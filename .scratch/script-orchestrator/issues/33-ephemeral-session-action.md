# 33: 通过 ephemeral session 自动整理并回收

**What to build:** 用户可选择 ephemeral session 动作完成一次性整理，系统在会话真正空闲后按配置回收 live Agent，同时保留可重新打开的冷会话历史。

**Blocked by:** 32 — 通过 persistent session 接管失败排查

**Status:** resolved

- [x] ephemeral 经直接铸造的 session id、当前模型选择、preset 解析/mount 和 `agents.create()` 创建自持 handle，投递路径与 persistent 共用。
- [x] `whenIdle()` 挂在 agent 上，收敛后才等待 idleDisposeSeconds 并 dispose；persistent 拒绝该字段，ephemeral 的零延迟与延迟回收均有测试。
- [x] 用户接管和对话活动会推迟空闲，回收只 teardown live Agent，不删除持久化日志或 Workspace 关系，冷会话可重新打开。
- [x] 投递失败的 ephemeral 不启动回收计时并保留 `sessionId` 现场；插件重启不重新认领历史 ephemeral，删除编排不提前杀死会话。
- [x] 插件停用/卸载由 owner-fiber teardown 清理 live Agent，异步回收任务全部受生命周期跟踪，回收竞态只承诺契约规定的 durable inbox 边界。
- [x] 隔离宿主测试覆盖创建、投递、空闲收敛、延迟 dispose、用户活动、失败不回收、卸载 teardown 和冷会话重开。

## Comments

### 做了什么

按票验收项 TDD（红-绿循环，先写失败测试）实施，交付「ephemeral 创建 + 投递 + 回收生命周期 + 卸载收口」端到端（票 32 的 persistent 投递路径直接复用）：

1. **创建与投递**（`lib/session-action.js` 扩展，契约 05 两模式表 + 决策 20/21 + 研究 session-actions §4 逐行路径）：
   - 首条消息投递抽 `deliverFirstMessage`（标题 rename 失败仅 warnings → followup 内联 UserMessage → flush），persistent/ephemeral **共用同一实现**（契约 05「两种模式共用同一段渲染与投递逻辑，只差生命周期管理」）。
   - `deliverEphemeralSession`：① 与 persistent 同一 `resolveSessionCwd`（allowedRoots 边界）；② preset 三步（`ctx.get('agentPresets').resolve(id ?? 缺省)`；服务缺失且无显式 preset → 裸创建；显式 preset 而服务缺失/解析 `agent-preset/not-found` → `preset_unknown`；mount 只能进 `agents.create` 的 setup，`meta.agentPreset` 只是记录）；③ `agentOptions = 显式 model ?? ctx.agentDefaultModel.currentSelection()`（显式优先）；④ `agents.create({ sessionId: 'session-'+uuid, agentOptions, meta: {cwd, agentPreset?}, setup })` 自持 `{agent, dispose}` handle（票 23 E3 实证路径）；⑤ 投递失败时 **handle 附在 `SessionActionError` 上交回调用方**（现场保留、不 dispose）。
2. **回收生命周期**（`lib/ephemeral-lifecycle.js` 新增）：`createEphemeralRegistry`
   - `adopt(handle, agent, sessionId, idleDisposeSeconds=0)`：`agent.whenIdle()` 收敛（宿主 do-while 语义天然含用户接管期间的对话）→ `idleDisposeSeconds > 0` 时延迟窗口与「新活动」竞速——新活动观察面 = `agent.ctx` 上的 `agent/status` 事件（宿主 setPhase 在 idle↔running 跃迁发布；决策 21 #5「新活动重置」），起臂前回读 `agent.status` 兜底「事件已发过」窗口；活动 → 回到 whenIdle 重新收敛；到点 → `handle.dispose()`（teardown 不是删除：日志与 Workspace 关系保留、冷会话可重开）。零延迟（缺省 0）= 收敛即 dispose（契约序列字面）。
   - **病态防自旋**：`whenIdle` 立即返回而 `status` 恒非 idle 的矛盾 agent 会让回读分支纯微任务 continue 饿死事件循环（fake timers 实测复现过）——回读分支经 1ms macrotask 让步再回 whenIdle，假计时器窗口有界。
   - `retain(handle, sessionId)`：投递失败现场——只登记卸载清理（stopped 预置 true），**不启动任何回收计时**（契约 05「投递失败的 ephemeral 不启动回收计时」）。
   - `disposeAll()`：插件卸载序列收口——停新回收、清在途计时、对全部登记条目确定性 dispose（幂等：disposing 守卫恰一次；dispose 抛错吞掉记 warn）；登记表内存态 = **插件重启不重新认领**历史 ephemeral（未回收者已随卸载 owner-fiber teardown，冷会话保留）。
