# 确定 Web 面板通信与刷新契约

Type: grilling
Status: resolved
Labels: wayfinder:grilling
Blocked by: 02, 05, 09

## Context

- [核实 Web 面板发现构建与注入](05-research-web-client.md)：Connection RPC、Typert Remote、事件白名单与 Desktop 注入的事实来源。
- [核实事件与插件服务机制](02-research-events-services.md)：Host Context 服务共享边界与事件生命周期的事实来源。
- [统一工具与服务的管理接口](09-management-interface.md)：桥接层应复用的管理语义。

## Question

首版 Web 面板应采用独立 Connection channel 的一元 RPC，还是 Typert Remote 类型化桥接？需要确定 list/view/create/edit/run 的桥接形状、输入校验、JSON 序列化、错误与 abort 映射、认证和 Host/Origin fence 的复用，以及暂停/恢复与管理服务的对应关系。还要确定写后回读、连接重置回读、活动 run 轮询的刷新策略和停止条件，并明确 Desktop 安装、后端重启、HMR 状态丢失及无实时事件推送的用户可观察语义。

## Comments

- 2026-11-08：用户接受 Q1–Q8 全部推荐（「都按推荐」），并于 Q9 批准共识与落盘范围。
- 2026-11-08：确认研究报告 §6.2 的「暂停/恢复用 `update(enabled)` 伪装」推断基于 09 号票之前的旧服务契约，已作废；面板直接用四 action `edit`。

## Answer

用户确认以下完整方案：

1. **桥接形态**：独立 Connection channel `/script-orchestrator` 的一元 RPC（Host `connection.rpc.handle`，浏览器 `ctx.connection.rpc.call`）；不采用 Typert Remote（类型链收益不抵 `./typert` 生成物 + `remote.$mount` 注册链成本，将来可整体升级）；不占用保留 channel `/api`。
2. **端点集与形状**：`list` / `view` / `create` / `edit` / `run` / `listActions` 六端点，参数与返回原样复用服务契约形状（零翻译 DTO，全部无损 JSON）；`run` 端点受理即返回 `{ runId, status }`（不等结算，`status` 可为非终态）；`listActions` 按需供编辑器动作提示，不混入 `view` 返回。
3. **输入校验与错误映射**：桥接层薄适配——端点参数最小形状校验（缺字段/类型错/多余字段 → `script_input_invalid` 同构映射，`unexpected`/`missing`/`range`/`format` + 准确 `field`）；业务语义全由服务判定；契约错误 `{code, message, details?}` 原样透传；不新增错误码。
4. **abort 语义**：连接层 abort 只终止等待，不取消已受理操作——`create`/`edit` 照常完成、下次回读见结果；`run` 端点不把 UI 请求 signal 传给执行（关掉详情页 ≠ 取消脚本 run）；v0.1 面板不暴露 run 取消入口（删除编排连带取消其 run 属既有语义）。
5. **认证与 fence**：完全复用 `connection.rpc.handle` 内建认证与 Host/Origin fence；不加自定义 token、不做面板级权限（out-of-scope）。
6. **暂停/恢复对应**：直接 `edit({ action: 'pause' | 'resume', expectedUpdatedAt? })`；`update(enabled)` 伪装作废；CAS 随 09 号票全 action 生效。
7. **刷新策略**：① 写后权威回读（create/edit/run 成功即重取 list/view）；② `connection/reset` 后全量回读；③ 活动轮询——「面板可见且存在非终态 run」时每 5 秒 `view(id)`，停止条件（无活动 run / 面板不可见 / 组件卸载）任一即停；如实声明无实时事件推送（`script-orchestrator/*` 不在转发白名单）。
8. **用户可观察语义**：Desktop 安装/manifest 变更/后端重启按重启或刷新边界生效，不承诺 SSE 级即时；开发期 client HMR 重建重置面板 React 本地状态（外层连接状态保留）；无推送期间列表可能过期，以回读为准；后台标签页不轮询为实现验收项。
9. **落点与版本口径**：新建 `docs/temp/11-web-panel.md`（通信与刷新契约；面板 UI 交互留给后续原型票）；README 变更记录加 v0.1h。

已同步契约：新增 [11-web-panel](../../../docs/temp/11-web-panel.md)；[README](../../../docs/temp/README.md)（索引 + v0.1h）；[10-decisions](../../../docs/temp/10-decisions.md)（关键分叉加行）。[验证最小 Web 客户端构建与注入](16-web-build-prototype.md) 只管构建注入闭环，与本契约正交，无需维护。
