# 02 · 触发规格

## 两种触发

v0.1 的 `trigger.kind` 只接受 `every`、`cron`。它是判别式，只有对应字段被接受；出现多余字段或其他 kind 均视为无效输入。

| kind | 字段 | 时区 | 说明 |
|---|---|---|---|
| `every` | `everySeconds`、`mode?` | 不使用 | 按绝对经过秒数触发；`everySeconds` 为整数且 ≥ 60 |
| `cron` | `expression`、`timeZone` | 必填 IANA | 五位 Vixie 表达式 |

`every.mode` 取 `'fixed-rate' | 'fixed-delay'`，省略时默认 `'fixed-rate'`。每条编排只选择一种模式，不同时运行两条自动序列。

`daily`、`weekly` 不是正式触发类型，只作为 Web 面板预设生成 cron。RRULE、`at`、`after` 均延后到后续版本，v0.1 不接受这些 kind。

硬性下限：任何重复触发产生的相邻两次计划时刻之差不得小于 60 秒；更密的输入在创建或更新时被拒绝，不做静默节流。

## every：固定计划相位 `fixed-rate`

- 首次计划时刻为 `createdAt + everySeconds`，不立即执行。
- 后续计划时刻为 `上一次 scheduledAt + everySeconds`。
- 延迟启动、脚本执行时长、单飞 `skip`/`queue` 与手动 run 均不改变后续计划相位。

例如 12:00 创建 `everySeconds: 300`，计划为 12:05、12:10、12:15。12:05 的 run 即使到 12:12 才结算，下一次计划仍为 12:15。

## every：固定完成间隔 `fixed-delay`

- 首次计划时刻为 `createdAt + everySeconds`，不立即执行。
- 后续计划时刻为 `上一次自动 run 的 settledAt + everySeconds`。
- 自动 run 处于 `queued`、`running`、`judging`、`dispatching` 时，`nextOccurrence = null`；结算后写入下一计划时刻。
- 编排仍为 `active` 时，自动 run 进入任何终态都推进序列：`succeeded`、`partial`、`failed`、`skipped`、`canceled`、`interrupted`。
- 编排为 `paused`、`ended` 或已删除时，不再推进。
- 手动 run 的 `settledAt` 不推进自动序列。

`active` 与 `nextOccurrence: null` 可以共存，表示等待本次自动 run 结算；`paused` 表示显式暂停，`ended` 表示没有后续自动计划。

手动 run 不直接移动自动计划，但可能与自动 run 竞争单飞额度：`overlap: 'skip'` 时，自动 run 记为 `skipped` 并以其 `settledAt` 推进；`overlap: 'queue'` 时，自动 run 等实际结算后再推进。因此长时间手动执行期间，`skip` 模式可能留下多次自动 `skipped` 记录。

## cron 子集

五位：`minute hour day-of-month month day-of-week`。

- 支持 `*`、`a`、`a-b`、`a-b/step`、`a,b,c`；分钟与小时支持 `/step`（如 `*/15`）。
- 全部为数字，不接受 `JAN`、`MON` 等名称，不支持秒字段或 `@daily` 等宏。
- 星期 `0` 与 `7` 都表示周日；`day-of-month` 与 `day-of-week` 同时受限时按 Vixie 语义取「或」。
- 时区必须显式给出，不接受「跟随宿主」的隐式时区。
- 合法五位 cron 以分钟为最小粒度，天然满足 60 秒下限，不做额外抽样节流。

创建或更新 cron 时，从校验参考时刻起未来 **5 年**内没有任何有效计划时刻，则拒绝该配置，不写入一个立即 `ended` 的编排。错误为 `script_input_invalid`，`details.field = 'trigger.expression'`、`details.reason = 'no-occurrence'`。已合法保存的配置若在运行期意外求不到下一时刻，仍转为 `ended` 作为防御性终态。

## 时区与夏令时

- `every` 始终表示绝对经过的秒数，不使用本地时区，也不受 DST 影响。
- cron 使用 IANA 时区名（`Asia/Shanghai`、`Europe/Berlin`），拒绝偏移量写法（`UTC+8` 需写成 `Etc/GMT-8`，且仅作兼容用途）。
- cron 的本地时间不存在（春季跳变）：该次跳过，顺延到下一个有效时刻。
- cron 的本地时间重复（秋季回拨）：只发生一次，取较早的瞬时。
- 面板每日/每周预设与其生成的 cron 使用同一个 `timeZone`。

## 下次触发计算

对外只暴露一个纯函数式契约：

```ts
nextOccurrence(trigger, fromMs: number) → number | null
```

返回严格大于 `fromMs` 的下一个计划时刻。`fromMs` 是本次计算的锚点，不总是当前时间，由调度器按场景提供：

- 创建：`createdAt`；
- 恢复：`resumedAt`；
- 调度字段编辑：`editedAt`；
- `fixed-rate` 后续推进：上一次 `scheduledAt`；
- `fixed-delay` 后续推进：上一次自动 run 的 `settledAt`；
- cron：本次需要计算其后继时刻的参考时刻。

纯函数只计算后继时刻，不判断暂停、执行中、编辑代际、重启或手动 run；这些状态由调度器负责。`fixed-delay` 执行中的 `null` 也由调度器持有。

