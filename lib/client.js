// 本文件由工作区工具 tools/build-veneer-client.mjs 从 <包>/ 下列 6 个模块拼接生成：
//   model/acl.js , log/schema.js , log/memory-sink.js , log/logger.js , ui/config-page.js , client.js
// **不要手改**：改源码后重跑构建。 src=710fb5a77a74
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
// dsh-veneer —— 插件页的「检查沙箱物化」面板（界面半边：**只读展示**）
//
// 形态：`plugins.row.config`（插件管理页里 dsh-veneer 那一行的配置页）里的一块。
//
// **它只读，不触发扫描。** 原因（查实过，别再试）：
//   · 浏览器侧没有写工作区文件的通道（`remote.workspaceFiles` 只有读）；
//   · 插件包没有 Typert 生成，界面拿不到自己的 RPC。
// 所以扫描由**宿主在打开工作区时**做一次（`scanOnMount`），面板读那份报告。
// 要再扫一次：重开工作区/重开 DSH，或用执行侧的 `-Apply` 干跑（只读）。
//
// 纪律（都真踩过）：
//   · 组件签名是 `(props)`，**React 从 `props.React` 取**；缺了就返回 null（不要这时候调 hooks）；
//   · **不读未声明的 ctx 服务**（真环境是代理，读未声明属性会抛，组件会整块消失）；
//   · 只读文件用 `remote.workspaceFiles.read(path, {}, signal)`（官方两参形状；老代码写过三参）；
//   · 不写 DOM、不 import Harness 客户端包、只用 `--dsw-alias-*` token。



/** 客户端要注入的服务：只用远端命名空间（已声明过的），不碰别的。 */
const CLIENT_INJECT = ['slots', 'remote', 'remote.workspaceFiles'];

/** 小摘要的相对路径（宿主写在报告旁边；见 core/persist.js 的 `summaryRelOf`）。 */
const SUMMARY_REL = 'review/veneer-summary.json';

/** 配置页在 Slots 里的 key：`<包名>#<行 id>`（与 cordis.patch.yml 的行 id 一致）。 */
const SLOT_KEY = 'dsh-veneer#veneer';

