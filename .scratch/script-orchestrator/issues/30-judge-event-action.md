# 30: 按判定结果发出 event 动作

**What to build:** 用户能在编排中配置判定规则与 event 动作，脚本结算后按首匹配或 fallback 发出对应 Cordis 事件，并在面板查看判定命中和动作结果。

**Blocked by:** 26 — 自动执行 every 编排并查看脚本结果

**Status:** resolved

- [x] 判定 DSL 覆盖全部契约谓词、首匹配、fallback、`matchedRule` 零下标与 `usedFallback`；脚本正常退出无论退出码或超时都进入判定。
- [x] 创建/更新可配置 judge 与 event 动作，静态校验动作键引用、事件短名和保留名；非法配置不落库。
- [x] 模板按契约渲染标量、`json:` 和递归 payload，未知变量与 JSON 失败对称处理，warnings 确定性保留最近 20 条，只有空 prompt 产生 `template_invalid`。
- [x] event 动作按声明顺序串行执行并发出正确全名与 JSON 安全载荷；单动作失败不中断后续动作，dispatching 取消停止剩余派发且 run 终态优先。
- [x] `action-settled` 与 `run-settled` 按动作及持久写序发布并保证回读一致；listener 异常不影响主流程，64 KiB 按最终 JSON UTF-8 字节计量并以 code point tail 兜底。
- [x] 面板居中模态展示脚本、判定、动作三段结果和 warnings；测试覆盖谓词、模板、事件载荷、失败隔离、取消和事件时序。

## Comments

### 做了什么

按票验收项 TDD（红-绿循环，先写失败测试）实施，交付「判定完整化 + 模板渲染 + event 动作端到端 + 事件时序 + 面板三段结果」：

1. **模板渲染**（`lib/judge.js`，契约 04「模板变量」）：`renderTemplate`/`renderPayload`/`buildTemplateVariables`/`appendWarning`——变量全表折算（`exitCode`/`signal` null → `"null"`、`truncated`/`timedOut` → `true`/`false`、`matchedRule` → 下标/`fallback`/`none`）；`\{{` 转义字面 `{{`；单次替换不对结果再展开；未闭合 `{{` 原样保留；`{{json:<path>}}` 惰性解析 stdout，非合法 JSON / 路径缺失与未知变量完全同构（空串 + 确定性 warning `stdout is not valid JSON` / `json path missing: <path>` / `unknown variable: {{name}}`）；payload 结构递归渲染（只渲染字符串值、对象键字面保留、标量原样、json: 非字符串按 JSON 文本插入，恒为合法 JSON）；warnings 追加即裁「保最近 20 条」。
2. **动作派发器**（`lib/actions.js` 新增，契约 05/06/09）：`dispatchActions` 按 actionKeys 声明序**串行**执行、单动作失败仅记录不中断（失败隔离）；event 动作发出 `script-orchestrator/<短名>` 固定四键载荷（全新对象、JSON 安全），listener 同步抛错由发布端 try/catch 记 `event_listener_failed`、动作仍 succeeded（发出即忘）；plugin 动作**逐动作执行前实时查表**（不缓存），未注册/已摘除 → failed `unknown_action` 不静默跳过，已注册以 ActionContext 调用（orchestration/run/payload 已渲染/signal/report，report 与模板警告共用 warnings 数组），抛错 → `action_error`；session 动作本票交付 prompt 渲染与 `template_invalid` 判定（渲染后去首尾空白为空即触发、仅该动作 failed），执行面以 `action_error` 占位（票 32/33 替换）；取消请求后停止派发剩余动作（记 `skipped`），在途动作经其 signal 中止、结果如实记录；`aggregateRunStatus` 按契约 09 汇总表（skipped 不计入成功/失败）；`createActionRegistry` 提供 resolve/snapshot 面（registerAction 与 disposer 四不变量属票 31）。
3. **runner 集成**（`lib/runner.js`）：脚本退出（无论退出码/超时）→ `judging` 内存态（判定字段进 live overlay）→ 非零动作 `dispatching` 内存态（**不落盘、不占 FIFO 槽**，逐动作进度并入 live 视图供面板轮询）→ 结算槽写 2 携带 `matchedRule`/`usedFallback`/`actions[]`，终态 = 取消优先（`dispatchCanceled` → `canceled`）否则按汇总表；`action-settled` 按动作执行序在**写 2 与内存视图更新之后**、`changed`（fixed-delay 推进）与 `run-settled` 之前发布（回读一致性单测：listener 内读存储已见终态与完整动作）；`requestCancel(runId)` 为 dispatching 取消入口（置请求 + abort 在途动作 controller，返回 true；非派发中返回 false——queued/running 矩阵与 exec.signal/delete 接线属票 29）；64 KiB 预算与 code point tail 兜底为票 26 既有实现，本票补齐直接测试（依次减半、代理对完整、其余字段不截）。
4. **静态校验**（`lib/validation.js`，票 25 已铺全量，本票验证收口）：谓词全表键白名单/形态、regex 编译与 flags `i/m/s`、jsonPath 极简语法、动作键引用存在性（`missing` + 精确 field 路径）、事件短名正则与四个保留名（`reserved`）、plugin 注册名格式——非法输入 `script_input_invalid` 不落库（隔离验证实测两次非法 create 后列表数量不变）。update 路径将复用同一校验器（edit 服务面属票 28）。
5. **注册表装配**（`lib/service.js` + `lib/index.js`）：单一 `createActionRegistry` 实例同时注入 runner（执行期查表）与 service（`listActions` 快照/`availableActions`）——票 31 开放 registerAction 后两端自动同源。
6. **存储**（`lib/storage.js`）：`run.actions[].status` 枚举补 `skipped`（契约 05 三态对齐；dispatching 取消的未派发动作记录形状）。
7. **面板**（`lib/client.js`）：RunCard 三段结果——判定段（命中规则 N / fallback / 未命中（零动作）；skipped 与 spawn_failed 不展示）、动作段（状态色点 + 名称 + 类型中文 + `error.code：message` + warnings 橙色）；脚本段与轮询路径沿用票 26。
8. **隔离验证**（`scripts/verify-ticket30.ps1`）：自建 DSH_HOME/profile orch30 + **事件探针插件**（订阅 `run-started`/`run-settled`/`action-settled` 与三个自定义短名，逐条 JSONL 落盘）。