3. **派发器接入**（`lib/actions.js`）：ephemeral 分支替换占位——成功 `adopt`（含 `idleDisposeSeconds ?? 0` 透传）、失败 `retain`；`ephemeralRegistry` 缺失防御 `internal_error`（生命周期不可跟踪则语义不成立，不伪造成功）；落点冲突映射与 persistent 一致（cwd_not_allowed/preset_unknown/delivery_failed/internal_error，成功与失败均记录 sessionId）。
4. **接线**（`lib/runner.js` + `lib/index.js`）：inject 增 `agents`/`agentDefaultModel`；sessionHost 扩 ephemeral 面（agents/agentDefaultModel/getAgentPresets 惰性取）；registry 单例注入 runner → dispatchActions；**卸载序**：调度器停 → 工具/桥摘 → `runner.shutdown()`（在途 run 收口）→ `ephemeralRegistry.disposeAll()`（确定性 teardown，宿主 owner-fiber 兜底之下显式收口）→ 队列排干 → domain.close。
5. **存储/面板/校验零增量**：runActionSchema.sessionId 已有；面板 sessionId 展示票 32 已交付（ephemeral 同形）；`idleDisposeSeconds` 仅 ephemeral + persistent 拒绝的静态校验票 25 已铺（负向矩阵既有，本票补正向归一化断言）。

### 包 / 目录结构（票 33 增量）

```
pkg/
  lib/  ephemeral-lifecycle.js（新增）  session-action.js（deliverEphemeralSession + deliverFirstMessage 抽取）
        actions.js  runner.js  index.js（扩展）
  test/ ephemeral-lifecycle.test.js（新增 7）  session-action.test.js（+7）  actions.test.js（+4 净增）
        index.test.js（+1）  service.test.js（+1）
scripts/verify-ticket33.ps1（liveness/接管/冷会话重开探针 + 5 编排 + 死端点 LLM）
```

### 测试命令与结果

- 单元+进程集成：pkg 目录内 `node pnpm.mjs exec vitest run` → **15 文件 451 测试全绿**（= 票 32 合并后的 431 基线 + 本票 20：ephemeral-lifecycle 7、session-action +7、actions +4、index +1、service +1）。覆盖：投递全链（直铸 id/currentSelection 缺省与显式 model/preset resolve+mount/meta 形状/返回 handle）、preset_unknown 三路（服务缺失/解析失败/cwd 越界）、delivery_failed 携带 sessionId+handle、零延迟/延迟/活动重置/病态防自旋（fake timers）、retain 不回收、disposeAll 幂等清计时、dispose/whenIdle 抛错防御、dispatch 集成（adopt/retain/缺登记器防御/idleDisposeSeconds 透传/失败隔离）、index 端到端（agents.create 全链 → 收敛后 dispose → 卸载 disposeAll 幂等）、persistent 拒绝 idleDisposeSeconds（负向既有）+ ephemeral 归一化（正向新增）。
- 隔离集成：`pwsh scripts/verify-ticket33.ps1` → **全部断言通过**（三轮调试后全绿，见偏差 6）。阶段：隔离 profile（`DSH_HOME=<repo>/.sandbox/s33/home`，profile `orch33`，file: 指向 worktree pkg + 探针插件；死端点 LLM 同票 32 样本）→ 无头启动（`--port 0`）→ 创建 5 编排（eph-zero 零延迟 banner / eph-delay 30s 延迟 plain+显式标题+preset / eph-activity 15s+接管推迟 / eph-long 600s+显式 model / eph-preset 未知预设）→ T+70 结算与 projcache 断言 → 写接管任务 → T+80 liveness 断言 → T+108 dispose 断言 → 杀宿主 → phase2 冷会话重开断言 → 清理。

### 隔离验证证据（探针 = @local/dsh-orch33-probe，inject agents/sessionController/sessions）

- **dispose 的外部可观测面**：探针轮询插件 runs 存储（`run.actions[].sessionId`）发现会话，再轮询 `ctx.agents.get(id)` 记录 live↔cold 转移（agents 注册表注销 = live Agent teardown 的确定性信号）。
- **创建/投递**：四编排 succeeded + sessionId；`agents.create` 收到直铸 id、缺省 model=currentSelection（死端点）、preset 解析 standard 进 meta+mount（projcache agentPreset=standard、modelSelection.lastUsed=probe-dead-model）；banner 全文（titleInput）与缺省标题（`零延迟整理 · 96b4`）；eph-delay 显式标题 + plain（titleInput 恰为 prompt 本身）。
- **空闲收敛 + 零延迟 dispose**：eph-zero（idleDisposeSeconds=0）在 T+80 已冷（agents 注销）；dispose 后投影缓存仍可读（历史留存）。
- **延迟 dispose**：eph-delay（30s）T+80 仍 live、T+108 已冷（~T+91 到点）。
- **用户活动推迟**：eph-activity（15s；无活动将于 ~T+76 回收）——探针注入三次接管对话（followup 内联 UserMessage + flush true，0.5/3/6s 偏移），T+80 仍 live（回收被推迟）、最后活动+15s 后已冷；会话目录数全程 4（dispose 不删历史）。
- **失败不回收（宿主可达面）**：eph-preset → `preset_unknown` 且零会话目录（失败在创建之前；delivery_failed 的「不启动回收 + retain」由单测 fake 覆盖——票 32 同边界，健康沙箱 followup/flush 必接受）。
- **卸载 teardown 近似 + 冷会话重开**：杀宿主（= owner-fiber teardown 近似，契约先例口径）时 eph-long 仍 live；重启后 phase2 探针对 4 个冷会话 `resolveAgent` 重开全部成功且 followup 接受 + flush true（持久化日志/目录/投影留存，插件重启不重新认领——登记表内存态）。
- 全程自建 DSH_HOME（验证后沙箱已删）；宿主终止按端口监听进程杀（两轮端口均确认无监听）。

