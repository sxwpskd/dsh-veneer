// dsh-veneer —— 报告装配（核心层纯函数：不读盘、不写盘，只把扫到的形状折成报告）
//
// 报告有两份消费者：
//   · 用户：`review/veneer-state.json` 里的 status / counts / objects / command；
//   · 执行侧脚本与将来的 UI：`template`（根上到底要求哪几项）。
//
// 一次扫描的边界（写进报告，别指望它是实时的）：
//   · 只保证**扫描那一刻**的这棵树；
//   · 扫完到用户执行命令之间新增/搬进来的对象，**不在**这份报告里；
//   · 工作区没有 fs watcher：下一次扫描只在工作区重新打开或手动触发时发生。
import { ITEM, REPORT_VERSION, STATUS } from '../model/acl.js';
import { deficitsOf, rootDeficits, templateOf } from './deficit.js';

/** 列到上限被截断时写进 `partialReasons` 的原因词。 */
export const TRUNCATED_REASON = 'list-truncated';

/**
 * @param {object} input
 * @param {string} input.root 工作区根（绝对路径）
 * @param {object} input.rootSignature 根的签名（model/acl.js 的形状）
 * @param {Array<object>} input.objects 子对象的读取结果（不含根）
 * @param {Array<{path:string, reason:string}>} [input.listErrors] 列目录失败的子树
 * @param {Array<{path:string, reason:string}>} [input.skipped] 执行侧已跳过的对象（reparse 等）
 * @param {boolean} [input.truncated] 列到上限被截断
 * @param {{scannedAt:number, generatedAt:number, listLimit:number}} input.meta
 * @param {string} [input.command] 生成好的修复命令（没有缺项时为空）
 * @returns {object} 报告（可直接 JSON.stringify）
 */
export function buildReport(input) {
  const root = String(input.root || '');
  const rootSig = input.rootSignature || {};
  const missingOnRoot = rootDeficits(rootSig);
  const template = templateOf(rootSig);
  const listErrors = Array.isArray(input.listErrors) ? input.listErrors : [];
  const preSkipped = Array.isArray(input.skipped) ? input.skipped : [];
  const meta = input.meta || {};

  const counts = {
    checked: 0,
    missing: 0,
    skipped: 0,
    failed: 0,
  };
  const missingItems = { [ITEM.CAP]: 0, [ITEM.DENY_DC]: 0, [ITEM.LABEL]: 0 };
  const skipped = [];
  const objects = [];

  for (const raw of Array.isArray(input.objects) ? input.objects : []) {
    counts.checked += 1;
    const d = deficitsOf(raw, template);
    if (d.skip) {
      counts.skipped += 1;
      skipped.push({ path: d.path, reason: d.skip });
      continue;
    }
    if (d.missing.length === 0) continue;
    counts.missing += 1;
    for (const item of d.missing) missingItems[item] = (missingItems[item] || 0) + 1;
    objects.push({ path: d.path, isDir: !!(raw && raw.isDir), missing: d.missing });
  }
  // 执行侧已经跳过的（reparse point 等）：只算进 skipped 计数，写进 skipped 列表。
  for (const item of preSkipped) {
    if (!item || typeof item.path !== 'string') continue;
    counts.skipped += 1;
    skipped.push({ path: item.path, reason: String(item.reason || 'skipped') });
  }
  counts.failed = listErrors.length;

  const partialReasons = [];
  if (counts.failed > 0) partialReasons.push('list-failed');
  if (input.truncated === true) partialReasons.push(TRUNCATED_REASON);

  return {
    version: REPORT_VERSION,
    plugin: 'dsh-veneer',
    status: statusOf({ missingOnRoot, partialReasons, counts }),
    root,
    rootSignature: {
      cap: rootSig.cap === true,
      denyDC: rootSig.denyDC === true,
      label: rootSig.label === 'low' ? 'low' : (rootSig.label === 'medium' ? 'medium' : null),
    },
    rootMissing: missingOnRoot,
    template,
    counts,
    partialReasons,
    missingItems,
    objects, // 只放缺项的对象：报告是给用户看的，不是全量 ACL 快照
    skipped,
    listErrors,
    command: typeof input.command === 'string' ? input.command : '',
    boundary: '只保证扫描那一刻的这棵树；工作区没有 fs watcher，下一次扫描在工作区重新打开或手动触发时发生。',
    scannedAt: typeof meta.scannedAt === 'number' ? meta.scannedAt : null,
    generatedAt: typeof meta.generatedAt === 'number' ? meta.generatedAt : null,
    listLimit: typeof meta.listLimit === 'number' ? meta.listLimit : null,
  };
}

/** 整体状态：根不全 → root-absent；扫不全 → partial；缺项 → incomplete；否则 ok。 */
function statusOf({ missingOnRoot, partialReasons, counts }) {
  if (missingOnRoot.length > 0) return STATUS.ROOT_ABSENT;
  if (partialReasons.length > 0) return STATUS.PARTIAL;
  if (counts.missing > 0) return STATUS.INCOMPLETE;
  return STATUS.OK;
}

/** 报告的一行摘要（日志用）。 */
export function summarize(report) {
  const r = report || {};
  const c = r.counts || {};
  const s = r.status || STATUS.UNKNOWN;
  if (s === STATUS.ROOT_ABSENT) {
    return '根上没有物化三项（缺：' + (r.rootMissing || []).join(', ') + '）——属于宿主，本插件不动手';
  }
  if (s === STATUS.UNSUPPORTED) return '非 Windows 平台：不适用';
  return s + '：checked ' + (c.checked || 0) + ' / missing ' + (c.missing || 0)
    + ' / skipped ' + (c.skipped || 0) + ' / failed ' + (c.failed || 0);
}

/** 报告里是否"需要用户去跑一条命令"。 */
export function needsUserAction(report) {
  const s = report && report.status;
  return s === STATUS.INCOMPLETE || s === STATUS.PARTIAL;
}
