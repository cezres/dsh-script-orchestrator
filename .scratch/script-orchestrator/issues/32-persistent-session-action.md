# 32: 通过 persistent session 接管失败排查

**What to build:** 用户的编排命中 session 动作后，系统创建一个新的 persistent root 会话并投递脚本结果，用户可从 run 记录接管排查；投递失败时保留会话现场。

**Blocked by:** 30 — 按判定结果发出 event 动作

**Status:** resolved

- [x] session 动作支持 persistent 默认模式、prompt 模板、banner/plain、缺省标题、cwd/preset/model 校验；session cwd 同受 allowedRoots 限制。
- [x] 经 `sessionController.create()` 创建宿主语义 root，每次 run 新建会话，不伪造 child、不复用旧会话、不做独立 Workspace attach。
- [x] 首条消息使用内联结构完整 UserMessage，`source.kind = 'user'`；动作成功仅表示创建成功、followup 接受且 flush 未拒绝，不断言消息已经 append 到会话日志。
- [x] 成功与投递失败均在 run 动作结果中记录 `sessionId`；followup/flush 失败映射为 `delivery_failed` 并保留会话，标题重命名失败仅记 warnings。
- [x] 面板展示 session 动作结果和可接管的会话引用；删除编排不触碰已经创建的会话。
- [x] 隔离宿主测试覆盖缺省 preset/model、banner、成功投递、死路由、失败保留和删除编排后的会话留存，不冒称正常 LLM append 时序已验证。

## Comments

### 做了什么

按票验收项 TDD（红-绿循环，先写失败测试）实施，交付「persistent session 动作真实执行路径」端到端：

1. **投递模块**（`lib/session-action.js` 新增，契约 05/09 + 决策 20/21 + 原型 23 逐行实证路径）：
   - `buildFirstMessageText`：banner（三行抬头 + 空行 + 单行 JSON 事实块 + 空行 + prompt）/ plain（仅 prompt）；`buildBannerJson` 按契约 05 示例字段序（runId/orchestrationId/status/exitCode/timedOut/durationMs/matchedRule）。
   - `defaultSessionTitle`：`${编排标题} · ${runId 尾 4 位}`。
   - `resolveSessionCwd`：缺省链 动作 cwd → 编排脚本 cwd → 配置 defaultCwd → Host 工作目录（与 runner 脚本 cwd 同链）；只做 allowedRoots 边界（**不**要求目录已存在——`sessionController.create` 自带 `mkdir(recursive)`，与脚本 cwd 的 stat 预检不同）。
   - `buildInlineUserMessage`：内联构造 `{ id: randomUUID(), role: 'user', content: [{type:'text',text}], source: {kind:'user'} }`（票 23 E1 定案，import dsh-llm 不可行）。
   - `deliverPersistentSession` 投递序列：① cwd 预检（越界 `cwd_not_allowed`，不创建会话）→ ② `sessionController.create({ sessionId: 'session-'+uuid, cwd, agentPreset? })`（Host 代 compose 缺省 preset/model；未显式给 preset 时**不传** agentPreset 键；preset 解析失败判别 `agent-preset/not-found` → `preset_unknown`；其他创建错误 → `internal_error`）→ ③ `resolveAgent(create 返回的 sessionId)`（宿主可能另铸 id，票 23 E2）→ ④ 显式 model 经 `agent.model.select()` 在首条消息前记录 session-local 选择（不改 Host 默认）→ ⑤ 标题：显式 title（空串视同未指定）或缺省模板，经 `ctx.get('sessionTitle').rename(agent.session, title)` 钉住，**失败仅记 warnings**（决策 21 #3）；服务缺失也记 warnings；rename 放投递前（失败现场也有可辨认标题，且 user-source title 阻止宿主用首条消息 fallback 改题）→ ⑥ `followup(内联 UserMessage)`（抛错含 `cannot append outside a SessionStore` → `delivery_failed`）→ ⑦ `await sessions.flush(agent.session)`（抛错 → `delivery_failed`；返回 false 非拒绝、按成功处理仅记 warning）。
