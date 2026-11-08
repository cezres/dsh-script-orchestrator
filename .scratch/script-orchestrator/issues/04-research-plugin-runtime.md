# 核实工作区插件、工具与配置机制

Type: research
Status: resolved
Labels: wayfinder:research
Research branch: research/plugin-runtime
Findings: .scratch/script-orchestrator/research/plugin-runtime.md
Research commit: 48ccae0ffa37e5271bbb03ba2f3aee81b169f939

## Question

DSH `0.2.2-rc.1` 如何发现、安装和加载本地工作区插件，插件包如何声明自身依赖、配置 schema、`apply` 生命周期与五个模型侧 `script_*` 工具？核实从工作区包 import 自身 npm 依赖和已安装 `@deepseek-ai/*` 包的可行性、推荐依赖边界、工具返回/abort 约定，以及 `@local/dsh-script-orchestrator` 所需包结构。给出主源码证据与最小配置示例。

## Answer

1. 本地包不会由当前项目目录自动扫描挂载；已核实路径是 profile package.json、`dsh.profile.bundles`、分层 Cordis patch 和 Loader import。推荐单包同时承载实现与 bundle，声明 `dsh.bundle.patch`，由包内 cordis.patch.yml 自插入 `script-orchestrator` 条目。
2. 本地绝对 `file:`/`link:` 路径可安装：file 更接近发布形态，link 适合开发但需自行构建并按实际 HMR/重启边界验证。应在隔离测试 profile 验收，不修改真实用户 profile。
3. 普通 npm dependencies 必须实际安装；链接外部工作区包时，宿主包需列入自身 peerDependencies 才能可靠走 runtime resolution，Node exports 仍是硬边界。推荐 dsh-util-time/schemastery 自装，dsh-tools/Cordis 等宿主框架 peer，服务优先 ctx.*，不为少量常量 import dsh-agent 内部。
4. 支持具名 Config/inject/apply 对象插件；Config 是同步 Standard Schema。async apply 与所有清理由 Fiber/Effect 跟踪，不允许遗留脱离生命周期的异步任务。
5. 五个工具应在 profile 根各注册一次；execute 返回 JSON 值，output.render 统一单块 JSON 文本，业务错误返回契约错误值而非直接抛出。
6. 严格要求多余字段也返回 `script_input_invalid` 时，defineTool 简写不够：参数根默认开放，预校验会抛宿主 INVALID_ARGS。可行主路径是直接 ctx.tools.register 原始 definition、严格 JSON Schema 与 validateJsonSchemaValue，再自行映射契约错误；是否接受宿主参数错误例外需决策。
7. abort 在调用前/后分别为宿主 ABORTED_BEFORE_DISPATCH/ABORTED。已启动的 script_run 必须把 exec.signal 传到执行层，terminate 并等待 run 结算 canceled 与工具 Promise 静止，不能只停止等待。
8. `script_edit` 各 action 成功返回形状、服务与工具 action 集合对齐、wait=true 等待上限错误码仍是契约未决项。本机安装与真实 HMR 未实测，需最小原型验证。

完整证据：[插件运行机制研究报告](D:/projects/dsh-script-orchestrator-research-plugin-runtime/.scratch/script-orchestrator/research/plugin-runtime.md)，分支 `research/plugin-runtime`，commit `48ccae0ffa37e5271bbb03ba2f3aee81b169f939`。
