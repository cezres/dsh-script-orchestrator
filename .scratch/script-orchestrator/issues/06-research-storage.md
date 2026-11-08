# 核实存储域与 JSON 持久化

Type: research
Status: resolved
Labels: wayfinder:research
Research branch: research/storage-domain
Findings: .scratch/script-orchestrator/research/storage-domain.md
Research commit: 3acb6d0533986dfdc1a1aee979576d4fc1076e2b

## Question

DSH `0.2.2-rc.1` 的 `ctx.storageDomain.open(defineDomain(...))` 与 JSON 后端如何定义 `single` 域、表、版本、`compatibleVersions` 和 `invalidRecords: 'backup-and-skip'`？核实 loadAll、内存视图、事务/批写、并发写序、关闭、损坏记录备份及跨版本归一化的真实接口和保证，判断两次写入、FIFO 队列、级联删除和保留裁剪契约是否可实现。

## Answer

当前存储契约不能原样实现，已核实以下宿主事实：

1. 单元名只允许 `^[a-z][a-z0-9_]*$`，所以 `script-orchestrator` 会在声明期失败；可改为 `script_orchestrator`，JSON 文件名随之变化。无 global 的 spec 必须省略该字段，不能显式传 `global: null`。
2. JSON `single` 不实现 `backupRecord`，单条 schema 坏记录仍使整个 `open` 失败；只有 `per-record` 提供单条备份跳过，但畸形、不可读或版本不接受的文档会被视为不存在。
3. Domain 提供每域跨表 FIFO，成功顺序为后端发布、更新内存、发出事件。run 开始/结算两次 put 与同步内存查询可实现；复合操作仍需服务层 FIFO，关闭前必须先停生产者并排干服务队列。
4. 没有跨表事务，编排与 runs 不能严格同批级联删除；需要幂等多步删除、启动孤儿清理或持久 pending 标记。
5. 新 run put 与保留裁剪 deleteMany 是两个发布点，裁剪可做但非原子，需要失败恢复、启动对账和确定的淘汰次序。
6. `compatibleVersions` 只做版本准入；打开仅做当前 schema 的内存归一化，不自动全量落库，当前版本戳下可能仍混有旧形状记录。
7. 运行期 put/update 不自动 schema.parse，键与 id/runId 一致也需插件校验。I/O 拒绝不代表磁盘未改，不能盲目重试；JSON 后端没有跨进程写锁。

完整证据：[存储域研究报告](D:/projects/dsh-script-orchestrator-research-storage-domain/.scratch/script-orchestrator/research/storage-domain.md)，分支 `research/storage-domain`，commit `3acb6d0533986dfdc1a1aee979576d4fc1076e2b`。
