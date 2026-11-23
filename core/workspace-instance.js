// dsh-veneer —— 一个工作区实例（**child fiber 的插件对象**）
//
// 一个工作区一份：配置、扫描、报告、手动入口、会话检查、修复都只碰自己的 root。
//   · 挂载时只注册 + 一次只读扫描（`scanOnMount`）；不在激活期建任何东西；
//   · **手动入口**：菜单项「检查沙箱物化」→ 界面写请求文件 → 这里轮询到就扫一次 → 写结论。
//     （插件包不带界面代码，所以桥走文件；见 core/bridge.js 的头注释）
//   · **v2 · 会话检查（R-12）**：订阅持久会话事件；**首条"人"的消息**（`user/message` 且
//     `data.source.kind === 'user'`）命中本工作区时，异步排一次扫描 → 有缺项且 `autoPrompt`
//     就弹宿主原生确认框：**现在修复 / 以后再说**。"取消后续检查本工作区"不在这里，
//     它在配置页的勾选项里（2026-11-23 主人定：弹窗不写配置）。
//   · **v2 · 修复令牌（B 通道）**：`fixRequest` 是 volatile 配置；`index.js` 收到
//     `loader/volatile-update` 后经 `core/fix-bus.js` 把令牌交给**本实例**（按 root 过滤、
//     同一 id 只执行一次），然后跑 `core/fix.js`（UAC 提权）→ 写结果 → 重扫。
//   · `turn/end` 之后**不自动重扫**：每轮多一次 PowerShell 不划算；重扫靠菜单 / 会话检查 / 修复后。
//
// 测试接缝（`applyChild(ctx, rawConfig, deps)`，`workspacePlugin.apply` 只是薄一层）：
//   deps 可注入 `fs` / `scanOnceImpl` / `runFixImpl` / `askFixImpl` / `now`，
//   让离线测试不碰真 PowerShell、真 UAC（产品路径用默认实现）。
import { createAclReader } from '../adapter/acl.js';
import { createFs } from '../adapter/fs.js';
import { createDsh, WORKSPACE_DEPENDENCIES } from '../adapter/dsh.js';
import { revealInExplorer, resolveInsideRoot } from '../adapter/desktop.js';
import { attachBootstrapLog, dedupeSink } from '../log/shared.js';
import { createLog } from '../log/logger.js';
import { createFileSink } from '../log/file-sink.js';
import { withDefaults } from '../config/defaults.js';
import { packageDirOf, scriptPathOf, INSPECT_SCRIPT } from '../core/command-path.js';
import { scanOnce, resolveRoot as resolveRootOf } from '../core/scan-once.js';
import { createScanner } from '../core/scanner.js';
import { createBridge } from '../core/bridge.js';
import { samePath } from '../core/plan.js';
import { joinPath } from '../core/persist.js';
import {
  runFix, writeFixResult, missingObjectsOf, newFixId, fixPathsOf,
} from '../core/fix.js';
import { subscribeFixRequests } from '../core/fix-bus.js';
import { enqueueGlobalScan, forgetWorkspace, reportWorkspaceScan } from '../core/aggregate.js';
import { askFix } from '../core/ask-native.js';
import { guardSync, reasonOf } from '../exception/guard.js';
import { CODES } from '../exception/codes.js';

/** 本文件的包根（没有宿主给的 packageDir 时兜底：<包根>/core/workspace-instance.js）。 */
const OWN_PACKAGE_DIR = packageDirOf(import.meta.url);

/** 扫描来源词（日志里按它区分触发者）。 */
export const SESSION_SCAN_SOURCE = 'session-first-message';
export const POST_FIX_SCAN_SOURCE = 'after-fix';

/**
 * 这条事件是不是**人**发的首条消息？（R-12 的触发判据）
 *
 * 只看 `user/message` 不够：插件自己发的阅读请求（如 dsh-milieu 的预加载）也是 `user/message`。
 * 平台用 `data.source.kind === 'user'` 标"人"，与 dsh-milieu 的 `isHumanMessage` 同一判据。
 * @param {object} event
 */
