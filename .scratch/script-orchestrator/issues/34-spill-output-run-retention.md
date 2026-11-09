# 34: 查看完整输出并自动裁剪 run 历史

**What to build:** 用户既能看到 run 的输出尾部，也能在溢写成立时读取完整 stdout/stderr；系统按保留规则自动裁剪历史并清理对应溢写文件。

**Blocked by:** 29 — 取消在途 run 并安全删除编排

**Status:** resolved

- [x] stdout/stderr 分别实现内存尾部与 spill 双层收集，`maxSpillBytes` 默认 8 MiB/流、0 禁用，超 cap 撤回对应 spillPath 且不影响内存尾部。
- [x] 输出按 UTF-8 处理，tail 保留解码后末 2048 code point 和 U+FFFD；`truncated = lossy` 不受 spill 是否存在影响，run 字段与事件载荷保持契约形状。
- [x] 面板可读取每流完整 spill，文件不存在时显示明确排障态；事件中的 tail 仍遵守 64 KiB 兜底，不广播完整输出。
- [x] 每编排与全库保留上限均在 run 结算后的同一服务槽位执行，按 `settledAt`/`runId` 定序，未结算 run 永不淘汰，暂时超限可由后续结算收敛。
- [x] 裁剪与级联删除时 best-effort 清理对应 spill，不做启动扫描；删除记录与文件清理失败均有可诊断行为。
- [x] Windows 实测复现 W2 的完整 spill 可读和超 cap 撤回，并覆盖 UTF-8 截断、保留定序、未结算保护、级联清理与面板读取。

## Comments

- **双层收集与 tail 已在票 26 交付**（`maxOutputBytes` / `maxSpillBytes` 配置、`truncated = lossy`、`execution-utils.tailText` 末 2048 code point、事件载荷 64 KiB UTF-8 预算兜底）；本票补齐**完整读取**与**保留裁剪**并做 Windows 实测复验。
- **交付**：
  - `lib/retention.js`（新）：`createRetentionPolicy().enforce()`——每编排 `maxRunsPerOrchestration`（默认 100）与全库 `MAX_TOTAL_RUNS = 1000` 双上限；淘汰对象限已结算 run（`settledAt` 非空），按 `settledAt` 升序、并列 `runId` 字典序；「每编排超限 ∪ 全库超限」去重后一次 `deleteMany`（域表无该面时逐键 delete 兼容）；被裁 run 的 `stdoutSpillPath`/`stderrSpillPath` best-effort `unlink`；任何失败只记内部日志（容忍暂时超限，由后续结算与票 35 启动对账收敛）。
  - `lib/runner.js`：`settle`/`settleSkip` 在写 2（`runs.put`）后、事件发布前调用 `enforceRetention()`（try/catch 包裹，绝不因裁剪失败影响结算与事件）。
  - `lib/service.js`：`readSpill({ runId, stream })`——未知 run → `script_unknown`；无溢写路径/文件不存在/不可读 → `script_storage_unavailable`（`details.cause` = `spill-unavailable` / `ENOENT` 等）；成功返回 `{ runId, stream, path, content, bytes }`（`bytes` 为 UTF-8 字节计量）。
  - `lib/bridge.js`：新增 `spill` 端点（最小形状校验：`runId` 非空字符串、`stream ∈ {stdout, stderr}`；深层语义由服务判定；`OrchestratorError` 同构映射）。
  - `lib/client.js`：RunCard 对存在溢写路径的流显示「stdout 全量 / stderr 全量」按钮 → `spill` 端点 → 全文模态（可滚动 pre + 字节数）；加载态/失败排障态（显示错误码与消息，并说明「溢写文件已不存在时属正常现象」）。
  - `lib/index.js`：接线 `fs: node:fs/promises`（`readSpill` 与 delete 级联 spill 清理此前因未接线而实际为空操作）与 `retention` 策略。
- **测试**：pkg 内 vitest **17 文件 563 测试全绿**（较票 29 基线 534 +29：retention 10、service readSpill 7、bridge spill 3、client spill UI 3、runner 裁剪接线 3、execution.process W2b + UTF-8 2、tailText U+FFFD 1）。
- **Windows 实测**（`scripts/verify-ticket34.ps1` 两轮无头宿主，动态端口 + 自建 DSH_HOME，全断言通过）：
  - 轮 1（`maxOutputBytes 500` / `maxSpillBytes 65536` / `maxRunsPerOrchestration 2`）：200 行输出 → `truncated=true` + `stdoutSpillPath` 成立；`spill` 端点读到全量（含首行 line-0000 与末行 line-0199，内存尾部只留末段），bytes 与 UTF-8 内容一致；连跑 3 次 → 保留 2 条、run1 被淘汰且其 spill 文件已删除；被裁 run 的 spill 读取 → `script_unknown`；手工删文件后读取 → `script_storage_unavailable`（「已不存在」排障态）。
  - 轮 2（`maxSpillBytes 500`）：超 cap 撤回 → `stdoutSpillPath` 缺省、`truncated` 仍 true、内存尾部含末行；`spill` 端点 → `spill-unavailable`（W2b 复现）。
  - UTF-8：进程集成测试覆盖多字节输出截断（tail 为解码文本末段、编码/解码往返一致、末行完整）；`tailText` 单测覆盖 U+FFFD 如实保留并计入。
- **契约偏差（需上游/契约关注）**：
  1. **新增第 7 个桥端点 `spill`**：契约 11 端点表为六端点（零翻译 DTO），但「面板可读取每流完整 spill」在浏览器侧只能经桥；端点参数为最小形状校验、返回 `{ runId, stream, path, content, bytes }`（排障读面）。建议走 10-decisions 流程补入契约 11。
  2. **裁剪执行位置**：本实现中 run 的两次写入由 runner 直接写域表（既有架构），裁剪在 `settle`/`settleSkip` 的同一 FIFO 槽内、写 2 之后执行——语义等同契约 08「结算写入后在同一服务槽位内顺带执行」，但非「服务层方法内联」的字面结构。
  3. `readSpill` 的「溢写缺失/文件不可读」复用错误码 `script_storage_unavailable`（契约 09 中该码定义为存储域不可用；此处扩展为存储侧读取失败，`details.cause` 区分）。
- **残余风险**：`spill` 端点单次返回完整文件（≤ `maxSpillBytes` 上限，默认 8 MiB/流），大文件对桥为单次大响应；面板为排障人工触发、非自动轮询，未做分块/流式读取。全库上限 1000 为契约固定值，未做可配置。
