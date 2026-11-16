# 07 · 工具契约（模型侧）

六个工具，前缀 `script_`，与既有 `schedule_*`（prompt 投递）互不重叠。全部返回单块 JSON 文本；失败返回 `{ "code", "message", "details"? }`。

## 分层总则

语义一律以 `ctx.scriptOrchestrator` 服务为准——校验规则、错误码、状态迁移、乐观并发、分页过滤、级联、注册动作表只定义一次；工具是薄适配层，不自带业务规则（Web 面板将来复用同一服务语义）。刻意差异仅限传输/展示层：

1. 模型参数的 schema 校验与 `script_input_invalid` 映射（见「适配层约定」）；
2. 单块 JSON `output.render` 与 `output.schema`；
3. abort 采用宿主规范结果（`ABORTED` / `ABORTED_BEFORE_DISPATCH`），不定义 `script_aborted`；
4. `actorSessionId` 自动取 `exec.agent?.session.id`（服务参数保留，其他调用方自行传入）；
5. `list`/`view` 不带 `signal`（服务签名如此，不做形式统一）。

| 工具 | 作用 | 主要错误 |
|---|---|---|
| `script_create` | 新建编排 | `script_input_invalid` |
| `script_list` | 分页列出 | `script_input_invalid` |
| `script_view` | 单条详情 + 最近执行 | `script_unknown` |
| `script_run` | 立即执行一次 | `script_unknown`、`script_conflict` |
| `script_report` | 会话向执行记录上报结果（v0.1y） | `script_unknown`、`script_input_invalid` |
| `script_edit` | 更新 / 暂停 / 恢复 / 删除 | `script_unknown`、`script_conflict`、`script_input_invalid` |

## script_create

参数：

```jsonc
{
  "title": "夜间部署巡检",
  "trigger": { "kind": "cron", "expression": "0 3 * * *", "timeZone": "Asia/Shanghai" },
  "script": { "command": "pwsh", "args": ["-NoProfile", "-File", "./check.ps1"], "cwd": "D:\\projects\\demo" },
  "judge": { "rules": [{ "when": { "exitCode": 0 }, "actions": ["emit-ok"] }], "fallback": ["emit-bad"] },
  "actions": {
    "emit-ok": { "kind": "event", "name": "deploy-ok" },
    "emit-bad": { "kind": "event", "name": "deploy-bad" }
  },
  "enabled": true,
  "overlap": "skip"
}
```

返回：完整 `OrchestrationView`（含生成的 `id`、`status`、`nextOccurrence`）。

校验在落库前完成：触发表达式、动作键引用、模板变量合法性、动作数量上限。任一不通过则不写入任何记录。

## script_list

参数：`{ "active"?: boolean, "limit"?: 1..500, "offset"?: number }`，默认 `limit = 100`。`active: true` 只返回 `status === 'active'`；`false` 返回 `paused` 与 `ended`；省略返回全部。

返回：`{ "items": OrchestrationView[], "total": number, "nextOffset": number | null }`（`nextOffset = offset + items.length`，取尽为 `null`），与服务 `list` 同形。

## script_view

参数：`{ "id": string, "runs"?: 0..50 }`（默认 5）。

返回：`OrchestrationView` + `runs: RunView[]` + `availableActions: Array<{ "name": string, "description"?: string }>`（来自服务 `listActions()` 的注册动作表快照，按 `name` 排序，用于核对拼写与发现能力）。

## script_run

参数：`{ "id": string, "wait"?: boolean }`（默认 `true`）。`paused`、`ended` 编排均允许手动执行；拒绝只发生在 id 不存在（`script_unknown`）。

- **排队身份**：手动执行与自动触发共用同一排队体系（占并发槽、进单飞屏障），但**不被 `overlap: 'skip'` 淘汰**（排队等上次结算）；全局溢出丢弃不豁免手动——被丢时返回 `skipped` RunView（`skipReason: 'concurrency'`），可见非静默（见 [03-execution](03-execution.md)）。
- `wait: true`：**尽力等待**本次结算，最长 `script.timeoutSeconds + 30` 秒；超限不报错，返回当前（可能非终态的）`RunView`，调用方稍后用 `script_view` 观察。不为此新增错误码，也不挪用动作 `timeout`。
- `wait: false`：立即返回 `{ runId, status }`，之后用 `script_view` 观察。
- **abort**：`exec.signal` 转为该 run 的取消请求（按 [03-execution](03-execution.md) 取消矩阵执行），等 run 结算 `canceled` 且持久化完成后，工具 Promise 才以宿主 `ABORTED` 静止；`wait: false` 已返回的 run 同样被取消（取消不依赖等待者存在）。

不改变下次自动触发时刻，`trigger = "manual"`；`fixed-delay` 只由自动 run 的终态推进。

## script_report

脚本调起的 AI 会话用它把**执行结果**写回 run 记录（v0.1y）；编排详情的执行记录会优先展示这些信息。参数：

```jsonc
{ "runId": "run-7f3c1a9e", "summary": "已归档 12 个文件到 3 个目录", "level": "info", "fields": { "文档": "8", "图片": "4" } }
```

