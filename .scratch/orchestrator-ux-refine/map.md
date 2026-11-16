# orchestrator-ux-refine · wayfinding

Feature: v0.1y 结果上报规范 + 详情展示优化 + SKILL 固定规则（spec.md 为准）。

## Notes

- 2026-11-16：spec 与票 01–07 立。契约先行（票 01），实现票 02/03/04 可在契约落定后并行，测试票 05 随实现走，票 06/07 依赖重装（用户已授权 profile 更新）。
- 2026-11-16（收尾）：票 01–07 全部 resolved；18 文件 611 项测试通过；link: 重装两次（旧模块内存驻留须 remove+install 循环，HMR 未覆盖本插件）；run-dd4002a8 实测标记行解析 + script_report 上报全链路 OK；临时验证编排已删。

## Decisions-so-far

- 标记行格式 `##SCRIPT-RESULT## <JSON>`（单行、取最后有效）；结果经 `run.result`（可选字段，不升域版本）；会话侧用独立工具 `script_report`（不复用动作 report() 进展通道）；reports 上限 10 条/run；changed 事件扩义覆盖执行记录写入。
- 面板两处：详情「脚本完成后」区 + run 卡 result 块（优先于原始输出）。
- SKILL：脚本固定 `~/scripts/<编排id>.<ext>`；创建固定 enabled:false；用户明确要求启用→创建后立即 resume。
- 实测教训：RunView 顶层枚举字段须随 01-domain-model 同步补进 tools.js output schema（additionalProperties:false 拒绝未声明键，宿主报 `must match exactly one oneOf branch`）；已写入 07-tools.md 适配层约定。pwsh `-Command` 内联中文经重定向输出会 GBK 乱码（真实脚本文件均已显式设 UTF-8，不受影响）。
