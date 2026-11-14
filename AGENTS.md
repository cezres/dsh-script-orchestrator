# dsh-script-orchestrator

## 沟通语言

与用户沟通用简体中文；代码、命令、路径和报错保留原文。

## 按任务读取

开始对应任务前，先读以下文档：

- **实现或修改契约** → `docs/temp/README.md`（v0.1 契约索引与术语），再按索引读相关契约；实现以契约为准。变更契约时，先按 `docs/temp/10-decisions.md` 的「契约变更流程」更新文档，再改实现。
- **创建 spec、读取或处理 ticket、wayfinding** → `docs/agents/issue-tracker.md`（本地议题布局、认领与解决流程）。
- **分诊（triage）** → `docs/agents/triage-labels.md`（分诊角色与标签映射）；ticket 的 `Status:` 与 wayfinding 状态按 `docs/agents/issue-tracker.md`。
- **探索代码库、命名领域概念、记录决定、编写 ADR 或术语表** → `docs/agents/domain.md`（领域文档读取顺序、术语与决策的事实源）。
