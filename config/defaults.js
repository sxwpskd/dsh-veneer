// dsh-veneer —— 默认配置与归并（config 层：不 import core/、不访问宿主）
//
// 发布默认值刻意保守：`workspaceRoot` 留空（别人机器上没有本机路径）、`scanOnMount` 开
// （它只做只读扫描 + 写一份自己的报告）。
//
// v2 起 `Config` 在 `config/schema.js` 里用 Schemastery 声明（Loader 校验 + 表单 + volatile），
// **默认值仍只在这里写一份**：schema 一律从 `DEFAULT_CONFIG` 取，不重新写死数字。

import { REPORT_REL_PATH } from '../model/acl.js';

export const DEFAULT_CONFIG = {
  // 工作区根。空 = 由平台 / `workspaces` 决定。
  workspaceRoot: '',
  // 多工作区：每项 `{ path }` 挂一个 child fiber；空数组 = 单工作区兼容。
  workspaces: [],
  // 报告写在**工作区里**的相对路径（相对根）。**不要写进 dsh-milieu 的状态文件**。
  reportPath: REPORT_REL_PATH,
  // 一次扫描最多列多少个对象（防超大工作区把时间吃光；超了报告 `partial`）。
  listLimit: 50000,
  // 单次读 ACL 的超时（毫秒）。大工作区实测 900 个对象约 5 秒，6 万给足余量。
  scanTimeoutMs: 60000,
  // 等服务就绪等多久（毫秒）。超时用父 ctx 兜一次（与 dsh-milieu 的同一手法）。
  readyWaitMs: 10000,
  // 工作区打开后自动扫一次。手动重扫（菜单）不看这个开关。
  scanOnMount: true,
  // **手动入口的桥**（`.dsh-veneer/request.json` → 扫一次 → `result.json`）。默认开。
  bridge: true,
  // 桥轮询请求文件的间隔（毫秒）；有文件监视时它只是兜底。
  bridgePollMs: 1000,

  // ---- v2 · 工作区范围（R-13） ----
  // 新出现的工作区自动纳入（`include` 为空时由它决定"全要"还是"不要"）。
  autoIncludeNew: true,
  // 白名单：非空时只管理这些工作区（归一化后比较）。
  include: [],
  // 黑名单：优先于 `autoIncludeNew`；弹窗选"不再检查"就是把路径加到这里。
  exclude: [],

  // ---- v2 · 会话检查（R-12） ----
  // 会话首条人类消息触发一次异步扫描。
  sessionCheck: true,
  // 扫出缺项后弹宿主原生确认框（关掉就只写日志、不打扰人）。
  autoPrompt: true,
  // **volatile**：客户端写 JSON 令牌（`{id, workspace, objects}`）请求修复；宿主收到即执行。
  // 标 volatile 后 Loader 只改它时不会重载插件行，而是发 `loader/volatile-update`
  //（与 dsh-milieu 的即时字段同一机制）。
  fixRequest: '',
};

/**
 * 这个值是不是 Cordis Volatile 引用？（对象且带可调用的 `get`）
 * 声明 `.volatile()` 后 Loader 交给 `apply` 的不是普通值，而是稳定引用；用 `.get()` 读快照。
 * 与 dsh-milieu 的 `config/values.js` 同一判据（不 import cosmokit，少一个未声明的传递依赖）。
 * @param {unknown} value
 */
export function isVolatileRef(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && typeof value.get === 'function';
}

/**
 * 把一个 volatile 值展开成**普通数据**（读取即时字段当前值的唯一入口）。
 *
 * 认三种形态：
 *   · Cordis/Cosmokit 的 Volatile 引用（`{ get() }`）——官方机制；
 *   · 带 `.value` 的引用对象——测试/旧实现；
 *   · 普通值——原样返回。
 * 读失败（`.get()` 抛错）返回 `undefined`：配置读不出来时按缺省处理，不把异常带进主流程。
 * @param {unknown} value
 */
export function resolveVolatile(value) {
  let current = value;
  let depth = 0;
  while (depth < 32 && current && typeof current === 'object') {
    if (typeof current.get === 'function') {
      try {
        current = current.get();
      } catch {
        return undefined;
      }
      depth += 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(current, 'value')) {
      current = current.value;
      depth += 1;
      continue;
    }
    break;
  }
  return current;
}

/** 深拷贝（只处理普通对象与数组；**Volatile 引用原样保留**）。 */
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  // 引用必须留着：child fiber 要靠它读即时字段的当前值（拷成普通对象就只剩空壳）。
  if (isVolatileRef(value)) return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const key of Object.keys(value)) out[key] = clone(value[key]);
  return out;
}

/**
 * 把补丁合到默认值上：嵌套普通对象递归合并，数组/标量整体替换，`0` / `''` / `false` 原样保留
 * （`0` 被 `||` 吃掉是 dsh-milieu 真踩过的坑，journal/044）。
 * @param {object} defaults
 * @param {unknown} patch
 */
export function mergeConfig(defaults, patch) {
  if (patch === null || patch === undefined || typeof patch !== 'object' || Array.isArray(patch)) {
    return clone(defaults);
  }
  const out = clone(defaults);
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    const base = out[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
      && base && typeof base === 'object' && !Array.isArray(base)) {
      out[key] = mergeConfig(base, value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

/** 补丁层配置 → 生效配置。 */
export function withDefaults(config) {
  return mergeConfig(DEFAULT_CONFIG, config);
}
