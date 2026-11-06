# 07 · 工具契约（模型侧）

五个工具，前缀 `script_`，与既有 `schedule_*`（prompt 投递）互不重叠。全部返回单块 JSON 文本；失败返回 `{ "code", "message", "details"? }`。

| 工具 | 作用 | 主要错误 |
|---|---|---|
| `script_create` | 新建编排 | `script_input_invalid` |
| `script_list` | 分页列出 | `script_input_invalid` |
| `script_view` | 单条详情 + 最近执行 | `script_unknown` |
| `script_run` | 立即执行一次 | `script_unknown`、`script_conflict` |
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

校验在落库前完成：触发表达式、动作名引用、模板变量合法性、动作数量上限。任一不通过则不写入任何记录。

## script_list

参数：`{ "active"?: boolean, "limit"?: 1..500, "offset"?: number }`，默认 `limit = 100`。

返回：`{ "items": OrchestrationView[], "total": number, "nextOffset": number | null }`。

## script_view

参数：`{ "id": string, "runs"?: 0..50 }`（默认 5）。

返回：`OrchestrationView` + `runs: RunView[]` + `availableActions: string[]`（当前已注册的插件动作名，用于核对拼写）。

## script_run

参数：`{ "id": string, "wait"?: boolean }`（默认 `true`）。

- `wait: true`：等待本次结算后返回 `RunView`；最长等待 `script.timeoutSeconds + 30` 秒。
- `wait: false`：立即返回 `{ runId, status }`，之后用 `script_view` 观察。

不改变下次自动触发时刻，不消耗 `COUNT`，`trigger = "manual"`。

## script_edit

参数：

```jsonc
{ "id": "nightly-deploy-check", "action": "update", "patch": { "title": "..." }, "expectedUpdatedAt": "2026-11-07T...Z" }
{ "id": "nightly-deploy-check", "action": "pause" }
{ "id": "nightly-deploy-check", "action": "resume" }
{ "id": "nightly-deploy-check", "action": "delete" }
```

- `update` 的 `patch` 至少一个字段；给出 `expectedUpdatedAt` 时做乐观并发，不匹配返回 `script_conflict`（`null` 表示「此前没有更新时间」）。
- `pause` 保留记录，停止触发；`resume` 重算下次触发，若表达式已用尽则直接 `ended`。
- `delete` 连同该编排的历史 run 一并移除，已排队未执行的 run 取消。

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

## 与 schedule_* 的区分（写给模型）

- `schedule_create`：定时把一段 instruction 投进会话，没有脚本、没有结果判定。
- `script_create`：定时跑脚本，按结果决定通知或开新会话。
- 用户说「定时提醒我」→ `schedule_*`；用户说「定时跑个脚本、失败就通知/开会话」→ `script_*`。
