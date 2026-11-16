# 11 · Web 面板：通信与刷新（renderer 侧）

Web 面板是 renderer 进程的 client 插件，不能直接取得 Host Context；一切管理操作经本契约的桥接层到达 `ctx.scriptOrchestrator`。桥接层复用 [06](06-events-service.md) 的服务语义，是继工具适配层（[07](07-tools.md) 分层总则）之后的第二个薄适配层。本文定义通信、刷新以及 v0.1u 的创建/编辑交互；构建注入见打包契约。

## 桥接形态

- **独立 Connection channel 的一元 RPC**：契约语义为 `connection.rpc.handle('/script-orchestrator', handler)`；浏览器侧 `ctx.connection.rpc.call('/script-orchestrator', endpoint, payload, signal)`。
- **实现备注（v0.1r，0.2.2-rc.1 实测）**：`connection.rpc.handle` 对第三方插件不可用——Cordis trace 把 `owner.webServer` 解析锚定到 client-connection 自身 fiber（其未注入 webServer），任何第三方插件调用必抛 `cannot get property "webServer" without inject`。实现改为**内联等价挂载**：`webServer.register` prefix 路由 + `connection.admit`（认证/fence 复用内建）+ 与宿主 `rpcFetchHandler` 对齐的 envelope 协议（client-request / server-response / gateway bad-request / handler failure）。浏览器侧调用面与错误形状零改动。
- 不使用 Typert Remote（不要求 `./typert` 生成物与 `remote.$mount` 注册链）；不占用保留 channel `/api`。
- 认证与 Host/Origin fence 复用 `connection.admit` 内建机制；v0.1 不加自定义 token、不做面板级权限。

## 端点表

