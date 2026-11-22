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
export const LEVELS = ['debug', 'info', 'warn', 'error'];

/** 没登记级别时的默认级别。 */
export const DEFAULT_LEVEL = 'info';

/**
 * 截断上限（字符数，不是字节）。
 * message 2000 / 单个字段值 512 / 字段个数 20 / 栈 1024。
 */
export const LIMITS = Object.freeze({
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
export const EVENTS = Object.freeze({
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
export function makeEvent(name, message, fields = {}, extras = {}) {
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
export function newBootId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  try {
    for (let i = 0; i < 8; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  } catch { out = '00000000'; }
  return out;
}
