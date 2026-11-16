# 12 · 打包与安装（交付契约）

面向安装者与实现者：`@echo/dsh-script-orchestrator` 如何交付、安装与验收。包形状与安装边界已由 [16 号原型](../../.scratch/script-orchestrator/issues/16-web-build-prototype.md) 在隔离沙箱端到端实证。

## 包形状

单包双面：一个包同时承载 Host 实现、Web client 与 bundle 声明，**不拆多包**（v0.1 无独立分发 client 的需求，拆包只增发布面）。

```json
{
  "name": "@echo/dsh-script-orchestrator",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "skills", "cordis.patch.yml"],
  "engines": { "dsh": "0.2.2-rc.3" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

- `.` 是 Host 入口：具名 `Config` 对象插件（同步 Standard Schema）+ 生成器 `apply`（`yield` 注销器）；`inject` 按实际消费的宿主服务申报（subprocess、storageDomain、tools、events 等，实现期定全量）；所有异步清理走 Fiber/Effect 生命周期跟踪，不遗留游离任务。
- `./client` 是预构建 client factory（简化档手写 lazy-CJS，零构建步骤；面板蓝图见 [11-web-panel](11-web-panel.md) 与 16 号原型）。
- `engines.dsh` **精确锁**当前验证过的宿主版本（v0.1t 起为 `0.2.2-rc.3`，此前为 `0.2.2-rc.1`）：基线只有这一个验证过的版本，写范围（`^`/`>=`）等于承诺未验证的兼容性；宿主 engines 不匹配拒装正是期望行为。宿主小版本升级时先核对 `docs/upgrade-guide` 是否触及本插件消费的公开面，再把精确锁挪到新版本并重装。
- `files: ['lib', 'skills', 'cordis.patch.yml']`：交付物 = 预构建 JS（简化档源码即产物）+ 内置 SKILL 文本。Host 明确依赖 `skills` 服务，通过 `skills.register` 注册并在卸载时注销；缺失技能资源必须在初始化阶段明确失败。打包验收覆盖资源可读与注册生命周期。构建方式不进契约，需要 JSX/chunks 时再采用常规构建。

## 依赖纪律

| 类别 | 规则 |
|---|---|
| `dependencies`（自装） | 最小集 = `@deepseek-ai/dsh-util-time`（锁 `>=0.2.2-rc.1`，防 0.1.x 只有时区校验）＋ `@deepseek-ai/schemastery`（`~3.19.0`，用于同步 Config；归属见 [核实工作区插件、工具与配置机制](../../.scratch/script-orchestrator/issues/04-research-plugin-runtime.md)）＋ `zod`（`4.4.3`，v0.1r 补：`dsh-storage-domain` 的 `domainTable` 约定 `valueSchema.parse` 为 zod API，记录 schema 必须用 zod；schemastery 无 `.parse`，仅用于同步 Config） |
| `peerDependencies` | 仅在源码实际 import 时列：`@cordisjs/*` 框架、dsh-tools 等；`validateJsonSchemaValue` 从 `@deepseek-ai/dsh-tools` 公开根导入并列 peer（随 `engines.dsh` 精确锁，v0.1t 起为 `0.2.2-rc.3`）；client 的 react 走页面 seed（经 ModuleLoader），**无 npm 依赖** |
| 禁止项 | 不为少量常量 import `@deepseek-ai/dsh-agent` 内部（内联）；只依赖公开 export，`lib/*` 内部路径是硬边界 |

## 安装形态

| 形态 | 用途 | 已知边界 |
|---|---|---|
| `file:` | 验收 / 预发布（最接近发布形态） | 硬链接同 inode：就地编辑穿透回源；**rename 式重建断链不传播** |
| `link:` | 日常开发（源编辑 + HMR 直达、免重装） | 符号链接指向工作区；须自行保证产物最新 |

- 两形态切换需清 `node_modules`（`CI=true` + `--no-frozen-lockfile`）。
- 开发与破坏性安装/卸载验收默认隔离 `DSH_HOME` + 独立 profile；不要为验证当前 GUI 启动替代服务器。未经授权不得修改当前 profile。
- v0.1u：用户明确授权验收通过后更新当前 profile 时，先 `plugin_manager` 列出精确包标识，再用其正式安装入口更新；不手工修改真实 profile 文件。升级可能重载插件、影响在途 run，执行前说明影响；需要重启时先告知用户。不把安装授权扩展为试运行或启用编排授权。

## 验收清单

- **安装**：隔离 profile 引入依赖后 `--dump-config` 出现 `script-orchestrator` 条目；无头 `dsh web` 页面侧边栏出现面板。
- **运行**：`/plugins/…/client.js` 进 `__DSH_BOOT__` graph；slot 挂载渲染。
- **HMR/重启**：冷重启后面板从 profile 持久恢复；HMR 重挂生效（React 状态重置、**面板选中重置回会话页**——如实声明，仅影响开发体验）。
- **卸载**：从 profile 移除依赖后重启，Loader 条目与面板无残留。
- **故障须知**：client bundle 缺失/损坏 = 整 profile 的 web **启动级故障**（报错精确、日志落 `<home>/logs/startup-*.log`）——分发必写。
- 终止无头实例须杀端口监听进程（杀 CLI 包装进程会留孤儿宿主）。

## 分发边界

- `private: true` + `@echo/` scope：v0.1 本地安装，不上 npm。
- 未来公开分发：改 scope（[10-decisions](10-decisions.md) 命名行既定）、重审依赖与版本锁、重跑验收清单。
