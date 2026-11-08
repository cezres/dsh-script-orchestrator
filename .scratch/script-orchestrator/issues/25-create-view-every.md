# 25: 通过对话创建并查看 every 编排

**What to build:** 用户从面板「新建」进入引导会话，通过模型工具创建 fixed-rate 或 fixed-delay 编排，随后能在列表和详情模态中查看持久化配置与下次触发时刻。

**Blocked by:** 24 — 安装插件并查看空编排列表

**Status:** resolved

- [x] 面板新建入口经 `uiWorkspace.startSession` 开启新会话并注入引导 prompt，不引入独立配置表单。
- [x] `script_create` 以严格 JSON Schema 校验 every 输入，非法字段、间隔和多余字段统一映射为 `script_input_invalid`，失败不产生任何记录。
- [x] 创建成功后持久化编排并发布 `changed`，`script_list`/`script_view` 与服务、Connection 返回契约形状；此时 `availableActions` 可以为空表。
- [x] fixed-rate/fixed-delay 首次计划均从 `createdAt` 加间隔，创建为 paused 时 `nextOccurrence = null`，创建不立即执行脚本。
- [x] 面板写后回读列表与详情，居中模态展示触发配置、状态和下次时刻，连接重置后重新回读。
- [x] 冷重启后已创建编排及下次时刻保持；测试覆盖创建校验、持久化、工具输出和面板完整路径。

## Comments

### 做了什么

按票验收项 TDD（红-绿循环，先写失败测试）实施，交付 every 编排的「对话式创建 + 查看 + 持久化 + 面板路径」：

1. **触发纯函数**（`lib/triggers.js`）：`nextOccurrence(trigger, fromMs)`——every 返回 `fromMs + everySeconds*1000`（两种模式首次计划同为 createdAt 锚点）；非 every kind 返回 null（cron 属票 27，非法 kind 在创建校验先行拒绝）。
2. **错误模型**（`lib/errors.js`）：`OrchestratorError { code, message, details }` 承载契约错误；`isLosslessJson` 用于 payload JSON 安全校验。
3. **输入校验与归一化**（`lib/validation.js`，服务语义唯一权威）：契约 01–05 全字段——title 去首尾空白 1–120、id 正则、every（everySeconds 整数且 ≥60 → `too-frequent`；mode 枚举；多余字段 → `unexpected`）、script（command/args/env/stdin/timeoutSeconds）、judge（rules 0–32、谓词键白名单与取值形态递归校验、regex 编译校验、jsonPath 极简路径语法、fallback）、actions（键正则、≤16、event/plugin/session 三类 per-kind 字段、保留事件短名、persistent 拒绝 idleDisposeSeconds）、动作键引用静态校验。通过则归一化（默认值填充）返回。
4. **管理服务**（`lib/service.js`）：`create`（FIFO 单槽内：校验 → id 解析（省略由标题 slug 生成、纯中文回退 `orchestration`、重名 `-2` 后缀、显式重复 → `taken`）→ 落库 → 计算 nextOccurrence → **持久写入完成后** `safeEmit('script-orchestrator/changed')`；`enabled:false` → `paused` + `nextOccurrence:null`）；`view`（记录 + 最近 runs 排序截取 + `availableActions: []` 快照；未知 id → `script_unknown`）；`list` 增加查询语义校验；`listActions`（注册表快照，票 31 才开放 registerAction）；emit 发布端 try/catch 兜底记 `event_listener_failed`。
5. **工具适配层**（`lib/tools.js`）：`script_create`/`script_list`/`script_view` 以原始 `ctx.tools.register` 注册；parameters 为严格 JSON Schema（根 `additionalProperties:false`，宿主支持子集：type/properties/required/additionalProperties/items/enum/const）；execute 内 `validateJsonSchemaValue`（从 `@deepseek-ai/dsh-tools` 公开根导入，peer + dev 镜像）校验并把 violation 文案映射为 `{field, reason: missing|unexpected|format}`；服务 `OrchestratorError` 还原为契约错误值；未分类异常 → `internal_error` 值 + 内部日志；`exec.signal` 已中止时异常上抛（宿主 ABORTED 规范结果接管，不吞成业务错误）；`actorSessionId` 自动取 `exec.agent?.session`；output.schema oneOf（成功形状 + 各错误分支 `const code` 互斥，**注意宿主子集要求 const 必须搭配标量 type**）；render 统一单块 `JSON.stringify` 文本。
6. **Connection 桥**（`lib/bridge.js`）：新增 `create`/`view` 端点——最小顶层形状校验 + 零翻译透传 + `OrchestratorError` 原样透传（不升级 internal_error）。
7. **存储记录 schema 收紧**（`lib/storage.js`）：编排记录按实际形状 strict zod schema（every/cron 判别 trigger、script/judge/actions 深层结构、status/时间戳/nextOccurrence）；票 24 时代的最小骨架记录（只有 id/title/status）此后按坏记录处置（backup-and-skip）；runs 表保持最小骨架（票 26 两写落地时收紧）。对齐测试保证 service.create 写入的记录恰好通过该 schema。
8. **入口**（`lib/index.js`）：inject 增 `tools`；注册三工具 → 挂桥 → provide；卸载顺序「先摘工具与桥（停生产者）→ 排干 FIFO → domain.close()」；`emit: (name, payload) => ctx.emit(name, payload)` 接入宿主事件总线。
9. **面板**（`lib/client.js`）：「＋ 新建」→ `ctx.uiWorkspace.startSession(void 0, { prompt: 引导 prompt, whenDraftExists: 'append' })`（schedule 面板 onNewTask 同款先例），**无独立配置表单**；列表渲染 every 触发摘要（间隔 + 模式）、状态、下次时刻；行点击 → **居中模态**（fixed overlay + 居中卡片）经 `view` 回读展示触发配置、状态与下次触发、执行记录（空态提示「创建不会立即执行脚本」）、可用注册动作（空态提示）；回读时机 = 挂载 + `connection/reset`（列表与已开模态都重读）+ 手动「刷新」+ `visibilitychange` 回到可见；client inject 增 `uiWorkspace`。

