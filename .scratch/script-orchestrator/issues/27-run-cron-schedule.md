# 27: 通过 cron 编排按计划执行

**What to build:** 用户通过对话创建带 IANA 时区的五位 cron 编排，系统按表达式自动执行，并在面板显示下次时刻与 run 历史；每日/每周引导只生成 cron，不增加触发类型。

**Blocked by:** 26 — 自动执行 every 编排并查看脚本结果

**Status:** resolved

- [x] 创建时只接受契约规定的五位 cron 子集和显式 IANA 时区，非法字段、宏、秒字段及过密规则返回准确的 `script_input_invalid`。
- [x] `nextOccurrence` 严格大于 `fromMs`，五年窗口内无解有界返回并在创建/更新时拒绝；运行期意外无解转为 `ended`。
- [x] cron 编排能经既有 runner 自动执行并持久化 run，面板正确显示表达式、时区、下次时刻和脚本结果。
- [x] DST 春季不存在的本地时间跳过，秋季重复时刻只取较早瞬时；每日/每周对话预设与生成 cron 使用同一时区，持久化 kind 仍为 `cron`。
- [x] 重启保留未来计划，停机多次错过合并为最近一次 run，暂停期间不补跑；被合并的中间触发不生成记录。
- [x] 测试覆盖纯函数、时区/DST、有界无解、自动执行、重启错过和面板回读，不引入 RRULE、`at` 或 `after`。

## Comments

### 做了什么

按票验收项 TDD（红-绿循环，先写失败测试，共 7 个切片）实施，交付「cron 触发类型端到端」：创建校验 → 计划计算 → 自动执行 → 错过合并 → 面板回读。

1. **触发纯函数**（`lib/triggers.js`）：`nextOccurrence` 增加 cron 分支——`Cron.parse`（实例按 expression+timeZone 缓存）→ `next(fromMs)`（库保证严格大于、DST gap 跳过、overlap 取较早瞬时）→ 套 5 年窗口（`CRON_WINDOW_MS = 5×366 天`，超出视为无解返回 null；库自身地平线 400 年，窗口收紧是契约 02 要求）。新增 `resolveCronMiss(trigger, plannedIso, acceptedMs)`：cron 错过合并的唯一出口（`Cron.resolve` 语义与契约 02 一致：多次错过取最近一次到期、不重放积压），返回 `{ occurrenceMs, nextMs }`；`{ defer: true }` 表示受理时刻早于计划时刻的时钟回拨（保持计划重排）；`null` 表示形状非法（防御面）。
2. **输入校验**（`lib/validation.js`）：`validateCronTrigger`——**插件层自研五位子集白名单**（库语法是契约超集）：逐字段正则（`a`、`a-b`、`a-b/step`、逗号列表；星步进 `*/n` 仅 minute/hour，契约 02 逐字）；dow 范围 0–7（7 折叠周日交库完成）；错误映射：宏 → `unsupported-part` + `part:'macro'`、>5 字段 → `part:'second-field'`、名称写法（JAN/MON）→ `unsupported-part` + part=字段名、数值越界 → `range` + part、反转/空元素/无范围 step（`5/15`）/星与列表混用 → `format` + part；时区经库 `canonicalizeTimeZone`（拒绝缩写/数字偏移/单段名/未知名 → `trigger.timeZone` format），别名接受（规范化随平台 ICU）。
3. **创建服务**（`lib/service.js`）：create 的 FIFO 槽内、落库前做 cron 五年无解检查（`nextOccurrence(trigger, createdAtMs) === null` → `script_input_invalid`，`field='trigger.expression'`、`reason='no-occurrence'`，契约 02 原文形状）；与 enabled 无关（paused 创建同样拒绝——「不写入立即 ended 的编排」的意图，见偏差 4）。active 的 nextOccurrence = 严格晚于 createdAt 的下一匹配；enabled:false → paused + null。
4. **调度器**（`lib/scheduler.js`）：`earliestDue` 纳入 cron kind；`fire` 按 kind 分派（every 路径原样保留）；`fireCron`——**受理时刻在 FIFO 槽内取值**（排队迟到按真实受理时刻合并），`resolveCronMiss` 合并错过 → 写入推进/发 `changed` → `requestRun({ trigger: 'cron', scheduledAtMs: occurrenceMs })`；推进无解（含窗口外）→ 编排转 `ended`（运行期意外无解的防御终态）；复核槽防 pause/edit 后旧 timer 重入（与 every 同款）；形状非法 → 记日志 + `ended`（防 timer 死循环）；时钟回拨 → defer 保持计划重排。
5. **工具适配层**（`lib/tools.js`）：`script_create` 的 trigger schema 声明 every/cron 字段全集（kind enum + everySeconds/mode/expression/timeZone + `additionalProperties:false` 拦未声明字段）；**每 kind 判别与语义校验归服务层**（错误 field 更准确：every+expression → 服务层 `unexpected`）；description 更新提 cron。
6. **面板**（`lib/client.js`）：TriggerSummary cron 分支显示 `表达式 @ 时区` + 语义摘要（`describeCron`：单一时刻 + dom/month 为 `*` → 「每天 HH:MM」；dow 展开（列表/范围，0/7 等价周日）→ 「每周一/三/五 HH:MM」；多时刻/step/日期月份受限只显原文——契约 02「复杂表达式只显示高级编辑器」的简化档解读）；CREATE_PROMPT 扩写 cron 指引（五位 + 显式时区、每日 `0 3 * * *`、每周一三五 `0 9 * * 1,3,5`、周日生成 0、预设与 cron 同一时区、不接受秒字段/宏/名称）。
7. **run 持久化与读侧**：`run.trigger='cron'` 经既有 runner 两写结算（storage schema 的 trigger 枚举票 26 已含 cron，票 25 已铺 cron trigger 读侧分支——本票补对齐断言防回归）。

