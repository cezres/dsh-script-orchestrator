# 36: 完成 Windows 全链路交付验收

**What to build:** 安装者能在隔离 Windows 环境验证插件从创建编排到执行、分发、排障和删除的完整产品路径，并获得可复现的交付验收结果与如实残余风险说明。

**Blocked by:** 31 — 通过 plugin 动作调用注册能力；33 — 通过 ephemeral session 自动整理并回收；34 — 查看完整输出并自动裁剪 run 历史；35 — 从重启与存储故障中恢复

**Status:** ready-for-agent

- [ ] 实施 spec 的单元、集成和端到端测试矩阵全部通过，无以待实现、跳过或仅验证 happy path 的方式替代关键取消、故障和恢复用例。
- [ ] 以 file: 形态在隔离 profile 完成安装，`engines.dsh`、依赖闭包、Config、client graph 和 slot 均正确；HMR、冷重启、卸载及坏 client 启动级故障须知均按契约验收。
- [ ] 端到端依次验证五工具 smoke、分别创建的 every/cron 编排各自动执行、判定命中、event/plugin/session 三动作、四类事件、面板对话入口和居中模态 run 历史、删除级联。
- [ ] 复测 Windows W1/W2：原生 Job terminate 得到 `{ exitCode: 1, signal: null }`，spill 完整可读且超 cap 撤回；另行验证正常退出后存活后代的清理与 warning。
- [ ] 验证工具 abort 会取消 run 并等待持久化，Connection UI abort 只停止等待；验证事件后的权威回读、轮询停止条件和删除前后的记录可见性。
- [ ] macOS 只保留源码证据声明，不作为本验收门；裸 `.cmd`/`.bat`、Desktop 窗口、tsdown、flush/append、UI 可观测性、session 真实停用/卸载 teardown 证据边界、回收竞态和 file: rename 等残余风险均如实交接。
- [ ] 验收记录包含实际环境、命令、结果和失败证据，不将原型证据冒充正式实现验收，不修改真实用户 profile，不合并抛弃式原型分支。
