# 06 · 事件与服务（给其他插件作者）

本插件对外的两个接口：**事件**（观察，发出即忘）与 **服务**（调用与注册）。二者职责不同，不要混用。

## 事件

| 事件名 | 何时发出 | 载荷 |
|---|---|---|
| `script-orchestrator/run-started` | run 领取到执行槽、脚本即将启动 | `{ runId, orchestrationId, trigger, scheduledAt, startedAt }` |
| `script-orchestrator/run-settled` | run 进入任一终态（含 `interrupted`） | 见下方 `RunSettled` |
| `script-orchestrator/action-settled` | 单个动作结算 | `{ runId, orchestrationId, name, kind, status, error? }` |
| `script-orchestrator/changed` | 编排或执行记录发生持久变更（编排增删改、暂停恢复；执行记录的结果上报写入，v0.1y） | 无载荷 |

`RunSettled`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `runId` / `orchestrationId` | string | 标识 |
| `status` | 枚举 | 见 [09](09-states-errors.md) |
| `trigger` | 枚举 | 触发来源 |
| `scheduledAt` / `startedAt` / `settledAt` | ISO 时间 | 时间线 |
| `script` | object | `{ exitCode, signal, timedOut, durationMs, truncated, stdoutSpillPath?, stderrSpillPath? }`（脚本阶段 warnings 不进事件） |
| `stdoutTail` / `stderrTail` | string | 各 ≤ 2048 个 code point |
| `matchedRule` | number \| null | 命中下标 |
| `usedFallback` | boolean | 是否走 fallback |
| `actions` | array | `{ name, kind, status }[]`，不含错误细节（细节在 `view` 里） |
| `result` | object \| 缺省 | 结算时刻的脚本侧结果上报 `{ summary, level?, fields? }`（v0.1y）；`reports` 与 `run-settled` 之后追加的更新不进事件，以 `view()` 为准 |

### 分发与异常隔离

- 四个事件统一用宿主 `emit` 分发：同步调用 listener、不等待异步 Promise。
- **发布端兜底**：每次发布包裹异常捕获，listener 同步抛错只记内部日志（含事件名，`event_listener_failed` 字样），绝不影响 run/action 主流程与后续动作；不新增错误码。
- **listener 纪律**（订阅方契约）：同步代码不得抛错、异步必须自行捕获。宿主无 per-listener 隔离——同步抛错的 listener 会中断本轮后续 listener 的调用，这是订阅方自己的责任。

### 载荷纪律

- 发布前构造**全新载荷对象**（不复用 run 记录引用）；构造期保证 JSON 安全：无函数、无 `undefined`、无循环引用。
- 发布后本插件不再修改载荷对象及其中字符串（tail 截短在构造前完成）。

### 64 KiB 计量与兜底截短

- 计量口径：**最终序列化 JSON 的 UTF-8 字节数**。
- 超限兜底：依次对 `stdoutTail`、`stderrTail` **减半保留末尾**（按 Unicode code point 切割，不产生半个代理对），循环直至 ≤ 64 KiB；其余字段不截。现有字段上限下该兜底几乎不会触发，仅为确定性而设。

### 顺序与发布时机

- 同步调用按 listener 注册序（含 `prepend` 前插）；**不承诺**异步完成顺序与跨发布者全局顺序。
- 本插件保证：`run-started` 在开始写入后发布；`action-settled` 按动作执行序；`run-settled` 在全部动作结算后；`changed` 在持久写入完成后。
- **回读一致性**：`run-settled` / `action-settled` / `changed` 一律在对应持久写入与内存视图更新**之后**发布——listener 收到事件立即 `view()` 必能看到已更新状态。

### 无重放与事实源

- 事件**不重放**：订阅前、离线期间、Host 重启前的事件一律不补发。
- 事件仅是**失效提示**（invalidation hint）；持久事实一律以 `view()` 为事实源；标准消费模式＝「收到提示 → `list()` / `view()` 重建」。`changed` 是重新 list/view 的无载荷提示。
- **删除的编排**：被取消的 run 先照常发布 `run-settled(canceled)`（此刻记录仍在、载荷自足），随后同批删除记录；**不为删除另发事件**。订阅者事后 `view()` 查无此 run 属预期（时序见 [03-execution](03-execution.md)「取消与等待」）。

