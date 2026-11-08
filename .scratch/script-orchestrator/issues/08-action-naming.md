# 统一动作命名与注册契约

Type: grilling
Status: resolved
Labels: wayfinder:grilling

## Question

编排内的具名 action key、`plugin` 动作注册名和 `event` 动作短名是否应采用不同规则？当前契约要求 `^[a-z][a-z0-9-]{0,63}$`，却又推荐并示例 `ops.oncall`，两者冲突。需要确定点号命名空间是否合法、各类名字的最大长度与保留名、静态引用校验及运行时 `unknown_action` 行为，并统一术语和全部示例。

还需确定 `registerAction` 的所有权与注销语义：是否只由调用方 `ctx.effect` 持有，原始 disposer 如何做到幂等、同步和按 token 精确删除，服务替换如何避免误删新实例；dispose 后在途 action.run 是继续、等待还是通过 signal 请求取消，未来执行何时重新查表并得到 `unknown_action`。宿主事实见 [核实事件与插件服务机制](02-research-events-services.md)。

## Comments

- 2026-11-07：用户接受 Q1，三类名字确立为独立概念：动作键（action key）、注册动作名（registered action name）、事件短名（event short name），各立规则并进 README 术语表。
- 2026-11-07：用户接受 Q2，动作键与事件短名维持 `^[a-z][a-z0-9-]{0,63}$` 无点；事件短名保留名沿用 4 个不新增；动作键无保留名。
- 2026-11-07：用户接受 Q3，注册动作名必须恰好一个点 `<namespace>.<verb>`，每段 `^[a-z][a-z0-9-]{0,29}$`；`namespace` 建议与注册方插件 id 一致但不校验。
- 2026-11-07：用户接受 Q4，注册动作名仅保留 `script-orchestrator.` 前缀，注册即抛错，其余不保留。
- 2026-11-07：用户接受 Q5，create/edit 静态校验：动作键引用必须存在；`plugin.action` 只校验格式；`event.name` 校验格式与保留名。
- 2026-11-07：用户接受 Q6，`unknown_action` 逐动作执行前实时查表、任何环节不缓存；`availableActions` 仅为展示快照。
- 2026-11-07：用户接受 Q7，`registerAction` 所有权仅调用方 `ctx.effect` 持有，服务端不自动叠加 effect。
- 2026-11-07：用户接受 Q8，重名注册同步抛 `Error`、不进错误码表；同一存活期重复注册抛错；重挂载顺序由 `inject`/`effect` 生命周期保证，无显式 API。
- 2026-11-07：用户接受 Q9，disposer 四不变量（幂等、同步、按 token 精确删除、实例内注册表）写入 06 契约。
- 2026-11-07：用户接受 Q10，dispose 不中止在途动作；在途继续完成并按自身成败正常聚合；`signal` 中止来源仅动作超时与整 run 取消。
- 2026-11-07：Q11 用户确认共识与落盘范围（回复「配置」经追问澄清为确认），按票 07 先例同步契约并关票。

## Answer

用户确认以下完整方案（Q1–Q10 全按推荐，Q11 确认落盘）：

1. **术语三分**：动作键（编排内局部标签）、注册动作名（全局动作注册表的键）、事件短名（拼入 `script-orchestrator/` 前缀）；三者各立规则，不再共用一条正则，README 术语表各加一条。
2. **动作键**：`^[a-z][a-z0-9-]{0,63}$`，无点号，无保留名。
3. **事件短名**：`^[a-z][a-z0-9-]{0,63}$`，无点号；保留名沿用 `run-started`、`run-settled`、`action-settled`、`changed`，不新增。
4. **注册动作名**：必须恰好一个点，`<namespace>.<verb>` 两段，每段 `^[a-z][a-z0-9-]{0,29}$`（整体 ≤ 61）；`namespace` 建议与注册方插件 id 一致，不强制校验；`registerAction` 对不合规名字同步抛错。
5. **保留前缀**：仅 `script-orchestrator.`（防冒名内置能力），注册即抛错；其余一概不保留。
6. **静态校验边界**（create/edit 落库前）：`judge`/`fallback` 引用的动作键必须存在于 `actions`（`script_input_invalid`）；`plugin` 的 `action` 字段只做格式校验，存在性留给运行时；`event` 的 `name` 做格式 + 保留名校验。
7. **`unknown_action` 查表时机**：逐动作执行前实时查表，不缓存跨动作/跨 run/跨编排的解析结果；dispose 后同一 run 内尚未开始的动作也记 `unknown_action`；`availableActions` 仅为展示快照，不在执行路径上。
8. **`registerAction` 所有权**：仅调用方通过 `ctx.effect` 持有 disposer；服务端不在调用者 fiber 上自动叠加 effect；契约明文写出「`registerAction` 自身不绑定清理」。
9. **重名注册**：同步 `throw Error`（消息含冲突名），不进 09 错误码表；同一存活期重复注册同名属调用方 bug，抛错即可；「先 dispose 再注册」的重挂载顺序由 `inject`/`effect` 生命周期自然保证，无显式 API。
10. **disposer 四不变量**（06 契约对外承诺）：幂等；同步摘除；按注册 token 精确删除（同名新注册不被旧 disposer 误删）；注册表为服务实例内部表（服务整体替换时旧实例 disposer 不伤新实例）。
11. **在途动作语义**：dispose 不中止在途 `run()`；在途动作继续执行、受自身 `timeoutSeconds`（≤ 300 秒）约束、按自身成败正常结算计入 run 聚合；`ActionContext.signal` 的中止来源仅两个——动作超时、整个 run 被取消——不新增「dispose」来源；不产生「因摘除而 canceled」的记录。
12. **版本口径**：沿用 [确定 every 与 cron 的调度语义](07-trigger-semantics.md) 第 12 条先例——尚无实现、无存量记录，属实现前契约调整，存储域仍从版本 1 起步；README 变更记录加 v0.1d。

已同步契约：[README](../../../docs/temp/README.md)（术语 3 条 + 变更记录 v0.1d）、[01-domain-model](../../../docs/temp/01-domain-model.md)、[04-judge](../../../docs/temp/04-judge.md)、[05-actions](../../../docs/temp/05-actions.md)、[06-events-service](../../../docs/temp/06-events-service.md)、[07-tools](../../../docs/temp/07-tools.md)（术语统一）、[09-states-errors](../../../docs/temp/09-states-errors.md)、[10-decisions](../../../docs/temp/10-decisions.md)。本决定不毕业雾区、不新建票：在途与查表属实现细节，事件分发异常策略归 [事件发布语义](17-event-publication.md) 等既有票。
