// dsh-veneer —— 稳定错误码（纯常量：不 import 任何层，不放业务判断）
//
// 纪律与 dsh-milieu 相同：**码值一旦发布就不改，只增**；`unknown` 只是兜底，不当分类用。
// 这里的码覆盖三类失败：宿主服务、读 ACL（执行侧进程）、写报告。

export const CODES = Object.freeze({
  // ---- 宿主 ----
  HOST_UNAVAILABLE: 'host-unavailable',
  HOST_CALL_FAILED: 'host-call-failed',

  // ---- 平台 ----
  UNSUPPORTED_PLATFORM: 'unsupported-platform', // 非 Windows：物化三项是 NTFS 语义，无处可谈

  // ---- 读 ACL（adapter/acl.js 起 pwsh 的结果） ----
  ACL_READ_FAILED: 'acl-read-failed',       // 执行侧进程没起来 / 非零退出 / 输出不是 JSON
  ACL_OUTPUT_INVALID: 'acl-output-invalid', // 输出解析失败或形状不对

  // ---- 报告 ----
  FS_UNAVAILABLE: 'fs-unavailable',
  FS_READ_FAILED: 'fs-read-failed',
  FS_WRITE_FAILED: 'fs-write-failed',

  // ---- 配置 ----
  CONFIG_INVALID: 'config-invalid',

  // ---- 兜底 ----
  UNKNOWN: 'unknown',
});

/** 是不是一个稳定错误码（挡住平台的 `ENOENT` 之类混进来当分类）。 */
export function isKnownCode(code) {
  if (typeof code !== 'string') return false;
  for (const value of Object.values(CODES)) if (value === code) return true;
  return false;
}
