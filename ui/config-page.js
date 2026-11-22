// dsh-veneer —— 插件页的「检查沙箱物化」面板（界面半边：**只读展示**）
//
// 形态：`plugins.row.config`（插件管理页里 dsh-veneer 那一行的配置页）里的一块。
//
// **它只读，不触发扫描。** 原因（查实过，别再试）：
//   · 浏览器侧没有写工作区文件的通道（`remote.workspaceFiles` 只有读）；
//   · 插件包没有 Typert 生成，界面拿不到自己的 RPC。
// 所以扫描由**宿主在打开工作区时**做一次（`scanOnMount`），面板读那份报告。
// 要再扫一次：重开工作区/重开 DSH，或用执行侧的 `-Apply` 干跑（只读）。
//
// 纪律（都真踩过）：
//   · 组件签名是 `(props)`，**React 从 `props.React` 取**；缺了就返回 null（不要这时候调 hooks）；
//   · **不读未声明的 ctx 服务**（真环境是代理，读未声明属性会抛，组件会整块消失）；
//   · 只读文件用 `remote.workspaceFiles.read(path, {}, signal)`（官方两参形状；老代码写过三参）；
//   · 不写 DOM、不 import Harness 客户端包、只用 `--dsw-alias-*` token。
import { REPORT_REL_PATH } from '../model/acl.js';

/** 客户端要注入的服务：只用远端命名空间（已声明过的），不碰别的。 */
export const CLIENT_INJECT = ['slots', 'remote', 'remote.workspaceFiles'];

/** 配置页在 Slots 里的 key：`<包名>#<行 id>`（与 cordis.patch.yml 的行 id 一致）。 */
export const SLOT_KEY = 'dsh-veneer#veneer';

/** 主题 token（只用 `--dsw-alias-*`）。 */
const TOKENS = {
  text: 'var(--dsw-alias-text-1, #1f2328)',
  muted: 'var(--dsw-alias-text-2, #57606a)',
  border: 'var(--dsw-alias-border-1, #d0d7de)',
  bg: 'var(--dsw-alias-bg-2, #f6f8fa)',
  good: 'var(--dsw-alias-state-success, #1a7f37)',
  warn: 'var(--dsw-alias-state-warning, #9a6700)',
  bad: 'var(--dsw-alias-state-danger, #cf222e)',
};

/** 报告 → 一行人话 + 颜色。 */
export function describeResult(result) {
  if (!result || typeof result !== 'object') return { text: '还没查过', tone: 'muted' };
  const counts = result.counts || {};
  switch (result.status) {
    case 'ok':
      return { text: '物化完整：' + (counts.checked || 0) + ' 个对象三项都齐', tone: 'good' };
    case 'incomplete':
      return {
        text: '还缺 ' + (counts.missing || 0) + ' 个对象（checked ' + (counts.checked || 0)
          + ' / skipped ' + (counts.skipped || 0) + '）',
        tone: 'warn',
      };
    case 'root-absent':
      return {
        text: '工作区根上没有物化三项（' + ((result.rootMissing || []).join(', ') || '未知') + '）——这是宿主的活',
        tone: 'muted',
      };
    case 'partial': {
      const failed = counts.failed || 0;
      return { text: '扫不全（' + failed + ' 处失败），结论不完整', tone: 'warn' };
    }
    default:
      return { text: String(result.summary || '未知结论'), tone: 'muted' };
  }
}

/** 缺项明细（最多列 5 条，避免面板变成日志）。 */
export function describeMissing(report) {
  const objects = Array.isArray(report && report.objects) ? report.objects : [];
  if (!objects.length) return [];
  const lines = objects.slice(0, 5).map((o) => {
    const missing = Array.isArray(o.missing) ? o.missing.join('/') : '';
    return (o.isDir ? '目录 ' : '文件 ') + String(o.path || '') + '  缺 ' + missing;
  });
  if (objects.length > 5) lines.push('…还有 ' + (objects.length - 5) + ' 个');
  return lines;
}

