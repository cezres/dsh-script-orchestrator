# 确定 every 与 cron 的调度语义

Type: grilling
Status: resolved
Labels: wayfinder:grilling

## Question

v0.1 收敛为 `every`、`cron` 后，如何精确定义间隔锚点、首次触发、60 秒下限、cron 子集、编辑/暂停/恢复/重启后的 `nextOccurrence`、错过合并和无解转 `ended`？每日/每周面板预设如何生成并回显 cron，手动执行为何不影响自动计划？需要用创建后修改、跨 DST、Host 停机和恢复等具体场景消除实现者仍需猜测的语义，并同步收缩原契约中的 RRULE/daily/weekly 类型。

## Comments

- 2026-11-07：用户接受 Q2，保留五位 Vixie cron 子集、显式 IANA 时区和有界求解，以分钟粒度保证 60 秒下限。
- 2026-11-07：用户接受 Q3，持久化只存 cron；面板按语义识别固定时间的每日/每周规则并回显简单表单，复杂表达式使用高级 cron 编辑器。
- 2026-11-07：Q1 尚未决定；用户要求评估 `every` 同时支持计划时刻驱动与执行完成后延迟两种模式的可行性。
- 2026-11-07：用户接受 Q4，采用 `every.mode: 'fixed-rate' | 'fixed-delay'`，每条编排二选一，默认 `fixed-rate`；不是同一编排同时运行两条触发序列。
- 2026-11-07：用户接受 Q5，`fixed-delay` 以整个自动 run 的 `settledAt` 为锚点，手动 run 不推进自动序列。
- 2026-11-07：用户接受 Q6，`fixed-delay` 自动 run 未结算时允许 `status: active` 与 `nextOccurrence: null` 共存，结算后写入下一计划时刻。
- 2026-11-07：用户接受 Q7，两种模式首次触发均为 `createdAt + everySeconds`，不立即执行。
- 2026-11-07：用户接受 Q8，编排仍为 active 时，自动 run 进入任何终态都以 settledAt 推进 fixed-delay；paused/ended/删除不再推进。
- 2026-11-07：用户接受 Q9，暂停只停止新的自动触发，不取消已有 queued/running run；暂停时 nextOccurrence 为 null，手动执行仍允许。
- 2026-11-07：用户接受 Q10，创建/更新 cron 时五年内无解返回 script_input_invalid（reason=no-occurrence）；运行期意外无解保留 ended 防御终态。
- 2026-11-07：用户接受 Q11，恢复不补暂停期；cron 取 resumedAt 后下一时刻，fixed-rate 从 resumedAt 重新锚定，fixed-delay 根据旧自动 run 是否未结算决定恢复计时或等待结算。
- 2026-11-07：用户接受 Q12，仅调度字段编辑重建计划；新 fixed-rate 从 editedAt 起算，cron 取 editedAt 后下一时刻，新 fixed-delay 在无旧自动 run 时从 editedAt 起算，否则等待旧 run 结算并使用新间隔。
- 2026-11-07：用户接受 Q13，重启保留未来时刻，cron/fixed-rate 只补最近一次，空闲 fixed-delay 至多补一次，未结算 run 先记 interrupted，暂停不补跑。
- 2026-11-07：用户接受 Q14，every 表示绝对经过秒数，不受时区或 DST 影响；cron 保持本地钟表时间和既定 DST 规则。
- 2026-11-07：用户接受 Q15，手动 run 不直接移动自动计划；自动 fixed-delay 因单飞 skip/queue 后仍按终态规则推进，长时间手动执行期间可能产生多次 skipped。
- 2026-11-07：用户接受 Q16，保留 nextOccurrence(trigger, fromMs) 纯函数，fromMs 由调度器按创建/恢复/编辑/scheduledAt/settledAt 场景提供；状态判断由调度器负责。

## Answer

用户在 Q17 确认以下完整方案：

