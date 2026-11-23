// dsh-veneer —— **Config Schema**（插件配置的运行时校验 / 默认值 / Volatile 声明）
//
// 为什么要有它（v2）：
//   · Cordis 的配置页与 `form.mutate` 要求插件导出 `Config`（Schemastery），Loader 在
//     `apply` 前用它校验配置、补默认值、把 `.volatile()` 字段解析成稳定引用；
//   · 客户端写"修复令牌"只能走配置（浏览器没有写工作区文件的通道）：令牌字段必须 volatile，
//     保存后 Loader 不重载插件行，只发 `loader/volatile-update`；
//   · 所有默认值都从 `config/defaults.js` 取——**本文件不重新写死任何数字**。
//
// Volatile（即时字段）只有 1 个：`fixRequest`。
//   · `fixRequest` 是客户端写的 JSON 字符串令牌：`{ id, workspace, objects:[{path,items}] }`；
//   · Loader 原地更新引用，宿主侧在 `index.js` 监听 `loader/volatile-update`（回调参数是
//     **变更路径数组**，如 `['fixRequest']`）→ `core/fix-bus.js` 分发给对应工作区实例。
//   · 其余字段是普通字段：改它们走 Loader 的常规生命周期（重载插件行 → 重新规划工作区范围）。
//
// 不可用的配置形状在 Loader 校验阶段就报错（fail loud）；未知字段保留（向前兼容）。
import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_CONFIG } from './defaults.js';

/** `workspaces` 项：只声明并校验 `path`（其余覆盖字段原样透传，避免物化缺省值）。 */
const workspaceItem = Schema.object({
  path: Schema.string().required(),
});

/**
 * 插件配置。
 *
 * 字段与 `cordis.patch.yml` 补丁层、`config/defaults.js` 一一对应；数组默认值用展开复制，
 * 避免多个配置实例共享同一个数组。
 */
export const Config = Schema.object({
  // ---- 工作区 ----
  workspaceRoot: Schema.string().default(DEFAULT_CONFIG.workspaceRoot),
  workspaces: Schema.array(workspaceItem).default([]),
  // ---- 报告 ----
  reportPath: Schema.string().default(DEFAULT_CONFIG.reportPath),
  listLimit: Schema.number().default(DEFAULT_CONFIG.listLimit),
  scanTimeoutMs: Schema.number().default(DEFAULT_CONFIG.scanTimeoutMs),
  readyWaitMs: Schema.number().default(DEFAULT_CONFIG.readyWaitMs),
  // ---- 自动动作 ----
  scanOnMount: Schema.boolean().default(DEFAULT_CONFIG.scanOnMount),
  bridge: Schema.boolean().default(DEFAULT_CONFIG.bridge),
  bridgePollMs: Schema.number().default(DEFAULT_CONFIG.bridgePollMs),
  // ---- v2 · 工作区范围（R-13） ----
  autoIncludeNew: Schema.boolean().default(DEFAULT_CONFIG.autoIncludeNew),
  include: Schema.array(Schema.string()).default([...DEFAULT_CONFIG.include]),
  exclude: Schema.array(Schema.string()).default([...DEFAULT_CONFIG.exclude]),
  // ---- v2 · 会话检查（R-12） ----
  sessionCheck: Schema.boolean().default(DEFAULT_CONFIG.sessionCheck),
  autoPrompt: Schema.boolean().default(DEFAULT_CONFIG.autoPrompt),
  // ---- v2 · 修复令牌（B 通道；即时字段） ----
  fixRequest: Schema.string().default(DEFAULT_CONFIG.fixRequest).volatile(),
});

/** 列出即时字段名（启动器 / 测试用；与上面 `.volatile()` 的字段保持一致）。 */
export const VOLATILE_FIELDS = Object.freeze(['fixRequest']);

export default Config;
