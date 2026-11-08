# 24: 安装插件并查看空编排列表

**What to build:** 用户在隔离 profile 安装插件后，能打开 Web 面板并看到由 Host 权威数据驱动的空编排列表，而不是只有静态界面或插件骨架。

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] 单包 Host/client 声明、同步 Config、依赖边界和自插入条目可用，`--dump-config` 能看到插件条目，侧边栏与主面板能挂载。
- [x] Host 管理服务与 Connection 桥提供空 `list` 闭环，返回 `{ items: [], total: 0, nextOffset: null }`，面板覆盖空态、加载态和传输错误态。
- [x] 存储域以既定 per-record 布局打开并关闭，内部服务层 FIFO 可入队、排干且单槽失败不毒化后续操作。
- [x] Config 默认值和非法配置诊断有测试，非法配置不能留下半初始化服务或游离异步任务。
- [x] 冷重启后面板通过权威回读恢复空列表；卸载插件后面板与 Loader 条目无残留。
- [x] 在隔离环境完成安装、启停、面板渲染和存储生命周期的自动化验证，不修改真实用户 profile。

## Comments

### 做了什么

按 spec §3 步骤 1（包骨架 + Config + 依赖 + 存储域）+ 步骤 6/7 的最小闭环实施，TDD（红-绿循环，先写失败测试）：

1. **包骨架**（`pkg/`，形状照抄 `proto/web-build:pkg/`）：单包双面（`exports` = `.` / `./client` / `./package.json`）、`dsh.bundle.patch` 自插入（`cordis.patch.yml` → `- id: script-orchestrator`）、`dsh.client.platform: 'web'`、`engines.dsh: '0.2.2-rc.1'` 精确锁、`files: ['lib', 'cordis.patch.yml']`。
2. **Config**（`lib/config.js`）：schemastery 同步 Standard Schema，`maxRunsPerOrchestration` 默认 100（契约 08）；默认值与非法值诊断（越界/非整数/类型错）有测试；null 按 schemastery 语义回落默认值。
3. **服务层 FIFO**（`lib/fifo.js`）：`ServiceQueue` 入队/排干/关闭；槽内复合操作不与后续槽交错（契约 08「写入」）；单槽失败只 reject 该槽调用方、不毒化队列；`close()` 停新槽并排干。
4. **存储域**（`lib/storage.js`）：`defineDomain({ name: 'script_orchestrator', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip', tables: { orchestrations, runs } })`，省略 `global`；打开后逐条校验「表键 = 记录内 id/runId」，不一致按坏记录处置（经 domain 写链删除 + error 日志）；关闭委托 `domain.close()`。
5. **管理服务**（`lib/service.js`）：`createManagementService()` 提供 `list`（active 过滤、limit 1–500 默认 100、offset 分页、`nextOffset` 取尽为 null、按 id 稳定排序）；其余方法属票 25+。
6. **Connection 桥**（`lib/bridge.js`）：`createBridgeHandler` 最小形状校验（多余字段/类型错/越界 → `script_input_invalid`，`unexpected`/`format`/`range` + 准确 `field`）+ `{ok,value}`/`{ok,error}` envelope；`mountBridge` 把 `/script-orchestrator` 挂为 webServer prefix 路由。
7. **Host 入口**（`lib/index.js`）：async 生成器 `apply`——openStorage（失败即 reject，不 provide 不挂桥，无半初始化服务）→ provide `scriptOrchestrator` → 挂桥 → `yield` 卸载器（先摘桥 → 排干队列 → `domain.close()`，契约 08 关闭顺序）；`inject: ['storageDomain', 'connection', 'webServer']`。
8. **Web client**（`lib/client.js`）：手写 lazy-CJS（`__ModuleLoader__.load`，零构建）；`main` + `sidebar.panellist`（order 91）双 slot；面板三态（加载中 / 空列表 / 加载失败+重试）；数据经 `ctx.connection.rpc.call('/script-orchestrator', 'list', {})`；`connection/reset` 订阅触发权威回读；变体 C 高密度表格骨架（创建入口、详情模态、活动轮询属票 25+）。
9. **隔离集成验证脚本**（`scripts/verify-ticket24.ps1`）：一键全阶段验证（见下）。

### 包 / 目录结构

```
pkg/
  package.json          # @local/dsh-script-orchestrator 0.1.0（deps: dsh-util-time + schemastery + zod；peer: dsh-storage-domain）
  cordis.patch.yml      # 自插入 - id: script-orchestrator
  vitest.config.js      # node + client(jsdom) 双 project
  lib/
    index.js  config.js  fifo.js  storage.js  service.js  bridge.js  client.js
  test/
    config.test.js  fifo.test.js  storage.test.js  service.test.js  bridge.test.js  index.test.js  client.test.js
scripts/verify-ticket24.ps1
```

### 测试命令与结果

