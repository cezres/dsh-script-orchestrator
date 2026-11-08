# 重新界定 session 动作模式

Type: grilling
Status: resolved
Labels: wayfinder:grilling
Blocked by: 01

## Context

- [核实会话创建与首条消息投递](01-research-session-actions.md)：真正 subagent 的 parent/lineage/composition 要求，以及 orphan 的实际列表与 API 行为。

## Question

定时或手动脚本产生 `session` 动作时，v0.1 要提供什么会话模式？需要回答没有 initiating Agent 时 child 的 parent 是谁：是首版只保留 root；把一次性短生命周期 root 作为新的独立模式；还是仅在调用方能提供 exact live parent 时支持真正 child，并为纯定时触发降级或拒绝。需要重新界定 root/child 命名、用户可接管性、列表归属和默认模式，不能再用两个 metadata 字段伪造 child。该决策先于具体创建、投递和回收接口。

## Comments

### Round 1（2026-11-08，六题均按推荐拍板）

1. **模式集合**：v0.1 砍掉 child，两模式都是宿主语义 root——`persistent`（默认，插件不主动回收）+ `ephemeral`（一次性，承接原 child 的「自动回收」卖点）；真正 child 移非目标。备选「child 仅手动触发、无法解析 parent 时拒绝/降级」被否：多一条不稳定路径。
2. **命名**：`mode: 'persistent' | 'ephemeral'` 取代 `'root' | 'child'`。两模式宿主里都是 root，区别只是插件对生命周期态度；未实现无存量，改名零成本。
3. **ephemeral 生命周期**：投递首条 → `whenIdle()` 收敛（含用户接管期间的对话——有人活动就不算 idle，不检测接管）→ `idleDisposeSeconds`（默认 0，可配延迟）→ `dispose()`。dispose 是 teardown 不是删除：持久化日志与 Workspace 关系保留，会话变冷、历史可读、可重新打开续聊。`idleDisposeSeconds` 改 ephemeral 专用，persistent 拒绝该字段。
4. **列表与接管**：两模式都正常出现在主列表（不承诺「不占列表」）；persistent 随时可接管；ephemeral 回收前可接管、回收后冷会话可打开。插件停用/卸载一律 teardown（宿主 owner-fiber 行为），「常驻」改写为「插件运行期间不主动回收」。
5. **child 复活条件**：仅当触发链路能供 exact live parent 时经 `ctx.subagents.startActivation()` 实现；v0.1 定时无 actor、手动 actor 距 dispatching 已冷却，不供给；自持 child 冷恢复需 descriptor/composition/catalog，成本不成比例。
6. **模式 × 创建路径**（只记属性，细节归 21 号票）：persistent 优先 `sessionController.create()`（Host 代 compose 默认 preset/model）；ephemeral 必须 `agents.create()` 自持 handle（要 dispose，controller 返回 bare Agent 不适合）。

### Round 2（2026-11-08，三题均按推荐拍板）

7. **待验证 #2 结案**：直接铸 `session-${randomUUID()}` 只走 Agent 通道（01 号研究已证 `ctx.sessions.create()` 退路不可实现），无需新实验；#3 source.kind 留 21 号票。
8. **地图雾区**：删「若保留真正 child，还需 parent 列表与冷恢复验证」；最小宿主集成实验在 21 号票定完投递/回收后毕业为正式票。
9. **生命周期解耦**：`delete` 编排不触碰已创建会话（无论模式），ephemeral 照常 idle 回收（可能正被用户使用，不得误杀）；插件卸载 teardown 两模式一致（题 4 已收）。

## Answer

**v0.1 会话模式 = 两种宿主语义 root**：

- `mode: 'persistent' | 'ephemeral'`，默认 `'persistent'`，取代原 `'root' | 'child'`。两模式 `owner === undefined`，区别只在插件对生命周期的态度；伪造 child（`origin`/`delegationDepth`）废弃。
- **persistent**：插件运行期间不主动回收；优先 `sessionController.create()` 创建（Host 代 compose 默认 preset/model，无需自持 handle）。「常驻」如实声明为「插件运行期间不主动回收」——停用/卸载走宿主 owner-fiber teardown，冷会话历史保留。
- **ephemeral**：一次性任务。必须 `agents.create()` 自持 handle。生命周期＝投递首条 → `whenIdle()` 收敛（含用户接管期间的对话）→ `idleDisposeSeconds`（默认 0）→ `dispose()`；teardown 不删持久化日志与 Workspace 关系，会话变冷、历史可读、可重开续聊。
- **列表与接管**：两模式都正常出现在主列表；persistent 随时可接管，ephemeral 回收前可接管、回收后冷会话可打开。
- **非目标**：真正 child。复活条件＝触发链路能供 exact live parent 时经 `ctx.subagents.startActivation()`；v0.1 定时无 actor、手动 actor 已冷却，不满足。
- **解耦**：`delete` 编排不触碰已创建会话；ephemeral 照常空闲回收。
- **顺手结案**：10-decisions 待验证 #2——id 直接铸 `session-${randomUUID()}` 只走 Agent 创建通道，`ctx.sessions.create()` 退路不可实现。

落盘：`05-actions.md` session 节重写（mode 枚举、两种模式表、如实声明、idleDisposeSeconds ephemeral 专用、followup 措辞）、`01-domain-model.md` 示例改 `'persistent'`、`10-decisions.md` 会话落点行修订 + 待验证 #2 结案、`README.md` v0.1l、`map.md` 加行 + 雾区措辞更新。投递/回收接口细节（source.kind、banner、delivery_failed 边界、preset/model 缺省链）全部归 [session 投递与生命周期](21-session-delivery-lifecycle.md)。
