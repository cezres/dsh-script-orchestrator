# 核实子进程与跨平台终止语义

Type: research
Status: resolved
Labels: wayfinder:research
Research branch: research/subprocess-semantics
Findings: .scratch/script-orchestrator/research/subprocess-semantics.md
Research commit: ea94ccc64c6b2fb124c0110f335986a913b46147

## Question

在 DSH `0.2.2-rc.1` 中，`ctx.subprocess.spawn` 的 argv、cwd、env、stdin、stdout/stderr 收集、`terminate()`、grace、强杀、`done` 与 abort 的真实行为是什么？重点核实 Windows 与 macOS 的退出码/signal 差异、完整输出溢写和读取尾部是否可行，以及契约中的超时、取消和 `truncated`/`spillPath` 记录能否实现。只做源码与既有测试调查；若仍需运行实验，明确最小实验要回答的问题。

## Answer

1. 批量 stdin 的宿主字段是 `{ data: string }`，契约的 `{ text }` 必须在适配层映射，不能原样透传。不存在的 cwd 通常由 `done` 异步 reject；严格的 spawn 前 `spawn_failed` 需要插件预检。裸 `.cmd`/`.bat` 不属于已证实支持范围。
2. 调用方只应传 `script.env`。DSH 自动继承脱敏环境并剔除敏感名称与 `DSH_*`；传完整 `process.env` 会把敏感值作为显式覆盖重新注入。
3. stdout/stderr 的 `{ maxBytes }` 只保留内存尾部，最终 `readFrom(0).lossy` 可映射 `truncated`，从解码后的 `read.text` 取字符尾部。完整 spill 必须另配更大的有界 `spill.maxBytes`；超 cap 或 I/O 失败会撤回 spillPath，文件需外部清理。
4. `graceMs` 不是脚本超时，超时和取消原因必须由插件自行记录再 terminate/abort，不能靠 `done`、exitCode 或 signal 反推。同步 throw 与异步 `done` reject 都需映射，取消 rejection 不得误记为 spawn_failed。
5. POSIX/macOS 为 SIGTERM、grace 后 SIGKILL；Windows 首次终止即强杀，通常为 `{ exitCode: 1, signal: null }`，无法区分 TERM/KILL。macOS 走较弱 PGID 回退，本轮未做实机验证。
6. `run.script.signal` 只能解释为 provider 观测到的退出信号，不代表插件请求的终止级别。`done` 是直接命令结果加有界输出 drain，不等于整个 Job/PGID 范围退出；范围清理需看 `waitForExit()`，正常 done 后如何处理存活后代仍需契约决策。
7. 本轮未运行新实验。报告给出 Windows W1（原生 Job 选择与 1/null outcome）和 W2（spill 实读与超 cap 撤回）两个最小实验，用于确认本机打包宿主与文件系统行为。

完整证据：[子进程研究报告](D:/projects/dsh-script-orchestrator-research-subprocess-semantics/.scratch/script-orchestrator/research/subprocess-semantics.md)，分支 `research/subprocess-semantics`，commit `ea94ccc64c6b2fb124c0110f335986a913b46147`。
