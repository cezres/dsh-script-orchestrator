# 验证 Windows 终止与输出溢写

Type: prototype
Status: resolved
Labels: wayfinder:prototype
Branch: proto/subprocess
Findings: .scratch/script-orchestrator/prototype/subprocess/FINDINGS.md（worktree D:\projects\dsh-script-orchestrator-proto-subprocess）
Commit: 390544b
Blocked by: 03

## Context

- [核实子进程与跨平台终止语义](03-research-subprocess.md)：W1/W2 最小实验设计及主源码证据。

## Question

在本机 DSH `0.2.2-rc.1` 普通 `ctx.subprocess.spawn` 路径上，抛弃式最小实验能否确认两件事：W1，ready 后 terminate 实际选择原生 Windows Job 还是 fallback，done 的 exitCode/signal 与 waitForExit 结果是什么；W2，在有限 maxBytes 与更大 spill.maxBytes 下，完整 spill 是否在 done 后可读且内存只留尾部，超 spill cap 时 spillPath 是否撤回？记录精确命令、输出、宿主警告和结论，不实现正式 runner，不修改宿主安装，不将结果外推为 macOS 实机证据。

## Comments

- 2026-11-08：用户批准按方案执行（沙箱 DSH_HOME 无头实例 + 探针插件 + 两个 dummy node 子进程，其一被 terminate）。
- 2026-11-08：W1/W2a/W2b 三组实验一次通过，结果与源码预测完全一致；探针宿主已停、临时 store 已清。

## Answer

原型结论（原始数据 `probe-results.json`、完整记录见 [FINDINGS.md](../../../dsh-script-orchestrator-proto-subprocess/.scratch/script-orchestrator/prototype/subprocess/FINDINGS.md)，分支 `proto/subprocess`，commit `390544b`）：

1. **W1 成立**：本机普通 `ctx.subprocess.spawn` 选中**原生 Windows Job**（CLI stdout 无 weaker-containment 回退警告）。目标 = 运行时 `node.exe` 长驻（ready 330 ms 后 `setInterval` 挂住），`graceMs: 100`，ready 后一次 `terminate()`：`done` → `{ exitCode: 1, signal: null }`（无 rejection），`await handle.waitForExit()` → `true`，全程 370 ms。与源码预测一致（`TerminateJobObject(..., 1)` + 父侧固定 `signal: null`）；未测第二次 terminate（Job latch 已由源码证明）。
2. **W2a 成立**：200 行 / 3200 字节已知输出，`maxBytes: 500` + `spill.maxBytes: 65536`：`done` 正常 `{0, null}`；`readFrom(0)` 为 `lossy: true`、内存文本恰 500 字节、含末行不含首行；`spillPath`（系统 temp 下 `dsh-subprocess-<rand>\*-stdout.log`）done 后可读、3200 字节、**同时含首末行**——双层收集（内存尾部 + 完整溢写）契约可实现；spill 文件需外部清理。
3. **W2b 成立**：同输出但 `spill.maxBytes: 500`：最终 `spillPath === undefined`（超 cap 撤回），内存尾部不受影响（`lossy: true`、含末行）。
4. **契约同步**：`03-execution` 超时与终止节补 Windows 实测口径（`signal` 恒 `null`、Job 终止 `exitCode: 1`）；`10-decisions` 待验证项 #5 标记已验证，原「退路」作废。
5. **边界**：不实现正式 runner；不改宿主安装；**不外推 macOS**（macOS 路线仍是报告 §7.3 的既有三组测试 + exit-0 用例）；未测「直接命令退出但后代存活」的 waitForExit 悬挂（非本实验判定问题）。

对地图的影响：[澄清执行排队取消与等待语义](10-execution-lifecycle.md) 的取消/结算语义现在有了 Windows 实测地基（terminate → 确定性 `1/null` + 范围退出 true），其排队与两次写入细节仍归该票。
