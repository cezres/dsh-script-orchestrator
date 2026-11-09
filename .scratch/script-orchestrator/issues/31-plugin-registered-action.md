# 31: 通过 plugin 动作调用注册能力

**What to build:** 其他插件能注册具名能力，用户的编排在判定命中后实时调用该能力；配置者和排障者能发现可用动作，并看到未注册、超时或执行失败的明确结果。

**Blocked by:** 30 — 按判定结果发出 event 动作

**Status:** resolved

- [x] `registerAction` 落实注册名格式、保留前缀和重名同步拒绝；`listActions()` 按名称排序返回 description，`script_view` 的 `availableActions` 与服务一致。
- [x] 创建/更新只校验注册动作名格式，不静态检查存在性；每次动作执行前实时查表，未注册或已摘除返回可见 `unknown_action`，不静默跳过。
- [x] 注册动作收到契约规定的 ActionContext，支持递归渲染后的 payload、signal 和 `report()` warnings；抛错与超时分别映射为 `action_error` 和 `timeout`。
- [x] disposer 满足幂等、同步、按 token 精确删除和服务实例隔离，所有权仅属调用方 `ctx.effect`；摘除不中止在途调用，只影响后续解析。
- [x] 一个测试插件能完成注册、被发现、被编排调用、注销及再次注册的全链验证，面板展示动作结果与警告。
- [x] 测试覆盖保留名、重名、四不变量、在途摘除、失败隔离、动作超时和 list/view 动作提示。

## Comments

### 做了什么

按票验收项 TDD（红-绿循环，先写失败测试）实施，交付「注册面开放 + plugin 动作超时接线 + 注册表/查表端到端 + 桥 listActions + 面板展示固化」：

1. **注册表注册面**（`lib/actions.js` `createActionRegistry().register`）：名字格式（恰好一个点 `<namespace>.<verb>`，两段各 `^[a-z][a-z0-9-]{0,29}$`，整体 ≤ 61，复用 `validation.js` 的 `REGISTERED_ACTION_PATTERN` 单一定义）、保留前缀 `script-orchestrator.`、definition 形状（对象/name 字符串/description 可选字符串/run 函数）与重名全部**同步抛 Error**（对插件作者的编程错误，不进契约 09 错误码表）；重名消息含冲突名、不覆盖既有注册。disposer 四不变量：**幂等**（disposed 标志）、**同步**（返回前完成 Map 删除——紧随同名重注册不误冲突）、**按 token 精确删除**（每次注册铸 Symbol token，disposer 只删 token 匹配的条目——旧 disposer 不误删同名新注册）、**实例内注册表**（entries 是实例闭包内 Map——服务整体替换时旧实例 disposer 不影响新实例）。所有权只属调用方：注册表不绑定任何 effect/清理，`registerAction` 自身不叠加（契约 06 明文）。
2. **服务面**（`lib/service.js`）：`registerAction(definition)` 同步方法（非 Promise）直接委托 `registry.register`；`listActions()` 快照按 name 排序返回 `{ name, description? }`（票 30 既有）；`view().availableActions` 与 `listActions()` 同源（同一注册表实例）。
3. **plugin 动作超时接线**（`lib/actions.js` `dispatchActions`，票 30 预留项）：`timeoutSeconds`（默认 30 秒，契约 05 公共约束）到期 → **先中止 ActionContext.signal**（契约 06 中止来源之一）→ 记 `failed timeout`（消息含动作名、注册名与秒数）→ **不再等待动作 Promise，串行继续**（实现完全无视 signal 时不得挂死整个 run）；迟到结算经 `.catch(() => {})` 吞掉（防游离 rejection 致命退出宿主，笔记 06-53）；超时先胜出时迟到的 reject 不改写为 `action_error`（race 语义保证优先级）；超时前 `report()` 的 warnings 保留在失败记录；渲染仍在执行前完成、不计超时（契约 05）。run 整体取消路径（`cancellation.controller.abort()`）语义不变：在途动作拒绝 → `action_error`、剩余动作 skipped、终态 canceled 优先（票 30 既有测试继续通过）。
4. **在途摘除**：注册摘除不中止在途调用（单测：动作执行中 dispose 自己后继续完成并按 succeeded 结算）；同 run 内后续对同名动作的解析实时查表得 `unknown_action`（无缓存）。
5. **桥 `listActions` 端点**（`lib/bridge.js`，契约 11 端点表补齐）：空对象/undefined payload → `{ ok, value: 快照 }`；多余字段/非对象 → `script_input_invalid`（unexpected/format + 准确 field）。
6. **面板**（`lib/client.js` 无代码改动）：RunCard 三段结果与 availableActions 展示为票 30 已通用化的实现；本票补 jsdom 真组件测试固化注册动作相关行为（plugin 成功 + `report()` 警告、`timeout` 错误码、可用注册动作 name + description 展示）。
7. **共享装配**（`lib/index.js` 无代码改动，票 30 预留）：单一注册表实例同时供 runner（执行期逐动作查表）与 service（快照/注册面）——index 接线测试断言 provided 服务的 `registerAction` 注册后 runner 派发解析、ActionContext 契约形状与 disposer 生效。
8. **隔离验证**（`scripts/verify-ticket31.ps1`）：注册能力探针插件（`ctx.inject` + `ctx.effect` 持有 disposer，契约 06 示例同款生命周期）+ 5 编排全链。

### 包 / 目录结构（票 31 增量）

