# 02 · 触发规格

## 七种触发

`trigger.kind` 是判别式，只有对应的字段被接受；出现多余字段视为无效输入。

| kind | 字段 | 时区 | MVP | 说明 |
|---|---|---|---|---|
| `every` | `everySeconds` | — | 是 | 间隔触发，≥ 60 秒 |
| `daily` | `time`, `timeZone` | 必填 IANA | 是 | 每天 HH:mm |
| `weekly` | `time`, `timeZone`, `weekdays` | 必填 IANA | 是 | `weekdays` 为 1–7（周一=1），非空、去重、升序 |
| `cron` | `expression`, `timeZone` | 必填 IANA | 是 | 五位 Vixie 表达式 |
| `rrule` | `rrule` | 写在 `DTSTART` 里 | 是 | 一行 DTSTART + 一行 RRULE |
| `at` | `at` | 必须带 `Z` | v1 | 一次性绝对时刻 |
| `after` | `afterSeconds` | — | v1 | 一次性延迟，≥ 1 秒 |

硬性下限：任何触发产生的相邻两次计划时刻之差 **不得小于 60 秒**；更密的表达式在创建时被拒绝，不做静默节流。

## cron 子集

五位：`minute hour day-of-month month day-of-week`。

- 支持 `*`、`a`、`a-b`、`a-b/step`、`a,b,c`；分钟与小时支持 `/step`（如 `*/15`）。
- 全部为数字，不接受 `JAN`、`MON` 这类名称。
- 星期 `0` 与 `7` 都表示周日；`day-of-month` 与 `day-of-week` 同时受限时按 Vixie 语义取「或」。
- 时区必须显式给出，不接受「跟随宿主」的隐式时区。

## RRULE 子集

格式固定为两行，顺序不可换：

```
DTSTART;TZID=Asia/Shanghai:20261107T030000
RRULE:FREQ=DAILY;INTERVAL=1
```

| 部件 | 支持 | 约束 |
|---|---|---|
| `DTSTART` | `TZID=<IANA>` 本地时间，或 `Z` 结尾的 UTC | 必须是一个存在的本地时刻 |
| `FREQ` | `DAILY` `WEEKLY` `MONTHLY` `YEARLY` | 不支持 `SECONDLY` `MINUTELY` `HOURLY` |
| `INTERVAL` | 正整数 | 默认 1 |
| `BYDAY` | `MO,TU,WE,TH,FR,SA,SU`，可带序数（`-1SU`、`2MO`） | 序数仅用于 `MONTHLY` / `YEARLY` |
| `BYMONTHDAY` | `1..31`，可取负（`-1` 表示月末） | 仅 `MONTHLY` / `YEARLY` |
| `BYMONTH` | `1..12` | — |
| `BYHOUR` / `BYMINUTE` | 0–23 / 0–59 | 用于把一天展开成多个时刻 |
| `BYSETPOS` | 最多 31 个值 | 在单次 FREQ 周期内选位 |
| `COUNT` | 1–1000 | 与 `UNTIL` 互斥 |
| `UNTIL` | UTC 时刻，`Z` 结尾 | 与 `COUNT` 互斥 |

不支持：`BYSECOND`、`BYWEEKNO`、`BYYEARDAY`、`WKST` 的自定义值。表达式超出子集时**拒绝创建**并给出具体部件名，不做降级解释。

## 时区与夏令时

- 一律使用 IANA 时区名（`Asia/Shanghai`、`Europe/Berlin`），拒绝偏移量写法（`UTC+8` 需写成 `Etc/GMT-8`，且仅作兼容用途）。
- 本地时间不存在（春季跳变）：该次跳过，顺延到下一个有效时刻。
- 本地时间重复（秋季回拨）：只发生一次，取较早的瞬时。
- `daily` / `weekly` 以「本地钟表时间」为准：跨 DST 时墙上时间不变，UTC 偏移随之改变。

## 下次触发计算

对外只暴露一个纯函数式契约：

```
nextOccurrence(trigger, fromMs: number) → number | null
```

- 返回严格大于 `fromMs` 的下一个计划时刻；`at` 已过期、`COUNT` 用尽、无更多匹配时返回 `null`（编排转 `ended`）。
- 计算必须是有界的：任何表达式在 5 年窗口内无解即视为无解，不允许无限循环。
- 调度器全插件只维护 **一个 timer**：取所有 `active` 编排中最早的 `nextOccurrence`，到点后重新计算。

## 错过的触发

- Host 停机期间错过的多次触发**合并为一次**：重启后只补最近一次错过的时刻，然后直接推进到下一个未来时刻。
- 单次触发被延迟执行时，`run.scheduledAt` 记录原计划时刻，`run.startedAt` 记录实际时刻，两者差值可观测。
- 不做「补跑全部错过」开关：重复执行带副作用的脚本比漏跑更危险。

## 触发与手动执行

- 工具调用 `script_run` 属于手动触发：`trigger = 'manual'`，**不改变**下次自动触发时刻，也不消耗 `COUNT`。
- 暂停（`paused`）期间不触发；`script_run` 仍可手动执行，执行后状态不变。

## 校验错误

触发字段不合法时返回 `script_input_invalid`，`details` 至少包含：

| 键 | 含义 |
|---|---|
| `field` | 出错路径，如 `trigger.expression` |
| `reason` | `missing` / `unexpected` / `range` / `format` / `too-frequent` / `unsupported-part` |
| `part` | 仅 rrule / cron：出问题的部件名，如 `BYSECOND` |
