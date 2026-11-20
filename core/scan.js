// dsh-veneer —— 一次扫描的编排（核心层动作：采集 → 命令 → 落盘 → 一句话结论）
//
// 这一层不碰宿主、不碰 node:fs：`acl` / `fs` 都由入口装配好传进来（测试可注入假实现）。
//
// 顺序固定，任一步失败都**只报告不猜**：
//   ① 采集（core/collect.js）——根不全就停在那里，不扫子树；
//   ② 有缺项且有根 → 生成命令（core/command.js）；
//   ③ 落盘到 `reportPath`（core/persist.js）——内容不变不写；
//   ④ 返回 `{ status, reportPath, command, ... }` 给入口打日志/给界面读。
import { CODES } from '../exception/codes.js';
import { fail, ok, isFail } from '../exception/result.js';
import { collect } from './collect.js';
import { persistReport } from './persist.js';
import { summarize, needsUserAction } from './report.js';

/**
 * @param {{acl:object, fs:object, commandPath:string, listLimit?:number, now?:Function}} deps
 * @param {{root:string, reportPath:string}} options
 */
export async function runScan(deps, options) {
  const root = options && options.root ? String(options.root) : '';
  if (!root) return fail('没有工作区根，跳过扫描', 'host', CODES.CONFIG_INVALID);

  const collected = await collect({
    acl: deps.acl,
    commandPath: deps.commandPath,
    listLimit: deps.listLimit,
    now: deps.now,
  }, { root });
  if (isFail(collected)) return collected;
  const report = collected.value;

  const saved = persistReport({ fs: deps.fs }, { root, reportPath: options.reportPath, report });
  if (isFail(saved)) {
    // 写不进去**不吞**：扫描结论还在，只是没落盘——把两者一起交给调用方。
    return fail(saved.reason + '（扫描结论：' + summarize(report) + '）', saved.blockedBy, saved.code);
  }

  return ok({
    status: report.status,
    summary: summarize(report),
    counts: report.counts,
    missingItems: report.missingItems,
    command: needsUserAction(report) ? report.command : '',
    reportPath: saved.value.path,
    written: saved.value.written,
    rootMissing: report.rootMissing,
  });
}
