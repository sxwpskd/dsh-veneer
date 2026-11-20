// dsh-veneer —— 文件系统适配（**只翻译**：不决定读写哪里）
//
// 规则同 dsh-milieu 的 adapter/fs.js：这里只把 `node:fs` 翻成能力对象，交给 core/ 用参数接收；
//   · core/ 不 import 'node:fs'（边界检查会看）；
//   · 不判断：写什么、写哪里由 core/ 决定；
//   · 错误原样抛出（与 node:fs 一致），由调用方包成 reason——翻译层不吞错。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync, watch } from 'node:fs';
import { dirname } from 'node:path';

/** 造一份文件系统能力对象。 */
export function createFs() {
  return {
    /** 读文本（utf8）。读不到 → 抛。 */
    readText: (path) => readFileSync(path, 'utf8'),
    /** 存在吗（不抛）。 */
    exists: (path) => existsSync(path),
    /** 递归建目录（已存在不算错）。 */
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    /**
     * 原子写文本：先写 `.tmp-<随机>`，再改名覆盖。
     * 为什么不用 writeFileSync 直接写：报告会被界面/脚本同时读到，半截 JSON 比没有更难查。
     */
    writeTextAtomic: (path, text) => {
      mkdirpFor(path);
      const tmp = path + '.tmp-' + Math.random().toString(16).slice(2, 10);
      try {
        writeFileSync(tmp, text, 'utf8');
        rmSync(path, { force: true });
        renameSync(tmp, path);
      } catch (err) {
        try { rmSync(tmp, { force: true }); } catch { /* 临时文件删不掉不影响主流程 */ }
        throw err;
      }
    },
    /** 目录部分。 */
    dirnameOf: (path) => dirname(path),
    /** 列目录（只给名字；读不到 → 抛）。界面读报告目录用。 */
    listNames: (path) => readdirSync(path, { encoding: 'utf8' }),
    /**
     * 看一个目录。**拿不到就是拿不到**：返回 `{ok:false, reason}`，
     * 因为宿主文件服务可能根本没挂载（这时界面那一半要如实说"这台机器看不了"）。
     */
    watchDir(path, onChange) {
      if (typeof watch !== 'function') return { ok: false, reason: 'fs.watch 不可用' };
      try {
        const watcher = watch(path, { persistent: false }, () => { try { onChange(); } catch { /* 回调异常不外溢 */ } });
        return { ok: true, close: () => { try { watcher.close(); } catch { /* 已关 */ } } };
      } catch (err) {
        return { ok: false, reason: String((err && err.message) || err) };
      }
    },
  };
}

/** 父目录不存在就建（writeTextAtomic 用）。 */
function mkdirpFor(path) {
  const dir = dirname(path);
  if (dir && dir !== path) mkdirSync(dir, { recursive: true });
}
