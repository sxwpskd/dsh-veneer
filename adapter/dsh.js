// dsh-veneer —— DSH 宿主适配（**唯一允许出现宿主服务名的地方**）
//
// 规则（与 dsh-milieu 的 ARCHITECTURE 同一条）：
//   · **只翻译，不决策**：这里没有"什么时候扫、扫什么、该怎么报"的判断，那些在 core/；
//   · **服务只从 `ctx.inject` 回调的 ctx 属性上取**：真宿主上 `ctx.get('服务名')` 返回 undefined
//     （2026-10-18 体检单，journal/038）。本文件不使用 `ctx.get`；
//   · **失败返回 `{ok:false, reason, blockedBy}`**，不吞错；
//   · 宿主名词（`workspaceRegistry` …）只出现在本文件，边界检查（tools/check.mjs）会查。
//
// v2 新增两件事（都只在这里）：
//   · `awaitScope(cb)`：等工作区表 + 配置编辑器就绪，用于"纳入策略"（R-13）；
//   · `runProcess(...)`：起一次外部进程并等它结束（原生对话框 / UAC 提权都走它）。
//     core/ 不 import `node:child_process`，进程能力只从这里出去。
import { execFile } from 'node:child_process';

const SERVICE = {
  workspace: 'workspaceRegistry',
  configEditor: 'configEditor',
};

/** "等工作区服务就绪"的依赖清单（`ctx.inject` 入参，同样只在这里出现）。 */
export const WORKSPACE_DEPENDENCIES = ['workspaceRegistry'];

/** "等工作区表 + 配置编辑器就绪"（R-13 纳入策略 / "不再检查"改配置用）。 */
export const SCOPE_DEPENDENCIES = ['workspaceRegistry', 'configEditor'];

/** 只等配置编辑器（"不再检查本工作区"才改配置，正常流程拿不到它就只报告）。 */
export const CONFIG_DEPENDENCIES = ['configEditor'];

/** 取一个服务：只做属性访问（真 ctx 是代理，没声明就访问会抛 → 翻译成"没有"）。 */
function service(ctx, name) {
  try {
    const found = ctx ? ctx[name] : undefined;
    return found || null;
  } catch {
    return null;
  }
}

/** Workspace 记录 → 绝对路径（宿主字段是 `path`；兼容别的拼法）。 */
function workspacePathOf(workspace) {
  if (!workspace) return null;
  const raw = workspace.path || workspace.root || workspace.cwd || workspace.dir;
  return raw ? String(raw) : null;
}

/** 把宿主给的 disposer 归一成一个函数。 */
function toDisposer(value) {
  if (typeof value === 'function') return value;
  if (value && typeof value.dispose === 'function') return () => value.dispose();
  return () => {};
}

/**
 * 起一次外部进程并等它结束——**core/ 唯一可用的进程通道**（本层 import `node:child_process`）。
 *
 * 为 native 对话框与 UAC 提权服务：两者都只需要"起进程 → 拿退出码/输出 → 判定"，
 * 不需要流式 IO。失败不抛：返回带 `ok/code/timedOut/error` 的普通对象。
 *
 * @param {string} command 可执行文件（如 `powershell.exe`）
 * @param {string[]} args 参数数组（**不经过 shell**，无需引号转义；空字符串也原样传）
 * @param {{env?:object, timeout?:number, maxBuffer?:number}} [options]
 * @param {Function} [execFileImpl] 测试注入点（签名同 `node:child_process.execFile`）
 * @returns {Promise<{ok:boolean, code:number|string|null, stdout:string, stderr:string, timedOut:boolean, error:string}>}
 */
export function runProcess(command, args, options = {}, execFileImpl) {
  const run = typeof execFileImpl === 'function' ? execFileImpl : execFile;
  const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 0;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : 4 * 1024 * 1024;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = run(command, args, {
        env: options.env && typeof options.env === 'object' ? options.env : process.env,
        timeout,
        windowsHide: true,
        maxBuffer,
      }, (err, stdout, stderr) => {
        const timedOut = !!(err && (err.killed === true || err.code === 'ETIMEDOUT'));
        finish({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : (err.code || null)) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut,
          error: err ? String(err.message || err) : '',
        });
      });
    } catch (err) {
      finish({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: String((err && err.message) || err),
      });
      return;
    }
    // 不需要 stdin：关掉它，免得子进程等输入。
    try { child.stdin.end(); } catch { /* 没有 stdin 也无所谓 */ }
  });
}

