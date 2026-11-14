# 脚本编排 · Script Orchestrator — 契约文档

> 状态：**设计定稿（v0.1），尚未实现**。本文档集定义插件的对外契约；实现以契约为准，实现前不得改契约，改动走 `10-decisions.md` 的记录流程。

## 一句话定位

按时间触发一段脚本，按执行结果判定，然后分发：通知其他插件、唤醒新的 AI 会话继续处理。

## 文档索引

| 文档 | 内容 | 读者 |
|---|---|---|
| [01-domain-model.md](01-domain-model.md) | 概念、编排与执行记录的字段、示例、命名与版本约定 | 所有人 |
| [02-triggers.md](02-triggers.md) | `every` 双模式与 cron 子集、时区与 DST、暂停恢复与错过触发 | 配置编排的人 |
| [03-execution.md](03-execution.md) | 脚本执行契约：argv、环境、超时、输出截断、并发、重启语义 | 配置编排的人、实现者 |
| [04-judge.md](04-judge.md) | 判定 DSL：谓词、组合、优先级、模板变量 | 配置编排的人 |
| [05-actions.md](05-actions.md) | 三类动作、两种会话模式、失败隔离 | 配置编排的人 |
| [06-events-service.md](06-events-service.md) | 事件名与载荷、`ctx.scriptOrchestrator` 服务、`registerAction` | 其他插件作者 |
| [07-tools.md](07-tools.md) | `script_*` 工具的参数、返回与错误码 | 模型侧、工具实现者 |
| [08-storage.md](08-storage.md) | 存储域、表结构、保留与裁剪、升级策略 | 实现者 |
| [09-states-errors.md](09-states-errors.md) | 编排与执行的状态机、错误码总表 | 实现者、排障 |
| [10-decisions.md](10-decisions.md) | 命名与关键决策记录、被否方案、待验证项 | 维护者 |
| [11-web-panel.md](11-web-panel.md) | Web 面板的 Connection RPC 桥接、刷新策略与可观察语义 | 实现者、面板开发者 |
| [12-packaging.md](12-packaging.md) | 包形状、依赖纪律、安装形态与验收清单 | 安装者、实现者 |

## 术语

| 术语 | 含义 |
|---|---|
| 编排 / orchestration | 一条被管理的配置：触发 + 脚本 + 判定 + 动作 |
| 执行 / run | 编排被触发一次所产生的记录，含脚本结果与动作结果 |
| 触发 / trigger | 决定何时开始一次执行的规则 |
| 判定 / judge | 根据脚本结果选出动作键的规则集 |
| 动作 / action | 判定命中后执行的一个具体行为：`event` / `plugin` / `session` |
| 动作键 / action key | 编排内 `actions` 映射的键，局部于单条编排，判定用它引用动作 |
| 注册动作名 / registered action name | 其他插件经 `registerAction` 注册进全局动作注册表的名字，形如 `<namespace>.<verb>`，`plugin` 动作用它引用 |
| 事件短名 / event short name | `event` 动作发出的事件在 `script-orchestrator/` 前缀之后的短名，如 `deploy-ok` |
| 单飞 / single-flight | 同一编排的两次执行不重叠的策略 |
| 固定计划相位 / fixed-rate | `every` 的模式：下一次由上一次计划时刻加间隔，执行耗时不改变计划相位 |
| 固定完成间隔 / fixed-delay | `every` 的模式：下一次由上一次自动 run 的结算时刻加间隔 |

## 架构

```
                    ┌──────────────────────────────────────────┐
   定时/手动 ────────▶│ 调度器 trigger  单 timer，按最近到期时间  │
                    └───────────────┬──────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │ 执行器 runner  子进程 + 超时 + 输出收集    │
                    └───────────────┬──────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │ 判定 judge  规则匹配 → 动作键列表          │
                    └───────────────┬──────────────────────────┘
                                    ▼
     ┌──────────────┬───────────────┴───────────────┬──────────────────┐
     ▼              ▼                               ▼                  ▼
  event 动作     plugin 动作                    session 动作        运行记录
  发 Cordis 事件  调已注册的具名动作            新建会话 + 首条消息   存入 runs 表
```

## 明确不做（非目标）

