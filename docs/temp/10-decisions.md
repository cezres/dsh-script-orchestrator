# 10 · 决策记录

## 命名

最终选择：**Script Orchestrator / 脚本编排**。

| 项 | 值 |
|---|---|
| 包名 | `@echo/dsh-script-orchestrator`（本机自有 scope，本地安装；2026-11-10 由 `@local/` 改定） |
| 插件行 id | `script-orchestrator` |
| 显示名 | 脚本编排 / Script Orchestrator |
| 服务键 | `scriptOrchestrator` |
| 工具前缀 | `script_*` |
| 事件命名空间 | `script-orchestrator/*` |
| 领域对象 | `orchestration`（编排）、`run`（执行） |

落选候选：`dsh-scheduled-script-runner`（只表达「定时跑脚本」，漏了结果分发）、`dsh-scheduled-reaction-chain`（名字长到说清三段，但工具前缀 `chain_*` 语义偏弱）、`dsh-script-scheduler`（与已有 `schedule` 服务撞词，易混淆）、`dsh-execution-cascade`（形象但「级联」暗示多级串联，而 v0.1 不做编排串联）。

## 关键分叉

| 分叉 | 决定 | 被否方案与理由 |
|---|---|---|
| 触发源 | **v0.1 为 `every`（`fixed-rate` / `fixed-delay`）+ cron（2026-11-07 修订）** | `daily`/`weekly` 与 cron 表达能力重复，降为 Web 面板预设；RRULE、`at`、`after` 延后，避免首版同时承担高级日历和一次性任务语义。只做 fixed-rate 无法覆盖「完成后等待一段间隔」；两种 every 模式并存但不增加正式 trigger.kind |
| 会话落点 | 两模式均为宿主语义 root：`persistent`（默认，插件不主动回收）+ `ephemeral`（一次性，空闲后 dispose、持久化日志与 Workspace 关系保留）；真正 child 移非目标，复活条件＝触发链路能供 exact live parent 时走 `ctx.subagents.startActivation()`（**2026-11-08 修订，[20 号票](../../.scratch/script-orchestrator/issues/20-session-modes.md)**） | 伪造 child（只加 `origin`/`delegationDepth`）：orphan 在客户端列表反而降级为 root 显示，普通 Session API 又因 origin 拒绝接管，两头落空；child 仅手动支持：actor 距 dispatching 已冷却，parent 可解析性不可保证；自持 child 冷恢复需 descriptor/composition/catalog，成本不成比例 |
| 通知形态 | 事件 + 注册式动作 | 纯事件：编排无法主动调起别的插件能力；加 webhook：多一个网络面、超时与凭据问题，且用户明确排除 |
| 与 `schedule` 的关系 | 完全独立，不共享存储与触发 | 复用其存储会把两种语义耦合；复用其触发则无法在触发点插入脚本 |
| 脚本调用 | `ctx.subprocess.spawn` + argv 数组 | 自建 shell 拼接：注入风险；`spawnTerminal`：PTY 语义对本场景过重 |
| 判定 DSL | 固定谓词 + 首匹配 | 表达式引擎（JS eval / JSONLogic）：前者是安全洞，后者引入依赖且难审阅 |
| 存储后端 | 宿主存储域 + JSON 后端（**2026-11-07 拍板，含 Web 面板需求**） | SQLite：Web 面板是 renderer 进程的 client 插件，只能经 `ctx.scriptOrchestrator` 服务 RPC 取数，摸不到存储后端，换 SQLite 面板零收益；且宿主存储栈无 SQLite 后端（仅 `dsh-storage-json`），绕开 `ctx.storageDomain` 意味着信封、版本迁移、backup-and-skip 全部自研，Electron 内嵌 Node 的 `node:sqlite` 可用性也未验证。全库 1000 条上限下内存查询绰绰有余；将来突破上限时再推动宿主提供 SQLite 后端 |
| 动作命名与注册 | 三类名字各立规则（**2026-11-07 拍板**）：动作键与事件短名维持无点 kebab `^[a-z][a-z0-9-]{0,63}$`，注册动作名必须 `<namespace>.<verb>` 单点两段、保留前缀 `script-orchestrator.`；`unknown_action` 逐动作执行前实时查表；`registerAction` 所有权仅调用方 `ctx.effect`，disposer 幂等/同步/按 token 摘除，dispose 不中止在途动作 | 可选点：全局裸名撞车，形状上无法与动作键区分；禁点：丢命名空间防撞语义且要改全部示例；服务端自动 effect：与调用方所有权叠加，幂等性无法定义；dispose 触发 signal 中止：run 结果依赖注册表时序，且对不监听 signal 的实现无效 |
| 管理接口 | 单一管理契约（**2026-11-07 拍板**）：语义以服务为准、工具为薄适配层（刻意差异仅传输/展示五项）；`EditInput` 对齐 `update/pause/resume/delete` 四 action，pause/resume 状态设置语义（幂等 no-op、不重锚），乐观并发全 action 生效；delete 取消排队与在途 run 后同批级联；`list` 统一 `{items,total,nextOffset}`；`listActions()` 供 `availableActions`（带 description）；工具以原始注册 + 严格 JSON Schema 全映射 `script_input_invalid`，单块 JSON render 与 oneOf output schema；`wait: true` 超限返回非终态 RunView 不报错 | pause=update(enabled) 伪装：状态迁移规则被逼进工具层；defineTool 简写：宿主 INVALID_ARGS 例外破坏单一错误面；wait 超限新增错误码或挪用动作 timeout：把健康 run 的长动作误判为错误；孤儿结算式 delete：session 动作仍为已删编排开会话、事件引用不存在的 id |
| 判定与模板 | matchedRule 定零下标；`truncated` 谓词按流声明、run 级维持单布尔并新增 `{{truncated}}` 变量；warnings 统一 `string[]`（模板警告与 `report()` 同数组、保最近 20 条、确定性文案）；`json:` 失败与未知变量对称；payload 递归渲染字符串值（恒合法 JSON），`template_invalid` 仅剩 prompt 空；渲染在动作执行前、不计超时（**2026-11-08 拍板**） | 序号口径：与「下标」措辞及数组使用冲突；顶层 truncated 谓词：丢失按流精度；文本替换再解析：把 stdout 内容当 JSON 语法，随机破碎且注入面大；warnings 用对象：消费者是人/模型，编程判断已有错误码 |
| 存储布局与恢复 | 域名 `script_orchestrator`、布局 `per-record` + backup-and-skip（两层坏记录语义如实声明）、单 Host 写者前提；服务层 FIFO 整槽复合操作、关闭先停生产者再排干；级联删除与裁剪定为可恢复最终一致（启动孤儿清理、结算后裁剪、未结算不淘汰、settledAt/runId 定序）；版本惰性写回；写入前 parse + 键=id 校验；I/O 未知走关闭-重开-对账（**2026-11-08 拍板**） | 保持 single：一条坏记录全域打不开、无备份跳过、每次写全库重写放大；跨表原子同批：宿主无事务，宣称不出；启动全量归一化落库：非原子大写放大零收益；pending-mutation 标记：改记录布局，v0.1 不值得；盲目重试写被拒：磁盘可能已变，官方明确禁止 |
| Web 面板通信 | 独立 Connection channel `/script-orchestrator` 一元 RPC，六端点零翻译复用服务形状；薄适配校验、错误原样透传；abort 只终止等待（run 不透传 UI signal）；认证复用内建 fence；刷新＝写后回读 + reset 回读 + 可见且有活动 run 时 5 秒轮询；无实时推送如实声明（**2026-11-08 拍板**） | Typert Remote：类型链收益不抵 `./typert` 生成物 + `remote.$mount` 注册链成本；`update(enabled)` 伪装暂停：基于旧服务契约的临时推断，09 号票后失效；run 端点透传 UI signal：切标签页会误杀 run；自定义 token/权限：out-of-scope 且重复造轮子 |
| 事件发布语义 | 四事件统一 emit + 双层隔离（发布端 try/catch 记内部日志、不影响主流程；listener 纪律条款如实声明宿主无 per-listener 隔离）；发布前全新 JSON 安全载荷、发布后不可变；64 KiB 按最终 JSON UTF-8 字节计量 + tail 按 code point 减半兜底；顺序只承诺注册序 + 插件生命周期序，run-settled/action-settled/changed 在持久写入与内存更新后发布（回读一致性）；无重放、view() 为事实源；不进 inspect、不自动到 renderer（**2026-11-08 拍板**） | parallel 分发：等全部 listener 结算会阻塞 run 管线，失败聚合与发出即忘矛盾；per-listener 包裹：发布端做不到，宿主 emit 内部分发；字符数计量：转义与多字节差异大、口径不确定；运行时深冻结：实现细节且不必要 |
| 脚本进程与输出 | 适配层只传 `script.env`（宿主自动继承脱敏环境）、stdin `text→data` 映射、cwd 预检；失败分类以插件自置 `cancelReason` 标志位为据（预取消 → canceled，其余同步/异步失败 → spawn_failed 保留 cause）；裸 `.cmd`/`.bat` 不拦截不承诺；正常 done 后有界等待 `waitForExit()` 2000ms 再 terminate 清后代（进程树生命周期以 run 为上限，warnings 记 descendants-terminated）；`maxSpillBytes` 默认 8 MiB/流、0 禁用；tail 取解码后末 2048 code point、`truncated` 判定即 `lossy`；spill 按流拆 `stdoutSpillPath?`/`stderrSpillPath?`，裁剪/级联删除时 best-effort unlink（**2026-11-08 拍板**） | 重传继承环境：敏感值以显式覆盖身份重新注入；猜 done rejection 内容分类：取消被误记 spawn_failed；拦截 .cmd/.bat：PATH 解析特判复杂易错；忽略存活后代：留僵尸到宿主退出；无界等待：后台脚本挂死 run；spill 单字段：装不下两条流；启动扫描 temp：与裁剪最终一致语义重复 |
| 排队与取消 | 单飞屏障（同编排至多 1 个脚本在跑，任何 run 等上一个结算；手动不被 overlap:skip 淘汰）；单飞队列溢出新者 skip（`overlap`）、全局溢出丢最旧（`concurrency`，不豁免手动——被丢返回 skipped 可见非静默）；两写统一（skipped 也建完整记录，唯一无记录 = 宿主 `ABORTED_BEFORE_DISPATCH`）；取消矩阵（queued 直接 canceled、running terminate、judging 不响应、dispatching 停止派发+已执行动作保留、终态优先于动作汇总）；first-write-wins 终态唯一；delete = 取消→结算 canceled→照发 run-settled→同批删、不另发事件；exec.signal 贯穿：abort 转 run 取消请求、结算持久化后工具 Promise 才以 ABORTED 静止、wait:false 同样被取消（**2026-11-08 拍板**） | 单飞队列也丢最旧：旧触发已过时，与错过合并哲学相悖；豁免手动于全局丢弃：特例分支且会挤掉调度语义，明确 skipped 结果更诚实；judging 可取消：为毫秒级计算引入取消点不值；删除补发事件：与无重放、view() 事实源矛盾；abort 只停等待：run 变成没人要的孤儿，违背「终止的是 run 不是等待」 |
| 会话投递 | 首条消息为结构完整 UserMessage，`source.kind` 用 `'user'` + banner 区分；成功 = 创建 + `followup` 接受 + `flush` 未拒绝；`delivery_failed`（followup 抛错或 flush 拒绝）保留会话并记 `sessionId`、失败 ephemeral 不启动回收计时；title 缺省 `${编排标题} · ${runId 尾 4 位}`、rename 失败仅 warnings；不做 Workspace attach；每执行新建会话；回收竞态与重启不重新认领如实声明（**2026-11-08 拍板，[21 号票](../../.scratch/script-orchestrator/issues/21-session-delivery-lifecycle.md)；2026-11-09 [23 号实验](../../.scratch/script-orchestrator/issues/23-session-integration-prototype.md) 修订：内联构造定案、`whenIdle` 挂 agent、**`flush===true` 不证明消息已落日志**（死路由场景日志仅 header，消息要等 step 内路由就绪后 append）**） | 自定义 source.kind：lastPromptAt/api-session/activity 只认 user，会话在列表显示为无活动且需扩展宿主类型面；followup 即算成功：未等待 flush，可能漏掉 flush 拒绝对应的 delivery_failed；失败 ephemeral 照常回收：失败现场秒消失；追加已有会话：打扰用户正在使用的会话 |
| 打包与安装 | 单包双面（Host 实现 + client + bundle 声明）；`engines.dsh` 精确锁当前验证过的宿主（v0.1t 起为 `0.2.2-rc.3`，此前 `0.2.2-rc.1`）；依赖最小集（dsh-util-time `>=0.2.2-rc.1` + `@deepseek-ai/schemastery` 自装用于同步 Config；`validateJsonSchemaValue` 从 `@deepseek-ai/dsh-tools` 公开根导入并列 peer，版本随精确锁）+ 其余 peer 仅实际 import 时列 + 不为常量 import dsh-agent 内部；交付物 = 预构建 JS（简化档零构建）；file: 验收 / link: 开发，隔离 DSH_HOME + 无头 dsh web 验证；坏 client 包 = 启动级故障写部署须知；`private` + `@echo/` 不上 npm（**2026-11-08 拍板，[确定插件打包依赖与安装方案](../../.scratch/script-orchestrator/issues/22-package-installation.md)；2026-11-09 依既有研究修正依赖归属误引；2026-11-14 精确锁随运行中的 DSH `0.2.2-rc.3` 前移**，全文见 [12-packaging](12-packaging.md)） | 拆多包：v0.1 无独立分发需求，徒增发布面；engines 写范围：承诺未验证兼容性；构建方式进契约：束缚简化档，需要 JSX 时再攻 tsdown；直接改真实 profile：违背隔离验证纪律 |
| 实现期契约补充（v0.1r） | 实施票 24–36 落地时以实测收敛的五处补充：① Web 面板新增排障读面端点 `spill`（读 run 完整溢写输出；最小形状校验；溢写缺失/文件不存在 → `script_storage_unavailable` + `cause`，见 [11-web-panel](11-web-panel.md) / [09-states-errors](09-states-errors.md)）；② 存储记录 schema 必须用 `zod`（`dsh-storage-domain` 的 `domainTable` 约定 `valueSchema.parse`；schemastery 无 `.parse` 会把全部记录误判坏记录并 backup-and-skip），依赖表已补（见 [12-packaging](12-packaging.md)）；③ `connection.rpc.handle` 在 0.2.2-rc.1 对第三方插件不可用（Cordis trace 把 `owner.webServer` 锚定到 client-connection 自身 fiber，实测必抛 `cannot get property "webServer" without inject`）——桥以内联等价挂载（`webServer.register` prefix 路由 + `connection.admit` + 与 `rpcFetchHandler` 对齐的 envelope），浏览器侧契约面零改动；④ 实现口径声明：保留裁剪在 run 结算的同一服务 FIFO 槽内执行（runner 拥有两写），启动维护三步（interrupted / 孤儿清理 / 保留对账）与 I/O 未知恢复（关闭-重开-对账，恢复期间 `script_storage_unavailable`）由存储门面统一执行（见 [08-storage](08-storage.md)）；⑤ Windows Job「父退出留存活后代」场景实测 `done`/`waitForExit` 悬挂直至 `terminate`（票 26 Comments），契约 03 的「done 结算后有界等待 2000ms」顺序在该场景不可达；实现以超时兜底适配（`timedOut=true`、`exitCode=1`、不伪造父进程退出码），进程树以 run 为上限的安全意图保持（后代实测被清理）；不扩展为 macOS 结论 | 改契约却不回写文档：实现与文档漂移；把 `rpc.handle` 宿主缺陷当契约：浏览器面被不可用 API 卡死；用 schemastery 做记录 schema：`.parse` 缺失导致全量记录被误删；新增端点走别名字段：破坏零翻译 DTO 原则 |

