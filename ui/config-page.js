// dsh-veneer —— 插件页行配置面板（界面半边：v2「工作区 → 文件 → 缺项 → 勾选 → 沙箱物化修复」）
//
// 形态：`plugins.row.config`（插件管理页里 dsh-veneer 那一行的配置页）里的一块。
//
// 它做两件事（B 通道）：
//   ① **只读展示**：宿主开工作区时扫一次，面板读 `review/veneer-summary.json`（小）与
//      `review/veneer-state.json`（全量，`objects[]` 才有完整清单）；
//   ② **勾选修复**：勾出要修的对象 → `form.mutate` 把 `fixRequest`（JSON 字符串）写进**插件配置**
//      → 宿主读到后发起 UAC 提权进程（提权进程写 `.dsh-veneer/fix-result.json`）→ 面板轮询结果、
//      据实显示成功/失败、然后重读报告刷新清单。
//
// 为什么走"配置文件"而不是自己的 RPC（查实过，别再试）：
//   · 浏览器侧没有写工作区文件的通道（`remote.workspaceFiles` 只有读）；
//   · 插件包没有 Typert 生成，界面拿不到自己的 RPC；
//   · 平台对行配置页给了 `form.mutate(ops, revision)`——`{op:'set', path:[...], value}` 是唯一稳定的写入口
//     （形状照抄 dsh-milieu 的 `saveDraft` / `saveWorkspaces`）。
//
// 纪律（都真踩过）：
//   · 组件签名是 `(props)`，**React 从 `props.React` 取**；缺了就返回 null（不要这时候调 hooks）；
//   · hooks 在组件顶部**无条件**调用（不能在 early return 之后）；
//   · **不读未声明的 ctx 服务**（真环境是代理，读未声明属性会抛，组件会整块消失）；
//   · 读文件用 `remote.workspaceFiles.read(sessionId, path, {}, signal)`（3 个业务参数 + signal）；
//   · 不写 DOM、不 import Harness 客户端包、样式只用 `--dsw-alias-*` token；
//   · **不假装成功**：读不到就说读不到，UAC 被取消 / 部分失败 / 超时都如实显示。
import { REPORT_REL_PATH } from '../model/acl.js';
import { createLog } from '../log/logger.js';

/** 客户端要注入的服务：只用远端命名空间（已声明过的），不碰别的。 */
export const CLIENT_INJECT = ['slots', 'remote', 'remote.workspaceFiles'];

/** 小摘要的相对路径（宿主写在报告旁边；见 core/persist.js 的 `summaryRelOf`）。 */
const SUMMARY_REL = 'review/veneer-summary.json';

/** 派发修复请求的配置字段（宿主 Config 里的 volatile 字段；面板只 `set`，不读）。 */
export const FIX_REQUEST_KEY = 'fixRequest';

/** 提权进程写的结果文件（相对工作区根）。面板轮询它；**id 对得上才算本次结果**。 */
export const FIX_RESULT_REL = '.dsh-veneer/fix-result.json';

/** 轮询间隔 / 最长等待（毫秒）。 */
export const FIX_POLL_MS = 2000;
export const FIX_TIMEOUT_MS = 120000;

/** 结果里最多列几个失败原因（再多就折叠成"还有 N 个"）。 */
const FIX_FAILURES_SHOWN = 5;

/** 配置页在 Slots 里的 key：`<包名>#<行 id>`（与 cordis.patch.yml 的行 id 一致）。 */
export const SLOT_KEY = 'dsh-veneer#veneer';

/** 三项的名字（与 model/acl.js 的 ITEM 同词；面板只展示，不 import core）。 */
const ITEM_ORDER = ['cap', 'denyDC', 'label'];

/** 缺项的中文注解（鼠标悬浮显示；行内仍用报告里的原词）。 */
const ITEM_HINT = {
  cap: '工作区能力 ACE',
  denyDC: 'Everyone 拒删子项',
  label: 'Low 完整性标签',
};

/** 主题 token（只用 `--dsw-alias-*`；fallback 是主题缺失时的兜底）。 */
const TOKENS = {
  text: 'var(--dsw-alias-label-primary, #111)',
  muted: 'var(--dsw-alias-label-secondary, #555)',
  tertiary: 'var(--dsw-alias-label-tertiary, #666)',
  border: 'var(--dsw-alias-border-secondary, #d9d9d9)',
  bg: 'var(--dsw-alias-bg-elevated, #fff)',
  accent: 'var(--dsw-alias-bg-accent, #eef4ff)',
  good: 'var(--dsw-alias-label-success, #1a7f37)',
  warn: 'var(--dsw-alias-label-warning, #a15c00)',
  bad: 'var(--dsw-alias-label-danger, #cf222e)',
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
  const objects = (report && (Array.isArray(report.missing) ? report.missing
    : (Array.isArray(report.objects) ? report.objects : []))) || [];
  if (!objects.length) return [];
  const lines = objects.slice(0, 5).map((o) => {
    const missing = Array.isArray(o.missing) ? o.missing.join('/') : '';
    return (o.isDir ? '目录 ' : '文件 ') + String(o.path || '') + '  缺 ' + missing;
  });
  if (report && report.more > 0) lines.push('…还有 ' + report.more + ' 个');
  else if (objects.length > 5) lines.push('…还有 ' + (objects.length - 5) + ' 个');
  return lines;
}

/**
 * 从 `useSessions` 的快照里取 Session id（读文件必须带一个：Remote 的 `read` 是
 * `read(sessionId, path, range, signal)`，第一个参数是**会话身份**，用来解析工作区根）。
 * 真实形状是 `{ ids: SessionId[], byId, phase, projectionsBySession }`；这里只认 ids/byId 两种。
 */
