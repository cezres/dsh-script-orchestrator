# 验证最小 Web 客户端构建与注入

Type: prototype
Status: resolved
Labels: wayfinder:prototype
Branch: proto/web-build
Findings: .scratch/script-orchestrator/prototype/web-build/FINDINGS.md（worktree D:\projects\dsh-script-orchestrator-proto-web-build）
Commit: 9fd161b
Blocked by: 04, 05

## Context

- [核实 Web 面板发现构建与注入](05-research-web-client.md)：lazy-CJS 产物协议、Loader 条目、slots、HMR 和共享 tsdown 预设未决项的事实来源。
- [核实工作区插件、工具与配置机制](04-research-plugin-runtime.md)：第三方包结构、依赖声明和 Host 加载方式的事实来源。

## Question

能否用一个不包含正式面板业务的抛弃式最小包，在 DSH `0.2.2-rc.1` 验证“包声明 → Host Loader 条目 → client bundle → Web/Desktop graph → slot 挂载”的完整闭环？原型应优先比较可复用 tsdown 配置与纯 JavaScript + `React.createElement` 简化档，记录最小 package/exports/bundle 形状、构建命令、启停/重启/HMR 行为和失败诊断，为正式面板选定可交付的构建路径。实验必须使用隔离测试 profile，区分 `file:` 发布形态与 `link:` 开发形态，不修改真实用户 profile。原型不是正式 Web 面板实现，不合并研究或原型分支。

## Comments

- 2026-11-08：环境对齐（用户批准）：第二实例 + 自定义 DSH_HOME、仓库抛弃式分支、Web+Desktop 双端验收；实测发现 Desktop 单实例锁无参且 userData 不随 DSH_HOME 变，第二 GUI 实例不可能，改用官方 CLI 无头 `dsh web` 验证（注入管线与 Desktop 生产同源）。
- 2026-11-08：闭环四段全部实证通过（dump-config 条目、__DSH_BOOT__ graph 行、sidebar/main slot 挂载、React 状态工作）；HMR、冷重启、失败诊断、file:/link: 两形态实验完成；构建档位定简化档。

## Answer

原型结论（完整证据与复现要点见 [FINDINGS.md](../../../dsh-script-orchestrator-proto-web-build/.scratch/script-orchestrator/prototype/web-build/FINDINGS.md)，分支 `proto/web-build`，commit `9fd161b`）：

1. **闭环验证通过**：包声明（`dsh.bundle.patch` + `dsh.client.platform` + `exports["./client"]`）→ profile bundle → Loader 条目（`--dump-config` 可见）→ client bundle 进 `__DSH_BOOT__` graph → `sidebar.panellist` + `main` slot 挂载渲染，全部在隔离沙箱 `DSH_HOME` 的无头 `dsh web` 实例上端到端实证。真实 `~/.dsh` 未被触碰。
2. **构建档位定为简化档**：纯 JS + `React.createElement` 手写 lazy-CJS factory（协议：`window.__ModuleLoader__.load({id, factory})`，factory 返回 `module.exports`，导出生成器 `apply`（`yield` 注销器）+ `inject: ['slots']`），零构建步骤即可交付；tsdown 共享预设仍不可从外部获得（与研究报告一致），正式实现需要 JSX/chunks 时再攻。
3. **正式面板的实现蓝图直接可用**：`main` slot `register({name:'main', key, inject:()=>({})}, Component)` + `sidebar.panellist` `register({name, id, order, label}, IconComponent)`；外层依赖仅 seed 内的 `react` 与已装载的 `slots` 等客户端服务。
4. **运维边界（新增事实）**：官方 CLI 位于 `resources\runtime\cli\bin\dsh.cmd`（`ELECTRON_RUN_AS_NODE`）；Desktop 第二实例不可能（无参单实例锁、userData 不随 DSH_HOME）；`desktop` profile 名被 CLI 独占；`dsh web` 默认自动开浏览器（验证用 `--no-open`）；无头实例须杀端口监听进程（杀 CLI 包装留孤儿宿主）；一个坏 client 包会拖死整个 profile 的 web 启动（报错精确、日志落盘 `<home>/logs/startup-*.log`）——正式面板分发必须把「client bundle 缺失/损坏 = 启动级故障」写进部署须知。
5. **file: 与 link:**：`file:` 是硬链接（同 inode，就地编辑穿透回源；rename 式重建断链不传播——推断）；`link:` 是符号链接（源编辑 + HMR 直达，免重装，开发形态实证）。`file:`→`link:` 切换需清 node_modules（`CI=true`）+ `--no-frozen-lockfile`。
6. **HMR 行为**：≤6s 重挂生效、React 状态重置、**当前面板选中重置回会话页**（新发现，仅影响开发体验）。
7. **局限**：Desktop 窗口内验证未执行（需退出本会话宿主 GUI，成本>收益），以管线同源 + Web 端到端替代，残余风险已知；tsdown 常规档未做最小编译验证。

对地图的影响：[确定 Web 面板通信与刷新契约](15-web-communication.md) 的桥接与刷新契约不受影响；[设计 Web 管理面板交互原型](12-web-panel-prototype.md) 可直接采用简化档蓝图与本分支 pkg 作为脚手架起点。
