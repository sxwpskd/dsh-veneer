// dsh-veneer —— 工作区规划（核心层纯策略：读 `config.workspaces` → child 配置列表）
//
// 与 dsh-milieu 的 A 方案同形：一个 Loader 行 + 每工作区一个 child fiber。
//   · `workspaces` 缺省 / 空 → 单工作区兼容：一个默认实例（root 到挂载时才解析）；
//   · 非空 → 每项一个实例；`path` 必须是非空绝对路径；同一路径重复 → **整份拒绝**（不静默去重）；
//   · child 配置不递归 `workspaces`。
//
// 本文件不挂 fiber、不读写文件、不访问宿主。
import { isAbsolute, resolve } from 'node:path';
import { withDefaults } from '../config/defaults.js';

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** 同一个路径的不同拼法（斜杠 / 大小写 / 末尾斜杠）算同一个。 */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * @param {object} [rawConfig] 补丁层给的配置
 * @returns {{ok:boolean, mode:'single'|'workspaces'|'invalid', children:Array<{path:string|null, index:number|null, config:object}>, errors:string[]}}
 */
export function planWorkspaces(rawConfig) {
  const raw = isPlainObject(rawConfig) ? rawConfig : {};
  const list = raw.workspaces;

  if (list === undefined || list === null || (Array.isArray(list) && list.length === 0)) {
    const config = withDefaults(raw);
    delete config.workspaces;
    return { ok: true, mode: 'single', children: [{ path: null, index: null, config }], errors: [] };
  }
  if (!Array.isArray(list)) {
    return {
      ok: false,
      mode: 'invalid',
      children: [],
      errors: ['workspaces 必须是对象数组（当前是 ' + (list === null ? 'null' : typeof list) + '）'],
    };
  }

  const errors = [];
  const seen = new Map();
  const children = [];
  list.forEach((entry, index) => {
    const where = 'workspaces[' + index + ']';
    if (!isPlainObject(entry)) {
      errors.push(where + ' 必须是对象，且含 path');
      return;
    }
    const rawPath = entry.path;
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      errors.push(where + '.path 必须是非空字符串');
      return;
    }
    if (!isAbsolute(rawPath)) {
      errors.push(where + '.path 必须是绝对路径：' + rawPath);
      return;
    }
    let resolvedPath;
    try {
      resolvedPath = resolve(rawPath);
    } catch (err) {
      errors.push(where + '.path 解析失败：' + rawPath);
      return;
    }
    const key = resolvedPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) {
      errors.push(where + ' 与 workspaces[' + seen.get(key) + '] 路径重复：' + resolvedPath);
      return;
    }
    seen.set(key, index);
    const overrides = { ...entry };
    delete overrides.path;
    delete overrides.workspaces;
    const config = withDefaults({ ...raw, ...overrides, workspaceRoot: resolvedPath });
    delete config.workspaces;
    children.push({ path: resolvedPath, index, config });
  });

  if (errors.length) return { ok: false, mode: 'invalid', children: [], errors };
  return { ok: true, mode: 'workspaces', children, errors: [] };
}
