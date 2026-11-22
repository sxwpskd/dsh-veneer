#!/usr/bin/env node
// 边界检查（exit 0 才算过）：
//   ① 宿主服务名 / `ctx.get(` / 本机路径不许出现在 adapter/ 之外（tests/、tools/、scripts/ 除外）；
//   ② apply 脚本不能**打印**完整路径：它的输出可能被写进日志/报告，本机路径就漏进插件；
//      报路径时只打印相对根的路径。
//
// 用法：node tools/check.mjs [目录]    （默认检查本包根）
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ? resolve(process.argv[2]) : join(HERE, '..');

/** 小工具：白名单展开时容错读（缺路径要报成检查失败，不要抛）。 */
const existsSyncSafe = (p) => existsSync(p);
const statSafe = (p) => { try { return statSync(p); } catch { return null; } };
const readdirSafe = (p) => { try { return readdirSync(p); } catch { return []; } };
const SKIP = new Set(['adapter', 'tests', 'tools', 'scripts', 'lib', 'node_modules', '.git']);
const SKIP_EXT = new Set(['.ps1', '.md', '.json', '.yml', '.yaml']);
const FORBIDDEN = [
  ['workspaceRegistry', '宿主服务名（只许出现在 adapter/）'],
  ['sessionController', '宿主服务名（只许出现在 adapter/）'],
  ['agentLoop', '宿主服务名（只许出现在 adapter/）'],
  ['ctx.get(', '真机上取不到服务（用 inject 回调里的 ctx 属性）'],
  ['D:\\DSH', '本机路径不许进插件'],
  ['D:/DSH', '本机路径不许进插件'],
];

const hits = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) { walk(path); continue; }
    const ext = extname(name);
    if (!['.js', '.mjs', '.cjs'].includes(ext) || SKIP_EXT.has(ext)) continue;
    const text = readFileSync(path, 'utf8');
    const rel = path.slice(ROOT.length + 1).replace(/\\/g, '/');
    for (const [needle, why] of FORBIDDEN) {
      if (text.includes(needle)) hits.push({ file: rel, needle, why });
    }
  }
}

walk(ROOT);

// ② apply 脚本的"输出里不许带完整路径"（报路径用相对根的路径）
const applyPath = join(ROOT, 'scripts', 'dsh-veneer-apply.ps1');
try {
  const text = readFileSync(applyPath, 'utf8');
  const writeLines = text.split(/\r?\n/).filter((line) => /Write-(Line|Err)/.test(line) && !line.trim().startsWith('#'));
  // 把这些路径变量**裸着**打出去的写法都算漏（套在 Get-Relative 里的不算）。
  const withFullPath = writeLines.filter((line) => /(^|[^-\w])\$(sig|item)\.(path|FullName)\b|\$entry\.path\b/.test(line)
    && !/Get-Relative/.test(line));
  if (withFullPath.length) {
    hits.push({ file: 'scripts/dsh-veneer-apply.ps1', needle: '打印完整路径', why: '输出可能进日志/报告：报路径只用 Get-Relative 的相对路径' });
  }
  // ③ apply 脚本不许给 PowerShell 的自动变量赋值（`$args` / `$input` …）：一旦赋值，
  //    函数体里的同名变量会被"当前作用域已存在的 $args"盖住，结果是静默空数组（2026-11-20 实测）。
  const autoVars = ['args', 'input', 'error', 'matches', 'this'];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith('#')) continue;
    for (const name of autoVars) {
      const re = new RegExp('\\$' + name + '\\s*=\\s*[^=]');
      if (re.test(line)) {
        hits.push({ file: 'scripts/dsh-veneer-apply.ps1:' + (i + 1), needle: '$' + name, why: 'PowerShell 自动变量，禁止赋值' });
      }
    }
  }
} catch (err) {
  if (!(err && err.code === 'ENOENT')) throw err;
}

// ④ **files 白名单必须覆盖运行时的相对 import 闭包**（2026-11-22 真机事故）
//    `files` 里漏了 `log/`，pnpm 按白名单打包 git 依赖 → 装好的包没有 `log/logger.js` →
//    宿主激活时 `Cannot find module .../log/logger.js`。这里把"装出来的包能不能 import 通"
//    变成静态检查：白名单展开后的文件集合，必须包含所有被它们相对引用到的文件。
{
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')); } catch { pkg = null; }
  if (pkg && Array.isArray(pkg.files)) {
    const shipped = new Set();
    const addPath = (rel) => {
      const p = join(ROOT, rel);
      if (!existsSyncSafe(p)) { hits.push({ file: 'package.json', needle: rel, why: '白名单里的路径不存在' }); return; }
      const st = statSafe(p);
      if (st && st.isDirectory()) {
        for (const name of readdirSafe(p)) addPath(rel.replace(/\/$/, '') + '/' + name);
      } else {
        shipped.add(rel.replace(/\\/g, '/'));
      }
    };
    for (const entry of pkg.files) addPath(String(entry));
    const importsOf = (file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const specs = [];
      for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) specs.push(m[1]);
      for (const m of text.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)) specs.push(m[1]);
      return specs;
    };
    for (const file of shipped) {
      if (!['.js', '.mjs'].includes(extname(file))) continue;
      for (const spec of importsOf(file)) {
        const target = normalize(join(dirname(file), spec)).replace(/\\/g, '/');
        if (!shipped.has(target)) {
          hits.push({
            file: file,
            needle: spec,
            why: '被引用的文件不在 files 白名单里：装出来的包会 Cannot find module（把它的目录加进 files）',
          });
        }
      }
    }
  }
}

if (hits.length) {
  console.error('边界检查失败：');
  for (const hit of hits) console.error('  ' + hit.file + ' —— `' + hit.needle + '`：' + hit.why);
  process.exit(1);
}
console.log('边界检查通过：宿主名词 / 本机路径只出现在 adapter/（tests/、tools/、scripts/ 除外）；apply 输出不带完整路径。');
