// dsh-veneer —— DSH 宿主适配（**唯一允许出现宿主服务名的地方**）
//
// 规则（与 dsh-milieu 的 ARCHITECTURE 同一条）：
//   · **只翻译，不决策**：这里没有"什么时候扫、扫什么、该怎么报"的判断，那些在 core/；
//   · **服务只从 `ctx.inject` 回调的 ctx 属性上取**：真宿主上 `ctx.get('服务名')` 返回 undefined
//     （2026-10-18 体检单，journal/038）。本文件不使用 `ctx.get`；
//   · **失败返回 `{ok:false, reason, blockedBy}`**，不吞错；
//   · 宿主名词（`workspaceRegistry` …）只出现在本文件，边界检查（tools/check.mjs）会查。

const SERVICE = {
  workspace: 'workspaceRegistry',
};

/** "等工作区服务就绪"的依赖清单（`ctx.inject` 入参，同样只在这里出现）。 */
export const WORKSPACE_DEPENDENCIES = ['workspaceRegistry'];

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
     * 订阅持久会话事件（`session/event`）：只把 `turn/end` 递出去。
     * 宿主没有 `ctx.on` → 返回 no-op；订阅者异常**不抛回宿主总线**。
     * @param {(event:object) => void} callback
     */
    onSessionEvent(callback) {
      const noop = () => {};
      try {
        if (!ctx || typeof ctx.on !== 'function' || typeof callback !== 'function') return noop;
        const disposer = ctx.on('session/event', (session, event) => {
          try {
            callback(event);
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