export function sessionIdsOf(snapshot, limit = 12) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const raw = Array.isArray(snapshot.ids)
    ? snapshot.ids
    : (snapshot.byId && typeof snapshot.byId === 'object' ? Object.keys(snapshot.byId) : []);
  return raw.filter((id) => typeof id === 'string' && id).slice(0, limit);
}

/**
 * 从 Remote 返回里取出文本；失败时给出人能看懂的原因。
 * 兼容：裸字符串 / `{text}` / `{content}` / `{ok:true,value:…}`（最多剥 3 层）/
 * `{ok:false,error}`（把 error 的 message 或 code 原样带出来）。
 * @returns {{text:string}|{error:string}}
 */
export function extractText(response) {
  let current = response;
  const shapes = [];
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === 'string') return { text: current };
    if (!current || typeof current !== 'object') break;
    if (current.ok === false) {
      const error = current.error;
      if (typeof error === 'string' && error) return { error };
      if (error && typeof error.message === 'string' && error.message) return { error: error.message };
      if (error && typeof error.code === 'string' && error.code) return { error: error.code };
      return { error: 'ok=false（没有 error 详情）' };
    }
    if (typeof current.text === 'string') return { text: current.text };
    if (typeof current.content === 'string') return { text: current.content };
    shapes.push('{' + Object.keys(current).slice(0, 6).join(',') + '}');
    if (current.value !== undefined) { current = current.value; continue; }
    if (current.result !== undefined) { current = current.result; continue; }
    break;
  }
  return { error: '返回里没有文本（形状：' + (shapes.join(' → ') || typeof response) + '）' };
}

// ---------------------------------------------------------------------------
// 报告 → 工作区 / 对象（纯函数，方便离线测试与复用）
// ---------------------------------------------------------------------------

/** 工作区路径归一：分隔符统一成 `/`、去掉尾斜杠、忽略大小写（Windows 路径比较用）。 */
export function normalizeWorkspacePath(path) {
  return String(path === null || path === undefined ? '' : path)
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 两个工作区路径是不是同一个（正斜杠/反斜杠、尾斜杠不同也算同一个）。 */
export function sameWorkspace(a, b) {
  const left = normalizeWorkspacePath(a);
  const right = normalizeWorkspacePath(b);
  return !!left && left === right;
}

/** 报告里的缺项对象清单（兼容摘要的 `missing[]`；去重、只认三项内的值）。 */
export function objectsOf(report) {
  if (!report || typeof report !== 'object') return [];
  const list = Array.isArray(report.objects)
    ? report.objects
    : (Array.isArray(report.missing) ? report.missing : []);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || !raw.path) continue;
    if (seen.has(raw.path)) continue;
    seen.add(raw.path);
    const missing = (Array.isArray(raw.missing) ? raw.missing : [])
      .filter((item) => ITEM_ORDER.includes(item));
    // 缺项为空的行不列：没有可修的东西，勾了也发不出请求（buildFixRequest 同样会滤掉）。
    if (!missing.length) continue;
    out.push({ path: raw.path, isDir: raw.isDir === true, missing });
  }
  return out;
}

/** 报告所属的工作区根（报告顶层 `root`；没有就给空串）。 */
export function reportRootOf(report) {
  return report && typeof report.root === 'string' ? report.root : '';
}

/**
 * 按工作区分组（一个报告通常只有一个根；`workspaces[]` 是给将来多工作区报告留的）。
 * 返回 `[{ workspace, objects: [{path, isDir, missing}] }]`；保持报告里的顺序。
 */
export function workspaceGroupsOf(report) {
  if (!report || typeof report !== 'object') return [];
  const groups = [];
  const root = reportRootOf(report);
  const rootObjects = objectsOf(report);
  if (root || rootObjects.length) groups.push({ workspace: root, objects: rootObjects });
  if (Array.isArray(report.workspaces)) {
    for (const item of report.workspaces) {
      if (!item || typeof item !== 'object') continue;
      const workspace = String(item.root || item.workspace || item.path || '');
      if (!workspace || (root && sameWorkspace(workspace, root))) continue;
      groups.push({ workspace, objects: objectsOf(item) });
    }
  }
  return groups;
}

/**
 * 当前工作区是否已被配置 `exclude` 排除（R-13 的展示面：面板只读提示，不替用户改配置）。
 * @param {object|null} configValue `form.state.value`（完整配置对象）
 */
export function isWorkspaceExcluded(configValue, workspace) {
  if (!configValue || typeof configValue !== 'object') return false;
  if (!Array.isArray(configValue.exclude)) return false;
  return configValue.exclude.some((item) => sameWorkspace(item, workspace));
}

/**
 * 造一个修复请求（写进 `fixRequest` 的内容；`request.id` 用来核对结果文件）。
 *
 * @param {string} workspace 工作区根（报告的 `root`）
 * @param {Array<{path:string, items:string[]}>} objects 勾选对象（只带缺的那几项）
 * @param {{now?:number, rand?:string}} [options] 测试口子（固定时间与随机段）
 * @returns {{version:1, id:string, workspace:string, objects:Array<{path:string, items:string[]}>}}
 */
