# 25: 通过对话创建并查看 every 编排

**What to build:** 用户从面板「新建」进入引导会话，通过模型工具创建 fixed-rate 或 fixed-delay 编排，随后能在列表和详情模态中查看持久化配置与下次触发时刻。

**Blocked by:** 24 — 安装插件并查看空编排列表

**Status:** claimed

- [ ] 面板新建入口经 `uiWorkspace.startSession` 开启新会话并注入引导 prompt，不引入独立配置表单。
- [ ] `script_create` 以严格 JSON Schema 校验 every 输入，非法字段、间隔和多余字段统一映射为 `script_input_invalid`，失败不产生任何记录。
- [ ] 创建成功后持久化编排并发布 `changed`，`script_list`/`script_view` 与服务、Connection 返回契约形状；此时 `availableActions` 可以为空表。
- [ ] fixed-rate/fixed-delay 首次计划均从 `createdAt` 加间隔，创建为 paused 时 `nextOccurrence = null`，创建不立即执行脚本。
- [ ] 面板写后回读列表与详情，居中模态展示触发配置、状态和下次时刻，连接重置后重新回读。
- [ ] 冷重启后已创建编排及下次时刻保持；测试覆盖创建校验、持久化、工具输出和面板完整路径。
