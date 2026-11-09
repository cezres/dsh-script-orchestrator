# 脚本编排 v0.1 · 实施 spec

> 状态：**交接稿（2026-11-09 复审修订）**。本文是**导览索引**，不复制契约内容：对外契约唯一事实源是 `docs/temp/`（v0.1a–v0.1q），决策证据与推理在各已解决 ticket。实现与文档冲突时以文档为准（`docs/temp/10-decisions.md` 变更流程）。

## 1 · 目标与范围

在 DSH `0.2.2-rc.1` 上实现 `@local/dsh-script-orchestrator`：`every`/`cron` 触发、脚本执行、判定 DSL、三类动作（event/plugin/session）、宿主 JSON 存储、五个 `script_*` 工具与 `ctx.scriptOrchestrator` 服务、Web 管理面板。

**非目标**（地图 Out of scope）：RRULE/`at`/`after`、`daily`/`weekly` 作为正式持久化触发器类型、编排串联、webhook、脚本沙箱、面板注册动作管理/指标/权限/独立通知中心、Linux 专门适配或实机验收、旧版本宿主兼容。每日/每周仅作为面板预设生成 cron；无脚本沙箱不等于无路径约束，脚本与 session 的 `cwd` 仍受 `allowedRoots` 限制。

## 2 · 模块边界与依赖方向

```
scheduler ──▶ runner ──▶ judge ──▶ actions（event / plugin / session + 注册表）
    │            │                     │
    └────┬───────┴──────────┬──────────┘
         ▼                  ▼
       store（存储域 + 服务层 FIFO）      events（emit 横切，只发布）
         ▲
service（ctx.scriptOrchestrator + 工具适配 + Connection 桥 /script-orchestrator）
         ▲
panel（Web client；单包双面：管理表格 + 居中模态 + 对话式创建/编辑）
```

| 模块 | 职责 | 契约与证据指针 |
|---|---|---|
| scheduler | 调度状态与锚点选择、every 双模式 + 五位 cron、`nextOccurrence` 纯函数、错过合并、暂停/恢复/编辑重锚 | [02-triggers](../../docs/temp/02-triggers.md)；[确定 every 与 cron 的调度语义](issues/07-trigger-semantics.md) |
| runner | 执行生命周期（单飞/全局排队、两写结算、取消、终态唯一）、spawn、`cwd`/`allowedRoots` 预检、超时、输出双层收集、后代清理、失败分类 | [03-execution](../../docs/temp/03-execution.md)、[09-states-errors](../../docs/temp/09-states-errors.md)；[澄清执行排队取消与等待语义](issues/10-execution-lifecycle.md)、[确定脚本进程与输出契约](issues/18-process-output-contract.md)、[验证 Windows 终止与输出溢写](issues/19-windows-subprocess-prototype.md) |
| judge | 谓词求值、模板渲染、warnings | [04-judge](../../docs/temp/04-judge.md)；[澄清判定模板与结果字段](issues/11-judge-template-results.md) |
| actions | 三类动作串行与失败隔离、注册表（四不变量）、session 两模式/投递/回收；session `cwd` 同受 `allowedRoots` 约束 | [05-actions](../../docs/temp/05-actions.md)、[06-events-service](../../docs/temp/06-events-service.md)；[统一动作命名与注册契约](issues/08-action-naming.md)、[重新界定 session 动作模式](issues/20-session-modes.md)、[确定会话创建投递与回收契约](issues/21-session-delivery-lifecycle.md)、[最小宿主集成实验（会话创建到回收闭环）](issues/23-session-integration-prototype.md) |
| store | 存储域、服务层 FIFO、裁剪、恢复/对账 | [08-storage](../../docs/temp/08-storage.md)；[确定存储布局与故障恢复契约](issues/14-storage-recovery.md) |
| service | 管理与执行服务契约、五工具、Connection 桥、事件发布 | [06-events-service](../../docs/temp/06-events-service.md)、[07-tools](../../docs/temp/07-tools.md)、[11-web-panel](../../docs/temp/11-web-panel.md)；[统一工具与服务的管理接口](issues/09-management-interface.md)、[确定 Web 面板通信与刷新契约](issues/15-web-communication.md)、[确定事件发布与失败隔离契约](issues/17-event-publication.md) |
| panel | Web client 管理表格、居中模态、对话入口、回读/轮询；单包双面采用简化档 | [11-web-panel](../../docs/temp/11-web-panel.md)、[12-packaging](../../docs/temp/12-packaging.md)；[设计 Web 管理面板交互原型](issues/12-web-panel-prototype.md)、[验证最小 Web 客户端构建与注入](issues/16-web-build-prototype.md) |