export function buildFixRequest(workspace, objects, options = {}) {
  const now = Number.isFinite(options && options.now) ? options.now : Date.now();
  const rand = options && typeof options.rand === 'string' && options.rand
    ? options.rand
    : Math.random().toString(36).slice(2, 8);
  const list = (Array.isArray(objects) ? objects : []).map((object) => {
    const item = object && typeof object === 'object' ? object : {};
    const path = typeof item.path === 'string' ? item.path : '';
    const items = (Array.isArray(item.items) ? item.items : []).filter((name) => ITEM_ORDER.includes(name));
    return { path, items };
  }).filter((object) => object.path && object.items.length);
  return {
    version: 1,
    id: 'fix-' + now + '-' + rand,
    workspace: typeof workspace === 'string' ? workspace : String(workspace || ''),
    objects: list,
  };
}

/** 数字字段收口（`undefined` / 非数字 → null，不把 `0` 吃掉）。 */
function numberField(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * 把提权进程写的 `fix-result.json` 收成一个稳定形状（宿主/脚本的字段名可能略有出入，都认）。
 *
 * 期望形状（同时是给宿主侧的契约）：
 *   `{ version:1, id:'fix-…', ok:true, total:N, success:N, failed:N,
 *      failures:[{ path, items?, reason }], cancelled?:true, reason?:'' }`
 * @returns {{id:string, ok:boolean, cancelled:boolean, total:number, success:number,
 *   failed:number, failures:{path:string, reason:string}[], reason:string}}
 */
export function summarizeFixResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  const id = String(r.id || r.requestId || r.request_id || '');
  const status = String(r.status || '');
  const reason = String(r.reason || r.message || r.error || '');
  const results = Array.isArray(r.results) ? r.results : [];
  const okFromResults = results.filter((x) => x && (x.ok === true || x.success === true)).length;
  const badFromResults = results.filter((x) => x && x.ok === false);
  const rawFailures = Array.isArray(r.failures)
    ? r.failures
    : (Array.isArray(r.failedObjects) ? r.failedObjects
      : (Array.isArray(r.errors) ? r.errors : badFromResults));
  const failures = rawFailures.map((entry) => {
    if (typeof entry === 'string') return { path: '', reason: entry };
    const item = entry && typeof entry === 'object' ? entry : {};
    return {
      path: String(item.path || item.object || ''),
      reason: String(item.reason || item.error || item.message || '（没有原因）'),
    };
  }).filter((entry) => entry.path || entry.reason);
  const success = numberField(r.success) ?? numberField(r.okCount) ?? numberField(r.succeeded) ?? okFromResults;
  const failed = numberField(r.failed) ?? numberField(r.failCount) ?? numberField(r.failedCount) ?? failures.length;
  const total = numberField(r.total) ?? numberField(r.count)
    ?? (success + failed > 0 ? success + failed : results.length);
  const cancelled = r.cancelled === true || r.canceled === true || r.userCancelled === true
    || status === 'cancelled' || status === 'canceled' || status === 'user-cancelled'
    || (!(r.ok === true) && /cancel|取消/i.test(reason));
  let ok = r.ok === true || status === 'ok' || status === 'done' || status === 'fixed';
  if (!ok && r.ok === undefined && status === '' && !cancelled) ok = total > 0 && failed === 0;
  if (cancelled) ok = false;
  return { id, ok, cancelled, total, success, failed, failures, reason };
}

/** 修复结果 → 一行人话 + 颜色（面板与离线测试共用）。 */
export function describeFixResult(summary) {
  if (!summary || typeof summary !== 'object') return { text: '没有修复结果', tone: 'muted' };
  if (summary.cancelled) {
    return {
      text: '修复未执行：用户取消了 UAC 授权（没有改动任何对象的 ACL，也没有重试）',
      tone: 'warn',
    };
  }
  const total = summary.total || (summary.success + summary.failed) || 0;
  if (summary.ok && summary.failed === 0) {
    return { text: '修复完成：成功 ' + summary.success + ' / ' + total, tone: 'good' };
  }
  if (summary.failed > 0) {
    return {
      text: '修复部分失败：成功 ' + summary.success + '，失败 ' + summary.failed + '（共 ' + total + '）',
      tone: 'bad',
    };
  }
  return {
    text: '修复结果未知（结果文件既没给成功数也没给失败数）'
      + (summary.reason ? '：' + summary.reason : ''),
    tone: 'warn',
  };
}

/** 毫秒 → 本地时间文本（读不到时间就给空串）。 */
function timestampText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  try { return new Date(value).toLocaleString(); } catch { return ''; }
}

