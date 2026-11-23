// dsh-veneer —— 宿主半边入口（**只做装配，不写业务**）
//
// 与 dsh-milieu 的 A 方案同形：
//   · profile 里只有**一个 Loader 行**（`cordis.patch.yml`）；
//   · 本文件按范围规划，用 `ctx.plugin(workspacePlugin, childConfig)` 为每个工作区挂一个
//     **child fiber**。
//
// 工作区范围（R-13，v2）——按优先级：
//   ① `workspaces` 非空 → 只挂这些（现有行为）；
//   ② 否则 `workspaceRoot` 非空 → 单实例（现有行为）；
//   ③ 否则等工作区表 + 配置编辑器就绪（`ctx.inject`），用平台工作区表 ∩ 纳入策略：
//        · 去掉 `exclude`；
//        · `include` 非空 → 只留命中的（**include 为空才算"自动纳入新工作区"**）；
//        · `autoIncludeNew=false` 且 `include` 为空 → 什么都不挂（日志说明）。
//
// 为什么不是多行 profile：同一个包出现在多个 active Loader 行会被 client-modules 拒绝
//   （dsh-milieu 实测）；多实例只能在**一个 Loader 行内**做。
//
// v2 配置（`config/schema.js`）：
//   · `fixRequest` 是 **volatile** 字段：客户端写修复令牌后，Loader **不重载插件行**，
//     只发 `loader/volatile-update`（回调参数是**变更路径数组**，如 `['fixRequest']`）；
//   · 该事件只发给**插件行 fiber**（Loader 用 `owner.fiber === fiber` 过滤，父层 emit 子层收不到），
//     所以监听放在本文件；解析后经 `core/fix-bus.js` 广播给各工作区实例（实例按 root 过滤）。
//
// 非 Windows：挂载即报告 `unsupported` 并什么都不做（物化三项是 NTFS 语义）。
//
// 移除：卸载时 Cordis 会 dispose 本文件返回的清理函数；工作区里的报告文件不自动删
//   （用户自己创建的认知材料不该被插件悄悄删掉），要清就删 `review/veneer-state.json`。
import { planWorkspaces } from './core/plan.js';
import { workspacePlugin } from './core/workspace-instance.js';
import { createDsh } from './adapter/dsh.js';
import { createFs } from './adapter/fs.js';
import { attachBootstrapLog, sharedLog } from './log/shared.js';
import { guardSync } from './exception/guard.js';
import { CODES } from './exception/codes.js';
import { withDefaults, resolveVolatile } from './config/defaults.js';
import { parseFixRequest, publishFixRequest, fixRequestChanged } from './core/fix-bus.js';

export const name = 'dsh-veneer';
export const inject = [];

/** 再导出给 Cordis：Loader 用它校验配置、补默认值、把标记字段解析成 Volatile 引用。 */
export { Config } from './config/schema.js';

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

