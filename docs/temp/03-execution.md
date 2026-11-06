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
  env: { ...inherited, ...script.env },
  stdio: {
    stdin: script.stdin ?? 'ignore',
    stdout: { maxBytes: config.maxOutputBytes },   // 默认 262144
    stderr: { maxBytes: config.maxOutputBytes },
  },
  graceMs: 5000,
  signal,
})
```

- 同步抛错（argv/cwd/env 非法、已预取消）一律映射为 `spawn_failed`。
- 不拼接命令行字符串；`args` 中的引号、空格、通配符保持字面量。

## 超时与终止

```
到点 → handle.terminate() → 等待 graceMs(5000) → 仍未退出则强杀
```

- 超时后 **`run.script.timedOut = true`**，`signal` 记录实际终止信号（`SIGTERM` 或 `SIGKILL`），`exitCode` 可能为 `null`。
- 超时**不是**执行失败：run 照常进入判定阶段，由规则决定如何处理（通常匹配 `timedOut: true`）。
- `run` 级取消（`script_run` 的 abort、插件卸载）同样走 `terminate()`，结算为 `canceled`。

## 输出收集

`await handle.done` 之后读取：

```js
const out = handle.collected.stdout?.readFrom(0)
// { text, nextOffset, lossy, spillPath? }
```

| 情形 | 记录 |
|---|---|
| 未超 `maxOutputBytes` | `truncated: false`，`stdoutTail` 为全文 |
| 超限或读取有损 | `truncated: true`，`stdoutTail` 取末尾 2048 字符 |
| 子进程服务给出溢写文件 | `spillPath` 原样记录，UI/排障可读全量 |

`stderr` 同规则。输出永远按 **UTF-8 文本**处理，不做二进制猜测。

## 并发与单飞

| 层 | 规则 |
|---|---|
| 单编排 | `overlap: 'skip'`（默认）→ 上次未结束时本次记 `skipped`，`skipReason: 'overlap'`；`'queue'` → 排队，队列上限 1 |
| 全局 | 同时运行的 run 不超过 `maxConcurrentRuns`（默认 2）；超出的排队 |
| 排队上限 | `maxConcurrentRuns × 4`；溢出时丢弃**最旧**的排队项，记 `skipped`，`skipReason: 'concurrency'` |

排队只发生在脚本阶段；动作分发不计入并发额度（动作是轻型调用，但单个 run 的动作串行执行，见 [05-actions](05-actions.md)）。

## 重启与崩溃

- 创建 run 记录并提交后才会 spawn；因此崩溃可能留下 `running` 记录。
- Host 启动时把所有非终态 run 标为 `interrupted`，**不自动重放**，只发一条 `run-settled`（`status: 'interrupted'`）。
- 定时器状态不落盘，重启后按各编排的 `nextOccurrence` 重新计算。

## 安全边界

- 脚本以插件进程权限运行，**不经过 DSH 的文件沙箱与审批**；这是本插件最大的风险面。
- 唯一的约束是配置项 `allowedRoots`：非空时，`cwd` 必须落在某个根之下（前缀匹配并对路径做规范化）；为空表示不限制，插件会在首次激活时记录一条警告。
- 不提供 `shell: true` 这类开关；需要 shell 语义时由用户显式写 `pwsh -Command ...` 或 `bash -lc ...`，风险由配置者自担。
- 环境变量按白名单泄漏风险处理：`env` 只做追加/覆盖，不提供「清空继承环境」的选项，避免误删 `PATH` 造成难诊断的失败。
