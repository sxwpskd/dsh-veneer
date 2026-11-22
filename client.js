// dsh-veneer —— 界面半边入口：**只装配**
//
// 客户端模块的形状（照官方模板）：
//   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … return { inject, apply } } })
// React 从**浏览器模块表**取（`require('react')`），不自己装一份。
//
// **平台按 classic script 加载界面插件**（不是 ES 模块）：发布的是 `lib/client.js`，
//   由工作区工具 `tools/build-veneer-client.mjs` 从本文件 + `ui/*.js` + 它们的相对依赖拼接生成。
//   改界面源码后必须重新生成，否则跑的是旧代码。
import { createClientPlugin, CLIENT_INJECT } from './ui/config-page.js';
import { createLog } from './log/logger.js';

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-veneer',
    factory(require) {
      const React = require('react');
      return {
        inject: CLIENT_INJECT,
        apply(ctx) {
          // 客户端日志：浏览器拿不到文件系统 → 只有内存环形缓冲（面板里显示最近几条）。
          const log = createLog(null, { memoryLimit: 120 });
          const plugin = createClientPlugin({ React, ctx, log });
          return plugin.apply(ctx);
        },
      };
    },
  });
}
