# 澄清判定模板与结果字段

Type: grilling
Status: resolved
Labels: wayfinder:grilling

## Question

如何消除判定 DSL、模板与 run 结果字段之间的歧义？至少包括：`matchedRule` 使用零下标还是序号；文档称 `truncated` 可读但谓词表未声明；未知变量与 `json:` 路径失败如何产生 warnings；`run.actions[].warnings` 的字段形状和 20 条上限；plugin payload 应递归渲染 JSON 字符串值还是先文本替换再解析，以及合法 JSON、空 prompt 和 `template_invalid` 的判定时机。

## Comments

- 2026-11-08：用户接受 Q1–Q6 全部推荐（「都按推荐」），并于 Q7 批准共识与落盘范围。

## Answer

用户确认以下完整方案：

1. **`matchedRule` 零下标**：`run.matchedRule` 与 `{{matchedRule}}` 统一为 0 起规则下标；`fallback` → `null` + `usedFallback: true`、全未命中 → `null` + `false`、模板变量渲染 `fallback` / `none`（均既有不变）；04 措辞统一为「规则下标 N（0 起）」。
2. **`truncated` 谓词按流声明**：`stdout` / `stderr` 谓词对象各加 `truncated?: boolean`（该流收集阶段截断：超 `maxOutputBytes` 或读取有损），不新增顶层谓词；run 记录 `script.truncated` 维持单布尔、明确「任一流截断」；模板变量表新增 `{{truncated}}`（渲染 `true`/`false`，与 `script.truncated` 同源）。
3. **warnings 形状与上限**：`run.actions[].warnings?: string[]`；模板警告在动作执行前写入、`report()` 随执行追加，同一数组；保留最近 20 条、超出丢最旧；确定性文案 `unknown variable: {{name}}`、`json path missing: <path>`、`stdout is not valid JSON`；01 字段表补 `warnings?`，06 `report()` 与 08 存储同步。
4. **`json:` 失败与未知变量对称**：stdout 非合法 JSON 或路径不存在/解析失败 → 空字符串 + 各记一条 warning，不抛错不整体失败。
5. **payload 递归渲染**：只对字符串值替换；对象键不渲染（含 `{{` 的键按字面量保留）；数字/布尔/null 原样；`{{json:}}` 取非字符串值按其 JSON 文本插入；渲染结果恒为合法 JSON，`template_invalid` 仅剩 prompt——渲染后去首尾空白为空即触发；「文本替换再解析」否决。
6. **渲染时机与隔离**：dispatch 阶段逐动作执行前渲染（与逐动作查表同位）；失败仅该动作 `failed` + `template_invalid`，后续动作照常；渲染不计入 `timeoutSeconds`（计时从 `run()` 被调用起）。
7. **版本口径**：实现前契约调整，存储域仍从版本 1 起步；README 变更记录加 v0.1f。

已同步契约：[04-judge](../../../docs/temp/04-judge.md)（判定结果表、谓词表、模板变量表与规则）、[01-domain-model](../../../docs/temp/01-domain-model.md)（`warnings?`、`truncated` 语义）、[05-actions](../../../docs/temp/05-actions.md)（公共约束加模板渲染行）、[06-events-service](../../../docs/temp/06-events-service.md)（`report()` 注释）、[08-storage](../../../docs/temp/08-storage.md)（warnings 落库说明）、[09-states-errors](../../../docs/temp/09-states-errors.md)（`template_invalid` 触发条件）、[10-decisions](../../../docs/temp/10-decisions.md)（关键分叉加行）、[README](../../../docs/temp/README.md)（v0.1f）。无雾区毕业、无既有票受影响。
