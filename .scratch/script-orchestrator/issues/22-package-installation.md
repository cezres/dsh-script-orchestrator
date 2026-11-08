# 确定插件打包依赖与安装方案

Type: grilling
Status: resolved
Labels: wayfinder:grilling
Blocked by: 04, 05, 16

## Context

- [核实工作区插件、工具与配置机制](04-research-plugin-runtime.md)：profile、bundle、自插入、依赖解析、Config 与生命周期的宿主事实。
- [核实 Web 面板发现构建与注入](05-research-web-client.md)：双面包的 client 声明与预构建产物要求。
- [验证最小 Web 客户端构建与注入](16-web-build-prototype.md)：最小包在隔离 profile 中的实际构建和加载证据。

## Question

v0.1 应如何交付 `@local/dsh-script-orchestrator`？需要确定单包 Host + Client 结构、main/exports、dsh.bundle.patch 与 cordis.patch.yml、自插入条目和 engines.dsh；普通 dependencies 与宿主 peerDependencies 的具体清单及版本纪律；同步 Config/inject/apply 形态；`file:` 发布形态与 `link:` 开发形态的使用场景、files 产物、隔离 profile 安装、构建/HMR/重启和卸载验收。还需明确本地 private 包与未来公开分发的边界，避免为常量或内部实现引入不必要的 `@deepseek-ai/*` 依赖。

## Comments

### Round 1（2026-11-08，七题均按推荐拍板）

1. **单包双面**：一包承载 Host 实现、Web client 与 bundle 声明；`exports` 照 16 号实证样本（`.` → Host 入口生成器 apply、`./client` → client factory、`./package.json` 自指）；`type: 'module'`；不拆多包。
2. **声明与版本锁**：`dsh.bundle.patch` 自插入 + `dsh.client.platform: 'web'`；`engines.dsh` **精确锁** `0.2.2-rc.1`（范围=未验证承诺；拒装即期望行为）。
3. **依赖纪律**：deps 最小集 = dsh-util-time（`>=0.2.2-rc.1`）+ 校验库（`validateJsonSchemaValue` 归属由 12 号原型实证）；宿主框架与 react 仅实际 import 时列 peer（client 走 seed react 无 npm 依赖）；不为常量 import dsh-agent 内部（内联）。
4. **插件形态**：具名 Config（同步 Standard Schema）+ 生成器 apply；inject 按实际消费申报（实现期定全量）；异步清理全走 Fiber/Effect。
5. **files 与产物**：`files: ['lib', 'cordis.patch.yml']`；交付物=预构建 JS（简化档零构建）；构建方式不进契约。
6. **file:/link: 分工**：file: 验收/预发布（硬链接穿透、rename 断链已知）；link: 日常开发（HMR 直达）；切换清 node_modules（`CI=true` + `--no-frozen-lockfile`）；一律隔离 DSH_HOME + 独立 profile + 无头 `dsh web --no-open`。
7. **验收与分发**：部署须知写「client bundle 缺失/损坏 = 整 profile web 启动级故障」；卸载=移除依赖重启无残留；HMR 面板选中重置仅开发体验；`private` + `@local/`，公开分发前改 scope 重审依赖。

### Round 2（2026-11-08，两题均按推荐拍板）

8. **落盘去向**：新建 `docs/temp/12-packaging.md`（内容可成文且被 13 号 spec 直接引用），README 索引加行、变更记录 v0.1n。
9. **待验证 #7 结案**：16 号原型已端到端实证注入闭环，「降级纯宿主侧」退路不需要。

- 2026-11-09：[确认实施模块与验收方案](13-implementation-spec.md) 复审发现，本票 Round 1 的「校验库归属由面板原型实证」是陈旧误引；[核实工作区插件、工具与配置机制](04-research-plugin-runtime.md) 已明确 `@deepseek-ai/schemastery` 自装用于 Config，`validateJsonSchemaValue` 从 `@deepseek-ai/dsh-tools` 公开根导入并列 peer。Answer 与 12-packaging 已按 v0.1q 同步纠错，本票其余决定不变。

## Answer

**打包与安装契约**（全文见 [12-packaging](../../../docs/temp/12-packaging.md)，原 v0.1n；依赖归属由 v0.1q 纠错）：

- 单包双面：`exports` = `.` / `./client` / `./package.json`；`type: 'module'`；不拆多包。
- 声明：`dsh.bundle.patch: './cordis.patch.yml'`（自插入 `script-orchestrator` 条目）+ `dsh.client.platform: 'web'`；`engines.dsh: '0.2.2-rc.1'` 精确锁。
- 依赖：deps 最小集 = `@deepseek-ai/dsh-util-time@>=0.2.2-rc.1` + `@deepseek-ai/schemastery`（自装用于同步 Config）；`validateJsonSchemaValue` 从 `@deepseek-ai/dsh-tools` 公开根导入并列 peer；其余 peer 仅实际 import 时列；client 无 npm 依赖；禁 dsh-agent 常量依赖。
- 形态：具名 Config（同步 Standard Schema）+ 生成器 apply；异步清理全走 Fiber/Effect；交付物 = 预构建 JS（简化档零构建）。
- 安装：`file:` 验收/预发布、`link:` 日常开发；切换清 node_modules；隔离 DSH_HOME + 独立 profile + 无头实例验证。
- 验收清单：安装（dump-config 条目 + 面板出现）、运行（graph + slot 挂载）、HMR/重启（持久恢复、选中重置声明）、卸载（无残留）；故障须知（坏 client 包 = 启动级故障）；杀端口进程终止无头实例。
- 分发边界：`private: true` + `@local/` scope 不上 npm；公开分发前改 scope、重审依赖、重跑验收。

落盘：新增 `docs/temp/12-packaging.md`；README 索引 + v0.1n；10-decisions「打包与安装」分叉行 + 待验证 #7 结案；map 加行；本票 resolved。
