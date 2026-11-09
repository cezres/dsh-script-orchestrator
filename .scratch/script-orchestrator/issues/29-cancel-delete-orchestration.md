# 29: 取消在途 run 并安全删除编排

**What to build:** 用户可以取消工具调用所对应的 run，或经面板确认删除编排；系统按阶段取消、等待结算持久化，再完成级联删除，不留下继续派发动作的孤儿执行。

**Blocked by:** 28 — 编辑触发、暂停/恢复并手动执行编排

**Status:** resolved

- [x] 工具 `exec.signal` 贯穿到 run：queued 直接 canceled、running 终止进程、judging 不响应、dispatching 停止剩余派发并保留已执行动作结果。
- [x] run 结算 canceled 且持久化后工具 Promise 才以宿主 `ABORTED` 静止；wait=false 已返回的 run 同样取消，`ABORTED_BEFORE_DISPATCH` 不产生 run 记录。
- [x] 取消与自然结算竞争时 first-write-wins，迟到结算不覆写、不重复发布 `run-settled`，终态优先于动作汇总。
- [x] `script_edit(action=delete)` 支持全状态与 CAS，先取消全部未终态 run、照发对应 `run-settled(canceled)`，再在同一服务槽位先删编排后删 runs，返回准确 `removedRuns`，不为删除补发事件。
- [x] 面板删除有二次确认，操作期间状态清晰，成功后回读列表；Connection UI abort 不取消已受理删除，工具与面板取消语义保持不同。
- [x] 集成测试覆盖四阶段取消、wait=false、预取消、终态竞争、删除事件时序、级联结果和面板确认路径。

## Comments

- **实施（2026-11-09，两段）**：原实施者 impl-30 完成 4 个提交（020cdb9 认领 → 46973d4 runner 取消矩阵 + shutdown 取消 + markDeleting 阻断 → 2522f05 service delete 两阶段级联 → c3338f1 tools exec.signal 贯穿）后回合因模型额度中断；Lead 接手，修复 client.js 未完成写法的括号结构、补齐面板删除二次确认与测试断言、新增隔离验证脚本并完成票面收尾。
- **交付**：
  - `lib/runner.js`：`cancelRun` 四阶段矩阵（queued 直接结算 canceled、running 终止进程、judging 不响应、dispatching 经 requestCancel 停止剩余派发并保留已执行动作结果）；`shutdown` 卸载取消；`markDeleting` 阻断删除中受理。
  - `lib/service.js`：`edit(delete)` 两阶段——槽 1（CAS + 标记删除中 + 收集未终态 run）→ 槽外按取消矩阵取消并等待结算（有界，`deleteWaitMs` 注入）→ 槽 2 同批先删编排后删 runs，返回 `{ id, removedRuns }`，不为删除补发事件（`changed` 不发），spill best-effort 清理。
  - `lib/tools.js`：`script_run` 的 `exec.signal` 贯穿（abort → 取消矩阵 → 等结算持久化后工具 Promise 以宿主 `ABORTED` 静止；wait=false 已返回的 run 同样取消；`ABORTED_BEFORE_DISPATCH` 不产生 run 记录）。
  - `lib/client.js`：行内删除按钮（全状态）+ 居中二次确认模态（级联取消与不可恢复提示、删除中禁用与「删除中…」、失败契约错误条可重试、成功后关闭确认并回读列表、详情模态正开着该编排则一并关闭）。
- **测试**：全量 514 用例全绿（runner/service/tools/actions/bridge/client/index 覆盖四阶段取消、wait=false、预取消、终态竞争、删除事件时序、级联结果、面板确认路径）。
- **隔离验证**：`scripts/verify-ticket29.ps1` 全断言通过（自建 DSH_HOME、`--port 0` 动态端口、杀端口监听进程清理）——长脚本手动 run 在途时 delete → `removedRuns=1`、delete 耗时 48ms（取消而非等 30s 自然完成）、L 级联删除后列表仅剩 P、view 已删编排 → `script_unknown`、delete CAS 不匹配 → `script_conflict`、active 无 run 与 paused 全状态删除、全部删除后 list 归零、stderr 无本插件错误。
- **偏差与残余风险**：
  - `run-settled(canceled)` 的事件时序由 service 单测确定性覆盖（隔离脚本未安装事件探针插件）；工具 `exec.signal` 四阶段矩阵由单测覆盖（桥 run 端点按契约不透传 signal＝UI abort 只终止等待，不取消已受理 run）。
  - delete 的取消等待有界（缺省按「脚本 terminate 5s grace + 各动作自身 timeoutSeconds」推得）；超时降级照删（单测覆盖），极端病态动作实现可能留下迟到结算，由 first-write-wins 丢弃。
  - 面板浏览器实机未重跑（jsdom 真组件覆盖删除确认路径；浏览器实机统一由票 36 验收覆盖）。
