# 脚本编排 v0.1 实现就绪方案

Labels: wayfinder:map

## Destination

形成 `.scratch/script-orchestrator/spec.md`：让实施者能够在 DSH `0.2.2-rc.1` 上实现 v0.1 插件与 Web 管理面板，并获得明确的模块边界、实施顺序、测试矩阵和验收标准。本地图只消除事实与决策不确定性，不编写插件实现代码。

## Notes

- 领域与事实来源：`docs/temp/README.md` 是索引与术语表；每个议题先读相关契约及 `docs/temp/10-decisions.md`。契约需要修正时，按既定流程同步对应文档、决策记录和 README 变更记录。
- v0.1 正式触发器只有 `every`、`cron`。Web 面板提供每日/每周快捷预设并生成 cron，不引入 `daily`/`weekly` 持久化类型。
- v0.1 包含五个 `script_*` 工具、`ctx.scriptOrchestrator` 服务、`event`/`plugin`/`session` 动作、宿主 JSON 存储，以及 Web 管理面板。
- Web 面板包含编排列表与详情、创建/编辑、暂停/恢复/删除、手动执行、run 历史及脚本/判定/动作结果查看。
- 宿主基线仅为 DSH `0.2.2-rc.1`；实现需兼容 Windows、macOS，但只以 Windows 做实际验证，macOS 未实机验证的残余风险必须写入 spec。
- 每个会话先读 `docs/agents/issue-tracker.md`。决策讨论调用 `grilling` 与 `domain-modeling`；接口设计调用 `codebase-design`；研究和原型分别按 ticket 类型调用 `research`、`prototype`。
- 与用户沟通使用简体中文。ticket 名称是可读引用，正文不只用编号指代议题。
- 研究分支为一次性本地分支，不合并、不开 PR；当前仓库未配置 remote，无法推送。

## Decisions so far

