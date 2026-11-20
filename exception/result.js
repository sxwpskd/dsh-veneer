// dsh-veneer —— 统一结果形状（纯模块：只定"成功/失败"长什么样）
//
//   ok(value)                  → { ok:true, value }
//   fail(reason, blockedBy)    → { ok:false, reason, blockedBy, code? }
//
// `blockedBy` 的主语是**工具或环境**（'host' / 'sandbox' / 'fs' / 'platform'），不落在"我没做"上。

/** 成功结果。 */
export function ok(value) {
  return { ok: true, value };
}

/**
 * 失败结果。
 * @param {string} reason 发生了什么（主语落在工具或环境上）
 * @param {string|null} [blockedBy] 被谁挡住
 * @param {string|null} [code] 稳定错误码（exception/codes.js）
 */
export function fail(reason, blockedBy = null, code = null) {
  const r = {
    ok: false,
    reason: String(reason || '未知原因'),
    blockedBy: blockedBy ? String(blockedBy) : null,
  };
  if (code) r.code = String(code);
  return r;
}

/** 是不是失败结果（与 `{ok:true}` 区分开，调用方不用自己比对）。 */
export function isFail(r) {
  return !!r && r.ok === false;
}

/**
 * 把失败报进日志口；日志自己坏了也不能反过来抛。
 * @param {{ok:boolean, reason?:string, blockedBy?:string}} result
 * @param {{info?:Function, warn?:Function}|null} log
 */
export function report(result, log) {
  if (!result || result.ok !== false) return result;
  const text = '[veneer] ' + (result.reason || '未知原因')
    + (result.blockedBy ? '（挡住它的是：' + result.blockedBy + '）' : '');
  try {
    if (log && typeof log.warn === 'function') log.warn(text);
    else if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(text);
  } catch { /* 日志口坏了不影响结果 */ }
  return result;
}
