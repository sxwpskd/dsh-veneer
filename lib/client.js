// 本文件由工作区工具 tools/build-veneer-client.mjs 从 <包>/ 下列 6 个模块拼接生成：
//   model/acl.js , log/schema.js , log/memory-sink.js , log/logger.js , ui/config-page.js , client.js
// **不要手改**：改源码后重跑构建。 src=fce8036ad0eb
(function () {
"use strict";

// ===== model/acl.js =====
// dsh-veneer —— 数据形状（model 层：只放形状与纯归一，不做 IO、不做判断）
//
// 三张形状：
//   · **签名**（signature）：一个对象的物化三项长什么样——`{ cap, denyDC, denyDCInherit, label }`；
//   · **判缺**（deficit）：这个对象缺哪几项、为什么跳过；
//   · **报告**（report）：写进工作区的那份 JSON。

/** 三项的名字（报告与执行侧脚本共用同一套词，别另起一套）。 */
const ITEM = Object.freeze({
  CAP: 'cap',       // 工作区能力 ACE（读根 SD 里的 SID，照抄）
  DENY_DC: 'denyDC', // 目录上的 `Everyone` 拒绝 FILE_DELETE_CHILD
  LABEL: 'label',   // Low 完整性标签
});

/** 报告版本：形状一变就升（执行侧脚本与将来的 UI 读它）。 */
const REPORT_VERSION = 1;

/**
 * 报告在工作区里的**默认相对路径**（宿主写、面板读）。
 * 只此一处：`config/defaults.js` 与界面半边都引它，别各写一份。
 */
const REPORT_REL_PATH = 'review/veneer-state.json';

/** 三种整体状态。 */
const STATUS = Object.freeze({
  OK: 'ok',             // 根齐、子树也都齐
  INCOMPLETE: 'incomplete', // 有对象缺三项（需要用户执行修复命令）
  ROOT_ABSENT: 'root-absent', // 根上没物化三项 → 属于宿主，本插件不动手
  PARTIAL: 'partial',   // 扫不全（读不了某些子树），结论不完整
  UNSUPPORTED: 'unsupported', // 非 Windows
  UNKNOWN: 'unknown',   // 还没扫过
});

/**
 * 一项被算作"已有"的判据（三项统一口径）：
 *   · cap    —— 根 SID 有一条第 `Allow` 职责位含写（`W` 或 `WD`）的 ACE；
 *   · denyDC —— 有一条 `S-1-1-0` 的 `Deny` ACE，且是删除子项位（`DC` 或 `D`）；
 *   · label  —— 完整性标签是 `Low`。
 * **显式与继承都算**：是否带 `(I)` 只作为签名的一部分记下来，**判缺不看它**。
 * 这么定的原因：只补"真的没有"的项。把已经从根继承来的再补一遍，会在 `icacls` 里留一组重复 ACE
 * （2026-11-20 在 `D:\agent-collab-1\公共信息库\` 亲眼见到）。
 */
const SAME_ITEM_RULES = Object.freeze({
  cap: 'any Allow ACE for the root capability SID with write data (W or WD)',
  denyDC: 'any Deny ACE for Everyone (S-1-1-0) with delete-child (DC or D)',
  label: 'integrity label Low',
});

/** 跳过原因（报告里的 `reason` 就取这些词，便于按词统计）。 */
const SKIP = Object.freeze({
  REPARSE: 'reparse-point',      // reparse point（junction / symlink / mount）：官方也管不全
  NO_ACL_READ: 'acl-unreadable', // 读不到 SD（权限不足）
});

/**
 * 归一一处 ACL 读取结果。输入来自执行侧脚本（`inspect` 命令）的原样输出。
 *
 * @param {object} raw
 * @returns {{path:string, isDir:boolean, signature:object, error?:string}|null}
 */
function normalizeObject(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string') return null;
  const cap = raw.cap === true;
  const denyDC = raw.denyDC === true;
  const label = raw.label === 'low' ? 'low' : (raw.label === 'medium' ? 'medium' : null);
  const signature = {
    cap,
    denyDC,
    denyDCInherit: raw.denyDCInherit === true,
    label,
  };
  const obj = {
    path: raw.path,
    isDir: raw.isDir === true,
    signature,
  };
  if (typeof raw.error === 'string' && raw.error) obj.error = raw.error;
  return obj;
}


// ===== log/schema.js =====
// dsh-veneer —— 日志数据形状（**只定义"一条日志长什么样"**）
//
// 为什么把"形状"单独放一层：
//   · logger 只负责把事件分发给各 sink，不许顺手改字段；
//   · 客户端半边（拿不到文件系统时）也要 import 同一份事件表与截断上限；
//   · 事件名/级别/上限是**规格**：改了这里就等于改 `plugin/dsh-veneer/LOG-SCHEMA.md`，
//     工作区里的 veneer-log-test 会钉住。
//
// 本文件不 import 任何模块：node / 浏览器 / 离线测试都能加载。

/** 级别，从低到高。 */
const LEVELS = ['debug', 'info', 'warn', 'error'];

/** 没登记级别时的默认级别。 */
const DEFAULT_LEVEL = 'info';

/**
 * 截断上限（字符数，不是字节）。
 * message 2000 / 单个字段值 512 / 字段个数 20 / 栈 1024。
 */
const LIMITS = Object.freeze({
  message: 2000,
  fieldValue: 512,
  fields: 20,
  stack: 1024,
});

/** 造一条事件表项；`required` 只声明"该事件应带哪些字段"，不做强校验。 */
const spec = (level, required = []) => Object.freeze({ level, required: Object.freeze(required.slice()) });

/**
 * 事件表：键 = 事件名，值 = `{ level, required }`。
 *
 * 为什么 **不做强校验**（缺 `required` 不丢事件）：日志层的职责是"记录"，不是"拦业务"；
 * 真缺字段由测试与人工核对。这里给的是**约定**。
 */
const EVENTS = Object.freeze({
  'host.mount': spec('info', ['platform']),
  'host.plan': spec('info', ['children']),
  'instance.mount': spec('info', ['scanOnMount', 'bridge']),
  'host.inject.waiting': spec('info', ['canInject']),
  'host.inject.ready': spec('info'),
  'host.inject.fallback': spec('warn', ['waitedMs']),
  'root.resolve.failed': spec('warn', ['reason']),
  'scan.started': spec('info', ['source']),
  'scan.done': spec('info', ['source', 'status']),
  'scan.failed': spec('warn', ['reason']),
  'bridge.started': spec('info', ['dir']),
  'bridge.failed': spec('warn', ['reason']),
  'ui.read.failed': spec('warn', ['path']),
  'error.caught': spec('error', ['where']),
  // 通用消息：`log.info/warn/error/debug('……')` 这类只给一句话的调用记成它，级别由调用决定。
  'log.message': spec('info'),
});

/** 截断一个字符串；超限时保留 `max-1` 个字符加一个省略号，结果长度正好是 max。 */
function clipText(value, max) {
  const text = value == null ? '' : String(value);
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  if (limit === 0) return '';
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

/** 字段值嵌套深度的上限（防止一棵大树把一个字段撑爆）。 */
const MAX_DEPTH = 4;
/** 数组最多收几个元素（同上）。 */
const MAX_ITEMS = 50;

/**
 * 把一个任意值转成"一定能 JSON.stringify 的普通值"：
 * 先走一遍 JSON（顺带尊重 Date.toJSON、丢掉函数），失败（循环引用 / BigInt / 会抛的 getter）→ 转字符串。
 */
function plainOf(value) {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return String(value); // undefined / function / symbol
    return JSON.parse(json);
  } catch {
    return String(value); // 循环引用、BigInt、toJSON/getter 抛错
  }
}

/** 深度递归截断：字符串按 fieldValue 截，对象/数组有数量与深度上限。 */
function clipDeep(value, depth = 0) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string') return clipText(value, LIMITS.fieldValue);
  if (type === 'number' || type === 'boolean') return value;
  if (depth >= MAX_DEPTH) return clipText(String(value), LIMITS.fieldValue);
  if (Array.isArray(value)) {
    const out = [];
    const count = Math.min(value.length, MAX_ITEMS);
    for (let i = 0; i < count; i += 1) out.push(clipDeep(value[i], depth + 1));
    return out;
  }
  if (type === 'object') {
    const out = {};
    const keys = Object.keys(value);
    const count = Math.min(keys.length, LIMITS.fields);
    for (let i = 0; i < count; i += 1) out[keys[i]] = clipDeep(value[keys[i]], depth + 1);
    return out;
  }
  return clipText(String(value), LIMITS.fieldValue);
}

/** 一个字段值：先收口成可 JSON 序列化的普通值（循环引用/函数 → 字符串），再按上限截断。 */
function normalizeValue(value) {
  return clipDeep(plainOf(value), 0);
}

/** 规整 fields：不是对象 → `{}`；最多 `LIMITS.fields` 个键；每个值按上限截断。 */
function normalizeFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  const out = {};
  let count = 0;
  for (const key of Object.keys(fields)) {
    if (count >= LIMITS.fields) break;
    out[String(key)] = normalizeValue(fields[key]);
    count += 1;
  }
  return out;
}