```
pkg/
  lib/  actions.js（register 注册面 + disposer 四不变量 + plugin 超时接线）  service.js（registerAction）
        bridge.js（listActions 端点）  client.js（无改动；行为由测试固化）
  test/ actions.test.js（+18：注册面 12 + 在途摘除 1 + 超时块 6）
        service.test.js（+6 registerAction/listActions/availableActions）
        index.test.js（+2：共享注册表接线 + timeoutSeconds 全链接线）
        bridge.test.js（+2 listActions 端点；未实现端点名单收窄）
        client.test.js（+1 注册动作展示）
scripts/verify-ticket31.ps1（探针插件 + 5 编排，断言约 40 项）
```

### 测试命令与结果

- 单元+进程集成：pkg 目录内 `node <捆绑>\pnpm.mjs exec vitest run` → **14 文件 401 测试全绿**（judge 33、bridge 38、config 19、fifo 3、tools 27、actions 36、storage 14、triggers 18、scheduler 16、service 125、client 18、index 10、runner 38、execution.process 6；= 票 27 集成后的 371 基线 + 本票 30：actions +18（注册面 12 + 在途摘除 1 + 超时 6 等）、service +6、index +2、bridge +2、client +1）。超时用例用 vitest fake timers（默认 30 秒路径确定性推进）与真实计时器（index 全链 1 秒）双路覆盖。
- 隔离集成：`pwsh scripts/verify-ticket31.ps1` → **全部断言通过**（合并集成分支后复跑同样全绿）。阶段：环境预检 → 隔离 profile（`DSH_HOME=<repo>/.sandbox/s31/home`，profile orch31，file: 依赖指向 worktree pkg + 探针插件）→ 无头启动（`--port 0` OS 分配）→ 探针自检（坏名字/无点/保留前缀/缺 run/重名 5 例同步抛错落盘 + 首次注册成功）→ 桥 listActions 返回 6 动作按名排序带 description、view.availableActions 同源一致 → 创建 5 编排 + 非法创建（两段点号 → `script_input_invalid(format)` 不落库）→ 等最晚 nextOccurrence+15s：**O1** probe.echo 被编排调用（payload 递归渲染「验证注册动作 退出码 0」、orchestration/run/signal/report 契约形状、report 警告进 run 记录）→ succeeded；**O2** 同 run 内 [drop2 摘除, 调 echo2] → partial（drop succeeded + **unknown_action 实时查表**、echo2 未被调用）；**O3** [recycle3 同步摘除+紧随重注册, 调 echo3] → succeeded（解析到**新注册**，report 标记 echo3-v2b）；**O4** timeoutSeconds=2 挂起 → partial（failed `timeout` 消息含「超过 2 秒」、超时前 report 警告保留、后续 event 动作照常、探针记录 signal aborted）；**O5** 保留前缀名 `script-orchestrator.page` **create 通过**（静态只查格式）→ 运行时 failed `unknown_action` → stderr 无本插件错误 → 杀端口进程清理。

### 隔离验证证据

- 全程自建 `DSH_HOME`（worktree 内 `.sandbox/`，验证后已删除），未触碰真实 `~/.dsh`；宿主终止按端口监听进程杀（OS 分配端口，杀后确认无监听）。
- 注册面第一次经真实宿主的 `ctx.inject`/`ctx.effect`/`provide` 生命周期端到端验证（探针插件即「其他插件注册方」）；单测中注册表/时钟/timers 全注入。

### 实现偏差与依据（契约 → 现实）

1. **超时后不再等待动作实现收尾**：契约 05/06 只规定「超时 → `timeout`」与 signal 中止，未规定实现无视 signal 时等待多久；实现选择记 timeout 后立即串行继续（不 hang run），迟到的 resolve/reject 被吞——「重试无、每动作至多执行一次」语义不受影响，且规避了坏实现挂死整个 run 的风险。已在动作注释中明示。
2. **超时只接线 plugin 动作**：契约 05 公共约束表的动作超时按字段归属落在 plugin 动作（`timeoutSeconds` 字段仅 plugin 定义；event 为同步发出即忘；session 执行面属票 32/33，届时如需超时由该两票接线）。默认 30 秒与 1–300 范围（创建期校验）均按契约。
3. **definition 形状校验为同步 Error**（契约只明文名字/保留前缀/重名抛错）：缺 run、description 非字符串、非对象等同为调用方编程错误，同一处理面（同步 Error），消息可诊断；不进 09 错误码表。
4. **桥 listActions 的 payload 校验**：契约 11 端点表参数为 `{}`，实现接受 `{}`/省略，多余字段 → `script_input_invalid(unexpected)`——与既有桥端点的最小形状校验分层一致。
5. **面板浏览器实机未重跑**（沿用票 30 残余风险口径）：RunCard/availableActions 增量经 jsdom 真组件断言；注入管线与 Web 同源已实证（票 24/25/26）。票 36 实机验收时统一覆盖。

### 残余风险

1. 动作实现若在超时后仍长时间占用事件循环（如同步死循环），任何超时机制都救不了（JS 运行时事实），不属本票可承诺范围。
2. `report()` 在动作结算后迟到的调用可能写入已记录的 warnings 数组引用（票 30 既有行为；持久化经 `structuredCloneSafe` 定格，窗口极小且契约未规定迟到 report 的可见性）。
3. 探针仅验证单注册方插件；多插件同名注册的冲突面（先到先得、后者抛错）由注册表单测覆盖，未做多插件实机（生命周期与单插件同构）。