/**
 * 造一份宿主能力对象。核心层只认这些名字，不认宿主接口名：
 *   · `logger()` / `cwd()` / `canInject()` / `effect(cb)` / `awaitWorkspace(cb)`
 *   · `workspace.available()/listPaths()`
 *   · `onSessionEvent(cb)`：订阅 `turn/end`（一次扫描的触发源之一），返回 disposer
 *   · `packageDir`：本包根目录（入口从宿主拿；拿不到时由入口退回 `core/command-path.js`）
 */
export function createDsh(ctx, packageDir = '') {
  return {
    id: 'dsh',

    /** 本包根目录（用于拼执行侧脚本的绝对路径）。 */
    packageDir: typeof packageDir === 'string' ? packageDir : '',

    /** 宿主 logger（本层只递过去；怎么用是入口的事）。 */
    logger() {
      try {
        return (ctx && ctx.logger) || null;
      } catch {
        return null;
      }
    },

    /** 进程当前目录（工作区根的最后兜底）。 */
    cwd() {
      try {
        return process.cwd();
      } catch {
        return '';
      }
    },

    /** 宿主有没有"等服务就绪"的扩展点。 */
    canInject() {
      try {
        return typeof (ctx && ctx.inject) === 'function';
      } catch {
        return false;
      }
    },

    /** 注册副作用清理（`ctx.effect(cb) => disposer`）。 */
    effect(callback) {
      return ctx.effect(callback);
    },

    /**
     * 等"工作区定位"需要的服务就绪，然后在**回调的 ctx** 上传一份新的能力对象。
     * @returns {object|null} 框架给的 fiber（可 dispose）
     */
    awaitWorkspace(callback) {
      return ctx.inject(WORKSPACE_DEPENDENCIES, (sub) => callback(createDsh(sub, packageDir)));
    },

    /**
     * 等工作区表 + 配置编辑器就绪（R-13 纳入策略用）。
     * 回调拿到 `{ dsh, ctx }`：`dsh` 是适配对象（读平台工作区表），`ctx` 给 `adapter/config.js` 用。
     * @returns {object|null} 框架给的 fiber（可 dispose）
     */
    awaitScope(callback) {
      return ctx.inject(SCOPE_DEPENDENCIES, (sub) => callback({ dsh: createDsh(sub, packageDir), ctx: sub }));
    },

    /**
     * 只等配置编辑器就绪（弹窗选"不再检查本工作区"时才需要改配置）。
     * 回调拿到**子 ctx 原样**（`adapter/config.js` 从它上面读 `configEditor`）。
     * @returns {object|null} 框架给的 fiber（可 dispose）
     */
    awaitConfigEditor(callback) {
      return ctx.inject(CONFIG_DEPENDENCIES, (sub) => callback(sub));
    },

    /**
     * 订阅持久会话事件（`session/event`）：**所有事件原样递出**，由核心层自己判类型。
     *
     * 回调签名是 `(event, session)`（事件在前；`session` 原样透传、不改形状）——
     * `turn/end` 与 `user/message` 都在这条通道上，核心层按 `event.type` 过滤。
     * 宿主没有 `ctx.on` → 返回 no-op；订阅者异常**不抛回宿主总线**。
     * @param {(event:object, session:object) => void} callback
     */
    onSessionEvent(callback) {
      const noop = () => {};
      try {
        if (!ctx || typeof ctx.on !== 'function' || typeof callback !== 'function') return noop;
        const disposer = ctx.on('session/event', (session, event) => {
          try {
            callback(event, session);
          } catch { /* 订阅者异常不能抛回宿主事件总线 */ }
        });
        return toDisposer(disposer);
      } catch {
        return noop;
      }
    },

    workspace: {
      /** 能不能问平台要工作区表。 */
      available() {
        const wr = service(ctx, SERVICE.workspace);
        return !!(wr && typeof wr.list === 'function');
      },

      /** 平台工作区表（有序，绝对路径）。失败返回 fail，不抛。 */
      listPaths() {
        const wr = service(ctx, SERVICE.workspace);
        if (!wr || typeof wr.list !== 'function') {
          return { ok: false, reason: '宿主没有 ' + SERVICE.workspace + '.list', blockedBy: 'host', code: 'host-unavailable' };
        }
        try {
          const rows = wr.list();
          const paths = (Array.isArray(rows) ? rows : []).map(workspacePathOf).filter(Boolean);
          return { ok: true, value: paths };
        } catch (err) {
          return {
            ok: false,
            reason: '读平台工作区列表失败：' + String((err && err.message) || err),
            blockedBy: 'host',
            code: 'host-call-failed',
          };
        }
      },
    },
  };
}

/** 供入口把"哪个事件算一轮结束"说清楚（同样只在这里出现事件名）。 */
export const TURN_END_EVENT = 'turn/end';
