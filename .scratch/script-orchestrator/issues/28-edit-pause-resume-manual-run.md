# 28: 编辑触发、暂停/恢复并手动执行编排

**What to build:** 用户能通过对话修改已支持的编排配置，在面板暂停、恢复或手动执行编排，并观察到与契约一致的状态、下次触发时刻和 run 返回。

**Blocked by:** 27 — 通过 cron 编排按计划执行

**Status:** resolved

- [x] `script_edit` 支持 update/pause/resume，更新已支持字段时完成静态校验、持久化和写后回读；仅调度字段变化重建计划，非调度编辑不重锚。
- [x] `expectedUpdatedAt` 对 update/pause/resume 做乐观并发检查，冲突返回 `script_conflict`；pause/resume 按状态设置语义幂等 no-op，不错误重锚 fixed-delay。
- [x] 调度编辑使用编辑代际或等价机制，旧 run 结算不能覆盖更新后的 fixed-rate/cron 计划；fixed-delay 旧自动 run 未结算时按契约保持等待。
- [x] `script_run` 支持 wait=true/false、尽力等待上限和 paused/ended 手动执行；手动 run 不移动自动计划，不被 `overlap:skip` 淘汰，但可被全局队列溢出丢弃并返回可见 skipped。
- [x] 面板行内暂停/恢复/执行操作经 Connection 调用并立即回读；run 端点受理即返回，UI abort 只停止等待，不取消已受理操作或 run。
- [x] 测试覆盖各状态 no-op、CAS、触发重锚、手动排队、等待超限、Connection abort 只停止等待和面板操作结果。

## Comments

### 做了什么

按票验收项 TDD（红-绿循环，先写失败测试，共 7 个切片）实施，交付「edit 三 action + 手动执行 + 面板行内操作」端到端：

1. **service.edit**（`lib/service.js`，语义唯一权威）：
   - **形状校验**（`validateEditInput`）：id/action 必填、action 枚举、patch 仅 update 且至少一个字段、expectedUpdatedAt 字符串或 null、多余字段 unexpected；未知 id → `script_unknown`（FIFO 槽内先 CAS 后动作）。
   - **乐观并发**：expectedUpdatedAt 对 update/pause/resume（及 delete）生效，不匹配 → `script_conflict { expected, actual }`；null = 「此前没有更新时间」（本域记录恒有 updatedAt，null 恒冲突——防御面等价，见偏差 2）。
   - **pause**：仅 active 生效（paused+nextOccurrence=null+updatedAt 推进+发 changed）；paused/ended 幂等 no-op（返回当前 View、不写库、不发 changed、不改 updatedAt）。
   - **resume**：仅 paused 生效，按契约 02 恢复表重锚（fixed-rate=resumedAt+间隔、cron=严格晚于 resumedAt 的下一匹配、fixed-delay 视未结算旧自动 run 决定锚定或保持 null——手动 run 在途不阻塞）；**运行期意外无解（含 5 年窗口外）→ ended 防御终态**；active/ended 幂等 no-op（不重锚 fixed-delay）。
   - **update（`applyUpdate`）**：patch 与当前值合并成完整输入走 create 同源校验（`validateOrchestrationInput`，enabled/overlap 显式携带当前值防默认值覆盖）；**调度字段变化**（trigger 深比较，键排序稳定序列化）→ 编辑表重锚；**enabled 变化走暂停/恢复规则**（false=暂停、true=恢复语义）；非调度编辑不重锚；**ended 经重算触发复活为 active**（契约 07），非调度编辑不复活；**更新路径 cron 五年无解 → no-occurrence 拒绝**（票 27 留的单点接入，失败不写库）；fixed-delay 旧自动 run 未结算 → 保持 null 等结算（结算推进用当前 trigger＝编辑代际，runner 既有实现）。