## 待验证项（实现前必须回答）

| # | 问题 | 影响 | 失败时的退路 |
|---|---|---|---|
| 1 | ~~工作区插件能否 `import '@deepseek-ai/dsh-util-time'`~~ **已验证（2026-11-07）：可复用** | v0.1 cron 使用 `Cron.parse`（npm `0.2.2-rc.1`，与宿主内置版同构）；RRULE 的验证结论保留给后续版本，不进入首版实现。插件以自身 package.json 依赖安装，Node 标准 ESM 解析即可 import。注意事项：① 早期 npm 版（0.1.x）只有时区校验，必须锁 `>=0.2.2-rc.1`；② 库接受的超集比契约宽，五位字段白名单由插件层校验，合法 cron 的分钟粒度保证 60 秒下限；③ `next()` 返回 ISO 字符串（`.000Z`），`resolve(scheduledAt: string, acceptedAt: number)` 的错过合并语义与契约一致 | 无需退路 |
| 2 | ~~新会话 id 如何铸造（`schedule` 的预留 id 实现）~~ **已验证（2026-11-08，[会话动作研究](../../.scratch/script-orchestrator/issues/01-research-session-actions.md) + [重新界定 session 动作模式](../../.scratch/script-orchestrator/issues/20-session-modes.md)）：直接铸 `session-${randomUUID()}` 只走 Agent 创建通道；`ctx.sessions.create()` 会先注册一个 live Session，同 id 再 `agents.create()` 必然重复，原退路不可实现** | `session` 动作能否稳定创建会话 | 无需退路 |
| 3 | ~~`agent.followup` 的 `source.kind` 是否接受自定义插件名~~ **已验证（2026-11-08，[会话动作研究](../../.scratch/script-orchestrator/issues/01-research-session-actions.md) + [会话投递契约](../../.scratch/script-orchestrator/issues/21-session-delivery-lifecycle.md)）：运行时接受任意非空字符串（`schedule` 用 `'schedule'`），但 `lastPromptAt`/api-session/activity 只认 `kind === 'user'`——采用 `{ kind: 'user' }` + banner 区分，退路转正** | 首条消息的来源标记 | 无需退路 |
| 4 | ~~自定义事件是否会被会话日志或 `Event` inspect 目录收录~~ **已结案（2026-11-09，声明性）：[核实事件与插件服务机制](../../.scratch/script-orchestrator/issues/02-research-events-services.md) 已证「不收录」——Event/Service inspect 为构建期静态目录、普通 emit 不进会话日志/持久化/遥测；[06-events-service](06-events-service.md) 可见性边界已如实声明，无需运行时注册** | 订阅方可发现性 | 无需退路（已按声明落地） |
| 5 | ~~`terminate()` 在 Windows 上的实际信号与退出码~~ **已验证（2026-11-08，[验证 Windows 终止与输出溢写](../../.scratch/script-orchestrator/issues/19-windows-subprocess-prototype.md) W1）：本机选中原生 Windows Job（无回退警告），`done` 为 `{exitCode: 1, signal: null}`，`waitForExit() === true`；`signal` 恒 `null` 是确定事实而非退路** | 超时判定里 `signal` 字段的取值 | 无需退路 |
| 6 | ~~从工作区包 `import` 已安装插件包（如 `dsh-agent` 的常量）是否可行~~ **已验证（2026-11-09，[最小宿主集成实验](../../.scratch/script-orchestrator/issues/23-session-integration-prototype.md) E1）：`import '@deepseek-ai/dsh-llm'` 不可行（未声明依赖时 `Cannot find package`）；内联构造 `{id, role:'user', content, source}` 被 followup+flush 接受——内联为定案** | 是否需要内联常量 | 内联构造（已实证） |
| 7 | ~~工作区/第三方插件的 client UI 如何被发现、构建并注入 Web GUI~~ **已验证（2026-11-08，[验证最小 Web 客户端构建与注入](../../.scratch/script-orchestrator/issues/16-web-build-prototype.md)）：包声明 → Loader 条目 → `__DSH_BOOT__` graph → slot 挂载闭环在隔离沙箱端到端实证；交付形态定为单包双面 + 简化档（见 [12-packaging](12-packaging.md)）** | 首版 Web 面板的可行形态 | 无需退路 |

