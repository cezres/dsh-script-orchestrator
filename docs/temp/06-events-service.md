# 06 · 事件与服务（给其他插件作者）

本插件对外的两个接口：**事件**（观察，发出即忘）与 **服务**（调用与注册）。二者职责不同，不要混用。

## 事件

| 事件名 | 何时发出 | 载荷 |
|---|---|---|
| `script-orchestrator/run-started` | run 领取到执行槽、脚本即将启动 | `{ runId, orchestrationId, trigger, scheduledAt, startedAt }` |
| `script-orchestrator/run-settled` | run 进入任一终态（含 `interrupted`） | 见下方 `RunSettled` |
| `script-orchestrator/action-settled` | 单个动作结算 | `{ runId, orchestrationId, name, kind, status, error? }` |
| `script-orchestrator/changed` | 编排集合发生持久变更（增删改、暂停恢复） | 无载荷 |

`RunSettled`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `runId` / `orchestrationId` | string | 标识 |
| `status` | 枚举 | 见 [09](09-states-errors.md) |
| `trigger` | 枚举 | 触发来源 |
| `scheduledAt` / `startedAt` / `settledAt` | ISO 时间 | 时间线 |
| `script` | object | `{ exitCode, signal, timedOut, durationMs, truncated, spillPath }` |
| `stdoutTail` / `stderrTail` | string | 各 ≤ 2048 字符 |
| `matchedRule` | number \| null | 命中下标 |
| `usedFallback` | boolean | 是否走 fallback |
| `actions` | array | `{ name, kind, status }[]`，不含错误细节（细节在 `view` 里） |

载荷约束：

- 必须是可无损序列化的 JSON，不含函数、`undefined`、循环引用。
- 单条事件载荷 ≤ 64 KiB；超过时截短 tail 而不是丢事件。
- 事件**不保证**送达顺序之外的重放：Host 重启不补发。需要持久结果的消费方应调用 `view()` 读存储。

订阅示例：

```js
// 其他插件的 apply 里
ctx.on('script-orchestrator/run-settled', (run) => {
  if (run.status === 'failed') ctx.logger?.warn?.(`脚本编排失败: ${run.orchestrationId}`)
})
```

> 自定义事件名不会出现在 `Event` inspect 目录中（该目录只收录内置声明）。TypeScript 消费方需自行做事件类型声明；纯 JS 订阅方无影响。

## 服务：`ctx.scriptOrchestrator`

```ts
interface ScriptOrchestratorService {
  create(input: OrchestrationInput, actorSessionId?: SessionId, signal?: AbortSignal): Promise<OrchestrationView>
  list(query?: ListQuery): Promise<{ items: OrchestrationView[]; total: number }>
  view(id: string, options?: { runs?: number }): Promise<OrchestrationView & { runs: RunView[] }>
  edit(input: EditInput, actorSessionId?: SessionId, signal?: AbortSignal): Promise<OrchestrationView>
  run(id: string, signal?: AbortSignal): Promise<RunView>
  registerAction(definition: OrchestratorAction): () => void
}

interface ListQuery { active?: boolean; limit?: number; offset?: number }   // limit 1–500，默认 100
interface EditInput {
  id: string
  action: 'update' | 'delete'
  patch?: Partial<OrchestrationInput>      // action: 'update' 时至少一个字段
  expectedUpdatedAt?: string | null        // 乐观并发；不匹配返回 script_conflict
}
```

| 方法 | 语义 |
|---|---|
| `create` | 校验 → 生成 id（未给时）→ 落库 → 计算 `nextOccurrence` → 发 `changed` |
| `list` | 按 `status` 过滤、分页；不激活任何会话、不执行脚本 |
| `view` | 单条详情 + 最近 `runs`（默认 5，最多 50）条执行记录 |
| `edit` | 更新字段 / 删除；`update` 会重算下次触发；删除后历史 run 一并移除 |
| `run` | 立即执行一次：`trigger = 'manual'`，不改变下次自动触发，不消耗 `COUNT` |
| `registerAction` | 注册一个可被 `plugin` 动作调用的具名动作；返回 disposer |

服务通过 `inject: ['scriptOrchestrator']` 或 `ctx.get('scriptOrchestrator')` 获取；未安装本插件时调用方应容忍 `undefined`。

## 注册动作

```ts
interface OrchestratorAction {
  name: string                    // ^[a-z][a-z0-9-]{0,63}$，建议 "<plugin>.<verb>"
  description?: string            // 给编排作者看的说明
  run(context: ActionContext): Promise<void>
}

interface ActionContext {
  orchestration: { id: string; title: string }
  run: { runId: string; status: RunStatus; trigger: TriggerKind }
  payload: JsonValue              // 已做模板替换后的 payload
  signal: AbortSignal             // 超时或取消时中止
  report(message: string): void   // 写入该动作的 warnings/进展，最多保留 20 条
}
```

契约：

- 重名注册**抛错**（不覆盖）。同名插件重新挂载时先 dispose 再注册。
- 返回的 disposer 必须由调用方用 `ctx.effect` 持有；插件卸载即摘除，之后引用它的编排执行时得到 `unknown_action`。
- 调用是**串行**的：一个 run 内的动作按声明顺序依次执行。
- 异常吞掉会被记录为 `action_error`；`signal` 中止后仍继续执行剩余动作（除非整个 run 被取消）。
- `description` 会出现在 `script_view` 的可用动作提示里，方便配置时发现拼写错误。

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
