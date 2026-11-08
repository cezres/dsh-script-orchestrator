# 核实会话创建与首条消息投递

Type: research
Status: resolved
Labels: wayfinder:research
Research branch: research/session-actions
Findings: .scratch/script-orchestrator/research/session-actions.md
Research commit: 076414a75a37434ea0bb240fc6402e18f921df7a

## Question

在 DSH `0.2.2-rc.1` 的工作区插件中，`session` 动作应如何铸造新会话 id、创建 root/child 会话并投递首条消息？核实 `ctx.sessions.create`、`ctx.agents.create`、`handle.agent.followup` 的真实接口与最小调用顺序，`source.kind` 是否接受自定义插件名，root/child 所需 metadata、preset/model 参数和 `dispose()` 语义分别是什么。给出主源码证据，并指出现有契约不可实现或需调整之处。

## Answer

1. 普通 root 可对齐 Host 使用 `session-${randomUUID()}` 并直接走 Agent 创建通道。`ctx.sessions.create()` 已注册 live Session，不是纯 id allocator；之后再对同 id 调 `agents.create()` 会重复失败，原待验证项 #2 的退路不可实现。Session Controller 可能返回不同 id，必须使用实际返回值。
2. 首条 followup 需要完整 UserMessage：按 schedule 使用 `createUserMessage({content, source})` 补出 id 与 `role: 'user'`，再 `agent.followup(message)`；需要持久化接受确认时再 await `ctx.sessions.flush()`。followup 是同步入队，flush 也不代表模型已消费或首轮成功。
3. 自定义 `source.kind` 运行时接受任意非空字符串，TypeScript 需扩展 MessageSourceMap。但列表 lastPromptAt 与 api-session/activity 只认 `kind === 'user'`，自定义插件 kind 与 user+banner 是产品语义取舍。
4. 直接 `agents.create()` 不自动应用 Host preset/model。preset 需 resolve 并在 setup 中 mount，model 缺省需显式读取 Host 默认；也可走 sessionController.create() 由上层 compose，再用 resolveAgent() 获取 Agent。
5. 真正 child 需要 exact live parent、`parentAgent`、`meta.parentSession`、按 parent 计算的 depth 和完整 composition。只加 origin/delegationDepth 会形成 orphan，客户端仍可能按 root 显示，普通 Session API 又会拒绝 subagent；定时脚本无天然 parent 时不能冒充 Host subagent。
6. managed subagent 通道适合 exact parent 下的默认 idle 0，不直接提供可配置延迟 idle 回收。dispose 会 cancel/drain、关闭写句柄并注销 live 对象，不是内建 idle timer，也不删除日志或 Workspace 关系。直接创建 Agent 的 owner fiber 卸载也会 teardown，root“常驻”需要重新限定。
7. title 不属于 Session meta，需要单独 rename；Workspace attach、命名失败、delivery_failed 覆盖阶段、root 卸载存活和持久保留都需契约决策或后续实验。

完整证据：[会话动作研究报告](D:/projects/dsh-script-orchestrator-research-session-actions/.scratch/script-orchestrator/research/session-actions.md)，分支 `research/session-actions`，commit `076414a75a37434ea0bb240fc6402e18f921df7a`。
