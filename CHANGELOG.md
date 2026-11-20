# 更新日志

## 0.1.0 — 未发布

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
