# 最小宿主集成实验（会话创建到回收闭环）

Type: prototype
Status: resolved
Labels: wayfinder:prototype
Branch: proto/session-integration
Findings: .scratch/script-orchestrator/prototype/session-integration/FINDINGS.md（worktree D:\projects\dsh-script-orchestrator-proto-session-integration）
Commit: a273a10
Blocked by: 01, 04, 20, 21

## Context

- [核实会话创建与首条消息投递](01-research-session-actions.md)：id、UserMessage、source、preset/model、dispose 与两条 root 创建路径。
- [核实工作区插件、工具与配置机制](04-research-plugin-runtime.md)：工作区插件 import 宿主包的可行边界。
- [重新界定 session 动作模式](20-session-modes.md)：persistent/ephemeral 两模式与创建路径偏好。
- [确定会话创建投递与回收契约](21-session-delivery-lifecycle.md)：投递成功语义、source.kind、回收竞态与重启声明。

## Question

在隔离沙箱实例中实证 session 动作的完整闭环，消除「契约已写、宿主行为未验证」的残余：

1. **消息构造依赖**（待验证 #6）：工作区插件能否 import 宿主 agent 包的 `createUserMessage`；不可行时内联 UserMessage 构造是否被 `followup` 接受。
2. **两条创建路径**：persistent 的 `sessionController.create()`（Host 代 compose preset/model，返回值含实际 sessionId）与 ephemeral 的 `agents.create()` 自持 handle（preset resolve/mount + `ctx.agentDefaultModel.currentSelection()`）。
3. **缺省链**：不设 preset/model 时首 step 不抛 "has no provider/model"。
4. **source 可观察差异**：`kind: 'user'` 投递后 lastPromptAt / activity 正常更新（会话列表显示有活动）。
5. **flush 持久化**：followup + `await ctx.sessions.flush()` 后重启实例，消息仍在 durable inbox。
6. **idle 回收与卸载**：`whenIdle()` + `idleDisposeSeconds` 插件计时生效；到期 dispose 的竞态窗口实测；插件卸载后 live Agent teardown、冷会话可重开续聊；投递失败会话保留不回收。

产出 FINDINGS.md 与探针产物；按证据修订 05-actions / 10-decisions 的残余假设（若有出入）。

## Comments

- 2026-11-09：用户批准按方案执行（死端点 LLM、零凭据、两次启动）。
- 2026-11-09：Phase 1 首跑发现 `handle.whenIdle is not a function`——API 自省修正（`whenIdle` 挂 agent）后重跑全绿；Phase 2 重启核对完成；宿主已停、store 已清。

## Answer

原型结论（完整记录见 [FINDINGS.md](../../../dsh-script-orchestrator-proto-session-integration/.scratch/script-orchestrator/prototype/session-integration/FINDINGS.md)，分支 `proto/session-integration`，commit `a273a10`）：

1. **E1（待验证 #6 结案）**：`import '@deepseek-ai/dsh-llm'` 不可行（未声明依赖，`Cannot find package`）；**内联构造 `{id, role:'user', content, source}` 被 followup + flush 接受**——21 号票的退路转正为定案，契约已改内联。
2. **E2 persistent 路径 ✅**：`sessionController.create`（requestedId == actualId）→ `resolveAgent` → followup 接受 → `flush() === true`。
3. **E3 ephemeral 路径 ✅**：直铸 id + `agentDefaultModel.currentSelection()`（死端点模型解析成功）+ preset resolve（默认 `'standard'`）+ mount + `agents.create()` 自持 handle；followup + flush ✅；`whenIdle`（**挂 agent 不挂 handle**——API 修正）20 秒内收敛；`dispose()` 完成。
4. **E4 缺省链 ✅**：无显式 preset/model，`currentSelection()` 返回有效选择、preset 解析默认、创建与投递链无 `has no provider/model`。
5. **E5 delivery_failed 路径 ✅**：对已 dispose 的 agent 再 followup 抛 `cannot append outside a SessionStore`。
6. **E6 重启持久化 ⚠️ 半通过 + 关键发现**：两会话（两模式）重启后 `resolveAgent` 重开成功（header 持久化、冷会话可复活）；但会话日志仅 312 字节 header——**`[PROBE]` 消息从未 append**。
7. **契约修订（v0.1p）**：`flush() === true` 收窄为「投递管线接受」——不证明消息已写入会话日志（user 消息要等 step 内路由就绪后 append，死路由场景永不 append、日志仅 header，如实声明）；turn 失败不回滚动作成功。`whenIdle` 位置与内联构造已同步 05-actions / 10-decisions。
8. **边界**：lastPromptAt/activity 的 UI 可观测性以 01 号研究源码结论为准；卸载 teardown 以杀宿主近似；未验证正常 LLM 回合的 append 时序（不影响收窄结论——收窄只依赖「flush 不证明 append」这一已实证事实）。

对地图的影响：本票是最后一个原型票；全部待验证项中仅剩 #4（声明性，研究已回答「不会进 Event inspect」）。
