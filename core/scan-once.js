// dsh-veneer —— 一次扫描（挂载与手动入口共用）
//
// 只做两件事：**解析工作区根** + 调 `runScan`（采集 → 落盘 → 一句话结论）。
// 根从哪来：配置里写死的优先；否则问平台（只有一个就用它，多个按平台顺序第一个）。
import { CODES } from '../exception/codes.js';
import { fail } from '../exception/result.js';
import { createAclReader } from '../adapter/acl.js';
import { scriptPathOf, INSPECT_SCRIPT } from './command-path.js';
import { runScan } from './scan.js';

/** Windows 上 powershell.exe 的路径由适配层给默认值；这里只把超时传下去。 */

/**
 * 解析工作区根。
 * @param {object} host adapter/dsh.js 造的能力对象
 * @param {string} [configured] 配置里的 workspaceRoot
 * @returns {{ok:true, value:string}|{ok:false, reason:string, blockedBy:string}}
 */
export function resolveRoot(host, configured) {
  const fixed = typeof configured === 'string' ? configured.trim() : '';
  if (fixed) return { ok: true, value: fixed };
  const listed = host && host.workspace ? host.workspace.listPaths() : null;
  if (listed && listed.ok && Array.isArray(listed.value) && listed.value.length) {
    return { ok: true, value: listed.value[0] };
  }
  return {
    ok: false,
    reason: '没有工作区根：配置没给 workspaceRoot，平台工作区表也拿不到',
    blockedBy: 'host',
  };
}

/**
 * 扫一次并落盘。
 * @param {{host:object, fs:object, packageDir?:string, execFileImpl?:Function, timeoutMs?:number, listLimit?:number}} deps
 * @param {object} cfg 已归并配置（`workspaceRoot` / `reportPath`）
 * @param {string} [rootOverride] 指定根（测试用）
 * @returns {Promise<{ok:true,value:object}|{ok:false, reason:string, blockedBy:string|null, code?:string}>}
 */
export async function scanOnce(deps, cfg, rootOverride) {
  const host = deps.host;
  const root = rootOverride || cfg.workspaceRoot;
  const resolved = resolveRoot(host, root);
  if (!resolved.ok) return fail(resolved.reason, resolved.blockedBy, CODES.CONFIG_INVALID);

  const packageDir = deps.packageDir || (host && host.packageDir) || '';
  const acl = deps.acl || createAclReader({
    scriptPath: scriptPathOf(packageDir, INSPECT_SCRIPT),
    execFileImpl: deps.execFileImpl,
    timeoutMs: deps.timeoutMs,
  });
  return runScan({
    acl,
    fs: deps.fs,
    commandPath: scriptPathOf(packageDir),
    listLimit: deps.listLimit,
  }, { root: resolved.value, reportPath: cfg.reportPath });
}
