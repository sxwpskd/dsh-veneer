// dsh-veneer —— 修复任务（核心层：校验 → 写任务/提权脚本 → UAC 提权执行 → 读结果）
//
// 这是**插件唯一会发起写 ACL 的入口**，但它自己不改 ACL：真正的写发生在提权进程里
// （`scripts/dsh-veneer-apply.ps1 -TaskFile … -Apply`），用户会在 UAC 上确认。
//
// 数据流（CHANGE-STATE-MACHINE §5）：
//   ① 校验：对象必须在 root 下、且**当前报告里确实缺**这些项——非法则**一个进程都不起**；
//   ② 写 `.dsh-veneer/fix-request.json`（任务：version/id/workspace/objects/at）；
//   ③ 写 `.dsh-veneer/fix-run.ps1`（一行 `& <apply> -Root … -TaskFile … -ResultFile … -Apply`）；
//   ④ 起 `powershell.exe … Start-Process -Verb RunAs -Wait …`（UAC 由用户确认，**不重试**）；
//   ⑤ 读提权进程写的 `.dsh-veneer/fix-result.json` → `{ok, fixed, failed, reason?}`。
//
// 纪律：
//   · **失败一律 `{ok:false, reason}`**，不抛、不吞；
//   · 本层**不 import `node:*`**：路径校验用 `adapter/desktop.js` 的 `resolveInsideRoot`，
//     进程用 `adapter/dsh.js` 的 `runProcess`，脚本路径用 `core/command-path.js`。
//   · 提权进程**不信任客户端**：任务里的对象在 apply 脚本里还会再校验一次是否在 root 下。
import { resolveInsideRoot } from '../adapter/desktop.js';
import { runProcess } from '../adapter/dsh.js';
import { scriptPathOf, APPLY_SCRIPT } from './command-path.js';
import { joinPath } from './persist.js';
import { fail } from '../exception/result.js';
import { CODES } from '../exception/codes.js';
import { FIX_ITEMS } from './fix-bus.js';

/** `.dsh-veneer/` 下的文件（相对工作区根；宿主与执行侧脚本共用这套名字）。 */
export const FIX_REQUEST_FILE = '.dsh-veneer/fix-request.json';
export const FIX_RESULT_FILE = '.dsh-veneer/fix-result.json';
export const FIX_RUN_FILE = '.dsh-veneer/fix-run.ps1';

/** 提权进程超时（毫秒）；UAC 上没人点也算"没完成"，超时后按失败报。 */
export const FIX_TIMEOUT_MS = 180000;

/** 斜杠归一（比较路径用，不改变实际使用的值）。 */
function slashPath(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 比较用的键：斜杠归一 + 小写。 */
export function pathKey(value) {
  return slashPath(value).toLowerCase();
}

/** 这个值看起来是不是绝对路径（不 import node:path 的判据）。 */
function looksAbsolute(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
}

/** 显式给的路径（绝对路径原样用；相对路径按工作区根拼）或默认的相对路径。 */
function filePathOf(explicit, root, fallback) {
  const value = typeof explicit === 'string' ? explicit.trim() : '';
  if (!value) return joinPath(root, fallback);
  if (looksAbsolute(value)) return value;
  return joinPath(root, value);
}

/** PowerShell 单引号字符串：内部单引号双写。 */
export function psSingleQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}

/** 生成一个修复 id（调用方给 id 时以调用方为准）。 */
export function newFixId(prefix = 'vfix') {
  const stamp = Date.now().toString(36);
  const salt = Math.random().toString(36).slice(2, 8);
  return prefix + '-' + stamp + '-' + salt;
}

/**
 * 对象是否在本工作区根下（且不是根本身）。
 * 用 `adapter/desktop.js` 的 `resolveInsideRoot` 做最后一道归一，越界返回 null。
 * @returns {string|null} 归一后的绝对路径
 */
export function insideRootOf(root, target) {
  const base = slashPath(root);
  const full = slashPath(target);
  if (!base || !full) return null;
  if (full.toLowerCase() === base.toLowerCase()) return null; // 根本身属于宿主，不归本插件修
  if (!full.toLowerCase().startsWith(base.toLowerCase() + '/')) return null;
  const relative = full.slice(base.length + 1);
  if (!relative) return null;
  return resolveInsideRoot(root, relative);
}

