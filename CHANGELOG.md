# 更新日志

## 0.2.2 — 2026-11-22

修 **0.2.1 装到别处就起不来**的发布缺陷：`package.json` 的 `files` 白名单从一开始就漏了 `log/`（这次也补上 `ui/`）。
pnpm 按白名单打包 git 依赖，所以从 GitHub 装下来的包里没有 `log/logger.js`，宿主激活时报
`Cannot find module ...\log\logger.js`。本地 link 安装不受影响，因此一直在本机"看不出问题"。

- `files` 增加 `log`、`ui`。
- `tools/check.mjs` 加一条静态检查：**白名单展开后的文件集合必须覆盖所有相对 import**；
  用 0.2.1 的装好的包跑，它会准确列出 `./log/logger.js`、`../log/logger.js`、`./ui/config-page.js` 三处。

## 0.2.1 — 2026-11-20

修复 0.2.0 在真机上**完全没起来**的两处缺陷（都不是平台的问题）：

- **工作区根永远解析不到 → 扫描与手动入口一次都没跑过**：`ctx.inject` 回调拿到的是适配层对象，
  代码又把它包了一层（`createDsh(child)`），于是找不到宿主服务、解析不到根，而且只留一条 warn。
  改为直接使用回调给的对象；失败原因也补上"为什么"（配置没给 / 平台报错 / 平台表为空）。
- **插件页那一行没有「配置」控件**：界面半边把 `slots.inject(插槽名, cb)` 的第一个参数写成了 key
  （`dsh-veneer#veneer`），不报错但永远不会注册。改为 `'plugins.row.config'`；构建自检也钉住这两点。
- 回归测试 +9（104 项）：界面注册（插槽名 / key / 组件形态）、实例注入（桥目录真的建起来）。

## 0.2.0 — 未发布

- **插件页里有一个「检查沙箱物化」面板**（dsh-veneer 那一行的配置页）：点一下 → 宿主马上只读扫一次 → 显示结论
  （`ok` / 还缺 N 个 / 根没物化 / 扫不全）。**不改任何 ACL**。
- 手动入口走**文件桥**：界面写 `.dsh-veneer/request.json` → 宿主看到就扫一次 → 写 `result.json` → 界面读。
  桥是必需的：插件包没有 Typert 生成，界面调不到宿主方法；桥只在本机 Windows 上跑，别处按钮会如实显示"点不了"。
- 新增 `ui/` + `client.js` + `lib/client.js`（**构建产物**，改界面源码后重跑 `node tools/build-veneer-client.mjs`）。
- `bridge` / `bridgePollMs` 两个配置键。
- `adapter/desktop.js`：在资源管理器里选中报告文件（只接受工作区内的相对路径）。

## 0.1.0 — 2026-11-20

首版。**只检测 + 报告 + 生成命令**；改 ACL 的那一半由用户在宿主外提权执行。

- 读根的安全描述符，照抄三项（能力 ACE / 目录上的 `Everyone` 拒删子项 / Low 标签）；**不派生 SID**。
- 根上没物化三项 → `root-absent`，不扫子树、不给命令（那是宿主的活）。
- 子树判缺：**只补根上有的项**；**继承来的 ACE 也算有**（不会再把已继承的 ACE 补一遍）。
- 跳过并报原因：reparse point、读不到 SD 的对象。
- 报告写 `review/veneer-state.json`：`status` / `counts` / `missingItems` / `objects`（只收缺项的）/
  `skipped` / `partialReasons` / `command` / `boundary`；**内容不变不写盘**。
- 生成一条命令（默认干跑）：`pwsh -File scripts\dsh-veneer-apply.ps1 -Root <工作区> -Cap -DenyDC -Label`。
- 执行侧脚本 `scripts/dsh-veneer-apply.ps1`：plan（默认）/ apply（备份 + 改 + 自检）/ restore；
  根没物化时 exit 6，备份失败时 exit 7 且**什么都不改**。
- Windows-only；一个工作区一个 child fiber；不改宿主；卸载只停扫描。
