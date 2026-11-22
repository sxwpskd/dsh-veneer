// dsh-veneer —— 日志门面（一处收口：内存环 / 宿主 logger / 文件 sink）
//
// 2026-11-22：旧的"系统临时目录 sink"（`<tmp>/dsh-veneer-host.log`）删掉了。原因：
//   · 它 import 了 `node:fs`，客户端半边没法用；
//   · 它绕过了脚手架规定的 `<工作区>/.dsh-veneer/veneer.log`，排查时要两处找。
// 现在分三层：
//   ① **内存环形缓冲一直在**（默认 200 条）：客户端拿不到文件系统时，界面调试行读 `logs(n)`；
//   ② **宿主 logger 有就同时转过去**：旧行为不变（旧调用点只调 `log.info/warn/error`）；
//   ③ **文件 sink 由装配层后挂**：`attachFileSink(sink)` 时把内存里已有事件按序补写一次，
//      之后的新事件实时写——不重复写。
//
// 兼容：`createLog(hostLogger)` 只有旧参数时 = memory + 宿主 logger，**不写任何文件、不产生临时文件**。
// 纪律：日志自己坏了不许抛（宿主 logger 抛、console 都没有、sink 抛，都一样）。
//
// 本文件不 import `node:fs`：写文件在 `log/file-sink.js`，fs 是注入的。

import { makeEvent, newBootId } from './schema.js';
import { createMemorySink } from './memory-sink.js';

/** `info/warn/error/debug('……')` 这类只给一句话的调用，事件名统一记成它（级别由调用决定）。 */
const MESSAGE_EVENT = 'log.message';

/**
 * 造一个日志口。
 *
 * @param {object|null} hostLogger 宿主 logger（有 `info/warn/error/debug` 就用；缺失/抛错退控制台）
 * @param {object} [options]
 * @param {number} [options.memoryLimit=200] 内存环形缓冲上限
 * @param {string} [options.bootId] 启动标识（不传自动生成一个 8 位）
 * @returns {{
 *   debug:(message:string, fields?:object)=>object,
 *   info:(message:string, fields?:object)=>object,
 *   warn:(message:string, fields?:object)=>object,
 *   error:(message:string, fields?:object)=>object,
 *   event:(name:string, message:string, fields?:object)=>object,
 *   logs:(n?:number)=>object[],
 *   attachFileSink:(sink:object)=>boolean,
 *   sinkStatus:()=>{attached:boolean, disabled:boolean, reason:string},
 *   flush:()=>void,
 * }}
 */
export function createLog(hostLogger, options = {}) {
  const memoryLimit = (() => {
    try { return options && Number.isFinite(options.memoryLimit) ? options.memoryLimit : 200; } catch { return 200; }
  })();
  const bootId = (() => {
    try {
      if (options && typeof options.bootId === 'string' && options.bootId) return options.bootId;
    } catch { /* 读不到就用新生成的 */ }
    return newBootId();
  })();

  const memory = createMemorySink(memoryLimit);
  let fileSink = null;

  /** 转给宿主 logger；缺失或抛错都退控制台；控制台也没有就放弃。 */
  function forward(level, text) {
    try {
      const host = hostLogger;
      if (host) {
        const fn = host[level];
        if (typeof fn === 'function') {
          fn.call(host, text);
          return;
        }
      }
    } catch { /* 宿主 logger 坏了：退控制台 */ }
    try {
      if (typeof console === 'undefined' || !console) return;
      let fn = null;
      if (level === 'warn') fn = console.warn;
      else if (level === 'error') fn = console.error;
      else if (level === 'debug') fn = console.debug || console.info;
      else fn = console.info;
      if (typeof fn === 'function') fn.call(console, text);
    } catch { /* 控制台也没有：放弃 */ }
  }

  /** 写进文件 sink（未挂 / 已禁用 / sink 抛错都只是少一条，不影响别处）。 */
  function writeSink(event) {
    try {
      if (!fileSink || typeof fileSink.write !== 'function') return;
      fileSink.write(event);
    } catch { /* sink 自己的异常不该掀翻日志 */ }
  }

  /** 一条事件的完整路径：内存 → 宿主 → 文件 sink。 */
  function emit(event, hostText) {
    try { memory.write(event); } catch { /* 内存环承诺不抛；这里再兜一层 */ }
    forward(event.level, hostText);
    writeSink(event);
  }

  /** 纯文本调用（debug/info/warn/error）。 */
  function plain(level, message, fields) {
    let event;
    try {
      event = makeEvent(MESSAGE_EVENT, message, fields, { level, bootId });
    } catch {
      event = { ts: '', level, event: MESSAGE_EVENT, message: String(message == null ? '' : message), fields: {} };
    }
    emit(event, '[veneer] ' + event.message);
    return event;
  }

  /** 具名事件（级别与必带字段看 `log/schema.js` 的 `EVENTS`）。 */
  function named(name, message, fields) {
    let event;
    try {
      event = makeEvent(name, message, fields, { bootId });
    } catch {
      event = { ts: '', level: 'info', event: String(name), message: String(message == null ? '' : message), fields: {} };
    }
    emit(event, '[veneer] ' + event.event + ': ' + event.message);
    return event;
  }

  /** 取最近 n 条**对象**（旧 → 新；面板调试行用）。 */
  function logs(n = 20) {
    try { return memory.tail(n); } catch { return []; }
  }

  /** 挂文件 sink：把内存里已有的事件**按序补写一次**；之后新事件实时写。 */
  function attachFileSink(sink) {
    try {
      if (!sink || typeof sink.write !== 'function') return false;
      if (sink === fileSink) return true; // 同一个 sink 重复挂：不重复补写
      fileSink = sink;
      const history = memory.tail(memory.size());
      for (const event of history) {
        try { sink.write(event); } catch { /* 补写失败不影响之后的事件 */ }
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 文件 sink 的状态：没挂时 attached=false；挂了再看 disabled/reason。 */
  function sinkStatus() {
    try {
      const attached = !!fileSink;
      let disabled = false;
      let reason = '';
      if (attached) {
        disabled = !!fileSink.disabled;
        if (fileSink.reason) reason = String(fileSink.reason);
      }
      return { attached, disabled, reason };
    } catch {
      return { attached: false, disabled: false, reason: '' };
    }
  }

  /** 让文件 sink 收尾（目前同步写，主要用于统一接口；失败也不抛）。 */
  function flush() {
    try {
      if (fileSink && typeof fileSink.flush === 'function') fileSink.flush();
    } catch { /* 收尾失败不反噬业务 */ }
  }

  return {
    debug: (message, fields) => plain('debug', message, fields),
    info: (message, fields) => plain('info', message, fields),
    warn: (message, fields) => plain('warn', message, fields),
    error: (message, fields) => plain('error', message, fields),
    event: named,
    logs,
    attachFileSink,
    sinkStatus,
    flush,
  };
}
