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

/** 宿主写的"多工作区扫描摘要"（每个被管工作区的 `.dsh-veneer/` 都有一份，面板读当前工作区那份）。 */
export const AGGREGATE_REL = '.dsh-veneer/workspaces.json';
/** 每个工作区的缺项明细（单独一个文件；很大，按块读）。 */
export const DETAILS_REL = '.dsh-veneer/workspaces-details.json';

/**
 * 宿主汇总（`.dsh-veneer/workspaces.json`）→ 面板行（按队列顺序，当前工作区标出来）。
 * 纯函数（测试直接调）。
 *
 * @param {object|null} aggregate `{version, updatedAt, workspaces:[{root,status,counts,scannedAt,reason}]}`
 * @param {string} [currentWorkspace]
 * @returns {Array<{root:string, text:string, tone:string, current:boolean}>}
 */
export function workspaceStatusRowsOf(aggregate, currentWorkspace = '') {
  const items = aggregate && Array.isArray(aggregate.workspaces) ? aggregate.workspaces : [];
  const rows = [];
  for (const item of items) {
    if (!item || typeof item.root !== 'string' || !item.root) continue;
    const counts = item.counts && typeof item.counts === 'object' ? item.counts : {};
    const scanned = item.scannedAt ? timestampText(item.scannedAt) : '';
    const current = !!currentWorkspace && sameWorkspace(item.root, currentWorkspace);
    const status = String(item.status || 'unknown');
    let text = '';
    let tone = 'muted';
    if (status === 'ok') {
      text = '无缺项（检查 ' + (counts.checked || 0) + '）';
      tone = 'good';
    } else if (status === 'incomplete') {
      text = '缺 ' + (counts.missing || 0) + '（检查 ' + (counts.checked || 0) + '）';
      tone = 'warn';
    } else if (status === 'partial') {
      text = '部分失败：失败 ' + (counts.failed || 0) + (item.reason ? '；' + item.reason : '');
      tone = 'warn';
    } else if (status === 'root-absent') {
      text = '根归宿主（本插件不动手）' + (item.reason ? '：' + item.reason : '');
    } else if (status === 'failed') {
      text = '扫描失败：' + (item.reason || '未知原因');
      tone = 'bad';
    } else if (status === 'unsupported') {
      text = '不支持（非 Windows）';
    } else {
      text = '状态：' + status;
    }
    rows.push({
      root: item.root,
      text: text + (scanned ? ' · ' + scanned : ''),
      tone,
      current,
    });
  }
  return rows;
}

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
 * 配置里"要管的工作区"列表（`workspaces`）。**空数组 = 管平台全部工作区**（2026-11-23 简化后
 * 这是唯一的面向用户字段；面板「管理工作区」写它）。
 * @param {object|null} configValue `form.state.value`（完整配置对象）
 * @returns {string[]} 有效路径（能归一化不了的项跳过）
 */
export function managedPathsOf(configValue) {
  if (!configValue || typeof configValue !== 'object') return [];
  const list = Array.isArray(configValue.workspaces) ? configValue.workspaces : [];
  const out = [];
  for (const item of list) {
    const path = item && typeof item === 'object' && typeof item.path === 'string' ? item.path.trim() : '';
    if (path) out.push(path);
  }
  return out;
}

/**
 * 平台工作区快照 → 路径列表（`useWorkspaces` 的 `snapshot.items`；去重、只留带路径的）。
 * @param {object|null} snapshot
 */