export function isHumanUserMessage(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type !== 'user/message') return false;
  const source = event.data && typeof event.data === 'object' ? event.data.source : null;
  return !!source && source.kind === 'user';
}

/**
 * 会话所属工作区（宿主两种拼法都认；原样透传，不改 session 形状）。
 * @param {object} session
 */
export function sessionCwdOf(session) {
  if (!session || typeof session !== 'object') return '';
  const header = session.header && typeof session.header === 'object' ? session.header : null;
  const fromHeader = header && typeof header.cwd === 'string' ? header.cwd : '';
  if (fromHeader) return fromHeader;
  return typeof session.cwd === 'string' ? session.cwd : '';
}

/** 一个工作区实例的装配（供 `workspacePlugin.apply` 调用；离线测试直接调它）。 */
export function applyChild(ctx, rawConfig, deps = {}) {
  const cfg = withDefaults(rawConfig);
  // **每个实例一个日志口**（2026-11-23，0.4.5）：以前共用进程级单例 + 单一文件 sink，
  // 多工作区共存时每个实例 `attachFileSink` 都会把 sink 换成自己的 → 事件全写到"最后挂的那个
  // 工作区"的日志里。现在各写各的：`<本工作区>/.dsh-veneer/veneer.log`。
  const log = createLog((() => { try { return ctx && ctx.logger; } catch { return null; } })(), {});
  const fs = deps.fs || createFs();

  /** 本实例自己的文件日志（只写本工作区；重复挂同一路径由 logger 自己短路）。 */
  const attachOwnWorkspaceLog = (root) => {
    const base = String(root || '');
    if (!base) return false;
    try {
      const sink = createFileSink({
        fs,
        dir: joinPath(base, '.dsh-veneer'),
        onFailure: (reason) => {
          try { log.warn('日志文件写不进去（' + base + '）：' + reason); } catch { /* 报告失败就算了 */ }
        },
      });
      return log.attachFileSink(dedupeSink(sink));
    } catch {
      return false;
    }
  };
  const scanOnceImpl = typeof deps.scanOnceImpl === 'function' ? deps.scanOnceImpl : scanOnce;
  const runFixImpl = typeof deps.runFixImpl === 'function' ? deps.runFixImpl : runFix;
  const askFixImpl = typeof deps.askFixImpl === 'function' ? deps.askFixImpl : askFix;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  let disposed = false;
  let fallbackTimer = null;
  let fiber = null;
  let bridge = null;
  let watch = null;

  /** 当前解析出来的工作区根（延迟解析：挂载时可能还没有平台服务）。 */
  let currentRoot = '';
  /** 已登记到修复总线的 root（换 root 时重登）。 */
  let registeredRoot = '';
  let unregisterFix = null;
  let disposeSession = null;
  /** 同一会话只检查一次（内存；重启后重新计）。 */
  const seenSessionIds = new Set();
  /** 同一修复 id 只执行一次（内存；客户端可能重复保存同一个令牌）。 */
  const handledFixIds = new Set();
  /** 扫描 / 修复各自串行（同一工作区同一时刻最多一个）。 */
  let scanChain = Promise.resolve();
  let fixChain = Promise.resolve();

  const packageDir = (() => {
    try { return ctx && typeof ctx.packageDir === 'string' ? ctx.packageDir : ''; } catch { return ''; }
  })() || OWN_PACKAGE_DIR;

  const host = createDsh(ctx, packageDir);
  log.event('instance.mount', '工作区实例启动', { scanOnMount: !!cfg.scanOnMount, bridge: !!cfg.bridge });
  log.info('实例 apply 进入：scanOnMount=' + cfg.scanOnMount + '，bridge=' + cfg.bridge
    + '，sessionCheck=' + cfg.sessionCheck + '，autoPrompt=' + cfg.autoPrompt
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

  // ------------------------------------------------------------------
  // 根 / 修复总线
  // ------------------------------------------------------------------
  /** 当前 root（没有就按配置/平台再解析一次）；解析不到返回空串。 */
  const rootNow = () => {
    if (currentRoot) return currentRoot;
    const resolved = resolveRootOf(host, cfg.workspaceRoot);
    if (resolved.ok) currentRoot = resolved.value;
    return currentRoot;
  };

  /** 根确定后登记到修复总线（令牌由 index 解析、这里按 root 过滤）。 */
  const ensureFixRegistration = () => {
    const root = rootNow();
    if (!root || registeredRoot === root) return root;
    if (typeof unregisterFix === 'function') {
      try { unregisterFix(); } catch { /* 退订失败不影响重登 */ }
      unregisterFix = null;
    }
    registeredRoot = root;
    unregisterFix = subscribeFixRequests((request) => { void enqueueFixRequest(request); });
    return root;
  };

  // ------------------------------------------------------------------
  // 扫描（串行；复用同一入口）
  // ------------------------------------------------------------------
  /**
   * 排一次扫描（串行、异步；**不阻塞调用方**）。
   * @param {object} h 宿主能力对象
   * @param {string} source 触发来源（日志/报告用）
   * @param {(result:object|null) => void} [onDone] 完成后回调（异常不外溢）
   * @returns {Promise<object|null>}
   */
  const enqueueScan = (h, source, onDone) => {
    if (disposed) return scanChain;
    const run = () => enqueueGlobalScan(() => new Promise((resolve) => {
      if (disposed) { resolve(null); return; }
      log.event('scan.started', '开始扫描（' + source + '）', { source });
      guardSync('扫描', () => {
        scanOnceImpl({ host: h, fs, timeoutMs: cfg.scanTimeoutMs, listLimit: cfg.listLimit }, cfg)
          .then((result) => {
            if (!result || result.ok !== true) {
              const reason = (result && result.reason) || '未知原因';
              log.event('scan.failed', '扫描没完成（' + source + '）：' + reason, { reason, source });
              // 失败也要进汇总：面板要能显示"这个工作区扫失败了/超时了"。
              reportWorkspaceScan({
                root: rootNow(), status: 'failed', reason, source,
                scannedAt: new Date(now()).toISOString(),
              });
              resolve(null);
              return;
            }
            log.event('scan.done', '扫描完成（' + source + '）：' + result.value.summary, {
              source,
              status: result.value.status || 'unknown',
              written: !!result.value.written,
              reportPath: result.value.reportPath || '',
            });
            // 汇总（多工作区展示用）：状态 + 计数 + 时间 + 失败/根归宿主的说明。
            reportWorkspaceScan({
              root: rootNow(),
              status: result.value.status || 'unknown',
              counts: result.value.counts || {},
              scannedAt: new Date(now()).toISOString(),
              source,
              reason: Array.isArray(result.value.rootMissing) && result.value.rootMissing.length
                ? '根上没有物化三项（属于宿主，本插件不动手）'
                : '',
            });
            if (result.value.command) log.info('需要修的话，在提权的 PowerShell 里跑：' + result.value.command);
            resolve(result);
          })
          .catch((err) => {
            const reason = String((err && err.message) || err);
            log.event('scan.failed', '扫描失败（' + source + '）：' + reason, { reason, source });
            reportWorkspaceScan({
              root: rootNow(), status: 'failed', reason, source,
              scannedAt: new Date(now()).toISOString(),
            });
            resolve(null);
          });
        return true;
      }, { log, blockedBy: 'host', code: CODES.HOST_CALL_FAILED });
    }));
    const next = scanChain.then(run, run).then((value) => {
      try {
        if (typeof onDone === 'function') onDone(value);
      } catch (err) {
        log.warn('扫描完成回调失败：' + reasonOf(err));
      }
      return value;
    });
    scanChain = next.then(() => undefined, () => undefined);
    return next;
  };

  // ------------------------------------------------------------------
  // 修复（串行；令牌 + 弹窗"去修复"共用）
  // ------------------------------------------------------------------
  /** 读当前报告（弹出"去修复"要全部缺项对象）。 */
  const readReport = () => {
    const root = rootNow();
    if (!root) return { ok: false, reason: '工作区根还没解析出来' };
    const path = joinPath(root, cfg.reportPath);
    try {
      const parsed = JSON.parse(fs.readText(path));
      return { ok: true, value: parsed };
    } catch (err) {
      return { ok: false, reason: '读不到当前报告：' + reasonOf(err) };
    }
  };

  /** 排一次修复（串行；异常不外溢）。 */
  const enqueueFixRequest = (request) => {
    const run = () => executeFixRequest(request);
    const task = fixChain.then(run, run).catch((err) => {
      log.warn('修复任务异常：' + reasonOf(err));
      return { ok: false, reason: '修复任务异常：' + reasonOf(err) };
    });
    fixChain = task.then(() => undefined, () => undefined);
    return task;
  };

  /** 执行一次修复请求（令牌或弹窗"去修复"）。 */
  const executeFixRequest = async (request) => {
    if (disposed) return { ok: false, reason: '实例已卸载，忽略修复请求' };
    const id = request && typeof request.id === 'string' ? request.id.trim() : '';
    if (!id) {
      log.warn('忽略缺 id 的修复请求（无法去重）');
      return { ok: false, reason: '修复请求缺 id' };
    }
    if (handledFixIds.has(id)) {
      log.info('忽略重复的修复请求（id=' + id + '，同一 id 只执行一次）');
      return { ok: true, skipped: true, reason: '同一 id 已执行过' };
    }
    const root = ensureFixRegistration();
    if (!root) {
      log.warn('收到修复请求，但工作区根还没解析出来（忽略）');
      return { ok: false, reason: '工作区根还没解析出来' };
    }
    const workspace = request && typeof request.workspace === 'string' ? request.workspace : '';
    if (!samePath(workspace, root)) {
      // 多实例时每个实例都会看到这条广播：非本工作区的请求按"他人的事"忽略。
      log.warn('忽略修复请求：它属于别的工作区（' + workspace + '）');
      return { ok: false, reason: '不是本工作区' };
    }
    handledFixIds.add(id);
    const report = readReport();
    let objects = request && Array.isArray(request.objects) && request.objects.length ? request.objects : null;
    if (!objects) {
      if (report.ok !== true) {
        log.warn('修复跳过：' + report.reason);
        return { ok: false, reason: report.reason };
      }
      objects = missingObjectsOf(report.value);
    }
    if (!objects.length) {
      log.info('修复请求里没有要修的对象（当前报告里已无缺项）');
      return { ok: true, fixed: 0, success: 0, total: 0 };
    }
    log.info('开始修复 ' + objects.length + ' 个对象（id=' + id + '；需要 UAC 授权）');
    const result = await runFixImpl({
      fs,
      root,
      objects,
      id,
      report: report.ok === true ? report.value : undefined,
      reportPath: joinPath(root, cfg.reportPath),
      packageDir,
      now,
      log,
    });
    if (disposed) return result;
    // 兜底：runFix 在提权前就失败（校验/写文件）时也可能没有结果文件——面板按 id 等它。
    const paths = fixPathsOf(root);
    let resultExists = false;
    try { resultExists = typeof fs.exists === 'function' ? fs.exists(paths.resultPath) : false; } catch { resultExists = false; }
    if (!resultExists) {
      const failures = objects.map((entry) => ({
        path: String((entry && entry.path) || ''),
        items: Array.isArray(entry && entry.items) ? entry.items : [],
        reason: (result && result.reason) || '修复未执行',
      }));
      writeFixResult(fs, root, {
        id,
        total: objects.length,
        success: 0,
        failed: objects.length,
        failures,
        cancelled: !!(result && result.cancelled),
        reason: (result && result.reason) || '修复未执行',
      });
    }
    if (result && result.ok === true) {
      log.info('修复完成（id=' + id + '）：成功 ' + (result.success ?? result.fixed ?? 0)
        + ' / ' + (result.total ?? objects.length));
    } else {
      log.warn('修复未完成（id=' + id + '）：' + String((result && result.reason) || '未知原因'));
    }
    // 不变量：修复结束必须重扫一次（用结果更新状态，不以退出码为唯一依据）。
    enqueueScan(host, POST_FIX_SCAN_SOURCE);
    return result;
  };

  /** 弹窗"去修复"：修当前报告里的**全部**缺项对象。 */
  const fixAllMissing = async (source) => {
    const root = rootNow();
    if (!root) {
      log.warn('修复跳过：工作区根还没解析出来');
      return { ok: false, reason: '工作区根还没解析出来' };
    }
    const report = readReport();
    if (report.ok !== true) {
      log.warn('修复跳过：' + report.reason);
      return { ok: false, reason: report.reason };
    }
    const objects = missingObjectsOf(report.value);
    if (!objects.length) {
      log.info('修复跳过：当前报告里没有缺项（' + source + '）');
      return { ok: true, fixed: 0, success: 0, total: 0 };
    }
    return enqueueFixRequest({ id: newFixId(), workspace: root, objects });
  };

  // ------------------------------------------------------------------
  // "取消后续检查本工作区"**不在弹窗里**（2026-11-23 主人定）：它改成配置页的一个勾选项，
  // 由用户明确勾选并保存（写 `workspaces`）。弹窗因此只问"现在修复吗？"，关窗永远只是"以后再说"，
  // 不会再因为误关窗口改配置。宿主侧不需要 `configEditor`（本文件不再改配置）。
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // 会话检查（R-12）：首条"人"的消息 → 异步扫描 → （可选）原生确认框
  // ------------------------------------------------------------------
  /** 扫完后的后续：有缺项且 autoPrompt → 弹原生确认框。 */
  const afterSessionScan = async (result) => {
    if (disposed || !cfg.autoPrompt) return;
    if (!result || result.ok !== true) return;
    const counts = (result.value && result.value.counts) || {};
    const missing = Number(counts.missing) || 0;
    if (missing <= 0) return;
    const root = rootNow();
    if (!root) return;
    log.info('会话检查：发现 ' + missing + ' 个缺项对象，弹原生确认框');
    const answer = await askFixImpl({
      root,
      missing,
      packageDir,
      log,
      execImpl: deps.execImpl,
      execFileImpl: deps.execFileImpl,
    });
    if (disposed) return;
    if (!answer || answer.ok !== true) {
      log.warn('原生确认框没有给出答案（' + String((answer && answer.reason) || '未知原因') + '），本次不处理');
      return;
    }
    if (answer.value === 'later') {
      log.info('会话检查：用户选择「以后再说」');
      return;
    }
    if (answer.value === 'fix') {
      log.info('会话检查：用户选择「去修复」');
      await fixAllMissing('dialog');
    }
  };

  /** 会话事件入口（异常不抛回宿主事件总线）。 */
  const handleSessionEvent = (event, session) => {
    try {
      if (disposed || !cfg.sessionCheck) return;
      if (!isHumanUserMessage(event)) return;
      const sessionId = (event && typeof event.sessionId === 'string' ? event.sessionId : '')
        || (session && typeof session.id === 'string' ? session.id : '');
      if (!sessionId || seenSessionIds.has(sessionId)) return;
      const cwd = sessionCwdOf(session);
      const root = rootNow();
      if (!root) {
        log.info('会话检查跳过：工作区根还没解析出来');
        return;
      }
      if (!cwd) {
        log.info('会话检查跳过：会话没有工作区信息（' + sessionId + '）');
        return;
      }
      if (!samePath(cwd, root)) {
        log.info('会话检查跳过：会话在别的工作区（' + cwd + '）');
        return;
      }
      seenSessionIds.add(sessionId);
      log.info('会话首条人类消息：排一次异步扫描（' + sessionId + '）');
      // **不阻塞事件回调**：扫描排进串行链，失败只进日志。
      enqueueScan(host, SESSION_SCAN_SOURCE, (result) => { void afterSessionScan(result); });
    } catch (err) {
      log.warn('处理会话事件失败：' + reasonOf(err));
    }
  };

  // ------------------------------------------------------------------
  // 订阅：会话事件 + 修复令牌
  // ------------------------------------------------------------------
  if (cfg.sessionCheck) {
    try {
      disposeSession = host.onSessionEvent(handleSessionEvent);
    } catch (err) {
      log.warn('订阅会话事件失败（会话检查停用）：' + reasonOf(err));
    }
  }
  // 修复令牌：Loader 的 `loader/volatile-update` 只发给插件行 fiber（父层 emit、子层收不到），
  // 所以由 `index.js` 监听并解析，经 `core/fix-bus.js` 广播到这里；本实例按 root 过滤。
  // 一开始就登记：即使 root 还要等注入，令牌到达时 `ensureFixRegistration` 会再试。
  ensureFixRegistration();

  // ------------------------------------------------------------------
  // 挂载扫描 / 手动入口（原有行为不动）
  // ------------------------------------------------------------------
  /** 起手动入口的桥（拿到工作区根之后）。 */
  const startBridge = (h, source) => {
    if (disposed || bridge) return;
    const resolved = resolveRootOf(h, cfg.workspaceRoot);
    if (!resolved.ok) {
      log.event('bridge.failed', '手动入口没起来（' + source + '）：' + resolved.reason, { reason: resolved.reason, source });
      return;
    }
    // 根已经知道：日志从现在起写进工作区（内存里之前的事件会补写过去）。
    attachOwnWorkspaceLog(resolved.value);
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
      currentRoot = early.value;
      ensureFixRegistration();
      log.event('root.resolved', '工作区根已解析：' + early.value, { root: early.value });
      if (cfg.scanOnMount) enqueueScan(host, 'mount');
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
          if (resolved.ok) {
            currentRoot = resolved.value;
            ensureFixRegistration();
            attachOwnWorkspaceLog(resolved.value);
          }
          log.event('host.inject.ready', '注入回调已触发（工作区服务就绪）', {});
          if (cfg.scanOnMount) enqueueScan(child, 'inject');
          if (cfg.bridge) startBridge(child, 'inject');
        }), { log, blockedBy: 'host', code: CODES.HOST_CALL_FAILED });
        // 兜底：服务始终没就绪时，用父 ctx 试一次（同样只读）。
        try {
          fallbackTimer = setTimeout(() => {
            if (disposed) return;
            log.event('host.inject.fallback', '兜底定时器触发：用父 ctx 再试一次', { waitedMs: cfg.readyWaitMs });
            if (cfg.scanOnMount) enqueueScan(createDsh(ctx, packageDir), 'fallback');
            if (cfg.bridge) startBridge(createDsh(ctx, packageDir), 'fallback');
          }, cfg.readyWaitMs);
          if (fallbackTimer && typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
        } catch { /* 没有 setTimeout 的宿主：不兜底 */ }
      } else {
        if (cfg.scanOnMount) enqueueScan(host, 'mount');
        if (cfg.bridge) startBridge(host, 'mount');
      }
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    // 汇总里去掉本工作区（实例卸载后它不再被管；面板不应再显示旧状态）。
    forgetWorkspace(rootNow());
    if (typeof unregisterFix === 'function') {
      try { unregisterFix(); } catch { /* 退订失败不反噬宿主 */ }
      unregisterFix = null;
    }
    if (typeof disposeSession === 'function') {
      try { disposeSession(); } catch { /* 同上 */ }
      disposeSession = null;
    }
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
    return applyChild(ctx, rawConfig);
  },
};

