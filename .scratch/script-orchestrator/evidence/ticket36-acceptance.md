# 票 36 · Windows 全链路交付验收记录

> 验收对象：`@local/dsh-script-orchestrator` v0.1（单包双面：Host + Web client）
> 验收分支：`integrate/script-orchestrator`（票 24–35 已合并 + 票 36 审查修复）
> 验收日期：2026-11-09 · 沟通与文档语言：简体中文
> 原则：不修改真实用户 profile；所有隔离验证使用独立 `DSH_HOME` 沙箱（`.sandbox/sNN`）；浏览器侧使用隔离 DSH 浏览器。

## 1 · 实际环境

| 项 | 值 |
|---|---|
| OS | Windows（win32 x64），中文系统 |
| DSH 宿主 | `0.2.2-rc.1`，`C:\Users\cezre\AppData\Local\Programs\DeepSeek Harness`（`resources\runtime\cli\bin\dsh.cmd`） |
| Node | `v24.21.0`（捆绑：`C:\Users\cezre\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`；系统 PATH 无 node） |
| pnpm | `11.28.5`（`…\dependencies\pnpm\bin\pnpm.mjs`，经捆绑 node 调起） |
| 包管理 | `file:` 安装进隔离 profile；`pnpm install --no-frozen-lockfile`；`ERR_PNPM_IGNORED_BUILDS`（koffi/node-pty 构建脚本被 pnpm 11 忽略）为已知非致命提示（预编译二进制可用，真实进程测试全过） |
| 验证方式 | 每个验收脚本自建 `DSH_HOME` + 独立 profile 四件套，`dsh web --port 0`（OS 动态端口）无头启动，终止按端口监听进程杀 |

## 2 · 测试矩阵结果

### 2.1 单元 / 进程集成（vitest）

命令（`pkg/` 下，PATH 加捆绑 node\bin）：

```
node <…>\pnpm\bin\pnpm.mjs test
```

结果：**17 个测试文件 / 580 个用例全绿**（约 11s）。覆盖：scheduler 纯函数与锚点、runner 执行生命周期/两写/取消矩阵/输出收集/后代清理（真实 Windows 子进程）、judge 谓词与模板、actions 三类动作、registry、session 两模式、retention 裁剪、storage 启动维护/坏记录/I-O 恢复、tools 严格校验与错误映射、bridge 端点、client 三态/模态/轮询/编辑入口、config、fifo、index 装配与关闭顺序。

### 2.2 隔离集成验收矩阵（13 个脚本，修复后最终代码）

命令（仓库根）：

```
pwsh -NoProfile -File scripts/verify-ticket24.ps1   # … 依次 24–36
```