/**
 * 报告里"真的缺项"的对象索引：`pathKey → {path, items}`。
 * 只认报告 `objects[]`（那本来就只列缺项对象）与三项白名单。
 */
export function reportMissingIndex(report) {
  const index = new Map();
  const objects = report && Array.isArray(report.objects) ? report.objects : [];
  for (const entry of objects) {
    if (!entry || typeof entry !== 'object') continue;
    const path = typeof entry.path === 'string' ? entry.path : '';
    if (!path) continue;
    const items = [];
    for (const name of Array.isArray(entry.missing) ? entry.missing : []) {
      if (FIX_ITEMS.includes(name) && !items.includes(name)) items.push(name);
    }
    if (items.length) index.set(pathKey(path), { path, items });
  }
  return index;
}

/** 当前报告里**全部**缺项对象（弹窗"去修复"默认修全部）。 */
export function missingObjectsOf(report) {
  return [...reportMissingIndex(report).values()].map((entry) => ({ path: entry.path, items: entry.items.slice() }));
}

/** 修复路径一览（宿主写、执行侧脚本读写；面板轮询结果）。 */
export function fixPathsOf(root) {
  return {
    taskPath: joinPath(root, FIX_REQUEST_FILE),
    resultPath: joinPath(root, FIX_RESULT_FILE),
    runPath: joinPath(root, FIX_RUN_FILE),
  };
}

/**
 * 把**宿主侧**的修复结论写进 `.dsh-veneer/fix-result.json`（供客户端轮询）。
 *
 * 结果文件契约（2026-11-23 集成方定；客户端面板按它解析）：
 *   `{version:1, id, ok, total, success, failed, failures:[{path, items, reason}], cancelled, reason}`
 *   · `id` 必须回带请求 id（面板按 id 匹配，不匹配会一直等到超时）；
 *   · `ok` = `success === total` 且未取消；
 *   · `total/success/failed` 是数字，`failures[]` 每项带 `path` / `items` / `reason`。
 *
 * 正常路径上这个文件由**提权进程**（apply 脚本）写；宿主只负责兜底：
 * UAC 取消 / 进程没起来 / 结果文件缺失时，这里补一条 `cancelled/failed` 的结论。
 *
 * @param {object} fs 文件系统能力
 * @param {string} root 工作区根
 * @param {object} result `{id, total, success, failed, failures, cancelled, reason, at}`
 * @param {string} [resultPath] 覆盖默认落点（测试 / 调用方另有约定时用）
 * @returns {{ok:true, value:string}|{ok:false, reason:string, blockedBy:string, code?:string}}
 */
export function writeFixResult(fs, root, result = {}, resultPath = '') {
  const paths = fixPathsOf(root);
  const target = typeof resultPath === 'string' && resultPath ? resultPath : paths.resultPath;
  const total = Number.isFinite(result.total) ? result.total : 0;
  const success = Number.isFinite(result.success) ? result.success : 0;
  const failed = Number.isFinite(result.failed) ? result.failed : 0;
  const cancelled = result.cancelled === true;
  const failures = [];
  for (const entry of Array.isArray(result.failures) ? result.failures : []) {
    if (!entry || typeof entry !== 'object') continue;
    const items = [];
    for (const name of Array.isArray(entry.items) ? entry.items : []) {
      if (FIX_ITEMS.includes(name)) items.push(name);
    }
    failures.push({
      path: String((entry.path) || ''),
      items,
      reason: String((entry.reason) || '未知原因'),
    });
  }
  const doc = {
    version: 1,
    id: typeof result.id === 'string' ? result.id : '',
    ok: cancelled !== true && success === total && failed === 0,
    total,
    success,
    failed,
    failures,
    cancelled,
    reason: typeof result.reason === 'string' ? result.reason : '',
    at: Number.isFinite(result.at) ? result.at : Date.now(),
  };
  try {
    fs.writeTextAtomic(target, JSON.stringify(doc, null, 2) + '\n');
  } catch (err) {
    return fail('写修复结果失败：' + String((err && err.message) || err), 'fs', CODES.FS_WRITE_FAILED);
  }
  return { ok: true, value: target };
}

