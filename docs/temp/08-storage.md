# 08 · 存储

## 域

| 项 | 值 |
|---|---|
| 域名称 | `script_orchestrator`（宿主单元名正则 `^[a-z][a-z0-9_]*$` 不含连字符；插件行 id `script-orchestrator`、事件命名空间、服务键的连字符写法互不受影响） |
| 版本 | `1` |
| 布局 | `per-record`（每记录一个文件；编排 id 与 `run-<8hex>` 键均满足后端键正则） |
| 表 | `orchestrations`、`runs` |
| 全局 | 无（spec **省略** `global` 字段，不写 `global: null`） |
| 坏记录 | `invalidRecords: 'backup-and-skip'`，两层语义见下 |
| 写者 | **单 Host 进程**：本域只由本插件在唯一 Host 进程内读写；JSON 后端无跨进程写锁，跨进程并发写不在保证范围 |

打开方式：`ctx.storageDomain.open(defineDomain({...}))`；句柄由插件 `ctx.effect` 持有，关闭顺序见「读写路径与恢复」。

## 记录与坏记录处置

逻辑视角是两张 KV 表：`orchestrations`（键 = `record.id`）与 `runs`（键 = `record.runId`）。`per-record` 布局下每个记录是后端目录里的一个文件，坏记录处置分两层，如实声明：

- **schema 校验失败**（文档可读、版本可接受，但记录不符合当前 schema）：改名 `.bak.<本地时间YYYYMMDDHHmm>`（同分钟重备覆盖前一份）、跳过该记录并记错误日志——该记录视为不存在。
- **畸形 JSON / 不可读 / 版本不接受的文档**：被后端**静默视为不存在**（无备份、无日志），属宿主行为，契约不做额外补救。

### 编排记录

`01-domain-model` 的全部字段 + `status`、`createdAt`、`updatedAt`、`nextOccurrence`。`enabled` 与 `status` 的一致性由写入层保证：`enabled: false` 等价于 `paused`。

### 执行记录

`run` 全部字段。`run.actions[].error` 只存 `{ code, message }`，不存堆栈；`stdoutTail` / `stderrTail` 已在入表前截到 2048 字符；`run.actions[].warnings` 为字符串数组，入表前已裁到最近 20 条。`run.result`（v0.1y，可选）：`summary` / `fields` 各自的上限在写入层校验（见 [01-domain-model](01-domain-model.md)），`reports` 由服务层保证 ≤ 10 条——存储 schema 只约束形状，不重复计数。

## 保留与裁剪

| 规则 | 值 |
|---|---|
| 每条编排保留最近 run | `maxRunsPerOrchestration`（默认 100） |
| 全库 run 上限 | `1000` |
| 裁剪时机 | run **结算写入后**在同一服务槽位内顺带执行，不单独定期清理 |
| 淘汰对象 | 已结算 run 中超出上述任一上限的最旧者；**未结算 run（`settledAt: null`）不计入淘汰、不可被裁剪删除** |
| 淘汰次序 | `settledAt` 升序，并列按 `runId` 字典序 |
| 执行方式 | 目标键 =「每编排超限 ∪ 全库超限」去重后一次 `runs.deleteMany`；失败容忍暂时超限，由后续结算写入与启动对账收敛 |

## 读写路径与恢复

- **打开**：`open` 内部 `loadAll` 后逐条 schema 校验（坏记录如上处置）；随后插件逐条校验**表键 = 记录内 `id`/`runId`**，不一致按坏记录处置；最后执行启动维护（见下）。
- **启动维护**：① 非终态 run 统一标 `interrupted`；② 孤儿清理：删除 `orchestrationId` 无父记录的全部 run（级联删除的崩溃残留，幂等）；③ 保留对账：按上表规则重算并补裁。
- **查询**：全部在内存完成（列表、过滤、分页），不触达后端。
- **写入**：复合操作（`create`/`edit`/`delete`、run 开始/结算、级联、裁剪）整体作为**服务层 FIFO** 的一个槽位入队，槽内「枚举 → 判断 → 多次 Domain 调用」不与其他操作交错；单槽失败不毒化队列。写入前由插件用对应 schema 显式 `parse`（Domain 运行期不复验）。
- **正常路径**：run 只写两次（开始、结算），中途状态（`running`/`judging`/`dispatching`）为内存态不落盘；恢复、对账、裁剪的维护写**不计入**「只写两次」。
- **结果上报写**（v0.1y）：`reportRunResult` 在 run 结算**之后**追加第三类写——同 FIFO 单槽内重读 run 记录、仅 merge `result`（脚本侧标记行在结算写内落库；会话侧 `reports` 追加），其余字段原样写回；每条上报一次写，不与结算写合并。在途 run 上的上报与结算写按 FIFO 全序串行，结算时保留已写入的 `reports`。
- **级联删除**：同一服务槽位内先删编排记录、再 `deleteMany` 其全部 run；无跨表事务，崩溃残留由启动孤儿清理收尾。delete 成功返回即两步均完成。
- **关闭**：先停生产者（调度器与工具入口拒绝新操作）→ 排干服务层队列 → `domain.close()`（幂等；排干已入链写入后拒绝读写）。

### I/O 结果未知的恢复

写入 Promise 被拒**不证明磁盘未变**（错误可能发生在文件替换之后）。处置流程固定：映射 `script_storage_unavailable` → 关闭域 → 重新打开读实际状态 → 重建内存视图与调度器 → 继续服务；恢复期间到达的管理操作以 `script_storage_unavailable` 失败。不做盲目重试。

## 升级策略

- 增加可选字段：不升版本，解码器给默认值。
- 改变字段语义或必填性：升 `version` 并把旧版本列入 `compatibleVersions`；当前 decoder 必须接受全部兼容版本的旧形状（打开时内存归一化）。
- **惰性写回**：仅当记录被显式重写时才落盘归一化值；文件版本戳为当前不代表全部记录已完成迁移；不设「全量迁移完成」事件，旧形状接受能力随兼容声明保留。
- 无法解码的记录按上文坏记录规则处置；域整体无法打开时报 `script_storage_unavailable`，由维护者决定备份重建或手写迁移；宿主不提供自动迁移。
