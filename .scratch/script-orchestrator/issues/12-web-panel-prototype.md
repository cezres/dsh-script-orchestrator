# 设计 Web 管理面板交互原型

Type: prototype
Status: resolved
Labels: wayfinder:prototype
Branch: proto/web-panel
Findings: .scratch/script-orchestrator/prototype/web-panel/（worktree D:\projects\dsh-script-orchestrator-proto-web-panel）
Commit: dfe1743
Blocked by: 02, 05, 07, 09, 20

## Context

- [核实事件与插件服务机制](02-research-events-services.md)：确定面板与宿主侧的通信通道。
- [核实 Web 面板发现构建与注入](05-research-web-client.md)：确定第三方 client UI 的可行形态。
- [确定 every 与 cron 的调度语义](07-trigger-semantics.md)：确定触发器表单与每日/每周预设。
- [统一工具与服务的管理接口](09-management-interface.md)：确定面板调用的管理契约。

## Question

首版 Web 管理面板应如何组织编排列表、详情、创建/编辑、暂停/恢复/删除、手动执行和 run 历史，使每日/每周预设、`every` 的 fixed-rate/fixed-delay 选择、cron 高级配置、judge/action 编辑以及脚本/判定/动作结果可理解且可排障？制作一个廉价但具体的界面/交互原型供用户反应，明确空态、加载、错误、危险操作确认、`active + nextOccurrence: null` 的等待结算展示和未实机验证的 macOS 风险提示是否需要呈现在界面中。

## Comments

- 2026-11-09：原型上线于隔离沙箱无头实例（`link:` 安装 + 浏览器车道验证），三变体（A 双栏工作台 / B 单列卡片流 / C 高密度表格）全部渲染正常，mock 数据覆盖票面全部状态（等待结算、failed 动作错误、skipped、paused、ended、四态页面状态）。产物提交 `proto/web-panel` 分支 `dfe1743`。
- 2026-11-09：**用户反应**——① 选 **变体 C**（高密度表格），但详情改为**居中弹窗**（不用右侧滑出）；② macOS 风险提示**不进界面**（与推荐一致）；③ 参考内置「自动化任务」面板：**创建/编辑走对话路径**——点击后在新建会话中经对话（模型用 `script_*` 工具）创建和修改编排，面板只做管理与排障。

## Answer

**胜选设计（2026-11-09 用户定案）**：

1. **列表 = 变体 C 高密度表格**：状态 / 标题（含 id）/ 触发 / 下次 / 上次 run / 行内操作（停·跑·删）。
2. **详情与 run 历史 = 居中模态弹窗**（点击行打开；不用侧滑）——含脚本/判定/动作三段结果、动作错误码与 sessionId、等待结算提示。
3. **创建/编辑主入口 = 对话式**：参考内置「自动化任务」`onNewTask` 先例——点新建/编辑 → `uiWorkspace.startSession` 开新会话注入引导 prompt → 用户经对话由模型调 `script_create` / `script_edit` 完成配置。**面板首版不做独立配置表单**；`create`/`edit` RPC 端点保留（工具之外的编程入口与未来表单直建）。
4. **macOS 未实机验证提示不进面板**（部署须知/诊断角落）。
5. 其余沿用原型验证过的形态：空态/加载/错误页、删除二次确认、`active + nextOccurrence: null` 的「⏳ 等待上次 run 结算」展示。

已同步：[11-web-panel](../../../docs/temp/11-web-panel.md) 新增「创建/编辑的对话路径」节（v0.1o）；README 变更记录 v0.1o；地图加行。原型（三变体完整源码 + 截图 + 沙箱 profile）留在 `proto/web-panel` 分支 `dfe1743`，供正式实现以变体 C + 居中模态 + 对话入口为蓝本起步。