订阅示例：

```js
// 其他插件的 apply 里
ctx.on('script-orchestrator/run-settled', (run) => {
  if (run.status === 'failed') ctx.logger?.warn?.(`脚本编排失败: ${run.orchestrationId}`)
})
```

> 可见性边界：自定义事件名不会出现在 `Event` inspect 目录中（构建期静态生成，非运行时注册），`Service` inspect 同理；普通 emit 不进会话日志、持久化、导出与遥测。TypeScript 消费方需 module augmentation 声明四个事件与 `scriptOrchestrator` 服务（将来随本插件类型包提供；纯 JS 订阅方零影响）。事件**不自动转发 renderer**（Host→Client 白名单不含 `script-orchestrator/*`）；Web 面板走 [11-web-panel](11-web-panel.md) 的回读与轮询，两者互不替代。

## 服务：`ctx.scriptOrchestrator`

```ts
interface ScriptOrchestratorService {
  create(input: OrchestrationInput, actorSessionId?: SessionId, signal?: AbortSignal): Promise<OrchestrationView>
  list(query?: ListQuery): Promise<ListResult>
  view(id: string, options?: { runs?: number }): Promise<OrchestrationView & { runs: RunView[] }>
  edit(input: EditInput, actorSessionId?: SessionId, signal?: AbortSignal): Promise<OrchestrationView | DeleteResult>
  run(id: string, signal?: AbortSignal): Promise<RunView>
  reportRunResult(input: ReportInput, actorSessionId?: SessionId): Promise<ReportResult>   // v0.1y
  listActions(): Array<{ name: string; description?: string }>
  registerAction(definition: OrchestratorAction): () => void
}

interface ReportInput {                                              // 限制同脚本标记行（03「结果上报」）
  runId: string
  summary: string                                                   // trim 后 1–300 code point
  level?: 'info' | 'warn' | 'error'
  fields?: Record<string, string>                                   // ≤ 8 项，键 1–40、值 1–100 code point
}
interface ReportResult { runId: string; orchestrationId: string; status: RunStatus; result: RunResult }

interface ListQuery { active?: boolean; limit?: number; offset?: number }   // limit 1–500，默认 100；active: true → status === 'active'，false → paused/ended，省略 → 全部
interface ListResult { items: OrchestrationView[]; total: number; nextOffset: number | null }  // nextOffset = offset + items.length，取尽为 null
interface EditInput {
  id: string
  action: 'update' | 'pause' | 'resume' | 'delete'
  patch?: Partial<OrchestrationInput>      // 仅 action: 'update'，至少一个字段
  expectedUpdatedAt?: string | null        // 四种 action 均可选；null 表示「此前没有更新时间」；不匹配返回 script_conflict
}
interface DeleteResult { id: string; removedRuns: number }   // removedRuns 含被取消的排队/在途 run
```

| 方法 | 语义 |
|---|---|
| `create` | 校验 → 生成 id（未给时）→ 落库 → 计算 `nextOccurrence` → 发 `changed` |
| `list` | 按 `active` 过滤（`true` → `status === 'active'`，`false` → `paused`/`ended`，省略 → 全部）、分页并返回 `nextOffset`；不激活任何会话、不执行脚本 |
| `view` | 单条详情 + 最近 `runs`（默认 5，最多 50）条执行记录 |
| `edit` | 四种管理动作（与 `script_edit` 同一契约，见 [07-tools](07-tools.md)）：`update` 更新字段，仅调度字段修改时按 [02-triggers](02-triggers.md) 重建下次触发，非调度编辑不改变它，不限编排状态；`pause`/`resume` 按状态设置语义（幂等 no-op 规则见 [09](09-states-errors.md)）；`delete` 取消未终态 run 后同批删除全部记录 |
| `run` | 立即执行一次：`trigger = 'manual'`，不改变下次自动触发；`paused`/`ended` 编排均允许，拒绝仅 id 不存在；共用排队体系但不被 `overlap: 'skip'` 淘汰（见 [03-execution](03-execution.md)）；`signal` abort 转为该 run 的取消请求，等结算 `canceled` 持久化后才静止 |
| `reportRunResult` | 向执行记录追加会话侧结果上报（v0.1y）：`runId` 不存在或已被裁剪删除 → `script_unknown`；内容越限 → `script_input_invalid`（`reason: format`）；每 run 上限 **10 条**，超出 → `script_input_invalid`（`reason: limit`）。run 任意状态（含在途）可上报；写入仅 merge `run.result.reports`（追加 `{ at, sessionId?, summary, level?, fields? }`，`sessionId` 取 `actorSessionId`），不动其余字段；结算时保留已写入的 reports。写入走服务 FIFO 单槽，落库后发 `changed`；返回 `{ runId, orchestrationId, status, result }`。脚本侧标记行结果见 [03-execution](03-execution.md) |
| `listActions` | 返回当前注册动作表快照 `{ name, description? }[]`（按 `name` 排序）；仅供展示与拼写核对，执行期逐动作查表语义不变 |
| `registerAction` | 注册一个可被 `plugin` 动作调用的具名动作；返回 disposer |

