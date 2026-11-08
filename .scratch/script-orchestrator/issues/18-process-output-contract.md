# 确定脚本进程与输出契约

Type: grilling
Status: resolved
Labels: wayfinder:grilling
Blocked by: 03, 19

## Context

- [核实子进程与跨平台终止语义](03-research-subprocess.md)：spawn、环境脱敏、stdin、输出、终止和平台差异的事实来源。
- [验证 Windows 终止与输出溢写](19-windows-subprocess-prototype.md)：本机 Job 与 spill 行为的实机证据。

## Question

v0.1 脚本执行契约应如何适配宿主真实行为？需要确定 stdin text→data、只传覆盖 env、cwd/allowedRoots 预检、同步与异步 spawn failure 分类、取消 rejection 的优先级、裸 `.cmd`/`.bat` 支持矩阵、maxSpillBytes 默认值与配置、超 cap/无 spillPath 的记录和清理责任、UTF-8 截断字符边界，以及 signal 只表示 provider 观测结果。还要决定正常 done 后存活后代是忽略、有界等待后终止还是持续等待，并明确 Windows 立即强杀、macOS PGID 回退和未实机验证风险。

## Comments

- 2026-11-08 第 1 轮（8 题，全部按推荐）：Q1 env 只传 `script.env ?? {}`（重传继承集会把敏感值以显式覆盖重新注入）；Q2 失败/取消分类三规则（cancelReason 标志位优先、未置位失败记 spawn_failed 保留 cause、预取消记 canceled）；Q3 裸 `.cmd`/`.bat` 不拦截不承诺（推荐 pwsh 包装，验收矩阵不含）；Q4 后代处理选有界等待 `waitForExit()` 2000ms 常量 + 超时 terminate 清范围 + `run.script.warnings` 记 `descendants-terminated`（进程树生命周期以 run 为上限）；Q5 `maxSpillBytes` 默认 8 MiB/流、0 禁用、只进插件配置；Q6 spill 清理 = 裁剪/级联删除时 best-effort unlink，不启动扫描，崩溃残留交 OS temp；Q7 tail 取解码后末 2048 code point（U+FFFD 保留）、`truncated` 判定即 `lossy`、spill 存在不改变它；Q8 signal 仅 provider 观测（不区分 TERM/KILL、Windows 恒 null）+ macOS 未实机验证声明。
- 2026-11-08 第 2 轮（3 题，全部按推荐）：Q9 stdin 契约保持 `{ text }`、适配层映射 `{ data }`、不做交互式 stdin；Q10 script warnings 只进 run 记录与 UI，不进判定、不进事件；Q11 spill 拆 `stdoutSpillPath?`/`stderrSpillPath?` 双字段（与 tail 命名对称）。
- 2026-11-08：汇总方案经用户批准，落盘契约 v0.1j。

## Answer

契约 v0.1j（[03-execution](../../../docs/temp/03-execution.md) 重写调用形态/新增「失败与取消分类」/扩充超时终止与输出收集；[01-domain-model](../../../docs/temp/01-domain-model.md) run.script 形状更新；[06-events-service](../../../docs/temp/06-events-service.md) 事件 script 对象同步；[10-decisions](../../../docs/temp/10-decisions.md) 关键分叉加行）：

1. **调用形态**：`env: script.env ?? {}`（宿主自动继承脱敏环境，插件只传覆盖项）；stdin `{ text }` 字段不变、适配层映射宿主 `{ data }`、一次性写完即关；两条流各配 `maxBytes`（`maxOutputBytes` 默认 262144）+ `spill: { maxBytes: config.maxSpillBytes }`。
2. **失败与取消分类**（判据是插件自置标志位，不猜 rejection 内容）：调 `terminate()` 前先置 `cancelReason`；`done` reject 时已置位 → 按超时/取消结算；未置位时的同步 throw 与异步 reject → `spawn_failed`（`details.cause` 保留原始错误）；已预取消的同步 throw → `canceled`；cwd 不存在保持 spawn 前预检 `spawn_failed`。
3. **裸 `.cmd`/`.bat`**：不拦截、不承诺、未验证；推荐 `pwsh -Command` 包装。
4. **后代**：`done` 结算脚本事实后有界等待 `waitForExit()` 2000ms（常量），超时 `terminate()` 清范围（Windows=Job 全杀、macOS=PGID 回退），`run.script.warnings?: string[]` 记 `descendants-terminated`；warnings 不进判定、不进事件。
5. **输出**：tail = 解码后文本末 2048 code point，U+FFFD 保留；`truncated` 判定即 `lossy`（溢写存在不改变）；spill 按流记 `stdoutSpillPath?`/`stderrSpillPath?`，超 cap 撤回即缺省；`maxSpillBytes` 默认 8388608/流、`0` 禁用。
6. **清理**：裁剪与级联删除 run 时 best-effort `unlink` spill 文件；不启动扫描；崩溃残留交 OS temp；UI 读失败显示「文件已不存在」。
7. **平台口径**：signal 仅 provider 观测、不区分 TERM/KILL、Windows 恒 `null`（19 号票实测）；macOS PGID 未实机验证，最终 spec 验收矩阵仅 Windows、残余风险写入 spec。
