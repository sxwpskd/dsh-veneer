// dsh-veneer —— 桌面端打开文件（环境适配；Windows 用 explorer.exe 选中文件）
//
// 为什么放这里而不是 core/：它起的是**桌面 shell 进程**，不是业务逻辑；
// 只由手动入口（RPC `openReport`）按需调用，**扫描过程从不调用它**。
//
// 约束：
//   · 路径必须是工作区里的相对路径——**拒绝绝对路径**（不让 RPC 变成"随便打开任何文件"）；
//   · 找不到文件 → 返回原因，不静默；
//   · 只在本机 Windows 有意义；别处返回"不支持"。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, normalize, isAbsolute } from 'node:path';

/** 把工作区里的相对路径解析成绝对路径；越界或非法 → null。 */
export function resolveInsideRoot(root, relative) {
  if (typeof relative !== 'string' || !relative.trim()) return null;
  if (isAbsolute(relative)) return null;
  const base = normalize(String(root));
  const target = normalize(join(base, relative));
  const prefix = base.endsWith('\\') || base.endsWith('/') ? base : base + '\\';
  if (target !== base && !target.startsWith(prefix)) return null;
  return target;
}

/**
 * 在资源管理器里选中一个文件。
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function revealInExplorer(target) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not Windows' };
  if (!existsSync(target)) return { ok: false, reason: 'file not found' };
  try {
    const child = spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}