- [核实会话创建与首条消息投递](issues/01-research-session-actions.md)：root 有可行创建路径，但完整 UserMessage、preset/model composition、delivery 边界需修正；无 parent 的 orphan 不能兑现原 child 语义。
- [核实事件与插件服务机制](issues/02-research-events-services.md)：自定义事件与同 scope Host 服务可用；载荷约束、listener 失败隔离、renderer 桥接和动作注销语义需由插件显式设计。
- [核实子进程与跨平台终止语义](issues/03-research-subprocess.md)：主路线可复用，但需修正 stdin/env/spill/错误适配，区分 done 与范围退出，并接受 Windows 与 macOS 的终止差异。
- [核实工作区插件、工具与配置机制](issues/04-research-plugin-runtime.md)：单包自插入、依赖与 Config 路径可行；严格工具参数校验需原始注册适配，真实安装/HMR 仍需原型验证。
- [核实 Web 面板发现构建与注入](issues/05-research-web-client.md)：普通第三方双面插件有正式注入路径；浏览器需显式桥接 Host 服务，构建闭环与通信策略仍需决策。
- [核实存储域与 JSON 持久化](issues/06-research-storage.md)：两次写入与 FIFO 可行，但当前域名、single 坏记录策略、跨表原子性和自动迁移假设不符合宿主真实能力。
- [确定 every 与 cron 的调度语义](issues/07-trigger-semantics.md)：v0.1 采用 every 双模式与五位 cron；每日/每周由面板生成 cron，并已明确创建、编辑、暂停恢复、重启错过和无解规则。
- [统一动作命名与注册契约](issues/08-action-naming.md)：三类名字各立规则，注册动作名必须 `<namespace>.<verb>` 单点两段并保留 `script-orchestrator.` 前缀；查表在逐动作执行前、dispose 不中止在途动作；disposer 四不变量与仅调用方所有权写入契约。
- [统一工具与服务的管理接口](issues/09-management-interface.md)：语义以服务为准、工具为薄适配层；edit 对齐四 action（pause/resume 幂等状态设置语义）、乐观并发全 action、delete 取消在途 run 后同批级联；`listActions()` 供 availableActions 带 description；工具严格校验全映射 `script_input_invalid`，wait 超限返回非终态 RunView 不报错。
- [澄清判定模板与结果字段](issues/11-judge-template-results.md)：matchedRule 定零下标、truncated 谓词按流声明；warnings 统一 string[] 保最近 20 条；payload 递归渲染恒合法 JSON，template_invalid 仅剩 prompt 空；渲染在动作执行前不计超时。
- [确定存储布局与故障恢复契约](issues/14-storage-recovery.md)：域名 `script_orchestrator`、布局 per-record 与两层坏记录语义；单 Host 写者、服务层 FIFO 与关闭顺序；级联与裁剪为可恢复最终一致（孤儿清理、未结算不淘汰、settledAt/runId 定序）；惰性写回、写入前校验、I/O 未知走关闭-重开-对账，错误码统一 script_storage_unavailable。
- [确定 Web 面板通信与刷新契约](issues/15-web-communication.md)：独立 Connection channel 一元 RPC、六端点零翻译 DTO、abort 只终止等待不取消操作；刷新为写后回读 + reset 回读 + 5 秒活动轮询；认证复用内建 fence，无实时推送如实声明；新增 11-web-panel 契约。
- [验证最小 Web 客户端构建与注入](issues/16-web-build-prototype.md)：闭环四段在隔离沙箱无头实例全部实证；构建档位定简化档（手写 lazy-CJS，零构建步骤）；slot 注册蓝图与官方 CLI/单实例锁/坏包启动级故障等运维事实入档，原型留在 proto/web-build 分支供正式面板起步。
- [确定事件发布与失败隔离契约](issues/17-event-publication.md)：emit + 双层隔离（发布端兜底 + listener 纪律）；发布前全新 JSON 安全载荷、发布后不可变；64 KiB 按 UTF-8 字节、tail 按 code point 减半兜底；回读一致性（事件在持久写入与内存更新后发布）；无重放、view() 事实源、不进 inspect、不自动到 renderer。
- [验证 Windows 终止与输出溢写](issues/19-windows-subprocess-prototype.md)：W1 实证原生 Windows Job（terminate → `{exitCode:1, signal:null}`、waitForExit true）；W2 实证双层收集（内存尾部 + 完整 spill 可读）与超 cap 撤回 spillPath；Windows 口径已同步 03/10 契约，不外推 macOS。
- [确定脚本进程与输出契约](issues/18-process-output-contract.md)：适配层只传 `script.env`、stdin text→data；失败分类以自置 `cancelReason` 为据（预取消→canceled、其余→spawn_failed）；裸 `.cmd`/`.bat` 不承诺；后代有界等待 2000ms 后 terminate（进程树以 run 为上限）；`maxSpillBytes` 默认 8 MiB/流；tail 末 2048 code point、`truncated` 即 `lossy`；spill 按流拆字段、裁剪时 best-effort 清理。契约 v0.1j。
- [澄清执行排队取消与等待语义](issues/10-execution-lifecycle.md)：单飞屏障（手动不被 overlap:skip 淘汰）；单飞队列溢出新者 skip、全局溢出丢最旧不豁免手动（skipped 可见）；两写统一（唯一无记录 = ABORTED_BEFORE_DISPATCH）；取消矩阵（judging 不响应、dispatching 停止派发且已执行动作保留、终态优先于汇总）；first-write-wins；delete 取消→发 settled→同批删；exec.signal 贯穿为 run 取消、持久化后工具才 ABORTED 静止。契约 v0.1k。
- [重新界定 session 动作模式](issues/20-session-modes.md)：两模式均为宿主语义 root——`persistent`（默认，插件运行期间不主动回收）与 `ephemeral`（`whenIdle()` 收敛含用户接管期间 + `idleDisposeSeconds` 后 dispose，teardown 不删日志）；真正 child 移非目标（需 exact live parent，走 `startActivation`）；插件卸载一律 teardown 如实声明；`delete` 编排不触碰已开会话；待验证 #2 结案（id 直接铸 `session-${randomUUID()}`）。契约 v0.1l。
- [确定会话创建投递与回收契约](issues/21-session-delivery-lifecycle.md)：UserMessage 以 `kind: 'user'` + banner 投递（#3 结案）；成功 = 创建 + followup 接受 + flush 未拒绝（后续实验收窄为投递管线接受，不证明消息已落日志）；`delivery_failed` 保留会话（`run.actions[]` 增 `sessionId?`）且失败 ephemeral 不回收；title 缺省 `${编排标题} · ${runId 尾 4 位}`；不做 Workspace attach、每执行新建会话；回收竞态与重启不认领如实声明。契约 v0.1m；后续由 [最小宿主集成实验（会话创建到回收闭环）](issues/23-session-integration-prototype.md) 修订 flush 口径。
- [确定插件打包依赖与安装方案](issues/22-package-installation.md)：单包双面 + `engines.dsh` 精确锁 0.2.2-rc.1；依赖最小集（dsh-util-time + 校验库）+ peer 仅实际 import 时列 + 禁 dsh-agent 常量依赖；file: 验收 / link: 开发；隔离 profile 验收清单与「坏 client 包 = 启动级故障」部署须知；`private` 不上 npm。新增 12-packaging 契约；待验证 #7 结案（16 号实证）。契约 v0.1n；依赖归属交叉引用由 v0.1q 纠错。
- [设计 Web 管理面板交互原型](issues/12-web-panel-prototype.md)：胜选 = 高密度表格（C）+ 居中模态详情 + **对话式创建/编辑**（`uiWorkspace.startSession` + 引导 prompt，模型经 `script_*` 工具配置；面板只管管理与排障，首版无独立表单）；macOS 提示不进面板。契约 v0.1o；原型留 proto/web-panel 分支。
- [最小宿主集成实验（会话创建到回收闭环）](issues/23-session-integration-prototype.md)：两条创建路径全链实证；UserMessage 内联构造定案（import 不可行，#6 结案）；`whenIdle` 挂 agent；已 dispose 会话再投递实证抛错；**`flush===true` 收窄为投递管线接受**（死路由场景日志仅 header，不证明消息落盘）——契约 v0.1p 修订。原型留 proto/session-integration 分支。
- [确认实施模块与验收方案](issues/13-implementation-spec.md)：spec.md 落盘并完成复审；七模块、八步实施与三层矩阵不变，补齐执行生命周期、安全边界、工具/面板 abort 及关键动作事件验收；事实源陈旧表述按 v0.1q 修正。待验证 #4 声明性结案（编号 #1–#7 全清），**Destination 维持达成**，前沿清零、雾区已空。

## Not yet specified

- （已清空——原「最小宿主集成实验」雾区随 [确定会话创建投递与回收契约](issues/21-session-delivery-lifecycle.md) 定案，毕业为 [最小宿主集成实验（会话创建到回收闭环）](issues/23-session-integration-prototype.md)。）

## Out of scope

- RRULE 及其 `COUNT`、`UNTIL`、月度/年度高级规则：延后到后续版本。
- `at`、`after` 一次性触发器：延后到后续版本。
- `daily`、`weekly` 作为正式持久化触发器类型：由 `cron` 无损覆盖；其用户友好的面板预设仍在范围内。
- webhook 出站、编排之间串联、脚本沙箱：沿用契约既定非目标。
- 旧于 DSH `0.2.2-rc.1` 的宿主兼容，以及 Linux 专门适配或实机验收。
- Web 面板中的注册动作管理、指标图表、权限管理和独立通知中心。
- 在 wayfinder 地图内编写插件实现代码或直接创建实施 issues；实施 issues 在最终 spec 交接后另建。