| 票 | 脚本 | 结果 | 耗时 | 覆盖要点 |
|---|---|---|---|---|
| 24 | verify-ticket24.ps1 | **PASS** | 20s | file: 安装、`--dump-config` 条目、无头启动与注入、空 list 闭环、冷重启回读、存储探针（合法/坏键/旧骨架/非终态 run→interrupted）、卸载无残留 |
| 25 | verify-ticket25.ps1 | **PASS** | 10s | 对话创建入口、every 严格校验、持久化与形状、nextOccurrence、paused 创建、冷重启保持 |
| 26 | verify-ticket26.ps1 | **PASS** | 92s | 自动触发、fixed-rate 相位/fixed-delay 结算推进、超时 Job 语义、后代清理、spawn_failed、非零退出≠失败、崩溃恢复 interrupted |
| 27 | verify-ticket27.ps1 | **PASS** | 501s | 五位 cron 校验矩阵、自动执行与持久化、DST 绕过（库保证）、停机 300s 错过合并为 1 条、暂停不补跑 |
| 28 | verify-ticket28.ps1 | **PASS** | 143s | 非调度不重锚、调度编辑重锚、CAS、cron 更新无解拒绝、pause/resume 幂等与不补跑、手动 run 受理即返回、delete 级联（票 29） |
| 29 | verify-ticket29.ps1 | **PASS** | 6s | 在途 run 的 delete 级联（removedRuns、取消耗时）、list/view 回读、delete CAS、全状态删除 |
| 30 | verify-ticket30.ps1 | **PASS** | 76s | 判定命中/fallback/template_invalid、event 载荷渲染、plugin 未注册 unknown_action、事件时序（run-started→自定义→action-settled→run-settled） |
| 31 | verify-ticket31.ps1 | **PASS** | 81s | 注册面自检、listActions 同源、plugin 调用/摘除实时查表/重注册/动作超时 signal 中止/保留前缀运行时拒配 |
| 32 | verify-ticket32.ps1 | **PASS** | 146s | persistent session 缺省链、banner/plain、标题、cwd 越界、preset_unknown、每 run 新建、冷重启留存 |
| 33 | verify-ticket33.ps1 | **PASS** | 123s | ephemeral 零延迟/延迟/活动推迟回收、liveness、preset 失败零会话、teardown 非删除、冷会话重开 |
| 34 | verify-ticket34.ps1 | **PASS** | 9s | W2a 完整 spill 可读、保留裁剪（settledAt 定序、spill 清理）、文件不存在排障态、W2b 超 cap 撤回 |
| 35 | verify-ticket35.ps1 | **PASS** | 11s | 两次冷启动：崩溃 run→interrupted、启动保留对账补裁、列表权威回读、执行引擎重建 |
| 36 | verify-ticket36.ps1 | **PASS** | 49s | 交付面（engines/exports/deps/`--dump-config`/`__DSH_BOOT__`）、五工具 smoke（服务路径）、every 判定+三动作+四类事件+自定义事件、cron 自动触发、权威回读、delete 级联不发 changed |

原始日志：`evidence/ticket36-verify-NN.log`（每脚本全量输出）、`evidence/ticket36-matrix.log`（汇总）。

### 2.3 Windows W1/W2 复测

| 项 | 证据 |
|---|---|
| W1 原生 Job terminate | `pkg/test/execution.process.test.js`「超时：timeoutSeconds=1 挂起脚本 → terminate → timedOut=true + Windows Job 语义 {exitCode:1, signal:null}」；verify-ticket26 在隔离宿主实测同类语义 |
| W2a 完整 spill 可读 | 进程测试「输出双层收集…spill 文件可读全量」；verify-ticket34 轮 1 经 `spill` 端点读到 200 行全量（含首末行） |
| W2b 超 cap 撤回 | verify-ticket34 轮 2：`maxSpillBytes=500` 时 `stdoutSpillPath` 缺省、`truncated` 仍 true、内存尾部不受影响 |
| 正常退出后存活后代清理 | 进程测试「父退出留后代：done 悬挂由超时兜底 → terminate 清 Job（后代确实死亡）」；已知偏差见 §4 |

### 2.4 取消与 abort 语义

- 工具 `exec.signal` → run 取消：`tools.test.js`（wait:false 受理期间中止 → 恰好一次 cancelRun + waitForRun；wait:true 同场景 → AbortError 静止；预中止信号立即补一次取消）；runner 取消矩阵单测（queued/running/dispatching；judging 不响应）。
- Connection UI abort 只停等待：`verify-ticket36.ps1` 实测 run 端点受理即返回（52ms，脚本跑约 2s）；桥层不传 UI signal（契约 11）；`service.run` 的 signal 仅受理前 `throwIfAborted`。
- 事件后权威回读、轮询停止条件、删除前后可见性：client jsdom 测试 + verify-ticket26/30/36 的 list/view 回读断言。

### 2.5 面板（Web client）

- 对话式入口：`verify-ticket25.ps1` 浏览器实测（＋新建 → 新会话注入引导 prompt）；详情模态「编辑」按钮与 startEditSession 由 jsdom 测试覆盖（审查修复新增）。
- 居中模态 run 历史三段结果：`verify-ticket26/28/29` 浏览器实测截图（`evidence/ticket2*-*.png` 见各票 Comments 引用）与 jsdom 测试；本票 jsdom 全量回归通过。
- 说明：面板 UI 验收以「隔离 DSH 浏览器实测（票 25/26/28 存证）+ jsdom 组件测试」组合完成；本票未重跑浏览器截图（Desktop 窗口未验证属既有残余风险）。

