# 29: 取消在途 run 并安全删除编排

**What to build:** 用户可以取消工具调用所对应的 run，或经面板确认删除编排；系统按阶段取消、等待结算持久化，再完成级联删除，不留下继续派发动作的孤儿执行。

**Blocked by:** 28 — 编辑触发、暂停/恢复并手动执行编排

**Status:** ready-for-agent

- [ ] 工具 `exec.signal` 贯穿到 run：queued 直接 canceled、running 终止进程、judging 不响应、dispatching 停止剩余派发并保留已执行动作结果。
- [ ] run 结算 canceled 且持久化后工具 Promise 才以宿主 `ABORTED` 静止；wait=false 已返回的 run 同样取消，`ABORTED_BEFORE_DISPATCH` 不产生 run 记录。
- [ ] 取消与自然结算竞争时 first-write-wins，迟到结算不覆写、不重复发布 `run-settled`，终态优先于动作汇总。
- [ ] `script_edit(action=delete)` 支持全状态与 CAS，先取消全部未终态 run、照发对应 `run-settled(canceled)`，再在同一服务槽位先删编排后删 runs，返回准确 `removedRuns`，不为删除补发事件。
- [ ] 面板删除有二次确认，操作期间状态清晰，成功后回读列表；Connection UI abort 不取消已受理删除，工具与面板取消语义保持不同。
- [ ] 集成测试覆盖四阶段取消、wait=false、预取消、终态竞争、删除事件时序、级联结果和面板确认路径。
