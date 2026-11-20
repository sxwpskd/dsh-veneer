// dsh-veneer —— 数据形状（model 层：只放形状与纯归一，不做 IO、不做判断）
//
// 三张形状：
//   · **签名**（signature）：一个对象的物化三项长什么样——`{ cap, denyDC, denyDCInherit, label }`；
//   · **判缺**（deficit）：这个对象缺哪几项、为什么跳过；
//   · **报告**（report）：写进工作区的那份 JSON。

/** 三项的名字（报告与执行侧脚本共用同一套词，别另起一套）。 */
export const ITEM = Object.freeze({
  CAP: 'cap',       // 工作区能力 ACE（读根 SD 里的 SID，照抄）
  DENY_DC: 'denyDC', // 目录上的 `Everyone` 拒绝 FILE_DELETE_CHILD
  LABEL: 'label',   // Low 完整性标签
});

/** 报告版本：形状一变就升（执行侧脚本与将来的 UI 读它）。 */
export const REPORT_VERSION = 1;

/** 三种整体状态。 */
export const STATUS = Object.freeze({
  OK: 'ok',             // 根齐、子树也都齐
  INCOMPLETE: 'incomplete', // 有对象缺三项（需要用户执行修复命令）
  ROOT_ABSENT: 'root-absent', // 根上没物化三项 → 属于宿主，本插件不动手
  PARTIAL: 'partial',   // 扫不全（读不了某些子树），结论不完整
  UNSUPPORTED: 'unsupported', // 非 Windows
  UNKNOWN: 'unknown',   // 还没扫过
});

/**
 * 一项被算作"已有"的判据（三项统一口径）：
 *   · cap    —— 根 SID 有一条第 `Allow` 职责位含写（`W` 或 `WD`）的 ACE；
 *   · denyDC —— 有一条 `S-1-1-0` 的 `Deny` ACE，且是删除子项位（`DC` 或 `D`）；
 *   · label  —— 完整性标签是 `Low`。
 * **显式与继承都算**：是否带 `(I)` 只作为签名的一部分记下来，**判缺不看它**。
 * 这么定的原因：只补"真的没有"的项。把已经从根继承来的再补一遍，会在 `icacls` 里留一组重复 ACE
 * （2026-11-20 在 `D:\agent-collab-1\公共信息库\` 亲眼见到）。
 */
export const SAME_ITEM_RULES = Object.freeze({
  cap: 'any Allow ACE for the root capability SID with write data (W or WD)',
  denyDC: 'any Deny ACE for Everyone (S-1-1-0) with delete-child (DC or D)',
  label: 'integrity label Low',
});

/** 跳过原因（报告里的 `reason` 就取这些词，便于按词统计）。 */
export const SKIP = Object.freeze({
  REPARSE: 'reparse-point',      // reparse point（junction / symlink / mount）：官方也管不全
  NO_ACL_READ: 'acl-unreadable', // 读不到 SD（权限不足）
});

/**
 * 归一一处 ACL 读取结果。输入来自执行侧脚本（`inspect` 命令）的原样输出。
 *
 * @param {object} raw
 * @returns {{path:string, isDir:boolean, signature:object, error?:string}|null}
 */
export function normalizeObject(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string') return null;
  const cap = raw.cap === true;
  const denyDC = raw.denyDC === true;
  const label = raw.label === 'low' ? 'low' : (raw.label === 'medium' ? 'medium' : null);
  const signature = {
    cap,
    denyDC,
    denyDCInherit: raw.denyDCInherit === true,
    label,
  };
  const obj = {
    path: raw.path,
    isDir: raw.isDir === true,
    signature,
  };
  if (typeof raw.error === 'string' && raw.error) obj.error = raw.error;
  return obj;
}
