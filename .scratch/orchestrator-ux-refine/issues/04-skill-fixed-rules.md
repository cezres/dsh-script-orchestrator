# 04 · SKILL 固定目录与固定暂停

Status: resolved
Scope: pkg/skills/script-orchestrator/SKILL.md；docs/temp/10-decisions.md（v0.1u 措辞衔接）；docs/temp/README.md；pkg/test/skills.test.js

- §2 创建确认流程：脚本文件固定写 `~/scripts/<编排id>.<ext>`（目录不存在则创建，不询问路径；用户主动指定遵从）；创建一律 `enabled:false` 不询问，创建后告知暂停态与启用方式；用户需求已明确要求启用 → 创建后立即 resume 并说明。
- 同步 10-decisions v0.1y 条目；skills.test.js 若有 SKILL 内容断言则更新。

## Answer

已完成：SKILL.md §1 尾固定规则声明；§2 创建固定规则两 bullet（~/scripts/<编排id>.<扩展名> 不问路径；一律 enabled:false 暂停态落库，用户已明确要求启用则创建后立即 resume 并注明）；§3 结果标记行规范+session 动作 prompt 要求 script_report。原商量式「建议暂停」措辞删除。
