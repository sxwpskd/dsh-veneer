#!/usr/bin/env node
// dryrun —— 离线跑一遍"采集 → 判缺 → 报告 → 命令"，用**真执行侧脚本**读 ACL，不写工作区。
//
// 为什么不写：
//   · 这是开发/排查用的干跑口，结论打在 stdout；
//   · 报告落盘的行为由插件在挂载时做，这里的 `--write` 只是可选的验证。
//
// 用法：
//   node tools/dryrun.mjs [--root <路径>] [--write] [--limit <n>]
//   默认 root = 当前目录（用 --root 指一个**有既有子树**的工作区才有意义）
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAclReader } from '../adapter/acl.js';
import { createFs } from '../adapter/fs.js';
import { scriptPathOf, INSPECT_SCRIPT } from '../core/command-path.js';
import { runScan } from '../core/scan.js';
import { describeMissing } from '../core/command.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = dirname(HERE);
const APPLY = scriptPathOf(PACKAGE_DIR);

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const root = resolve(opt('--root', process.cwd()));
const write = args.includes('--write');
const limit = Number(opt('--limit', '50000'));

const acl = createAclReader({ scriptPath: scriptPathOf(PACKAGE_DIR, INSPECT_SCRIPT) });
const fs = createFs();
// 干跑时把"存在/写"按住：结论只打 stdout。`--write` 才真的落盘（验证去重与原子写）。
const sandboxFs = write ? fs : {
  readText: () => { throw new Error('dryrun: 不读'); },
  exists: () => false,
  mkdirp: () => {},
  writeTextAtomic: () => {},
  dirnameOf: fs.dirnameOf,
};
const reportPath = 'review/veneer-state.json';

const started = Date.now();
const result = await runScan({
  acl,
  fs: sandboxFs,
  commandPath: APPLY,
  listLimit: limit,
}, { root, reportPath });

const ms = Date.now() - started;
if (!result.ok) {
  console.log('failed: ' + result.reason + '（' + (result.blockedBy || 'unknown') + '）');
  process.exit(1);
}
const value = result.value;
console.log('root    ' + root);
console.log('status  ' + value.status);
console.log('counts  checked ' + value.counts.checked + ' / missing ' + value.counts.missing
  + ' / skipped ' + value.counts.skipped + ' / failed ' + value.counts.failed);
console.log('items   ' + describeMissing(value.missingItems));
if (value.rootMissing.length) console.log('rootMissing ' + value.rootMissing.join(', '));
if (write) console.log('report  ' + (value.written ? '已写 ' : '未变 ') + value.reportPath);
if (value.command) console.log('command ' + value.command);
console.log('ms      ' + ms);
