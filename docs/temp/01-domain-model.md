# 01 · 领域模型

## 实体

```
orchestration 1 ──── n run
orchestration.actions{name → action}      // 具名动作，judge 用动作键引用
run.matchedRule                          // 命中的规则下标，未命中为 null
```

- **orchestration**：持久化，可增删改、可暂停；一条记录就是一份完整配置。
- **run**：每次触发一条，先落库再执行；保留最近 N 条（见 [08-storage](08-storage.md)）。
- **action**：不独立存储，随编排定义；`run.actions[]` 记录本次每个动作的结果。
- 其他插件注册的动作不落在编排里，只按名字解析（见 [06-events-service](06-events-service.md)）。

## 编排字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 创建后固定 | `^[a-z0-9][a-z0-9-]{0,63}$`；创建时可省略，由标题生成并保证唯一 |
| `title` | string | 是 | 1–120 字符，去首尾空白 |
| `enabled` | boolean | 否 | 默认 `true`；`false` 等同暂停 |
| `overlap` | `'skip' \| 'queue'` | 否 | 默认 `'skip'`，同一编排上次未结束时本次如何处理 |
| `trigger` | object | 是 | 见 [02-triggers](02-triggers.md) |
| `script` | object | 是 | 见 [03-execution](03-execution.md) |
| `judge` | object | 是 | 见 [04-judge](04-judge.md) |
| `actions` | object | 是 | 动作键 → 动作定义，见 [05-actions](05-actions.md)；动作键 `^[a-z][a-z0-9-]{0,63}$`，无点号，无保留名 |
| `createdAt` / `updatedAt` | ISO 时间 | 只读 | 存储层写入 |
| `status` | `'active' \| 'paused' \| 'ended'` | 只读 | 见 [09-states-errors](09-states-errors.md) |
| `nextOccurrence` | ISO 时间 \| null | 只读 | 下次自动触发；`paused` / `ended`，或 `fixed-delay` 等待自动 run 结算时为 `null` |

## 完整示例

```json
{
  "id": "nightly-deploy-check",
  "title": "夜间部署巡检",
  "enabled": true,
  "overlap": "skip",
  "trigger": { "kind": "cron", "expression": "0 3 * * *", "timeZone": "Asia/Shanghai" },
  "script": {
    "command": "pwsh",
    "args": ["-NoProfile", "-File", "./scripts/check-deploy.ps1"],
    "cwd": "D:\\projects\\demo",
    "env": { "CHECK_MODE": "full" },
    "timeoutSeconds": 300
  },
  "judge": {
    "rules": [
      { "when": { "exitCode": 0 }, "actions": ["emit-ok"] },
      { "when": { "exitCode": { "not": 0 } }, "actions": ["emit-bad", "page-oncall", "open-triage"] },
      { "when": { "stdout": { "regex": "\\bfail(ed|ure)\\b", "flags": "i" } }, "actions": ["open-triage"] }
    ],
    "fallback": ["emit-bad"]
  },
  "actions": {
    "emit-ok": { "kind": "event", "name": "deploy-ok" },
    "emit-bad": { "kind": "event", "name": "deploy-bad" },
    "page-oncall": {
      "kind": "plugin",
      "action": "ops.oncall",
      "payload": { "severity": "page", "summary": "{{orchestrationTitle}} 退出码 {{exitCode}}" }
    },
    "open-triage": {
      "kind": "session",
      "mode": "persistent",
      "title": "部署异常排查",
      "cwd": "D:\\projects\\demo",
      "prompt": "巡检脚本退出码 {{exitCode}}。stdout 末段：\n{{stdoutTail}}\n请定位原因并给出修复方案。"
    }
  }
}
```

## 执行记录字段（`run`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `runId` | string | `run-<8 hex>` |
| `orchestrationId` | string | 所属编排 |
| `trigger` | `'every' \| 'cron' \| 'manual'` | 本次由什么触发；工具触发记为 `manual` |
| `scheduledAt` | ISO 时间 | 计划触发时刻（手动触发取调用时刻） |
| `startedAt` / `settledAt` | ISO 时间 \| null | 实际开始与结算时刻 |
| `status` | 见 [09](09-states-errors.md) | 执行状态 |
| `skipReason` | string \| null | `overlap` / `disabled` / `concurrency` |
| `script` | object | 脚本结果：`{ command, exitCode, signal, timedOut, durationMs, stdoutTail, stderrTail, truncated, stdoutSpillPath?, stderrSpillPath?, warnings? }` |
| `matchedRule` | number \| null | 命中规则下标；`fallback` 命中为 `null` 且 `usedFallback: true` |
| `usedFallback` | boolean | 是否走了 fallback |
| `actions` | array | 每项 `{ name, kind, status, error?, warnings?, sessionId? }`；`warnings` 为字符串数组（模板警告 + `report()` 进展，保留最近 20 条）；`sessionId` 仅 `session` 动作有——成功与 `delivery_failed` 均记（供人工接管与追溯） |
| `result` | object \| 缺省 | 执行结果上报（v0.1y，见 [03-execution](03-execution.md)「结果上报」）：`{ summary?, level?, fields?, reports? }`。`summary`（≤ 300 code points）/`level`（`'info' \| 'warn' \| 'error'`）/`fields`（≤ 8 项 string→string）来自脚本 stdout 标记行；`reports` 为会话经 `script_report` 追加的上报数组，每项 `{ at, sessionId?, summary, level?, fields? }`，每 run 最多 10 条。整个字段可缺省（未上报） |

`stdoutTail` / `stderrTail` 各最多 **2048 个 code point**（超出取解码后文本末尾并置 `truncated: true`），`stdoutSpillPath` / `stderrSpillPath` 指向子进程服务给出的完整输出溢写文件（若有；超 cap 撤回则缺省），`warnings` 为脚本阶段非致命事实（见 [03-execution](03-execution.md)）。`script.truncated` 表示 stdout 或 stderr 任一在收集阶段被截断（判定即 `lossy`，溢写存在不改变它）。

## 命名与版本约定

- 时间统一为 **ISO-8601 UTC 毫秒**字符串，例如 `2026-11-07T19:00:00.000Z`；时区信息只出现在 cron 的 `trigger.timeZone` 中，`every` 不使用时区。
- 存储域版本从 **1** 开始；字段语义变化必须升版本并写 `compatibleVersions`，见 [08-storage](08-storage.md)。
- 工具名、事件名、服务键一旦发布即冻结；改名视为破坏性变更。