/** 等一会儿（轮询用；浏览器里一定有 setTimeout）。 */
function waitMs(ms) {
  return new Promise((resolve) => {
    try { setTimeout(resolve, ms); } catch { resolve(); }
  });
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 页面样式（只用主题 token；布局是行内 style，不写 DOM、不引样式表）。 */
const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 10, font: 'inherit', color: TOKENS.text },
  card: { border: '1px solid ' + TOKENS.border, borderRadius: 8, padding: '10px 12px', background: TOKENS.bg },
  title: { fontWeight: 600, fontSize: 14 },
  title2: { fontWeight: 600, fontSize: 12 },
  muted: { color: TOKENS.muted, fontSize: 12, margin: 0 },
  tertiary: { color: TOKENS.tertiary, fontSize: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0' },
  button: {
    cursor: 'pointer', padding: '4px 12px', borderRadius: 6,
    border: '1px solid ' + TOKENS.border, background: TOKENS.accent,
    color: 'inherit', font: 'inherit',
  },
  primary: { fontWeight: 600 },
  disable: { opacity: 0.6, cursor: 'not-allowed' },
  warnBox: {
    border: '1px solid ' + TOKENS.warn, borderRadius: 6, padding: '4px 8px',
    color: TOKENS.warn, fontSize: 12, margin: '4px 0',
  },
  list: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 340, overflow: 'auto', marginTop: 6 },
  groupHead: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px 2px',
    borderBottom: '1px solid ' + TOKENS.border, color: TOKENS.muted, fontSize: 12,
    fontFamily: 'monospace', overflowWrap: 'anywhere', wordBreak: 'break-all',
  },
  item: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 2px', fontSize: 12, cursor: 'pointer' },
  kindTag: { color: TOKENS.tertiary, fontSize: 11, whiteSpace: 'nowrap' },
  pathText: {
    fontFamily: 'monospace', fontSize: 12, flex: '1 1 220px', minWidth: 0,
    overflowWrap: 'anywhere', wordBreak: 'break-all', color: TOKENS.text,
  },
  badge: {
    padding: '0 4px', borderRadius: 4, border: '1px solid ' + TOKENS.warn,
    color: TOKENS.warn, fontSize: 11, whiteSpace: 'nowrap',
  },
  failList: { display: 'flex', flexDirection: 'column', gap: 2, margin: '4px 0' },
  failLine: { color: TOKENS.bad, fontSize: 12, overflowWrap: 'anywhere', wordBreak: 'break-all' },
  diag: {
    fontSize: 11, color: TOKENS.muted, whiteSpace: 'pre-wrap', margin: 0,
    maxHeight: 120, overflow: 'auto', fontFamily: 'monospace',
  },
  tried: {
    fontSize: 11, color: TOKENS.muted, whiteSpace: 'pre-wrap', margin: 0,
    fontFamily: 'monospace',
  },
};

/** tone 词 → 颜色 token。 */
function toneColor(tone) {
  if (tone === 'good') return TOKENS.good;
  if (tone === 'warn') return TOKENS.warn;
  if (tone === 'bad') return TOKENS.bad;
  return TOKENS.muted;
}

/** 列表的一行：复选框 + 目录/文件 + 路径 + 缺项（`cap` / `denyDC` / `label`）。 */
function buildItemRow(e, object, selectedSet, busy, onToggle) {
  const badges = object.missing.map((item) => e('span', {
    key: 'm:' + item,
    style: styles.badge,
    title: ITEM_HINT[item] || item,
  }, item));
  return e('label', {
    key: object.path,
    style: styles.item,
    title: object.path,
  }, [
    e('input', {
      key: 'cb',
      type: 'checkbox',
      checked: selectedSet.has(object.path),
      disabled: !!busy,
      onChange: () => onToggle(object.path),
    }),
    e('span', { key: 'kind', style: styles.kindTag }, object.isDir ? '目录' : '文件'),
    e('span', { key: 'path', style: styles.pathText }, object.path),
    ...badges,
  ]);
}

