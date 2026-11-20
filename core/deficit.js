// dsh-veneer —— 判缺（核心层纯策略：给一处签名，回答"缺什么 / 为什么不做"）
//
// 一条总规则：**只补"根上有、这个对象没有"**。根上也没有的项，插件不发明、不猜。
//
// 逐项：
//   · cap     —— 根 SD 里有工作区能力 SID（含写位）就要求每个子孙也有；**继承来的也算有**。
//   · denyDC  —— 只对**目录**要求（文件上"删除子项"没有意义），且只有根上有才要求；
//                **继承来的也算有**：判据只看这一位在不在，不看怎么来的。
//   · label   —— 根是 Low 才要求子孙是 Low；根不是 Low 就整项不要求。
//   · reparse point / 读不到 SD → 跳过，写原因，不补。
//
// 为什么强调"继承也算"：2026-11-20 在 `D:\agent-collab-1\公共信息库\` 看到回填把**已经从根继承来的**
// ACE 又显式补了一遍，`icacls` 里因此多出一组重复 ACE。判据按"显式/非继承"做就会复现这个毛病。
import { ITEM, SKIP } from '../model/acl.js';

/**
 * 根的模板：从根的签名里取"要求哪些项"。
 * @param {object} rootSignature 见 model/acl.js
 */
export function templateOf(rootSignature) {
  const sig = rootSignature || {};
  return {
    cap: sig.cap === true,
    denyDC: sig.denyDC === true,
    label: sig.label === 'low' ? 'low' : null,
  };
}

/**
 * 一处对象缺哪几项。
 *
 * @param {{path:string, isDir:boolean, signature:object, error?:string, reparse?:boolean}} obj
 * @param {{cap:boolean, denyDC:boolean, label:string|null}} template
 * @returns {{path:string, skip:string|null, missing:string[], has:object}}
 *   · `skip` 非空 → 整个对象跳过（`missing` 留空，别让调用方以为"补了就好"）；
 *   · `missing` 是 `ITEM` 里的词，顺序固定（cap, denyDC, label）。
 */
export function deficitsOf(obj, template) {
  const path = obj && typeof obj.path === 'string' ? obj.path : '';
  const sig = (obj && obj.signature) || {};
  const out = { path, skip: null, missing: [], has: { cap: false, denyDC: false, label: null } };

  // 读不到 SD：跳过（原因写在报告里），不做任何推断。
  if (obj && typeof obj.error === 'string' && obj.error) {
    out.skip = SKIP.NO_ACL_READ;
    return out;
  }
  // reparse point：官方语义下继承不走这一层，我们也不碰。
  if (obj && obj.reparse === true) {
    out.skip = SKIP.REPARSE;
    return out;
  }

  const isDir = !!(obj && obj.isDir);
  out.has.cap = sig.cap === true;
  out.has.denyDC = sig.denyDC === true;
  out.has.label = sig.label || null;

  if (template.cap && !out.has.cap) out.missing.push(ITEM.CAP);
  // 文件不要求 denyDC（根上那一项只对目录有意义）。
  if (template.denyDC && isDir && !out.has.denyDC) out.missing.push(ITEM.DENY_DC);
  if (template.label === 'low' && out.has.label !== 'low') out.missing.push(ITEM.LABEL);
  return out;
}

/**
 * 根的判断：根缺三项 → 这是宿主的活（不是我们的），返回缺哪几项。
 * @param {object} rootSignature
 * @returns {string[]} 根上缺的项（空数组 = 根齐了）
 */
export function rootDeficits(rootSignature) {
  const sig = rootSignature || {};
  const missing = [];
  if (sig.cap !== true) missing.push(ITEM.CAP);
  if (sig.denyDC !== true) missing.push(ITEM.DENY_DC);
  if (sig.label !== 'low') missing.push(ITEM.LABEL);
  return missing;
}