规则：模块间只经显式接口；**一切存储写入走服务层 FIFO 槽位**（复合操作整槽）；events 只发布不订阅自身；panel 不触 Host 服务本体（只走桥）。runner 拥有 run 生命周期，service 的 `run`/`script_run` 只经其执行接口触发与取消，不另造一套排队或结算逻辑。

## 3 · 实施顺序（每步独立验证）

1. **包骨架 + Config + 依赖 + 存储域**（[12-packaging](../../docs/temp/12-packaging.md)；[核实工作区插件、工具与配置机制](issues/04-research-plugin-runtime.md)、[确定插件打包依赖与安装方案](issues/22-package-installation.md)、[确定存储布局与故障恢复契约](issues/14-storage-recovery.md)）——空转可起停、`--dump-config` 可见条目，内部服务层 FIFO 与存储打开/关闭可测；
2. **scheduler**——`nextOccurrence` 纯函数与 scheduler 锚点选择分层测试，覆盖各模式适用的创建/恢复/编辑/结算锚点及有界无解；
3. **runner + 执行生命周期**——W1/W2 实测语义直接转断言（`{exitCode:1,signal:null}`、spill 双层、超 cap 撤回）；队列方向、两写、取消矩阵与 first-write-wins 转集成断言；
4. **judge + 模板**；
5. **actions + 注册表**——内联 UserMessage、`whenIdle` 挂 agent；两模式创建/投递/回收与注册表行为按 §4 验证；
6. **service + 五工具 + Connection 桥**——五工具严格 JSON Schema 校验并全映射 `script_input_invalid`；Connection 桥仅做最小形状校验并同构映射；工具 `exec.signal` 取消 run，Connection UI abort 只终止等待、不取消已受理操作；
7. **事件发布 + Web 面板**——UI 以 `proto/web-panel` 分支为脚手架（变体 C + 居中模态 + 对话入口），包形状与注入以 `proto/web-build` 分支为起点；
8. **全量验收**（§4 测试矩阵 + §5 实机验收）。

## 4 · 测试矩阵（骨架；细目实现期展开）

- **单元**：
  - scheduler：`nextOccurrence` 纯函数（严格大于 `fromMs`、五位 cron/DST/有界无解）；锚点选择（创建/恢复/编辑、`scheduledAt`/`settledAt`、fixed-delay 未结算为 `null`、旧 run 不覆盖新计划）；
  - runner：输出收集（按流 `truncated = lossy`、解码后末 2048 code point、U+FFFD 保留、spill 存在不改变 `truncated`、超 cap 撤回）；`cancelReason` 失败分类；
  - judge/store/actions：谓词全表（含 `truncated` 按流）；模板（`json:` 对称、payload 递归恒 JSON、warnings）；淘汰定序（`settledAt`/`runId`）；三类名字正则与 disposer 四不变量。
- **集成**：
  - 调度恢复：cron/fixed-rate 停机错过合并、fixed-delay 停机至多补一次、`interrupted` 后从恢复结算的 `settledAt` 推进、暂停期间不补跑；
  - 执行生命周期：单飞 queue 溢出新者 skip、全局溢出丢最旧；手动不被 `overlap:skip` 淘汰但可被全局丢弃；skipped 两写；取消矩阵；first-write-wins；正常退出后存活后代的有界等待 `waitForExit()` 2000ms→`terminate`→`descendants-terminated`；delete 时序（canceled→事件→同批删）；
  - 工具与服务：`exec.signal` → run 结算 canceled 且持久化 → 工具 Promise 以 `ABORTED` 静止（含 `wait:false`）；`ABORTED_BEFORE_DISPATCH` 无 run 记录；edit 四 action/CAS/幂等、list 分页；五工具 `script_input_invalid`/`internal_error`/`ToolOutputError` 分层；Connection 六端点零翻译 DTO、最小形状校验与 UI abort 不取消 run；
  - 安全与存储：脚本/session 越界 `cwd_not_allowed`、目录不存在 `spawn_failed`；FIFO 复合操作整槽；两类坏记录；写被拒后的关闭→重开→对账且不盲重试；重启恢复（interrupted、孤儿清理、保留对账）；
  - 动作：失败隔离、实时查表 `unknown_action`、dispose 不中止在途动作；session 的 persistent/sessionController 与 ephemeral/agents.create 两路径、`whenIdle`→`idleDisposeSeconds`→dispose、`delivery_failed` 保留 `sessionId` 且失败 ephemeral 不启动回收、delete 编排不触碰已建会话；成功只断言 followup 接受 + flush 未拒绝，不断言消息已 append 日志；
  - 事件与面板：发布端对 listener 异常兜底且不影响主流程（不承诺 per-listener 隔离）、四事件时序与回读一致、64 KiB UTF-8 计量与 tail 兜底；对话式创建/编辑、居中模态三段结果；写后与 connection/reset 回读、可见且有活动 run 时 5 秒轮询及停止条件；HMR/冷启动允许本地状态重置，经 `list`/`view` 回读恢复权威数据。
