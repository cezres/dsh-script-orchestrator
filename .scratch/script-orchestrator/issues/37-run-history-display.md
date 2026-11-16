# 37: 优化详情页执行记录展示

**What to build:** 用户打开编排详情时，执行记录区面向人类阅读：默认只展示最近 3 条 run，点击「展开全部」查看完整列表（服务单次上限 50 条，如实标注）；单条 run 卡片直观化——状态彩色徽章、相对时间（悬停见绝对时刻）、人性化耗时、非零退出码突出、runId 缩写、stderr 尾部直接可见。

**Blocked by:** 无（在 v0.1w 列表/详情布局上增量）

**Status:** resolved

- [x] 按契约变更流程先落契约：11-web-panel 增「执行记录展示（v0.1x）」小节、10-decisions 增 v0.1x 决策记录、README 变更记录加 v0.1x 行。
- [x] 详情打开即以 `view { id, runs: 50 }` 取回最近至多 50 条，计数与 5 秒活动轮询口径一致。
- [x] 默认渲染最近 3 条；取回数 > 3 时展示「展开全部执行记录」；展开后可「收起」回 3 条；达 50 条上限时如实标注。
- [x] run 卡片直观化：状态彩色徽章（成功/失败/部分/跳过·取消/非终态分色）、相对时间 + title 绝对时刻、未结算标注「开始于」、耗时人性化（ms/秒/分秒）、非零退出码错误色、runId 尾 4 位 + title 完整、stdout/stderr 尾部标注展示且 stderr 用错误色。
- [x] 更新与新增 client.test.js 用例；`pkg` 全量 vitest 绿。

## Comments

- 2026-11-15 契约 v0.1x 先落（`docs/temp/11-web-panel.md` 展示小节、`docs/temp/10-decisions.md` v0.1x 决策、README 变更记录）。取数方案定「恒定 50 条 + 纯本地折叠」，弃两档取数（避免展开时计数跳变与额外回读）。
- 2026-11-15 实现于 `pkg/lib/client.js`：新增 `RUN_STATUS_COLOR` / `fmtRelTime` / `fmtDuration` / `previewTail` 与 `RunChip`；详情 `view` 调用改 `{ id, runs: 50 }`；执行记录区 `slice(0, runsExpanded ? undefined : 3)` + 展开/收起按钮（`runsExpanded` 随 `id` 重置）+ ≥50 条上限标注；RunCard 头行彩色徽章、相对时间（title 绝对时刻，未结算「开始于」未开始「计划于」）、人性化耗时、非零退出码/超时错误色、runId 尾 4 位、stdout/stderr 尾部标注块（stderr 错误色）。
- 2026-11-15 `pkg/test/client.test.js`：9 处 view payload 断言补 `runs: 50`；既有卡片断言适配新文案；新增折叠/展开/收起、50 条上限标注、相对时间三个用例。`pkg` 全量 vitest 606 个测试绿。
