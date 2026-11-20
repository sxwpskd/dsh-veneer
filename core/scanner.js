// dsh-veneer —— 手动扫一次（核心层：一个工作区实例共用的"现在再查一遍"）
//
// 为什么要有它：挂载时扫一次不够用。用户可能在"打开工作区之后"才搬进旧内容，
//   也可能想在看报告之前**主动确认一次**。菜单项「检查沙箱物化」调的就是这里。
//
// 纪律：
//   · **单飞**：同一实例上同时在跑的扫描只允许一个；后来的请求复用同一个 Promise，
//     不排队、不并发（一次扫描要起 PowerShell，并发只会互相抢资源）；
//   · 扫描自己失败不崩：返回带原因的结果，调用方负责报告；
//   · 扫描期间记一份"最近一次结果"，供界面在扫描进行中先展示旧结论。
import { guardAsync } from '../exception/guard.js';
import { runScan } from './scan.js';

/**
 * @param {{acl:object, fs:object, packageDir:string, commandPath:string, listLimit?:number, cfg:object, log:object}} deps
 *   · `cfg` 是**已归并**的配置（含 reportPath / scanTimeoutMs / listLimit）；
 *   · `root` 由调用方给（扫描时才知道的工作区根）。
 */
export function createScanner(deps) {
  let inFlight = null;
  let last = null;

  const execute = (root) => guardAsync('手动扫描', async () => {
    const result = await runScan({
      acl: deps.acl,
      fs: deps.fs,
      commandPath: deps.commandPath,
      listLimit: deps.listLimit,
    }, { root, reportPath: deps.cfg.reportPath });
    if (result && result.ok === true) {
      last = { at: Date.now(), root, value: result.value };
    }
    return result;
  }, {
    log: deps.log,
    blockedBy: 'host',
  });

  return {
    /**
     * 现在扫一次。并发请求返回**同一个** Promise。
     * @param {string} root
     * @returns {Promise<{ok:true,value:object}|{ok:false,reason:string}>}
     */
    request(root) {
      if (inFlight) return inFlight;
      inFlight = execute(root).finally(() => { inFlight = null; });
      return inFlight;
    },

    /** 扫描是否在进行中。 */
    busy() {
      return inFlight !== null;
    },

    /** 最近一次成功扫描（给界面先展示旧结论用）；没有就是 null。 */
    lastResult() {
      return last;
    },
  };
}