### 包 / 目录结构（票 27 增量）

```
pkg/
  lib/  triggers.js（cron 分支 + resolveCronMiss）  validation.js（validateCronTrigger）
        service.js（无解拒绝）  scheduler.js（fireCron + earliestDue）  tools.js（trigger schema）  client.js（摘要 + prompt）
  test/ triggers.test.js  service.test.js  scheduler.test.js  tools.test.js  client.test.js
        storage.test.js  index.test.js（扩展）
scripts/verify-ticket27.ps1
evidence/ticket27-panel-list.png  ticket27-panel-modal.png
```

### 测试命令与结果

- 单元+进程集成：pkg 目录内 `node pnpm.mjs exec vitest run` → **13 文件 319 测试全绿**（triggers 18（cron 13 例：严格大于/换算/列表/dow 0=7/Vixie 或/柏林春跳秋叠/悉尼 DST/五年窗口/400 年无解/防御形状）、service 118（cron 校验矩阵 36 例 + 创建/无解/暂停）、scheduler 16（cron 到点/停机合并/FIFO 迟到合并/ended/暂停/防御/与 every 混排；反转票 26 的「cron 不触发」防御测试）、tools 27（schema 全集 4 例）、client 16（cron 列表/模态回显 + 每周摘要）、storage 13（cron 对齐）、index 7（cron 重启接线）；较票 26 的 250 增加 69）。
- 隔离集成：`pwsh scripts/verify-ticket27.ps1` → **全部断言通过**。阶段：环境预检 → 隔离 profile（`DSH_HOME=<repo>/.sandbox/s27/home`，profile `orch27`，file: 指向 worktree pkg，`--port 0` 动态端口）→ 非法矩阵 8 连（宏/秒字段/dow 星步进/minute 越界/偏移时区/缩写时区/五年无解/MON → 准确 field+reason+part，且失败后 total=0）→ 创建 A（`*/2 * * * *` Asia/Shanghai，active）、B（同表达式 UTC，供停机）、P（enabled:false → paused/null）→ A 首次自动触发（run succeeded、trigger=cron、scheduledAt=分钟边界、nextOccurrence=scheduledAt+2min、stdoutTail 含标记、view 回读 trigger 三件套）→ P 暂停期间无 run → 等 B 保留计划结算后取稳定基线 → 杀宿主 → 停机 300s（跨 2-3 个 */2 时刻）→ 冷重启：B 恰新增 1 条 run（scheduledAt=最近错过的分钟边界、trigger=cron、succeeded）、nextOccurrence 为未来 */2 边界、P 仍 paused 无 run、A 未来计划保留 → 两轮 stderr 均无本插件错误 → 杀端口进程 + 端口释放确认 + 沙箱删除。
- 浏览器实机（隔离 DSH 浏览器 tab，token URL，动态端口）：经桥 create `*/2 Asia/Shanghai` 与 `0 3 * * * Asia/Shanghai` 两编排 → 侧边栏「脚本编排」→ 列表显示两条 cron（每日预设回显「每天 03:00」摘要、`*/2` 复杂表达式只显原文、下次时刻列）→ 点行 → 居中模态：触发配置 `*/2 * * * * @ Asia/Shanghai`、下次触发已从 01:54 推进到 01:56、执行记录 1 条（成功 · 退出码 0 · 156ms · 输出尾部 LIVE-CRON-FAST-OK）。截图：[evidence/ticket27-panel-list.png](evidence/ticket27-panel-list.png)、[evidence/ticket27-panel-modal.png](evidence/ticket27-panel-modal.png)。

### 隔离验证证据

