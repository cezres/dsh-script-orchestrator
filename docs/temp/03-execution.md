# 03 · 脚本执行契约

## 定义字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `command` | string | 是 | — | 绝对路径，或 `PATH` 上可解析的裸命令名；不含参数 |
| `args` | string[] | 否 | `[]` | 逐项作为 argv 传递，**不经过 shell** |
| `cwd` | string | 否 | 见下 | 工作目录，必须落在允许的根之下 |
| `env` | object | 否 | `{}` | 追加/覆盖宿主环境变量；值为字符串 |
| `stdin` | `'ignore' \| { text: string }` | 否 | `'ignore'` | 需要喂数据时一次性写入后关闭 |
| `timeoutSeconds` | integer | 否 | 插件配置 `defaultTimeoutSeconds`（300） | 1–86400 |

`cwd` 解析顺序：`script.cwd` → 插件配置 `defaultCwd` → Host 进程工作目录。目录不存在时**在 spawn 前**失败为 `spawn_failed`，不进入执行。

## 调用形态

实现使用已核实的 `ctx.subprocess.spawn(spec)`（`@deepseek-ai/dsh-subprocess-local`）：

```js
const handle = ctx.subprocess.spawn({
  argv: [script.command, ...(script.args ?? [])],
  cwd,
  env: script.env ?? {},   // 宿主自动继承脱敏环境（剔除敏感名与 DSH_*）；插件只显式传覆盖项
  stdio: {
    stdin: script.stdin ?? 'ignore',          // { text } 由适配层映射为宿主 { data }
    stdout: { maxBytes: config.maxOutputBytes, spill: spillSpec },   // maxOutputBytes 默认 262144
    stderr: { maxBytes: config.maxOutputBytes, spill: spillSpec },
  },
  graceMs: 5000,
  signal,
})
```

`spillSpec`：`config.maxSpillBytes > 0` 时为 `{ maxBytes: config.maxSpillBytes }`，否则 `undefined`（禁用溢写，仅内存尾部）。

- 不拼接命令行字符串；`args` 中的引号、空格、通配符保持字面量。
- 裸 `.cmd` / `.bat` 命令**未验证、不承诺**（Windows 原生路径走 `CreateProcessW`，脚本解释器类型不在已证实范围）；需要 shell 语义时显式写 `pwsh -Command ...`，验收矩阵不含 `.cmd`/`.bat`。

## 失败与取消分类

判定依据是插件自己的标志位，不猜 `done` rejection 的内容：

1. 插件在调用 `terminate()` 前**先置内部 `cancelReason`**（`timeout` 或 `cancel`）。`done` reject 时若 `cancelReason` 已置位 → 按超时（`timedOut = true`）/ 取消（结算 `canceled`）处理，**不记 `spawn_failed`**。
2. `cancelReason` 未置位时的同步 throw（argv/env 非法）与 `done` 异步 reject（如二进制 `ENOENT`）→ `spawn_failed`，`details.cause` 保留原始错误字符串。
3. 已预取消（spawn 时 `signal` 已触发）的同步 throw → 结算 `canceled`，不是 `spawn_failed`。
4. `cwd` 目录不存在在 **spawn 前**预检失败为 `spawn_failed`（见上文解析顺序），不等宿主异步拒绝。

## 超时与终止

```
到点 → handle.terminate() → 等待 graceMs(5000) → 仍未退出则强杀
```

- 超时后 **`run.script.timedOut = true`**；`signal` 记录 provider 观测到的实际终止信号——POSIX 为 `SIGTERM`/`SIGKILL`，**Windows 实测恒为 `null`**（原生 Job 终止的 `done` 为 `{ exitCode: 1, signal: null }`，2026-11-08 实机验证）；`exitCode` 在信号终止时可能为 `null`（Windows Job 终止为 `1`）。
- `signal` **仅表示 provider 观测结果**：不区分 TERM/KILL，Windows 恒 `null`，不能用它反推终止级别或原因；原因由插件自记（`timedOut`/`cancelReason`），见「失败与取消分类」。
- 超时**不是**执行失败：run 照常进入判定阶段，由规则决定如何处理（通常匹配 `timedOut: true`）。
- `run` 级取消（`script_run` 的 abort、插件卸载）同样走 `terminate()`，结算为 `canceled`。
- **正常退出后的存活后代**：`done` 结算脚本事实（exitCode/signal/输出）后，有界等待 `waitForExit()` **2000ms（契约常量，不进配置）**；仍未完成则再调一次 `terminate()` 清空进程范围（Windows=Job 内全杀、macOS=PGID 回退），并在 `run.script.warnings` 记一条 `descendants-terminated`。语义：**进程树生命周期以 run 为上限**，不留后台存活者；需要常驻进程的场景另起编排。
- 平台矩阵：Windows 立即强杀（Job）；macOS 走 PGID 回退**未实机验证**，最终 spec 的验收矩阵仅含 Windows，macOS 残余风险须写入 spec。

