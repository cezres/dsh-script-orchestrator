# 确定会话创建投递与回收契约

Type: grilling
Status: resolved
Labels: wayfinder:grilling
Blocked by: 01, 04, 20

## Context

- [核实会话创建与首条消息投递](01-research-session-actions.md)：id、UserMessage、source、preset/model、dispose 和两条 root 创建路径的事实来源。
- [核实工作区插件、工具与配置机制](04-research-plugin-runtime.md)：createUserMessage 等依赖 import 的可行边界。
- [重新界定 session 动作模式](20-session-modes.md)：确定本议题需要支持的会话模式及 parent 前提。

## Question

在已选 session 模式下，如何确定创建与投递契约？需要选择 Session Controller 或直接 agents.create、id 铸造与实际返回值、完整 UserMessage 的构造/依赖路径、source.kind 使用 user+banner 或自定义插件名、followup/flush 的 delivery_failed 边界，以及 preset/model 默认与显式覆盖。还需明确 title/Workspace attach 的失败处理、创建后投递失败的会话保留、root 在插件卸载时的生命周期、idleDisposeSeconds 的插件计时与竞态、dispose 后日志/Workspace 保留，以及支持 child 时的 parent、depth、composition 和冷恢复要求。

## Comments

### Round 1（2026-11-08，七题均按推荐拍板）

前提（随 20 号票/研究直接沿用）：id 直接铸 `session-${randomUUID()}`（#2 已结案）；persistent 优先 `sessionController.create()`、ephemeral 必须 `agents.create()` 自持 handle；child 的 parent/depth/composition/冷恢复不适用（非目标）；插件卸载 owner-fiber teardown、dispose 不删日志与 Workspace 关系。

1. **source.kind = `'user'` + banner**：宿主 `lastPromptAt`/api-session/activity 只认 `kind === 'user'`，自定义 kind 会使会话在列表显示为无活动且需扩展 `MessageSourceMap`；banner 已声明来源与不可信边界。待验证 #3 以此结案（退路转正）。
2. **投递成功语义**：成功 = 创建 + `followup()` 接受 + `await ctx.sessions.flush()` durable 确认；`delivery_failed` = followup 抛错或 flush 拒绝，保留会话不回滚；投递失败的 ephemeral 不启动回收计时（失败现场不得秒回收）。
3. **title 与 attach**：缺省生成 `${编排标题} · ${runId 尾 4 位}`；rename 失败仅记 `warnings` 不失败动作（与 `schedule` 先例一致）；v0.1 不做独立 Workspace attach（`cwd` 进创建参数即工作目录语义）。
4. **preset/model**：显式优先；缺省统一「Host 默认」（persistent 经 sessionController 由 Host compose，ephemeral 经 `ctx.agentDefaultModel.currentSelection()` + preset resolve/mount，契约只承诺结果一致）；执行期 preset 解析失败 → `preset_unknown`，静态校验仍只查格式。
5. **回收计时与竞态**：插件自持计时（`whenIdle()` 收敛 → 起 `idleDisposeSeconds` 计时，新活动重置）；到期 dispose 与新消息的微小竞态如实声明（durable inbox 消息不丢、重开后处理）；插件重启不重新认领（未回收者已随卸载 teardown）。
6. **每执行新建会话**：追加已有会话、跨 run 复用均为非目标。
7. **UserMessage 构造**：结构完整 UserMessage（content blocks + source），用宿主 agent 包 `createUserMessage`；待验证 #6 import 不可行时内联等价构造，契约语义不变。

### Round 2（2026-11-08，两题均按推荐拍板）

8. **`run.actions[]` 增 `sessionId?`**：仅 session 动作有，成功与 `delivery_failed` 均记（后者即「保留 id 供人工接管」的落点）。
9. **雾区实验毕业**：21 落盘后创建票 23 [最小宿主集成实验]（prototype），map 雾区清空、由票 23 承接。

## Answer

**投递契约**（详见 05-actions.md v0.1m session 节）：

- 首条消息 = 结构完整 UserMessage（`createUserMessage` 构造，退路内联等价），`source: { kind: 'user' }` + banner 文本区分来源（#3 结案：自定义 kind 损失 lastPromptAt/api-session/activity 可观测性）。
- 成功语义 = 创建 + `followup` 接受 + `flush()` durable 确认；`delivery_failed`（followup 抛错 / flush 拒绝）保留会话、记 `sessionId`、失败 ephemeral 不启动回收。
- `title` 缺省 `${编排标题} · ${runId 尾 4 位}`，rename 失败仅 warnings；不做 Workspace attach；每执行新建会话（追加/复用非目标）。
- `preset`/`model` 显式优先、缺省 Host 默认（两路径实现不同结果一致）；preset 解析失败 → `preset_unknown`。
- 回收竞态与插件重启不认领如实声明；`run.actions[]` 增 `sessionId?`。
- child 相关问题（parent/depth/composition/冷恢复）不适用——child 已随 20 号票移非目标。

落盘：`05-actions.md`（title 行、投递段重写、如实声明两条、落点冲突扩充）、`01-domain-model.md`（actions[] 加 sessionId?）、`10-decisions.md`（会话投递分叉行 + 待验证 #3 结案）、`README.md` v0.1m、`map.md` 加行 + 雾区清空、新建 [票 23 最小宿主集成实验](23-session-integration-prototype.md)（承接 #6 实证与全链路验证）。
