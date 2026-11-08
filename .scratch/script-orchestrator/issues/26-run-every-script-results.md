# 26: 自动执行 every 编排并查看脚本结果

**What to build:** every 编排到点后自动运行脚本，用户能在面板看到 run 从受理到结算的过程以及退出码、超时和输出尾部等脚本结果。

**Blocked by:** 25 — 通过对话创建并查看 every 编排

**Status:** resolved

- [x] fixed-rate 按上一次 `scheduledAt` 推进，fixed-delay 在自动 run 未结算时保持 `nextOccurrence = null`、结算后从 `settledAt` 推进；手动 run 尚不影响自动序列。
- [x] runner 使用 argv 调用脚本，落实 cwd/allowedRoots 预检、env/stdin 适配、超时、`cancelReason` 分类和目录不存在时的 `spawn_failed`，不经过 shell。
- [x] 执行生命周期具备单飞屏障、全局并发与队列方向、run 两写和终态唯一基础；自动 skip/queue 均产生可解释的完整 run 记录。
- [x] 脚本退出后进入判定，零动作时按契约结算；输出按流保留解码尾部、`truncated = lossy`，收集超时与退出事实，不把正常非零退出自动等同执行失败。
- [x] 正常退出后仍有存活后代时，有界等待 `waitForExit()` 2000ms，再清理进程范围并记录 `descendants-terminated`；Windows 路径有实际进程集成测试。
- [x] `run-started`/`run-settled` 在对应持久写入与内存视图更新后发布，发布端异常兜底不影响主流程，listener 后立即 `view()` 能读到一致状态。
- [x] 面板在可见且有活动 run 时轮询并展示脚本阶段结果；单元与集成测试覆盖调度锚点、队列、两写、输出和进程清理。

## Comments

### 做了什么

按票验收项 TDD（红-绿循环，先写失败测试）实施，交付「every 自动执行 + runner 执行生命周期 + 输出双层收集 + 事件发布 + 面板轮询」：

1. **判定求值**（`lib/judge.js`）：`evaluateJudge(judge, facts)` 纯函数——谓词全表（exitCode 数字/not/in/min-max、signal、timedOut、durationMs 区间、stdout/stderr 的 regex+flags/contains/jsonPath/equals/notEquals/truncated、all/any、同对象多键 AND）+ 判定结果三态（规则下标 / fallback / 零动作）。零动作返回 `actionKeys: []`（「无 fallback 全未命中」「命中规则 actions 为空」均零动作）。
2. **执行引擎**（`lib/runner.js`，run 生命周期唯一拥有者）：
   - **触发受理**：`requestRun({ orchestrationId, trigger, scheduledAtMs })` 经 FIFO 单槽——写 1（queued 持久化）→ 自动触发对非 active 编排兜底 `skipped(disabled)`（触发与状态变更竞态防线）→ 单飞判定（overlap:skip 自动 skip；queue 排队上限 1、再溢出新者 skip；手动不被 overlap:skip 淘汰、占排队位）→ 全局排队上限 `maxConcurrentRuns×4` 溢出丢最旧 `skipped(concurrency)`（不区分来源，手动同样可被丢）→ 泵领槽。
   - **执行**：argv 直拼不经 shell；cwd 解析（script.cwd → defaultCwd → hostCwd）+ allowedRoots 规范化前缀预检 + 目录存在性预检（失败 → `failed` + `run.script.warnings` 记 `spawn_failed: …`/`cwd_not_allowed: …`，不调宿主）；stdin `{text}`→宿主 `{data}`；env 只传覆盖；`graceMs: 5000`；超时先置 `cancelReason='timeout'` 再 `terminate()`（分类按插件自置标志位，不猜 rejection 内容：未置位的同步 throw/异步 reject → spawn_failed 保留 cause；置位后 reject → 按超时结算、exitCode/signal 记 null；terminate 后正常 resolve → Windows Job 实测语义 `{exitCode:1, signal:null}`）。
   - **输出收集**：done 后按流 `readFrom(0)`——`truncated` 判定即 `lossy`（溢写存在不改变）、tail 取解码后末 2048 code point（U+FFFD 如实保留）、`stdoutSpillPath`/`stderrSpillPath` 记入（超 cap 撤回则缺省）；spill 文件读取与清理（裁剪/级联删除 best-effort unlink）属票 34，字段面已铺好。
   - **后代清理**：done 后有界等待 `waitForExit()` 2000ms（契约常量）→ 仍未清空则 `terminate()` 清进程范围 + `run.script.warnings` 记 `descendants-terminated`（Windows Job 实测行为见下方偏差 1）。
   - **结算**：spawn_failed → `failed` 跳过判定；脚本启动成功即进判定（exitCode/signal/timedOut 是判定输入不是失败判据；非零退出/超时零动作均 `succeeded`）；动作派发属票 30+，当前空派发（非零动作 run 按契约 09 汇总表 0 成功/0 失败 → succeeded，无动作结果记录，票 30 接真实派发后按汇总结算）；**终态唯一**：结算槽重读记录、已终态的迟到结算 no-op（不覆写、不重发事件）——`settleExternal` 是票 29 取消矩阵的接入点。
   - **fixed-delay 推进**：自动 run 进入任何终态（含 skipped）且编排仍 active、当前持久 trigger 仍为 every/fixed-delay 时，`nextOccurrence = settledAt + everySeconds` 并发 `changed`（手动 run 不推进；编辑代际防线=用当前持久 trigger 而非触发时快照）。
   - **停机**：停新触发 → 在途 run 有界等待 2s → terminate 清进程范围（进程树生命周期以 run 为上限）→ 记录保持非终态由下次启动 interrupted 收尾；完整取消矩阵（结算 canceled）属票 29。
