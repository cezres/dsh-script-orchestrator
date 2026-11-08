# 核实 Web 面板发现构建与注入

Type: research
Status: resolved
Labels: wayfinder:research
Research branch: research/web-client
Findings: .scratch/script-orchestrator/research/web-client.md
Research commit: 5c0e114656ac4120d04d0d557b579f2c7b1654f5

## Question

工作区或第三方插件的 client UI 在 DSH `0.2.2-rc.1` 中如何被发现、构建、注入 Web GUI 并与宿主侧 `ctx.scriptOrchestrator` 服务通信？调查 `dsh-client-modules`、`dsh-client-hmr`、内置 schedule 面板及插件分发路径，明确开发时 HMR、生产构建、路由/入口、RPC 或事件桥接、依赖与静态资源的准确机制。回答首版面板的可行实现形态；若只能降级，给出有源码证据的替代路径。

## Answer

已核实首版可以采用普通第三方 Host + Client 双面插件包，不需要退化为纯工具方案。Host 半侧必须是启用的 Loader 条目；包需声明 `dsh.bundle.patch`、`dsh.client.platform = "web"` 和 `exports["./client"]`，并随包提供预构建的 lazy-CJS factory，Host 不即时编译 TS/JSX。

Web 与 Desktop 生产均通过 `__DSH_BOOT__`、模块 graph 和 `/plugins` 注入。面板可参照 Schedule 注册 `main` 与 `sidebar.panellist` slots，不需要新增 URL 路由或修改第一方 Web shell。

浏览器不能直接取得 Host Context 或 `ctx.scriptOrchestrator`。可选择的桥接路径包括独立 Connection channel 的一元 RPC，以及 Schedule 同型的 Typert Remote；前者无需生成物，后者提供完整类型链但要求 `./typert` 与 `remote.$mount`。这是后续设计决策，不由研究票代替拍板。

`script-orchestrator/*` 不在第一方 Remote 事件转发白名单内。首版可采用写后权威回读、`connection/reset` 回读和活动 run 有限轮询，不应宣称已有实时事件推送。client HMR 是粗粒度重挂，会丢失插件 React 状态；manifest 变更和生产安装需要按重启边界验收。

尚未实际安装第三方面板，共享 tsdown 预设也未从 ASAR 中核实。实现前需要用最小包验证构建与加载闭环，或采用纯 JavaScript + `React.createElement` 的简化 lazy-CJS 构建档。

完整证据：[Web 面板研究报告](D:/projects/dsh-script-orchestrator-research-web-client/.scratch/script-orchestrator/research/web-client.md)，分支 `research/web-client`，commit `5c0e114656ac4120d04d0d557b579f2c7b1654f5`。