/** 比较用的路径键：斜杠归一 + 去尾斜杠 + 小写（与 `core/plan.js` 的 `samePath` 同一口径）。 */
export function pathKeyOf(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 配置里的字符串数组归一：只留非空字符串（去首尾空白；不改写用户写的路径）。 */
export function pathListOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * 平台工作区表 ∩ 纳入策略（纯函数；R-13 的唯一判据）。
 *
 * @param {object} input
 *   · `platformPaths` 平台工作区表（有序；可能含重复/非法项）
 *   · `include` / `exclude` 配置的字符串数组
 *   · `autoIncludeNew` 新工作区自动纳入（仅在 `include` 为空时有意义）
 * @returns {{managed:string[], skipped:Array<{path:string, reason:string}>}}
 *   `skipped[].reason`：`excluded` / `not-included` / `auto-include-off` / `duplicate`
 */
export function selectScope(input = {}) {
  const platformPaths = pathListOf(input.platformPaths);
  const include = pathListOf(input.include);
  const exclude = pathListOf(input.exclude);
  const includeKeys = new Set(include.map(pathKeyOf));
  const excludeKeys = new Set(exclude.map(pathKeyOf));
  const autoIncludeNew = input.autoIncludeNew !== false;
  const managed = [];
  const skipped = [];
  const seen = new Set();
  for (const rawPath of platformPaths) {
    const key = pathKeyOf(rawPath);
    if (!key) continue;
    if (seen.has(key)) {
      skipped.push({ path: rawPath, reason: 'duplicate' });
      continue;
    }
    seen.add(key);
    if (excludeKeys.has(key)) {
      skipped.push({ path: rawPath, reason: 'excluded' });
      continue;
    }
    if (includeKeys.size > 0) {
      if (includeKeys.has(key)) managed.push(rawPath);
      else skipped.push({ path: rawPath, reason: 'not-included' });
      continue;
    }
    if (!autoIncludeNew) {
      skipped.push({ path: rawPath, reason: 'auto-include-off' });
      continue;
    }
    managed.push(rawPath);
  }
  return { managed, skipped };
}

/**
 * 给一个工作区造 child 配置：顶层配置 + 固定 `workspaceRoot`，不递归 `workspaces`。
 * **保留 volatile 引用**（`withDefaults` 的 clone 不拷贝引用对象），实例才能读即时字段。
 */
function childConfigFor(rawConfig, path) {
  const base = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {};
  const config = withDefaults({ ...base, workspaces: [], workspaceRoot: path });
  delete config.workspaces;
  return config;
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
 * @returns {Function} 清理函数（dispose 每个 child fiber / volatile 监听）
 */
export function apply(ctx, config) {
  // 一个进程一个日志口（与工作区实例共用）；宿主 logger 有就同时转过去。
  const log = sharedLog(hostLoggerOf(ctx));
  const raw = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const cfg = withDefaults(raw);
  let childCleanups = [];
  let disposed = false;
  let scopeFiber = null;
  let volatileDispose = null;

  const disposeChildren = () => {
    const cleanups = childCleanups;
    childCleanups = [];
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* 清理失败不反噬宿主 */ }
    }
  };

  // 诊断（2026-11-22）：先挂**引导日志**（系统临时目录）。根解析出来后，实例会把它换成
  // `<工作区>/.dsh-veneer/veneer.log`，内存里的历史补写过去——所以"根没解析出来"也有现场。
  try { attachBootstrapLog(log, createFs()); } catch { /* 引导日志挂不上也不影响主流程 */ }

  const platform = typeof process !== 'undefined' && process.platform ? process.platform : '';
  log.event('host.mount', '宿主半边启动', { platform: platform || 'unknown' });
  if (platform !== 'win32') {
    log.warn('不是 Windows（' + (platform || 'unknown') + '）：物化三项是 NTFS 语义，本插件不做任何事');
    return () => {};
  }

  log.info('apply 进入：platform=' + platform + '，config=' + JSON.stringify(cfg));

  const packageDir = packageDirOfCtx(ctx);
  /** 工作区表注入回调只挂一次：服务可用性变化时 Cordis 可能重跑回调，重复挂会出双实例。 */
  let scopeMounted = false;

  /** 挂一批工作区（每个一个 child fiber）；返回挂上的个数。 */
  const mountAll = (entries) => {
    let mounted = 0;
    for (const entry of entries) {
      const mountedResult = guardSync('挂载工作区实例', () => mountChild(ctx, entry.config, packageDir), {
        log,
        blockedBy: 'host',
        code: CODES.HOST_CALL_FAILED,
      });
      if (typeof mountedResult === 'function') {
        childCleanups.push(mountedResult);
        mounted += 1;
      } else {
        log.warn('工作区实例挂载失败（' + (entry.path || '默认实例') + '）：'
          + (mountedResult && mountedResult.reason ? mountedResult.reason : '未知原因'));
      }
    }
    return mounted;
  };

  // ------------------------------------------------------------------
  // ① / ②：显式配置（workspaces 优先，其次 workspaceRoot）
  // ------------------------------------------------------------------
  const workspacesGiven = raw.workspaces !== undefined && raw.workspaces !== null
    && !(Array.isArray(raw.workspaces) && raw.workspaces.length === 0);
  const rootGiven = typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.trim() !== '';

  if (workspacesGiven || rootGiven) {
    const plan = planWorkspaces(raw);
    if (!plan.ok) {
      log.warn('工作区配置无效，本次不挂载任何实例：' + plan.errors.join('；'));
      return () => {};
    }
    log.event('host.plan', '规划完成：要挂 ' + plan.children.length + ' 个实例', { children: plan.children.length });
    log.info('规划完成：要挂 ' + plan.children.length + ' 个实例（'
      + plan.children.map((child) => child.path || '默认实例').join(' / ') + '）');
    mountAll(plan.children);
  } else {
    // ------------------------------------------------------------------
    // ③ 平台工作区表 ∩ 纳入策略（R-13）
    // ------------------------------------------------------------------
    const host = createDsh(ctx, packageDir);
    if (!host.canInject()) {
      log.warn('既没有 workspaces/workspaceRoot，宿主也没有 ctx.inject —— 拿不到平台工作区表，本次不挂实例');
      log.event('host.plan', '规划完成：要挂 0 个实例（无工作区来源）', { children: 0 });
    } else {
      scopeFiber = guardSync('等工作区范围服务', () => host.awaitScope((scope) => {
        if (disposed || scopeMounted) return;
        scopeMounted = true;
        const listed = scope.dsh && scope.dsh.workspace ? scope.dsh.workspace.listPaths() : null;
        if (!listed || listed.ok !== true) {
          log.warn('读平台工作区表失败，本次不挂实例：' + String((listed && listed.reason) || '宿主没有工作区表'));
          log.event('host.plan', '规划完成：要挂 0 个实例（工作区表不可用）', { children: 0 });
          return;
        }
        const selection = selectScope({
          platformPaths: listed.value,
          include: cfg.include,
          exclude: cfg.exclude,
          autoIncludeNew: cfg.autoIncludeNew,
        });
        for (const skipped of selection.skipped) {
          if (skipped.reason === 'duplicate') continue; // 平台表重复不必刷屏
          log.info('工作区不纳入（' + skipped.reason + '）：' + skipped.path);
        }
        if (selection.managed.length === 0) {
          if (!pathListOf(cfg.include).length && cfg.autoIncludeNew === false) {
            log.warn('autoIncludeNew=false 且 include 为空：平台工作区全都不纳入（要管哪个就写进 include 或 workspaceRoot）');
          } else {
            log.warn('平台工作区表按纳入策略过滤后为空：本次不挂实例');
          }
        }
        const entries = selection.managed.map((path) => ({ path, config: childConfigFor(raw, path) }));
        log.event('host.plan', '规划完成：要挂 ' + entries.length + ' 个实例', { children: entries.length });
        log.info('规划完成（平台工作区表 ∩ 纳入策略）：要挂 ' + entries.length + ' 个实例（'
          + (entries.map((entry) => entry.path).join(' / ') || '无') + '）');
        mountAll(entries);
      }), {
        log,
        blockedBy: 'host',
        code: CODES.HOST_CALL_FAILED,
      });
    }
  }

  // ------------------------------------------------------------------
  // 即时字段（Volatile）：修复令牌。事件只发给插件行 fiber，所以在**本层**监听。
  // 回调参数是**变更路径数组**（`string[][]`，如 `[['fixRequest']]`），不是新配置。
  // ------------------------------------------------------------------
  if (ctx && typeof ctx.on === 'function') {
    try {
      volatileDispose = ctx.on('loader/volatile-update', (changed) => {
        if (disposed) return;
        try {
          if (!fixRequestChanged(changed)) return;
          const rawToken = resolveVolatile(raw.fixRequest);
          if (typeof rawToken !== 'string' || !rawToken.trim()) return; // 清空：不是请求
          const parsed = parseFixRequest(rawToken);
          if (parsed.ok !== true) {
            log.warn('忽略非法的修复令牌：' + parsed.reason);
            return;
          }
          const published = publishFixRequest(parsed.value);
          if (!published.delivered) {
            log.warn('收到修复令牌，但本进程没有工作区实例接管（workspace=' + parsed.value.workspace + '）');
          } else {
            log.info('修复令牌已交给工作区实例（id=' + parsed.value.id + '，workspace=' + parsed.value.workspace
              + '，实例数=' + published.delivered + '）');
          }
        } catch (err) {
          log.warn('处理即时配置失败：' + String((err && err.message) || err));
        }
      });
    } catch (err) {
      log.warn('监听即时配置失败（客户端修复令牌不可用）：' + String((err && err.message) || err));
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof volatileDispose === 'function') {
      try { volatileDispose(); } catch { /* 取消监听失败不反噬宿主 */ }
      volatileDispose = null;
    }
    if (scopeFiber && typeof scopeFiber.dispose === 'function') {
      try { scopeFiber.dispose(); } catch { /* 同上 */ }
      scopeFiber = null;
    }
    disposeChildren();
  };
}
