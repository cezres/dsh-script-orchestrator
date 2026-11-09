# 28: 编辑触发、暂停/恢复并手动执行编排

**What to build:** 用户能通过对话修改已支持的编排配置，在面板暂停、恢复或手动执行编排，并观察到与契约一致的状态、下次触发时刻和 run 返回。

**Blocked by:** 27 — 通过 cron 编排按计划执行

**Status:** claimed

- [ ] `script_edit` 支持 update/pause/resume，更新已支持字段时完成静态校验、持久化和写后回读；仅调度字段变化重建计划，非调度编辑不重锚。
- [ ] `expectedUpdatedAt` 对 update/pause/resume 做乐观并发检查，冲突返回 `script_conflict`；pause/resume 按状态设置语义幂等 no-op，不错误重锚 fixed-delay。
- [ ] 调度编辑使用编辑代际或等价机制，旧 run 结算不能覆盖更新后的 fixed-rate/cron 计划；fixed-delay 旧自动 run 未结算时按契约保持等待。
- [ ] `script_run` 支持 wait=true/false、尽力等待上限和 paused/ended 手动执行；手动 run 不移动自动计划，不被 `overlap:skip` 淘汰，但可被全局队列溢出丢弃并返回可见 skipped。
- [ ] 面板行内暂停/恢复/执行操作经 Connection 调用并立即回读；run 端点受理即返回，UI abort 只停止等待，不取消已受理操作或 run。
- [ ] 测试覆盖各状态 no-op、CAS、触发重锚、手动排队、等待超限、Connection abort 只停止等待和面板操作结果。
