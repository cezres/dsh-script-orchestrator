# 03 · 面板：完成后行为区 + run 卡结果优先展示

Status: resolved
Scope: docs/temp/11-web-panel.md；pkg/lib/client.js

- DetailPanel 新增「脚本完成后」section（「触发配置」与「执行记录」之间）：`describeWhen`（exitCode 数字/not/in/min-max、timedOut、signal、durationMs、stdout/stderr regex·contains·jsonPath、all/any 组合、空对象=无条件）逐条人话；动作说明（event/plugin/session 模式+标题+prompt 首行）；fallback 行；零规则无兜底 → 固定文案。
- RunCard 增 result 块：位置在判定行之后、stdout/stderr 之前；脚本标记结果（level 配色 summary + fields）+ reports（时间 + sessionId 尾 8 位 + summary + fields）。
- 11-web-panel.md：记录两处展示语义与「结果上报到达需手动刷新/下次回读（无推送）」注记；无字段语义变化，不升域版本。

## Answer

已完成：client.js 新增 describeWhen/describeActionDef/AfterScriptSummary 完成后人话翻译区（DetailPanel「脚本完成后」section，纯展示）；RunCard 新增 ResultBlock（level 配色色条+summary+fields+reports 会话上报列表），位置在判定行后、原始输出前。client.test.js 5 个新用例全过。
