// dsh-veneer —— 修复令牌的**进程内小总线**（纯 JS：不依赖 ctx、不做 IO、不碰 host）
//
// 为什么需要它（2026-11-23 集成方定的契约）：
//   · Cordis 的 `loader/volatile-update` 是**向上冒泡**的：Loader 在插件行 fiber 上 emit，
//     子 fiber（工作区实例）收不到；所以只能在 `index.js` 里监听一次；
//   · 但"这个令牌归哪个工作区、同一 id 只执行一次、失败怎么报"是**实例**的事（每个 root 一份日志）；
//   · 于是中间放一条模块级小总线：`index.js` parse → `publishFixRequest(request)`；
//     实例 `apply` 时 `subscribeFixRequests(handler)`，清理函数里退订。
//
// 纪律：
//   · **纯函数/纯数据**：不 import 任何层（`tools/check.mjs` 的边界与"core 不 import node:*"都满足）；
//   · `publish` **永不抛**：某个订阅者坏了不能影响别的实例，也不能把异常带回 Loader 的事件总线；
//   · 订阅者自己按 `workspace` 过滤（多个实例时，非本工作区的请求会被各自忽略）。
//
// 形状（令牌）：`{ version?:1, id:string, workspace:string, objects:[{ path, items:[...] }] }`

/** 三项的合法名字（与 `model/acl.js` 的 ITEM 同一套词）。 */
export const FIX_ITEMS = Object.freeze(['cap', 'denyDC', 'label']);

/** 当前订阅者集合（模块级；一次进程一份）。 */
const handlers = new Set();

/**
 * 订阅修复令牌。
 * @param {(request:object) => void} handler 已通过 `parseFixRequest` 校验的请求对象
 * @returns {Function} 退订函数（幂等、无副作用）
 */
export function subscribeFixRequests(handler) {
  if (typeof handler !== 'function') return () => {};
  // 包一层：订阅者异常在这里收掉，不抛回 `publish` 的调用方（Loader 事件总线）。
  const wrapped = (request) => {
    try {
      handler(request);
    } catch { /* 订阅者自己的异常由它自己记日志；不能影响其它实例 */ }
  };
  handlers.add(wrapped);
  return () => {
    handlers.delete(wrapped);
  };
}

/**
 * 把一份已校验的修复令牌交给所有订阅的工作区实例。
 * @param {object} request `{ id, workspace, objects }`
 * @returns {{delivered:number}} 投给几个订阅者（0 = 本进程没有实例，调用方据此报一次）
 */
export function publishFixRequest(request) {
  const delivered = [];
  for (const handler of [...handlers]) {
    try {
      handler(request);
      delivered.push(handler);
    } catch { /* 单个订阅者出错不影响其它实例 */ }
  }
  return { delivered: delivered.length };
}

/** 当前订阅者数量（测试/诊断用）。 */
export function subscriberCount() {
  return handlers.size;
}

/**
 * `loader/volatile-update` 的变更路径里有没有 `fixRequest`？
 *
 * Loader 的回调参数是**变更路径数组**（`string[][]`，如 `[['fixRequest']]`）；
 * 也容忍扁平字符串（`['fixRequest']`）与 `[{value:…}]` 之外的其它拼法。
 * @param {unknown} changed
 */
export function fixRequestChanged(changed) {
  const list = Array.isArray(changed) ? changed : [changed];
  for (const item of list) {
    if (Array.isArray(item)) {
      if (item.length && String(item[0]) === 'fixRequest') return true;
      continue;
    }
    if (typeof item === 'string') {
      if (item === 'fixRequest' || item.startsWith('fixRequest.')) return true;
    }
  }
  return false;
}

/** 清空订阅（**只给测试用**：真实运行靠实例的清理函数退订）。 */
export function resetFixRequests() {
  handlers.clear();
}

/** 非法令牌的说法：一句话原因 + 稳定前缀（日志按它检索）。 */
function invalid(reason) {
  return { ok: false, reason: reason };
}

/**
 * 校验一份原始令牌（客户端发来的 JSON 字符串，或已 parse 的对象）。
 *
 * 只做**形状与语义**校验，不碰文件系统：工作区是否属于本实例、对象是否真的缺项，
 * 由 `core/fix.js` 的 `runFix` 与实例再校验一次。
 *
 * @param {unknown} raw 字符串（客户端写的 JSON）或对象
 * @returns {{ok:true, value:{id:string, workspace:string, objects:Array<{path:string, items:string[]}>}}|{ok:false, reason:string}}
 */
export function parseFixRequest(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return invalid('修复令牌是空字符串');
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return invalid('修复令牌不是合法 JSON：' + String((err && err.message) || err));
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('修复令牌必须是对象');
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return invalid('修复令牌缺 id');
  const workspace = typeof value.workspace === 'string' ? value.workspace.trim() : '';
  if (!workspace) return invalid('修复令牌缺 workspace');
  if (!Array.isArray(value.objects) || value.objects.length === 0) return invalid('修复令牌的 objects 必须是非空数组');

  const objects = [];
  for (let index = 0; index < value.objects.length; index += 1) {
    const entry = value.objects[index];
    const where = 'objects[' + index + ']';
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid(where + ' 必须是对象');
    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!path) return invalid(where + '.path 必须是非空字符串');
    const rawItems = Array.isArray(entry.items) ? entry.items : [];
    const items = [];
    for (const name of rawItems) {
      // 未知项直接拒（不静默丢掉：客户端与宿主对"要修哪几项"必须是同一套词）。
      if (!FIX_ITEMS.includes(name)) return invalid(where + '.items 含未知项：' + String(name));
      if (!items.includes(name)) items.push(name);
    }
    if (items.length === 0) return invalid(where + '.items 必须是非空数组');
    objects.push({ path, items });
  }
  return { ok: true, value: { id, workspace, objects } };
}
