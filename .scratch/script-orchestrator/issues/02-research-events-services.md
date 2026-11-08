# 核实事件与插件服务机制

Type: research
Status: resolved
Labels: wayfinder:research
Research branch: research/events-services
Findings: .scratch/script-orchestrator/research/events-services.md
Research commit: e8e98f5925a3a97c003012cf544219eab657f36e

## Question

在 DSH `0.2.2-rc.1` 中，工作区插件如何发布 `script-orchestrator/*` 自定义事件、暴露并获取 `ctx.scriptOrchestrator` 服务？核实 Cordis 事件命名与载荷约束、自定义事件是否进入会话日志或 Event inspect 目录、服务注册/`inject`/`ctx.get` 生命周期，以及跨插件调用和 disposer 的准确语义。给出主源码证据，并指出对事件与服务契约的约束。

## Answer

1. `script-orchestrator/*` 可直接逐名 `ctx.on`/`ctx.emit`，名称按精确字符串匹配，无运行时注册和通配订阅。TypeScript 消费方需要 Cordis module augmentation，纯 JS 不需要。
2. Cordis 原样传递 JS 参数，不做 JSON 校验、深拷贝、64 KiB 限制或 tail 截断。`emit` 同步调用 listener、忽略 Promise；同步异常会传回发布者并可能阻断后续 listener，失败隔离需要本插件另行决策和实现。
3. 外部自定义事件不会自动进入构建期静态生成的 Event inspect，Service inspect 也不会自动发现外部服务。普通 Cordis emit 不进入 Session 日志、持久化、导出或遥测；事件无重放，持久结果应以 `view()` 为事实源。
4. 服务必须用 `ctx.provide()` 或 `Service` 子类暴露。`inject` 是硬依赖，缺失时 callback 不执行；`ctx.get()` 才是即时、可返回 `undefined` 的可选查询，不等待也不订阅服务变化。
5. Host 插件在同一 Context/isolation scope 中直接调用实际服务对象，没有自动 JSON/RPC。renderer 必须显式装配 Remote/API 桥接；`registerAction` 的函数参数和 disposer 返回值必须保持 Host-only。
6. 当前 Host→Client 事件白名单不含 `script-orchestrator/*`。普通持久化工作区 bundle 与动态 host-runner 的受限 façade 不能互相推断能力。
7. `ctx.on` 和 `ctx.provide` 已绑定 fiber 清理。`registerAction` 由调用方以 `ctx.effect` 持有 disposer 的方向可行，但插件需保证原始 disposer 幂等、同步、按 token 精确摘除；dispose 不自动取消在途 action.run，未来执行需重新查表才得到 `unknown_action`。

完整证据：[事件与服务研究报告](D:/projects/dsh-script-orchestrator-research-events-services/.scratch/script-orchestrator/research/events-services.md)，分支 `research/events-services`，commit `e8e98f5925a3a97c003012cf544219eab657f36e`。
