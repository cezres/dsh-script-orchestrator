# 确认实施模块与验收方案

Type: grilling
Status: resolved
Labels: wayfinder:grilling
Blocked by: 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23

## Context

本议题汇总全部前置研究与决策，不重复保存其答案；最终 spec 链接各已解决 ticket 作为证据与决策来源。

## Question

在所有前置事实与契约决策关闭后，实施者应遵循怎样的模块边界、依赖方向、实施顺序、测试矩阵和验收标准？需要与用户确认最终交接方案，并写入 `.scratch/script-orchestrator/spec.md`：覆盖 every/cron、执行与判定、三类动作、存储、五个工具与服务、Web 面板、Windows 实际验证、macOS 兼容证据及已知残余风险。本地图不包含实现代码或实施 issues。

## Comments

- 2026-11-09：用户要求审查并修订 spec.md，重新认领本 ticket。复审口径：保持索引型交接稿，不复制契约；直接修正事实性错误、遗漏与误导性表述，新取舍另行确认。
- 2026-11-09：Round 1 六题用户「都按推荐」——Q1 七模块单向依赖；Q2 八步实施顺序（每步独立验证）；Q3 三层测试矩阵（spec 只列骨架与关键用例名）；Q4 Windows 实测=验收门、macOS=证据声明；Q5 spec 为索引型不复制契约；Q6 收尾三点（#4 声明性结案、Destination 达成确认、不建实施 issues）。
- 2026-11-09：spec.md 全文经用户「批准」落盘，地图收官。
- 2026-11-09：复审发现打包契约把校验库归属误指给只覆盖 UX 的面板原型；既有插件运行机制研究已给出明确归属。用户在复审范围确认中选择「同步修正（推荐）」，同意按契约变更流程追加 v0.1q，不改变既有设计决策。

## Answer

**[spec.md](../spec.md) 已落盘**（索引型交接稿）：§1 目标与范围（含非目标）→ §2 七模块边界与依赖方向（scheduler→runner→judge→actions；store+服务层 FIFO 为底；service 为唯一外部面；panel 只走桥）→ §3 八步实施顺序（每步独立验证口径）→ §4 三层测试矩阵骨架 → §5 验收标准（Windows 门 + macOS 声明）→ §6 残余风险如实清单（复审后八项）→ §7 证据索引。

### 2026-11-09 复审修订

经三组独立只读核对与用户确认，保持七模块、八步实施和三层测试矩阵不变，完成以下修订：

1. **执行生命周期归位**：runner 明确拥有单飞/全局排队、两写、取消与终态唯一；[澄清执行排队取消与等待语义](10-execution-lifecycle.md) 进入模块与实施入口，工具 `exec.signal` 的持久化后 `ABORTED` 静止、`wait:false` 与 `ABORTED_BEFORE_DISPATCH` 均入验收。
2. **调度与安全消歧**：拆分 `nextOccurrence` 纯函数和 scheduler 锚点选择，单列重启错过合并与 `interrupted` 后 fixed-delay 锚点测试；脚本/session 的 `allowedRoots` 约束、越界与目录不存在用例进入矩阵。
3. **关键行为补齐**：注册表/disposer、动作失败隔离、session 两模式与失败回收、事件失败兜底与回读一致、五工具和 Connection 桥不同校验/abort 语义、面板对话入口/模态/刷新轮询均有测试落点；U+FFFD 从模板组移回 runner 输出组。
4. **验收闭环**：最终验收明确 = §4 全绿 + §5 Windows 实机；every/cron 分别建编排验证；HMR 只承诺回读恢复权威数据，不承诺保留 React 本地状态。
5. **证据与风险**：ticket 全部改为可读名称链接；W1/W2 指向 [验证 Windows 终止与输出溢写](19-windows-subprocess-prototype.md)；残余风险补全 [最小宿主集成实验（会话创建到回收闭环）](23-session-integration-prototype.md) 的 UI 可观测性、卸载与回收竞态证据边界，并新增 Windows 正常退出后存活后代的 `waitForExit`/`terminate` 路径未实测项及对应集成验收。
6. **事实源纠错**：用户批准同步修正校验库归属误引。依据 [核实工作区插件、工具与配置机制](04-research-plugin-runtime.md)，`@deepseek-ai/schemastery` 自装用于同步 Config，`validateJsonSchemaValue` 从 `@deepseek-ai/dsh-tools` 公开根导入并列 peer；已同步 [确定插件打包依赖与安装方案](22-package-installation.md)、12-packaging、10-decisions 与 README v0.1q。最终回读另将 10-decisions 的 flush 被否理由从 durable 旧口径改为「不等待 flush 会漏掉 delivery_failed」，与 v0.1p 对齐。以上均不改变既有设计决策。

收尾结论：编号待验证 **#1–#7** 均已结案，但不以此冒称实现期测试已完成；地图 Destination 维持达成，前沿清零、雾区已空。实施 issues 按地图 Out of scope 约定不在本地图内创建。
