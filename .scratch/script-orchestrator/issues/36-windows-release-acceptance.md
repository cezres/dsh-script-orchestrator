# 36: 完成 Windows 全链路交付验收

**What to build:** 安装者能在隔离 Windows 环境验证插件从创建编排到执行、分发、排障和删除的完整产品路径，并获得可复现的交付验收结果与如实残余风险说明。

**Blocked by:** 31 — 通过 plugin 动作调用注册能力；33 — 通过 ephemeral session 自动整理并回收；34 — 查看完整输出并自动裁剪 run 历史；35 — 从重启与存储故障中恢复

**Status:** resolved

- [x] 实施 spec 的单元、集成和端到端测试矩阵全部通过，无以待实现、跳过或仅验证 happy path 的方式替代关键取消、故障和恢复用例。
- [x] 以 file: 形态在隔离 profile 完成安装，`engines.dsh`、依赖闭包、Config、client graph 和 slot 均正确；HMR、冷重启、卸载及坏 client 启动级故障须知均按契约验收。
- [x] 端到端依次验证五工具 smoke、分别创建的 every/cron 编排各自动执行、判定命中、event/plugin/session 三动作、四类事件、面板对话入口和居中模态 run 历史、删除级联。
- [x] 复测 Windows W1/W2：原生 Job terminate 得到 `{ exitCode: 1, signal: null }`，spill 完整可读且超 cap 撤回；另行验证正常退出后存活后代的清理与 warning。
- [x] 验证工具 abort 会取消 run 并等待持久化，Connection UI abort 只停止等待；验证事件后的权威回读、轮询停止条件和删除前后的记录可见性。
- [x] macOS 只保留源码证据声明，不作为本验收门；裸 `.cmd`/`.bat`、Desktop 窗口、tsdown、flush/append、UI 可观测性、session 真实停用/卸载 teardown 证据边界、回收竞态和 file: rename 等残余风险均如实交接。
- [x] 验收记录包含实际环境、命令、结果和失败证据，不将原型证据冒充正式实现验收，不修改真实用户 profile，不合并抛弃式原型分支。

## Comments

- **验收产物**：`.scratch/script-orchestrator/evidence/ticket36-acceptance.md`（环境、命令、矩阵结果、W1/W2 复测、残余风险、可复现命令）；`scripts/verify-ticket36.ps1`（端到端验收脚本）；`evidence/ticket36-matrix.log` + `evidence/ticket36-verify-NN.log`（13 个隔离验证脚本的原始输出）。
- **测试矩阵执行**：`pkg` 内 vitest 全量 **17 文件 580 用例全绿**（含真实 Windows 子进程的 W1/W2、取消矩阵、存储故障恢复、session 两模式、ephemeral 回收、保留裁剪、I/O 恢复、关闭顺序）；隔离集成矩阵 verify-ticket24…36（每脚本自建 DSH_HOME + `--port 0` 动态端口，全断言通过，见验收记录 §2.2）。
- **code-review（双轴）与修复**：按 `code-review` 技能以固定点 `b5a008a...HEAD` 并行执行 Standards / Spec 两轴审查，发现汇总与处理：
  - **Standards 硬违规**：新增 `spill` 端点、`readSpill` 服务面、`zod` 依赖、`spill-unavailable` cause 未进契约 → 已按 `10-decisions` 契约变更流程回写 **v0.1r**（11-web-panel 端点表 + rpc.handle 实现备注、12-packaging 依赖集、09-states-errors 错误码、10-decisions 实现期补充、README 变更记录）。
  - **Standards 判断性异味**：选取低风险项修复（runner 死分支/`liveView` 合并、过时注释、`MAX_TOTAL_RUNS` 单一来源）；高重构成本项（runner 五张 per-run Map 合并、safeEmit/events 模块抽取、scheduler guard 抽取、sessionEnv Data Clumps、tools 参数重复、测试 helper 抽取、verify 脚本公共 lib、`__delete__` 哨兵、fixed-delay 规则收拢）**明确延后**，理由：全部 580 测试与 13 个隔离验收脚本已绿，纯结构重构风险大于收益，不影响契约/行为。
  - **Spec 发现（8 项，全部修复并补测试）**：① 存储写入前显式 `valueSchema.parse`（契约 08「写入前 parse」）；② `enabled` 与 `status` 一致性（pause→false / resume→true / update 归一）；③ 面板详情模态补对话式「编辑」入口（契约 11「新建/编辑」同一 `uiWorkspace.startSession` 通道）；④ `allowedRoots` 为空时首次激活警告（契约 03）；⑤ update 的 `patch` 显式校验（多余键/`null`/类型不符 → `script_input_invalid`，不再静默忽略）；⑥ judging 阶段取消「不响应」（契约 03 取消矩阵：返回 false、不置标志、动作照常执行并按动作汇总结算；dispatching 停止语义不变）；⑦ 工具 `script_run` 的 abort 竞态（`signal.aborted` 预判，已中止信号立即补一次取消）；⑧ 契约回写（`view.availableActions` 说明、10-decisions 追加 Windows Job 悬挂 ⑤）。
  - **审查修复引入的实现决策**：judging → dispatching 之间让出一个微任务边界（纯内存、毫秒级），使「judging 不响应取消」状态可被取消入口与测试观测；不影响计时与事件顺序（runner 测试全绿）。
- **残余风险（如实交接，详见验收记录 §4）**：macOS 未实机验证（仅源码证据声明，非验收门）；裸 `.cmd`/`.bat` 不承诺；Desktop 窗口内面板未验证；HMR 未验证（需宿主开发构建）；tsdown 常规构建档未验证；`flush()===true` 仅投递管线接受；正常 LLM 回合 append/UI 可观测性未实测；session 真实停用/卸载 teardown 以杀宿主近似；ephemeral 回收竞态仅承诺 durable inbox 边界；Windows「父退出留存活后代」`done`/`waitForExit` 悬挂（超时兜底，已入契约 v0.1r ⑤）；坏 client 包 = 启动级故障为契约部署须知（本票未构造坏包实例）。
- **最终矩阵（修复后代码）**：verify-ticket24–36 **13/13 全部 PASS**（耗时 6s–501s：24 20s / 25 10s / 26 92s / 27 501s / 28 143s / 29 6s / 30 76s / 31 81s / 32 146s / 33 123s / 34 9s / 35 11s / 36 49s；原始日志见 evidence/ticket36-matrix.log 与 ticket36-verify-NN.log）。
- **合规**：未修改真实用户 profile（全部隔离 DSH_HOME）；未合并抛弃式原型分支（`proto/*`、`research/*` 均未进入集成分支历史）。
