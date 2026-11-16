# 07 · 重装验证

Status: resolved
Scope: 当前 DSH profile（用户已授权更新插件）

- 按打包契约重装 @echo/dsh-script-orchestrator（file: 安装），确认 SKILL 新文案与面板新区块加载。
- 手动 `script_run`（wait:false）触发两条编排（paused 允许手动执行）：run 记录含 result（标记行解析）；面板 run 卡优先展示结果块；「脚本完成后」区正确。
- archive-inbox 会话动作跑通后验证 script_report 写入 reports（如投递成功）。

## Answer

已完成：link: 安装 remove+install 重装两次（first 解决旧模块内存驻留，second 落地 runOutputSchema 修复）；script_run 实测 run-dd4002a8 result.summary/level/fields 解析就位；script_report 实测 reports 追加+中文无损+与标记行合并；script_view 确认持久化；临时编排 result-marker-verify 已删（removedRuns:3）。注：面板新 client.js 需刷新 GUI 页面加载。