## 输出收集

`await handle.done` 之后按流读取（stdout、stderr 各一次）：

```js
const out = handle.collected.stdout?.readFrom(0)
// { text, nextOffset, lossy, spillPath? }
```

| 情形 | 记录 |
|---|---|
| 未超 `maxOutputBytes`（`lossy: false`） | `truncated: false`，`stdoutTail` 为全文 |
| 超限或读取有损（`lossy: true`） | `truncated: true`，`stdoutTail` 取**解码后文本**的末尾 2048 个 code point |
| 该流溢写成立（`spillPath` 存在） | 记入 `stdoutSpillPath` / `stderrSpillPath`，UI/排障可读全量 |
| 溢写超 cap 被撤回（`spillPath === undefined`） | 对应字段缺省，内存尾部不受影响 |

- `stderr` 同规则。输出永远按 **UTF-8 文本**处理，不做二进制猜测。
- 字节截断若切断多字节字符，解码产生的 U+FFFD 替换字符如实保留并计入 2048。
- **`truncated` 的判定就是 `lossy`（按流）**：溢写文件存在不改变 `truncated: true`——全量可用性由 spill 字段另行表达。
- 溢写配置：插件配置 `maxSpillBytes`，默认 **8388608（8 MiB）/流**，stdout 与 stderr 各自独立；`0` 禁用溢写。溢写文件由子进程服务落在系统 temp，插件在**裁剪 run 或级联删除 run 时 best-effort `unlink`**；不做启动扫描，崩溃残留交给 OS temp 清理；UI 读取 spill 失败时显示「文件已不存在」。
- `run.script.warnings?: string[]`（沿用 actions 的 warnings 纪律：确定性文案、保最近 20 条）：脚本阶段非致命事实排障信息（`descendants-terminated`、`result-marker-invalid`）；**只进 run 记录与 UI，不进判定谓词、不进事件载荷**。

## 结果上报（标记行，v0.1y）

脚本可以用一行标记向执行记录回报**人类可读的执行结果**，UI 在 run 卡片中优先展示：

```
##SCRIPT-RESULT## {"summary":"清理了 3 个重复文件","level":"info","fields":{"扫描":"42","回收":"3"}}
```

- **格式**：单个 stdout 行 = 前缀 `##SCRIPT-RESULT## `（含尾随空格）+ 单行 JSON 对象。字段：`summary`（必填，trim 后 1–300 个 code point）；`level`（可选，`'info' | 'warn' | 'error'`，缺省 `'info'`）；`fields`（可选，≤ 8 项 string→string，键 1–40、值 1–100 个 code point）。
- **解析**：结算时从 stdout **收集文本**（`readFrom(0).text`，与 `stdoutTail` 同源）逐行扫描；多条标记行时取**最后一条可解析且合法**的；标记行在输出中的位置不限（建议靠近末尾）。stderr 不参与。
- **失败即忽略**：标记行非法 JSON、非对象、`summary` 缺失/空/超长、`level` 非法、`fields` 超限——该行忽略并在 `run.script.warnings` 追加一条 `result-marker-invalid`，**不影响 run 状态、判定与动作**；同一次输出里此前的合法标记行仍有效（取末条合法者的语义）。
- **溢写边界**：解析只看内存收集文本；输出超出 `maxOutputBytes` 且标记行只剩在溢写文件中时解析不到，视为未上报（spill 排障读面仍可看全量）。
- **落库**：合法解析写入 `run.result` 的 `summary`/`level`/`fields`（见 [01-domain-model](01-domain-model.md)）；会话侧可经 `script_report` 工具继续追加 `reports`（见 [07-tools](07-tools.md)）；两者合并不互相覆盖。
- 判定谓词、模板变量与事件 `script` 块**不包含**标记行的任何特殊处理——标记行只是 stdout 文本的一部分。

## 并发与单飞

**单飞屏障**：同一编排同时至多 1 个脚本在跑；任何 run（手动/自动）都在同编排上一个 run 结算后才开始。屏障管「何时开始」，overlap 模式管「调度积压要不要保留」，两条规则正交：