2. **service.run / waitRun / computeWaitBudgetMs**（`lib/service.js`）：run = 手动触发受理（`requestRun` trigger='manual'、scheduledAt=受理时刻；单飞/并发/溢出判定全在 runner）；paused/ended 放行、拒绝仅 id 不存在；waitRun = 尽力等待（默认上限 `script.timeoutSeconds ?? defaultTimeoutSeconds + 30s`，超限不报错返回当前视图；maxWaitMs 可注入供测试）；底层原语 **runner.waitForRun**（run 级等待者集合，settle/settleSkip 结算时唤醒；interrupted 启动维护路径因查表已终态而天然兼容）。
3. **工具适配层**（`lib/tools.js`）：`script_edit`（patch 声明 OrchestrationInput 字段全集拦未声明键、action 枚举、expectedUpdatedAt string|null 的 oneOf；output.schema oneOf View/DeleteResult/input_invalid/unknown/conflict/internal）；`script_run`（{id, wait?}；wait 默认 true → `service.run` + `service.waitRun` 返回 RunView；wait:false → 立即返回简形 `{runId,status}`；output.schema 的 RunView 分支与简形分支经 required 互斥；受理竞态防御 → internal_error 值）。
4. **Connection 桥**（`lib/bridge.js`）：`edit` 端点（最小形状校验 + 零翻译透传 + 契约错误原样透传）；`run` 端点（**受理即返回简形** `{runId,status}`，不接受 wait——进度经 view 回读；signal 不透传 → UI abort 只终止等待不取消 run/run 受理）。
5. **面板**（`lib/client.js`）：列表新增「操作」列（active → 暂停+执行；paused → 恢复+执行；ended → 执行；删除属票 29）；行内按钮 stopPropagation 不触发行打开模态；操作经 `call('edit'/'run')` → 成功立即 `list` 回读（写后权威回读），失败显示契约错误条（code+message，可关闭）。
6. **验证脚本**（`scripts/verify-ticket28.ps1`）与浏览器实机验证（见下）。

### 包 / 目录结构（票 28 增量）

```
pkg/
  lib/  service.js（edit/run/waitRun/computeWaitBudgetMs/applyUpdate）  runner.js（waitForRun）
        tools.js（script_edit/script_run）  bridge.js（edit/run 端点）  client.js（行内操作）
  test/ service.test.js  runner.test.js（未改，既有面）  tools.test.js  bridge.test.js  client.test.js  index.test.js（扩展）
scripts/verify-ticket28.ps1
evidence/ticket28-panel-actions.png  ticket28-panel-paused.png  ticket28-panel-manual-run.png
```

### 测试命令与结果

- 单元：pkg 目录内 `node pnpm.mjs exec vitest run` → **14 文件 430 测试全绿**（service 145（edit/run 新增 34：形状/CAS/no-op 矩阵/编辑表/enabled 暂停恢复/ended 复活/无解拒绝/编辑代际/手动排队/溢出可见 skipped/等待超限）、tools 39（+12）、bridge 53（+17）、client 21（+5）、index 8（五工具接线）；较票 27 合并后的 371 增加 59）。
- 隔离集成：`pwsh scripts/verify-ticket28.ps1` → **全部断言通过**。阶段：环境预检 → 隔离 profile（`--port 0` 动态端口）→ 创建 A（every 60s）/B（cron */2 上海）/C（enabled:false → paused）→ A 非调度编辑不重锚 + CAS 不匹配 conflict（expected/actual）+ 调度编辑（60→120s）CAS 匹配通过且 next=editedAt+120s → B cron 表达式更新重锚到本地 03:00（UTC 19:00）+ 更新到永无解表达式 no-occurrence 拒绝且记录保持 → A 手动 run 受理即返回简形 + view 回读 succeeded（输出含标记）+ 手动不改下次自动时刻 → C paused 手动放行且执行后仍 paused → run 未知 id script_unknown → A pause 生效 + 重复 pause 幂等（updatedAt 不变）+ **暂停跨过自动计划时刻 130s 无 every run**（暂停期间不补跑）+ resume 重锚 resumedAt+120s（不补暂停期）+ active 上 resume 幂等不重锚 → delete 准确 unsupported-part（票 29）且记录仍在 → stderr 无本插件错误 → 杀端口进程确认释放 + 沙箱删除。
- 浏览器实机（隔离 DSH 浏览器 tab，动态端口）：桥创建 `*/2 Asia/Shanghai` 编排 → 面板列表行内显示「暂停/执行」→ 点「执行」受理回读（下次时刻不变）→ 点「暂停」状态切换「已暂停」、下次「—」、按钮变「恢复/执行」→ 点「恢复」回到运行中且重锚到下一匹配 → 点行开详情模态：手动 run 卡（成功 · 退出码 0 · 168ms · 输出尾部 LIVE28-MANUAL-OK）+ 恢复后的下次触发。截图：[evidence/ticket28-panel-actions.png](evidence/ticket28-panel-actions.png)、[ticket28-panel-paused.png](evidence/ticket28-panel-paused.png)、[ticket28-panel-manual-run.png](evidence/ticket28-panel-manual-run.png)。

