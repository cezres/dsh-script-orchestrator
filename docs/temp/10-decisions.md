# 10 · 决策记录

## 命名

最终选择：**Script Orchestrator / 脚本编排**。

| 项 | 值 |
|---|---|
| 包名 | `@local/dsh-script-orchestrator`（本地安装；发布前改到自己的 scope） |
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
| 触发源 | MVP 即含 cron + rrule | 只做 `every`/`daily` 会让早期用户无法迁就现有运维习惯；cron 是这类工具的最低预期 |
| 会话落点 | `root` + `child` 两种都支持 | 只做 root：一次性摘要类任务会污染会话列表；只做 child：排查类任务用户无法接管 |
| 通知形态 | 事件 + 注册式动作 | 纯事件：编排无法主动调起别的插件能力；加 webhook：多一个网络面、超时与凭据问题，且用户明确排除 |
| 与 `schedule` 的关系 | 完全独立，不共享存储与触发 | 复用其存储会把两种语义耦合；复用其触发则无法在触发点插入脚本 |
| 脚本调用 | `ctx.subprocess.spawn` + argv 数组 | 自建 shell 拼接：注入风险；`spawnTerminal`：PTY 语义对本场景过重 |
| 判定 DSL | 固定谓词 + 首匹配 | 表达式引擎（JS eval / JSONLogic）：前者是安全洞，后者引入依赖且难审阅 |

## 待验证项（实现前必须回答）

| # | 问题 | 影响 | 失败时的退路 |
|---|---|---|---|
| 1 | 工作区插件能否 `import '@deepseek-ai/dsh-util-time'` | 决定 cron/rrule 是自己写还是复用 | 自带限定子集实现 + 表驱动测试 |
| 2 | 新会话 id 如何铸造（`schedule` 的预留 id 实现） | `session` 动作能否稳定创建会话 | 用 `ctx.sessions.create()` 铸 id 后再 `agents.create` |
| 3 | `agent.followup` 的 `source.kind` 是否接受自定义插件名 | 首条消息的来源标记 | 统一用 `{ kind: 'user' }`，靠抬头文本区分 |
| 4 | 自定义事件是否会被会话日志或 `Event` inspect 目录收录 | 订阅方可发现性 | 文档声明「需自行声明类型」，不做运行时注册 |
| 5 | `terminate()` 在 Windows 上的实际信号与退出码 | 超时判定里 `signal` 字段的取值 | 只保证 `timedOut` 可靠，`signal` 允许为 `null` |
| 6 | 从工作区包 `import` 已安装插件包（如 `dsh-agent` 的常量）是否可行 | 是否需要内联常量 | 只依赖 `ctx.*` 服务，不 import 任何 `@deepseek-ai/*` |

## 契约变更流程

1. 先改本文档或对应契约文档，并在 `README.md` 的变更记录里加一行。
2. 破坏性变更（改字段语义、改名、删状态）必须升域版本并给出兼容策略。
3. 实现与文档冲突时，以文档为准；文档本身错了就改文档，别让代码「跑通了就算对」。
