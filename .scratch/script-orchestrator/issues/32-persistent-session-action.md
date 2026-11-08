# 32: 通过 persistent session 接管失败排查

**What to build:** 用户的编排命中 session 动作后，系统创建一个新的 persistent root 会话并投递脚本结果，用户可从 run 记录接管排查；投递失败时保留会话现场。

**Blocked by:** 30 — 按判定结果发出 event 动作

**Status:** ready-for-agent

- [ ] session 动作支持 persistent 默认模式、prompt 模板、banner/plain、缺省标题、cwd/preset/model 校验；session cwd 同受 allowedRoots 限制。
- [ ] 经 `sessionController.create()` 创建宿主语义 root，每次 run 新建会话，不伪造 child、不复用旧会话、不做独立 Workspace attach。
- [ ] 首条消息使用内联结构完整 UserMessage，`source.kind = 'user'`；动作成功仅表示创建成功、followup 接受且 flush 未拒绝，不断言消息已经 append 到会话日志。
- [ ] 成功与投递失败均在 run 动作结果中记录 `sessionId`；followup/flush 失败映射为 `delivery_failed` 并保留会话，标题重命名失败仅记 warnings。
- [ ] 面板展示 session 动作结果和可接管的会话引用；删除编排不触碰已经创建的会话。
- [ ] 隔离宿主测试覆盖缺省 preset/model、banner、成功投递、死路由、失败保留和删除编排后的会话留存，不冒称正常 LLM append 时序已验证。
