// dsh-veneer —— 多工作区扫描结果的**汇总与串行队列**
//
// 为什么要有它（2026-11-23 主人指出"配置显示管全部、实际只看到一个工作区的一份"）：
//   · 每个工作区实例各自扫描、各自把报告写在自己的 `review/veneer-state.json`；
//   · 但配置页是浏览器侧，只能经**当前会话的工作区**读文件 → 永远只能看到当前工作区那份。
// 做法（简单版）：
//   ① 每个实例每次扫描结束（成功/失败/根归宿主）都把摘要上报到本模块（进程内存）；
//   ② 索引层（`index.js`）订阅变化，把**全量摘要**写到每个被管工作区的 `.dsh-veneer/workspaces.json`；
//   ③ 面板读当前工作区这一份 → 按工作区逐个展示（不管你在哪个工作区打开配置页）。
// 另外：扫描改为**全局串行队列**（一个扫完再扫下一个），顺序 = 挂载顺序，面板也按这个顺序展示。
//
// 纪律：本模块只存内存 + 纯函数，不碰文件系统、不抛异常（供测试直接调用）。

/** 工作区键：斜杠归一 + 去尾斜杠 + 小写。 */
function keyOf(root) {
  return String(root == null ? '' : root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** root → 摘要项（插入顺序 = 首次上报顺序 = 队列/挂载顺序）。 */
const entries = new Map();

/** 订阅者（索引层写文件用）。 */
const listeners = new Set();

/** 全局串行队列（扫描一次一个；失败不影响后续）。 */
let queue = Promise.resolve();

/** 通知订阅者（异常不外溢）。 */
function notify() {
  const snapshot = snapshotWorkspaces();
  for (const listener of Array.from(listeners)) {
    try {
      listener(snapshot);
    } catch { /* 订阅者异常不能掀翻扫描 */ }
  }
}

/**
 * 上报一个工作区的扫描摘要（同一 root 覆盖旧值，但保持首次出现的顺序）。
 *
 * @param {object} entry
 *   · `root`       工作区根（必填；空则忽略）
 *   · `status`     `ok` / `incomplete` / `root-absent` / `partial` / `failed` / `unsupported` / `unknown`
 *   · `counts`     `{checked, missing, skipped, failed}`
 *   · `scannedAt`  ISO 时间（扫描完成时间）
 *   · `reason`     失败/根归宿主等的原因
 *   · `source`     触发来源（mount / session-first-message / after-fix / inject …）
 * @returns {object|null} 归一后的项
 */
export function reportWorkspaceScan(entry) {
  try {
    const value = entry && typeof entry === 'object' ? entry : {};
    const root = typeof value.root === 'string' ? value.root.trim() : '';
    if (!root) return null;
    const key = keyOf(root);
    const previous = entries.get(key) || null;
    const counts = value.counts && typeof value.counts === 'object' ? value.counts : {};
    const next = {
      root: previous ? previous.root : root,
      status: typeof value.status === 'string' && value.status ? value.status : 'unknown',
      counts: {
        checked: Number(counts.checked) || 0,
        missing: Number(counts.missing) || 0,
        skipped: Number(counts.skipped) || 0,
        failed: Number(counts.failed) || 0,
      },
      scannedAt: typeof value.scannedAt === 'string' && value.scannedAt ? value.scannedAt : '',
      reason: typeof value.reason === 'string' ? value.reason : '',
      source: typeof value.source === 'string' ? value.source : '',
    };
    entries.set(key, next);
    notify();
    return next;
  } catch {
    return null;
  }
}

/** 工作区不再被管（实例卸载）：从汇总里去掉。 */
export function forgetWorkspace(root) {
  try {
    const key = keyOf(root);
    if (!key) return false;
    const removed = entries.delete(key);
    if (removed) notify();
    return removed;
  } catch {
    return false;
  }
}

/** 当前汇总（按首次出现顺序；返回副本）。 */
export function snapshotWorkspaces() {
  const out = [];
  for (const item of entries.values()) out.push({ ...item, counts: { ...item.counts } });
  return out;
}

/** 订阅汇总变化；返回退订函数。 */
export function subscribeWorkspaces(listener) {
  if (typeof listener !== 'function') return () => {};
  let active = true;
  const wrapped = (snapshot) => {
    if (active) listener(snapshot);
  };
  listeners.add(wrapped);
  return () => {
    active = false;
    listeners.delete(wrapped);
  };
}

/**
 * 全局串行队列：按调用顺序依次跑（扫描一个工作区再扫下一个）。
 * @param {() => Promise<any>|any} job
 * @returns {Promise<any>}
 */
export function enqueueGlobalScan(job) {
  const run = () => Promise.resolve().then(job);
  const next = queue.then(run, run);
  queue = next.catch(() => { /* 一个任务失败不能让队列卡死 */ });
  return next;
}

/** 只给测试/重启用：清空汇总与队列。 */
export function resetWorkspaces() {
  entries.clear();
  listeners.clear();
  queue = Promise.resolve();
}