计算必须有界：任何 cron 在 5 年窗口内无解即视为无解，不允许无限循环。调度器全插件只维护 **一个 timer**，取所有 `active` 且 `nextOccurrence` 非空的编排中最早者，到点后重新计算。

## 创建、编辑、暂停与恢复

### 创建

- 两种 `every` 模式的首次计划均为 `createdAt + everySeconds`。
- cron 的首次计划为严格晚于 `createdAt` 的下一匹配时刻。
- 创建时 `enabled: false` 的编排为 `paused`，`nextOccurrence = null`。

### 编辑

修改 `title`、`script`、`judge`、`actions`、`overlap` 等非调度字段，不改变已有 `nextOccurrence`。修改 `enabled` 走暂停/恢复规则。

修改 `trigger.kind`、`everySeconds`、`mode`、cron `expression` 或 `timeZone` 时，按新配置重建计划：

| 新配置 | 下一次自动计划 |
|---|---|
| `fixed-rate` | `editedAt + everySeconds` |
| cron | 严格晚于 `editedAt` 的下一匹配时刻 |
| `fixed-delay`，无未结算自动 run | `editedAt + everySeconds` |
| `fixed-delay`，旧自动 run 未结算 | 保持 `null`，旧 run 结算后使用其 `settledAt + 新 everySeconds` |

编辑不取消已有 run。调度器必须用编辑代际或等价机制，防止旧 run 的结算覆盖更新后的 fixed-rate/cron 计划。

### 暂停

- 暂停只停止新的自动触发，不取消已经产生的 queued/running/dispatching run；它们继续结算。
- `pause` 仅从 `active` 生效；对 `paused`/`ended` 是幂等 no-op（返回当前视图，不改任何计时）。
- 暂停期间 `nextOccurrence = null`，`script_run` 仍可手动执行。
- 暂停期间的自动 run 结算不直接在暂停状态下写入新的自动计划。

### 恢复

恢复不补跑暂停期间的触发：

| 触发配置 | 恢复后的下一次自动计划 |
|---|---|
| cron | 严格晚于 `resumedAt` 的下一匹配时刻 |
| `fixed-rate` | `resumedAt + everySeconds` |
| `fixed-delay`，恢复时无未结算旧自动 run | `resumedAt + everySeconds` |
| `fixed-delay`，恢复时旧自动 run 未结算 | 保持 `null`，旧 run 结算后使用其 `settledAt + everySeconds` |

旧 run 已在暂停期间结算的，恢复时仍从 `resumedAt` 重新计时，不根据暂停期间的 `settledAt` 补出立即执行。恢复时若运行期意外无解，编排转为 `ended`。

`resume` 仅从 `paused` 生效；对 `active`/`ended` 是幂等 no-op（返回当前视图、不重锚），重复 `resume` 不会重锚 fixed-delay。

## 重启与错过的触发

- 已有未来 `nextOccurrence` 的编排保留该时刻，不因重启重新锚定。
- cron / `fixed-rate` 在停机期间错过多次时合并为一次：只按最近一次错过的计划时刻创建一个 run，然后推进到未来计划。
- 空闲的 `fixed-delay` 在上次结算后只保存一个下一时刻，停机时至多错过一次；恢复后补这一次，再等其结算产生后续计划。
- 停机时未结算的 run 先标为 `interrupted`。`fixed-delay` 从这次恢复结算的 `settledAt` 再加间隔，不额外立即补跑。
- 暂停的编排重启后不补跑，仍按暂停规则处理。
- 被合并掉的中间触发不逐条生成 run 记录。
- 单次触发被延迟执行时，`run.scheduledAt` 记录原计划时刻，`run.startedAt` 记录实际时刻，两者差值可观测。
- 不做「补跑全部错过」开关：重复执行带副作用的脚本比漏跑更危险。

## 触发与手动执行

工具调用 `script_run` 属于手动触发：`trigger = 'manual'`，不改变下次自动触发时刻。`fixed-delay` 只由自动 run 的终态推进。暂停期间仍可手动执行，执行后编排状态不变。

## 每日/每周面板预设

面板简单模式只生成 cron，不增加持久化触发类型或额外预设标记：

- 每日 03:00 → `0 3 * * *`；
- 每周一、三、五 09:00 → `0 9 * * 1,3,5`；
- 周日统一生成为 `0`。

查看时，若表达式在语义上只是固定一个本地时间的每日或若干星期规则，可回显简单表单。例如 `0 9 * * 1-5` 与 `0 9 * * 1,3,5` 均可识别。包含多个时间、日期/月份限制、step 或其他复杂规则时，只显示高级 cron 编辑器。简单与高级模式使用同一个 `timeZone`。

## 校验错误

触发字段不合法时返回 `script_input_invalid`，`details` 至少包含：

| 键 | 含义 |
|---|---|
| `field` | 出错路径，如 `trigger.expression` |
| `reason` | `missing` / `unexpected` / `range` / `format` / `too-frequent` / `unsupported-part` / `no-occurrence` |
| `part` | 仅 cron：出问题的部件名，如秒字段或不支持的宏 |
