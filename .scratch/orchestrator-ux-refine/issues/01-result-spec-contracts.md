# 01 · 结果上报规范契约修订

Status: resolved
Scope: docs/temp/{01-domain-model,03-execution,06-events-service,07-tools,08-storage,09-states-errors,10-decisions}.md + docs/temp/README.md

按 spec.md D1 更新契约（先文档后实现，README 加 v0.1y 行）：

- 03：新增「结果上报」节（标记行格式、解析源与多标记取舍、失败 warnings、溢写边界）。
- 01：run 字段表增 `result`。
- 06：服务面增 `reportRunResult`；RunSettled 载荷增 `result`；`changed` 语义扩为「编排或执行记录持久变更」。
- 07：工具表增 `script_report`（参数/返回/错误码；服务层兜底校验 reason 枚举）。
- 08：run 记录 schema 说明增 `result` 可选；新增「结果上报写」类别（结算后可重写 run 记录，仅 merge result）。
- 09：`script_input_invalid` 的 reason 说明覆盖 report 校验（format/limit）。
- 10-decisions：v0.1y 决策条目（标记行而非新文件/退出码编码；script_report 独立工具而非复用 report()；结算后重写 run 的理由；changed 扩义理由）。

## Answer

已完成：01/03/06/07/08/09/10/11/12 九份契约按 v0.1y 修订，README.md 变更记录加行、状态行更新（18 文件 611 项）。关键点：run.result 可选字段（additive，不升域版本）；RunSettled 载荷带 result（reports 不进）；changed 扩义「编排或执行记录持久变更」；07-tools 新增「RunView 顶层枚举字段须随 01-domain-model 同步，否则宿主输出校验拒绝」实现者注记（实测翻车教训）。
