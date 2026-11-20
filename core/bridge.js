// dsh-veneer —— 本地桥（手动入口 ↔ 扫描器）
//
// 为什么有这一层：插件包本身不带界面代码，**点菜单发不了任何 RPC**；而"点一下马上出结果"
// 需要界面和宿主说上话。桥就是两者的接点：
//   · 界面（插件页里的"检查沙箱物化"按钮）写一个请求文件；
//   · 宿主这边订阅文件系统，看到请求就扫一次，把结论写进响应文件；
//   · 界面轮询响应文件，读到结论就显示。
//
// 但它**两条腿都要能走**：桥只在本机 Windows 上跑；非 Windows / 没有宿主文件服务时，
//   `submit()` 直接返回失败原因（"这台机器没法点一下就出结果"），**不假装成功**。
//
// 位置：`<工作区>/.dsh-veneer/`（与 dsh-milieu 的 `.dsh-milieu/` 同一条纪律：插件产物在自己的目录里）。
import { join } from 'node:path';

/** 桥的目录名（在工作区里）。 */
export const BRIDGE_DIR = '.dsh-veneer';
/** 请求 / 响应文件名。 */
export const REQUEST_FILE = 'request.json';
export const RESULT_FILE = 'result.json';

/** 桥的绝对目录。 */
export function bridgeDirOf(root) {
  return join(String(root), BRIDGE_DIR);
}

/** 请求文档（界面写、宿主读）。`id` 由界面生成，宿主原样回填。 */
export function makeRequest(id, at = Date.now()) {
  return { version: 1, kind: 'scan', id: String(id || ''), at };
}

/**
 * 从任意读到的 JSON 里取一个"扫描请求"；不是请求 → null（宿主别把垃圾当命令）。
 * @returns {{id:string, at:number}|null}
 */
export function parseRequest(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind !== 'scan') return null;
  const id = typeof value.id === 'string' ? value.id : '';
  if (!id) return null;
  const at = typeof value.at === 'number' ? value.at : 0;
  return { id, at };
}

/**
 * 响应文档（宿主写、界面读）。**只放结论，不放绝对路径**——它可能被复制出去。
 * @param {string} id 对应请求的 id
 * @param {{ok:boolean, reason?:string, value?:object}} result runScan 的结果
 */
export function makeResult(id, result, at = Date.now()) {
  const base = { version: 1, kind: 'scan-result', id: String(id || ''), at, finishedAt: at };
  if (!result || result.ok !== true) {
    return { ...base, ok: false, reason: String((result && result.reason) || '未知原因') };
  }
  const value = result.value || {};
  return {
    ...base,
    ok: true,
    status: String(value.status || ''),
    summary: String(value.summary || ''),
    counts: value.counts || {},
    missingItems: value.missingItems || {},
    rootMissing: Array.isArray(value.rootMissing) ? value.rootMissing : [],
    command: typeof value.command === 'string' ? value.command : '',
    reportPath: typeof value.reportPath === 'string' ? value.reportPath : '',
    written: value.written === true,
  };
}

/**
 * 桥的轮询与提交 **只依赖一个最小文件面**（与现有 fs 能力对象兼容）：
 *   readText / writeTextAtomic / exists
 * @param {{fs:object, scanner:{request:(root:string)=>Promise<object>}, root:string, log:object, pollMs?:number, onOpen?:(path:string)=>object}} deps
 */
export function createBridge(deps) {
  const dir = bridgeDirOf(deps.root);
  const requestPath = join(dir, REQUEST_FILE);
  const resultPath = join(dir, RESULT_FILE);
  const pollMs = typeof deps.pollMs === 'number' && deps.pollMs > 0 ? deps.pollMs : 1000;
  let timer = null;
  let stopped = false;
  let lastRequestId = '';
  let running = false;

  const readJson = (path) => {
    try {
      if (!deps.fs.exists(path)) return null;
      return JSON.parse(deps.fs.readText(path));
    } catch {
      return null;
    }
  };

  const writeJson = (path, value) => {
    try {
      deps.fs.writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n');
      return true;
    } catch (err) {
      deps.log.warn('桥写不进去（' + path + '）：' + String((err && err.message) || err));
      return false;
    }
  };

  /** 处理一次：有请求且是新请求 → 扫一次 → 写结论。 */
  const tick = async () => {
    if (stopped || running) return;
    const request = parseRequest(readJson(requestPath));
    if (!request || request.id === lastRequestId) return;
    running = true;
    lastRequestId = request.id;
    try {
      const result = await deps.scanner.request(deps.root);
      const wrote = writeJson(resultPath, makeResult(request.id, result));
      deps.log.info('手动检查 ' + (wrote ? '完成' : '完成但结论没写进去') + '：'
        + (result && result.ok === true ? result.value.summary : String((result && result.reason) || '未知原因')));
    } catch (err) {
      deps.log.warn('手动检查失败：' + String((err && err.message) || err));
    } finally {
      running = false;
    }
  };

  return {
    /** 开始轮询（只有轮询，不主动扫）。 */
    start() {
      if (timer !== null || stopped) return;
      timer = setInterval(() => { void tick(); }, pollMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },

    /** 立刻处理一次（文件服务可能没走 watcher）。 */
    tick,

    /** 停止轮询。 */
    stop() {
      stopped = true;
      if (timer !== null) {
        try { clearInterval(timer); } catch { /* 停不下来不影响卸载 */ }
        timer = null;
      }
    },

    /** 把工作区里的一个文件交给宿主打开（界面点到"在资源管理器里看"时用）。 */
    open(path) {
      if (typeof deps.onOpen === 'function') return deps.onOpen(path);
      return { ok: false, reason: '这台机器不提供打开文件' };
    },

    paths: { dir, requestPath, resultPath },
  };
}