| endpoint | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list` | `ListQuery` | `ListResult` | 与服务同形（含 `nextOffset`） |
| `view` | `{ id, runs? }` | `OrchestrationView & { runs }` | 与服务同形 |
| `create` | `OrchestrationInput` | `OrchestrationView` | |
| `edit` | `EditInput`（四 action） | `OrchestrationView \| DeleteResult` | 暂停/恢复直接 `action: 'pause' / 'resume'`，CAS 全 action 生效 |
| `run` | `{ id }` | `{ runId, status }` | **受理即返回**，`status` 可为非终态；不等结算 |
| `listActions` | `{}` | `Array<{ name, description? }>` | 编辑器的注册动作提示 |
| `spill` | `{ runId, stream: 'stdout' \| 'stderr' }` | `{ runId, stream, path, content, bytes }` | run 的完整溢写输出（排障读面，v0.1r）；溢写缺失/文件不存在/不可读 → `script_storage_unavailable`（`details.cause` 区分），面板显示「文件已不存在」 |

- 参数与返回**原样复用服务契约形状**（零翻译 DTO，全部无损 JSON）。
- 动作提示的读面（v0.1r 更正）：`view` 原样返回服务 `OrchestrationView`，其中 `availableActions` 即注册动作表快照（按 `name` 排序），面板详情直接展示；`listActions` 端点保留供按需刷新/单独取表（例如编辑器只要动作表、不取整条记录）。原「动作提示按需另调 `listActions`，不混入 `view` 返回」的表述与实现不符，以本条为准；两个读面同源（同一注册表快照），不是两套数据面。
- run 的进度与结果一律经 `view` 回读，`view()` 的 run 记录是最终事实。

## 创建/编辑路径（v0.1u，2026-11-15）

面板保留列表与详情/run 历史，管理操作集中于详情；新建走对话，详情提供「手动修改」和「在新会话修改」两个明确入口。本条取代 v0.1o「不做独立配置表单」的限制，不改变管理服务、调度或存储模型。

### 列表与详情布局（v0.1v）

- 未选择编排时列表占满内容区；点击具体编排后分为左右两列，左侧列表保持可操作，右侧显示该编排详情与 run 历史，不再使用居中详情模态。
- 当前编排行有选中态，标题按钮支持键盘激活；点击其他编排直接切换右侧详情，旧请求不得覆盖新选择。关闭详情恢复完整列表，不取消已受理的 run。
- 详情加载中和回读失败时仍有关闭入口，失败可重试。窄容器上下排列，表格可局部横向滚动，长标题、命令和输出不得撑破容器。样式与交互沿用 DSH 主题。
- 手动编辑、删除确认与完整输出保留独立模态，编辑模态打开期间维持焦点限制与未保存草稿确认；详情本身不限制焦点、不遮挡列表。

### 详情管理操作（v0.1w）

- 列表仅显示「状态、标题、触发、下次」四列，不再提供操作列或行内管理按钮。
- 已加载详情展示管理操作：active 可暂停，paused 可恢复，ended 不展示暂停/恢复；所有状态可手动执行及删除。编辑入口保留在详情。
- 删除仍须二次确认，并提示取消在途 run 与级联删除记录；成功后关闭已删除编排详情并刷新列表。其他管理操作成功立即回读 list/view，失败明确展示且不静默关闭详情。

### 完成后行为展示（v0.1y；v0.1aa 去键化）

- 详情在「触发配置」与「执行记录」之间的**「脚本完成后」**区把 `judge`/`actions` 配置翻译成简体中文明话，**正常展示不出现动作键**（如 `archive-session` 一类的键名不显示）：
  - 规则逐条一行：「规则 N：当 `<条件描述>`」，条件覆盖 exitCode（数字/`not`/`in`/`min`·`max`）、`timedOut`、`signal`、`durationMs`、stdout/stderr 谓词（`regex`/`contains`/`jsonPath`+`equals`/`truncated`）与 `all`/`any` 组合；空 `when` 显示「无条件（总是命中）」。命中动作为零个时行尾直接接「→ 不执行动作」。
  - 命中的动作逐个缩进行「→ `<动作描述>`」：event →「发出事件 `<短名>`」；plugin →「调用注册动作 `<注册名>`」，当前未注册时附「（当前未注册）」警示；session →「开启 一次性/持久 会话「<标题>」」（标题缺省则止于会话类型）；类型未知 →「未知类型的动作」。
  - **prompt 预览可展开（v0.1z）**：session 动作描述后接 prompt 首行预览（截断显示）作为可点击开关；点击展开下方完整 prompt（等宽块、超高滚动），再点收起。展开状态是纯本地展示状态，不进编辑、不触发取数。prompt 缺失或非字符串时不渲染开关。
  - 兜底行：「兜底（无规则命中）」，动作为零时行尾接「→ 不执行动作」，否则同样逐动作缩进行；零规则且无 `fallback` 字段显示「脚本完成后不执行任何动作」。
  - 规则/兜底引用了 `actions` 里未定义的键：该缩进行以错误色显示「未知动作「<键>」（actions 里没有定义）」——**该区唯一显示动作键的场景**（排障必需，否则面板对坏配置说谎）。
  - 已定义但未被任何规则/兜底引用的动作：弱化色单行列出描述（「已定义但未引用：…」），不显示键。
- run 卡判定行与详情规则编号对齐：`matchedRule` 零下标（契约 04）按 N+1 显示为「命中规则 N」；`usedFallback` →「命中兜底」；全未命中 →「未命中（不执行动作）」。仅改展示，字段语义不变。
- 该区是纯展示（配置来源 `view`），点击不进入编辑；编辑仍走「手动修改」/「在新会话修改」，动作键在编辑 JSON 中照常可见（判定用键引用动作的机制不变）。

### 执行记录展示（v0.1x）

- 详情打开即以 `view { id, runs: 50 }` 取回最近至多 50 条 run（服务单次上限），计数与 5 秒活动轮询共用同一口径；取回数达到 50 时在执行记录区如实标注「最多显示最近 50 条」。
- 默认只渲染最近 **3 条**；取回数大于 3 时提供「展开全部执行记录」，展开后展示完整已取回列表并可「收起」回 3 条；展开/收起是本地展示状态，不触发额外取数、不影响轮询与已受理的 run。
- 单条 run 卡片面向人类阅读，不改变任何字段语义：
  - 状态用彩色徽章（沿用主题 token）：成功绿、失败红、部分黄、跳过/取消灰、非终态（queued/running/judging/dispatching）品牌色、interrupted 黄。
  - 时间以相对表述为主（刚刚 / N 分钟前 / N 小时前 / N 天前，更早显示日期），悬停 title 可见绝对时刻；未结算的 run 标注「开始于」，未开始的标注「计划于」。
  - 耗时人性化：`2200ms` 显示为 `2.2 秒`，超一分钟显示 `M 分 S 秒`；跳过等无执行耗时的 run 不显示耗时。
  - 非零退出码以错误色突出；超时、截断保留原有事实标注。
  - runId 只显示尾 4 位缩写，悬停 title 见完整 id（排障与 spill 按钮仍在卡片内）。
  - `stdoutTail` / `stderrTail` 尾部均直接展示并加流标注，stderr 用错误色呈现；完整输出仍走 spill 模态。
  - **结果块优先展示（v0.1y）**：`run.result` 存在时，在判定行之后、原始输出之前渲染结果块——脚本标记行结果（summary 按 level 配色：info 中性、warn 黄、error 红；fields 键值对列出）与其后追加的 `reports`（每条：相对时间 + sessionId 尾 8 位 + summary + fields）。无 result 的 run 卡片不变。
  - **会话引用可跳转（v0.1ab）**：run 卡内出现的 sessionId——动作行的派发会话（成功与 delivery_failed 都有）与结果块 reports 的上报会话——渲染为链接样式按钮，点击经 `ctx.uiWorkspace.openSession(sessionId)`（DSH uiWorkspace 客户端服务）选中该会话并展示其对话。跳转是纯导航：不改变 run 记录与编排状态，也不预填草稿。宿主 `uiWorkspace` 未提供 `openSession` 时降级为纯文本展示（原样保留 id）。
- 结果上报到达没有推送（见「刷新策略」）：run 已结算时面板不自动刷新，用户手动刷新或下次回读可见；`script_report` 的返回值即时确认给上报会话。

### 内置 SKILL 对话

- 「新建」/「在新会话修改」使用 `uiWorkspace.startSession` **只预填草稿、不自动发送**；消息包含独立 `/script-orchestrator` 调用、创建或修改意图（修改仅携带编排 id）与自然语言输入位置，不拼入配置快照、环境变量值或技术配置清单。已有草稿不得静默覆盖。
- 插件通过 Host `skills.register` 注册内置 `script-orchestrator`，完整流程在随包分发的 SKILL 中维护；支持显式调用和模型按需加载。不能加载技能或缺工具时说明限制，不跳过确认流程。
- 先理解用户自然语言需求；无需求先请用户描述。仅追问缺失或不明确的信息，每题给 **1～3 个有效选项**，推荐项放首位并说明建议；允许自定义回答。已知信息不重复问，跳过问题不视为同意或授权。
- 信息齐备后简洁总结实施目标：功能、计划与时区、输入/输出和动作、修改范围、启用状态、可观察验收结果；请求用户明确确认。确认前不得写脚本、创建/修改编排或试运行；确认后变更目标须重新确认。试运行须单独获授权，不能把创建/保存授权当作执行授权。
- 创建**固定以暂停落库**（显式 `enabled: false`，不询问、不默认启用；v0.1y 起 SKILL 固定规则取代 v0.1u「默认建议暂停」的商量式措辞），创建后告知当前为暂停态与启用方式；用户需求中已明确要求启用时，创建后立即 resume 并在总结中说明。新建编排的脚本文件固定写入 `~/scripts/<编排id>.<扩展名>`（目录不存在则创建，不询问路径；用户主动指定位置时遵从）。修改默认保留原有启用状态，目标摘要说明是否影响运行中的计划。
- 会话修改先 `script_view` 获取权威配置和 `updatedAt`，仅提交必要顶层 patch 并携带 `expectedUpdatedAt`；嵌套对象是整块替换，必须保留未修改字段。遇 `script_conflict` 回读并重新确认，禁止盲重试覆盖。成功后回读报告状态，不回显密钥。
- 本流程为对话行为约束，**不是后端强制审批锁**。原工具/服务保持兼容。`script_view` 仍返回完整配置，避免回复回显不代表模型上下文已脱敏。

### 手动修改

- 常用字段用表单：标题、触发计划（every 模式/间隔或 cron/时区）、命令、逐项参数、工作目录、超时、启用状态与重叠策略；复杂判定、动作及脚本高级字段用 JSON 编辑。id 和运行派生字段只读，不支持在编辑器创建或删除编排。
- 编辑以打开时的权威 view 为基线，保留未改字段（包括脚本的 env/stdin 等高级字段）；表单与 JSON 的字段所有权明确，禁止重复值互相覆盖。JSON 语法及最小形状错误就地提示，业务校验仍由服务负责。
- 保存先展示变更摘要，再明确确认提交 `edit { action: 'update', patch, expectedUpdatedAt }`；无变更不提交。修改 active 编排可能影响后续自动执行，确认时提示；保存不触发手动 run。JSON 可能含敏感值，摘要不得回显值。
- 保存期间防重复提交。取消/关闭有未保存修改时需确认丢弃；关闭/卸载不等于取消已受理的服务操作。
- 冲突保留草稿并显示恢复指引，不自动覆盖或重试；加载新版本会丢弃草稿时先确认。传输失败不能断言写入未发生，提示回读核对再决定。成功后立即权威回读 list/view；回读失败与保存失败区分显示。
- 编辑对话框提供明确标签、键盘 Escape、焦点限制与关闭后焦点恢复；样式遵循宿主主题。macOS 未验证提示仍放部署/诊断说明，不占主面板。

## 校验、错误与 abort

- 桥接层只做**最小形状校验**：缺字段/类型错/多余字段 → `script_input_invalid` 同构映射（`unexpected` / `missing` / `range` / `format` + 准确 `field`）；业务语义全部由服务判定。
- 契约错误 `{ code, message, details? }` 原样透传；传输层失败由 Connection envelope 表达；不新增错误码。
- **abort 只终止等待，不取消已受理操作**：`create`/`edit` 照常完成（下次回读见结果）；`run` 端点不把 UI 请求 signal 传给执行——关掉详情页 ≠ 取消脚本 run；v0.1 面板不暴露 run 取消入口（删除编排连带取消其 run 属既有语义）。

## 刷新策略

权威数据永远来自 `list()`/`view()`，不依赖事件重放：

1. **写后权威回读**：`create`/`edit`/`run` 成功后立即重取 `list`/`view`。
2. **连接重置回读**：浏览器 `connection/reset` 事件后全量重取。
3. **活动 run 轮询**：仅当「面板可见 **且** 存在非终态 run」时每 **5 秒** `view(id)`；任一停止条件（无活动 run / 面板不可见 / 组件卸载）即停。

如实声明：`script-orchestrator/*` 不在第一方 Remote 事件转发白名单内，**没有实时事件推送**。

## 用户可观察语义

- Desktop 安装、manifest 变更、后端重启按**重启/刷新边界**生效，不承诺 SSE 级即时。
- 开发期 client HMR 重建会**重置面板 React 本地状态**（连接等外层状态保留），刷新后恢复。
- 无实时推送期间列表可能过期，一切以回读为准。
- 后台标签页不轮询（面板可见性与轮询联动）为实现验收项。