2. **派发器接入**（`lib/actions.js` session 分支替换票 30 占位）：persistent → 真实投递，`SessionActionError` 的 code（cwd_not_allowed/preset_unknown/delivery_failed/internal_error）映射动作错误码；**成功与 delivery_failed 均在 run.actions[] 记录 sessionId**（error.message 同步携带）；ephemeral 占位改为仅注明票 33；宿主会话服务未注入 → 防御性 `internal_error`（不伪造成功）。
3. **接线**（`lib/runner.js` + `lib/index.js`）：inject 增 `sessionController`/`sessions`；`sessionHost = { sessionController, sessions, getSessionTitle: () => ctx.get('sessionTitle') }` 注入 runner → dispatchActions；`sessionEnv = { allowedRoots, defaultCwd, hostCwd, scriptCwd }` 按当前编排组装；dispatch run 视图补 `orchestrationId`（banner JSON 需要字段）。
4. **面板**（`lib/client.js`）：RunCard 动作行渲染 `sessionId`（session 动作成功 → 「（可接管）」提示；delivery_failed → sessionId 随错误展示，排障入口）。
5. **存储/工具面零增量**：`runActionSchema.sessionId` 票 26 已铺（本票启用）；`script_view` output 的 runs 为松散对象，sessionId 原样透传；桥/工具对 actions 的 session 字段透传服务层（票 25 已铺全量静态校验：mode 枚举、title ≤120、prompt ≤32KiB、framing 枚举、idleDisposeSeconds 仅 ephemeral、model 形状）。

### 包 / 目录结构（票 32 增量）

```
pkg/
  lib/  session-action.js（新增）  actions.js  runner.js  index.js  client.js（扩展）
  test/ session-action.test.js（新增 21）  actions.test.js（session describe 重写 +5 净增）
        runner.test.js（+2）  index.test.js（+1）  client.test.js（+1）
scripts/verify-ticket32.ps1（死端点 LLM + allowedRoots profile 配置 + 四编排 + projcache 观测）
```

### 测试命令与结果

- 单元+进程集成：pkg 目录内 `node pnpm.mjs exec vitest run` → **15 文件 332 测试全绿**（session-action 21、actions 23、runner 40、index 8、client 16 等；较票 30 的 302 增加 30）。覆盖：banner/plain 全文与 JSON 字段、缺省标题尾 4 位、cwd 缺省链与 allowedRoots（含继承脚本 cwd 受限）、投递序列调用序（create 参数/resolveAgent 用 actual id/model.select 传参/rename 缺省与显式/followup 消息结构/flush）、preset_unknown（code 与文案双判别）、followup 抛错（dispose 场景文案）与 flush 拒绝 → delivery_failed + sessionId、resolveAgent {error} → delivery_failed、create 其他错误 → internal_error、rename 失败/服务缺失 → 仅 warnings、flush false → 成功 + warning、ephemeral 占位、宿主服务缺失防御、index 级端到端（apply → runner → dispatch → sessionHost，含 sessionId 持久化）、runner 级 config.allowedRoots 接线、面板 sessionId/「可接管」/delivery_failed 展示。
- 隔离集成：`pwsh scripts/verify-ticket32.ps1` → **全部断言通过**（两轮运行，第二轮全绿）。阶段：环境预检 → 隔离 profile（`DSH_HOME=<repo>/.sandbox/s32/home`，profile `orch32`，file: 指向 worktree pkg；`cordis.patch.yml` = 原型 23 死端点 LLM 样本（`127.0.0.1:1`）+ 本插件 `allowedRoots: [仓库根]` 配置注入）→ 无头启动（`--port 0` OS 分配）→ 创建四编排（A1 缺省链 banner、A2 显式 preset/model/title/plain、B session cwd `C:\Windows` 越界、C preset `no-such-preset`）→ T+70s 断言 → T+135s 二轮断言 → 杀宿主冷重启再断言 → 杀端口清理。

### 隔离验证证据（要点）

- **A1 缺省链**：run succeeded、动作 succeeded 且记录 sessionId、无 warnings（rename/flush 均被接受）；zstd 日志 header 含 sessionId 与 `agentPreset:"standard"`（Host compose 默认）；无 `has no provider/model`；projcache `modelSelection.lastUsed = probe-dead/probe-dead-model`（缺省 model 链真实走到 agent-default-model 配置）。
- **A1 banner 全文**（projcache `titleInput.first.text`，比 zstd 更强的证据——**user/message 确已 append 进会话事件流**）：三行抬头逐字匹配 + JSON 事实块含正确 runId/orchestrationId/status/exitCode/timedOut/durationMs/matchedRule + prompt 变量已渲染（`巡检退出码 0，stdout：SESSION-ORCH-MARKER`）；`sessionListMetadata.lastPromptAt` 已更新、`blank:false`（决策 21 #1 的 kind=user 可观测性实证）。
- **A2 显式**：显式 title `显式标题排查` 生效；`titleInput.first.text` 恰为 plain 正文（无 banner）；显式 preset 进 header/projection；model 选择链未破坏投递。
- **B/C 落点冲突**：`cwd_not_allowed` / `preset_unknown`（经 profile 配置注入的 allowedRoots 与真实 preset 解析），均无 sessionId 且**未创建任何会话目录**（T+70 时 sessions 目录数恰为 2）。
- **每 run 新建会话**：两轮触发 → 两个不同 sessionId + 各自缺省标题（`缺省链巡检 · 41b6` / `· 8212`，尾 4 位随 runId）；目录数 4 = 两轮 A1 + 两轮 A2。
- **重启留存**：杀宿主 → 冷重启 → 编排与 run 历史（含 sessionId）权威回读仍在，4 个会话目录与 projcache 原样留存（宿主/插件重启不触碰 persistent 会话）。
- 全程自建 DSH_HOME（验证后沙箱已删）；宿主终止按端口监听进程杀（两轮端口均确认无监听）。