### 包 / 目录结构（票 30 增量）

```
pkg/
  lib/  actions.js（新增）  judge.js  runner.js  storage.js  service.js  index.js  client.js（扩展）
  test/ actions.test.js（新增 18）  judge.test.js（+20）  runner.test.js（+12）  storage.test.js（+1）
        service.test.js（+1）  index.test.js（+1）  client.test.js（+1）
scripts/verify-ticket30.ps1（探针插件 + 三编排 + 非法配置不落库 + 事件时序断言）
```

### 测试命令与结果

- 单元+进程集成：pkg 目录内 `node pnpm.mjs exec vitest run` → **14 文件 302 测试全绿**（judge 33、actions 18、runner 39、storage 13、service 78、index 7、client 16、tools 23、bridge 36、execution.process 6、scheduler 10、triggers 5、config 19、fifo 3；较票 26 的 250 增加 52）。
- 隔离集成：`pwsh scripts/verify-ticket30.ps1` → **全部断言通过**。阶段：环境预检 → 隔离 profile（`DSH_HOME=<repo>/.sandbox/s30/home`，profile `orch30`，file: 依赖指向 worktree pkg + 探针插件）→ 无头启动（`--port 0` OS 分配）→ 创建三编排（A：jsonPath `$.status=degraded` 命中规则 0 → event 载荷渲染 + plugin 未注册；B：exit 7 全未命中走 fallback；C：session prompt 含未知变量渲空）+ 两次非法 create（保留短名 `reserved`、引用未定义键 `missing`）均 `script_input_invalid` 且列表仍 3 条 → T+70s：A run **partial**（emit-degraded succeeded 带 `unknown variable: {{nope}}` warning + page-missing failed `unknown_action`）、B **succeeded**（usedFallback=true → emit-bad）、C **failed**（`template_invalid`）→ 探针日志断言 A 的五行事件序 **run-started → 自定义事件 deploy-degraded（派发期间）→ action-settled×2（写 2 后按执行序，failed 者带 `error.code`）→ run-settled(partial)**、自定义载荷 `payload.summary` 已渲染（`验证派发 → degraded x3（164ms）`）、未知变量渲空串、`run.exitCode=0`/`run.status=succeeded`；B 收到 deploy-bad 且 run-settled `usedFallback=true`；stderr 无本插件错误 → 杀端口进程清理。