- 单元：`pkg` 目录内 `node pnpm.mjs exec vitest run` → **7 文件 45 测试全绿**（Config 8、FIFO 3、storage 4、service 3、bridge 18、index 4、client 5）。client 测试用 dev 镜像 react 18 + jsdom 渲染真实组件验证三态。
- 集成：`pwsh scripts/verify-ticket24.ps1` → **全部断言通过**。阶段：环境预检 → 隔离 profile 四件套（file: 依赖，`DSH_HOME=<repo>/.sandbox/s24/home`，profile `orch24`）→ pnpm install → `--dump-config` 出现 `# == @local/dsh-script-orchestrator` 与 `- id: script-orchestrator` → 无头启动（`--no-open`）→ 页面 `__DSH_BOOT__` graph 含本包行 → RPC `POST /script-orchestrator/list` 返回 `{ok:true, value:{items:[],total:0,nextOffset:null}}` → 空域惰性断言 + stderr 无错 → 杀端口进程冷重启 → list 仍空（权威回读恢复）→ 存储探针（预置 `probe-ok`/`probe-bad`/`run-aaaaaaaa` 三记录 → 重启 → list 恰含 probe-ok、键≠id 的被移除、键=id 的保留）→ 卸载（移除依赖+bundles → 重装 → dump-config 无条目、页面无本包行、RPC 通道 404）→ 杀端口进程清理。
- 浏览器实机（隔离 DSH 浏览器 tab）：侧边栏「全局面板」出现「脚本编排」入口（与「自动化任务」并列）→ 点击后 main 面板渲染「脚本编排 / 共 0 条 / 还没有编排。列表为 Host 权威数据（list 回读）」。截图：[evidence/ticket24-panel-empty.png](evidence/ticket24-panel-empty.png)。

### 隔离验证证据

- 全程自建 `DSH_HOME`（worktree 内 `.sandbox/`，gitignore），未触碰真实 `~/.dsh`；宿主终止均按端口监听进程杀（无孤儿宿主，脚本末尾与浏览器验证后均确认 3080 无监听）。
- `--dump-config` 有/无条目、页面 graph 有/无本包行、RPC 通道 200/404 三组对照断言覆盖「卸载无残留」。

### 实现偏差与依据（契约 → 宿主现实）

1. **桥挂载未用 `connection.rpc.handle`**（契约 11 指定）：`dsh-client-connection@0.2.2-rc.1` 的 `rpc.handle` 实现中 `owner.webServer` 经 Cordis trace 机制把服务解析锚定到提供者 fiber（client-connection 自身未注入 webServer），第三方插件调用必抛 `cannot get property "webServer" without inject`（沙箱实测复现，stderr 栈：`client-connection/lib/index.js:871` ← 我的 apply）。改为内联等价实现：`webServer.register` prefix 路由 + `connection.admit`（认证与 Host/Origin fence 复用内建）+ 与 `rpcFetchHandler` 对齐的 envelope 协议（client-request/server-response/gateway/bad-request/handler failure→500）。**浏览器侧契约面零改动**（`ctx.connection.rpc.call('/script-orchestrator', …)` 实测工作）。若上游修复 rpc.handle 可切回（`mountBridge` 是唯一挂载点，改动局部化）。
2. **存储记录 schema 用 zod 而非 schemastery**：`dsh-storage-domain` 的 `domainTable` 约定 `valueSchema.parse(raw)`（源码注释 "Record schemas are zod"，其自身 dependencies 即 `zod@4.4.3`）；schemastery 无 `.parse`，传入会导致全部记录在 open 时 parse 抛 TypeError → 被 backup-and-skip 整体误删（沙箱探针实测发现后修复）。schemastery 仅用于插件静态 Config（12-packaging 既定），二者分工已在代码注释说明。契约 08 未规定 schema 库；此偏差是宿主 API 事实约束，不改变存储契约语义。
3. **键≠id 记录的「按坏记录处置」实现为经 domain 写链删除**（而非 `.bak` 备份改名）：`backupRecord` 是后端 unit 内部 API，插件层无该面。等价语义「视为不存在」成立（本次与后续启动均不存在）；与契约 08 的差异（无备份副本）如实声明。
4. **记录 schema 为最小骨架**（`{id}`/`{runId}` 必填 + `passthrough` 保真未知字段）：完整字段与静态校验属票 25+（引入时收紧并升 schema，尚无存量记录、域版本仍为 1）。
5. **schemastery Config 对未知键透传、null 回落默认值**：为 schemastery 3.19 既定语义，契约未禁止；诊断断言覆盖非法值。

### 残余风险

1. `rpc.handle` 的 defSite 缺陷是宿主侧问题（上游修复前 `mountBridge` 内联实现承担契约面）；若宿主升级改动 `admit`/路由协议需同步。
2. 面板错误态在真实浏览器中未实机复现（触发需宿主半死状态）；以 jsdom 单测（react 渲染 + mock transport failure/业务错误 + 重试）覆盖。
3. Desktop 窗口内验证未执行（与 spec §6.3 一致，注入管线与 Web 同源已实证）。
4. `file:` 硬链接「rename 式重建断链」特性照旧（12-packaging 已知边界）；本票交付物为源码即产物，无重建步骤。
5. HMR 重挂行为未在本票验证（属后续面板票）；冷重启回读已验证。
