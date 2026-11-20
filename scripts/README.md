# dsh-veneer 的执行侧脚本（给用户在宿主外提权执行的那一半）

这里放的是**不在插件里跑**的脚本：插件跑在沙箱内，受限进程改不了安全描述符
（实测：令牌只有 `SeChangeNotifyPrivilege`，连可写目录里的 `icacls /setintegritylevel` 都被拒）。
所以"真正改 ACL"的那一下，交给用户在**提权的 PowerShell** 里跑这里的东西。

| 文件 | 什么时候用 | 会不会改东西 |
| --- | --- | --- |
| `dsh-veneer-apply.ps1` | 插件把命令交给你之后 | 默认**干跑**；加 `-Apply` 才改，改之前备份并打印 `restore` |

## `dsh-veneer-apply.ps1` 的三种模式（按参数出现顺序判断）

| 模式 | 命令 | 行为 |
| --- | --- | --- |
| **plan**（默认） | `-File dsh-veneer-apply.ps1 -Root <根> -Cap -DenyDC -Label` | 只读扫描，打印"要补什么、跳过什么" |
| **apply** | 同上再加 `-Apply` | 备份 → 逐对象补 → 自检 |
| **restore** | `-Root <根> -Restore <备份目录>` | 用 apply 留下的备份恢复 |

## 它和插件报告的关系

- 插件生成的命令**默认就是 plan 模式**：你先看计划，再自己加 `-Apply`。
- 命令里的 `-Cap / -DenyDC / -Label` 是**插件报告里真的缺的项**；三项都没缺就不生成命令。
- 脚本自己也会按"根上有、这个对象没有"重新判一遍——**不依赖插件报告的内容**，报告只决定你跑不跑。

## 约束

- Windows PowerShell 5.1 兼容；源码**纯 ASCII**（无 BOM 的 `.ps1` 按 ANSI 解码，中文会炸）；
- 只改安全描述符，不动文件内容；
- 不碰工作区根；不碰 reparse point；读不到 SD 的对象跳过并报；
- 幂等：已经是"已有"的对象（含**从根继承来的**）不再补。