## 3 · 安装 / 运行 / 卸载 / 故障须知

| 契约 12 验收项 | 结果 |
|---|---|
| 安装（file:） | `verify-ticket24/36`：`file:` 依赖落 profile node_modules，`--dump-config` 出现 `- id: script-orchestrator`，页面 `__DSH_BOOT__` client graph 含本包；`engines.dsh` 精确锁 0.2.2-rc.1、exports `.`/`./client`/`./package.json`、`dsh.client.platform=web`、`private:true` 已断言 |
| 运行 | 侧边栏「脚本编排」+ main slot 面板渲染（隔离浏览器实测，票 25/26/28） |
| 冷重启 | `verify-ticket24/25/32/33/35`：编排/run/会话/存储恢复与权威回读 |
| HMR | **未验证**（需要 `pnpm run dev:web` 宿主开发构建；如实列为残余风险） |
| 卸载 | `verify-ticket24` 阶段 7：移除依赖 + bundles 后 `--dump-config` 与页面 graph 无残留、桥通道 404 |
| 坏 client 包 = 启动级故障 | 部署须知已在契约 12；本票未构造坏包实例（如实列为残余风险；宿主行为已在票 16 研究实证） |

## 4 · 残余风险与证据边界（如实交接）

1. **macOS 未实机验证**：PGID 终止回退与 signal 语义仅按源码事实实现；本验收门仅 Windows。
2. **裸 `.cmd`/`.bat` 不承诺**：契约明确，推荐 `pwsh -Command` 包装；验收矩阵不含。
3. **Desktop 窗口内面板未验证**：注入管线与 Web 同源已实证，Desktop 窗口未跑。
4. **tsdown 常规构建档未验证**：简化档零构建已定案。
5. **HMR 未验证**、**正常 LLM 回合的 append/lastPromptAt UI 可观测性未实测**、**真实停用/卸载 teardown 以杀宿主近似**、**ephemeral 回收竞态仅承诺 durable inbox 边界**（票 21/23/26/32/33 Comments）。
6. **`flush()===true` 只是投递管线接受**（契约 v0.1p 修订）。
7. **`file:` 安装 rename 式重建断链**为推断（票 16）。
8. **Windows「父退出留存活后代」**：`done` 与 `waitForExit` 悬挂直至 terminate（票 26 Comments + 10-decisions v0.1r ⑤）；实现以超时兜底（`timedOut=true`、`exitCode=1`、不伪造父进程退出码），进程树以 run 为上限（后代实测被清理）。
9. **新增 `spill` 端点**已回写契约 11（v0.1r）；**存储记录 schema 用 zod**、**`connection.rpc.handle` 对于第三方不可用→内联等价挂载**均已回写契约/决策（v0.1r）。
10. **审查修复引入的实现决策**：judging → dispatching 之间让出一个微任务边界，使 judging 取消「不响应」状态可观测（纯内存、毫秒级，不影响计时/事件顺序）。
11. 全库 run 上限 1000、`maxSpillBytes` 默认 8 MiB 等固定值未做可配置扩展（契约既有范围）。
12. **原型分支 `proto/*` 与 `research/*` 从未合并**：本验收仅合并 `impl-*` 工作分支；原型产物按 spec §7 抛弃式处理，已确认不在集成分支历史中。

## 5 · 命令清单（可复现）

```powershell
# 单元/进程/集成测试
cd pkg
$env:PATH = 'C:\Users\cezre\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;' + $env:PATH
node C:\Users\cezre\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs test

# 隔离验收矩阵（仓库根，每个脚本自建沙箱与动态端口）
pwsh -NoProfile -File scripts/verify-ticket24.ps1
# … 25–36 同形；汇总见 evidence/ticket36-matrix.log
```

## 6 · 结论

- 单元 / 进程 / 集成测试矩阵：**全绿**（580 用例）。
- 隔离集成验收矩阵（13 脚本）：**全部 13 个脚本 PASS（0 FAIL）**。
- 五工具 smoke、every/cron 自动执行、判定三动作、四类事件、权威回读、删除级联：**通过**。
- 已知残余风险如 §4 如实交接；macOS 仅保留源码证据声明，不作为验收门。