| 层 | 规则 |
|---|---|
| 单编排 | `overlap: 'skip'`（默认）→ 上次未结束时本次记 `skipped`，`skipReason: 'overlap'`；`'queue'` → 排队，队列上限 1，**再溢出时新者 skip**（`skipReason: 'overlap'`；与 [02-triggers](02-triggers.md) 错过合并语义同向——保最老的 pending 尽快追赶） |
| 全局 | 同时运行的 run 不超过 `maxConcurrentRuns`（默认 2）；超出的排队 |
| 排队上限 | `maxConcurrentRuns × 4`；溢出时丢弃**最旧**的排队项，记 `skipped`，`skipReason: 'concurrency'`（保护别的编排不被饿死；**不区分来源**——手动 run 同样可被丢，`script_run` 返回 skipped 结果，可见非静默） |

- **手动执行**（`trigger: 'manual'`）与自动触发共用同一排队体系（占并发槽、进单飞屏障），但**不被 `overlap: 'skip'` 淘汰**——显式意图排队等上次结算，不静默消失。
- **两写统一**：一切入过队的 run 都有完整记录（写 1 创建 `queued` + 写 2 结算）。disabled / overlap / concurrency 的 skip 也是两条写（几乎同时发生），含 `scheduledAt` 与 `skipReason`，UI 可解释「为什么没跑」。唯一无 run 记录的取消是宿主层 `ABORTED_BEFORE_DISPATCH`（插件根本没收到调用）。
- 排队只发生在脚本阶段；动作分发不计入并发额度（动作是轻型调用，但单个 run 的动作串行执行，见 [05-actions](05-actions.md)）。

## 取消与等待

**取消矩阵**——来源（`script_run` 的 abort、`delete`、插件卸载）× 阶段（见 [09](09-states-errors.md)）：

| 阶段 | 行为 |
|---|---|
| `queued` | 直接结算 `canceled`，不 spawn |
| `running` | `terminate()`（5 秒 grace + 强杀）→ 结算 `canceled` |
| `judging` | **不响应取消**：纯内存计算、毫秒级，自然前进 |
| `dispatching` | 当前动作按其 `signal` 中止等待 + **停止派发剩余动作**；已执行动作结果保留在记录；结算 `canceled`（**终态优先于动作汇总**） |

- **终态唯一（first-write-wins）**：取消与自然结算竞争时，FIFO 写序下第一笔终态结算生效；迟到的结算尝试为 no-op——不覆写字段、不重发 `run-settled`。一行规则终结全部竞态。
- **delete 时序**：按上表取消全部未终态 run → 各自结算 `canceled`（两写）→ **`run-settled(canceled)` 照常发布**（此刻记录仍在，载荷自足）→ 同批删除（先编排后 runs，见 [07-tools](07-tools.md)）→ **不为删除另发事件**。订阅者事后 `view()` 查无此 run 属预期：事件不重放、`view()` 是事实源（见 [06](06-events-service.md)）。
- **exec.signal 贯穿与静止**：`script_run`（服务 `run`）收到 abort → 执行服务把 signal 转成**该 run 的取消请求**（按上表执行），等 run 结算 `canceled` 且**持久化完成后**，工具 Promise 才以宿主 `ABORTED` 规范结果静止——终止的是 run，不是等待。`wait: false` 已提前返回的 run 同样被取消：**取消不依赖等待者存在**。宿主 `ABORTED_BEFORE_DISPATCH` 时插件未收到调用，无 run 记录。

## 重启与崩溃

- 创建 run 记录并提交后才会 spawn；因此崩溃可能留下 `running` 记录。
- Host 启动时把所有非终态 run 标为 `interrupted`，**不自动重放**，只发一条 `run-settled`（`status: 'interrupted'`）。
- 单 timer 的运行态不落盘；`nextOccurrence` 随编排持久化。重启后保留未来时刻，并按 [02-triggers](02-triggers.md) 处理错过的触发与 `interrupted` run，不统一重新锚定。

## 安全边界

- 脚本以插件进程权限运行，**不经过 DSH 的文件沙箱与审批**；这是本插件最大的风险面。
- 唯一的约束是配置项 `allowedRoots`：非空时，`cwd` 必须落在某个根之下（前缀匹配并对路径做规范化）；为空表示不限制，插件会在首次激活时记录一条警告。
- 不提供 `shell: true` 这类开关；需要 shell 语义时由用户显式写 `pwsh -Command ...` 或 `bash -lc ...`，风险由配置者自担。
- 环境变量按白名单泄漏风险处理：`env` 只做追加/覆盖，不提供「清空继承环境」的选项，避免误删 `PATH` 造成难诊断的失败。
