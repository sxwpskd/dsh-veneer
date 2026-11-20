// dsh-veneer —— 宿主半边入口（**只做装配，不写业务**）
//
// 与 dsh-milieu 的 A 方案同形：
//   · profile 里只有**一个 Loader 行**（`cordis.patch.yml`）；
//   · 本文件按 `workspaces` 规划，为每个工作区用 `ctx.plugin(workspacePlugin, childConfig)` 挂一个
//     **child fiber**；`workspaces` 为空时挂一个默认实例（根在第一次扫描时解析）。
//
// 为什么不是多行 profile：同一个包出现在多个 active Loader 行会被 client-modules 拒绝
//   （dsh-milieu 实测，WORKSPACE-MANAGEMENT.md）；多实例只能在**一个 Loader 行内**做。
//
// 非 Windows：挂载即报告 `unsupported` 并什么都不做（物化三项是 NTFS 语义）。
//
// 移除：卸载时 Cordis 会 dispose 本文件返回的清理函数；工作区里的报告文件不自动删
//   （用户自己创建的认知材料不该被插件悄悄删掉），要清就删 `review/veneer-state.json`。
import { planWorkspaces } from './core/plan.js';
import { workspacePlugin } from './core/workspace-instance.js';
import { createLog } from './log/logger.js';
import { guardSync } from './exception/guard.js';
import { CODES } from './exception/codes.js';

export const name = 'dsh-veneer';
export const inject = [];

/** 宿主 logger（真 ctx 是代理：读未声明属性可能抛）。 */
function hostLoggerOf(ctx) {
  try {
    return (ctx && ctx.logger) || null;
  } catch {
    return null;
  }
}

/** 包根目录：优先问宿主（它知道包装在哪），拿不到就让实例自己按模块位置推。 */
function packageDirOfCtx(ctx) {
  try {
    const value = ctx && ctx.packageDir;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

/** 把一个 child 配置挂成实例。 */
function mountChild(ctx, childConfig, packageDir) {
  if (ctx && typeof ctx.plugin === 'function') {
    const fiber = ctx.plugin(workspacePlugin, childConfig);
    return () => {
      try {
        if (fiber && typeof fiber.dispose === 'function') {
          const pending = fiber.dispose();
          if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 卸载失败不反噬宿主 */ });
        }
      } catch { /* 卸载失败不反噬宿主 */ }
    };
  }
  // 离线假 ctx / 没有 plugin API 的宿主：直接调用实例 apply（等价于一个实例）。
  const cleanup = workspacePlugin.apply(ctx, childConfig);
  void packageDir;
  return typeof cleanup === 'function' ? cleanup : () => {};
}

/**
 * @param {object} ctx Cordis ctx
 * @param {object} [config] 该 Loader 行的配置
 * @returns {Function} 清理函数（dispose 每个 child fiber）
 */
export function apply(ctx, config) {
  const log = createLog(hostLoggerOf(ctx));
  let childCleanups = [];
  let disposed = false;

  const disposeChildren = () => {
    const cleanups = childCleanups;
    childCleanups = [];
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* 清理失败不反噬宿主 */ }
    }
  };

  const platform = typeof process !== 'undefined' && process.platform ? process.platform : '';
  if (platform !== 'win32') {
    log.warn('不是 Windows（' + (platform || 'unknown') + '）：物化三项是 NTFS 语义，本插件不做任何事');
    return () => {};
  }

  const plan = planWorkspaces(config);
  if (!plan.ok) {
    log.warn('工作区配置无效，本次不挂载任何实例：' + plan.errors.join('；'));
    return () => {};
  }

  const packageDir = packageDirOfCtx(ctx);
  for (const child of plan.children) {
    const mounted = guardSync('挂载工作区实例', () => mountChild(ctx, child.config, packageDir), {
      log,
      blockedBy: 'host',
      code: CODES.HOST_CALL_FAILED,
    });
    if (typeof mounted === 'function') {
      childCleanups.push(mounted);
    } else {
      log.warn('工作区实例挂载失败（' + (child.path || '默认实例') + '）：' + (mounted && mounted.reason ? mounted.reason : '未知原因'));
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    disposeChildren();
  };
}
