# 02 · 结果上报实现（runner / storage / service / tools）

Status: resolved
Scope: pkg/lib/{result-marker.js,runner.js,storage.js,service.js,tools.js}；依赖票 01 契约

- 新建 `pkg/lib/result-marker.js`：`parseScriptResult(stdoutText)`（取最后有效标记行）、`validateResultShape({summary, level, fields})` 共享校验（summary 1–300 cp；level enum；fields ≤8 项、键 1–40、值 1–100）。
- runner：settle 槽内解析 `facts.stdoutText` → `run.result` merge（保留先前 reports）；非法标记 → `script.warnings` 'result-marker-invalid'；buildSettledPayload 增 `result`（不含 reports）。
- storage：runSchema 增 optional `result`（strict：summary/level/fields/reports[]，report={at,sessionId?,summary,level?,fields?}）。
- service：`reportRunResult(input, actorSessionId)`——FIFO 槽内校验（script_unknown / format / limit 10 条）→ merge → put → safeEmit changed → 返回 `{runId, orchestrationId, status, result}`；view 路径零改动（result 随 run 记录流出）。
- tools：`script_report` 定义（parameters/output schema 按既有 oneOf 模式；actorSessionId 取 exec.agent.session）。

## Comments

- 在途 run：live overlay 不含 result 键，view merge 后持久 result 可见；settle 显式 merge 防覆盖（票 03 测试覆盖）。

## Answer

已完成：新建 pkg/lib/result-marker.js（前缀 ##SCRIPT-RESULT##、形状校验、最后合法者胜）；runner.collectOutput 解析标记→outcome.result、settle 合并 persisted.result 保留 reports、buildSettledPayload 带 result；storage runSchema 加 runResultSchema（reports 子表）；service.reportRunResult（FIFO 槽内 merge+落库+发 changed，≤10 条）；tools 第六工具 script_report（fields 参数用 {type:'object'}——宿主 schema 子集限制）。