3. **调度器**（`lib/scheduler.js`）：全插件单 timer（active 且 nextOccurrence 非空且 kind=every 的最早者）；到点经 FIFO 槽复核「nextOccurrence 仍是该计划且 status=active」（pause/edit 后旧 timer 重入 no-op）；fixed-rate 沿相位推演错过时刻（`scheduledAt` = ≤now 的最大计划时刻，合并为一次 run）并推进 `scheduledAt + everySeconds`（仍在过去则继续推进到未来、不逐条补跑——统一覆盖运行期迟到与停机错过合并，契约 02「重启与错过的触发」）；fixed-delay 触发后 `nextOccurrence = null` 等待结算（至多补一次、不推演）；cron kind 防御形状跳过（实现属票 27）。编排集合变更（create/结算推进）→ `reschedule()`。
4. **存储**（`lib/storage.js`）：runs 表 schema 收紧为契约 01 run 全字段 strict 形状（queued/skipped/结算各态、可选 spill 路径与 warnings、actions 结果项）；**启动维护**：非终态 run 统一标 `interrupted`（维护写不计两写）各发一条 `run-settled(interrupted)`、不自动重放，fixed-delay 编排的自动 run 以恢复结算时刻推进序列；孤儿清理与保留对账属票 35。
5. **服务/入口**：`service.view` 合并 runner 活动视图（running/judging/dispatching 内存态实时可见、结算后回落持久记录）；`service` 增 `onMutation` 钩子；`lib/index.js` 组装 runner+scheduler（inject 增 `subprocess`），卸载序「调度器停 → 工具/桥摘除 → runner 停机（清进程）→ 排干 FIFO → domain.close()」。
6. **配置**（`lib/config.js`）：新增 `maxConcurrentRuns`(2)/`defaultTimeoutSeconds`(300)/`maxOutputBytes`(262144)/`maxSpillBytes`(8388608，0 禁用)/`allowedRoots`([])/`defaultCwd`(可选)，非法值诊断 + 测试。
7. **面板**（`lib/client.js`）：详情模态 run 记录卡（RunCard）展示脚本阶段结果——状态/跳过原因中文、退出码、信号、已超时、耗时、已截断、输出尾部预览（truncated 前缀 …）、spill 提示、warnings；**活动轮询**：模态打开且存在非终态 run 时每 5 秒静默 `view(id)`（不可见时 tick 空转、全部终态/组件卸载即停；无活动 run 不启动——契约 11「存在非终态 run」字面语义，见偏差 8）。
8. **验证脚本**（`scripts/verify-ticket26.ps1`）与浏览器实机验证（见下）。

### 包 / 目录结构（票 26 增量）

```
pkg/
  lib/  judge.js  runner.js  execution-utils.js  scheduler.js（新增）
        config.js  service.js  storage.js  index.js  client.js（扩展）
  test/ judge.test.js  runner.test.js  scheduler.test.js  execution.process.test.js（新增）
        config.test.js  service.test.js  storage.test.js  index.test.js  client.test.js（扩展）
scripts/verify-ticket26.ps1
evidence/ticket26-panel-run-polling.png  ticket26-panel-run-settled.png
```