/** 当前时间（ISO 字符串）；理论上不会抛，兜一层只是不想让日志门面担心。 */
function nowIso() {
  try { return new Date().toISOString(); } catch { return ''; }
}

/**
 * 造一条事件。
 *
 * @param {string} name 事件名（事件表里有就取表里的级别；没有就是 `info` + 原样名字）
 * @param {string} message 一句话结论（按 `LIMITS.message` 截断）
 * @param {object} [fields] 结构化字段（只收可 JSON 序列化的值；循环引用/函数 → 字符串）
 * @param {object} [extras] 附加字段（`bootId`、`stack` 等）；值同样收口成可序列化
 * @returns {{ts:string, level:string, event:string, message:string, fields:object, bootId?:string}}
 */
function makeEvent(name, message, fields = {}, extras = {}) {
  const eventName = String(name == null ? 'unknown' : name);
  const known = Object.prototype.hasOwnProperty.call(EVENTS, eventName) ? EVENTS[eventName] : null;
  const event = {
    ts: nowIso(),
    level: known ? known.level : DEFAULT_LEVEL,
    event: eventName,
    message: clipText(message, LIMITS.message),
    fields: normalizeFields(fields),
  };

  // `bootId` 放在 extras 之前（与文档里的字段顺序一致）；其余 extras 逐个收口。
  try {
    if (extras && typeof extras === 'object') {
      if (extras.bootId != null) event.bootId = clipText(extras.bootId, LIMITS.fieldValue);
      for (const key of Object.keys(extras)) {
        if (key === 'bootId') continue;
        if (key === 'level') {
          if (LEVELS.includes(extras.level)) event.level = extras.level;
          continue;
        }
        if (key === 'stack') {
          event.stack = clipText(extras.stack, LIMITS.stack);
          continue;
        }
        event[key] = normalizeValue(extras[key]);
      }
    }
  } catch { /* 附加字段坏了不影响主字段：宁可少带，不丢这条 */ }

  return event;
}

