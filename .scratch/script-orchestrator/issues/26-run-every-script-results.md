# 26: 自动执行 every 编排并查看脚本结果

**What to build:** every 编排到点后自动运行脚本，用户能在面板看到 run 从受理到结算的过程以及退出码、超时和输出尾部等脚本结果。

**Blocked by:** 25 — 通过对话创建并查看 every 编排

**Status:** ready-for-agent

- [ ] fixed-rate 按上一次 `scheduledAt` 推进，fixed-delay 在自动 run 未结算时保持 `nextOccurrence = null`、结算后从 `settledAt` 推进；手动 run 尚不影响自动序列。
- [ ] runner 使用 argv 调用脚本，落实 cwd/allowedRoots 预检、env/stdin 适配、超时、`cancelReason` 分类和目录不存在时的 `spawn_failed`，不经过 shell。
- [ ] 执行生命周期具备单飞屏障、全局并发与队列方向、run 两写和终态唯一基础；自动 skip/queue 均产生可解释的完整 run 记录。
- [ ] 脚本退出后进入判定，零动作时按契约结算；输出按流保留解码尾部、`truncated = lossy`，收集超时与退出事实，不把正常非零退出自动等同执行失败。
- [ ] 正常退出后仍有存活后代时，有界等待 `waitForExit()` 2000ms，再清理进程范围并记录 `descendants-terminated`；Windows 路径有实际进程集成测试。
- [ ] `run-started`/`run-settled` 在对应持久写入与内存视图更新后发布，发布端异常兜底不影响主流程，listener 后立即 `view()` 能读到一致状态。
- [ ] 面板在可见且有活动 run 时轮询并展示脚本阶段结果；单元与集成测试覆盖调度锚点、队列、两写、输出和进程清理。
