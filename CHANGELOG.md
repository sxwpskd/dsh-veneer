# 更新日志

## 0.3.0 — 2026-11-22

按脚手架补齐**日志层**（plugin/_scaffold/log/README.md），并修客户端读文件的错误契约：

- **日志层**（新增 LOG-SCHEMA.md）：\log/schema.js\ 事件表/级别/截断；\log/file-sink.js\ 写
  \<工作区>/.dsh-veneer/veneer.log\（JSONL、1 MiB 轮转、保留 2 份、失败禁用并报告一次）；
  \log/memory-sink.js\ 200 条环形缓冲；\log/logger.js\ 门面（宿主 logger + 内存 + 文件 sink，永不抛）；
  \log/shared.js\ 装配（一个进程一个日志口；根没解析出来时先落系统临时目录的**引导日志**，根出来再换成工作区文件）。
- **客户端只读展示的调试行**：面板显示最近 6 条客户端日志（内存缓冲），读失败原因也进日志。
- **修读取契约**：\workspaceFiles.read\ 是 \ead(sessionId, path, range, signal)\（错误信息原文：
  "expected 3 business argument(s) plus an optional AbortSignal"）。改用 \useSessions\ 快照取 SessionId 后按 3 参读；
  先读小摘要 \eview/veneer-summary.json\，再退整份报告；每次尝试的原因都显示在面板上。
- **宿主挂载改成"先同步解析根"**：实例 fiber 已声明工作区服务依赖，通常挂载即就绪；解析失败也**进日志**（不再静默），
  然后才走 \ctx.inject\ 等待 + 兜底定时器。
- 测试：新增日志层套件（107 项）+ 实例日志落盘回归（veneer 123 项），全套 **19 套 / 约 1828 项全绿**。

## 0.2.4 — 2026-11-22

把"**宿主那一半到底跑到哪一步**"变成可查的事实（上一版只能靠猜）：

- 宿主半边每步都写进系统临时目录的 `dsh-veneer-host.log`：`apply 进入`（含 platform/config）、
  `规划完成`、`实例 apply 进入`、`等服务就绪：canInject=`、`注入回调已触发`、`开始扫描`、
  `兜底定时器触发`、扫描成功/失败原因、桥目录。文件上限 512 KB，超了重写；不进工作区。
- 扫描落盘时**多写一份小摘要** `review/veneer-summary.json`（几 KB）：面板优先读它，读不到再读整份报告。
  原因：几百 KB 的报告在真机上读取不稳，而面板只需要结论 + 几条缺项。
- 面板读不到时**把每次尝试的原因摊开显示**（`read(path)` / `read(path, opts)` / 小摘要 / 整份报告），
  不用开 DevTools 也能看出卡在"没通道 / 文件不存在 / 返回形状不对"。
- 测试 112 项（新增"摘要与报告各落一次"）。

## 0.2.3 — 2026-11-22

修 **0.2.2 的配置页整块不显示**，并把面板改成**只读展示**（不再有按不动的按钮）：

- **面板渲染崩了**：组件在渲染时读了未声明的 ctx 服务（`ctx.session`）。真环境的客户端 ctx 是代理，
  读未声明属性会抛，整块被错误边界吞成 null —— 页面只剩标题和描述。已删掉那处读取；
  组件改为从 `props.React` 取 React（dsh-milieu 的既有教训），并加了"严格 ctx 代理"回归测试。
- **面板只读**：宿主在打开工作区时扫一次，面板读 `review/veneer-state.json` 显示结论
  （完整 / 还缺 N 个 / 根没物化 / 扫不全 + 最多 5 条缺项明细 + 扫描时间）；"重新读取"重读文件。
  按钮不再声称能触发扫描（浏览器没有写工作区文件的通道，这条查实过）。
- 构建自检现在会**真的渲染一次组件**（`props.React` 必须得到一个 div），不再只检查注册形状。

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
