// dsh-veneer —— 配置编辑器适配（**宿主名词只在这里**：`configEditor`）
//
// 用途只有两件（都在"不再检查本工作区"这条路上）：
//   · `entries()`     找到**本插件自己的 Loader 行**（`entry.id === 'include:veneer'`）；
//   · `editExclude()` 把工作区路径加进该行配置的 `exclude`（下一轮 Loader 重规划时它就不在范围里）。
//
// 为什么不是"直接写 profile 文件"：`configEditor.edit(entry, change)` 是官方接口
//   —— 它在应用文件锁/重载队列里校验并落盘，Loader 会按正常生命周期重挂插件行。
//   自己改 YAML 会绕开校验，还可能覆盖并发的其它改动。
//
// 异常边界：**不抛**。宿主没有 `configEditor`、找不到行、或 `edit` 失败 → `{ok:false, reason}`。
// 纪律与 `adapter/dsh.js` 相同：这里只翻译，不决定"该不该排除"（那是核心层/用户的决定）。
const SERVICE = {
  configEditor: 'configEditor',
};

/**
 * 本插件 Loader 行的 profile patch id。
 * 由 `cordis.patch.yml` 的 `- insert: - id: veneer` 经 Include 层展开而来（2026-11-23 集成方确认）。
 */
export const ENTRY_ID = 'include:veneer';

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

/** 条目里找本插件行：先按契约 id，再按包名兜底（id 拼法随 Include 层变化时不至于失效）。 */
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
 * @returns {{entries:Function, editExclude:Function}}
 */
export function createConfigEditor(ctx) {
  /** 本插件行的 entry；找不到/接口没有 → `{ok:false}`。 */
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
    /**
     * 本插件的 Loader entry（供诊断/测试）。
     * @returns {{ok:true, value:object}|{ok:false, reason:string}}
     */
    entries() {
      return findEntry();
    },

    /**
     * 把工作区路径加进本行配置的 `exclude`（幂等：已在里面就不重复）。
     *
     * 用 `configEditor.edit(entry, change)`：`change(current)` 收到**原始配置**，返回完整的新配置；
     * 官方负责校验、落盘并让 Loader 重规划（child fiber 的增删交给 Loader）。
     *
     * @param {string} addPath 工作区路径（调用方已归一/校验过是本实例 root）
     * @returns {Promise<{ok:true, value:{entry:object, exclude:string[]}}|{ok:false, reason:string}>}
     */
    async editExclude(addPath) {
      const path = typeof addPath === 'string' ? addPath.trim() : '';
      if (!path) return { ok: false, reason: '要排除的工作区路径是空的' };
      const found = findEntry();
      if (found.ok !== true) return found;
      const entry = found.value;
      const editor = service(ctx, SERVICE.configEditor);
      if (!editor || typeof editor.edit !== 'function') {
        return { ok: false, reason: '宿主 ' + SERVICE.configEditor + ' 没有 edit()（改不了配置）' };
      }
      try {
        await editor.edit(entry, (current) => {
          const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
          const existing = Array.isArray(base.exclude) ? base.exclude.filter((item) => typeof item === 'string') : [];
          return { ...base, exclude: [...new Set([...existing, path])] };
        });
      } catch (err) {
        return { ok: false, reason: '写配置失败（' + path + '）：' + reasonOf(err) };
      }
      return { ok: true, value: { entry, exclude: [path] } };
    },
  };
}