## v0.1u · 自然语言配置与双编辑入口（2026-11-15）

用户确认：新建/会话修改只预填不自动发送；内置 SKILL 驱动自然语言→缺漏澄清（每题 1～3 选项 + 推荐）→简洁目标确认→实施；默认建议暂停创建；手动修改采用常用字段表单 + 高级 JSON，保存预览后确认，使用既有 CAS 防覆盖。

- 取代 v0.1o「面板不提供独立配置表单」决定，仅新增编辑表单，不扩展手动新建。完整可视化规则编辑器维护成本过高；仅 JSON 则不利于常用字段操作，均不采用。
- SKILL 由 Host `skills.register` 正式注册，依赖 `skills` 服务、随包分发独立文本；不用仅放文件等待自动发现，也不把完整流程重复塞入 client prompt。
- 创建/编辑/执行服务语义与存储域版本保持不变。确认流程是 SKILL 的行为约束，不新增后端审批或权限体系；保存/创建不隐含试运行授权。
- 冲突后保留手动草稿；会话需回读重新确认，禁止盲覆盖。暂不改变 view 的敏感字段返回契约，明确告知会话上下文可读配置、不回显密钥不等于脱敏。
- 本次验收通过后用户授权更新当前 profile；使用插件管理工具安装，若需中断/重启另行告知。不启动替代 Web 服务。