/**
 * 任务对象 → 校验过的对象表（按归一路径合并重复项）。
 * @returns {{ok:true, value:Array<{path:string, items:string[]}>}|{ok:false, reason:string, blockedBy:string|null, code?:string}}
 */
function normalizeWantedObjects(root, objects) {
  if (!Array.isArray(objects) || objects.length === 0) {
    return fail('修复请求没有对象', 'config', CODES.CONFIG_INVALID);
  }
  const wanted = new Map();
  for (const entry of objects) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail('修复对象必须是 {path, items}', 'config', CODES.CONFIG_INVALID);
    }
    const rawPath = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!rawPath) return fail('修复对象的 path 必须是非空字符串', 'config', CODES.CONFIG_INVALID);
    const target = insideRootOf(root, rawPath);
    if (!target) {
      return fail('拒绝：修复对象不在工作区根下（或等于根本身）：' + rawPath, 'config', CODES.CONFIG_INVALID);
    }
    const items = [];
    for (const name of Array.isArray(entry.items) ? entry.items : []) {
      if (!FIX_ITEMS.includes(name)) {
        return fail('修复对象含未知项：' + String(name), 'config', CODES.CONFIG_INVALID);
      }
      if (!items.includes(name)) items.push(name);
    }
    if (!items.length) {
      return fail('修复对象没有要修的项：' + target, 'config', CODES.CONFIG_INVALID);
    }
    const key = pathKey(target);
    const existing = wanted.get(key);
    if (existing) {
      for (const name of items) if (!existing.items.includes(name)) existing.items.push(name);
    } else {
      wanted.set(key, { path: target, items: items.slice() });
    }
  }
  return { ok: true, value: [...wanted.values()] };
}

/** 报告从哪来：内存里的报告优先，其次读 `reportPath`；都没有 → 不修（无法确认缺项）。 */
function currentReportOf(options) {
  const fs = options.fs;
  if (options.report && typeof options.report === 'object') {
    return { ok: true, value: options.report };
  }
  const reportPath = typeof options.reportPath === 'string' ? options.reportPath.trim() : '';
  if (!reportPath) return { ok: false, reason: '没有当前报告（report / reportPath 都没给），无法确认缺项' };
  try {
    if (typeof fs.exists === 'function' && !fs.exists(reportPath)) {
      return { ok: false, reason: '当前报告不存在（先扫描一次再修）：' + reportPath };
    }
    const parsed = JSON.parse(fs.readText(reportPath));
    return { ok: true, value: parsed };
  } catch (err) {
    return { ok: false, reason: '读当前报告失败：' + String((err && err.message) || err) };
  }
}

/**
 * 提权结果文件 → 统一结果；形状不对返回 null。
 *
 * 契约见 `writeFixResult`：`{version, id, ok, total, success, failed, failures, cancelled, reason}`。
 * 返回给调用方的形状同时带 `success`（新契约）与 `fixed`（旧别名，R-11 面板/日志沿用）。
 */
function normalizeFixResult(raw, resultPath, requestId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const failures = [];
  for (const entry of Array.isArray(raw.failures) ? raw.failures : []) {
    if (!entry || typeof entry !== 'object') continue;
    const items = [];
    for (const name of Array.isArray(entry.items) ? entry.items : []) {
      if (FIX_ITEMS.includes(name)) items.push(name);
    }
    failures.push({
      path: typeof entry.path === 'string' ? entry.path : '',
      items,
      reason: String((entry.reason) || '未知原因'),
    });
  }
  const total = Number.isFinite(raw.total) ? raw.total : 0;
  const success = Number.isFinite(raw.success) ? raw.success : 0;
  const failed = Number.isFinite(raw.failed) ? raw.failed : failures.length;
  const cancelled = raw.cancelled === true;
  const ok = cancelled !== true && raw.ok === true && success === total && failed === 0;
  const out = {
    ok,
    id: typeof raw.id === 'string' && raw.id ? raw.id : requestId,
    total,
    success,
    fixed: success, // 旧字段别名（调用方/日志用）
    failed,
    failures,
    cancelled,
    resultPath,
  };
  if (!ok) out.reason = typeof raw.reason === 'string' && raw.reason
    ? raw.reason
    : (cancelled ? '用户取消提权' : '修复未全部成功');
  return out;
}

