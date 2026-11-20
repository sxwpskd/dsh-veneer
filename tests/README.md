# 测试在哪

**测试不在包内。** dsh-veneer 的离线自测与 Windows 真机只读自测在工作区 D:\DSH\tools\：

- 	ools/veneer-test.mjs（95 项，纯 node）
- 	ools/windows-live-test.mjs（12 项，真 PowerShell，只读）

唯一入口：
ode tools/run-tests.mjs（连 dsh-milieu 的 16 套一起跑）。

	ests/ 目录只为满足官方 iles 检查（白名单里要有 lib 或 dist）而存在——**它不放测试代码，也不进发布包**。

