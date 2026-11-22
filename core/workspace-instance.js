// dsh-veneer —— 一个工作区实例（**child fiber 的插件对象**）
//
// 一个工作区一份：配置、扫描、报告、手动入口都只碰自己的 root。
//   · 挂载时只注册 + 一次只读扫描（`scanOnMount`）；不在激活期建任何东西；
//   · **手动入口**：菜单项「检查沙箱物化」→ 界面写请求文件 → 这里轮询到就扫一次 → 写结论。
//     （插件包不带界面代码，所以桥走文件；见 core/bridge.js 的头注释）
//   · `turn/end` 之后**不自动重扫**：每轮多一次 PowerShell 不划算；重扫靠菜单。
import { createAclReader } from '../adapter/acl.js';
import { createFs } from '../adapter/fs.js';
import { createDsh, WORKSPACE_DEPENDENCIES } from '../adapter/dsh.js';
import { revealInExplorer, resolveInsideRoot } from '../adapter/desktop.js';
import { attachBootstrapLog, attachWorkspaceLog, sharedLog } from '../log/shared.js';
import { withDefaults } from '../config/defaults.js';
import { packageDirOf, scriptPathOf, INSPECT_SCRIPT } from '../core/command-path.js';
import { scanOnce, resolveRoot as resolveRootOf } from '../core/scan-once.js';
import { createScanner } from '../core/scanner.js';
import { createBridge } from '../core/bridge.js';
import { guardSync } from '../exception/guard.js';
import { CODES } from '../exception/codes.js';

/** 本文件的包根（没有宿主给的 packageDir 时兜底：<包根>/core/workspace-instance.js）。 */
const OWN_PACKAGE_DIR = packageDirOf(import.meta.url);

/**
 * child fiber 的插件：`name` / `inject` / `apply`。
 * 一个工作区一个实例；`apply` 返回的清理函数由 Cordis 的 fiber 调用。
 */