### 包 / 目录结构（票 25 增量）

```
pkg/
  lib/  triggers.js  errors.js  validation.js  tools.js（新增）
        service.js  bridge.js  storage.js  index.js  client.js（扩展）
  test/ triggers.test.js  tools.test.js（新增）
        service.test.js  bridge.test.js  storage.test.js  index.test.js  client.test.js（扩展）
scripts/verify-ticket25.ps1
evidence/ticket25-panel-list.png  ticket25-panel-modal.png  ticket25-create-session.png
```

### 测试命令与结果

- 单元：pkg 目录内 `node pnpm.mjs exec vitest run` → **9 文件 171 测试全绿**（triggers 5、service 82（含 58 例校验矩阵）、tools 23、bridge 36、storage 5、index 5、client 11、config 8、fifo 3；较票 24 的 45 增加 126）。工具测试同时用宿主 `assertSupportedJsonSchema`/`validateJsonSchemaValue` 自检 parameters 与 output.schema 合法且 oneOf 恰一匹配。
- 集成：`pwsh scripts/verify-ticket25.ps1` → **全部断言通过**。阶段：环境预检 → 隔离 profile（`DSH_HOME=<repo>/.sandbox/s25/home`，profile `orch25`，file: 依赖指向 worktree pkg）→ pnpm install → 无头启动 → 桥 create 合法 every 输入（完整 OrchestrationView + `nextOccurrence = createdAt + 300s` 且落在调用时间窗内）→ list/view 契约形状（runs: []、availableActions: []）→ 非法输入三连（everySeconds=30 → `too-frequent`；多余字段 → `unexpected`；view 未知 id → `script_unknown`）且失败后列表仍 1 条 → 磁盘记录检查（per-record 文件含 id/status/nextOccurrence）→ 冷重启后编排与下次时刻保持、runs 仍空 → 杀端口进程清理。
- 浏览器实机（隔离 DSH 浏览器 tab，登录 token URL）：侧边栏「脚本编排」→ 面板渲染「共 1 条」权威列表 → 点击行 → 居中模态展示触发配置/状态与下次触发/执行记录（0）/暂无注册动作 → 关闭 → 「＋ 新建」→ **切换到新会话且草稿框注入引导 prompt（含 script_create 指引）** → 返回面板重新回读列表。截图：[evidence/ticket25-panel-list.png](evidence/ticket25-panel-list.png)、[evidence/ticket25-panel-modal.png](evidence/ticket25-panel-modal.png)、[evidence/ticket25-create-session.png](evidence/ticket25-create-session.png)。

