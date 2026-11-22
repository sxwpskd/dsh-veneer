// dsh-veneer —— 临时目录（只有"找不到工作区根"时的引导日志需要它）
//
// 为什么不把 os.tmpdir() 直接写进 core/：core/ 不碰 node 内置模块（与 adapter 的约定一致）；
// 引导日志是**非产物**：它只在还没有工作区根的时候用来回答"宿主跑到哪一步了"，
// 一旦根解析成功，之后的日志全部写进 `<工作区>/.dsh-veneer/veneer.log`。
import { tmpdir } from 'node:os';

/** 系统临时目录（拿不到就返回空串，调用方自己降级）。 */
export function tempDir() {
  try { return tmpdir(); } catch { return ''; }
}
