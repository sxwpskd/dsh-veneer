// dsh-veneer —— 宿主原生确认框（A 通道：会话首条人类消息 → 扫描出缺项 → 问人要不要修）
//
// 浏览器面板可以自己画弹窗；但"刚打开一条会话、还没进面板"这一刻没有可用的客户端钩子，
// 所以用**宿主原生**对话框：起 `powershell.exe` 跑 `scripts/dsh-veneer-ask.ps1`。
//
// 为什么是**两步**（2026-11-23 修 E-013）：MessageBox 的「取消」和"点 X 关窗"都返回 Cancel，
// 无法区分；三按钮 Yes/No/Cancel 会把"顺手关窗"误当成"不再检查本工作区"（写 exclude，把工作区
// 移出管理）。改成两个 Yes/No 框：
//   框一：现在修复？（是 = 修复全部缺项并弹 UAC；否 = 进入框二）
//   框二：以后还自动检查本工作区？（是 = 不再检查并写 exclude；否/关窗 = 以后再说）
// 退出码：6 = 修复、7 = 以后再说、8 = 不再检查；其它 = 失败（如实报告，不猜用户点了什么）。
//
// 传参纪律（与 `adapter/acl.js` 同一手法）：**参数只经环境变量**，不在命令行拼 JSON。
//   · `DSH_VENEER_ASK_TEXT`：第一个框正文（含工作区与缺项数；这里拼好，脚本只负责显示）；
//   · `DSH_VENEER_ASK_TEXT2`：第二个框正文；
//   · `DSH_VENEER_ASK_ROOT` / `DSH_VENEER_ASK_MISSING`：结构化事实（脚本/支持人员可复核）。
//
// 异常边界：**永不 reject**；进程起不来 / 超时 / 退出码不认识都返回 `{ok:false, reason}`。
import { runProcess } from '../adapter/dsh.js';
import { scriptPathOf } from './command-path.js';

/** 弹窗脚本相对包根的路径。 */
export const ASK_SCRIPT = 'scripts/dsh-veneer-ask.ps1';

/** 等人点按钮的时限（毫秒）；超时按失败报，不假装"以后再说"。 */
export const ASK_TIMEOUT_MS = 300000;

/** 退出码 → 动作。 */
export const ASK_EXIT = Object.freeze({
  FIX: 6,
  LATER: 7,
  IGNORE: 8,
});

/** 第二个框的正文环境变量名（脚本读它；名字一起改）。 */
export const TEXT2_ENV = 'DSH_VENEER_ASK_TEXT2';

/** 第一个框的正文环境变量名。 */
export const TEXT1_ENV = 'DSH_VENEER_ASK_TEXT';

/** PowerShell 参数（与 `adapter/acl.js` 的同一组；这里用 `-File` 直接跑脚本）。 */
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

/** 数字归一（非法 → 0）。 */
function countOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/**
 * 弹窗正文（中文；也允许调用方传自己的文案）。
 * 必须含**工作区**与**缺项数**（R-12 的验收点），前几条明细有就给。
 * @param {{root:string, missing:number, samples?:Array}} input
 */
export function buildAskText(input = {}) {
  const root = typeof input.root === 'string' ? input.root : '';
  const missing = countOf(input.missing);
  const samples = Array.isArray(input.samples) ? input.samples : [];
  const lines = [
    'dsh-veneer 检测到本工作区有对象缺"沙箱物化三项"（能力 ACE / Everyone 拒删子项 / Low 标签）。',
    '',
    '工作区：' + root,
    '缺项对象：' + missing + ' 个',
  ];
  if (samples.length) {
    lines.push('');
    lines.push('前几个：');
    for (const sample of samples.slice(0, 3)) {
      const path = sample && typeof sample.path === 'string' ? sample.path : '';
      if (!path) continue;
      const items = sample && Array.isArray(sample.items) && sample.items.length
        ? '（缺 ' + sample.items.join(' / ') + '）'
        : '';
      lines.push('  · ' + path + items);
    }
  }
  lines.push('');
  lines.push('按钮：是 = 现在修复（会弹 UAC，只改这些对象缺的项）；');
  lines.push('      否 = 以后再说（不会再把本工作区列为“不再检查”）。');
  return lines.join('\n');
}

