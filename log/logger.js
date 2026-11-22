// dsh-veneer —— 日志（宿主 logger + 控制台 + **临时目录文件 sink**）
//
// 为什么现在有文件 sink（2026-11-22）：真机上出现过"插件行是 active，但工作区里什么都没发生"，
// 而宿主 logger 的输出只有在 DSH 自己的日志里才看得到，排查时够不着。
// 于是把同样的几条结论**同时**追加到 `<系统临时目录>/dsh-veneer-host.log`（有大小上限）。
// 它不在工作区里、不是产物，只用来回答"宿主这一半到底跑到哪一步了"。
//
// 纪律：日志自己坏了不许反过来抛（边界里的边界）。

import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 诊断日志路径（系统临时目录；不进工作区）。 */
export const LOG_FILE = (() => {
  try { return join(tmpdir(), 'dsh-veneer-host.log'); } catch { return ''; }
})();

/** 文件上限：超过就整份重来（只需要最近一次启动的现场）。 */
const MAX_BYTES = 512 * 1024;

/** 追加一行到诊断日志（任何异常都吞掉）。 */
function appendLine(line) {
  if (!LOG_FILE) return;
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_BYTES) writeFileSync(LOG_FILE, '');
    appendFileSync(LOG_FILE, line + '\n');
  } catch { /* 日志文件写不了：不影响主流程 */ }
}

/** 造一个日志口。宿主 logger 缺失时退到控制台；两者都没有也还会写文件 sink。 */
export function createLog(hostLogger) {
  const emit = (level, message) => {
    const text = '[veneer] ' + message;
    try { appendLine(new Date().toISOString() + ' ' + level.toUpperCase() + ' ' + message); } catch { /* 同上 */ }
    try {
      const fn = hostLogger && hostLogger[level];
      if (typeof fn === 'function') {
        fn.call(hostLogger, text);
        return;
      }
    } catch { /* 宿主 logger 坏了：试控制台 */ }
    try {
      const fn = level === 'warn' ? console.warn : console.info;
      if (typeof fn === 'function') fn.call(console, text);
    } catch { /* 控制台也没有：放弃 */ }
  };
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  };
}
