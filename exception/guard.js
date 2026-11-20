// dsh-veneer —— 异常边界（包住一次同步/异步调用，绝不把异常抛给宿主）
//
// 与 dsh-milieu 的 guard 同一个契约，但只保留这里用得上的部分：
//   · success → 原值；
//   · throw   → 统一失败结果（不带栈，只带 reason/blockedBy/code），**不 rethrow**；
//   · **不装 process 级处理器**：插件不能替宿主决定进程策略。
import { fail } from './result.js';

/** 把任意 thrown 值折成人话（不要 `String(undefined)`）。 */
export function reasonOf(err) {
  if (!err) return '未知原因';
  if (typeof err === 'string') return err;
  const msg = err.message || err.reason;
  return msg ? String(msg) : String(err);
}

/**
 * @template T
 * @param {string} label 这次边界叫什么（进 reason，便于定位）
 * @param {() => T} fn
 * @param {{log?:object|null, blockedBy?:string, code?:string}} [opts]
 * @returns {T | {ok:false, reason:string, blockedBy:string|null, code?:string}}
 */
export function guardSync(label, fn, opts = {}) {
  try {
    return fn();
  } catch (err) {
    const r = fail((label ? label + '：' : '') + reasonOf(err), opts.blockedBy || null, opts.code || null);
    try {
      if (opts.log && typeof opts.log.warn === 'function') opts.log.warn('[veneer] ' + r.reason);
    } catch { /* 日志口坏了不影响结果 */ }
    return r;
  }
}

/**
 * 异步边界：同步 throw 与 Promise 拒绝都接住；**返回的 Promise 永远 resolve**
 * （失败时 resolve 成统一失败结果），不会把拒绝抛给宿主。
 * @template T
 * @param {string} label
 * @param {() => T | Promise<T>} fn
 * @param {{log?:object|null, blockedBy?:string, code?:string}} [opts]
 */
export async function guardAsync(label, fn, opts = {}) {
  try {
    return await fn();
  } catch (err) {
    const r = fail((label ? label + '：' : '') + reasonOf(err), opts.blockedBy || null, opts.code || null);
    try {
      if (opts.log && typeof opts.log.warn === 'function') opts.log.warn('[veneer] ' + r.reason);
    } catch { /* 日志口坏了不影响结果 */ }
    return r;
  }
}
