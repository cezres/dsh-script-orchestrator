# 05 · 测试补齐与全量回归

Status: resolved
Scope: pkg/test/{result-marker,runner,service,storage,tools,client,skills}.test.js

- 新增 result-marker.test.js：合法单条/多条取末条/位置不限；非法 JSON、非对象、summary 缺失/超限、level 非法、fields 超限 → invalid+原因；无标记 → null。
- runner.test.js：result 落库（含 merge 保留 reports）、warnings 追加、buildSettledPayload 含 result、spawn_failed/canceled 无 result。
- service.test.js：reportRunResult 全路径（成功/unknown/format/limit/changed 发表/in-flight run 可上报且 settle 后保留）。
- storage.test.js：runSchema 收 `result` 可选、拒绝坏形状。
- tools.test.js：script_report 定义存在、参数校验映射、actorSessionId 透传。
- client.test.js：「脚本完成后」区渲染（规则/动作/兜底/零动作文案）、RunCard result 块与顺序。
- skills.test.js：SKILL 固定目录/固定暂停断言。
- 全量 `pnpm test` 通过（Windows 实际进程用例除外按既有约定）。

## Answer

已完成：result-marker.test.js 22 用例；runner/service/tools/storage/client/skills 补测；18 文件 611 项全过（修复：工具数 5→6 的名称数组与 toHaveLength、mountDetail call 分发、fields schema 子集、runOutputSchema 补 result 属性）。
