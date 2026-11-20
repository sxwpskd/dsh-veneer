// dsh-veneer —— 采集（核心层编排：根先看，再决定要不要往子树走）
//
// 顺序（每一步失败都只报告，不猜）：
//   ① 读根的签名；
//   ② 根缺三项 → 直接 `root-absent`，**不扫子树**（宿主的活，不是我们的）；
//   ③ 根齐了 → 列子树 → 逐个读签名 → 判缺 → 生成命令 → 装配报告。
//
// 为什么根不齐就停：根都没有物化，说明宿主那一步没跑或跑失败；这时候去补子树，等于**替宿主**做半套，
//   而且补出来的 ACE 没有根做源头。REQ 第 1 条就是这个意思（"根没有三项就 defer / 报告"）。
import { CODES } from '../exception/codes.js';
import { fail, ok, isFail } from '../exception/result.js';
import { buildReport } from './report.js';
import { buildCommand } from './command.js';

/**
 * @param {object} deps
 * @param {{inspect:(opts:object)=>Promise<object>, expand:(opts:object)=>Promise<object>}} deps.acl 适配层能力
 * @param {string} deps.commandPath 执行侧脚本的绝对路径（进命令）
 * @param {number} [deps.listLimit] 一次最多列多少个对象（防超大工作区把时间吃光）
 * @param {() => number} [deps.now] 时钟（测试注入）
 *
 * @param {{root:string}} options
 * @returns {Promise<{ok:true, value:object}|{ok:false, reason:string, blockedBy:string|null, code?:string}>}
 */
export async function collect(deps, options) {
  const root = options && typeof options.root === 'string' ? options.root : '';
  if (!root) return fail('没有工作区根，跳过扫描', 'host', CODES.CONFIG_INVALID);

  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const listLimit = typeof deps.listLimit === 'number' ? deps.listLimit : null;
  const scannedAt = now();

  // ① 根
  const rootRead = await deps.acl.inspect({ targets: [root] });
  if (isFail(rootRead)) return rootRead;
  const rootRaw = firstOf(rootRead.value);
  if (!rootRaw || !rootRaw.signature) {
    return fail('读根的安全描述符没有返回可用的签名：' + root, 'acl', CODES.ACL_OUTPUT_INVALID);
  }

  // ② 根缺三项 → 宿主的活；不扫子树、不生成命令
  const rootOnly = buildReport({
    root,
    rootSignature: rootRaw.signature,
    objects: [],
    listErrors: [],
    meta: { scannedAt, generatedAt: now(), listLimit },
  });
  if (rootOnly.status === 'root-absent') return ok(rootOnly);

  // ③ 子树
  const expanded = await deps.acl.expand({ root, limit: listLimit });
  if (isFail(expanded)) return expanded;
  const value = expanded.value || {};
  const objects = Array.isArray(value.objects) ? value.objects : [];
  const listErrors = Array.isArray(value.listErrors) ? value.listErrors : [];
  const skipped = Array.isArray(value.skipped) ? value.skipped : [];

  const report = buildReport({
    root,
    rootSignature: rootRaw.signature,
    objects,
    listErrors,
    skipped,
    truncated: value.truncated === true,
    meta: { scannedAt, generatedAt: now(), listLimit },
  });

  // 命令只按**真的缺的项**生成；没有缺项就不给命令（免得用户白跑一次）。
  if (report.counts.missing > 0) {
    report.command = buildCommand({ script: deps.commandPath, root, missing: report.missingItems });
  }
  return ok(report);
}

/** 读回来的第一条（`inspect` 只传了根，所以就是根）。 */
function firstOf(value) {
  const items = Array.isArray(value) ? value : (value && Array.isArray(value.objects) ? value.objects : []);
  return items.length ? items[0] : null;
}
