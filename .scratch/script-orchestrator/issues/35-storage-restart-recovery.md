# 35: 从重启与存储故障中恢复

**What to build:** 插件经历崩溃、重启、坏记录或写入结果未知后，能以持久化事实恢复编排、run 和调度状态；用户在面板看到的是恢复后的权威视图，而不是内存残影。

**Blocked by:** 29 — 取消在途 run 并安全删除编排

**Status:** ready-for-agent

- [ ] 启动将全部非终态 run 标为 `interrupted` 并照发一次 `run-settled`，不自动重放；fixed-delay 从恢复结算的 `settledAt` 推进，cron/fixed-rate 按既定错过合并恢复。
- [ ] 启动幂等清理无父 run 并完成保留对账，级联删除中途崩溃不会留下永久孤儿或错误列表。
- [ ] schema 坏记录执行 backup-and-skip 并记日志，畸形 JSON、不可读或版本不接受文档按宿主语义静默缺席；表键与记录 id 不一致按坏记录处理。
- [ ] 写入被拒映射为 `script_storage_unavailable`，随后关闭域、重新打开、重建内存视图与调度器，不盲目重试；恢复期间管理操作明确失败。
- [ ] 正常关闭先停止调度器与工具等生产者，再排干服务层 FIFO，最后幂等关闭存储域，不遗留游离写入或定时器。
- [ ] 测试覆盖崩溃恢复、孤儿清理、两类坏记录、I/O 结果未知、关闭顺序，以及 connection/reset 后面板经 list/view 回读权威状态。