服务通过 `inject: ['scriptOrchestrator']` 或 `ctx.get('scriptOrchestrator')` 获取；未安装本插件时调用方应容忍 `undefined`。

## 注册动作

```ts
interface OrchestratorAction {
  name: string                    // 注册动作名：<namespace>.<verb>，两段各 ^[a-z][a-z0-9-]{0,29}$
  description?: string            // 给编排作者看的说明
  run(context: ActionContext): Promise<void>
}

interface ActionContext {
  orchestration: { id: string; title: string }
  run: { runId: string; status: RunStatus; trigger: TriggerKind }
  payload: JsonValue              // 已做模板替换后的 payload
  signal: AbortSignal             // 动作超时或整个 run 被取消时中止；注册摘除不触发
  report(message: string): void   // 追加到该动作 warnings（字符串数组，与模板警告同数组，保留最近 20 条）
}
```

契约：

- `name` 必须形如 `<namespace>.<verb>`（恰好一个点，两段各 `^[a-z][a-z0-9-]{0,29}$`）；`namespace` 建议与注册方插件 id 一致，但不校验。不合规名字同步抛错。保留前缀 `script-orchestrator.` 不可注册（防冒名内置能力）；除此之外不保留任何名字。
- **所有权只属调用方**：`registerAction` 自身不绑定清理，返回的 disposer 由调用方用 `ctx.effect` 持有。调用方插件卸载、或 `scriptOrchestrator` 服务消失/替换导致 `inject` 回调卸载时 disposer 被调用；服务端不在调用者 fiber 上自动叠加 effect，两种所有权不混用。
- 重名注册**同步抛 `Error`**（消息含冲突名，不覆盖）。同一存活期内重复注册同名属调用方 bug，抛错即可；插件重新挂载的「先 dispose 再注册」顺序由 `inject`/`effect` 生命周期自然保证，无显式 API。
- 原始 disposer 承诺四条不变量：**幂等**（重复调用无害）；**同步**（返回前完成摘除，保证紧随其后的重名注册不误冲突）；**按注册 token 精确删除**（只删自己那次注册，同名新注册不被旧 disposer 误删）；**注册表是服务实例内部表**（服务整体替换时，旧实例的 disposer 不影响新实例的注册表）。
- 摘除只影响**未来解析**：执行器逐动作执行前实时查表、不缓存函数引用，摘除后的下一次执行得到 `unknown_action`。dispose **不中止**在途 `run()`：已开始的调用继续执行，受自身 `timeoutSeconds`（≤ 300 秒）约束，按自身成败正常结算并计入 run 聚合；不产生「因摘除而 canceled」的记录，`canceled` 专属整个 run 的显式取消。
- 调用是**串行**的：一个 run 内的动作按声明顺序依次执行。
- 异常吞掉会被记录为 `action_error`；`signal` 中止后仍继续执行剩余动作（除非整个 run 被取消）。
- `description` 经 `listActions()` 出现在 `script_view` 的可用动作提示里，方便配置时发现拼写错误。

示例：一个提供告警能力的插件

```js
export function apply(ctx) {
  ctx.inject(['scriptOrchestrator'], (ctx) => {
    ctx.effect(() => ctx.scriptOrchestrator.registerAction({
      name: 'ops.oncall',
      description: '按 severity 呼叫值班',
      async run({ payload, report, signal }) {
        await pageOncall(payload, signal)
        report(`已呼叫 ${payload.severity}`)
      },
    }))
  })
}
```