- `runId` 从 session 动作首条消息 banner 的 JSON 块读取（`framing: "banner"` 时）；`summary` 必填（trim 后 1–300 code point）；`level` 可选（`'info' | 'warn' | 'error'`，默认 `'info'`）；`fields` 可选（≤ 8 项 string→string，键 1–40、值 1–100 code point）。限制与脚本标记行一致（见 [03-execution](03-execution.md)「结果上报」）。
- run 任意状态（含在途）可上报；每 run 上限 **10 条**，超出返回 `script_input_invalid`（`details: { field: "report", reason: "limit" }`）——后续结果放进最终答复即可。`runId` 不存在（含已被裁剪删除）→ `script_unknown`。
- `sessionId` 自动取调用会话（`exec.agent?.session`），无需也不接受传入。
- 成功返回 `{ "runId", "orchestrationId", "status", "result" }`（`result` 为该 run 当前完整结果对象，含脚本侧标记行与全部 `reports`）。写入走服务 FIFO，落库后发 `script-orchestrator/changed`。

## script_edit

参数：

```jsonc
{ "id": "nightly-deploy-check", "action": "update", "patch": { "title": "..." }, "expectedUpdatedAt": "2026-11-07T...Z" }
{ "id": "nightly-deploy-check", "action": "pause" }
{ "id": "nightly-deploy-check", "action": "resume" }
{ "id": "nightly-deploy-check", "action": "delete", "expectedUpdatedAt": "2026-11-07T...Z" }
```

- `expectedUpdatedAt` 对四种 action 均可选：给出时做乐观并发，不匹配返回 `script_conflict`（`null` 表示「此前没有更新时间」）。
- `update` 的 `patch` 至少一个字段；仅调度字段修改重建下次触发，非调度编辑不改变它；不限编排状态，`ended` 可经重算触发复活为 `active`。
- `pause`/`resume` 按**状态设置**语义：`pause` 仅从 `active` 生效（保留记录、停止新的自动触发、不取消已有 run、`nextOccurrence = null`）；`resume` 仅从 `paused` 生效（不补跑暂停期，按 [02-triggers](02-triggers.md) 的模式规则重算，运行期意外无解则转为 `ended`）。对其余状态（对已暂停的 `pause`、对激活中的 `resume`、对 `ended` 的 `pause`/`resume`）为幂等 no-op：返回当前 View、不改任何计时、绝不重锚 fixed-delay。
- `delete` 任何状态可执行，id 不存在返回 `script_unknown`：已排队 run 直接取消；在途 run 走整 run 取消（`signal` 中止动作 + 脚本 `terminate()`，同插件卸载路径），等待结算为 `canceled` 后在同一服务操作内删除编排及其全部 run 记录（先删编排再删 runs；崩溃残留由启动孤儿清理幂等收尾，见 [08-storage](08-storage.md)）。等待有界：脚本 terminate（5 秒 grace + 强杀）+ 各动作自身 `timeoutSeconds`。

成功返回：`update` / `pause` / `resume` → 完整 `OrchestrationView`（含新 `status` 与 `nextOccurrence`）；`delete` → `{ "id": string, "removedRuns": number }`（含被取消的排队/在途 run）。与服务 `edit` 同一契约。

## 结果示例

```json
{
  "id": "nightly-deploy-check",
  "title": "夜间部署巡检",
  "status": "active",
  "nextOccurrence": "2026-11-08T19:00:00.000Z",
  "lastRun": { "runId": "run-7f3c1a9e", "status": "failed", "settledAt": "2026-11-07T19:00:04.418Z" }
}
```

## 适配层约定（实现者）

- **严格参数校验**：六工具均以原始 `ctx.tools.register` 注册，`parameters` 为严格 JSON Schema（根 `additionalProperties: false`），在 `execute` 内用 `validateJsonSchemaValue` 自行校验并全部映射为 `script_input_invalid` JSON：多余字段 `reason: "unexpected"`、缺失 `missing`、越界 `range`、类型/语法 `format`，均带准确 `field`。不使用 `defineTool` 简写（其 schema 违规会抛宿主 `INVALID_ARGS`，破坏单一错误面）。服务层语义兜底（长度、条数上限等宿主 schema 子集表达不了的约束）同样映射 `script_input_invalid`（`reason: "format" | "limit"`）。
- **统一 render**：`execute` 返回 JSON **值**（不是字符串）；`output.render` 一律返回单块 `JSON.stringify(value)` 文本。
- **output schema**：用 `oneOf` 联合「成功形状 + 每个契约错误形状」，各分支以 `required` + `const code` + `additionalProperties: false` 保持互斥。RunView 成功分支顶层字段逐一枚举且 `additionalProperties: false`：01-domain-model 给 RunView **新增可选字段**（如 `result`）时必须同步补进该枚举，否则宿主输出校验直接拒绝工具返回。
- **错误分层**：已知业务失败返回 `{ "code", "message", "details"? }` 值；未分类异常映射 `internal_error` 值并记内部日志；实现自身的 output schema 写错让宿主 `ToolOutputError` 暴露，不吞成业务结果。
- **abort**：不定义 `script_aborted`；宿主以 `ABORTED` / `ABORTED_BEFORE_DISPATCH` 规范结果取代成功值，`exec.signal` 贯穿到执行层（详见 [03-execution](03-execution.md)）。

## 与 schedule_* 的区分（写给模型）

- `schedule_create`：定时把一段 instruction 投进会话，没有脚本、没有结果判定。
- `script_create`：定时跑脚本，按结果决定通知或开新会话。
- 用户说「定时提醒我」→ `schedule_*`；用户说「定时跑个脚本、失败就通知/开会话」→ `script_*`。
