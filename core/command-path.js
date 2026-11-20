// dsh-veneer —— 命令位置（核心层纯函数：执行侧脚本在哪）
//
// 为什么单独一个文件：命令里要出现**脚本的绝对路径**，而这个路径随安装形态变
// （本地链接目录 / npm 包 / profile 里的 node_modules）。这里只回答"脚本路径从哪来"，
// 不碰文件系统、不碰宿主。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 执行侧脚本相对包根的路径（与 scripts/README.md 同一处信息）。 */
export const APPLY_SCRIPT = 'scripts/dsh-veneer-apply.ps1';
/** 只读探针相对包根的路径。 */
export const INSPECT_SCRIPT = 'scripts/dsh-veneer-inspect.ps1';

/**
 * 解析执行侧脚本的绝对路径。
 * @param {string} packageDir 包根目录（入口从宿主拿；离线时用 `packageDirOf(import.meta.url)`）
 * @param {string} [relative] 相对路径（默认 APPLY_SCRIPT）
 * @returns {string} 绝对路径；`packageDir` 为空时返回空串
 */
export function scriptPathOf(packageDir, relative = APPLY_SCRIPT) {
  if (!packageDir) return '';
  return resolve(packageDir, relative.replace(/\//g, '\\'));
}

/**
 * 包根目录：<包根>/core/xxx.js 往上两级。
 * @param {string} moduleUrl `import.meta.url`
 */
export function packageDirOf(moduleUrl) {
  try {
    return dirname(dirname(fileURLToPath(moduleUrl)));
  } catch {
    return '';
  }
}