### 隔离验证证据

- 全程自建 `DSH_HOME`（worktree 内 `.sandbox/`，验证后已删除），未触碰真实 `~/.dsh`；无头宿主一律 `--port 0`（沿用票 27/30 的并行冲突经验）；宿主终止按端口监听进程杀并确认端口释放（49583/58174/55990 均确认无监听）。
- 「对话式编辑」路径与桥 edit 同走 `service.edit`（工具测试锚定透传 + 服务测试锚定语义）；面板行内操作与桥同通路。

### 实现偏差与依据（契约 → 票序/语义空白）

1. **paused + 调度编辑不解暂停**（契约空白的语义连贯性解读）：契约 02 编辑表未限定状态、07 只明文「ended 可经重算触发复活」。本实现：显式暂停不被字段编辑意外解除——调度编辑不预写计划（paused 的 nextOccurrence 恒 null，契约 09），恢复时按 resume 表用新配置重算；ended + 调度编辑 → active（复活）；ended + 仅 enable（trigger 未变）→ 尝试重算，有解复活、无解保持 ended（不拒绝——配置未变非用户配置错误）；patch.enabled:true 对 paused = 恢复语义（与 resume 表同锚点）。
2. **expectedUpdatedAt:null 恒冲突**：契约「null = 此前没有更新时间」，本域记录恒有 updatedAt（create 即写），故 null 与任何当前值不匹配 → conflict；防御面等价（万一未来出现无 updatedAt 的记录则可匹配）。
3. **patch.id 的处理**：契约未定义 id 可否修改。相同值忽略、不同值 `unexpected`（patch.id 不可改）。
4. **delete 给准确暂不支持**（`unsupported-part` + field action，注明票 29 交付）——与票 25 cron 暂拒同一先例；工具/桥的 output schema 已含 DeleteResult 分支（契约形状先行占位）。
5. **service.run 的 signal 取消贯穿属票 29**（契约 03 取消矩阵/exec.signal 静止语义）：本票仅受理前 `throwIfAborted()`（与 create 一致）；工具层 abort 异常上抛交宿主 ABORTED 规范结果的既有面不变。
6. **waitRun 的 maxWaitMs 注入参数**：服务公共辅助的测试参数（覆盖等待上限，不改语义）；工具路径恒用契约公式（timeoutSeconds + 30s）。
7. **run 端点返回简形**（契约 11 端点表逐字 `{ runId, status }`）：面板不需要完整 RunView（view 回读是事实源）；工具 script_run 的 wait:false 也是简形、wait:true 是 RunView（契约 07 两个层面各自的面）。
8. **幂等 no-op 不发 changed**：无持久变更即无失效提示（契约 06 changed = 「编排集合发生持久变更」）；CAS 冲突失败同样不发。

### 残余风险

1. 「模型在引导会话里真正调用 script_edit/script_run」未端到端实测（沙箱无模型凭据，票 25 以来的既有边界）；工具/桥/服务同构性由分层测试保证。
2. waitRun 超限返回非终态视图后，调用方（模型）需按契约用 script_view 轮询——等待与轮询的衔接语义正确性依赖模型行为，工具描述已明示。
3. pause 与到点 timer 的竞态由调度器复核槽防线（票 26 既有）+ runner disabled 兜底（skipReason disabled）覆盖；本票未新增竞态面。
4. 承接票 26/27 的既有残余（Windows Job 悬挂、Cron 400 年扫描、UTC 直显等）不在本票范围，维持原状。
