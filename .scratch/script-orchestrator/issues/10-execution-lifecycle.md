# 澄清执行排队取消与等待语义

Type: grilling
Status: resolved
Labels: wayfinder:grilling
Blocked by: 03, 06, 18

## Context

- [核实子进程与跨平台终止语义](03-research-subprocess.md)：提供终止、取消和输出行为的宿主事实。
- [核实存储域与 JSON 持久化](06-research-storage.md)：提供写序与持久化保证。

## Question

run 在 queued/running/judging/dispatching 与 skipped/canceled/interrupted 之间如何结算和持久化？需要明确单飞 queue 上限、全局队列溢出时“丢弃最旧并记 skipped”的具体记录、工具 abort 与插件卸载的取消范围（含 delete 触发的取消，见 [统一工具与服务的管理接口](09-management-interface.md)）。还要统一“run 只写开始/结算两次”与各终态事件的语义（存储侧已由 [确定存储布局与故障恢复契约](14-storage-recovery.md) 定案：两次写入排除恢复/对账/裁剪的维护写，启动维护含 interrupted 标记与孤儿清理）。

工具取消还需对齐宿主 ABORTED_BEFORE_DISPATCH/ABORTED：exec.signal 必须贯穿执行服务，terminate 后等待 run 结算 canceled 和工具 Promise 静止；不能只停止等待。`wait: true` 的工具侧语义已在 [统一工具与服务的管理接口](09-management-interface.md) 定为尽力等待、超限返回非终态 RunView、不新增错误码；本票只决定执行侧细节（排队/取消的结算与持久化口径）。宿主事实见 [核实工作区插件、工具与配置机制](04-research-plugin-runtime.md)。

## Comments

- **Round 1（2026-11-08，用户「都按推荐」）**：① 单飞队列溢出 = 新者 skip（`skipReason: 'overlap'`，与错过合并同向；全局队列才丢最旧 `'concurrency'`）；② 两写统一——disabled/overlap/concurrency skip 也建完整 run 记录（`scheduledAt` + `skipReason`），唯一无记录 = 宿主 `ABORTED_BEFORE_DISPATCH`；③ 手动执行共用排队体系（占并发槽）但不被 overlap:skip 淘汰（显式意图排队等上次结束）；④ 取消矩阵：queued→直接 canceled 不 spawn、running→terminate→canceled、judging→不响应取消（毫秒级计算例外）、dispatching→当前动作按其 signal 中止 + 停止派发剩余、已执行动作结果保留、结算 canceled（终态优先于动作汇总）；⑤ first-write-wins——FIFO 第一笔终态生效，迟到结算 no-op 不重发事件；⑥ delete 时序 = 按矩阵取消 → 各自结算 canceled（两写）→ `run-settled(canceled)` 照发 → 同批删（先编排后 runs）→ 不为删除另发事件；⑦ exec.signal 贯穿 = abort 转该 run 取消请求（按 ④ 矩阵），run 结算 canceled 且持久化完成后工具 Promise 才以宿主 ABORTED 静止，wait:false 的 run 同样被取消（取消不依赖等待者）。
- **Round 2（2026-11-08，用户「都按推荐」）**：⑧ 手动 run 不豁免全局溢出丢弃——被丢时结算 skipped（`'concurrency'`）并返回 skipped RunView，可见非静默（规则单一：队列溢出丢弃不区分来源）；⑨ 单飞屏障表述为通用规则：同编排至多 1 个脚本在跑，任何 run 等上一个结算后开始；手动不设特例条款——屏障管「何时开始」，overlap 模式管「积压保留」。

## Answer

**方案（2026-11-08 拍板，落盘 v0.1k）**：

1. **单飞屏障（通用规则）**：同一编排同时至多 1 个脚本在跑；任何 run（手动/自动）都在同编排上一个 run 结算后才开始。屏障管「何时开始」，overlap 模式管「调度积压要不要保留」，正交。
2. **溢出策略**：单飞 `'queue'` 队列上限 1，再溢出时**新者 skip**（`skipReason: 'overlap'`，与错过合并语义同向）；全局排队上限 `maxConcurrentRuns × 4`，溢出**丢最旧**（`'concurrency'`，保护别的编排不被饿死），**不区分来源**——手动 run 同样可被丢，`script_run` 返回 skipped RunView，可见非静默。
3. **两写统一**：一切入过队的 run 都有完整记录（写 1 创建 `queued` + 写 2 结算）；disabled/overlap/concurrency 的 skip 也是两条写（含 `scheduledAt`、`skipReason`），UI 可解释「为什么没跑」。唯一无 run 记录的取消是宿主层 `ABORTED_BEFORE_DISPATCH`（插件未收到调用）。
4. **取消矩阵**（来源 = `script_run` abort / delete / 插件卸载）：`queued` → 直接结算 `canceled` 不 spawn；`running` → `terminate()`（5s grace + 强杀）→ `canceled`；`judging` → 不响应取消（纯内存计算毫秒级），自然前进；`dispatching` → 当前动作按其 `signal` 中止 + 停止派发剩余动作、已执行动作结果保留、结算 `canceled`（**终态优先于动作汇总**）。
5. **终态唯一（first-write-wins）**：取消与自然结算竞争时 FIFO 写序下第一笔终态生效，迟到结算 no-op（不覆写、不重发 `run-settled`）。
6. **delete 时序**：按矩阵取消未终态 run → 各自结算 `canceled`（两写）→ `run-settled(canceled)` 照常发布（记录仍在、载荷自足）→ 同批删除（先编排后 runs）→ 不为删除另发事件；订阅者事后 `view()` 查无属预期（无重放、view() 事实源）。
7. **exec.signal 贯穿与静止**：abort → 执行服务转为该 run 的取消请求（按矩阵执行），等结算 `canceled` 且持久化完成后工具 Promise 才以宿主 `ABORTED` 静止——终止的是 run，不是等待；`wait: false` 已返回的 run 同样被取消（取消不依赖等待者存在）；`ABORTED_BEFORE_DISPATCH` 时插件未收到调用、无 run 记录。

**落盘**：`docs/temp/03-execution.md`（并发与单飞重写 + 新增「取消与等待」节）、`09-states-errors.md`（状态图补 queue 溢出线、结算规则 5/6 两条）、`07-tools.md`（script_run 排队身份 + abort 条款）、`06-events-service.md`（删除编排的事件时序、服务 run 行）、`10-decisions.md`（「排队与取消」分叉行）、`README.md`（v0.1k）。
