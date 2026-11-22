// dsh-veneer —— 文件 sink（JSONL、有界轮转、**fs 是注入的**）
//
// 为什么注入 fs 而不是 import 'node:fs'：
//   · 这个模块也要能在客户端半边被打包/测试替换（浏览器没有 node:fs）；
//   · 写哪里、能不能写由装配层决定——本层只负责"一行一条 + 超限轮转"；
//   · 离线测试塞一个内存假 fs 就能验，不用碰真磁盘。
//
// 行为：
//   · 一行一条 JSONL：`JSON.stringify(event)` + `\n`（字符串里的换行由 JSON 自己转义，不会断行）；
//   · 写前看大小：超过 `maxBytes` 就轮转（`veneer.log` → `veneer.log.1`，旧的往后推，`keep` 控制保留几份）；
//   · 任何异常 → `disabled = true` + `reason`，`onFailure(reason)` **只回调一次**，之后不再写；
//   · 永不抛：日志自己坏了不许掀翻插件。

/** 默认上限 1 MiB、默认保留 2 份（与 LOG-SCHEMA.md 一致）。 */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** 字节数（UTF-8）；没有 TextEncoder 时退回字符数（保守估计）。 */
function byteLengthOf(text) {
  const value = text == null ? '' : String(text);
  try {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  } catch { /* 没有 TextEncoder：退回字符数 */ }
  return value.length;
}

/** 拼路径：Windows 用 `\`，其它平台用 `/`（本模块不能 import node:path）。 */
function joinPath(dir, name) {
  const base = String(dir == null ? '' : dir).replace(/[\\/]+$/, '');
  if (!base) return name;
  return base + (base.includes('\\') ? '\\' : '/') + name;
}

/**
 * 造一个文件 sink。
 *
 * @param {object} options
 * @param {object} options.fs 注入的文件系统适配对象（`adapter/fs.js` 形状：`exists/readText/writeTextAtomic/mkdirp`，可选 `appendText`）
 * @param {string} options.dir 日志目录（如 `<工作区>/.dsh-veneer`）
 * @param {string} [options.fileName='veneer.log']
 * @param {number} [options.maxBytes=1024*1024] 单个文件上限（字节）
 * @param {number} [options.keep=2] 轮转保留份数（`veneer.log.1 … veneer.log.keep`）
 * @param {(reason:string)=>void} [options.onFailure] 写失败时报告一次（不传则只记在 disabled/reason 上）
 * @returns {{write:(event:object)=>boolean, flush:()=>boolean, disabled:boolean, reason:string, path:string}}
 */
export function createFileSink({
  fs,
  dir = '',
  fileName = 'veneer.log',
  maxBytes = DEFAULT_MAX_BYTES,
  keep = 2,
  onFailure = null,
} = {}) {
  const baseDir = String(dir == null ? '' : dir);
  const name = String(fileName == null ? 'veneer.log' : fileName);
  const sizeLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
  const keepCount = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : 2;
  const path = joinPath(baseDir, name);
  const notify = typeof onFailure === 'function' ? onFailure : null;

  let disabled = false;
  let reason = '';
  let dirReady = false;
  let notified = false;

  /** 失败：禁用 + 记原因 + 只报告一次（之后的写入直接返回 false）。 */
  function fail(err) {
    if (disabled) return;
    disabled = true;
    reason = String((err && err.message) || err || '未知错误');
    if (notify && !notified) {
      notified = true;
      try { notify(reason); } catch { /* 回调自己坏了也不许外溢 */ }
    }
  }

  /** 第一次写前建目录（等价于 `mkdirp(dir)`）；只做一次。 */
  function ensureDir() {
    if (dirReady || !baseDir) return;
    if (typeof fs.mkdirp === 'function') fs.mkdirp(baseDir);
    dirReady = true;
  }

  /**
   * 读一个文件；不存在 → 空串。
   * **读失败不吞**：读不了说明这个 fs 现在不可靠，让调用方按失败处理（宁可禁用，也不装成空文件越写越大）。
   */
  function readIfPresent(file) {
    if (typeof fs.exists === 'function' && !fs.exists(file)) return '';
    if (typeof fs.readText !== 'function') return '';
    const text = fs.readText(file);
    return typeof text === 'string' ? text : '';
  }

  /** 追加一行：优先 `appendText`；没有就"读旧文 + 新文"原子覆盖。 */
  function appendLine(line) {
    if (typeof fs.appendText === 'function') {
      fs.appendText(path, line);
      return;
    }
    const before = readIfPresent(path);
    fs.writeTextAtomic(path, before + line);
  }

  /**
   * 轮转：`.i` → `.i+1`（从最旧的开始搬），当前文件 → `.1`，然后清空当前文件。
   * 超出 `keep` 的旧份不搬，下一轮直接覆盖 —— 等价于"丢掉最旧的"。
   */
  function rotate(currentText) {
    for (let i = keepCount - 1; i >= 1; i -= 1) {
      const from = path + '.' + i;
      if (typeof fs.exists === 'function' && !fs.exists(from)) continue;
      const text = readIfPresent(from);
      if (text !== '') fs.writeTextAtomic(path + '.' + (i + 1), text);
    }
    if (currentText !== '') fs.writeTextAtomic(path + '.1', currentText);
    fs.writeTextAtomic(path, '');
  }

  /**
   * 写一条事件（JSONL 一行）。
   * @param {object} event
   * @returns {boolean} 是否写成功（禁用后恒 false）
   */
  function write(event) {
    if (disabled) return false;
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    if (!fs || typeof fs !== 'object') {
      fail('file-sink 缺少注入的 fs');
      return false;
    }
    if (typeof fs.writeTextAtomic !== 'function' && typeof fs.appendText !== 'function') {
      fail('file-sink 的 fs 既没有 appendText 也没有 writeTextAtomic');
      return false;
    }

    let line;
    try { line = JSON.stringify(event); } catch (err) { fail(err); return false; }
    if (typeof line !== 'string') { fail('事件不能序列化成 JSON'); return false; }
    line += '\n';

    try {
      ensureDir();
      const currentText = readIfPresent(path);
      const currentBytes = byteLengthOf(currentText);
      // 写前看大小：这一行再写进去会超上限就先把当前文件轮转掉。
      if (currentBytes > 0 && currentBytes + byteLengthOf(line) > sizeLimit) rotate(currentText);
      appendLine(line);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  /** 目前是同步写、没有缓冲；flush 只保证目录存在，方便装配层统一调用。 */
  function flush() {
    if (disabled) return false;
    try {
      ensureDir();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  const sink = {
    write,
    flush,
    get disabled() { return disabled; },
    get reason() { return reason; },
    path,
  };
  return sink;
}