export const workspacePlugin = {
  name: 'dsh-veneer:workspace',
  // 依赖声明写在这里（宿主服务名只许出现在 adapter/）：实例 fiber 会等服务就绪才跑。
  inject: WORKSPACE_DEPENDENCIES,
  apply(ctx, rawConfig) {
    const cfg = withDefaults(rawConfig);
    const log = sharedLog((() => { try { return ctx && ctx.logger; } catch { return null; } })());
    const fs = createFs();
    let disposed = false;
    let fallbackTimer = null;
    let fiber = null;
    let bridge = null;
    let watch = null;

    const packageDir = (() => {
      try { return ctx && typeof ctx.packageDir === 'string' ? ctx.packageDir : ''; } catch { return ''; }
    })() || OWN_PACKAGE_DIR;

    const host = createDsh(ctx, packageDir);
    log.event('instance.mount', '工作区实例启动', { scanOnMount: !!cfg.scanOnMount, bridge: !!cfg.bridge });
    log.info('实例 apply 进入：scanOnMount=' + cfg.scanOnMount + '，bridge=' + cfg.bridge
      + '，workspaceRoot=' + JSON.stringify(cfg.workspaceRoot || ''));
    const scanner = createScanner({
      acl: createAclReader({
        scriptPath: scriptPathOf(packageDir, INSPECT_SCRIPT),
        timeoutMs: cfg.scanTimeoutMs,
      }),
      fs,
      commandPath: scriptPathOf(packageDir),
      listLimit: cfg.listLimit,
      cfg,
      log,
    });

    /** 一次扫描（挂载时用）。 */
    const once = (h, source) => {
      if (disposed) return;
      log.event('scan.started', '开始扫描（' + source + '）', { source });
      guardSync('挂载扫描', () => {
        scanOnce({ host: h, fs, timeoutMs: cfg.scanTimeoutMs, listLimit: cfg.listLimit }, cfg)
          .then((result) => {
            if (!result || result.ok !== true) {
              const reason = (result && result.reason) || '未知原因';
              log.event('scan.failed', '扫描没完成（' + source + '）：' + reason, { reason, source });
              return;
            }
            log.event('scan.done', '扫描完成（' + source + '）：' + result.value.summary, {
              source,
              status: result.value.status || 'unknown',
              written: !!result.value.written,
              reportPath: result.value.reportPath || '',
            });
            if (result.value.command) log.info('需要修的话，在提权的 PowerShell 里跑：' + result.value.command);
          })
          .catch((err) => {
            const reason = String((err && err.message) || err);
            log.event('scan.failed', '扫描失败（' + source + '）：' + reason, { reason, source });
          });
        return true;
      }, { log, blockedBy: 'host', code: CODES.HOST_CALL_FAILED });
    };

    /** 起手动入口的桥（拿到工作区根之后）。 */
    const startBridge = (h, source) => {
      if (disposed || bridge) return;
      const resolved = resolveRootOf(h, cfg.workspaceRoot);
      if (!resolved.ok) {
        log.event('bridge.failed', '手动入口没起来（' + source + '）：' + resolved.reason, { reason: resolved.reason, source });
        return;
      }
      // 根已经知道：日志从现在起写进工作区（内存里之前的事件会补写过去）。
      attachWorkspaceLog(log, fs, resolved.value);
      bridge = createBridge({
        fs,
        root: resolved.value,
        scanner,
        log,
        pollMs: cfg.bridgePollMs,
        onOpen: (relative) => {
          const target = resolveInsideRoot(resolved.value, relative);
          if (!target) return { ok: false, reason: '拒绝打开工作区外的路径' };
          return revealInExplorer(target);
        },
      });
      try { fs.mkdirp(bridge.paths.dir); } catch (err) { log.warn('桥目录建不了：' + String((err && err.message) || err)); }
      bridge.start();
      watch = fs.watchDir(bridge.paths.dir, () => { void bridge.tick(); });
      if (!watch.ok) log.warn('桥不能用文件监视（' + watch.reason + '），改为只按 ' + cfg.bridgePollMs + ' ms 轮询');
      log.event('bridge.started', '手动入口已就绪（' + source + '）', { dir: bridge.paths.dir, source });
    };

    if (cfg.scanOnMount || cfg.bridge) {
      // 引导日志：根还没解析出来时，至少能看到"实例起来了、卡在哪一步"。
      attachBootstrapLog(log, fs);
      // 实例 fiber 已经把"工作区服务"声明成依赖，服务通常此刻就绪：先**同步**试一次根，
      // 省掉等注入回调的延迟；失败也要落到日志（不能像 0.2.x 那样静默）。
      const early = resolveRootOf(host, cfg.workspaceRoot);
      if (early.ok) {
        log.event('root.resolved', '工作区根已解析：' + early.value, { root: early.value });
        if (cfg.scanOnMount) once(host, 'mount');
        if (cfg.bridge) startBridge(host, 'mount');
      } else {
        log.event('root.resolve.failed', '工作区根没解析出来：' + early.reason, { reason: early.reason });
        const canInject = host.canInject();
        log.event('host.inject.waiting', '等工作区服务就绪', { canInject });
        if (canInject) {
          // **回调拿到的是适配层对象，不是原始 ctx**（`adapter/dsh.js` 的 `awaitWorkspace` 已经包过一次）。
          // 再 `createDsh(child)` 就是二次包装：适配层对象上没有宿主服务属性 → 解析不到工作区根 →
          // 扫描与手动入口全部静默不启动（2026-11-20 真机踩到，v0.2.0 的面板因此从没出现过）。
          fiber = guardSync('等工作区服务', () => host.awaitWorkspace((child) => {
            const resolved = resolveRootOf(child, cfg.workspaceRoot);
            if (resolved.ok) attachWorkspaceLog(log, fs, resolved.value);
            log.event('host.inject.ready', '注入回调已触发（工作区服务就绪）', {});
            if (cfg.scanOnMount) once(child, 'inject');
            if (cfg.bridge) startBridge(child, 'inject');
          }), { log, blockedBy: 'host', code: CODES.HOST_CALL_FAILED });
          // 兜底：服务始终没就绪时，用父 ctx 试一次（同样只读）。
          try {
            fallbackTimer = setTimeout(() => {
              if (disposed) return;
              log.event('host.inject.fallback', '兜底定时器触发：用父 ctx 再试一次', { waitedMs: cfg.readyWaitMs });
              if (cfg.scanOnMount) once(createDsh(ctx, packageDir), 'fallback');
              if (cfg.bridge) startBridge(createDsh(ctx, packageDir), 'fallback');
            }, cfg.readyWaitMs);
            if (fallbackTimer && typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
          } catch { /* 没有 setTimeout 的宿主：不兜底 */ }
        } else {
          if (cfg.scanOnMount) once(host, 'mount');
          if (cfg.bridge) startBridge(host, 'mount');
        }
      }
    }

    return () => {
      disposed = true;
      if (fallbackTimer !== null) {
        try { clearTimeout(fallbackTimer); } catch { /* 清理失败不反噬宿主 */ }
        fallbackTimer = null;
      }
      if (watch && watch.ok) {
        try { watch.close(); } catch { /* 同上 */ }
        watch = null;
      }
      if (bridge) {
        try { bridge.stop(); } catch { /* 同上 */ }
        bridge = null;
      }
      try { if (fiber && typeof fiber.dispose === 'function') fiber.dispose(); } catch { /* 同上 */ }
    };
  },
};