1. **正式类型**：v0.1 只有 `every`、`cron`。`every.mode` 为可选 `'fixed-rate' | 'fixed-delay'`，默认 `fixed-rate`；`everySeconds` 为 ≥60 的整数，使用绝对经过秒数，不受时区或 DST 影响。RRULE、`at`、`after` 延后，`daily`/`weekly` 不作为持久化类型。
2. **fixed-rate**：首次为 `createdAt + everySeconds`，后续为上次 `scheduledAt + everySeconds`；延迟、执行时长、skip/queue 和手动 run 不改变计划相位。
3. **fixed-delay**：首次同样从创建时刻加间隔；后续为上次自动 run 的 `settledAt + everySeconds`。自动 run 未结算时允许 `active + nextOccurrence: null`；任何终态都推进，paused/ended/删除不推进。
4. **手动执行**：不改变自动计划。它造成自动 skip/queue 时，仍按自动 run 的实际终态与 `settledAt` 推进 fixed-delay；长时间手动执行可能留下连续 skipped 记录。
5. **暂停**：只停止新的自动触发，不取消已有 queued/running/dispatching run；`nextOccurrence = null`，手动执行仍允许，暂停期间的 run 结算不直接写入新计划。
6. **恢复**：不补暂停期。cron 取 `resumedAt` 后下一时刻；fixed-rate 从 `resumedAt` 加间隔；fixed-delay 在无未结算旧自动 run 时从 `resumedAt` 加间隔，否则等待旧 run 结算。旧 run 已在暂停期结算的，恢复仍从 `resumedAt` 重新计时。
7. **编辑**：非调度字段不改变下次计划；trigger.kind/everySeconds/mode/expression/timeZone 的修改重建计划，enabled 走暂停恢复。新 fixed-rate 从 `editedAt` 起算，新 cron 取其后继，新 fixed-delay 根据旧自动 run 是否未结算决定从 `editedAt` 起算或等待结算。旧 run 不得覆盖更新后的 fixed-rate/cron 计划。
8. **重启与错过**：未来 `nextOccurrence` 保留；cron/fixed-rate 多次错过只补最近一次，空闲 fixed-delay 至多补一次；未结算 run 先记 interrupted，fixed-delay 从恢复结算时刻加间隔；暂停不补跑，被合并的中间触发不逐条生成 run。
9. **cron**：保留五位 Vixie 子集、显式 IANA 时区和有界求解，分钟粒度保证 60 秒下限。创建/更新时五年无解返回 `script_input_invalid`，新增 `reason = 'no-occurrence'`；运行期意外无解仍转 `ended`。
10. **每日/每周面板预设**：只生成 cron，周日统一为 0；面板按语义识别固定时间的每日/每周表达式并回显简单表单，复杂表达式只显示高级 cron 编辑器。
11. **纯计算接口**：保留 `nextOccurrence(trigger, fromMs)`，`fromMs` 是调度器按创建/恢复/编辑/scheduledAt/settledAt 场景提供的锚点；纯函数不判断调度状态，fixed-delay 执行中的 null 由调度器持有。
12. **版本口径**：这些调整发生在尚未实现、无存量持久记录之前；首个实现的存储域仍从版本 1 起步，不制造无实际数据的迁移版本。

已同步契约：[02-triggers](../../../docs/temp/02-triggers.md)、[01-domain-model](../../../docs/temp/01-domain-model.md)、[03-execution](../../../docs/temp/03-execution.md)、[04-judge](../../../docs/temp/04-judge.md)、[06-events-service](../../../docs/temp/06-events-service.md)、[07-tools](../../../docs/temp/07-tools.md)、[09-states-errors](../../../docs/temp/09-states-errors.md)、[10-decisions](../../../docs/temp/10-decisions.md) 与 [README](../../../docs/temp/README.md)。同时更新 [设计 Web 管理面板交互原型](12-web-panel-prototype.md)，纳入双模式与等待结算状态。