- 不做 webhook 出站（已拍板排除）。
- 不做编排之间的串联（A 成功后再触发 B），留给 v2。
- v0.1 不含 RRULE、`at`、`after`；每日/每周只作为 Web 面板预设生成 cron。
- Web 管理面板纳入 v0.1；注册动作管理、指标图表、权限管理和独立通知中心不在首版面板范围。
- 不替代 `@deepseek-ai/dsh-schedule`：它管「按时投递 prompt」，本插件管「脚本驱动的编排」。
- 不做脚本沙箱：脚本以插件进程权限运行，安全边界只有配置白名单。

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-11-07 | 初版契约：触发含 cron/rrule，会话动作含 root/child，通知为事件 + 注册式动作 |
| v0.1a | 2026-11-07 | 待验证项 #1 结案：`dsh-util-time@0.2.2-rc.1` 可复用，cron/rrule 不再自研（见 10-decisions.md） |
| v0.1b | 2026-11-07 | 拍板：存储维持宿主 JSON 存储域，否决 SQLite（Web 面板经服务 RPC 取数，后端对面板透明）；新增待验证项 #7（工作区插件的 client UI 注入机制） |
| v0.1c | 2026-11-07 | 触发器收敛为 `every`（新增 fixed-rate/fixed-delay 双模式）与 cron；每日/每周改为 Web 面板预设，RRULE/at/after 延后；明确创建、编辑、暂停恢复、重启与无解规则；Web 管理面板纳入首版。以上均为未实现、无存量记录前的契约调整，首个实现的存储域仍从版本 1 起步 |
| v0.1d | 2026-11-07 | 动作命名三分各立规则：动作键与事件短名维持无点 kebab；注册动作名必须 `<namespace>.<verb>` 单点两段并保留 `script-orchestrator.` 前缀；明确创建/更新静态校验边界、逐动作执行前查表的 `unknown_action`、`registerAction` 仅调用方 `ctx.effect` 所有权、disposer 四不变量与 dispose 不中止在途动作。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1e | 2026-11-07 | 统一管理契约：服务 `edit` 对齐 `update/pause/resume/delete` 四 action（pause/resume 幂等状态设置语义），乐观并发全 action 生效，delete 取消在途 run 后同批级联；`list` 统一 `{items,total,nextOffset}`；新增 `listActions()`，`availableActions` 带 description；工具适配层定为原始注册 + 严格 JSON Schema 全映射 `script_input_invalid`、单块 JSON render 与 oneOf output schema；`script_run` 对 paused/ended 放行，`wait: true` 超限返回非终态 RunView 不报错。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1f | 2026-11-08 | 判定与模板去歧义：`matchedRule` 定零下标；stdout/stderr 谓词各增 `truncated`，run 级维持单布尔并新增 `{{truncated}}` 变量；`run.actions[]` 增 `warnings?: string[]`（模板警告与 `report()` 同数组、保最近 20 条）；`json:` 失败与未知变量对称处理；payload 改为递归渲染字符串值（恒合法 JSON），`template_invalid` 仅剩 prompt 空；渲染定于动作执行前、不计入 `timeoutSeconds`。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1g | 2026-11-08 | 存储契约按宿主真实能力重写：域名改 `script_orchestrator`，布局改 `per-record`（schema 坏记录备份跳过，畸形文档静默缺席如实声明）；确立单 Host 写者前提、服务层 FIFO 与关闭顺序；级联删除与保留裁剪定为可恢复最终一致（启动孤儿清理、结算后裁剪、未结算不淘汰、settledAt/runId 定序）；版本惰性写回；写入前 parse 与键=id 校验；I/O 结果未知走关闭-重开-对账；错误码统一 `script_storage_unavailable`。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1h | 2026-11-08 | 新增 11-web-panel 通信契约：独立 Connection channel `/script-orchestrator` 一元 RPC（list/view/create/edit/run/listActions，零翻译 DTO），认证与 fence 复用内建；abort 只终止等待不取消操作，run 端点受理即返回；刷新定为写后回读 + connection/reset 回读 + 活动轮询（可见且有非终态 run 时每 5 秒）；如实声明无实时事件推送与 Desktop 重启边界。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1i | 2026-11-08 | 事件发布契约定案：emit + 双层失败隔离（发布端兜底记日志不影响主流程、listener 同步不抛异步自捕纪律）；发布前全新 JSON 安全载荷、发布后不可变；64 KiB 按最终 JSON UTF-8 字节计量，超限 tail 按 code point 减半兜底；顺序承诺收敛为注册序 + 插件生命周期序，run-settled/action-settled/changed 在持久写入与内存更新后发布保证回读一致；无重放、view() 事实源、不进 inspect、不自动到 renderer。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1j | 2026-11-08 | 脚本进程与输出契约定案：适配层只传 `script.env`（宿主自动继承脱敏环境）、stdin `text→data` 映射；失败分类以插件自置 `cancelReason` 为据（预取消 → canceled，其余同步/异步失败 → `spawn_failed` 保留 cause）；裸 `.cmd`/`.bat` 不拦截不承诺；正常退出后有界等待 `waitForExit()` 2000ms 再 terminate 清后代（进程树生命周期以 run 为上限，`run.script.warnings` 记 `descendants-terminated`）；`maxSpillBytes` 默认 8 MiB/流、0 禁用；tail 取解码后末 2048 code point（U+FFFD 保留），`truncated` 判定即 `lossy`（溢写存在不改变）；spill 按流拆 `stdoutSpillPath?`/`stderrSpillPath?`，裁剪/级联删除时 best-effort unlink；signal 仅 provider 观测、macOS 未实机验证（验收矩阵仅 Windows）。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1k | 2026-11-08 | 执行排队与取消契约定案：单飞屏障（同编排至多 1 个脚本在跑，任何 run 等上一个结算；手动共用排队体系但不被 overlap:skip 淘汰）；单飞队列溢出新者 skip（`overlap`）、全局溢出丢最旧（`concurrency`，不豁免手动，skipped 可见非静默）；两写统一（skipped 也建完整记录，唯一无记录 = `ABORTED_BEFORE_DISPATCH`）；取消矩阵（queued 直接 canceled、running terminate、judging 不响应、dispatching 停止派发且已执行动作保留，终态优先于动作汇总）；first-write-wins 终态唯一；delete 取消→结算 canceled→照发 run-settled→同批删、不另发事件；exec.signal 贯穿为 run 取消请求，结算持久化后工具 Promise 才以 ABORTED 静止，wait:false 同样被取消。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1l | 2026-11-08 | 会话模式重新定案：`mode: 'persistent' \| 'ephemeral'`（默认 persistent）取代 root/child，两模式均为宿主语义 root、正常出现在主列表；`persistent` 插件运行期间不主动回收（停用/卸载走宿主 owner-fiber teardown，冷会话保留）；`ephemeral` 在 `whenIdle()` 收敛（含用户接管期间的对话）+ `idleDisposeSeconds`（默认 0，persistent 拒绝该字段）后 dispose，teardown 不删持久化日志与 Workspace 关系；创建路径 persistent 优先 `sessionController.create()`、ephemeral 必须 `agents.create()` 自持 handle；真正 child 移非目标（复活条件＝触发链路能供 exact live parent）；`delete` 编排不触碰已创建会话；待验证 #2 结案（id 直接铸 `session-${randomUUID()}` 只走 Agent 通道）。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1m | 2026-11-08 | 会话投递契约定案：首条消息为结构完整 UserMessage，`source.kind` 用 `'user'` + banner 区分（宿主 lastPromptAt/api-session/activity 只认 user；待验证 #3 结案，退路转正）；成功 = 创建 + followup 接受 + `flush()` durable 确认，`delivery_failed`（followup 抛错或 flush 拒绝）保留会话（`run.actions[]` 增 `sessionId?`，成功与失败均记）且失败 ephemeral 不启动回收计时；title 缺省 `${编排标题} · ${runId 尾 4 位}`、rename 失败仅 warnings；不做 Workspace attach；每执行新建会话（追加/复用为非目标）；回收竞态（durable inbox 不丢）与插件重启不重新认领如实声明；UserMessage 构造依赖 `createUserMessage`，import 不可行时内联等价（#6 待验证，入票 23 实验）。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1n | 2026-11-08 | 新增 12-packaging 交付契约：单包双面（exports `. + ./client + ./package.json`）、`dsh.bundle.patch` 自插入 + `dsh.client.platform`、`engines.dsh` 精确锁 `0.2.2-rc.1`；依赖最小集（dsh-util-time `>=0.2.2-rc.1` + 校验库，归属交叉引用原误指面板原型，后由 v0.1q 纠错）+ peer 仅实际 import 时列 + 禁止 dsh-agent 常量依赖；file: 验收 / link: 开发分工与切换边界；隔离 profile 安装 + HMR/重启/卸载验收清单 + 「坏 client 包 = 启动级故障」部署须知；`private` + `@local/` scope 分发边界。待验证 #7 结案（16 号原型已实证注入闭环）。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1o | 2026-11-09 | Web 面板 UX 定案（12 号原型）：列表采用高密度表格（变体 C）、详情与 run 历史用**居中模态**；**创建/编辑主入口改为对话式**——点新建/编辑经 `uiWorkspace.startSession` 开新会话注入引导 prompt，由模型经 `script_create`/`script_edit` 完成配置（与内置「自动化任务」同先例）；面板只承载管理与排障，首版不做独立配置表单（`create`/`edit` RPC 保留）；macOS 风险提示不进面板。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1p | 2026-11-09 | 会话集成实验定案（23 号原型）：UserMessage **内联构造定案**（import `@deepseek-ai/dsh-llm` 不可行，内联被 followup+flush 接受，待验证 #6 结案）；两条创建路径（persistent 经 sessionController、ephemeral 经 agents.create + currentSelection + preset mount）全链实证；`whenIdle` 挂 agent 不挂 handle；对已 dispose 会话再投递实证抛错（delivery_failed 路径）；**`flush() === true` 收窄为「投递管线接受」——不证明消息已落日志**（死路由场景会话日志仅 header，消息要等 step 内路由就绪后 append，如实声明）。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1q | 2026-11-09 | 实施 spec 复审同步事实源纠错：打包依赖归属不再误指 Web 面板 UX 原型——`@deepseek-ai/schemastery` 自装用于同步 Config，`validateJsonSchemaValue` 从 `@deepseek-ai/dsh-tools` 公开根导入并列 peer；依据为既有插件运行机制研究。同轮将「会话投递」被否理由中 flush 的 durable 旧口径改为「不等待 flush 会漏掉 delivery_failed」，与 v0.1p 对齐。仅修正陈旧表述，不改变既定契约语义。仍未实现、无存量记录，存储域从版本 1 起步 |
| v0.1r | 2026-11-09 | 实现期契约补充（票 24–36 落地与验收后回写）：① [11-web-panel](11-web-panel.md) 新增排障读面端点 `spill`（读 run 完整溢写输出；最小形状校验；溢写缺失/文件不存在 → `script_storage_unavailable` + `cause`），并如实记录 `connection.rpc.handle` 在 0.2.2-rc.1 对第三方插件不可用（Cordis trace 把 `owner.webServer` 锚定到 client-connection 自身 fiber）→ 桥以内联等价挂载（`webServer.register` prefix 路由 + `connection.admit` + 与 `rpcFetchHandler` 对齐的 envelope），浏览器侧契约面零改动；② [12-packaging](12-packaging.md) 依赖最小集补 `zod 4.4.3`——`dsh-storage-domain` 的 `domainTable` 约定 `valueSchema.parse` 为 zod API（schemastery 仅用于同步 Config，无 `.parse`）；③ [09-states-errors](09-states-errors.md) 的 `script_storage_unavailable` 扩展覆盖溢写读取失败（`cause` 区分）；④ [08-storage](08-storage.md) 的启动维护三步与 I/O 未知恢复按实现口径落实（裁剪在 run 结算的同一 FIFO 槽内、恢复期间管理操作明确失败）。决策记录见 [10-decisions](10-decisions.md)「实现期契约补充（v0.1r）」；实现与验收证据见 `.scratch/script-orchestrator/issues/24`–`36` 与 [spec](../script-orchestrator/spec.md) |
| v0.1s | 2026-11-10 | 包名改定为 `@echo/dsh-script-orchestrator`（由 `@local/` 换到本机自有 scope，仍 `private` + `file:` 本地安装、不上 npm）：同步 `pkg/package.json`、`pkg/cordis.patch.yml`、client bundle id、安装/验收脚本与 [12-packaging](12-packaging.md)，并重装本机 desktop profile。仅打包标识变化，不改变契约语义、存储域名与域版本（存储域仍从版本 1 起步） |
| v0.1t | 2026-11-14 | `engines.dsh` 精确锁由 `0.2.2-rc.1` 前移到运行中的 DSH `0.2.2-rc.3`（peer/dev 的 `dsh-storage-domain`、`dsh-tools`、`dsh-subprocess-local` 同步）。已核对安装包 `docs/upgrade-guide`：`v0.2.2-rc.1` 之后没有 `v0.2.2-rc.2`/`v0.2.2-rc.3` 目录，`v0.2.2-rc.1` 一节不触及本插件消费的公开面（`defineDomain`/`domainTable`、`validateJsonSchemaValue`、`Cron`、`webServer.register` prefix、`connection.admit`、`sessionController`/`agents`/`tools`）。不改契约语义、存储域名与域版本。`dsh-util-time` 仍锁 `>=0.2.2-rc.1`（防 0.1.x） |