/**
 * 造客户端插件。
 * @param {{React:object, ctx:object}} input
 */
export function createClientPlugin({ React, ctx }) {
  const closureReact = React;

  /** 读一次报告文件。读不到是正常情况（还没扫过），不抛。 */
  const readReport = async () => {
    let files;
    try { files = ctx && ctx.remote && ctx.remote.workspaceFiles; } catch { files = null; }
    if (!files || typeof files.read !== 'function') {
      return { ok: false, reason: '没有文件读通道（remote.workspaceFiles 不可用）' };
    }
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(8000) : undefined;
    const attempts = [
      () => files.read(REPORT_REL_PATH, {}, signal),
      () => files.read(REPORT_REL_PATH, {}),
    ];
    for (const call of attempts) {
      try {
        const res = await call();
        const value = res && res.ok === true && res.value !== undefined ? res.value : res;
        const text = typeof value === 'string'
          ? value
          : (value && typeof value.text === 'string' ? value.text : null);
        if (text === null) continue;
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return { ok: true, report: parsed };
      } catch { /* 换下一种签名 */ }
    }
    return { ok: false, reason: '读不到报告（可能还没生成）' };
  };

  const Panel = (props) => {
    const R = (props && props.React) || closureReact;
    if (!R || typeof R.createElement !== 'function' || typeof R.useState !== 'function') return null;
    const e = R.createElement;
    const [state, setState] = R.useState({ phase: 'init', text: '正在读报告…', tone: 'muted', report: null });

    const load = async () => {
      setState({ phase: 'loading', text: '正在读报告…', tone: 'muted', report: null });
      const got = await readReport();
      if (!got.ok) {
        setState({ phase: 'none', text: got.reason, tone: 'muted', report: null });
        return;
      }
      const line = describeResult(got.report);
      setState({ phase: 'done', text: line.text, tone: line.tone, report: got.report });
    };

    if (typeof R.useEffect === 'function') {
      R.useEffect(() => { void load(); }, []);
    }

    const report = state.report;
    const details = report ? describeMissing(report) : [];
    const scannedAt = report && typeof report.scannedAt === 'number'
      ? new Date(report.scannedAt).toLocaleString() : '';

    return e('div', {
      style: {
        display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
        border: '1px solid ' + TOKENS.border, borderRadius: 8, background: TOKENS.bg,
      },
    }, [
      e('div', { key: 'title', style: { fontWeight: 600, color: TOKENS.text } }, '检查沙箱物化'),
      e('div', { key: 'desc', style: { fontSize: 12, color: TOKENS.muted } },
        '只读：宿主在打开工作区时扫一次，看哪些既有对象缺了物化三项（能力 ACE / Everyone 拒删子项 / Low 标签）。'
        + '要再扫一次，重开工作区（或重开 DSH）。'),
      e('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
        e('button', {
          key: 'btn', type: 'button', onClick: () => { void load(); },
          style: {
            padding: '4px 12px', borderRadius: 6, border: '1px solid ' + TOKENS.border,
            background: TOKENS.text, color: '#fff', cursor: 'pointer',
          },
        }, '重新读取'),
        e('span', { key: 'msg', style: { fontSize: 12, color: TOKENS[state.tone] || TOKENS.muted } }, state.text),
      ]),
      details.length
        ? e('div', { key: 'details', style: { fontSize: 12, color: TOKENS.muted, whiteSpace: 'pre-wrap', fontFamily: 'monospace' } }, details.join('\n'))
        : null,
      report
        ? e('div', { key: 'report', style: { fontSize: 12, color: TOKENS.muted } },
          '报告：' + REPORT_REL_PATH + (scannedAt ? '（扫描于 ' + scannedAt + '）' : ''))
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
      // 第一个参数是**插槽名**（`slots.inject(slotName, cb)`），不是 key（2026-11-20 真机踩过）。
      slots.inject('plugins.row.config', () => slots.register({ name: 'plugins.row.config', key: SLOT_KEY }, Panel));
      return () => {};
    },
  };
}
