// dsh-veneer —— 日志（极简：宿主 logger + 控制台兜底，不建文件 sink）
//
// 为什么不做 dsh-milieu 那种 JSONL 文件日志：这个插件**一次扫描只产出几条结论**，
// 而结论本身（报告 JSON）已经落在工作区里。再写一份日志文件，等于给工作区多添一个要清理的产物。
//
// 纪律：日志自己坏了不许反过来抛（边界里的边界）。

/** 造一个日志口。宿主 logger 缺失时退到控制台；两者都没有就是 no-op。 */
export function createLog(hostLogger) {
  const emit = (level, message) => {
    const text = '[veneer] ' + message;
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
