# 确定存储布局与故障恢复契约

Type: grilling
Status: resolved
Labels: wayfinder:grilling
Blocked by: 06

## Context

- [核实存储域与 JSON 持久化](06-research-storage.md)：宿主名称约束、备份能力、写链、原子性和版本行为的事实来源。

## Question

在宿主真实能力下，v0.1 应如何修正存储契约？需要确定合法域名与文件布局、`single` 或 `per-record`、坏记录处置、单 Host 写者前提、服务 FIFO 与关闭顺序、级联删除和保留裁剪的幂等恢复、未结算/并列时间记录的淘汰次序、版本归一化的写回时机、写入前 schema 与键/id 校验、I/O 结果未知时的恢复，以及统一 `script_storage_unavailable` 错误码。目标是让持久化保证可实现、可测试，不再宣称宿主没有提供的原子性或自动迁移。

## Comments

- 2026-11-08：用户接受 Q1–Q11 全部推荐（「都按推荐」），并于 Q12 批准共识与落盘范围。

## Answer

用户确认以下完整方案：

1. **域名与声明**：存储域名 `script_orchestrator`（文件/目录名随之）；spec 省略 `global` 字段；插件行 id、事件命名空间、服务键保持连字符不变。
2. **布局改 `per-record`**：每记录一个文件（键合法已核实）；放弃 `single`（全域开门失败、无备份跳过、全库重写放大）。
3. **坏记录双层语义**：schema 失败 → `.bak.<本地时间YYYYMMDDHHmm>`（同分钟覆盖前份）+ 跳过 + 错误日志；畸形/不可读/版本不接受 → 后端**静默视为不存在**（契约如实声明）。
4. **单 Host 写者前提**：域只由本插件在唯一 Host 进程读写；跨进程并发写不在保证范围。
5. **服务层 FIFO 与关闭**：复合操作（create/edit/delete、run 开始/结算、级联、裁剪）整槽位入队，单槽失败不毒化队列；关闭顺序＝停生产者 → 排干服务队列 → `domain.close()`。
6. **级联删除可恢复语义**：「同批」物理原子改为「同一服务操作、成功即完成、失败可恢复」：槽位内先删编排记录再 `deleteMany` runs；崩溃残留由启动孤儿清理（`orchestrationId` 无父即删，幂等）收尾；不引入 pending-mutation 标记；用户可见语义与 `removedRuns` 口径不变。
7. **裁剪算法**：结算写入后同槽位执行；目标＝每编排超限 ∪ 全库超限，一次 `deleteMany`；未结算 run 不计入淘汰、不可删除；次序 `settledAt` 升序、并列 `runId` 字典序；失败容忍暂时超限，由后续结算与启动对账收敛；「只写两次」明确排除恢复/对账/裁剪的维护写。
8. **版本惰性写回**：decoder 接受全部兼容版本旧形状；仅显式重写时落盘归一化值；版本戳 ≠ 全量迁移完成；不设迁移完成事件。
9. **写入前校验**：每次 put/update 前插件自行 schema.parse；打开后逐条校验表键 = `id`/`runId`，不一致按坏记录处置。
10. **I/O 未知恢复**：不盲目重试；`script_storage_unavailable` → 关闭域 → 重开读实际状态 → 重建内存视图与调度器 → 继续；恢复期间管理操作以该码失败；如实声明「写被拒不证明磁盘未变」窗口。
11. **错误码统一**：全文档 `script_storage_unavailable`（08 原 `storage_unavailable` 系笔误）；宿主 `DomainError`/`StorageError` 到契约错误码的映射由写入层负责。
12. **版本口径**：实现前契约调整，存储域从版本 1 起步；README 变更记录加 v0.1g。

已同步契约：[08-storage](../../../docs/temp/08-storage.md)（整体重写）、[07-tools](../../../docs/temp/07-tools.md)（delete 级联措辞）、[09-states-errors](../../../docs/temp/09-states-errors.md)（`script_storage_unavailable` 扩写）、[10-decisions](../../../docs/temp/10-decisions.md)（关键分叉加行）、[README](../../../docs/temp/README.md)（v0.1g）。地图维护：[统一工具与服务的管理接口](09-management-interface.md) 补注「同批删除」细化；[澄清执行排队取消与等待语义](10-execution-lifecycle.md) 补存储侧排除口径指针。
