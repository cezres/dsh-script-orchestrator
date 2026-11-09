# 09 · 状态机与错误码

## 编排状态

```
        create
          │
          ▼
       active ──pause──▶ paused
          ▲  │              │
      resume │              │ resume（运行期无解）
          │  │              ▼
          │  └──────────▶ ended
          └──edit(重算触发)──┘
```

| 状态 | 含义 | 是否触发 |
|---|---|---|
| `active` | 正常，等下一次触发或当前 `fixed-delay` 自动 run 结算 | 是 |
| `paused` | 显式暂停，`nextOccurrence = null`，已有 run 继续结算 | 否（`script_run` 仍可手动执行） |
| `ended` | 运行期不再有匹配时刻的防御性终态；创建/更新无解 cron 会直接拒绝 | 否（`script_run` 仍可手动执行） |

`delete` 直接移除记录，不是状态迁移。`pause`/`resume` 按**状态设置**语义：仅分别从 `active`/`paused` 生效；对其余状态幂等 no-op（返回当前视图、不重锚），不是可报错的迁移断言。

## 执行状态

```
trigger
  │
  ├─ 不允许（disabled）────────────▶ skipped (skipReason: disabled)
  ├─ 单飞命中 overlap: skip ───────▶ skipped (overlap)
  ├─ queue 队列已满（上限 1）───────▶ skipped (overlap)
  ├─ 并发额度耗尽/排队溢出 ────────▶ skipped (concurrency)
  ▼
queued ──领槽──▶ running ──退出──▶ judging ──命中动作──▶ dispatching ──▶ succeeded
  │                    │                                   │            ├─▶ partial
  │                    ├─取消/卸载──▶ canceled              │            └─▶ failed
  │                    └─崩溃恢复────▶ interrupted          │
  └─取消──────────────▶ canceled                            └─无动作──▶ succeeded
```

| 状态 | 含义 | 终态 |
|---|---|---|
| `queued` | 已创建，等待并发槽 | 否 |
| `running` | 脚本已启动、未退出 | 否 |
| `judging` | 脚本已退出，规则求值中 | 否 |
| `dispatching` | 动作执行中 | 否 |
| `succeeded` | 脚本正常结算，动作全部成功（含零动作） | 是 |
| `partial` | 至少一个动作成功、至少一个失败 | 是 |
| `failed` | 无动作成功且至少一个失败；或脚本未能启动 | 是 |
| `skipped` | 本次未执行（`skipReason` 说明原因） | 是 |
| `canceled` | 被显式取消 | 是 |
| `interrupted` | Host 崩溃/重启时未结算 | 是 |

### 结算规则

1. 只要脚本**启动成功**，无论退出码、是否超时，都进入 `judging`；`exitCode`/`signal`/`timedOut` 是判定输入，不是失败判据。
2. 判定选出的动作键在创建/更新时已静态校验存在；`plugin` 动作的注册动作名只静态校验格式，存在性在执行时逐动作查表，因此 `unknown_action` 来自「名字未注册或注册已被摘除」，属于环境错误而非配置错误。
3. `spawn_failed`（命令不存在、cwd 不合法、子进程服务拒绝）直接 `failed`，跳过判定。
4. 动作汇总：

| 成功数 | 失败数 | 结果 |
|---|---|---|
| ≥1 | 0 | `succeeded` |
| ≥1 | ≥1 | `partial` |
| 0 | ≥1 | `failed` |
| 0 | 0 | `succeeded` |

5. 取消与排队语义（取消矩阵、first-write-wins、delete 时序、`exec.signal` 贯穿）以 [03-execution](03-execution.md)「取消与等待」「并发与单飞」为准。要点：`judging` 不响应取消；`dispatching` 中被取消的 run 停止派发剩余动作、已执行动作结果保留，结算 `canceled`——**终态优先于动作汇总**。
6. **两写统一**：一切入过队的 run 都有完整记录（创建 + 结算两条写）；`skipped`（disabled/overlap/concurrency）也是完整记录（含 `scheduledAt`、`skipReason`，`trigger: 'manual'` 同样可被全局溢出丢弃——可见的 skipped 结果，非静默）。唯一无 run 记录的取消是宿主层 `ABORTED_BEFORE_DISPATCH`。

## 错误码

统一形状：`{ "code": string, "message": string, "details"?: object }`。`message` 面向人，可本地化；`code` 稳定、可编程判断。

| code | 触发条件 | 可重试 | 典型 details |
|---|---|---|---|
| `script_input_invalid` | 字段缺失、越界、多余字段、引用不存在 | 否 | `{ field, reason, part? }` |
| `script_unknown` | 编排 id 不存在（或已删除） | 否 | `{ id }` |
| `script_conflict` | 管理动作（`update`/`pause`/`resume`/`delete`）的 `expectedUpdatedAt` 与当前不一致 | 是（重读后重试） | `{ expected, actual }` |
| `script_storage_unavailable` | 存储域打不开、写入被拒（含 I/O 结果未知后的关闭恢复期；处置流程见 [08-storage](08-storage.md)）；以及 run 完整溢写输出读取失败（`spill` 排障读面，v0.1r） | 条件性 | `{ cause }`（如 `recovering` / `unavailable` / `spill-unavailable` / `ENOENT`） |
| `spawn_failed` | 脚本无法启动 | 否 | `{ command, cwd, cause }` |
| `unknown_action` | `plugin` 动作的注册动作名未注册（或注册被摘除） | 否 | `{ action }` |
| `action_error` | 动作实现抛错 | 否 | `{ name, message }` |
| `timeout` | 动作超过 `timeoutSeconds` | 否 | `{ name, timeoutSeconds }` |
| `template_invalid` | `prompt` 模板渲染后去首尾空白为空（payload 按结构递归渲染，恒为合法 JSON） | 否 | `{ name, field }` |
| `cwd_not_allowed` | 路径不在 `allowedRoots` 内 | 否 | `{ cwd, roots }` |
| `preset_unknown` | 指定的 agent preset 不存在 | 否 | `{ preset }` |
| `delivery_failed` | 新会话已创建但首条消息投递失败 | 是（人工接管） | `{ sessionId }` |
| `internal_error` | 未分类异常 | — | — |

## 日志与可观测

- 每个 run 的进入/结算各一条结构化日志：`{ runId, orchestrationId, status, exitCode, durationMs }`。
- 动作失败必须带 `code`，禁止只写字符串消息。
- `script_view` 返回的 `runs[].actions[]` 是排障首选入口；事件载荷刻意不含错误细节，避免把大对象广播给所有订阅方。