### 实现偏差与依据（契约 → 票序/宿主现实）

1. **「新活动重置」的观察面用 `agent.ctx` 上的 `agent/status` 事件**：决策 21 #5 只说「新活动重置」未定接口。宿主 `setPhase` 在 idle↔running 跃迁经 agent 作用域发布 `agent/status {status}`（本机核实 dsh-agent-loop）；listener 挂 agent.ctx（作用域内可见）。armed 后回读 `agent.status` 兜底「事件已错过」窗口；无事件面的 agent 退化为只靠 whenIdle（契约竞态声明覆盖残余）。maintenance 状态宿主外部口径即 idle（status getter 映射），不视为活动。
2. **活动重置的回读分支必须让步事件循环**：病态 agent（whenIdle 立即返回而 status 恒非 idle）下纯微任务 continue 会饿死事件循环——vitest fake timers 实测复现（首轮测试挂死）。以 1ms macrotask 让步修复并保留病理防御测试（advance 能返回即证明不饿死）。
3. **投递失败现场保留 = handle 存活到卸载**：`retain` 条目不启动回收，live agent 由 `disposeAll`（显式）与宿主 owner-fiber teardown（兜底）清理——「失败现场不得秒回收」与「会话可被人工接管」同时成立；`SessionActionError.handle` 是失败 handle 的交回通道（persistent 路径无此字段）。
4. **`whenIdle` 挂 agent 不挂 handle**（票 23 E3 API 修正结论）：实现与测试的 fake 均按 agent 面；handle 仅 `{agent, dispose}`。
5. **delivery_failed 宿主级触发不可达**（票 32 同边界）：健康沙箱 followup/flush 必接受；三路失败（followup 抛错/flush 拒绝/presets 服务缺失）由单测 fake 覆盖，宿主负向以 preset_unknown（创建前失败）为边界证据。
6. **验证脚本两处踩坑（对后续票有普适价值）**：① PowerShell 单元素 hashtable 经**管道** `ConvertTo-Json` 产出对象而非数组（探针 `for...of` 抛错）——必须 `ConvertTo-Json -InputObject @(...)`；② 探针定时回调里的 async 函数 rejection 被 `void` 丢弃成 **unhandled rejection，实测 fatal 整个宿主**（`dsh: fatal load failure`，笔记 02 S25 的宿主纪律）——回调一律 `.catch` 落日志，任务文件读后改名 `.consumed` 防重启重复消费。另：探针 followup 偏移必须是**绝对偏移**（顺序 sleep 会累加，第三条落到检查点之后）。
7. **`agentOptions` 缺省为 `currentSelection() ?? undefined`**：宿主无默认模型选择时裸创建照常（首个 step 抛 `has no provider/model` = turn 失败，不回滚动作成功——契约收窄口径），不预先失败动作。
8. **保留 ephemeral 的 cwd/标题/banner/模板行为与 persistent 完全一致**：`resolveSessionCwd`/`deliverFirstMessage` 同一实现复用，无模式分叉（契约 05 字面）。

### 残余风险

1. 回收竞态只承诺契约规定的 durable inbox 边界：到期 dispose 恰逢发消息，已 flush 进 durable inbox 的消息不丢、会话重开后仍会被处理（死端点场景无法实测真实 LLM 回合的消息处理时序——票 36 顺带）。
2. 「用户接管/对话活动」的活动重置依赖 `agent/status` 事件面与 `agent.status` 回读；若宿主未来更改事件形状（0.2.2-rc.1 内核实），重置退化为 whenIdle 单保险（契约竞态声明仍覆盖），需要同步适配。
3. 卸载 teardown 以「杀宿主 + 显式 disposeAll 单测」双近似：真实 Electron 插件停用（不杀进程）的 owner-fiber teardown 行为未实机触发（契约如实声明口径；票 36 实机验收顺带）。
4. 面板浏览器实机未重跑（ephemeral 结果展示与 persistent 同形，票 32 已交付 sessionId/「可接管」展示；jsdom 覆盖）。
5. `whenIdle()` 在极长活动（如挂死的 maintenance）下会推迟 dispose 直至活动结束——dispose 内部 abort/cancel 机制由宿主保证收敛，本插件不额外加超时（契约未规定，过度设计）。
