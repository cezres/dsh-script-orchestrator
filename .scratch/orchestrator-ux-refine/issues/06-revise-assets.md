# 06 · 修订实际脚本与编排配置

Status: resolved
Scope: C:\Users\cezre\scripts\{archive-inbox.ps1,dedupe-downloads.ps1}；编排 archive-inbox 的 session 动作 prompt（script_edit）

- archive-inbox.ps1：列文件路径后输出 `##SCRIPT-RESULT## {"summary":"待归档 N 个文件","fields":{"文件数":"N"}}`；NO_FILES → info 标记「无待归档文件」；目录缺失 → error 标记。退出码语义不变。
- dedupe-downloads.ps1：SUMMARY 后输出标记（扫描/分组/保留/回收入 fields）；HASH_FAIL/RECYCLE_FAIL/目录缺失输出 error 标记后按原退出码退出。
- script_edit（archive-inbox，带 expectedUpdatedAt）：prompt 末尾追加「完成后调用 script_report 工具上报结果（runId 取上方 JSON 块 runId 字段；summary 一句话结论；fields 放各目录文件数）；无法调用时在最终答复说明」。

## Answer

已完成：两个脚本新增 Write-ScriptResult（ConvertTo-Json -Compress）；archive-inbox 实跑验证标记行输出正确；dedupe 语法检查过（未实跑避免真回收文件）；archive-inbox 编排 session prompt 末尾追加 script_report 上报要求（updatedAt 2026-11-15T16:45:43.027Z）；orchestration 编排无需改。