### 实现偏差与依据（契约 → 票序/宿主现实）

1. **观测面换用 `session_projcache`**：原始 `session.v4.jsonl.zstd` 在死路由场景仅落 header（事件后缀未写出文件，票 23 E6 同象——强杀宿主后仍 header-only）。但宿主每会话持久化的投影缓存（`storages/session_projcache/sessions/<id>.json`）完整可读：title/modelSelection/agentPreset/**titleInput（含首条消息全文）**/turnOutline/sessionListMetadata。验证脚本据此断言，并修正了对 E6 的理解：**E6「消息永不 append」实为文件层观测；事件流层面 user/message 确已 append**（titleInput.count=1、messageTokens>0、turn 开始），只是 zstd 事件后缀的写出晚于观测点。契约 05 v0.1p「flush 不证明 append」的**保证级别**不变（我们不依赖 append 事实判定成功），本发现只加强了对实际行为的认知。
2. **banner JSON `status` 取 `succeeded`**：契约 05 示例为 `"failed"`，但与 event 动作载荷同口径（票 30 偏差 1，经第二模型仲裁）：事件/消息在 dispatch 阶段生成，能进派发的 run 脚本阶段必已正常完成，真实退出码由 `exitCode` 携带。matchedRule 按 verdict 原值（fallback → null）。
3. **delivery_failed 的宿主级触发不可达（如实声明）**：健康沙箱内 followup/flush 均正常接受（原型 E5 靠对已 dispose 会话 followup 才触发，persistent 模式无 dispose 面）。delivery_failed 语义（保留 sessionId、不回滚会话、失败 isolation）由单测 fake 宿主覆盖（followup 抛错/flush 拒绝/resolveAgent error 三路）；宿主级失败保留以 B/C（创建期失败不建会话）+ 重启留存为边界证据。
4. **「删除编排后留存」以「杀宿主重启留存」近似**：删除级联属票 29（服务面尚无 delete），本票验证宿主/插件生命周期结束不触碰已建会话 + 代码面零耦合（session-action 无任何 teardown/级联钩子，会话生命周期归宿主）；票 29 落地 delete 后应补真实删除路径断言。
5. **`title` 显式空串视同未指定**（走缺省模板）：静态校验允许空串（`allowEmpty`），但空串归一化后必被 rename 拒绝、且语义上无意义，归一到缺省比记 warning 更符合「缺省标题」意图。
6. **dispatching 取消对 session 动作为尽力而为**：sessionController.create/flush 均无 signal 面；取消发生在 session 动作在途时该动作照常完成（结果如实记录）、剩余动作照常 skipped。与契约 03「在途动作经其 signal 中止」的差距是宿主 API 事实，记入残余风险。
7. **`resolveAgent` 失败映射 `delivery_failed`（携带 sessionId）**：契约 09 字面仅列 followup 抛错/flush 拒绝；resolveAgent 失败同为「会话已创建但投递链断」，保留 id 供接管与契约意图（「投递失败保留现场」）一致。
8. **flush 返回 false 的处理**：宿主语义为「无持久化 listener 参与」，非拒绝；按契约成功口径（flush 未拒绝）算成功并记 warning（观测提示），不失败动作。

### 残余风险

1. 正常 LLM 回合下的 append 时序未验证（死端点场景 turn 在 LLM 调用处失败；projcache 证明消息已入事件流，但完整「请求-响应」回合需可用 provider——票 36 实机验收顺带）。
2. delivery_failed 的宿主级端到端未触发（见偏差 3）；面板浏览器实机未重跑（sessionId 展示经 jsdom 真组件断言，基础设施未变，票 36 顺带）。
3. zstd 事件后缀不落盘是宿主 0.2.2-rc.1 行为（header 落盘、事件后缀批量/延迟写出；强杀后丢失）；若上游改为即时写出，观测面可切回原始日志，契约语义不受影响。
4. ephemeral 模式（agents.create/whenIdle/idleDisposeSeconds/dispose）整体属票 33，当前 action_error 占位；静态校验（idleDisposeSeconds 仅 ephemeral）已随票 25 存在，无需预铺。
