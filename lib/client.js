// 本文件由工作区工具 tools/build-veneer-client.mjs 从 <包>/ 下列 4 个模块拼接生成：
//   model/acl.js , core/bridge.js , ui/config-page.js , client.js
// **不要手改**：改源码后重跑构建。 src=1adbef9de629
(function () {
"use strict";

// ===== model/acl.js =====
// dsh-veneer —— 数据形状（model 层：只放形状与纯归一，不做 IO、不做判断）
//
// 三张形状：
//   · **签名**（signature）：一个对象的物化三项长什么样——`{ cap, denyDC, denyDCInherit, label }`；
//   · **判缺**（deficit）：这个对象缺哪几项、为什么跳过；
//   · **报告**（report）：写进工作区的那份 JSON。

/** 三项的名字（报告与执行侧脚本共用同一套词，别另起一套）。 */
const ITEM = Object.freeze({
  CAP: 'cap',       // 工作区能力 ACE（读根 SD 里的 SID，照抄）
  DENY_DC: 'denyDC', // 目录上的 `Everyone` 拒绝 FILE_DELETE_CHILD
  LABEL: 'label',   // Low 完整性标签
});

/** 报告版本：形状一变就升（执行侧脚本与将来的 UI 读它）。 */
const REPORT_VERSION = 1;

/** 三种整体状态。 */
const STATUS = Object.freeze({
  OK: 'ok',             // 根齐、子树也都齐
  INCOMPLETE: 'incomplete', // 有对象缺三项（需要用户执行修复命令）
  ROOT_ABSENT: 'root-absent', // 根上没物化三项 → 属于宿主，本插件不动手
  PARTIAL: 'partial',   // 扫不全（读不了某些子树），结论不完整
  UNSUPPORTED: 'unsupported', // 非 Windows
  UNKNOWN: 'unknown',   // 还没扫过
});

/**
 * 一项被算作"已有"的判据（三项统一口径）：
 *   · cap    —— 根 SID 有一条第 `Allow` 职责位含写（`W` 或 `WD`）的 ACE；
 *   · denyDC —— 有一条 `S-1-1-0` 的 `Deny` ACE，且是删除子项位（`DC` 或 `D`）；
 *   · label  —— 完整性标签是 `Low`。
 * **显式与继承都算**：是否带 `(I)` 只作为签名的一部分记下来，**判缺不看它**。
 * 这么定的原因：只补"真的没有"的项。把已经从根继承来的再补一遍，会在 `icacls` 里留一组重复 ACE
 * （2026-11-20 在 `D:\agent-collab-1\公共信息库\` 亲眼见到）。
 */
const SAME_ITEM_RULES = Object.freeze({
  cap: 'any Allow ACE for the root capability SID with write data (W or WD)',
  denyDC: 'any Deny ACE for Everyone (S-1-1-0) with delete-child (DC or D)',
  label: 'integrity label Low',
});

/** 跳过原因（报告里的 `reason` 就取这些词，便于按词统计）。 */
const SKIP = Object.freeze({
  REPARSE: 'reparse-point',      // reparse point（junction / symlink / mount）：官方也管不全
  NO_ACL_READ: 'acl-unreadable', // 读不到 SD（权限不足）
});

/**
 * 归一一处 ACL 读取结果。输入来自执行侧脚本（`inspect` 命令）的原样输出。
 *
 * @param {object} raw
 * @returns {{path:string, isDir:boolean, signature:object, error?:string}|null}
 */
function normalizeObject(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string') return null;
  const cap = raw.cap === true;
  const denyDC = raw.denyDC === true;
  const label = raw.label === 'low' ? 'low' : (raw.label === 'medium' ? 'medium' : null);
  const signature = {
    cap,
    denyDC,
    denyDCInherit: raw.denyDCInherit === true,
    label,
  };
  const obj = {
    path: raw.path,
    isDir: raw.isDir === true,
    signature,
  };
  if (typeof raw.error === 'string' && raw.error) obj.error = raw.error;
  return obj;
}


// ===== core/bridge.js =====
// dsh-veneer —— 本地桥（手动入口 ↔ 扫描器）
//
// 为什么有这一层：插件包本身不带界面代码，**点菜单发不了任何 RPC**；而"点一下马上出结果"
// 需要界面和宿主说上话。桥就是两者的接点：
//   · 界面（插件页里的"检查沙箱物化"按钮）写一个请求文件；
//   · 宿主这边订阅文件系统，看到请求就扫一次，把结论写进响应文件；
//   · 界面轮询响应文件，读到结论就显示。
//
// 但它**两条腿都要能走**：桥只在本机 Windows 上跑；非 Windows / 没有宿主文件服务时，
//   `submit()` 直接返回失败原因（"这台机器没法点一下就出结果"），**不假装成功**。
//
// 位置：`<工作区>/.dsh-veneer/`（与 dsh-milieu 的 `.dsh-milieu/` 同一条纪律：插件产物在自己的目录里）。


/** 桥的目录名（在工作区里）。 */
const BRIDGE_DIR = '.dsh-veneer';
/** 请求 / 响应文件名。 */
const REQUEST_FILE = 'request.json';
const RESULT_FILE = 'result.json';

/** 桥的绝对目录。 */
function bridgeDirOf(root) {
  return join(String(root), BRIDGE_DIR);
}

/** 请求文档（界面写、宿主读）。`id` 由界面生成，宿主原样回填。 */
function makeRequest(id, at = Date.now()) {
  return { version: 1, kind: 'scan', id: String(id || ''), at };
}

/**
 * 从任意读到的 JSON 里取一个"扫描请求"；不是请求 → null（宿主别把垃圾当命令）。
 * @returns {{id:string, at:number}|null}
 */
function parseRequest(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind !== 'scan') return null;
  const id = typeof value.id === 'string' ? value.id : '';
  if (!id) return null;
  const at = typeof value.at === 'number' ? value.at : 0;
  return { id, at };
}

/**
 * 响应文档（宿主写、界面读）。**只放结论，不放绝对路径**——它可能被复制出去。
 * @param {string} id 对应请求的 id
 * @param {{ok:boolean, reason?:string, value?:object}} result runScan 的结果
 */
function makeResult(id, result, at = Date.now()) {
  const base = { version: 1, kind: 'scan-result', id: String(id || ''), at, finishedAt: at };
  if (!result || result.ok !== true) {
    return { ...base, ok: false, reason: String((result && result.reason) || '未知原因') };
  }
  const value = result.value || {};
  return {
    ...base,
    ok: true,
    status: String(value.status || ''),
    summary: String(value.summary || ''),
    counts: value.counts || {},
    missingItems: value.missingItems || {},
    rootMissing: Array.isArray(value.rootMissing) ? value.rootMissing : [],
    command: typeof value.command === 'string' ? value.command : '',
    reportPath: typeof value.reportPath === 'string' ? value.reportPath : '',
    written: value.written === true,
  };
}

/**
 * 桥的轮询与提交 **只依赖一个最小文件面**（与现有 fs 能力对象兼容）：
 *   readText / writeTextAtomic / exists
 * @param {{fs:object, scanner:{request:(root:string)=>Promise<object>}, root:string, log:object, pollMs?:number, onOpen?:(path:string)=>object}} deps
 */
function createBridge(deps) {
  const dir = bridgeDirOf(deps.root);
  const requestPath = join(dir, REQUEST_FILE);
  const resultPath = join(dir, RESULT_FILE);
  const pollMs = typeof deps.pollMs === 'number' && deps.pollMs > 0 ? deps.pollMs : 1000;
  let timer = null;
  let stopped = false;
  let lastRequestId = '';
  let running = false;

  const readJson = (path) => {
    try {
      if (!deps.fs.exists(path)) return null;
      return JSON.parse(deps.fs.readText(path));
    } catch {
      return null;
    }
  };

  const writeJson = (path, value) => {
    try {
      deps.fs.writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n');
      return true;
    } catch (err) {
      deps.log.warn('桥写不进去（' + path + '）：' + String((err && err.message) || err));
      return false;
    }
  };

  /** 处理一次：有请求且是新请求 → 扫一次 → 写结论。 */
  const tick = async () => {
    if (stopped || running) return;
    const request = parseRequest(readJson(requestPath));
    if (!request || request.id === lastRequestId) return;
    running = true;
    lastRequestId = request.id;
    try {
      const result = await deps.scanner.request(deps.root);
      const wrote = writeJson(resultPath, makeResult(request.id, result));
      deps.log.info('手动检查 ' + (wrote ? '完成' : '完成但结论没写进去') + '：'
        + (result && result.ok === true ? result.value.summary : String((result && result.reason) || '未知原因')));
    } catch (err) {
      deps.log.warn('手动检查失败：' + String((err && err.message) || err));
    } finally {
      running = false;
    }
  };

  return {
    /** 开始轮询（只有轮询，不主动扫）。 */
    start() {
      if (timer !== null || stopped) return;
      timer = setInterval(() => { void tick(); }, pollMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },

    /** 立刻处理一次（文件服务可能没走 watcher）。 */
    tick,

    /** 停止轮询。 */
    stop() {
      stopped = true;
      if (timer !== null) {
        try { clearInterval(timer); } catch { /* 停不下来不影响卸载 */ }
        timer = null;
      }
    },

    /** 把工作区里的一个文件交给宿主打开（界面点到"在资源管理器里看"时用）。 */
    open(path) {
      if (typeof deps.onOpen === 'function') return deps.onOpen(path);
      return { ok: false, reason: '这台机器不提供打开文件' };
    },

    paths: { dir, requestPath, resultPath },
  };
}


// ===== ui/config-page.js =====
// dsh-veneer —— 插件页的「检查沙箱物化」面板（界面半边）
//
// 形态：`plugins.row.config`（插件管理页里 dsh-veneer 那一行的配置页）里的一个区块。
// **为什么不是工作区右键菜单**：插件包不带界面代码，菜单贡献在**浏览器**里执行，
// 它发不了任何 RPC（官方做法要 Typert 代码生成，插件包没有）；而 RPC 是"点一下出结果"的前提。
//
// 所以这里走一条**文件桥**（见 core/bridge.js）：
//   点按钮 → 往 `<工作区>/.dsh-veneer/request.json` 写一个带 id 的请求
//          → 宿主半边看到就扫一次 → 写 `result.json`
//          → 这里读到同 id 的结论就显示。
// **没有桥的机器**（非 Windows / 宿主文件服务没挂载）：按钮禁用，并如实说"这台机器点不了"。
//
// 纪律：
//   · 不写 DOM、不 import Harness 客户端包、只用 `--dsw-alias-*` 主题 token；
//   · 组件是 `(props)` 函数，React 从 `props.React` 取（dsh-milieu 踩过 `(React, props)` 的坑）；
//   · 轮询有上限，失败/超时都显示原因，**不假装在跑**。


/** 客户端要注入的服务：只用远端命名空间（已声明过的），不碰别的。 */
const CLIENT_INJECT = ['slots', 'remote', 'remote.workspaceFiles'];

/** 配置页在 Slots 里的 key：`<包名>#<行 id>`（与 cordis.patch.yml 的行 id 一致）。 */
const SLOT_KEY = 'dsh-veneer#veneer';

/** 轮询：每 800ms 读一次结论文件，最多等 90 秒（一次扫描实测 ~5s/900 对象）。 */
const POLL_MS = 800;
const WAIT_MS = 90000;

/** 主题 token 常量（只用 `--dsw-alias-*`）。 */
const TOKENS = {
  text: 'var(--dsw-alias-text-1, #1f2328)',
  muted: 'var(--dsw-alias-text-2, #57606a)',
  border: 'var(--dsw-alias-border-1, #d0d7de)',
  bg: 'var(--dsw-alias-bg-2, #f6f8fa)',
  good: 'var(--dsw-alias-state-success, #1a7f37)',
  warn: 'var(--dsw-alias-state-warning, #9a6700)',
  bad: 'var(--dsw-alias-state-danger, #cf222e)',
};

/** 一个随机 id（不需要密码学强度，只要同一时刻的两次点击不同）。 */
function newRequestId() {
  return 'scan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** 结论 → 一行人话 + 颜色。 */
function describeResult(result) {
  if (!result || typeof result !== 'object') return { text: '还没查过', tone: 'muted' };
  if (result.ok === false) return { text: '这次检查失败了：' + (result.reason || '未知原因'), tone: 'bad' };
  const counts = result.counts || {};
  switch (result.status) {
    case 'ok':
      return { text: '工作区物化完整（' + (counts.checked || 0) + ' 个对象都齐了）', tone: 'good' };
    case 'incomplete':
      return {
        text: '还缺 ' + (counts.missing || 0) + ' 个对象（checked ' + (counts.checked || 0)
          + ' / skipped ' + (counts.skipped || 0) + '）——要修的话去报告里拿命令',
        tone: 'warn',
      };
    case 'root-absent':
      return {
        text: '工作区根上没有物化三项（' + ((result.rootMissing || []).join(', ') || '未知') + '）——这是宿主的活，插件不动手',
        tone: 'muted',
      };
    case 'partial': {
      const failed = (result.counts && result.counts.failed) || 0;
      return { text: '扫不全（' + failed + ' 处失败）——结论不完整', tone: 'warn' };
    }
    default:
      return { text: String(result.summary || '未知结论'), tone: 'muted' };
  }
}

/**
 * 造客户端插件（纯函数：注入 ctx 与 React，返回 `{ apply }`）。
 * @param {{React:object, ctx:object, deps?:{fs?:object, sleep?:(ms:number)=>Promise<void>}}} input
 */
function createClientPlugin({ React, ctx, deps = {} }) {
  const h = React.createElement;
  const cwdOf = () => {
    // 工作区根 = 本轮会话的 cwd（与 dsh-milieu 用 `turnTail` 的思路一致：不问、只读）。
    try {
      const root = ctx && ctx.remote && ctx.remote.$host && ctx.remote.$host;
      return typeof root.cwd === 'string' ? root.cwd : '';
    } catch {
      return '';
    }
  };
  void cwdOf;

  /** 读/写结论文件：走 `remote.workspaceFiles`（宿主 Remote 文件读）。 */
  const readResult = async (sessionId, root, id) => {
    const wf = ctx && ctx.remote && ctx.remote.workspaceFiles;
    if (!wf || typeof wf.read !== 'function' || !sessionId) return null;
    const rel = bridgeDirOf('').replace(/\\/g, '/') + '/' + RESULT_FILE;
    try {
      const answer = await wf.read(sessionId, rel, { offset: 0, limit: 64 * 1024 }, new AbortController().signal);
      const value = answer && answer.ok === false ? null : (answer && answer.value !== undefined ? answer.value : answer);
      const text = value && typeof value.text === 'string' ? value.text : '';
      if (!text) return null;
      const parsed = JSON.parse(text);
      return parsed && parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
    void root;
  };

  /** 写请求文件：**界面目前没有写通道**（只有读）；写不了就如实报。 */
  const writeRequest = async () => ({ ok: false, reason: '界面没有写工作区文件的通道' });

  const Panel = (props) => {
    const [state, setState] = React.useState({ tone: 'muted', text: '还没查过', busy: false, result: null });
    const sessionId = (props && props.sessionId) || (ctx && ctx.session && ctx.session.selected && ctx.session.selected.getSnapshot && ctx.session.selected.getSnapshot());
    const onClick = async () => {
      if (state.busy) return;
      const id = newRequestId();
      setState({ tone: 'muted', text: '正在检查…（一次扫描约 5 秒）', busy: true, result: null });
      const written = await writeRequest();
      if (!written.ok) {
        setState({ tone: 'muted', text: '这台机器点不了：' + written.reason, busy: false, result: null });
        return;
      }
      const started = Date.now();
      const root = cwdOf();
      while (Date.now() - started < WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const result = await readResult(sessionId, root, id);
        if (result) {
          setState({ ...describeResult(result), busy: false, result });
          return;
        }
      }
      setState({ tone: 'bad', text: '等结论超时（90 秒）——宿主那半边可能没在跑', busy: false, result: null });
    };
    void makeRequest;
    void REQUEST_FILE;
    return h('div', {
      style: {
        display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
        border: '1px solid ' + TOKENS.border, borderRadius: 8, background: TOKENS.bg,
      },
    }, [
      h('div', { key: 'title', style: { fontWeight: 600, color: TOKENS.text } }, '检查沙箱物化'),
      h('div', { key: 'desc', style: { fontSize: 12, color: TOKENS.muted } },
        '只读扫描：看工作区里哪些既有对象缺了物化的三项（能力 ACE /  Everyone 拒删子项 / Low 标签）。不改任何东西。'),
      h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
        h('button', {
          key: 'btn',
          type: 'button',
          disabled: state.busy,
          onClick: () => { void onClick(); },
          style: {
            padding: '4px 12px', borderRadius: 6, border: '1px solid ' + TOKENS.border,
            background: state.busy ? TOKENS.bg : TOKENS.text, color: state.busy ? TOKENS.muted : '#fff',
            cursor: state.busy ? 'default' : 'pointer',
          },
        }, state.busy ? '检查中…' : '现在检查'),
        h('span', { key: 'msg', style: { fontSize: 12, color: TOKENS[state.tone] || TOKENS.muted } }, state.text),
      ]),
      state.result && state.result.reportPath
        ? h('div', { key: 'report', style: { fontSize: 12, color: TOKENS.muted } }, '报告：' + state.result.reportPath)
        : null,
    ].filter(Boolean));
  };

  return {
    inject: CLIENT_INJECT,
    apply(inner) {
      const slots = (inner && inner.slots) || (ctx && ctx.slots);
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        return () => {};
      }
      // `slots.inject` 的回调里注册；它返回的 disposer 由插槽自己管，这里交还一个 no-op 清理。
      slots.inject(SLOT_KEY, () => slots.register({ name: 'plugins.row.config', key: SLOT_KEY }, Panel));
      return () => {};
    },
  };
}


// ===== client.js =====
// dsh-veneer —— 界面半边入口：**只装配**
//
// 客户端模块的形状（照官方模板）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … return { inject, apply } } })
// React 从**浏览器模块表**取（`require('react')`），不自己装一份。
//
// **平台按 classic script 加载界面插件**（不是 ES 模块）：发布的是 `lib/client.js`，
//   由工作区工具 `tools/build-veneer-client.mjs` 从本文件 + `ui/*.js` + 它们的相对依赖拼接生成。
//   改界面源码后必须重新生成，否则跑的是旧代码。


if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-veneer',
    factory(require) {
      const React = require('react');
      return {
        inject: CLIENT_INJECT,
        apply(ctx) {
          const plugin = createClientPlugin({ React, ctx });
          return plugin.apply(ctx);
        },
      };
    },
  });
}

})();