/** 主题 token（只用 `--dsw-alias-*`）。 */
const TOKENS = {
  text: 'var(--dsw-alias-text-1, #1f2328)',
  muted: 'var(--dsw-alias-text-2, #57606a)',
  border: 'var(--dsw-alias-border-1, #d0d7de)',
  bg: 'var(--dsw-alias-bg-2, #f6f8fa)',
  good: 'var(--dsw-alias-state-success, #1a7f37)',
  warn: 'var(--dsw-alias-state-warning, #9a6700)',
  bad: 'var(--dsw-alias-state-danger, #cf222e)',
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
 * 造客户端插件。
 * @param {{React:object, ctx:object, log?:object}} input `log` 由 `client.js` 传入（内存环形缓冲）；
 *   不传时自己造一个（浏览器里没有宿主 logger，正好只用内存 + 控制台）。
 */
function createClientPlugin({ React, ctx, log }) {
  const closureReact = React;
  // 客户端日志：拿不到文件系统 → 内存环形缓冲（脚手架要求），面板把它当"诊断日志"显示。
  const logger = log || createLog(null, { memoryLimit: 120 });

  /**
   * 读报告。**必须带 sessionId**（2026-11-22 真机报错证实：Remote 只接受 3 个业务参数 + signal）。
   * 一个工作区可能有好几个会话，逐个试；读不到就退回"还没扫"。
   * @param {string[]} sessionIds
   */
  const readReport = async (sessionIds) => {
    let files;
    try { files = ctx && ctx.remote && ctx.remote.workspaceFiles; } catch { files = null; }
    if (!files || typeof files.read !== 'function') {
      return { ok: false, reason: '没有文件读通道（remote.workspaceFiles 不可用）', tried: [] };
    }
    const ids = Array.isArray(sessionIds) ? sessionIds : [];
    if (!ids.length) {
      const reason = '界面还拿不到会话（读文件需要一个 SessionId）';
      try { logger.event('ui.read.failed', reason, { path: SUMMARY_REL }); } catch { /* 日志坏了不影响面板 */ }
      return { ok: false, reason, tried: [] };
    }
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(8000) : undefined;
    const tried = [];
    // 先读小摘要（几 KB），再退到整份报告；同一会话内失败就换下一个会话。
    for (const rel of [SUMMARY_REL, REPORT_REL_PATH]) {
      for (const sessionId of ids) {
        try {
          const res = await files.read(sessionId, rel, {}, signal);
          const value = res && res.ok === true && res.value !== undefined ? res.value : res;
          const text = typeof value === 'string'
            ? value
            : (value && typeof value.text === 'string' ? value.text : null);
          if (text === null) { tried.push(rel + ' @' + sessionId.slice(-6) + '：返回形状没有 text'); continue; }
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') return { ok: true, report: parsed, from: rel, sessionId };
        } catch (err) {
          tried.push(rel + ' @' + String(sessionId).slice(-6) + '：'
            + String((err && err.message) || err).slice(0, 120));
        }
      }
    }
    try { logger.event('ui.read.failed', '读不到报告（' + tried.length + ' 次尝试都失败）', { path: SUMMARY_REL }); } catch { /* 日志坏了不影响面板 */ }
    return { ok: false, reason: '读不到报告（宿主可能还没扫）', tried };
  };

  const Panel = (props) => {
    const R = (props && props.React) || closureReact;
    if (!R || typeof R.createElement !== 'function' || typeof R.useState !== 'function') return null;
    const e = R.createElement;
    // 行配置 slot 的标准 props 里有 `useSessions`（快照钩子）。它必须**无条件**调用（hooks 规则）。
    const useSessions = props && props.useSessions;
    const sessions = typeof useSessions === 'function' ? useSessions((s) => s) : null;
    const sessionIds = sessionIdsOf(sessions);
    const [state, setState] = R.useState({ phase: 'init', text: '正在读报告…', tone: 'muted', report: null });

    const load = async () => {
      setState({ phase: 'loading', text: '正在读报告…', tone: 'muted', report: null, tried: [] });
      const got = await readReport(sessionIds);
      if (!got.ok) {
        setState({ phase: 'none', text: got.reason, tone: 'muted', report: null, tried: got.tried || [] });
        return;
      }
      const line = describeResult(got.report);
      setState({ phase: 'done', text: line.text, tone: line.tone, report: got.report, tried: [], from: got.from });
    };

    if (typeof R.useEffect === 'function') {
      R.useEffect(() => { void load(); }, []);
    }

    const report = state.report;
    const details = report ? describeMissing(report) : [];
    const scannedAt = report && typeof report.scannedAt === 'number'
      ? new Date(report.scannedAt).toLocaleString() : '';
    const diagLines = (() => {
      try {
        return (logger.logs(6) || []).map((entry) => String(entry && entry.ts ? entry.ts : '')
          + ' ' + String(entry && entry.level ? entry.level : '')
          + ' ' + String(entry && (entry.event || entry.message) ? (entry.event || entry.message) : ''));
      } catch {
        return [];
      }
    })();

    return e('div', {
      style: {
        display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
        border: '1px solid ' + TOKENS.border, borderRadius: 8, background: TOKENS.bg,
      },
    }, [
      e('div', { key: 'title', style: { fontWeight: 600, color: TOKENS.text } }, '检查沙箱物化'),
      e('div', { key: 'desc', style: { fontSize: 12, color: TOKENS.muted } },
        '只读：宿主在打开工作区时扫一次，看哪些既有对象缺了物化三项（能力 ACE / Everyone 拒删子项 / Low 标签）。'
        + '要再扫一次，重开工作区（或重开 DSH）。'),
      e('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
        e('button', {
          key: 'btn', type: 'button', onClick: () => { void load(); },
          style: {
            padding: '4px 12px', borderRadius: 6, border: '1px solid ' + TOKENS.border,
            background: TOKENS.text, color: '#fff', cursor: 'pointer',
          },
        }, '重新读取'),
        e('span', { key: 'msg', style: { fontSize: 12, color: TOKENS[state.tone] || TOKENS.muted } }, state.text),
      ]),
      details.length
        ? e('div', { key: 'details', style: { fontSize: 12, color: TOKENS.muted, whiteSpace: 'pre-wrap', fontFamily: 'monospace' } }, details.join('\n'))
        : null,
      report
        ? e('div', { key: 'report', style: { fontSize: 12, color: TOKENS.muted } },
          '来源：' + (state.from || REPORT_REL_PATH) + (scannedAt ? '（扫描于 ' + scannedAt + '）' : ''))
        : null,
      // 读不到时把**每次尝试的原因**摊开：这样不用开 DevTools 也知道卡在"没通道 / 文件不存在 / 形状不对"。
      !report && state.tried && state.tried.length
        ? e('div', {
          key: 'tried',
          style: { fontSize: 12, color: TOKENS.muted, whiteSpace: 'pre-wrap', fontFamily: 'monospace' },
        }, state.tried.join('\n'))
        : null,
      // 客户端诊断日志（内存环形缓冲；脚手架要求"拿不到文件系统时退回内存 + 界面调试行"）。
      diagLines.length
        ? e('pre', {
          key: 'diag',
          style: {
            fontSize: 11, color: TOKENS.muted, whiteSpace: 'pre-wrap', margin: 0,
            maxHeight: 120, overflow: 'auto', fontFamily: 'monospace',
          },
        }, '诊断日志（最近 ' + diagLines.length + ' 条）：\n' + diagLines.join('\n'))
        : null,
    ].filter(Boolean));
  };

  return {
    inject: CLIENT_INJECT,
    apply(inner) {
      const slots = (inner && inner.slots) || (ctx && ctx.slots);
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