### 测试命令与结果

- 单元+进程集成：pkg 目录内 `node pnpm.mjs exec vitest run` → **14 文件 250 测试全绿**（judge 14、runner 28、scheduler 10、execution.process 6（真实 Windows 子进程：argv 字面量/非零退出/超时 Job 语义/输出双层 spill/后代清理）、storage 12、service 83、client 14、index 6、tools 23、bridge 36、triggers 5、config 19、fifo 3；较票 25 的 171 增加 79）。`execution.process.test.js` 经 devDependency `@deepseek-ai/dsh-subprocess-local@0.2.2-rc.1`（registry 镜像宿主同版，最小 fake ctx 实例化）直接 spawn 真实进程。
- 隔离集成：`pwsh scripts/verify-ticket26.ps1` → **全部断言通过**。阶段：环境预检 → 隔离 profile（`DSH_HOME=<repo>/.sandbox/s26/home`，profile `orch26`，file: 指向 worktree pkg）→ 无头启动 → 并行创建 6 个 every(60s) 编排 → T+63s：A fixed-rate run succeeded/exitCode 0/stdoutTail 含标记/`nextOccurrence = scheduledAt+60s`（相位推进）；B fixed-delay run 执行中（内存态可见）+ `nextOccurrence=null`；C/D/E 已触发（并发额度 2 排队）→ T+80s：B 结算 succeeded + `nextOccurrence = settledAt±0.1s+60s`；D 目录不存在 → failed + warnings spawn_failed；E exit 3 零动作 → succeeded；C 父退出留后代 → 超时兜底 terminate → timedOut=true + exitCode=1（Job 语义）+ **后代 pid 实测已死亡**；stderr 无本插件错误 → 杀宿主（H 的 run 在 running）→ 冷重启 → run 标 interrupted + fixed-delay 从恢复结算时刻推进 → 杀端口进程清理。
- 浏览器实机（隔离 DSH 浏览器 tab，evidence 截图）：创建 every(60s)+20s 脚本编排 → 侧边栏进面板 → 列表显示编排与下次时刻 → 到点触发后重开详情模态：**run 卡实时显示「执行中 run-1313553e」**（running 内存态经 view 合并），随后**无任何手动操作**轮询自动更新为「成功 · 退出码 0 · 20189ms」+ 输出尾部（LIVE-STAGE-1/LIVE-DONE-EXIT-2），与第一轮已结算记录（20177ms）并列；下次触发时刻相位推进正确。截图：[evidence/ticket26-panel-run-polling.png](evidence/ticket26-panel-run-polling.png)（执行中→轮询后）、[evidence/ticket26-panel-run-settled.png](evidence/ticket26-panel-run-settled.png)。

### 隔离验证证据

- 全程自建 `DSH_HOME`（worktree 内 `.sandbox/`，验证后已删除），未触碰真实 `~/.dsh`；宿主终止按端口监听进程杀（3080 已确认无监听）；实机沙箱同样清理。
- 单测中 subprocess/fs/时钟全部注入（fake）；真实进程路径在 vitest（registry 镜像包）与隔离宿主（真实 `ctx.subprocess`）双路验证，结论一致。

### 实现偏差与依据（契约 → 宿主现实 / 票序）

