// 本文件由工作区工具 tools/build-veneer-client.mjs 从 <包>/ 下列 3 个模块拼接生成：
//   model/acl.js , ui/config-page.js , client.js
// **不要手改**：改源码后重跑构建。 src=a35210571bd1
(function () {
"use strict";

// ===== model/acl.js =====
// dsh-veneer —— 数据形状（model 层：只放形状与纯归一，不做 IO、不做判断）
//
// 三张形状：
//   · **签名**（signature）：一个对象的物化三项长什么样——`{ cap, denyDC, denyDCInherit, label }`；
//   · **判缺**（deficit）：这个对象缺哪几项、为什么跳过；
//   · **报告**（report）：写进工作区的那份 JSON。

/** 三项的名字（报告与执行侧脚本共用同一套词，别另起一套）。 */
const ITEM = Object.freeze({
  CAP: 'cap',       // 工作区能力 ACE（读根 SD 里的 SID，照抄）
  DENY_DC: 'denyDC', // 目录上的 `Everyone` 拒绝 FILE_DELETE_CHILD
  LABEL: 'label',   // Low 完整性标签
});

/** 报告版本：形状一变就升（执行侧脚本与将来的 UI 读它）。 */
const REPORT_VERSION = 1;

/**
 * 报告在工作区里的**默认相对路径**（宿主写、面板读）。
 * 只此一处：`config/defaults.js` 与界面半边都引它，别各写一份。
 */
const REPORT_REL_PATH = 'review/veneer-state.json';

/** 三种整体状态。 */
const STATUS = Object.freeze({
  OK: 'ok',             // 根齐、子树也都齐
  INCOMPLETE: 'incomplete', // 有对象缺三项（需要用户执行修复命令）
  ROOT_ABSENT: 'root-absent', // 根上没物化三项 → 属于宿主，本插件不动手
  PARTIAL: 'partial',   // 扫不全（读不了某些子树），结论不完整
  UNSUPPORTED: 'unsupported', // 非 Windows
  UNKNOWN: 'unknown',   // 还没扫过
});

/**
 * 一项被算作"已有"的判据（三项统一口径）：
 *   · cap    —— 根 SID 有一条第 `Allow` 职责位含写（`W` 或 `WD`）的 ACE；
 *   · denyDC —— 有一条 `S-1-1-0` 的 `Deny` ACE，且是删除子项位（`DC` 或 `D`）；
 *   · label  —— 完整性标签是 `Low`。
 * **显式与继承都算**：是否带 `(I)` 只作为签名的一部分记下来，**判缺不看它**。
 * 这么定的原因：只补"真的没有"的项。把已经从根继承来的再补一遍，会在 `icacls` 里留一组重复 ACE
 * （2026-11-20 在 `D:\agent-collab-1\公共信息库\` 亲眼见到）。
 */
const SAME_ITEM_RULES = Object.freeze({
  cap: 'any Allow ACE for the root capability SID with write data (W or WD)',
  denyDC: 'any Deny ACE for Everyone (S-1-1-0) with delete-child (DC or D)',
  label: 'integrity label Low',
});

/** 跳过原因（报告里的 `reason` 就取这些词，便于按词统计）。 */
const SKIP = Object.freeze({
  REPARSE: 'reparse-point',      // reparse point（junction / symlink / mount）：官方也管不全
  NO_ACL_READ: 'acl-unreadable', // 读不到 SD（权限不足）
});

/**
 * 归一一处 ACL 读取结果。输入来自执行侧脚本（`inspect` 命令）的原样输出。
 *
 * @param {object} raw
 * @returns {{path:string, isDir:boolean, signature:object, error?:string}|null}
 */
function normalizeObject(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string') return null;
  const cap = raw.cap === true;
  const denyDC = raw.denyDC === true;
  const label = raw.label === 'low' ? 'low' : (raw.label === 'medium' ? 'medium' : null);
  const signature = {
    cap,
    denyDC,
    denyDCInherit: raw.denyDCInherit === true,
    label,
  };
  const obj = {
    path: raw.path,
    isDir: raw.isDir === true,
    signature,
  };
  if (typeof raw.error === 'string' && raw.error) obj.error = raw.error;
  return obj;
}


// ===== ui/config-page.js =====
// dsh-veneer —— 插件页的「检查沙箱物化」面板（界面半边：**只读展示**）
//
// 形态：`plugins.row.config`（插件管理页里 dsh-veneer 那一行的配置页）里的一块。
//
// **它只读，不触发扫描。** 原因（查实过，别再试）：
//   · 浏览器侧没有写工作区文件的通道（`remote.workspaceFiles` 只有读）；
//   · 插件包没有 Typert 生成，界面拿不到自己的 RPC。
// 所以扫描由**宿主在打开工作区时**做一次（`scanOnMount`），面板读那份报告。
// 要再扫一次：重开工作区/重开 DSH，或用执行侧的 `-Apply` 干跑（只读）。
//
// 纪律（都真踩过）：
//   · 组件签名是 `(props)`，**React 从 `props.React` 取**；缺了就返回 null（不要这时候调 hooks）；
//   · **不读未声明的 ctx 服务**（真环境是代理，读未声明属性会抛，组件会整块消失）；
//   · 只读文件用 `remote.workspaceFiles.read(path, {}, signal)`（官方两参形状；老代码写过三参）；
//   · 不写 DOM、不 import Harness 客户端包、只用 `--dsw-alias-*` token。


/** 客户端要注入的服务：只用远端命名空间（已声明过的），不碰别的。 */
const CLIENT_INJECT = ['slots', 'remote', 'remote.workspaceFiles'];

/** 小摘要的相对路径（宿主写在报告旁边；见 core/persist.js 的 `summaryRelOf`）。 */
const SUMMARY_REL = 'review/veneer-summary.json';

/** 配置页在 Slots 里的 key：`<包名>#<行 id>`（与 cordis.patch.yml 的行 id 一致）。 */
const SLOT_KEY = 'dsh-veneer#veneer';

/** 主题 token（只用 `--dsw-alias-*`）。 */
const TOKENS = {
  text: 'var(--dsw-alias-text-1, #1f2328)',
  muted: 'var(--dsw-alias-text-2, #57606a)',
  border: 'var(--dsw-alias-border-1, #d0d7de)',
  bg: 'var(--dsw-alias-bg-2, #f6f8fa)',
  good: 'var(--dsw-alias-state-success, #1a7f37)',
  warn: 'var(--dsw-alias-state-warning, #9a6700)',
  bad: 'var(--dsw-alias-state-danger, #cf222e)',
};

/** 报告 → 一行人话 + 颜色。 */
function describeResult(result) {
  if (!result || typeof result !== 'object') return { text: '还没查过', tone: 'muted' };
  const counts = result.counts || {};
  switch (result.status) {
    case 'ok':
      return { text: '物化完整：' + (counts.checked || 0) + ' 个对象三项都齐', tone: 'good' };
    case 'incomplete':
      return {
        text: '还缺 ' + (counts.missing || 0) + ' 个对象（checked ' + (counts.checked || 0)
          + ' / skipped ' + (counts.skipped || 0) + '）',
        tone: 'warn',
      };
    case 'root-absent':
      return {
        text: '工作区根上没有物化三项（' + ((result.rootMissing || []).join(', ') || '未知') + '）——这是宿主的活',
        tone: 'muted',
      };
    case 'partial': {
      const failed = counts.failed || 0;
      return { text: '扫不全（' + failed + ' 处失败），结论不完整', tone: 'warn' };
    }
    default:
      return { text: String(result.summary || '未知结论'), tone: 'muted' };
  }
}

/** 缺项明细（最多列 5 条，避免面板变成日志）。 */
function describeMissing(report) {
  const objects = (report && (Array.isArray(report.missing) ? report.missing
    : (Array.isArray(report.objects) ? report.objects : []))) || [];
  if (!objects.length) return [];
  const lines = objects.slice(0, 5).map((o) => {
    const missing = Array.isArray(o.missing) ? o.missing.join('/') : '';
    return (o.isDir ? '目录 ' : '文件 ') + String(o.path || '') + '  缺 ' + missing;
  });
  if (report && report.more > 0) lines.push('…还有 ' + report.more + ' 个');
  else if (objects.length > 5) lines.push('…还有 ' + (objects.length - 5) + ' 个');
  return lines;
}

/**
 * 造客户端插件。
 * @param {{React:object, ctx:object}} input
 */
function createClientPlugin({ React, ctx }) {
  const closureReact = React;

  /** 读一次报告文件。读不到是正常情况（还没扫过），不抛；失败原因攒起来给面板显示。 */
  const readReport = async () => {
    let files;
    try { files = ctx && ctx.remote && ctx.remote.workspaceFiles; } catch { files = null; }
    if (!files || typeof files.read !== 'function') {
      return { ok: false, reason: '没有文件读通道（remote.workspaceFiles 不可用）', tried: [] };
    }
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(8000) : undefined;
    // 先读小摘要（几 KB，真机更稳），再退到整份报告。
    const filesToTry = [SUMMARY_REL, REPORT_REL_PATH];
    const tried = [];
    for (const rel of filesToTry) {
      const attempts = [
        ['read(path)', () => files.read(rel, {}, signal)],
        ['read(path, opts)', () => files.read(rel, {})],
      ];
      for (const [label, call] of attempts) {
        try {
          const res = await call();
          const value = res && res.ok === true && res.value !== undefined ? res.value : res;
          const text = typeof value === 'string'
            ? value
            : (value && typeof value.text === 'string' ? value.text : null);
          if (text === null) { tried.push(rel + ' ' + label + '：返回形状没有 text'); continue; }
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') return { ok: true, report: parsed, from: rel };
        } catch (err) {
          tried.push(rel + ' ' + label + '：' + String((err && err.message) || err).slice(0, 120));
        }
      }
    }
    return { ok: false, reason: '读不到报告（宿主可能还没扫）', tried };
  };

  const Panel = (props) => {
    const R = (props && props.React) || closureReact;
    if (!R || typeof R.createElement !== 'function' || typeof R.useState !== 'function') return null;
    const e = R.createElement;
    const [state, setState] = R.useState({ phase: 'init', text: '正在读报告…', tone: 'muted', report: null });

    const load = async () => {
      setState({ phase: 'loading', text: '正在读报告…', tone: 'muted', report: null, tried: [] });
      const got = await readReport();
      if (!got.ok) {
        setState({ phase: 'none', text: got.reason, tone: 'muted', report: null, tried: got.tried || [] });
        return;
      }
      const line = describeResult(got.report);
      setState({ phase: 'done', text: line.text, tone: line.tone, report: got.report, tried: [], from: got.from });
    };

    if (typeof R.useEffect === 'function') {
      R.useEffect(() => { void load(); }, []);
    }

    const report = state.report;
    const details = report ? describeMissing(report) : [];
    const scannedAt = report && typeof report.scannedAt === 'number'
      ? new Date(report.scannedAt).toLocaleString() : '';

    return e('div', {
      style: {
        display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
        border: '1px solid ' + TOKENS.border, borderRadius: 8, background: TOKENS.bg,
      },
    }, [
      e('div', { key: 'title', style: { fontWeight: 600, color: TOKENS.text } }, '检查沙箱物化'),
      e('div', { key: 'desc', style: { fontSize: 12, color: TOKENS.muted } },
        '只读：宿主在打开工作区时扫一次，看哪些既有对象缺了物化三项（能力 ACE / Everyone 拒删子项 / Low 标签）。'
        + '要再扫一次，重开工作区（或重开 DSH）。'),
      e('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
        e('button', {
          key: 'btn', type: 'button', onClick: () => { void load(); },
          style: {
            padding: '4px 12px', borderRadius: 6, border: '1px solid ' + TOKENS.border,
            background: TOKENS.text, color: '#fff', cursor: 'pointer',
          },
        }, '重新读取'),
        e('span', { key: 'msg', style: { fontSize: 12, color: TOKENS[state.tone] || TOKENS.muted } }, state.text),
      ]),
      details.length
        ? e('div', { key: 'details', style: { fontSize: 12, color: TOKENS.muted, whiteSpace: 'pre-wrap', fontFamily: 'monospace' } }, details.join('\n'))
        : null,
      report
        ? e('div', { key: 'report', style: { fontSize: 12, color: TOKENS.muted } },
          '来源：' + (state.from || REPORT_REL_PATH) + (scannedAt ? '（扫描于 ' + scannedAt + '）' : ''))
        : null,
      // 读不到时把**每次尝试的原因**摊开：这样不用开 DevTools 也知道卡在"没通道 / 文件不存在 / 形状不对"。
      !report && state.tried && state.tried.length
        ? e('div', {
          key: 'tried',
          style: { fontSize: 12, color: TOKENS.muted, whiteSpace: 'pre-wrap', fontFamily: 'monospace' },
        }, state.tried.join('\n'))
        : null,
    ].filter(Boolean));
  };

  return {
    inject: CLIENT_INJECT,
    apply(inner) {
      const slots = (inner && inner.slots) || (ctx && ctx.slots);
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        return () => {};
      }
      // 第一个参数是**插槽名**（`slots.inject(slotName, cb)`），不是 key（2026-11-20 真机踩过）。
      slots.inject('plugins.row.config', () => slots.register({ name: 'plugins.row.config', key: SLOT_KEY }, Panel));
      return () => {};
    },
  };
}


// ===== client.js =====
// dsh-veneer —— 界面半边入口：**只装配**
//
// 客户端模块的形状（照官方模板）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … return { inject, apply } } })
// React 从**浏览器模块表**取（`require('react')`），不自己装一份。
//
// **平台按 classic script 加载界面插件**（不是 ES 模块）：发布的是 `lib/client.js`，
//   由工作区工具 `tools/build-veneer-client.mjs` 从本文件 + `ui/*.js` + 它们的相对依赖拼接生成。
//   改界面源码后必须重新生成，否则跑的是旧代码。


if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-veneer',
    factory(require) {
      const React = require('react');
      return {
        inject: CLIENT_INJECT,
        apply(ctx) {
          const plugin = createClientPlugin({ React, ctx });
          return plugin.apply(ctx);
        },
      };
    },
  });
}

})();