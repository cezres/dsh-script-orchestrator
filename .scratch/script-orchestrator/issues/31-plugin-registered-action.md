# 31: 通过 plugin 动作调用注册能力

**What to build:** 其他插件能注册具名能力，用户的编排在判定命中后实时调用该能力；配置者和排障者能发现可用动作，并看到未注册、超时或执行失败的明确结果。

**Blocked by:** 30 — 按判定结果发出 event 动作

**Status:** claimed

- [ ] `registerAction` 落实注册名格式、保留前缀和重名同步拒绝；`listActions()` 按名称排序返回 description，`script_view` 的 `availableActions` 与服务一致。
- [ ] 创建/更新只校验注册动作名格式，不静态检查存在性；每次动作执行前实时查表，未注册或已摘除返回可见 `unknown_action`，不静默跳过。
- [ ] 注册动作收到契约规定的 ActionContext，支持递归渲染后的 payload、signal 和 `report()` warnings；抛错与超时分别映射为 `action_error` 和 `timeout`。
- [ ] disposer 满足幂等、同步、按 token 精确删除和服务实例隔离，所有权仅属调用方 `ctx.effect`；摘除不中止在途调用，只影响后续解析。
- [ ] 一个测试插件能完成注册、被发现、被编排调用、注销及再次注册的全链验证，面板展示动作结果与警告。
- [ ] 测试覆盖保留名、重名、四不变量、在途摘除、失败隔离、动作超时和 list/view 动作提示。
