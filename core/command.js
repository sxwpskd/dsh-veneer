// dsh-veneer —— 命令生成（核心层纯函数：只拼字符串，不执行）
//
// 生成的命令必须满足用户的规矩（协作协议 §3.3 / 工作区 AGENTS 托管段）：
//   **命令行里只许出现"工具名 + 参数"**——不出现循环、管道、内联脚本、变量展开。
//   所以这里只产出一条 `powershell -NoProfile -ExecutionPolicy Bypass -File <脚本> -Root <根> ...`。
//
// 为什么默认不加 `-Apply`：**dry-run 是默认**。用户先看计划，再加 `-Apply` 真改；
//   执行侧脚本自己也会备份并打印 restore 命令。
import { ITEM } from '../model/acl.js';

/** 三项 → 执行侧脚本的参数词。 */
const FLAG = Object.freeze({
  [ITEM.CAP]: '-Cap',
  [ITEM.DENY_DC]: '-DenyDC',
  [ITEM.LABEL]: '-Label',
});

/** Windows 命令行的引号：双引号包起来，内部双引号与百分号转义不了——所以调用方要保证路径里没有它们。 */
export function quoteArg(value) {
  const text = String(value == null ? '' : value);
  if (/["%]/.test(text)) throw new Error('路径里有无法在命令行安全引用的字符：" 或 %：' + text);
  return '"' + text + '"';
}

/**
 * 拼一条修复命令。
 *
 * @param {{script:string, root:string, missing:Record<string, number>, apply?:boolean, medium?:boolean}} input
 *   · `missing` 是报告里的 `missingItems`（只对 >0 的项加参数）；
 *   · `apply` 默认 false（干跑）；用户看到计划后再自己加 `-Apply`。
 * @returns {string} 一条可粘贴的命令；没有缺项时返回空串
 */
export function buildCommand(input) {
  const script = input && typeof input.script === 'string' ? input.script : '';
  const root = input && typeof input.root === 'string' ? input.root : '';
  const missing = (input && input.missing) || {};
  if (!script || !root) return '';

  const args = [];
  for (const [item, flag] of Object.entries(FLAG)) {
    if (Number(missing[item] || 0) > 0) args.push(flag);
  }
  if (args.length === 0) return '';

  let quote;
  try {
    quote = quoteArg(script) + ' -Root ' + quoteArg(root) + ' ' + args.join(' ');
  } catch (err) {
    // 路径引用不了：不编一条会跑错的命令，交给调用方报告。
    return '';
  }
  const tail = input && input.apply === true ? ' -Apply' : '';
  const medium = input && input.medium === true ? ' -Medium' : '';
  return 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + quote + tail + medium;
}

/**
 * 把报告的 `missingItems` 压成一句人话（日志/README 用）。
 * @param {Record<string, number>} missingItems
 */
export function describeMissing(missingItems) {
  const items = missingItems || {};
  const parts = [];
  if (items[ITEM.CAP]) parts.push('能力 ACE ' + items[ITEM.CAP] + ' 处');
  if (items[ITEM.DENY_DC]) parts.push('Everyone 拒删子项 ' + items[ITEM.DENY_DC] + ' 处');
  if (items[ITEM.LABEL]) parts.push('Low 标签 ' + items[ITEM.LABEL] + ' 处');
  return parts.length ? parts.join('，') : '无';
}
