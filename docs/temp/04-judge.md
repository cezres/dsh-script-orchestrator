# 04 · 判定 DSL

## 结构

```json
{
  "rules": [
    { "when": { "exitCode": 0 }, "actions": ["emit-ok"] },
    { "when": { "exitCode": { "not": 0 } }, "actions": ["emit-bad", "open-triage"] }
  ],
  "fallback": ["emit-bad"]
}
```

| 字段 | 规则 |
|---|---|
| `rules` | 数组，0–32 条；按顺序求值，**第一条命中者生效**，其余不再求值 |
| `rules[].when` | 谓词对象，必须至少含一个谓词键；未知键视为无效输入 |
| `rules[].actions` | 动作名数组，可空；名字必须在 `actions` 里定义，创建时**静态校验** |
| `fallback` | 无规则命中时执行的动作名数组；省略表示「无动作」（脚本结果仍记录，run 正常结算） |

判定是**纯函数**：只读本次 run 的脚本结果，不做 I/O、不调脚本、不写存储。

## 谓词

| 谓词 | 取值 | 语义 |
|---|---|---|
| `exitCode` | 数字，或 `{ "not": 数字 }` / `{ "in": [数字...] }` / `{ "min": 数字, "max": 数字 }` | 退出码比较；进程被信号杀死时为 `null`，用 `signal` 判定 |
| `signal` | 字符串或 `null` | 终止信号名，如 `"SIGTERM"` |
| `timedOut` | boolean | 是否因超时被终止 |
| `durationMs` | `{ "min"?: 数字, "max"?: 数字 }` | 墙钟耗时区间 |
| `stdout` | `{ "regex"?, "flags"?, "contains"?, "jsonPath"?, "equals"?, "notEquals"? }` | 在收集到的 stdout 文本上求值 |
| `stderr` | `{ "regex"?, "flags"?, "contains"? }` | 同上 |
| `all` | 谓词数组 | 全部成立 |
| `any` | 谓词数组 | 任一成立 |

细则：

- `regex` 使用 **JS RegExp**，`flags` 取 `i` / `m` / `s` 的组合（默认空）。不支持 `(?i)` 这类内联开关；写了会创建失败并给出 `reason: "format"`。
- 正则只在**已收集的文本**上匹配（最多 `maxOutputBytes`），不做流式匹配；文本本身可能已截断，此时 `truncated: true` 可被谓词读取。
- `jsonPath` 只支持极简路径：`$` 开头，`.` 访问属性，`[n]` 访问数组下标，例如 `$.status`、`$.items[0].state`。解析失败按「路径不存在」处理，不抛错。
- `equals` / `notEquals` 比较 JSON 标量（字符串、数字、布尔、null）；对对象与数组只做严格深比较，不做类型转换。
- 同一谓词对象里出现多个键时按 **AND** 处理（例如 `{ "exitCode": 0, "stdout": { "contains": "ok" } }`）。

## 判定结果

| 情形 | `matchedRule` | `usedFallback` |
|---|---|---|
| 第 N 条规则命中 | `N` | `false` |
| 走 `fallback` | `null` | `true` |
| 无 `fallback`，全部未命中 | `null` | `false`，`actions: []` |

## 模板变量

`actions.<name>.payload`（`plugin` 动作）与 `actions.<name>.prompt`（`session` 动作）支持变量替换：

| 变量 | 值 |
|---|---|
| `{{orchestrationId}}` / `{{orchestrationTitle}}` | 编排标识与标题 |
| `{{runId}}` | 本次 run 标识 |
| `{{trigger}}` | `cron` / `rrule` / `every` / `daily` / `weekly` / `at` / `after` / `manual` |
| `{{scheduledAt}}` / `{{startedAt}}` | ISO 时间 |
| `{{exitCode}}` / `{{signal}}` / `{{timedOut}}` / `{{durationMs}}` | 脚本结果 |
| `{{stdoutTail}}` / `{{stderrTail}}` | 截断后的文本（≤ 2048 字符） |
| `{{matchedRule}}` | 命中下标，或字符串 `fallback` / `none` |
| `{{json:<path>}}` | 从 stdout 解析出的 JSON 中按路径取值，例如 `{{json:$.status}}` |

规则：

- 未知变量替换为空字符串，并在 `run.actions[].warnings` 中记一条，不整体失败。
- 字面量 `{{` 用 `\{{` 转义。
- 替换只做一次（不对替换结果再展开），避免注入式套娃。
- 模板结果必须是合法 JSON（`payload`）或非空字符串（`prompt`），否则该动作失败为 `template_invalid`。

## 示例：失败升级

```json
{
  "rules": [
    { "when": { "timedOut": true }, "actions": ["emit-timeout", "page-oncall"] },
    { "when": { "exitCode": 0, "stdout": { "contains": "DEGRADED" } }, "actions": ["emit-degraded"] },
    { "when": { "exitCode": 0 }, "actions": ["emit-ok"] },
    { "when": { "exitCode": { "in": [2, 3] } }, "actions": ["emit-bad"] },
    { "when": { "signal": "SIGTERM", "durationMs": { "max": 5000 } }, "actions": ["open-triage"] }
  ],
  "fallback": ["emit-bad", "open-triage"]
}
```