## v0.1v · 列表与详情分栏（2026-11-15）

- 按用户要求取代 v0.1o 的居中详情模态：未选中时列表占满内容区，点击编排后左侧保留列表，右侧展示单条详情与执行记录；点击其他编排直接切换，当前行有选中态。关闭详情恢复完整列表，不影响已受理的脚本执行。
- 详情不是模态，不遮挡或锁定列表；加载和失败时也提供关闭入口。标题使用原生按钮支持键盘操作；窄容器改为上下排列，避免强制压缩表格与详情。颜色沿用 DSH 主题 token。
- 手动编辑、删除确认和完整输出仍为独立模态；切换/关闭详情不绕过编辑草稿丢弃确认。管理 RPC、刷新策略和存储版本不变。

## v0.1w · 管理操作集中到详情（2026-11-15）

- 按用户要求移除列表「操作」列，列表仅呈现状态、标题、触发、下次；暂停/恢复、执行、删除移入已加载的详情操作区。
- 状态对应的可用操作、删除二次确认、错误反馈及写后 list/view 回读保持不变；切换详情时操作只针对当前显示的编排。

## v0.1x · 执行记录展示优化（2026-11-15）

- 按用户要求优化详情页执行记录：默认只展示最近 3 条，「展开全部」查看完整列表；单条卡片面向人类阅读直观化。
- 取数口径定为详情打开即 `view { id, runs: 50 }`：计数（执行记录（N））与轮询一致、展开零等待；放弃「折叠取 5、展开再取 50」的两档方案，因为折叠态计数会在展开后跳变、且展开依赖一次额外回读。本地面板 50 条载荷可控。
- run 卡片直观化只改呈现不改字段语义：状态彩色徽章沿用编排 Chip 的主题 token；相对时间为主（绝对时刻放 title，排障仍可核对）；runId 缩写为尾 4 位（完整 id 在 title，spill 入口在卡片内）；stderr 尾部与 stdout 并列直展，不再只能进 spill 模态看。
- 50 条为服务 `view` 单次上限，达到上限时面板如实标注，不伪造「全部」。
- 管理操作、刷新策略、存储域版本均不变；无字段语义变化，不升域版本。