/** 8 位小写字母数字的启动标识（一次插件启动一个，用来把日志按启动分组）。 */
function newBootId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  try {
    for (let i = 0; i < 8; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  } catch { out = '00000000'; }
  return out;
}


// ===== log/memory-sink.js =====
// dsh-veneer —— 内存环形缓冲（客户端拿不到文件系统时的"最后 N 条"）
//
// 为什么必须有它（脚手架 log/README 的硬要求）：
//   · 客户端半边可能根本没有 fs 服务，日志写不进文件；
//   · 但界面要能显示"刚才发生了什么"（面板的调试行直接读 `logs(n)`）；
//   · 环形 = 有界：只留最近 N 条，写日志不会把内存吃光。
//
// 纪律：**永不抛**。日志自己坏了不许反过来影响业务流程。

/**
 * 造一个内存 sink（环形缓冲）。
 *
 * @param {number} [limit=200] 最多保留多少条；超了丢最旧的。非法值退回 200。
 * @returns {{write:(event:object)=>boolean, tail:(n?:number)=>object[], clear:()=>void, size:()=>number}}
 */
function createMemorySink(limit = 200) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  let buffer = [];

  return {
    /**
     * 收一条事件。只收对象（数组不算「一条日志」）；超上限丢最旧的。
     * @param {object} event
     * @returns {boolean} 是否收下
     */
    write(event) {
      try {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
        buffer.push(event);
        if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * 取最近 n 条（**旧 → 新**，与写入顺序一致；面板直接按这个顺序显示）。
     * @param {number} [n=20]
     * @returns {object[]}
     */
    tail(n = 20) {
      try {
        const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
        if (count === 0) return [];
        return buffer.slice(-count);
      } catch {
        return [];
      }
    },

    /** 清空。 */
    clear() {
      try { buffer = []; } catch { /* 清不掉也不许抛 */ }
    },

    /** 当前条数。 */
    size() {
      try { return buffer.length; } catch { return 0; }
    },
  };
}


// ===== log/logger.js =====
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
function createLog(hostLogger, options = {}) {
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


// ===== ui/config-page.js =====
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



/** 客户端要注入的服务：只用远端命名空间（已声明过的），不碰别的。 */
const CLIENT_INJECT = ['slots', 'remote', 'remote.workspaceFiles'];

/** 小摘要的相对路径（宿主写在报告旁边；见 core/persist.js 的 `summaryRelOf`）。 */
const SUMMARY_REL = 'review/veneer-summary.json';

/** 派发修复请求的配置字段（宿主 Config 里的 volatile 字段；面板只 `set`，不读）。 */
const FIX_REQUEST_KEY = 'fixRequest';

/** 提权进程写的结果文件（相对工作区根）。面板轮询它；**id 对得上才算本次结果**。 */
const FIX_RESULT_REL = '.dsh-veneer/fix-result.json';

/** 轮询间隔 / 最长等待（毫秒）。 */
const FIX_POLL_MS = 2000;
const FIX_TIMEOUT_MS = 120000;

/** 结果里最多列几个失败原因（再多就折叠成"还有 N 个"）。 */
const FIX_FAILURES_SHOWN = 5;

/** 配置页在 Slots 里的 key：`<包名>#<行 id>`（与 cordis.patch.yml 的行 id 一致）。 */
const SLOT_KEY = 'dsh-veneer#veneer';

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
function describeResult(result) {
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
function describeMissing(report) {
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
function sessionIdsOf(snapshot, limit = 12) {
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
function extractText(response) {
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
function normalizeWorkspacePath(path) {
  return String(path === null || path === undefined ? '' : path)
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 两个工作区路径是不是同一个（正斜杠/反斜杠、尾斜杠不同也算同一个）。 */
function sameWorkspace(a, b) {
  const left = normalizeWorkspacePath(a);
  const right = normalizeWorkspacePath(b);
  return !!left && left === right;
}

/** 报告里的缺项对象清单（兼容摘要的 `missing[]`；去重、只认三项内的值）。 */
function objectsOf(report) {
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
function reportRootOf(report) {
  return report && typeof report.root === 'string' ? report.root : '';
}

/**
 * 按工作区分组（一个报告通常只有一个根；`workspaces[]` 是给将来多工作区报告留的）。
 * 返回 `[{ workspace, objects: [{path, isDir, missing}] }]`；保持报告里的顺序。
 */
function workspaceGroupsOf(report) {
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
function isWorkspaceExcluded(configValue, workspace) {
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
function buildFixRequest(workspace, objects, options = {}) {
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
function summarizeFixResult(result) {
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
function describeFixResult(summary) {
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
function createClientPlugin({ React, ctx, log }) {
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


// ===== client.js =====
// dsh-veneer —— 界面半边入口：**只装配**
//
// 客户端模块的形状（照官方模板）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … return { inject, apply } } })
// React 从**浏览器模块表**取（`require('react')`），不自己装一份。
//
// **平台按 classic script 加载界面插件**（不是 ES 模块）：发布的是 `lib/client.js`，
//   由工作区工具 `tools/build-veneer-client.mjs` 从本文件 + `ui/*.js` + 它们的相对依赖拼接生成。
//   改界面源码后必须重新生成，否则跑的是旧代码。



if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-veneer',
    factory(require) {
      const React = require('react');
      return {
        inject: CLIENT_INJECT,
        apply(ctx) {
          // 客户端日志：浏览器拿不到文件系统 → 只有内存环形缓冲（面板里显示最近几条）。
          const log = createLog(null, { memoryLimit: 120 });
          const plugin = createClientPlugin({ React, ctx, log });
          return plugin.apply(ctx);
        },
      };
    },
  });
}

})();