/**
 * 执行一次修复（对外入口，**永不 reject**）。
 *
 * @param {object} options
 *   · `fs`           文件系统能力（`adapter/fs.js`）
 *   · `root`         工作区根（绝对路径）
 *   · `objects`      `[{path, items}]`：只修列出的对象与项
 *   · `id`           修复请求 id（同一 id 由调用方去重）
 *   · `report`       当前报告对象（优先）；或 `reportPath` 读盘
 *   · `packageDir`   包根（算 apply 脚本路径）；或直接给 `applyScriptPath`
 *   · `taskPath` / `resultPath` / `runPath`  覆盖默认落点（测试用）
 *   · `execImpl` / `execFileImpl`  进程注入点（测试用）
 *   · `timeoutMs` / `now`
 * @returns {Promise<{ok:boolean, id?:string, total?:number, success?:number, fixed?:number, failed?:number,
 *   failures?:Array<{path:string, items:string[], reason:string}>, cancelled?:boolean, reason?:string,
 *   code?:string, resultPath?:string}>}
 *   结果文件契约见 `writeFixResult`；`fixed` 是 `success` 的旧别名。
 */
export async function runFix(options = {}) {
  const fs = options.fs;
  const root = typeof options.root === 'string' ? options.root.trim() : '';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const id = typeof options.id === 'string' ? options.id.trim() : '';
  if (!fs || typeof fs.writeTextAtomic !== 'function' || typeof fs.readText !== 'function') {
    return fail('没有文件系统能力（fs），修复任务写不了', 'fs', CODES.FS_UNAVAILABLE);
  }
  if (!root) return fail('没有工作区根，不能修复', 'host', CODES.CONFIG_INVALID);
  if (!id) return fail('修复请求缺 id（同一请求必须可去重）', 'config', CODES.CONFIG_INVALID);

  // ① 校验对象：必须在 root 下
  const wantedResult = normalizeWantedObjects(root, options.objects);
  if (wantedResult.ok !== true) return wantedResult;

  // ① 校验对象：当前报告里确实缺这些项（**不信任调用方**，一个都不能凭空修）
  const reportResult = currentReportOf(options);
  if (reportResult.ok !== true) return fail(reportResult.reason, 'config', CODES.CONFIG_INVALID);
  const known = reportMissingIndex(reportResult.value);
  for (const entry of wantedResult.value) {
    const hit = known.get(pathKey(entry.path));
    if (!hit) {
      return fail('拒绝：当前报告里没有这个缺项对象：' + entry.path, 'config', CODES.CONFIG_INVALID);
    }
    for (const name of entry.items) {
      if (!hit.items.includes(name)) {
        return fail('拒绝：当前报告里 ' + entry.path + ' 不缺 ' + name, 'config', CODES.CONFIG_INVALID);
      }
    }
  }

  const applyScriptPath = typeof options.applyScriptPath === 'string' && options.applyScriptPath
    ? options.applyScriptPath
    : scriptPathOf(options.packageDir || '', APPLY_SCRIPT);
  if (!applyScriptPath) {
    return fail('找不到修复脚本（包目录解析失败）', 'config', CODES.CONFIG_INVALID);
  }
  const taskPath = filePathOf(options.taskPath, root, FIX_REQUEST_FILE);
  const resultPath = filePathOf(options.resultPath, root, FIX_RESULT_FILE);
  const runPath = filePathOf(options.runPath, root, FIX_RUN_FILE);

  // ② 写任务（提权进程读它；**只列要修的对象与项**）
  const request = {
    version: 1,
    id,
    workspace: root,
    objects: wantedResult.value.map((entry) => ({ path: entry.path, items: entry.items.slice() })),
    at: now(),
  };
  try {
    fs.writeTextAtomic(taskPath, JSON.stringify(request, null, 2) + '\n');
  } catch (err) {
    return fail('写修复任务失败：' + String((err && err.message) || err), 'fs', CODES.FS_WRITE_FAILED);
  }

  // ③ 写提权要跑的脚本：一行调用 apply 脚本（路径按 PowerShell 规则单引号转义）
  const runLine = '& ' + psSingleQuote(applyScriptPath)
    + ' -Root ' + psSingleQuote(root)
    + ' -TaskFile ' + psSingleQuote(taskPath)
    + ' -ResultFile ' + psSingleQuote(resultPath)
    + ' -Apply';
  try {
    // UTF-8 **带 BOM**：Windows PowerShell 5.1 对无 BOM 的 .ps1 按 ANSI 解码，
    // 中文路径会碎（与 inspect/apply 脚本头的 ASCII 纪律是同一类问题，这里用 BOM 解决）。
    fs.writeTextAtomic(runPath, '\uFEFF' + runLine + '\r\n');
  } catch (err) {
    return fail('写提权脚本失败：' + String((err && err.message) || err), 'fs', CODES.FS_WRITE_FAILED);
  }

  // ④ 发起提权（用户会在 UAC 上确认；被取消 → 不重试）
  const total = wantedResult.value.length;
  const writeFallback = (fields) => {
    // 兜底：提权没跑成也要给面板一条**带 id** 的结论（否则客户端会一直等到超时）。
    try {
      writeFixResult(fs, root, { id, total, success: 0, failed: 0, failures: [], cancelled: false, ...fields }, resultPath);
    } catch { /* 兜底写不进去也不能盖住真正的失败原因 */ }
  };
  const innerArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runPath];
  const command = 'Start-Process -Verb RunAs -Wait -WindowStyle Hidden -FilePath powershell.exe -ArgumentList '
    + innerArgs.map(psSingleQuote).join(',');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
  const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : FIX_TIMEOUT_MS;
  const run = typeof options.execImpl === 'function'
    ? options.execImpl
    : (cmd, argv, opts) => runProcess(cmd, argv, opts, options.execFileImpl);
  let launched;
  try {
    launched = await run('powershell.exe', args, { timeout, windowsHide: true });
  } catch (err) {
    const reason = '起不来提权进程：' + String((err && err.message) || err);
    writeFallback({ failed: total, cancelled: true, reason: '用户取消提权（' + reason + '）' });
    return { ok: false, reason, code: 'uac-cancelled', id, total, success: 0, failed: total, failures: [], cancelled: true };
  }
  if (launched && launched.timedOut) {
    writeFallback({ failed: total, cancelled: true, reason: '用户取消提权（提权进程超时 ' + timeout + ' ms）' });
    return {
      ok: false, reason: '提权进程超时（' + timeout + ' ms）', code: 'fix-timeout',
      id, total, success: 0, failed: total, failures: [], cancelled: true,
    };
  }
  if (!launched || launched.ok !== true) {
    // 用户在 UAC 上点"否"时 PowerShell 报错、退出码非 0；不重试、不静默。
    writeFallback({ failed: total, cancelled: true, reason: '用户取消提权' });
    return {
      ok: false, reason: '用户取消或提权失败', code: 'uac-cancelled',
      id, total, success: 0, failed: total, failures: [], cancelled: true,
    };
  }

  // ⑤ 读提权进程写的结果（apply 脚本在 -ResultFile 里回带 id）
  if (typeof fs.exists === 'function' && !fs.exists(resultPath)) {
    writeFallback({ failed: total, cancelled: false, reason: '提权进程没有留下结果文件' });
    return {
      ok: false, reason: '提权进程结束了，但没有留下结果文件', code: 'fix-result-missing',
      id, total, success: 0, failed: total, failures: [], cancelled: false,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readText(resultPath));
  } catch (err) {
    writeFallback({ failed: total, cancelled: false, reason: '结果文件不是合法 JSON' });
    return {
      ok: false, reason: '修复结果不是合法 JSON：' + String((err && err.message) || err), code: 'fix-result-invalid',
      id, total, success: 0, failed: total, failures: [], cancelled: false,
    };
  }
  const normalized = normalizeFixResult(parsed, resultPath, id);
  if (!normalized) {
    writeFallback({ failed: total, cancelled: false, reason: '结果文件的形状不认识' });
    return {
      ok: false, reason: '修复结果的形状不认识（要 version:1 的 {ok,total,success,failed,failures,cancelled,reason}）',
      code: 'fix-result-invalid', id, total, success: 0, failed: total, failures: [], cancelled: false,
    };
  }
  return normalized;
}
