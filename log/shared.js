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
  const ok = log.attachFileSink(sink);
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
  const ok = log.attachFileSink(sink);
  if (ok) sinkTarget = dir;
  return ok;
}

/** 引导日志的绝对路径（报告给用户看用）。 */
export function bootstrapLogPath() {
  const dir = tempDir();
  return dir ? joinPath(dir, 'dsh-veneer-bootstrap.log') : '';
}
