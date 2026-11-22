// dsh-veneer —— 内存环形缓冲（客户端拿不到文件系统时的"最后 N 条"）
//
// 为什么必须有它（脚手架 log/README 的硬要求）：
//   · 客户端半边可能根本没有 fs 服务，日志写不进文件；
//   · 但界面要能显示"刚才发生了什么"（面板的调试行直接读 `logs(n)`）；
//   · 环形 = 有界：只留最近 N 条，写日志不会把内存吃光。
//
// 纪律：**永不抛**。日志自己坏了不许反过来影响业务流程。

/**
 * 造一个内存 sink（环形缓冲）。
 *
 * @param {number} [limit=200] 最多保留多少条；超了丢最旧的。非法值退回 200。
 * @returns {{write:(event:object)=>boolean, tail:(n?:number)=>object[], clear:()=>void, size:()=>number}}
 */
export function createMemorySink(limit = 200) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
  let buffer = [];

  return {
    /**
     * 收一条事件。只收对象（数组不算「一条日志」）；超上限丢最旧的。
     * @param {object} event
     * @returns {boolean} 是否收下
     */
    write(event) {
      try {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
        buffer.push(event);
        if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * 取最近 n 条（**旧 → 新**，与写入顺序一致；面板直接按这个顺序显示）。
     * @param {number} [n=20]
     * @returns {object[]}
     */
    tail(n = 20) {
      try {
        const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
        if (count === 0) return [];
        return buffer.slice(-count);
      } catch {
        return [];
      }
    },

    /** 清空。 */
    clear() {
      try { buffer = []; } catch { /* 清不掉也不许抛 */ }
    },

    /** 当前条数。 */
    size() {
      try { return buffer.length; } catch { return 0; }
    },
  };
}
