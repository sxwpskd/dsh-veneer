// dsh-veneer —— 配置编辑器适配（**宿主名词只在这里**：`configEditor`）
//
// 用途只有一件（"弹窗里勾了『以后不再检查本工作区』"这条路）：
//   · `entries()` 找到**本插件自己的 Loader 行**（`entry.id === 'include:veneer'`）；
//   · `editWorkspacesRemove()` 把工作区从该行配置的 `workspaces` 里去掉（下一轮 Loader 重规划时它就不在范围里）。
//
// `workspaces` 的约定（2026-11-23 简化后）：**空数组 = 管理平台全部工作区**，非空 = 只这些。
// 所以"去掉一个"有两种写法：列表非空 → 直接过滤；列表为空（全管）→ 用平台表展开后去掉它。
// 只剩一个工作区时无法用空列表表达"不检查"，这种情况如实拒绝，不写坏配置。
//
// 为什么不是"直接写 profile 文件"：`configEditor.edit(entry, change)` 是官方接口
//   —— 它在应用文件锁/重载队列里校验并落盘，Loader 会按正常生命周期重挂插件行。
//
// 异常边界：**不抛**。宿主没有 `configEditor`、找不到行、或 `edit` 失败 → `{ok:false, reason}`。
const SERVICE = {
  configEditor: 'configEditor',
};

/** 本插件 Loader 行的 profile patch id（Include 层展开后的 id）。 */
export const ENTRY_ID = 'include:veneer';

/** 路径比较键：斜杠归一 + 去尾斜杠 + 小写。 */
function pathKeyOf(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 取服务：只做属性访问（真 ctx 是代理，没声明就访问会抛 → 翻译成"没有"）。 */
function service(ctx, name) {
  try {
    const found = ctx ? ctx[name] : undefined;
    return found || null;
  } catch {
    return null;
  }
}

/** 一句话原因（异常/未知值都别把 `String(undefined)` 亮出来）。 */
function reasonOf(err) {
  return String((err && err.message) || err || '未知原因');
}

/** 条目里找本插件行：先按契约 id，再按包名兜底。 */
function findOwnEntry(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (const entry of list) {
    if (entry && entry.id === ENTRY_ID) return entry;
  }
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (name === 'dsh-veneer' || (id && /(^|[:\/])veneer$/.test(id))) return entry;
  }
  return null;
}

/**
 * 造一份配置编辑能力。
 *
 * @param {object} ctx **注入了 `configEditor` 的 ctx**（实例里来自 `host.awaitConfigEditor`）
 * @returns {{entries:Function, editWorkspacesRemove:Function}}
 */
export function createConfigEditor(ctx) {
  const findEntry = () => {
    const editor = service(ctx, SERVICE.configEditor);
    if (!editor) return { ok: false, reason: '宿主没有 ' + SERVICE.configEditor + '（改不了配置）' };
    if (typeof editor.entries !== 'function') {
      return { ok: false, reason: '宿主 ' + SERVICE.configEditor + ' 没有 entries()（认不出本插件行）' };
    }
    let rows;
    try {
      rows = editor.entries();
    } catch (err) {
      return { ok: false, reason: '读配置条目失败：' + reasonOf(err) };
    }
    const entry = findOwnEntry(rows);
    if (!entry) {
      return { ok: false, reason: '找不到本插件的 Loader 行（期望 id=' + ENTRY_ID + '）' };
    }
    return { ok: true, value: entry };
  };

  return {
    /** 本插件的 Loader entry（诊断/测试用）。 */
    entries() {
      return findEntry();
    },

    /**
     * 把工作区从本行配置的 `workspaces` 里去掉（幂等）。
     *
     * @param {string} removePath 工作区路径（调用方已校验是本实例 root）
     * @param {string[]} [platformPaths] 平台工作区表（列表为空=全管时需要它来展开）
     * @returns {Promise<{ok:true, value:{entry:object, workspaces:Array}}|{ok:false, reason:string}>}
     */
    async editWorkspacesRemove(removePath, platformPaths) {
      const path = typeof removePath === 'string' ? removePath.trim() : '';
      if (!path) return { ok: false, reason: '要去掉的工作区路径是空的' };
      const found = findEntry();
      if (found.ok !== true) return found;
      const entry = found.value;
      const editor = service(ctx, SERVICE.configEditor);
      if (!editor || typeof editor.edit !== 'function') {
        return { ok: false, reason: '宿主 ' + SERVICE.configEditor + ' 没有 edit()（改不了配置）' };
      }
      const key = pathKeyOf(path);
      let next = null;
      try {
        await editor.edit(entry, (current) => {
          const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
          const list = Array.isArray(base.workspaces)
            ? base.workspaces.filter((item) => item && typeof item.path === 'string' && item.path.trim())
            : [];
          let kept;
          if (list.length > 0) {
            kept = list.filter((item) => pathKeyOf(item.path) !== key);
          } else {
            const platform = Array.isArray(platformPaths) ? platformPaths : [];
            if (platform.length === 0) {
              throw new Error('列表为空（=全管）且拿不到平台工作区表，无法把本工作区摘出去');
            }
            kept = platform
              .filter((item) => typeof item === 'string' && pathKeyOf(item) !== key)
              .map((item) => ({ path: item }));
          }
          if (kept.length === 0) {
            throw new Error('摘掉后管理工作区为空：空列表表示"全管"，无法表达"不检查"（至少要留一个，或停用本插件行）');
          }
          next = kept;
          return { ...base, workspaces: kept };
        });
      } catch (err) {
        return { ok: false, reason: '写配置失败（' + path + '）：' + reasonOf(err) };
      }
      return { ok: true, value: { entry, workspaces: next || [] } };
    },
  };
}