- **端到端**：沙箱实例闭环——五工具 smoke；分别创建 every 与 cron 编排并各自动触发一次 → 判定命中 → event/plugin/session 三动作 → `run-settled`/`action-settled` 事件 → 面板对话式新建/编辑入口（`uiWorkspace.startSession` + 引导 prompt）→ 居中模态 run 历史三段结果 → 删除级联。

## 5 · 验收标准

**Windows 实测（验收门）**：

- §4 测试矩阵全绿；
- [12-packaging](../../docs/temp/12-packaging.md) 验收清单全绿（安装/运行/HMR/重启/卸载/故障须知）；
- 运行验收链：五工具 smoke → 分别创建 every 与 cron 编排并各自动触发一次 → 判定 → 三动作 → 事件 → 面板对话入口与居中模态 run 历史 → 删除级联；
- W1/W2 语义复测（terminate→`{1,null}`、spill 可读、超 cap 撤回）。

> **验收结果（2026-11-09）**：上述验收门由 [完成 Windows 全链路交付验收](issues/36-windows-release-acceptance.md) 执行并通过——单元/进程/集成测试 580 用例全绿，隔离集成矩阵 verify-ticket24–36 全部 PASS；完整环境、命令、结果与残余风险见 [验收记录](evidence/ticket36-acceptance.md)。HMR 与坏 client 包实例化未验证（如实列为残余风险）；macOS 仍仅源码证据声明。

**macOS（证据声明，非验收门）**：PGID 终止回退、`signal` 语义未实机验证——代码路径按源码事实实现（[核实子进程与跨平台终止语义](issues/03-research-subprocess.md)），不做实机断言。

## 6 · 已知残余风险（如实交接）

1. macOS 全部终止/信号语义未实机验证（验收矩阵仅 Windows）；
2. 裸 `.cmd`/`.bat` 未验证不承诺（推荐 `pwsh -Command` 包装）；
3. Desktop 窗口内面板验证未执行（注入管线与 Web 同源已实证）；
4. tsdown 常规构建档未验证（简化档零构建已定案；需 JSX/chunks 时再攻）；
5. `flush() === true` 只是投递管线接受——死路由场景会话日志仅 header（[最小宿主集成实验（会话创建到回收闭环）](issues/23-session-integration-prototype.md) 实测）；
6. 正常 LLM 回合的消息 append、`lastPromptAt`/activity 的 UI 可观测性未实测；真实停用/卸载 teardown 仅以杀宿主近似；ephemeral 回收竞态未见原型实测结论（均如实保留为证据边界，不改变既有契约语义）；
7. `file:` 安装 rename 式重建断链为推断（[验证最小 Web 客户端构建与注入](issues/16-web-build-prototype.md)）；
8. Windows「直接命令退出但后代存活」的 `waitForExit` 悬挂、2000ms 后 `terminate` 清理及 `descendants-terminated` 路径未实机验证（仅源码依据，W1/W2 未覆盖；见 [验证 Windows 终止与输出溢写](issues/19-windows-subprocess-prototype.md)）。

## 7 · 证据与决策索引

完整决策与证据索引见 [脚本编排 v0.1 实现就绪方案](map.md) 的 Decisions so far：22 张已解决前置 ticket（研究 6、决策 12、原型 4），本交接稿由 [确认实施模块与验收方案](issues/13-implementation-spec.md) 汇总并复审。原型产物分支 `proto/web-build`、`proto/subprocess`、`proto/web-panel`、`proto/session-integration` 均抛弃式不合并。

[10-decisions](../../docs/temp/10-decisions.md) 中编号待验证 #1–#7 均已结案；这不替代 §4 的实现期测试与 §5 的实机验收。
