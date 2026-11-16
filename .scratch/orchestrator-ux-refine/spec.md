# Spec · orchestrator-ux-refine（v0.1y）

用户需求（2026-11-16，三条）：

1. 编排详情更清晰展示「脚本执行完成后的行动」（判定规则 → 动作）。
2. 定义结果上报规范：脚本可返回指定字段、或脚本调起的 AI 会话可返回指定字段，用于说明执行结果；执行记录优先展示此信息；随后修订现有 archive-inbox、orchestration 两个脚本。
3. 创建脚本编排时：脚本放固定规范的目录（不询问写入路径）；创建后固定先暂停（不询问）。

## D1 · 结果上报规范（任务 2 核心）

**脚本侧标记行**：脚本在 stdout 输出单行标记 `##SCRIPT-RESULT## <JSON>`：

- JSON 对象：`summary`（必填，trim 后 1–300 code points）、`level`（`'info'|'warn'|'error'`，默认 `'info'`）、`fields`（可选，≤8 项，键 1–40、值 1–100 code points，string→string）。
- 解析源为 stdout 收集文本（`readFrom(0).text`，与 `stdoutTail` 同源）；多条标记行时取**最后一条有效**；标记行输出位置不限（建议靠末尾）。
- 解析失败（非法 JSON、非对象、summary 缺失/超限、level 非法、fields 超限）→ 忽略该标记行，`script.warnings` 追加 `'result-marker-invalid'`，不影响 run 状态。
- 输出超出内存收集上限且标记被溢写时解析不到（视为未上报）；判定与模板不受标记行影响。

**会话侧上报工具 `script_report`**：脚本调起的会话内可调用，参数 `{runId, summary, level?, fields?}`（限制同上）：

- `runId` 不存在或已删除 → `script_unknown`；参数越限 → `script_input_invalid`（`reason: 'format'|'limit'`）。
- 每 run 上限 10 条（超出 → `script_input_invalid`，field `report`、reason `limit`）；追加进 `run.result.reports[]`：`{at, sessionId?, summary, level?, fields?}`；`sessionId` 自动取调用会话。
- run 任意状态可上报（含在途）；在途 run 结算时保留已写入的 reports（merge 不覆盖）。
- 写入走服务 FIFO 单槽，put 后发 `script-orchestrator/changed`（回读一致性前提不变）；返回 `{runId, orchestrationId, status, result}`。

**存储与事件**：

- `run.result`（可选）：`{summary?, level?, fields?, reports?}`。additive 可选字段，不升域版本（契约 08 升级策略）。
- RunSettled 载荷增加 `result`（仅结算时刻的 `summary/level/fields`，reports 不进事件）。
- `changed` 语义扩展为「编排或执行记录发生持久变更（含结果上报）」——纯加法，订阅方按失效提示回读，无兼容负担；契约 06 同步措辞。

**展示（任务 2 后半 + 任务 1）**：

- run 卡片：`result` 块优先展示（位于判定行之后、原始输出之前）：level 配色的 summary + fields 键值 + reports 列表（时间 + sessionId 尾 8 位 + summary + fields）。stdout/stderr 直展保持不变，退居其后。
- 详情新增「脚本完成后」区（位于「触发配置」与「执行记录」之间）：规则逐条人话化（`describeWhen`：退出码/超时/信号/耗时/stdout·stderr 谓词/组合），动作逐个说明（event→事件名、plugin→注册动作名、session→模式+标题+prompt 首行预览），fallback 行，零规则无兜底→「脚本完成后不执行任何动作」。

## D2 · SKILL 固定规则（任务 3）

- 新建编排的脚本文件固定写入用户主目录 `~/scripts/`（Windows `%USERPROFILE%\scripts`），文件名 `<编排id>.<扩展名>`；目录不存在则创建；不向用户询问写入路径（用户主动指定位置时遵从）。
- 创建一律显式 `enabled: false`（固定规则、不询问、不默认启用）；创建后告知当前为暂停态与启用方式；用户需求中已明确要求启用时，创建后立即 `resume` 并在总结中说明。修订点覆盖 SKILL.md §2 与 10-decisions v0.1u 的「默认建议暂停」表述。

## D3 · 实际资产修订（任务 2 收尾）

- `C:\Users\cezre\scripts\archive-inbox.ps1`：有文件时输出 info 标记（summary 含数量）；NO_FILES/目录缺失输出对应标记（level info / error）。
- `C:\Users\cezre\scripts\dedupe-downloads.ps1`：成功输出 summary 标记（扫描/保留/回收数入 fields）；HASH_FAIL/RECYCLE_FAIL/目录缺失输出 error 标记后按原退出码退出。
- `archive-inbox` 编排的 session prompt 末尾追加 script_report 指引（runId 从 banner JSON 块读取）。

## 验收

- 全量测试通过（新增：result-marker、runner result 落库/事件、service reportRunResult、tools script_report、storage schema、client 展示、SKILL 断言更新）。
- 重装插件后：手动执行两条编排，run 记录含 result；面板详情「脚本完成后」区正确渲染；run 卡优先展示结果块。
- SKILL 文案与 10-decisions/README 变更记录（v0.1y）一致。
