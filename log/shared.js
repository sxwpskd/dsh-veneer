// dsh-veneer —— 日志装配（把"一个日志口 + 文件 sink"接到宿主半边）
//
// 为什么单独一个文件：`log/logger.js` 是纯门面（不碰文件系统），`index.js` 与
// `core/workspace-instance.js` 都需要**同一个**日志口（一个 bootId、一份内存环），
// 而文件 sink 要等"工作区根"解析出来才知道写哪里。装配逻辑放这里，两个调用点共用。
//
// 三条硬规则（2026-11-22 定：诊断能力必须先按脚手架落地，不许用临时文件糊过去）：
//   ① 一个进程一个日志口：`sharedLog(hostLogger)` 第一次造，之后复用；
//   ② 根解析成功 → 日志写 `<工作区>/.dsh-veneer/veneer.log`（JSONL、1 MiB 轮转、保留 2 份）；
//   ③ 根还解析不出来 → 先挂**引导日志** `<临时目录>/dsh-veneer-bootstrap.log`，
//      等根出来再换成工作区文件（内存里的历史会补写进新 sink，不丢前面的现场）。
import { createFileSink } from './file-sink.js';
import { createLog } from './logger.js';
import { tempDir } from '../adapter/temp.js';
import { joinPath } from '../core/persist.js';

/** 进程级共享日志口（宿主半边只用这一个）。 */
let shared = null;

/**
 * 取共享日志口；第一次调用时按宿主 logger 造一个。
 * @param {object|null} hostLogger
 * @returns {ReturnType<typeof createLog>}
 */
export function sharedLog(hostLogger) {
  if (!shared) shared = createLog(hostLogger || null, {});
  return shared;
}

/** 只给测试/重启用：丢掉共享口（宿主不会调用）。 */
export function resetSharedLog() {
  shared = null;
}

/** 当前日志口挂的是哪里的文件（'' = 还没挂）。 */
let sinkTarget = '';

// ---------------------------------------------------------------------------
// 事件去重（2026-11-23 发现 E-012 的真实原因）
//
// Loader 在同一个宿主进程里**重载插件行**时（安装/配置变更），`sharedLog` 的单例还在，
// 内存环里是旧事件；每次重载都会 `attachFileSink` 一次，把**历史事件再补写一遍**，
// 日志里就出现同一 bootId/timestamp 的整块重复。这里在 sink 外面套一层"同一条事件只写一次"
// （键 = bootId|ts|level|event|message；有界集合，超了清空从头记）。
// ---------------------------------------------------------------------------

/** 已经写进文件的键（进程级，有界）。 */
const writtenKeys = new Set();

/** 上限：超过就清空（只影响去重范围，不影响正确性）。 */
const WRITTEN_LIMIT = 10000;

/** 一条事件的去重键。 */
export function dedupeKeyOf(event) {
  const value = event && typeof event === 'object' ? event : {};
  return [value.bootId || '', value.ts || '', value.level || '', value.event || '', value.message || ''].join('|');
}

/**
 * 给文件 sink 套一层"同一条事件只写一次"（供测试与装配共用）。
 * @param {object} sink `createFileSink()` 的返回
 * @returns {object} 包装后的 sink（保留 write/flush/disabled/reason/path）
 */
export function dedupeSink(sink) {
  return {
    write(event) {
      const key = dedupeKeyOf(event);
      if (writtenKeys.has(key)) return false;
      if (writtenKeys.size >= WRITTEN_LIMIT) writtenKeys.clear();
      writtenKeys.add(key);
      return sink.write(event);
    },
    flush() {
      return typeof sink.flush === 'function' ? sink.flush() : true;
    },
    get disabled() { return !!sink.disabled; },
    get reason() { return sink.reason || ''; },
    get path() { return sink.path || ''; },
  };
}

/** 只给测试/重启用：清空去重集合。 */
export function resetLogDedupe() {
  writtenKeys.clear();
}

/**
 * 把日志挂到某个工作区的文件上（同一路径重复调用不重复挂）。
 * @param {object} log 共享日志口
 * @param {object} fs `adapter/fs.js` 的能力对象
 * @param {string} root 工作区根
 * @returns {boolean} 是否挂上（或已经挂着同一处）
 */
export function attachWorkspaceLog(log, fs, root) {
  const base = String(root || '');
  if (!base) return false;
  if (sinkTarget === base) return true;
  const sink = createFileSink({
    fs,
    dir: joinPath(base, '.dsh-veneer'),
    onFailure: (reason) => {
      try { log.warn('日志文件写不进去（' + base + '）：' + reason); } catch { /* 报告失败就算了 */ }
    },
  });
  const ok = log.attachFileSink(dedupeSink(sink));
  if (ok) sinkTarget = base;
  return ok;
}

/**
 * 挂引导日志：还没有工作区根时，日志落到系统临时目录（不是产物，随时可删）。
 * @param {object} log 共享日志口
 * @param {object} fs `adapter/fs.js` 的能力对象
 * @returns {boolean}
 */
export function attachBootstrapLog(log, fs) {
  const dir = tempDir();
  if (!dir) return false;
  if (sinkTarget === dir) return true;
  const sink = createFileSink({
    fs,
    dir,
    fileName: 'dsh-veneer-bootstrap.log',
    maxBytes: 64 * 1024,
    keep: 1,
    onFailure: () => { /* 引导日志写不了也不外溢 */ },
  });
  const ok = log.attachFileSink(dedupeSink(sink));
  if (ok) sinkTarget = dir;
  return ok;
}

/** 引导日志的绝对路径（报告给用户看用）。 */
export function bootstrapLogPath() {
  const dir = tempDir();
  return dir ? joinPath(dir, 'dsh-veneer-bootstrap.log') : '';
}