1. **Windows Job「父退出留存活后代」场景：`done`/`waitForExit` 均悬挂（本机实测，源码对照）**：`dsh-subprocess-local@0.2.2-rc.1` Windows Job 路径在 target 退出但 Job 非空时，runner 的 target-exit IPC 不上报（`launchWindowsJob` 的 direct 不 resolve），done（direct+输出流关闭/graceMs drain）与 waitForExit 悬挂，**直至 terminate()**（resolve `{exitCode:1, signal:null}`）。契约 03「done 结算脚本事实后有界等待 waitForExit() 2000ms → terminate → descendants-terminated」的顺序在该场景不可达（19 号票 W1/W2 未覆盖此路径，spec 残余风险 #8 的实测答案）。适配：该场景由 `timeoutSeconds` 兜底（terminate → timedOut=true + Job 语义 exitCode=1，**不是**父进程真实退出码 0——target-exit 事实不可达）；进程树生命周期以 run 为上限的安全意图仍满足（Job 全杀，实测后代 pid 死亡）。`descendants-terminated` 的记录路径（done 已结算但 waitForExit 2000ms 未清空）以 fake 单测覆盖实现；真实 Windows 宿主下该路径实测不可达。**建议**：上游若改为 target-exit 即发 done，契约路径自然生效；或契约按宿主现实修订该节（后续票/ADR 处理）。
2. **判定谓词求值已完整落地（票 30 范围的前置实现）**：「零动作按契约结算」依赖准确谓词求值（否则零动作判定本身错误），故完整实现谓词全表；模板渲染与三类动作执行仍属票 30+——当前非零动作 run 空派发，按契约 09 汇总表 0/0 → succeeded 且无动作结果记录（票 30 接入后按真实汇总结算）。
3. **spawn_failed/cwd_not_allowed 在 run 记录中的承载**：契约 09 只规定终态（failed）与工具错误码，未规定原因在 run 记录中的字段；实现记入 `run.script.warnings`（确定性文案 `spawn_failed: …`/`cwd_not_allowed: …`，供 UI/排障可解释）。工具/服务层的 `cwd_not_allowed` 错误码路径随票 28 手动执行再接线。
4. **调度推进发 `changed`、不改 `updatedAt`**：nextOccurrence 推进属持久可见变更（面板/订阅方应收到失效提示），故发；但调度推进不是内容编辑，不改 `updatedAt`（避免无谓触发乐观并发 `script_conflict`）。
5. **fixed-rate 错过合并算法**：`scheduledAt` = 沿相位从保留计划推演到 ≤now 的最大时刻（运行期迟到与停机错过统一为「合并为一次、推进到未来、不逐条补跑」，契约 02「重启与错过的触发」）。重启恢复的完整矩阵（cron、暂停期补跑边界等）属票 35。
6. **启动维护范围**：本票做 ①非终态标 interrupted + fixed-delay 恢复推进（崩溃收尾是 run 写入的必要配套）；②孤儿清理、③保留对账属票 35。interrupted 的 `run-settled` 载荷 script 对象不带 warnings（契约 06 载荷纪律）。
7. **devDependency `@deepseek-ai/dsh-subprocess-local@0.2.2-rc.1`**：registry 镜像宿主同版（peer 面不受影响——只在测试 import，不进 lib 运行时）；经最小 fake ctx（reflect/effect）实例化 `LocalSubprocessRuntime`（Cordis Service 基类只消费这两个面，源码核实）。koffi/node-pty 构建脚本被 pnpm 忽略但 Windows Job 路径实测可用（koffi 自带 prebuild）。
8. **面板轮询启动条件按契约字面**：「存在非终态 run 时」才轮询——模态打开时无活动 run 则不启动，自动触发发生在打开期间时需重开模态或点「刷新」（列表重读联动模态重挂载）触发一次 view 后轮询接管。契约 11 无事件推送下这是既定刷新模型；若后续票想让面板「发现新出现的活动 run」，需对 active 编排做低频 list 轮询（超出本票契约面）。
9. **fixed-delay skip 也推进序列**：契约 02 末段「overlap:skip 时自动 run 记为 skipped 并以其 settledAt 推进」在 `settleSkip` 路径实现（单测覆盖：手动占用单飞 → 到点自动 skip → skipped 结算即推进）。

### 残余风险

1. 偏差 1 的 Windows Job done 悬挂是宿主 0.2.2-rc.1 实测行为；若上游变更（target-exit 即发 done），runner 的 2000ms 有界等待路径自动生效、超时兜底路径仍安全（ terminate 幂等）。
2. 长输出（>maxOutputBytes）下 stdout/stderrTail 是内存尾部而非全量——判定谓词（regex/contains）也只在已收集文本上求值（契约 04 原文如此）；需要全量判定的场景等票 34 的 spill 完整读取。
3. 事件时序「listener 后 view() 一致」以单测覆盖（run-started 在内存更新后、run-settled 在持久写与 overlay 清理后发布）；宿主内真实 listener 的端到端（探针插件订阅）未做——事件面与桥/工具同一 emit 通路，风险低。
4. `runner.shutdown` 的 2 秒有界等待内未结算的 run 会被 terminate 清进程但记录留非终态（下次启动 interrupted）；「卸载=取消结算 canceled」的完整语义属票 29。
5. 面板 fmtTime 显示 UTC 时刻（ISO 字符串直显，未做本地化）——票 25 既有行为，保持。