### 隔离验证证据

- 全程自建 `DSH_HOME`（worktree 内 `.sandbox/`，验证后已删除），未触碰真实 `~/.dsh`；宿主终止按端口监听进程杀（3080 已确认无监听）。
- 工具注册只在宿主内发生，无法经 HTTP 直接驱动：单测经 `ctx.tools.register` mock 覆盖注册/卸载顺序与 execute 连通真服务；端到端的「模型经工具创建」路径由引导会话 + 桥 create 同语义服务保证（同一 `service.create`）。

### 实现偏差与依据（契约 → 票序/宿主现实）

1. **cron 创建暂被拒绝**（票序边界，非契约终态）：`trigger.kind: 'cron'` → `script_input_invalid`（field `trigger.kind`，reason `unsupported-part`，消息注明票 27 交付）；工具 parameters 的 trigger 只声明 every 字段，cron 形状会在 schema 层先报 `unexpected`。存储记录 schema 在**读侧**已接受 cron 形状（域版本 1 的存储契约）。
2. **reason 词表的两处扩展**：02 的 reason 闭集只约束触发字段；非触发字段的重复 id 用 `taken`、保留事件短名用 `reserved`（均归 `script_input_invalid`），已在实现注释与测试中固化。`everySeconds < 60` 用 `too-frequent`（02 硬性下限措辞），类型/非整数用 `format`。
3. **契约 07「模板变量合法性」按 04 落地为非致命**：04 规定未知变量/坏 jsonPath 在 dispatch 期替换为空串 + warning、不整体失败，因此 create 期不存在模板失败路径（prompt 空的 `template_invalid` 是运行期动作失败）；本票只校验 payload/prompt 的 JSON 安全与长度。
4. **宿主 JSON Schema 子集无 min/max/pattern/union**（dsh-tools enforced subset 实测）：工具 parameters 的数值范围（≥60、1–86400、0–50、1–500）、字符串长度（title 1–120、prompt ≤32KiB）、键名格式全部由服务层语义校验兜底，映射为契约 reason；桥的最小形状校验与工具 schema 同此分工。`const` 必须搭配标量 `type`，否则不被求值（oneOf 分支实测发现）。
5. **`lastRun` 未实现**：契约 07 结果示例含 `lastRun`，但无 runs 写入路径前恒为无意义字段（票 26 两写落地时随 run 历史一并考虑）；01 领域模型未把它列为编排字段，View = 记录全字段 + runs/availableActions。
6. **「写后回读」的实现边界**：票 25 面板自身不发起写（对话路径在会话内由工具完成，无事件推送通道——契约 11 如实声明），故面板回读时机 = 挂载/回面板（面板切换即重挂载，实测重读）+ `connection/reset` + 手动刷新 + visibilitychange 回到可见；这覆盖「会话创建后回面板看到新编排」的真实路径。
7. **`whenDraftExists: 'append'`** 照抄 schedule 先例（宿主未文档化的选项按先例使用）；若草稿已存在则追加而不是覆盖。

### 残余风险

1. 工具 `execute(args, exec)` 的 `exec.agent?.session` 取 SessionId 字符串（笔记 05 §7 依 `flush(agent.session)` 推断），未在真实会话内实测（沙箱无模型凭据，无法驱动工具调用回合）；桥 create 与工具 create 同走 `service.create`，语义一致性由同构实现保证。
2. 引导会话的「模型真正调用 script_create」未端到端实测（需可用 provider）；面板注入 prompt、草稿可见性已实测。prompt 文案属产品字符串，票 27（cron）后需同步扩写。
3. 冷重启「保持」验证到进程级（杀宿主重启）；Electron 桌面窗口内行为与 Web 同源（spec §6.3 既有边界）。
4. 记录 schema 收紧后，若有人在票 24→25 之间手工造过非契约形状记录，打开时会被 backup-and-skip 移除（.bak 留档）——符合契约 08，但升级须知里应提一句。
