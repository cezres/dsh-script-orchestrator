# 30: 按判定结果发出 event 动作

**What to build:** 用户能在编排中配置判定规则与 event 动作，脚本结算后按首匹配或 fallback 发出对应 Cordis 事件，并在面板查看判定命中和动作结果。

**Blocked by:** 26 — 自动执行 every 编排并查看脚本结果

**Status:** ready-for-agent

- [ ] 判定 DSL 覆盖全部契约谓词、首匹配、fallback、`matchedRule` 零下标与 `usedFallback`；脚本正常退出无论退出码或超时都进入判定。
- [ ] 创建/更新可配置 judge 与 event 动作，静态校验动作键引用、事件短名和保留名；非法配置不落库。
- [ ] 模板按契约渲染标量、`json:` 和递归 payload，未知变量与 JSON 失败对称处理，warnings 确定性保留最近 20 条，只有空 prompt 产生 `template_invalid`。
- [ ] event 动作按声明顺序串行执行并发出正确全名与 JSON 安全载荷；单动作失败不中断后续动作，dispatching 取消停止剩余派发且 run 终态优先。
- [ ] `action-settled` 与 `run-settled` 按动作及持久写序发布并保证回读一致；listener 异常不影响主流程，64 KiB 按最终 JSON UTF-8 字节计量并以 code point tail 兜底。
- [ ] 面板居中模态展示脚本、判定、动作三段结果和 warnings；测试覆盖谓词、模板、事件载荷、失败隔离、取消和事件时序。
