// dsh-veneer —— 读 ACL（平台层：**唯一允许起外部进程的地方**）
//
// 这里只做三件事：
//   ① 起一个**只读**子进程，跑脚本文件 `scripts/dsh-veneer-inspect.ps1`；
//   ② 把它的 JSON 解析成 model/acl.js 的形状；
//   ③ 失败返回带原因的结果（不吞错）。
//
// 为什么用脚本文件而不是 `-Command "内联脚本"`：
//   · 内联脚本要塞进命令行参数，Windows 下 `"` / `%` / 换行的转义规则很容易把一个
//     "只读探针"变成一次看不懂的失败；
//   · 脚本文件是**可复核的实物**——用户能打开看它到底做了什么，这比"插件里藏一段命令"可信。
//
// 三条纪律：
//   · **只读**：inspect 脚本只 `Get-ChildItem` / `Get-Acl` / `icacls`（不带任何写参数）；
//   · 参数只传 base64 的 JSON（`-InputJson`），不做字符串拼命令；
//   · 失败必须说清被什么挡住（powershell 不在 / 超时 / 非零退出 / 输出不是 JSON）。
//
// 输出形状（与 model/acl.js 对齐）：
//   { objects: [{ path, isDir, cap, denyDC, denyDCInherit, label, error }], skipped: [], errors: [], truncated: bool }
//
// 两条 PowerShell 5.1 实测（2026-11-20，别重犯）：
//   ① `-File` 会把 `-InputJson '<json>'` 的引号剥掉 → 原始 JSON 到脚本里已经碎了
//      （`Invalid JSON primitive: inspect`）。所以载荷走 **base64 + 环境变量**；
//   ② `-Command "& '<脚本>'"` 时顶层 `$args` 传不进脚本块（`& { }` 有自己的作用域）——
//      环境变量是唯一不经过任何引号层的通道。
import { execFile } from 'node:child_process';
import { CODES } from '../exception/codes.js';
import { fail, ok, isFail } from '../exception/result.js';
import { normalizeObject } from '../model/acl.js';

/** Windows 上 powershell.exe 的默认参数：不载 profile、不交互、放行脚本。 */
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** 载荷环境变量的名字（脚本读它；名字一起改）。 */
const PAYLOAD_ENV = 'DSH_VENEER_INPUT';

/**
 * 造 ACL 读取能力。
 * @param {{scriptPath:string, execFileImpl?:Function, timeoutMs?:number, powershell?:string}} options
 *   · `scriptPath` 必填：inspect 脚本的绝对路径（由入口按包目录算出来）；
 *   · `execFileImpl` 留给测试注入（默认 `node:child_process.execFile`）；
 *   · `timeoutMs` 单次读取超时。
 */
export function createAclReader(options = {}) {
  const run = typeof options.execFileImpl === 'function' ? options.execFileImpl : execFile;
  const timeout = typeof options.timeoutMs === 'number' ? options.timeoutMs : 60000;
  const shell = typeof options.powershell === 'string' ? options.powershell : 'powershell.exe';
  const scriptPath = typeof options.scriptPath === 'string' ? options.scriptPath : '';

  /** 起一次只读子进程，返回解析后的 JSON。 */
  const query = (payload) => new Promise((resolve) => {
    if (!scriptPath) {
      resolve(fail('缺少 inspect 脚本路径（包目录解析失败）', 'acl', CODES.ACL_READ_FAILED));
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      // **载荷用 base64 + 环境变量传**（两条 PS 5.1 实测，见文件头）：base64 只含 ASCII，
      // 环境变量不经过任何命令行引号层，`& '<脚本>'` 里读得到的只有它。
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      const env = { ...process.env };
      env[PAYLOAD_ENV] = encoded;
      child = run(shell, [...PS_ARGS, '& "' + scriptPath + '"'], {
        env,
        timeout,
        windowsHide: true,
        maxBuffer: 512 * 1024 * 1024,
      }, (err, stdout) => {
        if (err) {
          const reason = err.killed
            ? '读 ACL 超时（' + timeout + ' ms）：' + payload.root
            : '读 ACL 失败（' + (err.code || err.message) + '）：' + payload.root;
          finish(fail(reason, 'acl', CODES.ACL_READ_FAILED));
          return;
        }
        const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
        if (!text) {
          finish(fail('读 ACL 没有输出：' + payload.root, 'acl', CODES.ACL_OUTPUT_INVALID));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          finish(fail('读 ACL 的输出不是 JSON：' + text.slice(0, 200), 'acl', CODES.ACL_OUTPUT_INVALID));
          return;
        }
        finish(ok(parsed));
      });
    } catch (error) {
      finish(fail('起不来读 ACL 的进程：' + String((error && error.message) || error), 'acl', CODES.ACL_READ_FAILED));
      return;
    }
    // 不需要 stdin；关掉它，免得子进程等输入。
    try { child.stdin.end(); } catch { /* 没有 stdin 也无所谓 */ }
  });

  /** 原样标准化的对象数组。 */
  const toObjects = (raw) => {
    const out = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const normalized = normalizeObject(item);
      if (normalized) out.push(normalized);
    }
    return out;
  };

  return {
    /** 只读根的签名。 */
    async inspect({ targets }) {
      const root = Array.isArray(targets) && targets.length ? targets[0] : '';
      const result = await query({ mode: 'inspect', root, limit: 0 });
      if (isFail(result)) return result;
      const objects = toObjects(result.value && result.value.objects);
      return objects.length ? ok({ objects }) : fail('读根没有返回对象：' + root, 'acl', CODES.ACL_OUTPUT_INVALID);
    },

    /** 读整棵树（根 + 子孙；`objects` 里只返回子孙，根已单独读过）。 */
    async expand({ root, limit }) {
      const result = await query({ mode: 'expand', root, limit: typeof limit === 'number' ? limit : 0 });
      if (isFail(result)) return result;
      const value = result.value || {};
      const all = Array.isArray(value.objects) ? value.objects : [];
      return ok({
        objects: toObjects(all.slice(1)),
        listErrors: Array.isArray(value.errors) ? value.errors : [],
        skipped: Array.isArray(value.skipped) ? value.skipped : [],
        truncated: value.truncated === true,
      });
    },
  };
}
