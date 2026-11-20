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
import { bridgeDirOf, makeRequest, RESULT_FILE, REQUEST_FILE } from '../core/bridge.js';

/** 客户端要注入的服务：只用远端命名空间（已声明过的），不碰别的。 */
export const CLIENT_INJECT = ['slots', 'remote', 'remote.workspaceFiles'];

/** 配置页在 Slots 里的 key：`<包名>#<行 id>`（与 cordis.patch.yml 的行 id 一致）。 */
export const SLOT_KEY = 'dsh-veneer#veneer';

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
export function describeResult(result) {
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
export function createClientPlugin({ React, ctx, deps = {} }) {
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
      // 第一个参数是**插槽名**（`slots.inject(slotName, cb)`），不是 key！
      // 2026-11-20 真机踩到：写成 `slots.inject(SLOT_KEY, …)` 不会报错，但永远不会注册，
      // 插件页那一行因此没有「配置」控件。
      slots.inject('plugins.row.config', () => slots.register({ name: 'plugins.row.config', key: SLOT_KEY }, Panel));
      return () => {};
    },
  };
}