/** 把面板的所有事实画成一棵树（纯函数；hooks 与异步都在外面）。 */
function buildTree(R, model) {
  const e = R.createElement;
  const view = model.view || {};
  const picks = model.picks || {};
  const fix = model.fix || {};
  const groups = Array.isArray(model.groups) ? model.groups : [];
  const objects = Array.isArray(model.objects) ? model.objects : [];
  const handlers = model.handlers || {};
  const selectedSet = new Set(Array.isArray(picks.selected) ? picks.selected : []);
  const selectedCount = objects.filter((object) => selectedSet.has(object.path)).length;
  const totalCount = objects.length;
  const busy = fix.phase === 'requesting' || fix.phase === 'fixing';
  const report = view.report || null;
  const summary = view.summary || null;
  const counts = (report && report.counts) || (summary && summary.counts) || {};
  const missingItems = report && report.missingItems && typeof report.missingItems === 'object'
    ? report.missingItems : null;
  const scannedAt = timestampText(report ? report.scannedAt : (summary ? summary.scannedAt : null));

  const children = [];

  children.push(e('div', { key: 'title', style: styles.title }, '沙箱物化修复（检查 → 勾选 → 修复）'));
  children.push(e('div', { key: 'desc', style: styles.muted },
    '宿主在打开工作区时只读扫描一次；这里列出缺项对象，勾选后点底部的「沙箱物化修复」，'
    + '由宿主发起一次 UAC 提权进程只修勾选项（插件自己不改 ACL）。'));

  // ---- 状态卡：重读按钮 + 状态 + 来源/时间 + 当前工作区 ----
  const statusChildren = [];
  statusChildren.push(e('div', { key: 'row', style: styles.row }, [
    e('button', {
      key: 'reload',
      type: 'button',
      style: { ...styles.button, ...(busy ? styles.disable : {}) },
      disabled: !!busy,
      onClick: handlers.reload,
    }, '重新读取报告'),
    e('span', { key: 'status', style: { ...styles.muted, color: toneColor(view.tone) } }, String(view.text || '')),
  ]));
  const sourceParts = [];
  if (view.from) sourceParts.push('来源：' + view.from);
  if (scannedAt) sourceParts.push('扫描于 ' + scannedAt);
  if (sourceParts.length) {
    statusChildren.push(e('div', { key: 'source', style: styles.tertiary }, sourceParts.join('；')));
  }
  const countParts = [];
  if (!report && summary) countParts.push('摘要只带前 5 条缺项（完整清单要读全量报告）');
  if (counts.checked !== undefined) {
    countParts.push('检查 ' + (counts.checked || 0)
      + ' / 缺项 ' + (counts.missing || 0)
      + ' / 跳过 ' + (counts.skipped || 0)
      + ' / 失败 ' + (counts.failed || 0));
  }
  if (missingItems) {
    countParts.push('缺项分布：' + ITEM_ORDER.map((item) => item + ' ' + (missingItems[item] || 0)).join(' / '));
  }
  if (countParts.length) {
    statusChildren.push(e('div', { key: 'counts', style: styles.tertiary }, countParts.join('；')));
  }
  statusChildren.push(e('div', { key: 'workspace', style: styles.tertiary },
    '当前工作区：' + (model.currentWorkspace || '（报告里没有 root 字段）')));
  if (model.excluded) {
    statusChildren.push(e('div', { key: 'excluded', style: styles.warnBox },
      '本工作区已被排除管理（插件配置 exclude 里包含它）：不会再主动扫描/弹窗；'
      + '这里的勾选修复仍可手动执行。'));
  }
  children.push(e('div', { key: 'statusCard', style: styles.card }, statusChildren));

  // ---- 勾选清单（按工作区分组）----
  if (totalCount > 0) {
    const selectChildren = [];
    selectChildren.push(e('div', { key: 'head', style: styles.row }, [
      e('span', { key: 'stat', style: styles.title2 }, '已选 ' + selectedCount + ' / 共 ' + totalCount),
      e('button', {
        key: 'all',
        type: 'button',
        style: { ...styles.button, ...(busy || selectedCount === totalCount ? styles.disable : {}) },
        disabled: !!busy || selectedCount === totalCount,
        onClick: handlers.selectAll,
      }, '全选'),
      e('button', {
        key: 'none',
        type: 'button',
        style: { ...styles.button, ...(busy || selectedCount === 0 ? styles.disable : {}) },
        disabled: !!busy || selectedCount === 0,
        onClick: handlers.selectNone,
      }, '全不选'),
      e('span', { key: 'hint', style: styles.tertiary }, '默认全选；取消勾选的对象不会被修改'),
    ]));
    const listChildren = [];
    for (const group of groups) {
      listChildren.push(e('div', {
        key: 'g:' + (group.workspace || '?'),
        style: styles.groupHead,
      }, (group.workspace || '（未知工作区）') + '  ·  ' + group.objects.length + ' 个缺项对象'));
      for (const object of group.objects) {
        listChildren.push(buildItemRow(e, object, selectedSet, busy, handlers.toggle));
      }
    }
    selectChildren.push(e('div', { key: 'list', style: styles.list }, listChildren));
    children.push(e('div', { key: 'selectCard', style: styles.card }, selectChildren));
  } else {
    children.push(e('div', { key: 'emptyCard', style: styles.card }, [
      e('div', { key: 't', style: styles.title2 }, '没有可修复的缺项对象'),
      e('div', { key: 'd', style: styles.muted },
        view.phase === 'none' || view.phase === 'loading'
          ? '先解决上面的读取问题；报告读到后这里会列出缺项对象。'
          : '报告里 objects[] 为空：这个工作区的既有对象都齐了（或宿主还没扫到）。'),
    ]));
  }

  // ---- 修复按钮 + 执行状态 + 结果 ----
  const fixChildren = [];
  fixChildren.push(e('div', { key: 'row', style: styles.row }, [
    e('button', {
      key: 'fix',
      type: 'button',
      style: {
        ...styles.button,
        ...styles.primary,
        ...(model.disabledReason ? styles.disable : {}),
      },
      disabled: !!model.disabledReason,
      onClick: handlers.fix,
    }, busy ? '修复执行中…' : '沙箱物化修复'),
    e('span', { key: 'meta', style: styles.tertiary },
      busy
        ? '已递交修复请求：每 2 秒读一次 ' + FIX_RESULT_REL + '，最多等 120 秒'
        : '只修勾选项；点按钮 = 授权一次 UAC 提权'),
  ]));
  if (model.disabledReason) {
    fixChildren.push(e('div', { key: 'why', style: styles.warnBox }, '按钮不可用：' + model.disabledReason));
  }
  if (fix.text) {
    fixChildren.push(e('div', {
      key: 'fixtext',
      style: { ...styles.muted, color: toneColor(fix.tone) },
    }, String(fix.text)));
  }
  if (fix.result) {
    const result = fix.result;
    fixChildren.push(e('div', { key: 'sum', style: styles.title2 },
      '成功 ' + (result.success || 0) + ' / 失败 ' + (result.failed || 0)
      + '（共 ' + (result.total || 0) + '）'));
    const failures = Array.isArray(result.failures) ? result.failures : [];
    if (failures.length) {
      fixChildren.push(e('div', { key: 'failures', style: styles.failList },
        failures.slice(0, FIX_FAILURES_SHOWN).map((failure, index) => e('div', {
          key: 'f:' + index,
          style: styles.failLine,
        }, (failure.path ? failure.path + '：' : '') + failure.reason))));
      if (failures.length > FIX_FAILURES_SHOWN) {
        fixChildren.push(e('div', { key: 'more', style: styles.tertiary },
          '…还有 ' + (failures.length - FIX_FAILURES_SHOWN) + ' 个失败对象'));
      }
    }
  }
  children.push(e('div', { key: 'fixCard', style: styles.card }, fixChildren));

  // ---- 读不到时的每次尝试原因（不开 DevTools 也知道卡在哪）----
  if (Array.isArray(view.tried) && view.tried.length) {
    children.push(e('pre', { key: 'tried', style: styles.tried },
      '读取尝试（为什么读不到）：\n' + view.tried.join('\n')));
  }

  // ---- 客户端诊断日志（内存环形缓冲）----
  if (Array.isArray(model.diagLines) && model.diagLines.length) {
    children.push(e('pre', { key: 'diag', style: styles.diag },
      '诊断日志（最近 ' + model.diagLines.length + ' 条）：\n' + model.diagLines.join('\n')));
  }

  return e('div', { style: styles.root }, ...children.filter(Boolean));
}

