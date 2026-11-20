// dsh-veneer —— 一次工作区实例（**child fiber 的插件对象**）
//
// 一个工作区一份：配置、扫描、报告都只碰自己的 root。
//   · 挂载时**只注册 + 只做一次只读扫描**（如果 `scanOnMount`）；不在激活期建任何东西；
//   · `turn/end` 之后**不做自动重扫**：那会让每轮对话都多起一次 PowerShell，代价与收益不成比例
//     （详见 README "为什么不在每轮之后重扫"）。重扫走手动入口；
//   · 服务就绪用 `ctx.inject`；等不到就用父 ctx 兜一次（与 dsh-milieu 的同一手法，见其 boot.js）。
import { createAclReader } from '../adapter/acl.js';
import { createFs } from '../adapter/fs.js';
import { createDsh, WORKSPACE_DEPENDENCIES } from '../adapter/dsh.js';
import { createLog } from '../log/logger.js';
import { withDefaults } from '../config/defaults.js';
import { packageDirOf, scriptPathOf, INSPECT_SCRIPT } from '../core/command-path.js';
import { runScan } from '../core/scan.js';
import { guardSync } from '../exception/guard.js';
import { CODES } from '../exception/codes.js';

/** 本文件的包根（没有宿主给的 packageDir 时兜底：<包根>/core/workspace-instance.js）。 */
const OWN_PACKAGE_DIR = packageDirOf(import.meta.url);

/**
 * 解析工作区根：配置里写死的优先；否则问平台（只有一个就用它，多个按平台顺序第一个）。
 * @returns {{ok:true, value:string}|{ok:false, reason:string, blockedBy:string}}
 */
export function resolveRoot(host, configured) {
  const fixed = typeof configured === 'string' ? configured.trim() : '';
  if (fixed) return { ok: true, value: fixed };
  const listed = host && host.workspace ? host.workspace.listPaths() : null;
  if (listed && listed.ok && Array.isArray(listed.value) && listed.value.length) {
    return { ok: true, value: listed.value[0] };
  }
  return {
    ok: false,
    reason: '没有工作区根：配置没给 workspaceRoot，平台工作区表也拿不到',
    blockedBy: 'host',
  };
}

/**
 * 一次扫描（入口与测试共用的口子）。
 * @param {{host:object, fs:object, log:object, packageDir?:string, execFileImpl?:Function}} deps
 * @param {object} cfg 已归并配置
 * @param {string} [rootOverride] 指定根（测试用）
 */
export async function scanOnce(deps, cfg, rootOverride) {
  const host = deps.host;
  const root = rootOverride || cfg.workspaceRoot;
  const resolved = resolveRoot(host, root);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, blockedBy: resolved.blockedBy };

  const packageDir = deps.packageDir || host.packageDir || OWN_PACKAGE_DIR;
  const acl = createAclReader({
    scriptPath: scriptPathOf(packageDir, INSPECT_SCRIPT),
    execFileImpl: deps.execFileImpl,
    timeoutMs: cfg.scanTimeoutMs,
  });
  return runScan({
    acl,
    fs: deps.fs,
    commandPath: scriptPathOf(packageDir),
    listLimit: cfg.listLimit,
  }, { root: resolved.value, reportPath: cfg.reportPath });
}

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
    const log = createLog((() => { try { return ctx && ctx.logger; } catch { return null; } })());
    const fs = createFs();
    let disposed = false;
    let fallbackTimer = null;
    let fiber = null;

    const once = (host, source) => {
      if (disposed) return;
      const run = guardSync('挂载扫描', () => {
        scanOnce({ host, fs }, cfg)
          .then((result) => {
            if (!result || result.ok !== true) {
              log.warn('扫描没完成（' + source + '）：' + (result && result.reason ? result.reason : '未知原因'));
              return;
            }
            log.info('扫描完成（' + source + '）：' + result.value.summary
              + (result.value.written ? '；报告已更新：' + result.value.reportPath : '；报告没变'));
            if (result.value.command) log.info('需要修的话，在提权的 PowerShell 里跑：' + result.value.command);
          })
          .catch((err) => {
            log.warn('扫描失败（' + source + '）：' + String((err && err.message) || err));
          });
        return true;
      }, { log, blockedBy: 'host', code: CODES.HOST_CALL_FAILED });
      return run;
    };

    if (cfg.scanOnMount) {
      const base = createDsh(ctx);
      if (base.canInject()) {
        fiber = guardSync('等工作区服务', () => {
          return base.awaitWorkspace((sub) => once(createDsh(sub), 'inject'));
        }, { log, blockedBy: 'host', code: CODES.HOST_CALL_FAILED });
        // 兜底：服务始终没就绪时，用父 ctx 试一次（同样只读）。
        try {
          fallbackTimer = setTimeout(() => {
            if (!disposed) once(createDsh(ctx), 'fallback');
          }, cfg.readyWaitMs);
          if (fallbackTimer && typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
        } catch { /* 没有 setTimeout 的宿主：不兜底 */ }
      } else {
        once(base, 'mount');
      }
    }

    return () => {
      disposed = true;
      if (fallbackTimer !== null) {
        try { clearTimeout(fallbackTimer); } catch { /* 清理失败不反噬宿主 */ }
        fallbackTimer = null;
      }
      try { if (fiber && typeof fiber.dispose === 'function') fiber.dispose(); } catch { /* 同上 */ }
    };
  },
};
