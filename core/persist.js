// dsh-veneer —— 落盘（核心层：把报告写进工作区，按内容去重）
//
// 规则：
//   · 写**内容不同**才写（`generatedAt` 不参与比较）——没有变化不刷盘；
//   · 原子写（adapter/fs.js 的 `writeTextAtomic`）：界面/脚本可能正在读半截文件；
//   · 形状不变、只是时间变 → 不写；形状变了 → 写。
import { CODES } from '../exception/codes.js';
import { fail, ok } from '../exception/result.js';

/**
 * 把报告写进 `reportPath`。
 * @param {{fs:object}} deps
 * @param {{root:string, reportPath:string, report:object}} options
 * @returns {{ok:true, value:{written:boolean, path:string}}|{ok:false, reason:string, blockedBy:string|null, code?:string}}
 */
export function persistReport(deps, options) {
  const root = options && options.root ? String(options.root) : '';
  const rel = options && options.reportPath ? String(options.reportPath) : '';
  const report = options && options.report;
  if (!root || !rel || !report) {
    return fail('写报告缺参数（root / reportPath / report）', 'config', CODES.CONFIG_INVALID);
  }
  const path = joinPath(root, rel);
  const next = JSON.stringify(report, null, 2) + '\n';

  // 先看旧报告：去掉 generatedAt / scannedAt 之后一样，就不写。
  try {
    if (deps.fs.exists(path)) {
      const before = deps.fs.readText(path);
      if (sameShape(before, next)) return ok({ written: false, path });
    }
  } catch {
    // 旧报告读不了（坏 JSON / 权限）：照样覆盖，不因为旧文件坏了就不写新结论。
  }

  try {
    deps.fs.writeTextAtomic(path, next);
  } catch (err) {
    return fail('写报告失败：' + String((err && err.message) || err), 'fs', CODES.FS_WRITE_FAILED);
  }
  return ok({ written: true, path });
}

/** 路径拼接（只接受相对路径：报告不许写到工作区外）。 */
export function joinPath(root, rel) {
  const base = String(root).replace(/[\\/]+$/, '');
  const sub = String(rel).replace(/^[\\/]+/, '');
  return base + '\\' + sub.replace(/\//g, '\\');
}

/** 两份报告 JSON 的"形状"是否一样（忽略时间戳字段）。 */
function sameShape(beforeText, afterText) {
  try {
    const before = JSON.parse(beforeText);
    const after = JSON.parse(afterText);
    delete before.generatedAt;
    delete after.generatedAt;
    delete before.scannedAt;
    delete after.scannedAt;
    return JSON.stringify(before) === JSON.stringify(after);
  } catch {
    return false;
  }
}