/** 渲染失败时的落点（配置页自己的错误不能把插件管理页搞白）。 */
function buildNotice(R, text) {
  const e = R.createElement;
  return e('div', { style: { ...styles.card, color: TOKENS.muted } }, String(text));
}

// ---------------------------------------------------------------------------
// 客户端插件
// ---------------------------------------------------------------------------

/**
 * 造客户端插件。
 * @param {{React:object, ctx:object, log?:object}} input `log` 由 `client.js` 传入（内存环形缓冲）；
 *   不传时自己造一个（浏览器里没有宿主 logger，正好只用内存 + 控制台）。
 */
export function createClientPlugin({ React, ctx, log }) {
  const closureReact = React;
  // 客户端日志：拿不到文件系统 → 内存环形缓冲（脚手架要求），面板把它当"诊断日志"显示。
  const logger = log || createLog(null, { memoryLimit: 120 });

  /** 记一条客户端日志（日志层自己坏了不许抛）。 */
  const logEvent = (name, message, fields) => {
    try {
      if (logger && typeof logger.event === 'function') logger.event(name, message, fields);
    } catch { /* 日志坏了不影响面板 */ }
  };

  /** 取文件读通道（只读；未声明的 ctx 服务一律不碰）。 */
  const filesOf = () => {
    try { return (ctx && ctx.remote && ctx.remote.workspaceFiles) || null; } catch { return null; }
  };

  /**
   * 读一个相对路径的 JSON。**必须带 sessionId**（`read(sessionId, path, {}, signal)`）。
   * 一个工作区可能有好几个会话，逐个试；失败原因原样留在 `tried` 里。
   * @returns {{ok:true, value:object, sessionId:string}|{ok:false, error:string, tried:string[]}}
   */
  const readJsonRel = async (files, rel, sessionIds, timeoutMs) => {
    const ids = Array.isArray(sessionIds) ? sessionIds : [];
    if (!ids.length) {
      return { ok: false, error: '界面还拿不到会话（读文件需要一个 SessionId）', tried: [] };
    }
    const tried = [];
    for (const sessionId of ids) {
      const tag = rel + ' @' + String(sessionId).slice(-6);
      let signal;
      try {
        signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(timeoutMs) : undefined;
      } catch { signal = undefined; }
      try {
        const res = await files.read(sessionId, rel, {}, signal);
        const found = extractText(res);
        if (found.error) { tried.push(tag + '：' + found.error); continue; }
        let parsed;
        try {
          parsed = JSON.parse(found.text);
        } catch (err) {
          tried.push(tag + '：JSON 解析失败（' + String((err && err.message) || err).slice(0, 90) + '）');
          continue;
        }
        if (parsed && typeof parsed === 'object') return { ok: true, value: parsed, sessionId };
        tried.push(tag + '：读到的不是 JSON 对象');
      } catch (err) {
        tried.push(tag + '：' + String((err && err.message) || err).slice(0, 140));
      }
    }
    return { ok: false, error: '读不到 ' + rel, tried };
  };

  const Panel = (props) => {
    const R = (props && props.React) || closureReact;
    if (!R || typeof R.createElement !== 'function' || typeof R.useState !== 'function') return null;

    // ---- hooks：无条件调用，顺序永远一致 ----
    const useSessions = props && props.useSessions;
    const sessions = typeof useSessions === 'function' ? useSessions((snapshot) => snapshot) : null;
    const sessionIds = sessionIdsOf(sessions);
    const [view, setView] = R.useState({
      phase: 'init', text: '正在读报告…', tone: 'muted',
      summary: null, report: null, from: '', tried: [],
    });
    const [picks, setPicks] = R.useState({ selected: [], known: [] });
    const [fix, setFix] = R.useState({
      phase: 'idle', requestId: '', text: '', tone: 'muted', result: null,
    });
    // 卸载标记（定时器/轮询里 setState 前看一眼；不用 ref，保持离线假 React 也能跑）。
    const alive = R.useState({ current: true })[0];
    // 单飞闩：按钮的 disabled 要等一次渲染才生效，连点两下不能发两个请求。
    const latch = R.useState({ submitting: false })[0];
    if (typeof R.useEffect === 'function') {
      R.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);
    }

    // ---- 报告事实 ----
    const form = props && props.form;
    const formState = form && form.state && typeof form.state === 'object' ? form.state : null;
    const revision = formState ? formState.revision : undefined;
    const configValue = formState && formState.value && typeof formState.value === 'object'
      ? formState.value : null;
    const report = view.report || null;
    const summary = view.summary || null;
    const objects = objectsOf(report || summary);
    const groups = workspaceGroupsOf(report || summary);
    const currentWorkspace = reportRootOf(report) || (groups[0] && groups[0].workspace) || '';
    const excluded = isWorkspaceExcluded(configValue, currentWorkspace);
    const busy = fix.phase === 'requesting' || fix.phase === 'fixing';

    /** 读报告：先小摘要（几 KB），再全量报告（勾选清单要 `objects[]`）。 */
    const load = async (options = {}) => {
      const files = filesOf();
      if (!files || typeof files.read !== 'function') {
        const reason = '没有文件读通道（remote.workspaceFiles 不可用）';
        setView({ phase: 'none', text: reason, tone: 'muted', summary: null, report: null, from: '', tried: [] });
        logEvent('ui.read.failed', reason, { path: SUMMARY_REL });
        return;
      }
      setView((prev) => ({ ...(prev || {}), phase: 'loading', text: '正在读报告…', tone: 'muted' }));
      const tried = [];
      const gotSummary = await readJsonRel(files, SUMMARY_REL, sessionIds, 8000);
      if (!gotSummary.ok) {
        if (gotSummary.tried && gotSummary.tried.length) tried.push(...gotSummary.tried);
        else tried.push(SUMMARY_REL + '：' + gotSummary.error);
      }
      const gotReport = await readJsonRel(files, REPORT_REL_PATH, sessionIds, 12000);
      if (!gotReport.ok && gotReport.tried && gotReport.tried.length) tried.push(...gotReport.tried);
      const nextReport = gotReport.ok ? gotReport.value : null;
      const nextSummary = gotSummary.ok ? gotSummary.value : null;
      if (!nextReport && !nextSummary) {
        const reason = '读不到报告（宿主可能还没扫）';
        setView({ phase: 'none', text: reason, tone: 'muted', summary: null, report: null, from: '', tried });
        logEvent('ui.read.failed', reason + '（' + tried.length + ' 次尝试都失败）', { path: SUMMARY_REL });
        return;
      }
      const line = describeResult(nextReport || nextSummary);
      // 勾选：默认全选；用户之前取消过的（同一路径）仍然保持取消。
      const nextObjects = objectsOf(nextReport || nextSummary);
      const known = new Set(Array.isArray(picks.known) ? picks.known : []);
      const selected = new Set(Array.isArray(picks.selected) ? picks.selected : []);
      const nextSelected = nextObjects
        .map((object) => object.path)
        .filter((path) => !known.has(path) || selected.has(path));
      setPicks({ selected: nextSelected, known: nextObjects.map((object) => object.path) });
      setView({
        phase: 'done',
        text: line.text,
        tone: line.tone,
        summary: nextSummary,
        report: nextReport,
        from: gotReport.ok ? REPORT_REL_PATH : SUMMARY_REL,
        // 全量报告读不到时把原因摊开（摘要读到了也一样：勾选清单缺的就是全量那份）。
        tried: nextReport ? [] : tried,
      });
      if (options && options.afterFix) logEvent('ui.report.reloaded', '修复后重读报告', { path: REPORT_REL_PATH });
    };

    if (typeof R.useEffect === 'function') {
      const sessionKey = sessionIds.join(',');
      R.useEffect(() => {
        if (!sessionKey) return;
        void load();
      }, [sessionKey]);
    }

    /** 轮询 fix-result：每 2 秒一次、最多 120 秒；**id 对得上才算本次结果**。 */
    const waitForFixResult = async (requestId) => {
      const files = filesOf();
      if (!files || typeof files.read !== 'function') {
        return { ok: false, tone: 'warn', text: '没有文件读通道（remote.workspaceFiles 不可用），读不到修复结果' };
      }
      const startedAt = Date.now();
      let lastNote = '';
      while (true) {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= FIX_TIMEOUT_MS) {
          return {
            ok: false,
            tone: 'warn',
            text: '没等到修复结果（已等 ' + Math.round(FIX_TIMEOUT_MS / 1000) + ' 秒）：'
              + '可能 UAC 窗口还在等授权，或提权进程没有写 ' + FIX_RESULT_REL + '。'
              + (lastNote ? '（最后一次看到：' + String(lastNote).slice(0, 160) + '）' : '')
              + '请重读报告并人工核对，不要当成成功。',
          };
        }
        await waitMs(FIX_POLL_MS);
        if (!alive.current) return { ok: false, tone: 'muted', text: '页面已卸载，停止等待修复结果' };
        const got = await readJsonRel(files, FIX_RESULT_REL, sessionIds, 8000);
        if (!got.ok) {
          lastNote = (got.tried && got.tried.length) ? got.tried[0] : got.error;
          continue;
        }
        const parsed = summarizeFixResult(got.value);
        if (!parsed.id || parsed.id !== requestId) {
          lastNote = '结果文件里的 id=' + (parsed.id || '（没有 id）') + '，不是本次请求 ' + requestId;
          continue;
        }
        const line = describeFixResult(parsed);
        return { ok: true, tone: line.tone, text: line.text, result: parsed };
      }
    };

    /** 取勾选对象（保持报告顺序）。 */
    const chosenObjects = () => {
      const selected = new Set(Array.isArray(picks.selected) ? picks.selected : []);
      return objects.filter((object) => selected.has(object.path));
    };

    /** 按钮不可用的原因（空串 = 可以点）。 */
    const disabledReasonOf = () => {
      if (!form) return '这个页面没有配置表单（form），修复请求交不出去';
      if (typeof form.mutate !== 'function') return '页面宿主没有提供保存通道（form.mutate）';
      if (formState && formState.status === 'unavailable') return '这一行没有配置命名空间（form.state.status=unavailable）';
      if (formState && formState.status === 'loading') return '配置还在加载（form.state.status=loading），稍后再试';
      if (formState && formState.writable === false) return '当前配置不可写（只读模式），修复请求交不出去';
      if (!report) return '读不到全量报告（' + REPORT_REL_PATH + '），不知道对象属于哪个工作区，不能提交修复请求';
      if (!reportRootOf(report)) return '全量报告里没有 root 字段，不知道修复哪个工作区';
      if (view.phase === 'loading' || view.phase === 'init') return '正在读报告…';
      if (!objects.length) return '报告里没有可修复的缺项对象';
      if (!chosenObjects().length) return '还没有勾选对象（先在上面勾选要修复的行）';
      if (busy) return '修复正在进行中…';
      return '';
    };

    /** 点「沙箱物化修复」：单飞（连点两下也只有一个请求）后再进真正的执行。 */
    const submitFix = async () => {
      if (busy || latch.submitting) return;
      latch.submitting = true;
      try {
        await runFixRequest();
      } finally {
        latch.submitting = false;
      }
    };

    /** 真正执行一次：组请求 → form.mutate 写 fixRequest → 轮询结果 → 重读报告。 */
    const runFixRequest = async () => {
      const reason = disabledReasonOf();
      if (reason) {
        setFix({ phase: 'idle', requestId: '', text: '还不能修复：' + reason, tone: 'warn', result: null });
        return;
      }
      const chosen = chosenObjects();
      const request = buildFixRequest(reportRootOf(report), chosen.map((object) => ({
        path: object.path,
        items: object.missing,
      })));
      if (!request.objects.length) {
        setFix({ phase: 'idle', requestId: '', text: '没有勾选到有效对象（缺项为空），没有提交', tone: 'warn', result: null });
        return;
      }
      setFix({ phase: 'requesting', requestId: request.id, text: '正在把修复请求写进插件配置…', tone: 'muted', result: null });
      let accepted;
      try {
        accepted = form.mutate(
          [{ op: 'set', path: [FIX_REQUEST_KEY], value: JSON.stringify(request) }],
          revision,
        );
      } catch (err) {
        const text = '写修复请求失败：' + String((err && err.message) || err) + '（修复没有开始）';
        setFix({ phase: 'error', requestId: request.id, text, tone: 'bad', result: null });
        logEvent('ui.fix.failed', text, { requestId: request.id });
        return;
      }
      let acceptedFlag;
      try {
        acceptedFlag = await accepted;
      } catch (err) {
        const text = '写修复请求失败：' + String((err && err.message) || err) + '（修复没有开始）';
        setFix({ phase: 'error', requestId: request.id, text, tone: 'bad', result: null });
        logEvent('ui.fix.failed', text, { requestId: request.id });
        return;
      }
      if (acceptedFlag === false) {
        const text = '宿主拒绝了这次修改（值无效或配置已被并发修改），修复没有开始';
        setFix({ phase: 'error', requestId: request.id, text, tone: 'bad', result: null });
        logEvent('ui.fix.failed', text, { requestId: request.id });
        return;
      }
      logEvent('ui.fix.requested', '已提交修复请求', {
        requestId: request.id, workspace: request.workspace, objects: request.objects.length,
      });
      setFix({
        phase: 'fixing',
        requestId: request.id,
        text: '已递交修复请求（' + request.objects.length + ' 个对象）；'
          + '等待 UAC 授权与提权进程写结果，最多等 120 秒…',
        tone: 'warn',
        result: null,
      });
      const waited = await waitForFixResult(request.id);
      if (!alive.current) return;
      if (waited.ok) {
        const result = waited.result;
        setFix({
          phase: result.cancelled ? 'cancelled' : (result.failed > 0 || !result.ok ? 'failed' : 'done'),
          requestId: request.id,
          text: waited.text,
          tone: waited.tone,
          result,
        });
      } else {
        setFix({ phase: 'timeout', requestId: request.id, text: waited.text, tone: waited.tone, result: null });
      }
      logEvent('ui.fix.result', waited.text, { requestId: request.id });
      // 不论成功/失败/超时，都重读一次报告：面板展示的永远是文件里的事实。
      try { await load({ afterFix: true }); } catch { /* load 自己兜底 */ }
    };

    /** 勾选切换（state 里存数组，渲染时转 Set 查）。 */
    const togglePick = (path) => {
      if (busy) return;
      setPicks((prev) => {
        const current = Array.isArray(prev && prev.selected) ? prev.selected : [];
        const selected = current.includes(path)
          ? current.filter((item) => item !== path)
          : current.concat(path);
        return { selected, known: (prev && prev.known) || [] };
      });
    };

    const handlers = {
      reload: () => { if (!busy) void load(); },
      selectAll: () => {
        if (busy) return;
        const paths = objects.map((object) => object.path);
        setPicks({ selected: paths, known: paths });
      },
      selectNone: () => {
        if (busy) return;
        setPicks({ selected: [], known: objects.map((object) => object.path) });
      },
      toggle: togglePick,
      fix: () => { void submitFix(); },
    };

    const diagLines = (() => {
      try {
        const records = (logger && typeof logger.logs === 'function') ? logger.logs(6) : [];
        return (Array.isArray(records) ? records : []).map((entry) => {
          const item = entry && typeof entry === 'object' ? entry : {};
          return String(item.ts || '') + ' ' + String(item.level || '') + ' '
            + String(item.event || item.message || '');
        });
      } catch {
        return [];
      }
    })();

    const model = {
      view,
      picks,
      fix,
      groups,
      objects,
      handlers,
      diagLines,
      currentWorkspace,
      excluded,
      disabledReason: disabledReasonOf(),
    };
    try {
      return buildTree(R, model);
    } catch (err) {
      // fail-open：面板自己的渲染错误不能把插件管理页搞白；原因照实说。
      return buildNotice(R, '面板渲染失败（已跳过）：' + String((err && err.message) || err));
    }
  };

  return {
    inject: CLIENT_INJECT,
    apply(inner) {
      let slots = null;
      try {
        slots = (inner && inner.slots) || (ctx && ctx.slots);
      } catch {
        slots = (inner && inner.slots) || null;
      }
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        return () => {};
      }
      // 第一个参数是**插槽名**（`slots.inject(slotName, cb)`），不是 key（2026-11-20 真机踩过）。
      slots.inject('plugins.row.config', () => slots.register({ name: 'plugins.row.config', key: SLOT_KEY }, Panel));
      return () => {};
    },
  };
}