export function platformPathsOf(snapshot) {
  const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const raw = item.path || item.root || item.cwd || item.dir;
    const path = typeof raw === 'string' ? raw.trim() : '';
    if (!path) continue;
    if (out.some((existing) => sameWorkspace(existing, path))) continue;
    out.push(path);
  }
  return out;
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
  wsList: { display: 'flex', flexDirection: 'column', gap: '2px', margin: '6px 0' },
  wsOption: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 2px', fontSize: '13px', cursor: 'pointer' },
  wsPath: { overflowWrap: 'anywhere' },
  aggRow: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '2px 0', fontSize: '12px', flexWrap: 'wrap' },
  itemReadonly: { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 4px', opacity: 0.7, fontSize: '12px' },
  itemReadonlyRow: { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0', opacity: 0.65, fontSize: '12px' },
  wsBlock: { marginBottom: '10px' },
  treeRow: { display: 'flex', alignItems: 'center', gap: '4px' },
  caret: { background: 'transparent', border: 'none', cursor: 'pointer', width: 18, padding: 0, color: 'inherit', font: 'inherit' },
  caretSpacer: { display: 'inline-block', width: 18 },
  partialMark: { color: TOKENS.warn, fontSize: 12 },
  dialogBackdrop: { position: 'fixed', inset: '0', zIndex: 2147483000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' },
  dialog: { width: 'min(560px, calc(100vw - 48px))', maxHeight: 'min(640px, calc(100vh - 48px))', overflow: 'auto', background: TOKENS.bg, color: TOKENS.text, border: '1px solid ' + TOKENS.border, borderRadius: 10, padding: '14px 16px', boxShadow: '0 8px 24px rgba(0,0,0,0.25)' },
  dialogTitle: { fontSize: '15px', fontWeight: 600, marginBottom: '6px' },
  dialogFoot: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' },
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

// ---------------------------------------------------------------------------
// 缺项对象 → 目录树（2026-11-23 主人要求：按工作区收起 / 有层级 / 父子三态联动）
// ---------------------------------------------------------------------------

/**
 * 勾选路径 → 按工作区拆的修复请求素材（多工作区一起提交时，宿主按 workspace 路由）。
 *
 * @param {object|null} details
 * @param {string} currentWorkspace
 * @param {Set<string>|string[]} selectedPaths
 * @param {Array<{path:string, missing:string[], isDir:boolean}>} [fallbackObjects] 明细读不到时用当前工作区的对象
 * @returns {Array<{workspace:string, objects:Array<{path:string, missing:string[], isDir:boolean}>}>}
 */
export function fixGroupsOf(details, currentWorkspace, selectedPaths, fallbackObjects = []) {
  const selected = selectedPaths instanceof Set ? selectedPaths : new Set(Array.isArray(selectedPaths) ? selectedPaths : []);
  const groupsNow = workspacesDetailGroups(details, currentWorkspace);
  const list = groupsNow.some((group) => group.objects.length)
    ? groupsNow
    : (Array.isArray(fallbackObjects) && fallbackObjects.length && currentWorkspace
      ? [{ workspace: currentWorkspace, objects: fallbackObjects }]
      : []);
  return list
    .map((group) => ({
      workspace: group.workspace,
      objects: group.objects.filter((object) => selected.has(object.path)),
    }))
    .filter((group) => group.objects.length > 0);
}

/**
 * 宿主明细文件（所有工作区的缺项对象）→ 按工作区分组，当前工作区可勾选。
 *
 * @param {object|null} details `workspaces-details.json` 解析结果
 * @param {string} [currentWorkspace]
 * @returns {Array<{workspace:string, current:boolean, status:string, objects:Array<{path:string, missing:string[], isDir:boolean}>}>}
 */
export function workspacesDetailGroups(details, currentWorkspace = '') {
  const items = details && Array.isArray(details.workspaces) ? details.workspaces : [];
  const groups = [];
  for (const item of items) {
    if (!item || typeof item.root !== 'string' || !item.root) continue;
    const objects = [];
    for (const obj of Array.isArray(item.objects) ? item.objects : []) {
      if (!obj || typeof obj.path !== 'string' || !obj.path) continue;
      objects.push({
        path: obj.path,
        missing: (Array.isArray(obj.items) ? obj.items : []).filter((name) => ITEM_ORDER.includes(name)),
        isDir: !!obj.isDir,
      });
    }
    groups.push({
      workspace: item.root,
      current: !!currentWorkspace && sameWorkspace(item.root, currentWorkspace),
      status: typeof item.status === 'string' ? item.status : '',
      objects,
    });
  }
  return groups;
}
export function pathSegmentsOf(rootPath, objectPath) {
  const root = String(rootPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const full = String(objectPath || '').replace(/\\/g, '/');
  const lower = full.toLowerCase();
  let rel;
  if (root && lower.startsWith(root + '/')) rel = full.slice(root.length + 1);
  else rel = full.replace(/^[A-Za-z]:\//, '');
  return rel.split('/').filter(Boolean);
}

/**
 * 把缺项对象列表变成目录树（根节点 = 工作区）。
 *
 * @param {string} rootPath 工作区根
 * @param {Array<{path:string, missing:string[], isDir?:boolean}>} objects
 * @returns {{name:string, path:string, isDir:boolean, object:object|null, children:Array}}
 */
export function buildObjectTree(rootPath, objects) {
  const root = {
    name: String(rootPath || ''), path: String(rootPath || ''), isDir: true, object: null, children: [],
  };
  const byKey = new Map();
  byKey.set('', root);
  /** 按相对键取/建目录节点（同一个键只建一次）。 */
  const ensureDir = (key, name, parent) => {
    let node = byKey.get(key);
    if (!node) {
      node = {
        name,
        path: parent.path.replace(/[\\/]+$/, '') + '\\' + name,
        isDir: true,
        object: null,
        children: [],
      };
      parent.children.push(node);
      byKey.set(key, node);
    }
    return node;
  };
  for (const obj of Array.isArray(objects) ? objects : []) {
    if (!obj || typeof obj.path !== 'string' || !obj.path) continue;
    const segments = pathSegmentsOf(rootPath, obj.path);
    if (!segments.length) continue;
    let key = '';
    let parent = root;
    for (let index = 0; index < segments.length; index += 1) {
      const nextKey = key ? key + '/' + segments[index] : segments[index];
      const last = index === segments.length - 1;
      const node = ensureDir(nextKey, segments[index], parent);
      if (last) {
        // 目录本身也可能是一个缺项对象（例如缺项的是 lab 这个目录）——保留它的 object。
        node.object = obj;
      }
      parent = node;
      key = nextKey;
    }
  }
  return root;
}

/** 一个节点下的所有**缺项对象**路径（目录节点 = 它自己 + 它下面所有文件）。 */
export function collectLeafPaths(node) {
  const out = [];
  const walk = (item) => {
    if (!item) return;
    for (const child of item.children || []) walk(child);
    if (item.object) out.push(item.object.path);
  };
  walk(node);
  return out;
}

/**
 * 一个节点当前的三态：`on`（全选）/ `partial`（部分）/ `off`（没选）。
 * @returns {'on'|'partial'|'off'}
 */
export function treeCheckState(node, selectedSet) {
  const leaves = collectLeafPaths(node);
  if (!leaves.length) return 'off';
  let on = 0;
  for (const path of leaves) if (selectedSet && selectedSet.has(path)) on += 1;
  if (on === 0) return 'off';
  return on === leaves.length ? 'on' : 'partial';
}

/**
 * 点一个节点后的新选择：
 *   · 已全选 → 取消它下面全部文件；
 *   · 否则（off/partial）→ 把它下面全部文件选上。
 * 目录被勾选 = 它下面所有缺项对象都会物化（请求里带的是展开后的文件）。
 *
 * @param {object} node
 * @param {Set<string>|string[]} selectedSet
 * @returns {string[]} 新的已选文件路径数组
 */
export function toggleTreeSelection(node, selectedSet) {
  const set = selectedSet instanceof Set ? new Set(selectedSet) : new Set(Array.isArray(selectedSet) ? selectedSet : []);
  const state = treeCheckState(node, set);
  const leaves = collectLeafPaths(node);
  if (state === 'on') for (const path of leaves) set.delete(path);
  else for (const path of leaves) set.add(path);
  return Array.from(set);
}
export function workspacesValueOf(draft, paths) {
  const list = (Array.isArray(draft) ? draft : []).filter((path) => typeof path === 'string' && path);
  const all = Array.isArray(paths) ? paths : [];
  const allSelected = all.length > 0 && all.every((path) => list.some((item) => sameWorkspace(item, path)));
  return allSelected ? [] : list.map((path) => ({ path }));
}

/**
 * 「管理工作区」弹窗（2026-11-23 主人定：**关掉弹窗时写配置**，不再要单独的保存按钮）。
 * 纯渲染；草稿与保存都在 `Panel` 的 hooks 里。
 */
export function buildWorkspaceDialog(R, model) {
  const e = R.createElement;
  const wsModel = (model && model.workspaces) || {};
  const handlers = (model && model.handlers) || {};
  const paths = Array.isArray(wsModel.paths) ? wsModel.paths : [];
  const draft = Array.isArray(wsModel.draft) ? wsModel.draft : [];
  const saving = !!wsModel.saving;
  const body = [];
  body.push(e('div', { key: 'd', style: styles.muted },
    '勾选的工作区会被主动检查；全勾 = 管平台全部（含以后新建的）。关掉这个弹窗时写配置。'));
  if (!paths.length) {
    body.push(e('div', { key: 'empty', style: styles.tertiary },
      '平台工作区表还没读到（或平台没有工作区）；这只是清单读不到，不影响已有报告。'));
  } else {
    body.push(e('div', { key: 'list', style: styles.wsList }, paths.map((path) => e('label', {
      key: 'w:' + path,
      style: styles.wsOption,
    },
    e('input', {
      type: 'checkbox',
      checked: draft.some((item) => sameWorkspace(item, path)),
      disabled: saving,
      onChange: () => { if (typeof handlers.toggleWorkspace === 'function') handlers.toggleWorkspace(path); },
    }),
    e('span', { style: styles.wsPath }, path)))));
  }
  return e('div', { key: 'wsDialog', style: styles.dialogBackdrop },
    e('div', { role: 'dialog', 'aria-label': '管理工作区', style: styles.dialog },
      e('div', { key: 't', style: styles.dialogTitle }, '管理工作区'),
      ...body,
      e('div', { key: 'foot', style: styles.dialogFoot }, [
        e('span', { key: 'hint', style: styles.tertiary }, saving ? '保存中…' : (wsModel.text || '')),
        e('button', {
          key: 'close',
          type: 'button',
          style: { ...styles.button, ...(saving ? styles.disable : {}) },
          disabled: saving || typeof handlers.closeWorkspaces !== 'function',
          onClick: handlers.closeWorkspaces,
        }, '关闭'),
      ])));
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
      key: 'rescan',
      type: 'button',
      style: { ...styles.button, ...(busy ? styles.disable : {}) },
      disabled: !!busy,
      title: '让宿主重新扫描（重操作：后台逐个工作区重扫；结果由 5 秒自动刷新读回）',
      onClick: handlers.rescan,
    }, '重新扫描'),
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
  children.push(e('div', { key: 'statusCard', style: styles.card }, statusChildren));

  // ---- 管理工作区（R-13：唯一字段 workspaces；空列表 = 管平台全部） ----
  // 卡片只放入口与摘要；勾选在**弹窗**里做（2026-11-23 主人定：关掉弹窗时写配置）。
  const wsModel = model.workspaces || {};
  const wsChildren = [];
  wsChildren.push(e('div', { key: 'h', style: styles.title2 }, '管理工作区'));
  wsChildren.push(e('div', { key: 'd', style: styles.muted },
    '勾选的工作区会被主动检查（会话首条消息扫描、有缺项弹窗）。全勾 = 管平台全部（含以后新建的）；'
    + '在弹窗里勾选、关掉弹窗时写配置；面板展示的仍是上次检查的结果。'));
  wsChildren.push(e('div', { key: 'row', style: styles.row }, [
    e('button', {
      key: 'open',
      type: 'button',
      style: { ...styles.button, ...(wsModel.saving ? styles.disable : {}) },
      disabled: !!wsModel.saving || typeof handlers.openWorkspaces !== 'function',
      onClick: handlers.openWorkspaces,
    }, '管理工作区…'),
    e('span', { key: 'hint', style: styles.tertiary }, wsModel.text
      || (wsModel.allMode ? '当前：管平台全部工作区' : '当前：管 ' + wsModel.managedCount + ' 个')),
  ]));
  children.push(e('div', { key: 'wsCard', style: styles.card }, wsChildren));

  // ---- 各工作区扫描结果（宿主汇总；队列顺序） ----
  const aggRows = workspaceStatusRowsOf(model.aggregate, model.currentWorkspace);
  const aggChildren = [];
  aggChildren.push(e('div', { key: 'h', style: styles.title2 }, '各工作区扫描结果'));
  aggChildren.push(e('div', { key: 'd', style: styles.muted },
    '宿主按队列逐个扫描，这里是每个工作区**最近一次**的结果（"上次检查"，不实时刷新）。'
    + '▶ = 当前工作区。'));
  if (aggRows.length) {
    aggChildren.push(e('div', { key: 'list', style: styles.wsList }, aggRows.map((row) => e('div', {
      key: 'agg:' + row.root,
      style: styles.aggRow,
    },
    e('span', { key: 'path', style: styles.wsPath }, (row.current ? '▶ ' : '') + row.root),
    e('span', { key: 'status', style: { color: toneColor(row.tone) } }, row.text)))));
  } else {
    aggChildren.push(e('div', { key: 'empty', style: styles.tertiary },
      '还没有汇总（宿主还没上报扫描结果，或宿主是旧版本）。'));
  }
  children.push(e('div', { key: 'aggCard', style: styles.card }, aggChildren));
  if (wsModel.open) children.push(buildWorkspaceDialog(R, model));

  // ---- 勾选清单：按工作区的目录树（当前工作区可勾选；其它可展开看，只读）----
  const detailGroups = (Array.isArray(model.detailGroups) ? model.detailGroups : [])
    .filter((group) => group && group.objects && group.objects.length > 0);
  if (detailGroups.length > 0) {
    const currentGroup = detailGroups.find((group) => group.current) || null;
    const allLeaves = [];
    for (const group of detailGroups) {
      allLeaves.push(...collectLeafPaths(buildObjectTree(group.workspace, group.objects)));
    }
    const selectedCount = allLeaves.filter((path) => selectedSet.has(path)).length;
    const selectChildren = [];
    selectChildren.push(e('div', { key: 'head', style: styles.row }, [
      e('span', { key: 'stat', style: styles.title2 }, '已选 ' + selectedCount + ' / 共 ' + allLeaves.length + ' 个缺项对象'),
      e('button', {
        key: 'all',
        type: 'button',
        style: { ...styles.button, ...(busy || selectedCount === allLeaves.length ? styles.disable : {}) },
        disabled: !!busy || selectedCount === allLeaves.length,
        onClick: handlers.selectAll,
      }, '全选'),
      e('button', {
        key: 'none',
        type: 'button',
        style: { ...styles.button, ...(busy || selectedCount === 0 ? styles.disable : {}) },
        disabled: !!busy || selectedCount === 0,
        onClick: handlers.selectNone,
      }, '全不选'),
      e('span', { key: 'hint', style: styles.tertiary },
        '所有工作区都能勾选；提交后宿主按工作区各自弹一次 UAC。勾目录 = 它下面所有缺项一起修'),
    ]));
    const renderNode = (node, depth) => {
      if (!node) return null;
      const leaf = !!node.object;
      const state = treeCheckState(node, selectedSet);
      const open = model.treeOpen ? model.treeOpen[node.path] !== false : true;
      const rowChildren = [
        node.children.length
          ? e('button', {
            key: 'caret',
            type: 'button',
            style: styles.caret,
            title: open ? '收起' : '展开',
            onClick: () => { if (typeof handlers.toggleExpand === 'function') handlers.toggleExpand(node.path); },
          }, open ? '▾' : '▸')
          : e('span', { key: 'caret', style: styles.caretSpacer }, ' '),
        e('label', { key: 'label', style: styles.item }, [
          e('input', {
            key: 'cb',
            type: 'checkbox',
            checked: state === 'on',
            disabled: !!busy,
            onChange: () => {
              // **目录（有子节点）一律走 toggleNode**：连它自己 + 它下面全部缺项一起选/取消。
              // （以前用 `!!!node.object` 判叶子，目录本身也是缺项对象时被当叶子，只切了自己 —— E-020）
              if (node.children.length > 0) {
                if (typeof handlers.toggleNode === 'function') handlers.toggleNode(node);
              } else {
                handlers.toggle(node.path);
              }
            },
          }),
          state === 'partial'
            ? e('span', { key: 'partial', style: styles.partialMark, title: '部分选中' }, '◐')
            : null,
          e('span', { key: 'kind', style: styles.kindTag }, node.isDir ? '目录' : '文件'),
          e('span', { key: 'name', style: styles.pathText, title: node.path }, node.name),
          ...(leaf ? node.object.missing.map((item) => e('span', {
            key: 'm:' + item, style: styles.badge, title: ITEM_HINT[item] || item,
          }, item)) : []),
        ]),
      ];
      const childRows = [];
      if (open) {
        for (const child of node.children) {
          const row = renderNode(child, depth + 1);
          if (row) childRows.push(row);
        }
      }
      return e('div', { key: 'n:' + node.path, style: { marginLeft: depth * 14 } }, [
        e('div', { key: 'row', style: styles.treeRow }, rowChildren),
        ...childRows,
      ]);
    };
    for (const group of detailGroups) {
      const open = model.treeOpen ? model.treeOpen['ws:' + group.workspace] !== false : true;
      const rootNode = buildObjectTree(group.workspace, group.objects);
      const groupRows = [
        e('div', { key: 'gh', style: styles.treeRow }, [
          e('button', {
            key: 'caret',
            type: 'button',
            style: styles.caret,
            title: open ? '收起' : '展开',
            onClick: () => { if (typeof handlers.toggleExpand === 'function') handlers.toggleExpand('ws:' + group.workspace); },
          }, open ? '▾' : '▸'),
          e('span', { key: 'ws', style: styles.title2 }, group.workspace),
          e('span', { key: 'cnt', style: styles.tertiary },
            '　缺 ' + group.objects.length + (group.current ? '（当前工作区）' : '')),
        ]),
      ];
      if (open) {
        for (const child of rootNode.children) {
          const row = renderNode(child, 0);
          if (row) groupRows.push(row);
        }
      }
      selectChildren.push(e('div', { key: 'grp:' + group.workspace, style: styles.wsBlock }, groupRows));
    }
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

  /**
   * 按块读一个大 JSON（缺项明细可能几百 KB，整读会被文件接口挡掉）。
   * 先整读；失败再试几种 range 形状（宿主不同版本的参数不一样），都失败就返回错误。
   *
   * @param {object} files remote.workspaceFiles
   * @param {string} rel 工作区内相对路径
   * @param {string[]} sessionIds
   * @param {number} timeoutMs
   * @returns {Promise<{ok:boolean, value?:object, error?:string, tried?:string[]}>}
   */
  const readJsonRelChunked = async (files, rel, sessionIds, timeoutMs) => {
    const tried = [];
    const ids = Array.isArray(sessionIds) ? sessionIds : [];
    if (!files || typeof files.read !== 'function') return { ok: false, error: '没有文件读通道', tried };
    const whole = await readJsonRel(files, rel, ids, timeoutMs);
    if (whole.ok) return whole;
    if (whole && whole.tried) tried.push(...whole.tried);
    // range 的形状：不同版本可能叫 start/end、offset/length、start/length——都试一遍。
    const shapes = [
      { start: 0, end: 0 },
      { offset: 0, length: 0 },
      { start: 0, length: 0 },
    ];
    const chunk = 96 * 1024;
    for (const shape of shapes) {
      for (const sessionId of ids) {
        const parts = [];
        let failed = '';
        for (let offset = 0; offset < 8 * 1024 * 1024; offset += chunk) {
          const range = { ...shape };
          if ('offset' in shape) { range.offset = offset; range.length = chunk; }
          if ('start' in shape) { range.start = offset; range[('end' in shape) ? 'end' : 'length'] = offset + chunk; }
          let signal;
          try {
            signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
              ? AbortSignal.timeout(timeoutMs) : undefined;
          } catch { signal = undefined; }
          let res;
          try {
            res = await files.read(sessionId, rel, range, signal);
          } catch (err) {
            failed = String((err && err.message) || err).slice(0, 120);
            break;
          }
          const found = extractText(res);
          if (found.error) { failed = found.error; break; }
          const text = found.text || '';
          parts.push(text);
          // 如果 range 被忽略（整份回来了，长度 > 块大小）：别再拼，直接用。
          if (text.length > chunk) { parts.length = 0; parts.push(text); break; }
          if (text.length < chunk) break;
        }
        if (failed) { tried.push(JSON.stringify(shape) + '：' + failed); continue; }
        const text = parts.join('');
        // 块没被切（range 被忽略）时 parts 只有整份，解析成功就成功。
        let parsed;
        try { parsed = JSON.parse(text); } catch (err) {
          tried.push(JSON.stringify(shape) + '：JSON 解析失败（' + String((err && err.message) || err).slice(0, 80) + '）');
          continue;
        }
        if (parsed && typeof parsed === 'object') return { ok: true, value: parsed, sessionId, via: 'chunked' };
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
    const useWorkspaces = props && props.useWorkspaces;
    const wsSnapshot = typeof useWorkspaces === 'function' ? useWorkspaces((snapshot) => snapshot) : null;
    // 管理工作区：草稿为 null 时按"已保存的配置"显示。
    const [wsEdit, setWsEdit] = R.useState({ open: false, draft: null, saving: false, text: '' });
    // 目录树的展开状态（路径 → 是否展开；未记录 = 展开）。
    const [treeOpen, setTreeOpen] = R.useState({});
    // 多工作区汇总（宿主写、每个工作区都有一份）。
    const [aggregate, setAggregate] = R.useState(null);
    // 每个工作区的缺项明细（单独文件，可能几百 KB；按块读）。
    const [details, setDetails] = R.useState(null);
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
    // 管理工作区：平台清单 + 已配置清单（配置里有但平台表没有的也列出来，允许取消勾选）。
    const managedPaths = managedPathsOf(configValue);
    const platformPaths = platformPathsOf(wsSnapshot);
    const wsPaths = platformPaths.concat(
      managedPaths.filter((path) => !platformPaths.some((item) => sameWorkspace(item, path))),
    );
    const wsSaved = managedPaths.length > 0 ? managedPaths : wsPaths;
    const wsDraft = Array.isArray(wsEdit.draft) ? wsEdit.draft : wsSaved;
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
      // 多工作区汇总：宿主写到每个被管工作区的 `.dsh-veneer/workspaces.json`；读当前工作区这份即可。
      const gotAggregate = await readJsonRel(files, AGGREGATE_REL, sessionIds, 8000);
      if (gotAggregate.ok) setAggregate(gotAggregate.value);
      // 每个工作区的缺项明细（单独文件、可能很大）：按块读；读不到就退回"只有当前工作区有明细"。
      const gotDetails = await readJsonRelChunked(files, DETAILS_REL, sessionIds, 15000);
      if (gotDetails.ok) setDetails(gotDetails.value);
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
      // 汇总/明细每 5 秒刷新一次：宿主是**串行队列**逐个扫，先扫完的先写进来，
      // 只读一次会停在"只看到前几个工作区"（2026-11-23 主人现场看到的就是这个）。
      R.useEffect(() => {
        if (!sessionKey) return undefined;
        let stopped = false;
        const timer = setInterval(() => {
          if (stopped) return;
          const files = filesOf();
          if (!files || typeof files.read !== 'function') return;
          void (async () => {
            const got = await readJsonRel(files, AGGREGATE_REL, sessionIds, 8000);
            if (!stopped && got.ok) setAggregate(got.value);
            const gotD = await readJsonRelChunked(files, DETAILS_REL, sessionIds, 15000);
            if (!stopped && gotD.ok) setDetails(gotD.value);
          })().catch(() => { /* 轮询失败不打断页面 */ });
        }, 5000);
        return () => { stopped = true; clearInterval(timer); };
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

    /** 勾选对象按工作区分组（其它工作区也能一起提交；宿主按 workspace 路由到对应实例）。 */
    const chosenGroups = () => fixGroupsOf(
      details,
      currentWorkspace,
      new Set(Array.isArray(picks.selected) ? picks.selected : []),
      objects,
    );

    /** 按钮不可用的原因（空串 = 可以点）。 */
    const disabledReasonOf = () => {
      if (!form) return '这个页面没有配置表单（form），修复请求交不出去';
      if (typeof form.mutate !== 'function') return '页面宿主没有提供保存通道（form.mutate）';
      if (formState && formState.status === 'unavailable') return '这一行没有配置命名空间（form.state.status=unavailable）';
      if (formState && formState.status === 'loading') return '配置还在加载（form.state.status=loading），稍后再试';
      if (formState && formState.writable === false) return '当前配置不可写（只读模式），修复请求交不出去';
      if (view.phase === 'loading' || view.phase === 'init') return '正在读报告…';
      if (!chosenGroups().length) return '还没有勾选对象（先在上面勾选要修复的行）';
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
      const chosen = chosenGroups();
      const requests = chosen.map((group) => buildFixRequest(group.workspace, group.objects.map((object) => ({
        path: object.path,
        items: object.missing,
      })))).filter((request) => request.objects.length > 0);
      if (!requests.length) {
        setFix({ phase: 'idle', requestId: '', text: '没有勾选到有效对象（缺项为空），没有提交', tone: 'warn', result: null });
        return;
      }
      const totalObjects = requests.reduce((sum, request) => sum + request.objects.length, 0);
      setFix({
        phase: 'requesting',
        requestId: requests[0].id,
        text: '正在把修复请求写进插件配置（' + requests.length + ' 个工作区 / ' + totalObjects + ' 个对象）…',
        tone: 'muted',
        result: null,
      });
      // **逐个工作区**写令牌：宿主按 workspace 路由到对应实例；每个工作区各自弹一次 UAC。
      for (const request of requests) {
        let accepted;
        try {
          accepted = form.mutate(
            [{ op: 'set', path: [FIX_REQUEST_KEY], value: JSON.stringify(request) }],
            revision,
          );
        } catch (err) {
          const text = '写修复请求失败（' + request.workspace + '）：' + String((err && err.message) || err) + '（修复没有开始）';
          setFix({ phase: 'error', requestId: request.id, text, tone: 'bad', result: null });
          logEvent('ui.fix.failed', text, { requestId: request.id });
          return;
        }
        let acceptedFlag;
        try {
          acceptedFlag = await accepted;
        } catch (err) {
          const text = '写修复请求失败（' + request.workspace + '）：' + String((err && err.message) || err) + '（修复没有开始）';
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
      }
      const currentRequest = requests.find((request) => sameWorkspace(request.workspace, currentWorkspace)) || null;
      const pendingText = requests.length > 1
        ? '已把 ' + requests.length + ' 个工作区的修复请求交给宿主（共 ' + totalObjects + ' 个对象）；'
          + '每个工作区会各自弹一次 UAC。别的工作区的结果写进它们自己的工作区，这里会把缺项数刷新出来。'
        : '已递交修复请求（' + totalObjects + ' 个对象）；等待 UAC 授权与提权进程写结果，最多等 120 秒…';
      setFix({
        phase: 'fixing',
        requestId: currentRequest ? currentRequest.id : '',
        text: pendingText,
        tone: 'warn',
        result: null,
      });
      if (!currentRequest) {
        // 只修了别的工作区：结果不在这个工作区的 fix-result.json 里，直接收口（刷新后看缺项数）。
        if (alive.current) {
          setFix({ phase: 'done', requestId: '', text: pendingText, tone: 'warn', result: null });
          logEvent('ui.fix.result', pendingText, {});
        }
        try { await load({ afterFix: true }); } catch { /* load 自己兜底 */ }
        return;
      }
      const waited = await waitForFixResult(currentRequest.id);
      if (!alive.current) return;
      if (waited.ok) {
        const result = waited.result;
        setFix({
          phase: result.cancelled ? 'cancelled' : (result.failed > 0 || !result.ok ? 'failed' : 'done'),
          requestId: currentRequest.id,
          text: result.text || '',
          tone: waited.tone,
          result,
        });
      } else {
        setFix({ phase: 'timeout', requestId: currentRequest.id, text: waited.text, tone: waited.tone, result: null });
      }
      logEvent('ui.fix.result', waited.text, { requestId: currentRequest.id });
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

    /** 管理工作区：打开弹窗（草稿为空 = 按已保存的配置显示）。 */
    const openWorkspaces = () => {
      if (wsEdit.saving) return;
      setWsEdit({ open: true, draft: null, saving: false, text: '' });
    };

    /** 管理工作区：勾选切换（草稿只在弹窗里，**关掉弹窗时**写配置）。 */
    const toggleWorkspace = (path) => {
      if (wsEdit.saving) return;
      setWsEdit((prev) => {
        const current = Array.isArray(prev.draft) ? prev.draft : wsSaved;
        const draft = current.some((item) => sameWorkspace(item, path))
          ? current.filter((item) => !sameWorkspace(item, path))
          : current.concat(path);
        return { open: prev.open !== false, draft, saving: false, text: '' };
      });
    };

    /** 管理工作区：关弹窗 = 有改动就写配置（全勾 → 空列表 = 管平台全部）。 */
    const closeWorkspaces = async () => {
      const draft = Array.isArray(wsEdit.draft) ? wsEdit.draft : wsSaved;
      const value = workspacesValueOf(draft, wsPaths);
      const savedValue = managedPaths.map((path) => ({ path }));
      // 没改就只是关掉；有改动才写。
      if (JSON.stringify(value) === JSON.stringify(savedValue)) {
        setWsEdit({ open: false, draft: null, saving: false, text: '' });
        return;
      }
      if (!form || typeof form.mutate !== 'function') {
        setWsEdit((prev) => ({ ...prev, text: '这个页面没有保存通道（form.mutate），改不了管理工作区' }));
        return;
      }
      if (!draft.length) {
        setWsEdit((prev) => ({ ...prev, text: '至少留一个工作区：空列表表示"管全部"，无法表示"一个都不管"' }));
        return;
      }
      setWsEdit((prev) => ({ ...prev, saving: true, text: '保存中…' }));
      let accepted;
      try {
        accepted = await form.mutate([{ op: 'set', path: ['workspaces'], value }], revision);
      } catch (err) {
        setWsEdit((prev) => ({ ...prev, saving: false, text: '保存失败：' + String((err && err.message) || err) }));
        return;
      }
      if (accepted === false) {
        setWsEdit((prev) => ({ ...prev, saving: false, text: '宿主拒绝了这次修改（配置已被并发修改或值不可用）' }));
        return;
      }
      setWsEdit({
        open: false,
        draft: null,
        saving: false,
        text: value.length ? '已保存：管 ' + value.length + ' 个工作区（下次扫描生效）' : '已保存：管平台全部工作区（下次扫描生效）',
      });
      logEvent('ui.workspaces.saved', '已保存管理工作区', { count: value.length });
    };

    const handlers = {
      reload: () => { if (!busy) void load(); },
      // 「重新扫描」= 重操作：写 volatile 令牌 → 宿主把每个工作区实例排进串行队列重扫；
      // 页面自己的 5 秒轮询只负责把结果读回来（不重复触发扫描）。
      rescan: () => {
        if (busy) return;
        const form = props && props.form;
        if (!form || typeof form.mutate !== 'function') {
          setView((prev) => ({ ...(prev || {}), text: '这个页面没有保存通道（form.mutate），没法请求重新扫描', tone: 'warn' }));
          return;
        }
        void (async () => {
          try {
            setView((prev) => ({ ...(prev || {}), text: '已请求重新扫描：宿主会在后台逐个工作区重扫，稍等自动刷新结果', tone: 'muted' }));
            await form.mutate([{ op: 'set', path: ['scanRequest'], value: Date.now() }], revision);
            // 请求已发出：立刻再读一次当前文件（真正结果要等宿主扫完，5 秒轮询会补齐）。
            void load();
          } catch (err) {
            setView((prev) => ({
              ...(prev || {}),
              text: '重新扫描请求失败：' + String((err && err.message) || err),
              tone: 'warn',
            }));
          }
        })();
      },
      // 全选/全不选作用于**所有工作区**（提交时按工作区拆成多个请求，各弹一次 UAC）。
      currentDetailPaths: () => {
        try {
          const list = workspacesDetailGroups(details, currentWorkspace);
          const found = list.some((group) => group.objects.length) ? list : null;
          if (found) {
            const paths = [];
            for (const group of found) for (const object of group.objects) paths.push(object.path);
            return paths;
          }
          return objects.map((object) => object.path);
        } catch {
          return objects.map((object) => object.path);
        }
      },
      selectAll: () => {
        if (busy) return;
        const paths = handlers.currentDetailPaths();
        setPicks({ selected: paths, known: paths });
      },
      selectNone: () => {
        if (busy) return;
        const paths = handlers.currentDetailPaths();
        setPicks({ selected: [], known: paths });
      },
      toggle: togglePick,
      fix: () => { void submitFix(); },
      toggleNode: (node) => {
        if (busy) return;
        setPicks((prev) => {
          const current = Array.isArray(prev && prev.selected) ? prev.selected : [];
          return { selected: toggleTreeSelection(node, new Set(current)), known: (prev && prev.known) || [] };
        });
      },
      toggleExpand: (path) => {
        setTreeOpen((prev) => {
          const map = prev && typeof prev === 'object' ? prev : {};
          return { ...map, [path]: map[path] === false };
        });
      },
      openWorkspaces,
      toggleWorkspace,
      closeWorkspaces: () => { if (!wsEdit.saving) void closeWorkspaces(); },
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
      aggregate: aggregate || null,
      detailGroups: (() => {
        const groups = workspacesDetailGroups(details, currentWorkspace);
        if (groups.some((group) => group.objects.length > 0)) return groups;
        // 明细文件还没写到 / 读不到：至少把当前工作区的对象当一组显示。
        return objects.length && currentWorkspace
          ? [{ workspace: currentWorkspace, current: true, status: '', objects }]
          : [];
      })(),
      treeOpen,
      workspaces: {
        paths: wsPaths,
        draft: wsDraft,
        open: !!wsEdit.open,
        saving: !!wsEdit.saving,
        text: wsEdit.text || '',
        allMode: managedPaths.length === 0,
        managedCount: managedPaths.length,
      },
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
