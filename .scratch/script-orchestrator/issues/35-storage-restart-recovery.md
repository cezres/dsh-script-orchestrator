# 35: 从重启与存储故障中恢复

**What to build:** 插件经历崩溃、重启、坏记录或写入结果未知后，能以持久化事实恢复编排、run 和调度状态；用户在面板看到的是恢复后的权威视图，而不是内存残影。

**Blocked by:** 29 — 取消在途 run 并安全删除编排

**Status:** resolved

- [x] 启动将全部非终态 run 标为 `interrupted` 并照发一次 `run-settled`，不自动重放；fixed-delay 从恢复结算的 `settledAt` 推进，cron/fixed-rate 按既定错过合并恢复。
- [x] 启动幂等清理无父 run 并完成保留对账，级联删除中途崩溃不会留下永久孤儿或错误列表。
- [x] schema 坏记录执行 backup-and-skip 并记日志，畸形 JSON、不可读或版本不接受文档按宿主语义静默缺席；表键与记录 id 不一致按坏记录处理。
- [x] 写入被拒映射为 `script_storage_unavailable`，随后关闭域、重新打开、重建内存视图与调度器，不盲目重试；恢复期间管理操作明确失败。
- [x] 正常关闭先停止调度器与工具等生产者，再排干服务层 FIFO，最后幂等关闭存储域，不遗留游离写入或定时器。
- [x] 测试覆盖崩溃恢复、孤儿清理、两类坏记录、I/O 结果未知、关闭顺序，以及 connection/reset 后面板经 list/view 回读权威状态。

## Comments

- **交付**：
  - `lib/storage.js`：`openStorage` 启动维护补齐为契约 08 三步——① 非终态 run 标 `interrupted` + `run-settled(interrupted)` + fixed-delay 恢复推进（票 26 已有）；② **孤儿清理**：删除 `orchestrationId` 无父记录的全部 run（含未结算；级联删除崩溃残留，重开幂等）；③ **保留对账**：复用票 34 的 `createRetentionPolicy` 重算并补裁（未结算不可淘汰，settledAt/runId 定序）。维护在首次打开与恢复重开时共用同一函数（幂等）。
  - **I/O 结果未知的恢复**：存储门面包装每张表的写操作（`put`/`delete`/`deleteMany`）；写入 Promise 被拒时映射 `script_storage_unavailable`（`details.cause` 保留原始错误，**当前写不重试**）→ 关闭旧域 → 重新 `openDomain` → 重跑启动维护对账 → 清恢复标志 → `onRecovered()` 回调（index 接线为调度器重算 timer）。恢复期间读写一律 `script_storage_unavailable`（`details.cause='recovering'`），不静默返回空视图；重开失败则保持不可用并记日志。
  - `lib/index.js`：`openStorage({ config, fs: node:fs/promises, onRecovered })` 接线（启动对账的 spill 清理与恢复后调度器重建）。
  - 关闭顺序（票 24 起既有，本票补测试固化）：`scheduler.stop()` → 工具/桥注销 → `runner.shutdown()`（在途 run 有界取消）→ ephemeral `disposeAll` → `queue.close()`（排干已入队槽）→ `storage.close()`（幂等）。
- **测试**：pkg 内 vitest **17 文件 570 测试全绿**（本票 +7：孤儿清理幂等、启动保留对账、两类坏记录（键≠id 移除 + 宿主缺席语义）、I/O 恢复三例（成功恢复/恢复中失败/重开失败保持不可用）、关闭顺序）。
- **隔离集成验证**（`scripts/verify-ticket35.ps1`，两次冷启动，全断言通过）：启动 1 下 A 两次手动结算、B 长脚本 run 在途（running）后强杀宿主；改 `maxRunsPerOrchestration=2→1` 后启动 2——B 的在途 run 被标 `interrupted`（settledAt=恢复时刻、不伪造退出码）、A 的 2 条 settled run 按启动保留对账补裁为 1 条（settledAt 定序保留最新）、list 权威回读、执行引擎重建（A 再次执行成功且保留上限持续生效）、stderr 干净。面板侧 connection/reset 回读由既有 client 测试（subscribeReset → list 刷新）与票 32/33 的冷重启验证覆盖。
- **偏差与残余风险**：
  1. **恢复入口在存储门面**：I/O 恢复（关闭-重开-对账）由 `lib/storage.js` 的门面统一处理；runner/service/scheduler 无需感知（继续经 `storage.table()` 访问，恢复后自动指向新域）。与契约「插件处置流程固定」吻合，但非单一顶层恢复编排函数。
  2. **恢复期间的活跃 run**：I/O 未知后重开对账会把「非终态」run 标 `interrupted`（含可能仍在内存中执行的本进程 run）；该 run 若稍后正常结算，写入因 first-write-wins 对已终态记录 no-op——即该次执行结果不被持久化（保持 interrupted 事实）。契约未规定此竞态的进一步语义，如实声明。
  3. **坏记录的 .bak 备份**由宿主 domain 层（`invalidRecords: 'backup-and-skip'`）执行；插件层对「表键≠记录 id」的记录经写链删除并记日志（无 `.bak` 副本，见票 24 Comments）。畸形 JSON/不可读/版本不接受文档由宿主语义静默缺席，插件打开不崩溃；上述宿主侧行为以 fake domain 缺席语义测试，未在本机注入真实损坏文件做端点级验证。
  4. 级联删除中途崩溃的孤儿清理以单测注入（无父 run）验证；隔离脚本未直接构造磁盘孤儿/损坏记录（域 per-record 布局属宿主私有细节）。