## v0.1y · 结果上报规范、完成后行为展示与 SKILL 固定规则（2026-11-16）

用户需求三条：编排详情更清晰展示脚本完成后的行动；定义脚本/会话侧执行结果上报规范并在执行记录优先展示；创建编排时脚本固定放规范目录、固定创建后先暂停（均不询问）。关键决定与被否方案：

- **标记行而非退出码编码/结果文件/stdout 全量 JSON**：`##SCRIPT-RESULT## <JSON>` 单行前缀 + 人读字段（summary/level/fields）。退出码编码表达力为零；结果文件要引入路径约定与清理责任；stdout 整体要求 JSON 破坏脚本的正常日志输出。解析源定在内存收集文本（与 `stdoutTail` 同源），溢写丢失如实声明为「未上报」，不为标记行增加 spill 读——排障读面已有全量。
- **`script_report` 独立工具而非复用 `report()`**：`ActionContext.report()` 是动作执行期的内存进展通道（warnings，随结算快照冻结）；会话上报发生在 run 结算之后、生命周期独立、要持久化。复用会把「排障进展」与「执行结果」两种语义混进一个数组，且 report() 无法触达已落盘记录。
- **run 结算后允许第三类写（结果上报写）**：违反「只写两次」的原教旨，但替代方案更差——reports 挂到编排记录会失去 run 级归置、另开表引入跨表一致性、只在内存则刷新即丢。约束收窄为：仅 merge `result` 字段、FIFO 全序、上限 10 条、不改 `settledAt`/`status`。存储域 additive 可选字段，不升版本。
- **`changed` 扩义到执行记录写入**：面板与订阅方的消费模式本就是「提示 → view() 回读」，扩义是纯加法；为 reports 另设事件名（如 `run-reported`）会多一个只被同一批消费者订阅的事件。`run-settled` 载荷只带结算时刻的脚本侧结果（summary/level/fields），reports 不进事件——事件是失效提示不是事实源。
- **面板两处展示**：详情新增「脚本完成后」区（判定规则与动作的人话描述，任务 1）；run 卡 result 块优先于原始输出（任务 2 后半）。结果上报到达后无推送，靠手动刷新/下次回读——如实声明，不为此引入实时通道。
- **SKILL 固定规则（任务 3）**：脚本文件固定写 `~/scripts/<编排id>.<扩展名>`（目录不存在则创建，不询问路径；用户主动指定遵从）；创建一律 `enabled: false` 不询问（取代 v0.1u「默认建议暂停」的商量式措辞），创建后告知暂停态与启用方式；用户需求中已明确要求启用时创建后立即 resume 并说明。脚本目录取用户主目录而非工作区：编排脚本是机器级资产（跨会话、跨工作区存活），与两个既有脚本（`~/scripts/`）一致。
- 存量兼容：旧 run 无 `result` 字段照常打开（可选字段）；旧脚本不输出标记行零影响；两个实际脚本与 archive-inbox 编排 prompt 随本轮修订（spec D3）。

## 契约变更流程

1. 先改本文档或对应契约文档，并在 `README.md` 的变更记录里加一行。
2. 破坏性变更（改字段语义、改名、删状态）必须升域版本并给出兼容策略。
3. 实现与文档冲突时，以文档为准；文档本身错了就改文档，别让代码「跑通了就算对」。