- 全程自建 `DSH_HOME`（worktree 内 `.sandbox/`，验证后已删除），未触碰真实 `~/.dsh`；宿主终止按端口监听进程杀并确认端口释放（58866/52822/52808 均确认无监听）；无头宿主一律 `--port 0` 动态端口（采纳票 30 的并行冲突发现，不再占默认 3080）。
- 「模型经工具创建 cron」路径与桥 create 同走 `service.create`（同一校验与无解拒绝），由单测（tools.test + service.test）与服务同构性保证；工具 schema 放行形状、语义判定在服务的分层经 `every 混入 cron 字段` 用例固定。

### 实现偏差与依据（契约 → 票序/库现实）

1. **库语法超集由插件层白名单收紧**（笔记 04 预告）：dsh-util-time `Cron.parse` 接受全字段星步进与更多形式；契约 02 逐字「分钟与小时支持 `/step`」→ 星步进仅 minute/hour，其余字段报 `unsupported-part`+part。`*/n` 不允许与逗号列表混用（契约元素清单只列 `a`/`a-b`/`a-b/step`，收紧；记录于此，如需放开属契约变更）。
2. **五年窗口取 5×366 天**（`CRON_WINDOW_MS`）：契约只说「5 年」，取最宽毫秒近似保证覆盖任意起点向后 5 个日历年（含 2096/2104 类闰年边缘：2/29 规则在 2097 年视角被拒、2026 年视角有解——单测锚定）。
3. **时区别名规范化随平台**：库 `canonicalizeTimeZone` 委托 Intl resolvedOptions，本机 ICU 保留 `Asia/Calcutta` 原样（其他平台可能规范化为 `Asia/Kolkata`）；接受即通过，断言用集合成员而非具体值。存储 timeZone 用库给出的规范名（库设计意图：zone 随记录持久并在另一进程重解析）；expression 原样持久化（白名单已过的用户输入）。
4. **无解拒绝与 enabled 无关**：契约 02「创建或更新 cron 时……拒绝」未区分 enabled；paused 创建同样拒绝（配置永不有效，避免恢复时必然 ended 的记录入库）。**更新路径（script_edit 改 trigger）属票 28**：拒绝逻辑在 service 层单点实现，票 28 接 update 时复用同一检查。
5. **「更新时拒绝」的接线边界**：本票 create 拒绝 + 运行期 ended 均已落地；`script_edit` 工具本身属票 28（验收项措辞「创建/更新时拒绝」的更新半边随票 28 的 edit 路径接入，语义无新增）。
6. **防御面的两个决定**（契约未明说的兜底）：存储中形状非法的 cron 记录（绕过创建校验，如手工改库）到点转 `ended` + 内部日志——否则 earliestDue 每轮都选中过期计划造成 timer 死循环；受理时刻早于计划时刻（时钟回拨，`Cron.resolve` 抛 RangeError）→ defer 保持计划重排（暂态不惩罚为 ended）。
7. **受理时刻在 FIFO 槽内取值**：cron 的错过合并锚点是槽实际执行时刻而非 timer 回调时刻（排队迟到合并更准确）；单测以 FIFO 慢任务占用模拟 4.5 分钟迟到，合并到 ≤受理时刻的最近匹配。
8. **面板语义摘要为文字形式**：契约 02「可回显简单表单」的「可」字 + 契约 11「首版 UI 不做独立配置表单」→ 简化档只做文字摘要（每天 HH:MM / 每周X/Y/Z HH:MM），不引入表单控件；`1-5` 范围按星期枚举展开显示（契约举例可识别）。
9. **验证脚本自身的三轮修正**（记录供后续票复用）：① `[string]$part = $null` 参数默认值强转空串使 `$null -ne ''` 为 true 的误判；② Invoke-RestMethod 把 ISO 日期自动反序列化为 DateTime，边界断言改 `To-UtcMs` 毫秒取模；③ 杀宿主与计划时刻的竞态——基线先等保留计划结算再取（杀前最后一刻的正常触发不是停机补跑）；另加会话过期 401 自动重连（web 会话 cookie 分钟级过期）与端口释放等待（Stop-Process 异步，否则重启 EADDRINUSE）。

### 残余风险

1. `Cron.next` 对永无解表达式（如 2 月 30 日）会扫满库的 400 年地平线（实测单文件全绿总时长 <8s，该路径仅创建/更新校验时发生一次）；若未来需要更快拒绝可先做结构可达性预判，当前不必要。
2. 时区别名的具体规范化形式平台相关（ICU 版本）；跨平台迁移同一存储时 zone 语义一致（同一 IANA 链接目标）但字面可能不同。
3. 面板 fmtTime 显示 UTC 时刻（ISO 直显，票 25 既有行为，保持）；cron 的本地时间语义只在触发计算层，面板未做目标时区本地化显示。
4. 「模型在引导会话里真正调用 script_create 创建 cron」未端到端实测（沙箱无模型凭据，票 25 同一边界）；工具层语义与桥 create 同构（同一 service.create），prompt 指引文案已实测注入。
5. 承接票 26 的既有残余（Windows Job done 悬挂、spill 读取、卸载取消语义等）不在本票范围，维持原状。