/**
 * 第二个框的正文（"以后还自动检查吗"）。**关窗等于"否"**，所以不能把这件事塞进第一个框。
 * @param {{root:string, missing:number}} input
 */
export function buildAskText2(input = {}) {
  const root = typeof input.root === 'string' ? input.root : '';
  const missing = countOf(input.missing);
  const lines = [
    '以后还自动检查这个工作区吗？',
    '',
    '工作区：' + root,
    '当前缺项对象：' + missing + ' 个',
    '',
    '按钮：是 = 以后不再自动检查（把本工作区写进配置 exclude，可手动恢复）；',
    '      否（或直接关窗）= 继续自动检查，这次先不处理。',
  ];
  return lines.join('\n');
}

/**
 * 弹一次原生确认框（**永不 reject**）。
 *
 * @param {object} options
 *   · `root`       工作区根（正文里会显示）
 *   · `missing`    缺项对象数（>0 才值得问；0 直接返回失败，不弹窗）
 *   · `samples`    可选：`[{path, items}]` 前几条明细
 *   · `text`       可选：覆盖正文（调用方已拼好时）
 *   · `packageDir` 包根（算脚本路径）；或直接给 `scriptPath`
 *   · `execImpl`   进程注入点（签名同 `adapter/dsh.runProcess` 的 runner）
 *   · `execFileImpl` 更底层注入点（签名同 `node:child_process.execFile`）
 *   · `env` / `timeoutMs` / `title`
 * @returns {Promise<{ok:true, value:'fix'|'later'|'ignore'}|{ok:false, reason:string, code:string}>}
 */
export async function askFix(options = {}) {
  const root = typeof options.root === 'string' ? options.root.trim() : '';
  const missing = countOf(options.missing);
  if (!root) return { ok: false, reason: '没有工作区根，不弹确认框', code: 'ask-no-root' };
  if (!missing) return { ok: false, reason: '没有缺项，不需要确认', code: 'ask-nothing-to-ask' };

  const scriptPath = typeof options.scriptPath === 'string' && options.scriptPath
    ? options.scriptPath
    : scriptPathOf(options.packageDir || '', ASK_SCRIPT);
  if (!scriptPath) {
    return { ok: false, reason: '找不到确认框脚本（包目录解析失败）', code: 'ask-script-missing' };
  }

  const text = typeof options.text === 'string' && options.text
    ? options.text
    : buildAskText({ root, missing, samples: options.samples });
  const text2 = typeof options.text2 === 'string' && options.text2
    ? options.text2
    : buildAskText2({ root, missing });
  const env = {
    ...(options.env && typeof options.env === 'object' ? options.env : process.env),
    DSH_VENEER_ASK_ROOT: root,
    DSH_VENEER_ASK_MISSING: String(missing),
    [TEXT1_ENV]: text,
    [TEXT2_ENV]: text2,
  };
  const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : ASK_TIMEOUT_MS;
  const run = typeof options.execImpl === 'function'
    ? options.execImpl
    : (command, args, runOptions) => runProcess(command, args, runOptions, options.execFileImpl);

  let result;
  try {
    result = await run('powershell.exe', [...PS_ARGS, scriptPath], { env, timeout, windowsHide: true });
  } catch (err) {
    return { ok: false, reason: '起不来确认框进程：' + String((err && err.message) || err), code: 'ask-failed' };
  }
  if (!result) return { ok: false, reason: '确认框进程没有返回结果', code: 'ask-failed' };
  if (result.timedOut) {
    return { ok: false, reason: '确认框超时（' + timeout + ' ms）：没有人点按钮', code: 'ask-timeout' };
  }
  // 6/7/8 是**业务退出码**；execFile 对非零退出会给 err，所以先看 code。
  if (result.code === ASK_EXIT.FIX) return { ok: true, value: 'fix' };
  if (result.code === ASK_EXIT.LATER) return { ok: true, value: 'later' };
  if (result.code === ASK_EXIT.IGNORE) return { ok: true, value: 'ignore' };
  const detail = String((result.stderr || result.error || '') || '').trim();
  return {
    ok: false,
    reason: '确认框失败（退出码 ' + String(result.code) + '）'
      + (detail ? '：' + detail.slice(0, 200) : ''),
    code: 'ask-failed',
  };
}
