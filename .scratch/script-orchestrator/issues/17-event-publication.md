# 确定事件发布与失败隔离契约

Type: grilling
Status: resolved
Labels: wayfinder:grilling
Blocked by: 02

## Context

- [核实事件与插件服务机制](02-research-events-services.md)：Cordis 精确分发、同步异常、载荷原样传递、静态 inspect 和无重放的事实来源。

## Question

`script-orchestrator/run-started`、`run-settled`、`action-settled`、`changed` 应采用哪种发布与异常隔离语义？需要确定 listener 同步 throw 和异步 rejection 是否影响 run/action 主流程及其他 listener、发布前 JSON 安全快照与不可变纪律、64 KiB 按何种 JSON UTF-8 字节口径计量、超限时 stdout/stderr tail 如何按字符安全截短，以及同步调用顺序、异步完成顺序和无重放承诺。还需明确事件仅是失效提示、`view()` 是持久事实源，以及 TypeScript 事件/服务声明和 Host-only 边界。

## Comments

- 2026-11-08：用户接受 Q1–Q6 全部推荐（「都按推荐」），并于 Q7 批准共识与落盘范围。

## Answer

用户确认以下完整方案：

1. **分发与异常隔离**：四事件统一 `ctx.emit`（同步分发、不等异步）。双层隔离——发布端每次 emit 包 try/catch，listener 同步抛错记内部日志（含事件名，`event_listener_failed` 字样），绝不影响 run/action 主流程与后续动作，不新增错误码；listener 纪律条款入契约：同步代码不得抛、异步自行捕获，并如实声明宿主行为（同步抛错中断本轮后续 listener 调用、无 per-listener 隔离）。`parallel` 分发否决（阻塞发布方 + 失败聚合与发出即忘矛盾）。
2. **载荷纪律**：发布前构造全新载荷对象（不复用 run 记录引用）；构造期保证 JSON 安全（无函数/`undefined`/循环引用）；发布后不再修改载荷与其中字符串（tail 截短在构造前完成）；不做运行时深冻结。
3. **64 KiB 口径与截短**：按最终序列化 JSON 的 UTF-8 字节数计量；超限依次对 `stdoutTail`、`stderrTail` 减半保留末尾（按 Unicode code point 切割），循环直至达标；其余字段不截；现有字段上限下兜底几乎不触发，只为确定性。
4. **顺序与发布时机**：同步调用按注册序（含 `prepend`）；不承诺异步完成序与跨发布者序。本插件保证：`run-started` 在开始写入后、`action-settled` 按动作执行序、`run-settled` 在全部动作结算后、`changed` 在持久写入完成后发布；**回读一致性**——`run-settled`/`action-settled`/`changed` 一律在对应持久写入与内存视图更新之后发布，listener 收到即 `view()` 必见最新状态。
5. **无重放与事实源**：事件不重放（订阅前/离线/重启前一律不补发）；事件仅是失效提示，持久事实一律 `view()`；标准消费模式「收到提示 → `list()`/`view()` 重建」；`changed` 为无载荷的重新 list/view 提示。
6. **TS 声明与可见性边界**：TS 消费方需 module augmentation（将来随本插件类型包提供；纯 JS 零影响）；不进 `Event`/`Service` inspect 静态目录；普通 emit 不进会话日志/持久化/导出/遥测；不自动转发 renderer，Web 面板走 11-web-panel 的回读与轮询，互不替代。
7. **版本口径**：实现前契约调整；README 变更记录加 v0.1i。

已同步契约：[06-events-service](../../../docs/temp/06-events-service.md)（事件节整体改写）、[10-decisions](../../../docs/temp/10-decisions.md)（关键分叉加行）、[README](../../../docs/temp/README.md)（v0.1i）。05 的「发出即忘」表述与新口径相容；11 号面板契约已含「无实时推送」，无需改动。
