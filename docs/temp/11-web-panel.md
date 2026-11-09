# 11 · Web 面板：通信与刷新（renderer 侧）

Web 面板是 renderer 进程的 client 插件，不能直接取得 Host Context；一切管理操作经本契约的桥接层到达 `ctx.scriptOrchestrator`。桥接层复用 [06](06-events-service.md) 的服务语义，是继工具适配层（[07](07-tools.md) 分层总则）之后的第二个薄适配层。面板 UI 交互与构建注入由后续原型票补充，本文只定通信与刷新。

## 桥接形态

- **独立 Connection channel 的一元 RPC**：契约语义为 `connection.rpc.handle('/script-orchestrator', handler)`；浏览器侧 `ctx.connection.rpc.call('/script-orchestrator', endpoint, payload, signal)`。
- **实现备注（v0.1r，0.2.2-rc.1 实测）**：`connection.rpc.handle` 对第三方插件不可用——Cordis trace 把 `owner.webServer` 解析锚定到 client-connection 自身 fiber（其未注入 webServer），任何第三方插件调用必抛 `cannot get property "webServer" without inject`。实现改为**内联等价挂载**：`webServer.register` prefix 路由 + `connection.admit`（认证/fence 复用内建）+ 与宿主 `rpcFetchHandler` 对齐的 envelope 协议（client-request / server-response / gateway bad-request / handler failure）。浏览器侧调用面与错误形状零改动。
- 不使用 Typert Remote（不要求 `./typert` 生成物与 `remote.$mount` 注册链）；不占用保留 channel `/api`。
- 认证与 Host/Origin fence 复用 `connection.admit` 内建机制；v0.1 不加自定义 token、不做面板级权限。

## 端点表

| endpoint | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list` | `ListQuery` | `ListResult` | 与服务同形（含 `nextOffset`） |
| `view` | `{ id, runs? }` | `OrchestrationView & { runs }` | 与服务同形 |
| `create` | `OrchestrationInput` | `OrchestrationView` | |
| `edit` | `EditInput`（四 action） | `OrchestrationView \| DeleteResult` | 暂停/恢复直接 `action: 'pause' / 'resume'`，CAS 全 action 生效 |
| `run` | `{ id }` | `{ runId, status }` | **受理即返回**，`status` 可为非终态；不等结算 |
| `listActions` | `{}` | `Array<{ name, description? }>` | 编辑器的注册动作提示 |
| `spill` | `{ runId, stream: 'stdout' \| 'stderr' }` | `{ runId, stream, path, content, bytes }` | run 的完整溢写输出（排障读面，v0.1r）；溢写缺失/文件不存在/不可读 → `script_storage_unavailable`（`details.cause` 区分），面板显示「文件已不存在」 |

- 参数与返回**原样复用服务契约形状**（零翻译 DTO，全部无损 JSON）。
- 动作提示的读面（v0.1r 更正）：`view` 原样返回服务 `OrchestrationView`，其中 `availableActions` 即注册动作表快照（按 `name` 排序），面板详情直接展示；`listActions` 端点保留供按需刷新/单独取表（例如编辑器只要动作表、不取整条记录）。原「动作提示按需另调 `listActions`，不混入 `view` 返回」的表述与实现不符，以本条为准；两个读面同源（同一注册表快照），不是两套数据面。
- run 的进度与结果一律经 `view` 回读，`view()` 的 run 记录是最终事实。

## 创建/编辑的对话路径（胜选 UX，2026-11-08 原型定案）

面板的**主创建/编辑入口是对话式的**：点「新建/编辑」→ `uiWorkspace.startSession` 开新会话并注入引导 prompt → 用户在会话里由模型经 `script_create` / `script_edit` 工具完成配置（与内置「自动化任务」面板 `onNewTask` 同一先例与同一通道）。面板自身只承载**管理与排障**：列表（高密度表格）、行内操作（暂停/恢复/执行/删除）、**居中模态**的详情与 run 历史、状态展示（含 `active + nextOccurrence: null` 的「等待结算」）。`create`/`edit` RPC 端点保留（工具之外的编程入口与未来表单直建），但首版 UI 不做独立配置表单。macOS 未实机验证的风险提示**不进面板**（部署须知/诊断角落）。

## 校验、错误与 abort

- 桥接层只做**最小形状校验**：缺字段/类型错/多余字段 → `script_input_invalid` 同构映射（`unexpected` / `missing` / `range` / `format` + 准确 `field`）；业务语义全部由服务判定。
- 契约错误 `{ code, message, details? }` 原样透传；传输层失败由 Connection envelope 表达；不新增错误码。
- **abort 只终止等待，不取消已受理操作**：`create`/`edit` 照常完成（下次回读见结果）；`run` 端点不把 UI 请求 signal 传给执行——关掉详情页 ≠ 取消脚本 run；v0.1 面板不暴露 run 取消入口（删除编排连带取消其 run 属既有语义）。

## 刷新策略

权威数据永远来自 `list()`/`view()`，不依赖事件重放：

1. **写后权威回读**：`create`/`edit`/`run` 成功后立即重取 `list`/`view`。
2. **连接重置回读**：浏览器 `connection/reset` 事件后全量重取。
3. **活动 run 轮询**：仅当「面板可见 **且** 存在非终态 run」时每 **5 秒** `view(id)`；任一停止条件（无活动 run / 面板不可见 / 组件卸载）即停。

如实声明：`script-orchestrator/*` 不在第一方 Remote 事件转发白名单内，**没有实时事件推送**。

## 用户可观察语义

- Desktop 安装、manifest 变更、后端重启按**重启/刷新边界**生效，不承诺 SSE 级即时。
- 开发期 client HMR 重建会**重置面板 React 本地状态**（连接等外层状态保留），刷新后恢复。
- 无实时推送期间列表可能过期，一切以回读为准。
- 后台标签页不轮询（面板可见性与轮询联动）为实现验收项。
