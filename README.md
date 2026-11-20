# dsh-veneer

> **工作区物化只落在根上。** 这个插件把"哪些既有对象没跟上"说清楚，并把"怎么补"交到你手里。

宿主在 workspace-write 下对工作区根做一次安全描述符物化（能力 ACE + `Everyone` 拒删子项 + Low 完整性标签）。
**物化之前就已经存在的子对象不会继承这三项**，于是受限的 shell 写不进去，而且不报错。

`dsh-veneer` 是这件事的**保底**，不是替代：

- **插件只做三件事**：只读扫描 → 报告 → 生成一条命令。
- **真正改 ACL 的那一下由你执行**：在**提权的 PowerShell** 里跑生成的命令。
  为什么插件不自己改：插件跑在沙箱里，受限进程连可写目录的 `icacls /setintegritylevel` 都被拒
  （实测令牌只剩 `SeChangeNotifyPrivilege`）；要改 SD 必须离开沙箱，那是**你的授权**，不是插件的。

## 它做什么

1. **读根的签名**：能力 SID、目录上的 `Everyone` 拒绝删除子项、Low 标签——三项都是**从根照抄**，
   插件不自己派生 SID、不发明策略。
2. **根不齐就停**：根上没物化 = 宿主那一步没跑或跑失败了，报告写 `root-absent`，**不动手**。
3. **扫子树**：只补"根上有、这个对象没有"的项。**继承来的也算有**（判据不看 ACE 是不是显式写上去的），
   所以不会把已经从根继承来的 ACE 再补一遍。
4. **跳过并报原因**：reparse point（junction / 符号链接 / 挂载点）、读不到 SD 的对象——不补，写进 `skipped`。
5. **写报告**：`review/veneer-state.json`（可配置）。**内容不变不写盘**。
6. **给命令**：只在真有缺项时生成，默认是**干跑**形态；你看到计划后自己决定加不加 `-Apply`。

## 报告长什么样

```json
{
  "version": 1,
  "plugin": "dsh-veneer",
  "status": "incomplete | ok | root-absent | partial",
  "root": "D:\\your-workspace",
  "rootSignature": { "cap": true, "denyDC": true, "label": "low" },
  "rootMissing": [],
  "template": { "cap": true, "denyDC": true, "label": "low" },
  "counts": { "checked": 936, "missing": 891, "skipped": 0, "failed": 0 },
  "partialReasons": [],
  "missingItems": { "cap": 890, "denyDC": 1, "label": 891 },
  "objects": [{ "path": "D:\\your-workspace\\a", "isDir": true, "missing": ["cap", "label"] }],
  "skipped": [{ "path": "…", "reason": "reparse-point" }],
  "listErrors": [],
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"…\\dsh-veneer-apply.ps1\" -Root \"D:\\your-workspace\" -Cap -DenyDC -Label",
  "boundary": "只保证扫描那一刻的这棵树；…",
  "scannedAt": 0, "generatedAt": 0, "listLimit": 50000
}
```

- `objects` **只放缺项的对象**（不是全量 ACL 快照）。
- `partial` 指"扫不全"：某个子树列不出来（`list-failed`）或到了 `listLimit` 截断（`list-truncated`）。
- `root-absent` 出现时，`command` 为空——这不是你该补的。

## 生成的命令怎么用

```
powershell -NoProfile -ExecutionPolicy Bypass -File "<包目录>\scripts\dsh-veneer-apply.ps1" -Root "<工作区>" -Cap -DenyDC -Label
```

