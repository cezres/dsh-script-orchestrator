# 33: 通过 ephemeral session 自动整理并回收

**What to build:** 用户可选择 ephemeral session 动作完成一次性整理，系统在会话真正空闲后按配置回收 live Agent，同时保留可重新打开的冷会话历史。

**Blocked by:** 32 — 通过 persistent session 接管失败排查

**Status:** ready-for-agent

- [ ] ephemeral 经直接铸造的 session id、当前模型选择、preset 解析/mount 和 `agents.create()` 创建自持 handle，投递路径与 persistent 共用。
- [ ] `whenIdle()` 挂在 agent 上，收敛后才等待 `idleDisposeSeconds` 并 dispose；persistent 拒绝该字段，ephemeral 的零延迟与延迟回收均有测试。
- [ ] 用户接管和对话活动会推迟空闲，回收只 teardown live Agent，不删除持久化日志或 Workspace 关系，冷会话可重新打开。
- [ ] 投递失败的 ephemeral 不启动回收计时并保留 `sessionId` 现场；插件重启不重新认领历史 ephemeral，删除编排不提前杀死会话。
- [ ] 插件停用/卸载由 owner-fiber teardown 清理 live Agent，异步回收任务全部受生命周期跟踪，回收竞态只承诺契约规定的 durable inbox 边界。
- [ ] 隔离宿主测试覆盖创建、投递、空闲收敛、延迟 dispose、用户活动、失败不回收、卸载 teardown 和冷会话重开。
