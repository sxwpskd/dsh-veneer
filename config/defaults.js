// dsh-veneer —— 默认配置与归并（config 层：不 import core/、不访问宿主）
//
// 发布默认值刻意保守：`workspaceRoot` 留空（别人机器上没有本机路径）、`scanOnMount` 开
// （它只做只读扫描 + 写一份自己的报告）。
//
// 这里**不声明 Config / schemastery**：配置走补丁层 + 代码默认值。理由与 dsh-milieu 相反——
// 那个插件的配置项多到需要表单；这个只有 6 个键，多引一个要打包的依赖不划算。

export const DEFAULT_CONFIG = {
  // 工作区根。空 = 由平台 / `workspaces` 决定。
  workspaceRoot: '',
  // 多工作区：每项 `{ path }` 挂一个 child fiber；空数组 = 单工作区兼容。
  workspaces: [],
  // 报告写在**工作区里**的相对路径（相对根）。**不要写进 dsh-milieu 的状态文件**。
  reportPath: 'review/veneer-state.json',
  // 一次扫描最多列多少个对象（防超大工作区把时间吃光；超了报告 `partial`）。
  listLimit: 50000,
  // 单次读 ACL 的超时（毫秒）。大工作区实测 900 个对象约 5 秒，6 万给足余量。
  scanTimeoutMs: 60000,
  // 等服务就绪等多久（毫秒）。超时用父 ctx 兜一次（与 dsh-milieu 的同一手法）。
  readyWaitMs: 10000,
  // 工作区打开后自动扫一次。手动重扫不看这个开关。
  scanOnMount: true,
};

/** 深拷贝（只处理普通对象与数组）。 */
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
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