- 这一条是**干跑**：只读扫描，打印"哪些对象缺什么、会怎么补"。
- 看完计划，把 `-Apply` 加在最后再跑一次：脚本**先备份**（`<工作区>\.dsh-veneer-backup\<时间>\`，内含 `manifest.json`），
  再逐对象补，最后**自检一遍**。
- 要回滚：

```
powershell -NoProfile -ExecutionPolicy Bypass -File "<包目录>\scripts\dsh-veneer-apply.ps1" -Root "<工作区>" -Restore -RestoreDir "<备份目录>"
```

- 脚本自己也会按"根上有、这个对象没有"重新判一遍，**不依赖插件报告的内容**；报告只决定你跑不跑。
- 退出码：`0` 正常 / `2` 参数错 / `3` 根或备份不存在 / `6` 拒绝（根没物化 / 根是 reparse point）/
  `7` 备份失败（此时**什么都没改**）/ `8` 有对象改失败 / `9` 自检仍有缺项。

## 为什么不在每轮对话之后重扫

一次扫描要起一个 PowerShell 去读整棵树的 ACL（900 个对象约 5 秒）。挂在 `turn/end` 上就是每轮多 5 秒，
而"后人搬进来的内容"在下次打开工作区或手动重扫时就会被看到。所以：

- **自动**：工作区挂载后扫一次（`scanOnMount`）。
- **手动**：重新打开工作区，或直接跑包里的 `tools/dryrun.mjs`（干跑，不写盘）。

## 配置（补丁层 `cordis.patch.yml`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `workspaceRoot` | `''` | 留空 = 由平台工作区表决定（只有一个就用；多个用第一个） |
| `workspaces` | `[]` | 多项 = 每项一个 child fiber；`path` 必须绝对路径，重复即拒绝 |
| `reportPath` | `review/veneer-state.json` | 报告写在工作区里的相对路径 |
| `listLimit` | `50000` | 一次最多列多少对象（超了报告 `partial`） |
| `scanTimeoutMs` | `60000` | 单次读 ACL 的超时 |
| `readyWaitMs` | `10000` | 等工作区服务就绪的时长（超时用父 ctx 兜一次） |
| `scanOnMount` | `true` | 工作区打开后自动扫一次 |

## 边界

- **Windows-only**：物化三项是 NTFS 语义；其它平台挂载即报告 `unsupported`，什么都不做。
- **不碰根**、不碰 reparse point、不碰读不到 SD 的对象。
- **不改宿主**、不注册任何全局处理器。
- **可移除**：卸载只停扫描；报告文件留着（那是工作区里的材料，插件不替你删）。
  已经补上的 ACL 不会自动回滚——要回滚用上面那条 `-Restore`。
- **一次扫描只保证当时那棵树**：扫完之后搬进来的对象，下次扫描才看得见。

## 结构

```
plugin/dsh-veneer/plugin/        ← 本仓库的根（一个包一层，远端是 github.com/sxwpskd/dsh-veneer）
├── index.js                     # 入口：按 workspaces 挂 child fiber（一个工作区一个实例）
├── core/                        # 纯逻辑：判缺 / 报告 / 命令 / 采集 / 落盘 / 扫描编排 / 工作区实例
├── adapter/                     # 宿主与服务的外部边界（唯一出现宿主服务名；唯一起子进程的地方）
├── model/                       # 数据形状（签名 / 报告版本 / 状态词）
├── config/                      # 默认值 + 深合并（`0` / `''` / `false` 是合法值）
├── exception/                   # 稳定错误码 / 统一结果 / 异常边界
├── log/                         # 极简日志（宿主 logger + 控制台兜底，不建日志文件）
├── scripts/                     # **给提权执行的那一半**（只读探针 + apply/restore）
├── tests/                       # 空目录占位（测试在工作区 tools/，见 tests/README.md）
└── tools/                       # 开发脚本（边界检查 / 干跑），不进发布
```

`tools/check.mjs` 会查"宿主服务名只出现在 `adapter/`"和"本机路径不许进插件"。

## 开发

- **测试不在包里**：工作区的 `tools/veneer-test.mjs`（离线 95 项）与 `tools/windows-live-test.mjs`（真机只读 12 项），唯一入口 `node tools/run-tests.mjs`。
- **想先看结论不跑插件**：`node tools/dryrun.mjs --root <工作区>`（只读，不写盘）。
- 行尾：源码 LF；`.ps1` 保持 CRLF（`.gitattributes` 钉住）。