### 隔离验证证据

- 全程自建 `DSH_HOME`（worktree 内 `.sandbox/`，验证后已删除），未触碰真实 `~/.dsh`；宿主终止按端口监听进程杀（本轮端口为 OS 分配的 59966，杀后确认无监听）。
- 事件面第一次经真实宿主 emit 总线端到端验证（探针插件订阅）；单测中 emit/注册表/时钟全部注入。

### 实现偏差与依据（契约 → 票序/宿主现实）

1. **event 动作载荷 `run.status` 取「脚本阶段完成即 `succeeded`」**：契约 05 示例为 `"status": "succeeded"`，但事件在 dispatch 阶段发出、run 终态未知（后续动作可能把终态变成 partial/failed）。能进派发的 run 脚本阶段必已正常完成（spawn_failed 直接 failed 跳过判定），故该字段恒为 `succeeded`——与示例字面一致、可编程判断稳定，真实退出码由 `run.exitCode` 携带，订阅方拿终态应订阅 `run-settled`。经第二模型仲裁确认（置信 0.986）。plugin ActionContext 的 `run.status` 同口径。
2. **`action-settled` 对 skipped 动作也发布**：契约 06「单个动作结算」未排除因取消未派发的动作；每条 run.actions[] 记录（含 skipped）各发一条、按执行序。failed 动作带 `error: { code, message }`（06 载荷表 `error?` 的字面；09「事件载荷不含错误细节」理解为不含堆栈/大对象——与 run 记录同形状）。
3. **session 动作执行面占位**：本票交付渲染与 `template_invalid`；创建/投递/回收执行属票 32（persistent）/33（ephemeral），当前以 failed `action_error`（消息注明后续票）占位，保证失败隔离与汇总路径可测。
4. **plugin 动作 `timeoutSeconds` 未接线**：契约 06 ActionContext.signal 的中止来源之一「动作超时」与 1–300 秒计时属票 31；本票 signal 仅接整个 run 取消。渲染在动作执行前完成、不计超时（渲染同步完成，时序天然满足）。
5. **`requestCancel` 仅覆盖 dispatching**：queued/running 阶段的取消（terminate + cancelReason='cancel' 路径）与 exec.signal/delete/卸载接线属票 29。**给票 29 的接线提示**：dispatching 中的 run 应经 `requestCancel`（自然结算写 canceled、保留动作结果）；直接 `settleExternal(canceled)` 会因 first-write-wins 先落终态而丢失在途动作结果。
6. **event 动作未定义 payload 时载荷省略 `payload` 键**：契约未规定该形状（示例恒带）；省略保持 JSON 安全与四键最小形状。
7. **动作键未定义的防御分支**：静态校验后不应出现；派发器遇 `actions[key]` 缺失记 failed `internal_error`（不中断后续），kind 取 `event` 仅为满足记录形状。
8. **并行 worktree 端口冲突（对后续票有普适价值）**：第一轮验证在 T+70s 出现 unauthorized/ResponseEnded——排查发现**票 27 的沙箱无头宿主（--profile orch27）正占用默认端口 3080**，两个 worktree 的宿主互相顶替。验证脚本已改 `--port 0`（OS 分配空闲端口，实际端口从打印的 token URL 解析），彻底消除并行冲突；建议票 27+ 的 verify 脚本同样处理（当前 verify-ticket26.ps1 仍硬编码默认端口）。

### 残余风险

1. 面板浏览器实机未重跑（票 26 已验模态挂载与活动轮询路径，基础设施未变；本票 RunCard 三段增量经 jsdom 真组件断言文本）。下次实机验收（票 36）时顺带覆盖。
2. event 动作在真实宿主内只验证了「单订阅方探针」；多 listener 注册序与同步抛错中断后续 listener 属宿主行为（契约 06 已如实声明），单测以注入 emit 覆盖。
3. `{{json:}}` 解析源是收集到的 stdout 全文（≤ `maxOutputBytes` 内存尾部，契约 04 原文口径）；长输出全量判定仍待票 34 spill 完整读取。
