# 统一工具与服务的管理接口

Type: grilling
Status: resolved
Labels: wayfinder:grilling

## Question

五个 `script_*` 工具与 `ctx.scriptOrchestrator` 服务应在哪些语义上完全一致、哪些展示差异是刻意设计？重点解决服务 `EditInput` 只有 update/delete 而工具有 pause/resume/delete 的冲突，`active` 过滤与 active/paused/ended 状态的关系、list 分页返回、delete 级联、乐观并发，以及 availableActions 返回名称还是名称加 description。还需明确 script_edit 四种 action 各自的成功返回形状。目标是形成供工具、服务和 Web 面板共用的单一管理契约。

工具适配层还需决定是否坚持所有 malformed arguments（包括多余字段）都返回 `script_input_invalid` JSON：若是，应采用原始 `ctx.tools.register`、严格 JSON Schema 和 `validateJsonSchemaValue`，而非让 defineTool 预校验抛宿主 INVALID_ARGS；同时统一成功值/错误值的单块 JSON render 和 output schema。宿主事实见 [核实工作区插件、工具与配置机制](04-research-plugin-runtime.md)。

## Comments

- 2026-11-07：用户接受 Q1–Q10 全部推荐（「都按推荐」）：分层总则、EditInput 四 action 对齐与成功返回、乐观并发全 action、active 过滤、list 同形、delete 级联含在途取消、availableActions 带 description + `listActions()`、严格校验方案 A、统一 render/output schema、wait 超限尽力等待。
- 2026-11-07：用户接受 Q11（「都按推荐」），pause/resume 定为状态设置语义：仅从 `active`/`paused` 生效，其余状态幂等 no-op、不重锚；update 不限状态（ended 可复活）；delete 任何状态可执行。
- 2026-11-07：用户接受 Q12（「都按推荐」），`script_run` 对 `paused`/`ended` 均放行，拒绝仅 id 不存在。
- 2026-11-07：Q13 用户批准共识与落盘范围，同步契约、维护 ticket 10 票面并关票。
- 2026-11-08：[确定存储布局与故障恢复契约](14-storage-recovery.md) 把第 2/8 条的「同批删除」细化为「同一服务操作 + 启动孤儿清理」的物理语义；用户可见语义（delete 成功即完成、`removedRuns` 口径）不变。

## Answer

用户确认以下完整方案：

1. **分层总则**：语义（校验、错误码、状态迁移、乐观并发、分页过滤、级联、注册动作表）一律以服务为准、只定义一次，工具是薄适配层；Web 面板将来复用同一服务语义。刻意差异仅五项：参数 schema 校验与 `script_input_invalid` 映射、单块 JSON render 与 output schema、abort 走宿主 `ABORTED*`（不造 `script_aborted`）、`actorSessionId` 自动取 `exec.agent?.session.id`、`list`/`view` 不带 `signal`。
2. **`EditInput` 对齐**：`action: 'update' | 'pause' | 'resume' | 'delete'`，工具 1:1 透传，方法仍叫 `edit`。成功返回：`update`/`pause`/`resume` → 完整 `OrchestrationView`；`delete` → `{ id, removedRuns }`。
3. **pause/resume 状态设置语义**：`pause` 仅从 `active` 生效，`resume` 仅从 `paused` 生效（运行期无解转 `ended`）；对其余状态幂等 no-op、返回当前 View、不重锚（重复 resume 不重锚 fixed-delay）。`update` 不限状态（`ended` 可经重算触发复活为 `active`）；`delete` 任何状态可执行，id 不存在 → `script_unknown`。
4. **乐观并发**：`expectedUpdatedAt`（`null` = 此前没有更新时间）对四种 action 均可选，不匹配一律 `script_conflict`。
5. **`active` 过滤**：`true` → 恰好 `status === 'active'`；`false` → `paused` + `ended`；省略 → 全部；不引入 `status` 过滤参数。
6. **list 返回统一**：服务与工具同形 `{ items, total, nextOffset }`，`nextOffset = offset + items.length`，取尽为 `null`。
7. **availableActions 与 listActions**：`script_view` 返回 `Array<{ name, description? }>`（按 `name` 排序）；服务新增 `listActions(): Array<{ name, description? }>` 作为唯一数据源；执行期逐动作查表语义不变（沿用 [统一动作命名与注册契约](08-action-naming.md)）。
8. **delete 级联**：排队 run 直接取消；在途 run 走整 run 取消（`signal` 中止动作 + 脚本 `terminate()`，复用插件卸载路径），等待结算为 `canceled` 后**同批**删除编排与全部 run 记录；`removedRuns` 含被取消项。等待有界：脚本 terminate（5 秒 grace + 强杀）+ 各动作自身 `timeoutSeconds`。孤儿结算（删后丢弃写入）与拒绝删除（等自然结束）被否。
9. **`script_run` 放行口径**：`paused`、`ended` 均允许手动执行（`trigger = 'manual'`，不改 `nextOccurrence`）；拒绝仅 id 不存在。
10. **`wait: true` 尽力等待**：最长 `script.timeoutSeconds + 30` 秒；超限不报错，返回当前（可能非终态的）`RunView`，调用方用 `script_view` 轮询；不新增错误码、不挪用动作 `timeout`。此结论同时封口研究报告点名的「等待上限错误映射」空缺。
11. **严格校验方案 A**：原始 `ctx.tools.register` + 严格 JSON Schema（`additionalProperties: false`）+ `validateJsonSchemaValue` 自行校验；多余字段 `reason: 'unexpected'`、缺失 `missing`、越界 `range`、类型/语法 `format`，均带准确 `field`，全部映射 `script_input_invalid` JSON；`defineTool` 简写否决。
12. **统一 render 与 output schema**：`execute` 返回 JSON 值；`output.render` 一律单块 `JSON.stringify(value)` 文本；`output.schema` 用 `oneOf` 联合成功 + 各错误分支（`required` + `const code` + `additionalProperties: false` 互斥）；未分类异常映射 `internal_error` 值并记日志；实现自身的 schema 错误让宿主 `ToolOutputError` 暴露。
13. **版本口径**：实现前契约调整，存储域仍从版本 1 起步；README 变更记录加 v0.1e。

已同步契约：[02-triggers](../../../docs/temp/02-triggers.md)（pause/resume 幂等口径）、[06-events-service](../../../docs/temp/06-events-service.md)（四 action `EditInput`、`ListResult`/`DeleteResult`、`listActions()`、方法表）、[07-tools](../../../docs/temp/07-tools.md)（分层总则、各工具口径、适配层约定节）、[09-states-errors](../../../docs/temp/09-states-errors.md)（ended 手动执行、幂等注记、`script_conflict` 适用面）、[10-decisions](../../../docs/temp/10-decisions.md)（关键分叉加行）、[README](../../../docs/temp/README.md)（v0.1e）。地图维护：[澄清执行排队取消与等待语义](10-execution-lifecycle.md) 票面已把「wait 上限工具侧语义」划归本票结论，只留执行侧细节。
