// 执行引擎（契约 docs/temp/03-execution.md）：run 生命周期唯一拥有者。
// 单飞屏障 + 全局并发/排队、两写结算、argv 直传 spawn（不经 shell）、cwd/allowedRoots
// 预检、超时（cancelReason 自置标志位分类）、输出按流解码尾部、正常退出后存活后代
// 的有界等待与清理、run-started/run-settled 事件（持久写入与内存更新后发布）。
// 票 30：脚本退出后进判定（judging 内存态）→ 非零动作串行派发（dispatching 内存态，
// 不占 FIFO 槽、不落盘）→ 按契约 09 汇总定终态；action-settled 按动作执行序在写 2
// 之后、run-settled 之前发布。
// 票 29：cancelRun 落实完整取消矩阵（queued 直接 canceled / running terminate 后
// canceled / judging 不响应·派发面停止 / dispatching 停止剩余派发），first-write-wins
// 终态唯一；shutdown（卸载=取消来源）将有界等待后未结算的 run 取消结算 canceled；
// markDeleting 阻断删除中编排的新 run 受理（service.delete 两阶段协调）。
// 服务 run / script_run 只经 requestRun 触发，不另造排队或结算逻辑（spec §2）。
import { evaluateJudge } from './judge.js'
import { dispatchActions, aggregateRunStatus } from './actions.js'
import { isWithin, tailText } from './execution-utils.js'

export const TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed', 'skipped', 'canceled', 'interrupted'])
/** 正常退出后存活后代的有界等待上限（契约 03 常量，不进配置）。 */
export const DESCENDANTS_WAIT_MS = 2000
/** run-settled 载荷的 UTF-8 预算（契约 06「64 KiB 计量与兜底截短」）。 */
export const EVENT_BUDGET_BYTES = 65536
/** stdoutTail / stderrTail 的 code point 上限（契约 01/03）。 */
export const TAIL_CODEPOINTS = 2048

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const iso = (ms) => new Date(ms).toISOString()

function randomRunId() {
  const bytes = new Uint8Array(4)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
    return `run-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  }
  return `run-${Math.random().toString(16).slice(2, 10)}`
}

/** run.script 空壳（skipped / spawn_failed / interrupted 等未产出阶段）。 */
function emptyScript(command, over = {}) {
  return {
    command,
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
    stdoutTail: '',
    stderrTail: '',
    truncated: false,
    ...over,
  }
}

/**
 * run-settled 载荷（契约 06 RunSettled）：发布前构造全新对象；超 64 KiB 时对
 * stdoutTail/stderrTail 依次减半保留末尾（按 code point 切割，不产生半个代理对）。
 * 脚本阶段 warnings 不进事件载荷（契约 03/06）。
 */
export function buildSettledPayload(run) {
  const payload = {
    runId: run.runId,
    orchestrationId: run.orchestrationId,
    status: run.status,
    trigger: run.trigger,
    scheduledAt: run.scheduledAt,
    startedAt: run.startedAt,
    settledAt: run.settledAt,
    script: {
      exitCode: run.script.exitCode ?? null,
      signal: run.script.signal ?? null,
      timedOut: run.script.timedOut === true,
      durationMs: run.script.durationMs ?? 0,
      truncated: run.script.truncated === true,
      ...(run.script.stdoutSpillPath !== undefined ? { stdoutSpillPath: run.script.stdoutSpillPath } : {}),
      ...(run.script.stderrSpillPath !== undefined ? { stderrSpillPath: run.script.stderrSpillPath } : {}),
    },
    stdoutTail: run.script.stdoutTail ?? '',
    stderrTail: run.script.stderrTail ?? '',
    matchedRule: run.matchedRule ?? null,
    usedFallback: run.usedFallback === true,
    actions: (run.actions ?? []).map((action) => ({ name: action.name, kind: action.kind, status: action.status })),
  }
  const size = () => Buffer.byteLength(JSON.stringify(payload), 'utf8')
  for (const field of ['stdoutTail', 'stderrTail']) {
    while (size() > EVENT_BUDGET_BYTES && payload[field].length > 0) {
      const points = Array.from(payload[field])
      payload[field] = points.slice(Math.ceil(points.length / 2)).join('')
    }
  }
  return payload
}

/**
 * 建执行引擎。
 * @param {object} deps
 * @param {object} deps.storage openStorage() 的返回值（内存读视图）
 * @param {object} deps.queue ServiceQueue（一切持久写入的复合槽位）
 * @param {object} deps.subprocess { spawn(spec) }（宿主 ctx.subprocess 形状）
 * @param {object} deps.config 已验证的插件配置（maxConcurrentRuns/defaultTimeoutSeconds/maxOutputBytes/maxSpillBytes/allowedRoots/defaultCwd）
 * @param {(name: string, payload?: unknown) => void} deps.emit 事件发布
 * @param {() => number} [deps.now] 时钟注入（默认 Date.now）
 * @param {object} [deps.logger] 内部日志
 * @param {object} [deps.fs] { stat }（cwd 预检；默认 node:fs/promises 的 stat）
 * @param {string} [deps.hostCwd] Host 进程工作目录（cwd 解析兜底；默认 process.cwd()）
 * @param {() => void} [deps.onOrchestrationMutated] 编排持久变更（fixed-delay 推进等）后的回调（scheduler 重算 timer 用）
 * @param {object} [deps.registry] 动作注册表 { resolve(name) }（plugin 动作逐动作实时查表；createActionRegistry 或结构等同物）
 * @param {object} [deps.sessionHost] 宿主会话服务面（persistent session 动作投递；
 *   { sessionController, sessions, getSessionTitle() }，index.js 由 ctx 装配；缺省时
 *   session 动作 failed internal_error）
 * @param {object} [deps.ephemeralRegistry] ephemeral 生命周期登记器（票 33；
 *   createEphemeralRegistry 或结构等同物；缺省时 ephemeral 动作 failed internal_error）
 */
export function createRunner({ storage, queue, subprocess, config, emit, now, logger, fs, hostCwd, onOrchestrationMutated, registry, sessionHost, ephemeralRegistry }) {
  const currentTime = now ?? (() => Date.now())
  const publish = emit ?? (() => {})
  const log = logger ?? console
  const hostWorkingDir = hostCwd ?? (typeof process !== 'undefined' ? process.cwd() : '')
  const maxConcurrentRuns = config.maxConcurrentRuns ?? 2
  const queueCapacity = maxConcurrentRuns * 4
  const mutating = onOrchestrationMutated ?? (() => {})
  // dispatching 取消面：runId → { requested, controller }（cancelRun 置位并中止在途动作）
  const dispatchCancellations = new Map()
  // run 级取消标志：runId → { cancelRequested }（begin 起存在、settle 后清除；
  // running 阶段的 terminate 后归 canceled、judging/dispatching 阶段的停止派发都读它）
  const activeStates = new Map()
  // 删除中编排（service.delete 两阶段协调）：此间 requestRun 一律不受理（无 run 记录）
  const deletingOrchestrations = new Set()

  // 活动视图：runId → live 记录（内存态 running/judging/dispatching；queued 的覆盖字段）。
  // 中途状态不落盘（契约 08「只写两次」）；service.view 合并此视图对外呈现。
  const live = new Map()
  // pending：已入队（写 1 完成）等待并发槽/单飞的 runId，FIFO；active：已领槽执行中。
  const pending = []
  const active = new Map() // runId → handle（shutdown 清理进程范围用）
  const activeHandles = new Map()
  // 单 run 等待者：runId → Set<resolve>（service.waitRun 的尽力等待；结算时唤醒）
  const runWaiters = new Map()
  let shuttingDown = false
  const idleWaiters = new Set()

  /** run 终态结算后唤醒全部等待者（settle / settleSkip 末尾调用）。 */
  function notifyRunSettled(runId) {
    const waiters = runWaiters.get(runId)
    if (waiters === undefined) return
    runWaiters.delete(runId)
    for (const resolve of waiters) resolve()
  }

  function safeEmit(name, payload) {
    try {
      publish(name, payload)
    } catch (error) {
      log.error?.(
        `script-orchestrator: event_listener_failed ${name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  function wakeIdleWaiters() {
    if (pending.length === 0 && active.size === 0) {
      for (const resolve of idleWaiters) resolve()
      idleWaiters.clear()
    }
  }

  function currentRun(runId) {
    const persisted = storage.table('runs').get(runId)
    if (persisted === undefined) return undefined
    const overlay = live.get(runId)
    return overlay === undefined ? persisted : { ...persisted, ...overlay }
  }

  function orchestrationOf(run) {
    return storage.table('orchestrations').get(run.orchestrationId)
  }

  /** 单飞占用判定：该编排是否有 running（已领槽）run。 */
  function hasRunningFor(orchestrationId) {
    for (const runId of active.keys()) {
      if (currentRun(runId)?.orchestrationId === orchestrationId) return true
    }
    return false
  }

  /** 该编排已排队（pending、未领槽）的 run 数。 */
  function pendingCountFor(orchestrationId) {
    let count = 0
    for (const runId of pending) {
      if (currentRun(runId)?.orchestrationId === orchestrationId) count += 1
    }
    return count
  }

  /**
   * 触发一次 run（自动 every/cron 或 manual）。持久写入经 FIFO 单槽；
   * skip 也是两条写（disabled/overlap/concurrency），含 scheduledAt 与 skipReason。
   * 返回受理时的 run 视图（queued 或 skipped）。
   */
  function requestRun({ orchestrationId, trigger, scheduledAtMs }) {
    return queue.enqueue(async () => {
      if (shuttingDown) {
        throw new Error('runner is shutting down')
      }
      // 删除中编排不受理新 run（契约 06 delete：先取消在途 → 同批删除；此间触发一律
      // 不产生 run 记录——含 skip 记录，避免删除批次外再写入）
      if (deletingOrchestrations.has(orchestrationId)) return null
      const orchestration = storage.table('orchestrations').get(orchestrationId)
      if (orchestration === undefined) return null
      const run = {
        runId: randomRunId(),
        orchestrationId,
        trigger,
        scheduledAt: iso(scheduledAtMs),
        startedAt: null,
        settledAt: null,
        status: 'queued',
        skipReason: null,
        script: emptyScript(orchestration.script.command),
        matchedRule: null,
        usedFallback: false,
        actions: [],
      }
      await storage.table('runs').put(run.runId, structuredCloneSafe(run)) // 写 1：queued
      live.set(run.runId, {})

      // 自动触发只对 active 编排生效（与状态变更竞态时的兜底防线，契约 09 disabled skip）
      if (trigger !== 'manual' && orchestration.status !== 'active') {
        return settleSkip(run.runId, 'disabled')
      }
      // 单飞屏障：同编排至多 1 个脚本在跑；屏障管「何时开始」，overlap 管积压保留（契约 03）
      if (hasRunningFor(orchestrationId)) {
        const skipForOverlap =
          trigger !== 'manual' && orchestration.overlap !== 'queue'
            ? true // overlap:skip 且自动触发 → 直接 skip
            : pendingCountFor(orchestrationId) >= 1 // 排队位（上限 1）已满 → 新者 skip
        if (skipForOverlap) {
          return settleSkip(run.runId, 'overlap')
        }
      } else if (pendingCountFor(orchestrationId) >= 1) {
        // 无 running 但已有排队（并发受限）：单飞语义仍是「上一个结算后才开始」
        return settleSkip(run.runId, 'overlap')
      }

      pending.push(run.runId)
      // 全局排队上限：溢出丢最旧（不区分来源，含手动；契约 03 排队上限）
      while (pending.length > queueCapacity) {
        const droppedId = pending.shift()
        await settleSkip(droppedId, 'concurrency')
      }
      pump()
      return currentRun(run.runId)
    })
  }

  /** 写 2 结算 skipped（与写 1 几乎同时，同一 FIFO 槽内完成）。 */
  async function settleSkip(runId, skipReason) {
    const settledMs = currentTime()
    const persisted = storage.table('runs').get(runId)
    if (persisted === undefined || TERMINAL_STATUSES.has(persisted.status)) {
      return persisted ?? null // first-write-wins：迟到结算 no-op
    }
    const settled = {
      ...persisted,
      status: 'skipped',
      skipReason,
      settledAt: iso(settledMs),
    }
    await storage.table('runs').put(runId, settled)
    live.delete(runId)
    // fixed-delay：自动 run 进入任何终态都推进序列（含 skipped；契约 02「fixed-delay」）
    await advanceFixedDelayIfDue(settled, settledMs)
    wakeIdleWaiters()
    notifyRunSettled(runId)
    safeEmit('script-orchestrator/run-settled', buildSettledPayload(settled))
    pump()
    return settled
  }

  /** 泵：在全局并发额度内为排队 run 领槽（跳过单飞仍被占的项，避免头阻塞）。 */
  function pump() {
    while (active.size < maxConcurrentRuns && pending.length > 0 && !shuttingDown) {
      const index = pending.findIndex((runId) => {
        const run = currentRun(runId)
        return run !== undefined && !hasRunningFor(run.orchestrationId)
      })
      if (index === -1) return
      const [runId] = pending.splice(index, 1)
      begin(runId).catch((error) => {
        log.error?.(`script-orchestrator: run ${runId} 执行异常: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        active.delete(runId)
        activeHandles.delete(runId)
        wakeIdleWaiters()
        pump()
      })
    }
  }

  /** 领槽 → 内存态 running → 发布 run-started（内存更新后）→ 执行 → 结算。 */
  async function begin(runId) {
    const run = currentRun(runId)
    if (run === undefined || run.status !== 'queued') {
      active.delete(runId)
      wakeIdleWaiters()
      return null
    }
    active.set(runId, true)
    // run 级取消标志（cancelRun 的矩阵作用面）；领槽瞬间已请求取消 → 不 spawn 直接结算
    const state = { cancelRequested: false }
    activeStates.set(runId, state)
    if (state.cancelRequested) {
      activeStates.delete(runId)
      active.delete(runId)
      await settle(runId, { kind: 'canceled', script: run.script })
      wakeIdleWaiters()
      pump()
      return null
    }
    const startedMs = currentTime()
    const startedAt = iso(startedMs)
    live.set(runId, { ...run, status: 'running', startedAt })
    safeEmit('script-orchestrator/run-started', {
      runId,
      orchestrationId: run.orchestrationId,
      trigger: run.trigger,
      scheduledAt: run.scheduledAt,
      startedAt,
    })

    const outcome = await execute(runId, run, startedMs)
    // 判定与动作派发（票 30）：judging/dispatching 为内存态（不落盘、不占 FIFO 槽），
    // 结算槽（写 2）在派发完成后竞争入队——first-write-wins 语义不变
    const enriched = await judgeAndDispatch(runId, run, outcome)
    await settle(runId, enriched)
    active.delete(runId)
    activeHandles.delete(runId)
    activeStates.delete(runId)
    wakeIdleWaiters()
    pump()
  }

  /**
   * 脚本完成后：判定求值（内存态 judging）→ 非零动作串行派发（内存态 dispatching）。
   * spawn_failed/canceled 原样返回（跳过判定，契约 09 结算规则 3）。
   * @returns 带 verdict/actionResults/dispatchCanceled 的结算输入
   */
  async function judgeAndDispatch(runId, runAtStart, outcome) {
    if (outcome.kind !== 'script') return outcome
    const orchestration = orchestrationOf(runAtStart)
    const verdict = orchestration
      ? evaluateJudge(orchestration.judge, outcome.facts)
      : { matchedRule: null, usedFallback: false, actionKeys: [] }
    const overlay = live.get(runId) ?? {}
    live.set(runId, {
      ...overlay,
      status: 'judging',
      matchedRule: verdict.matchedRule,
      usedFallback: verdict.usedFallback,
    })

    let actionResults = []
    let dispatchCanceled = false
    if (verdict.actionKeys.length > 0 && orchestration !== undefined) {
      live.set(runId, { ...live.get(runId), status: 'dispatching', actions: [] })
      // 取消请求贯穿：judging 期间到达的取消在派发开始时生效（全部动作 skipped）
      const cancellation = { requested: activeStates.get(runId)?.cancelRequested === true, controller: null }
      dispatchCancellations.set(runId, cancellation)
      try {
        const dispatched = await dispatchActions({
          actionKeys: verdict.actionKeys,
          actions: orchestration.actions,
          orchestration: { id: orchestration.id, title: orchestration.title },
          run: {
            runId,
            orchestrationId: runAtStart.orchestrationId,
            trigger: runAtStart.trigger,
            scheduledAt: runAtStart.scheduledAt,
            startedAt: overlay.startedAt ?? runAtStart.startedAt ?? null,
            script: outcome.script,
          },
          verdict,
          stdoutText: outcome.facts.stdoutText,
          registry,
          emit: publish,
          // session 动作投递面（票 32 persistent / 票 33 ephemeral）：cwd 环境按当前编排
          //（session cwd 缺省取编排脚本 cwd，同受 allowedRoots 限制；defaultCwd/hostCwd
          // 与脚本 cwd 解析同链）；ephemeralRegistry 承接回收生命周期
          sessionHost,
          ephemeralRegistry,
          sessionEnv: {
            allowedRoots: config.allowedRoots,
            defaultCwd: config.defaultCwd,
            hostCwd: hostWorkingDir,
            scriptCwd: orchestration.script.cwd,
          },
          logger: log,
          cancellation,
          // 逐动作结算进度并入内存视图（面板轮询可见；结算后 live 移除、回落持久记录）
          onActionResult: (result) => {
            const current = live.get(runId)
            if (current !== undefined) live.set(runId, { ...current, actions: [...(current.actions ?? []), result] })
          },
        })
        actionResults = dispatched.results
        dispatchCanceled = dispatched.canceled
      } finally {
        dispatchCancellations.delete(runId)
      }
    }
    return { ...outcome, verdict, actionResults, dispatchCanceled }
  }

  /** cwd 解析（script.cwd → 配置 defaultCwd → Host 工作目录）与 allowedRoots/存在性预检。 */
  async function resolveWorkingDirectory(script) {
    const cwd = script.cwd ?? config.defaultCwd ?? hostWorkingDir
    const roots = config.allowedRoots ?? []
    if (roots.length > 0 && !roots.some((root) => isWithin(cwd, root))) {
      return { cwd, failure: `cwd_not_allowed: cwd '${cwd}' 不在 allowedRoots 之内` }
    }
    try {
      const statResult = await statDirectory(cwd)
      if (!statResult.isDirectory()) {
        return { cwd, failure: `spawn_failed: cwd '${cwd}' 不是目录` }
      }
    } catch (error) {
      return { cwd, failure: `spawn_failed: cwd '${cwd}' 不存在（${error instanceof Error ? error.message : String(error)}）` }
    }
    return { cwd, failure: null }
  }

  async function statDirectory(cwd) {
    if (fs?.stat) return fs.stat(cwd)
    const { stat } = await import('node:fs/promises')
    return stat(cwd)
  }

  /** 脚本阶段执行：spawn → 超时 → done → 输出收集 → 后代清理。 */
  async function execute(runId, runAtStart, startedMs) {
    const orchestration = orchestrationOf(runAtStart)
    const script = orchestration.script
    // 取消在 spawn 前到达（领槽后、进程未起的窗口）→ 不 spawn 直接 canceled
    if (activeStates.get(runId)?.cancelRequested === true) {
      return { kind: 'canceled', script: emptyScript(script.command), startedMs }
    }
    const { cwd, failure } = await resolveWorkingDirectory(script)
    if (failure) {
      return { kind: 'spawn_failed', script: emptyScript(script.command, { warnings: [failure] }), startedMs }
    }

    const timeoutSeconds = script.timeoutSeconds ?? config.defaultTimeoutSeconds ?? 300
    const spillCap = config.maxSpillBytes ?? 8388608
    const spillSpec = spillCap > 0 ? { maxBytes: spillCap } : undefined
    const cancelState = { reason: null }
    const spec = {
      argv: [script.command, ...(script.args ?? [])],
      cwd,
      env: script.env ?? {},
      stdio: {
        stdin: script.stdin === undefined || script.stdin === 'ignore' ? 'ignore' : { data: script.stdin.text },
        stdout: { maxBytes: config.maxOutputBytes ?? 262144, ...(spillSpec ? { spill: spillSpec } : {}) },
        stderr: { maxBytes: config.maxOutputBytes ?? 262144, ...(spillSpec ? { spill: spillSpec } : {}) },
      },
      graceMs: 5000,
    }
    let handle
    try {
      handle = subprocess.spawn(spec)
    } catch (error) {
      // 同步 throw：其余 → spawn_failed 保留 cause（契约 03 失败分类 2）
      return {
        kind: 'spawn_failed',
        script: emptyScript(script.command, { warnings: [`spawn_failed: ${error instanceof Error ? error.message : String(error)}`] }),
        startedMs,
      }
    }
    activeHandles.set(runId, handle)
    const timeoutTimer = setTimeout(() => {
      cancelState.reason = 'timeout' // 调 terminate 前先置内部标志（契约 03 失败分类 1）
      try {
        handle.terminate()
      } catch {
        /* terminate 幂等；异常由 done/清理路径兜底 */
      }
    }, timeoutSeconds * 1000)

    let doneResult = null
    let doneError = null
    try {
      doneResult = await handle.done
    } catch (error) {
      doneError = error
    }
    clearTimeout(timeoutTimer)
    const durationMs = currentTime() - startedMs

    // 取消已请求（契约 03 取消矩阵 running 面）：terminate 后 done 无论 resolve
    //（Windows Job 语义 {exitCode:1}）还是 reject，都结算 canceled——退出事实不是判定输入
    if (activeStates.get(runId)?.cancelRequested === true) {
      return { kind: 'canceled', script: emptyScript(script.command), startedMs }
    }
    if (doneError !== null) {
      if (cancelState.reason === 'timeout') {
        // 超时：照常进入判定（契约 03「超时不是执行失败」）；reject 时退出事实未知
        return collectOutput(handle, script, { exitCode: null, signal: null, timedOut: true, durationMs })
      }
      if (cancelState.reason === 'cancel') {
        return { kind: 'canceled', script: emptyScript(script.command), startedMs }
      }
      return {
        kind: 'spawn_failed',
        script: emptyScript(script.command, {
          warnings: [`spawn_failed: ${doneError instanceof Error ? doneError.message : String(doneError)}`],
        }),
        startedMs,
      }
    }
    // terminate 后 done 正常 resolve（Windows Job 实测 {exitCode:1, signal:null}）
    return collectOutput(handle, script, {
      exitCode: doneResult.exitCode,
      signal: doneResult.signal,
      timedOut: cancelState.reason === 'timeout',
      durationMs,
    })
  }

  /** done 后输出收集（按流，truncated 判定即 lossy）+ 存活后代的有界等待与清理。 */
  async function collectOutput(handle, script, facts) {
    const warnings = []
    const stdout = handle.collected?.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected?.stderr?.readFrom(0) ?? { text: '', lossy: false }
    // 正常退出后存活后代：有界等待 waitForExit() 2000ms → 仍未清空则 terminate 清范围
    //（Windows=Job 内全杀）并记 descendants-terminated（契约 03「超时与终止」末节）
    let descendantsCleared
    try {
      descendantsCleared = await Promise.race([
        handle.waitForExit().then(
          () => true,
          () => true,
        ),
        delay(DESCENDANTS_WAIT_MS).then(() => false),
      ])
    } catch {
      descendantsCleared = false
    }
    if (!descendantsCleared) {
      try {
        handle.terminate()
      } catch {
        /* 进程范围可能已消失 */
      }
      warnings.push('descendants-terminated')
    }
    const scriptResult = {
      command: script.command,
      exitCode: facts.exitCode ?? null,
      signal: facts.signal ?? null,
      timedOut: facts.timedOut === true,
      durationMs: facts.durationMs ?? 0,
      stdoutTail: tailText(stdout.text ?? ''),
      stderrTail: tailText(stderr.text ?? ''),
      truncated: stdout.lossy === true || stderr.lossy === true,
      ...(stdout.spillPath !== undefined ? { stdoutSpillPath: stdout.spillPath } : {}),
      ...(stderr.spillPath !== undefined ? { stderrSpillPath: stderr.spillPath } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
    return {
      kind: 'script',
      script: scriptResult,
      facts: {
        ...facts,
        stdoutText: stdout.text ?? '',
        stderrText: stderr.text ?? '',
        stdoutTruncated: stdout.lossy === true,
        stderrTruncated: stderr.lossy === true,
      },
    }
  }

  /**
   * 结算（写 2）：spawn_failed → failed（跳过判定）；脚本完成 → 按判定结果与动作汇总
   * 定终态（契约 09：取消终态优先于动作汇总）。终态唯一：已终态的 run 迟到结算为 no-op。
   * action-settled 按动作执行序发布（契约 06：在对应持久写入与内存视图更新之后、
   * run-settled 之前；listener 收到立即 view() 必见已更新状态）。
   */
  async function settle(runId, outcome) {
    return queue.enqueue(async () => {
      const persisted = storage.table('runs').get(runId)
      if (persisted === undefined || TERMINAL_STATUSES.has(persisted.status)) {
        return null // first-write-wins（契约 03「取消与等待」）：迟到结算 no-op
      }
      const run = { ...persisted, ...(live.get(runId) ?? {}) }
      const settledMs = currentTime()
      run.settledAt = iso(settledMs)
      run.script = outcome.script

      if (outcome.kind === 'canceled') {
        run.status = 'canceled'
      } else if (outcome.kind === 'spawn_failed') {
        // 契约 09 结算规则 3：spawn_failed 直接 failed，跳过判定
        run.status = 'failed'
      } else {
        run.matchedRule = outcome.verdict.matchedRule
        run.usedFallback = outcome.verdict.usedFallback
        run.actions = outcome.actionResults
        run.status = outcome.dispatchCanceled ? 'canceled' : aggregateRunStatus(outcome.actionResults)
      }

      await storage.table('runs').put(runId, structuredCloneSafe(run))
      live.delete(runId)
      wakeIdleWaiters()
      for (const action of run.actions ?? []) {
        safeEmit('script-orchestrator/action-settled', {
          runId: run.runId,
          orchestrationId: run.orchestrationId,
          name: action.name,
          kind: action.kind,
          status: action.status,
          ...(action.error !== undefined ? { error: { code: action.error.code, message: action.error.message } } : {}),
        })
      }
      await advanceFixedDelayIfDue(run, settledMs)
      notifyRunSettled(runId)
      safeEmit('script-orchestrator/run-settled', buildSettledPayload(run))
      return run
    })
  }

  /**
   * fixed-delay 序列推进（契约 02）：仅自动 run 终态、编排仍 active、当前持久触发
   * 配置仍为 every/fixed-delay（用当前 trigger 而非触发时快照＝编辑代际防线）。
   * settledAt + everySeconds 写回 nextOccurrence 并发布 changed（nextOccurrence 属
   * 持久可见变更；不改 updatedAt——调度推进不是内容编辑，避免无谓的乐观并发冲突）。
   */
  async function advanceFixedDelayIfDue(run, settledMs) {
    const current = storage.table('orchestrations').get(run.orchestrationId)
    if (
      run.trigger !== 'manual' &&
      current?.status === 'active' &&
      current.trigger.kind === 'every' &&
      current.trigger.mode === 'fixed-delay'
    ) {
      await storage.table('orchestrations').put(current.id, {
        ...current,
        nextOccurrence: iso(settledMs + current.trigger.everySeconds * 1000),
      })
      mutating()
      safeEmit('script-orchestrator/changed')
    }
  }

  /**
   * run 取消（契约 03「取消与等待」取消矩阵；来源 = script_run abort / delete / 插件卸载）。
   * 按阶段执行：queued → 移出队列 + 结算槽直接写 canceled；running → 置标志 + terminate()
   * → done settle 后结算 canceled；judging → 不响应（求值照常），标志在派发开始生效；
   * dispatching → 标志 + 中止在途动作 signal，剩余动作 skipped、已执行结果保留。
   * 终态或未知 run 返回 false（幂等，不重复发布事件）。
   */
  function cancelRunInternal(runId) {
    const persisted = storage.table('runs').get(runId)
    if (persisted === undefined || TERMINAL_STATUSES.has(persisted.status)) return false
    const state = activeStates.get(runId)
    if (state !== undefined) {
      state.cancelRequested = true
      const dispatch = dispatchCancellations.get(runId)
      if (dispatch !== undefined) {
        dispatch.requested = true
        try {
          dispatch.controller?.abort()
        } catch {
          /* abort 不应抛；防御 */
        }
      }
      const handle = activeHandles.get(runId)
      if (handle !== undefined) {
        try {
          handle.terminate() // running 阶段终止进程；judging/dispatching 时进程已退（幂等 no-op）
        } catch {
          /* 进程可能已退出 */
        }
      }
      return true
    }
    // queued/pending：移出待发队列（防 pump 领槽）+ 结算槽写 canceled
    const index = pending.indexOf(runId)
    if (index !== -1) pending.splice(index, 1)
    settle(runId, { kind: 'canceled', script: persisted.script }).catch((error) => {
      log.error?.(`script-orchestrator: 取消 run ${runId} 结算失败: ${error instanceof Error ? error.message : String(error)}`)
    })
    return true
  }

  /**
   * 停机（插件卸载序列）：停新触发；在途 run 有界等待后终止进程范围并**取消结算
   * canceled**（契约 03 取消矩阵的「插件卸载」来源；票 26 的「留非终态交 interrupted」
   * 升级为卸载即取消）。等待有界：超时未结算者记录留非终态，由下次启动 interrupted
   * 收尾（降级路径，记错误日志）。
   */
  async function shutdown() {
    shuttingDown = true
    if (active.size > 0 || pending.length > 0) {
      await Promise.race([waitForIdle(), delay(2000)])
    }
    for (const runId of [...active.keys(), ...pending]) {
      try {
        cancelRunInternal(runId)
      } catch (error) {
        log.error?.(`script-orchestrator: shutdown 取消 run ${runId} 异常: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // 取消结算（FIFO 槽）排干（等待有界，避免无限挂卸载）
    await Promise.race([waitForIdle(), delay(3000)])
  }

  function waitForIdle() {
    if (pending.length === 0 && active.size === 0) return Promise.resolve()
    return new Promise((resolve) => {
      idleWaiters.add(resolve)
    })
  }

  return {
    requestRun,
    /** 等 active 与 pending 清空（测试/停机用）。 */
    waitIdle: waitForIdle,
    /**
     * 等待单个 run 进入终态（service.waitRun 尽力等待的底层原语）：
     * 已终态立即返回终态视图；未终态挂起直到该 run 结算（settle/settleSkip 唤醒）。
     * run 不存在返回 null。
     */
    waitForRun: (runId) => {
      const persisted = storage.table('runs').get(runId)
      if (persisted === undefined) return Promise.resolve(null)
      if (TERMINAL_STATUSES.has(persisted.status)) return Promise.resolve(currentRun(runId))
      return new Promise((resolve) => {
        const set = runWaiters.get(runId) ?? new Set()
        set.add(() => resolve(currentRun(runId)))
        runWaiters.set(runId, set)
      })
    },
    /**
     * 外部结算入口（取消与自然结算竞争的防御面）：与自然结算同一 FIFO 槽位竞争，
     * first-write-wins——已终态的 run 迟到结算为 no-op（返回 null），不覆写、不重发
     * run-settled。注意：dispatching 中的 run 应优先用 cancelRun（直接 settleExternal
     * canceled 会丢在途动作结果）。
     */
    settleExternal: (runId, outcome) => settle(runId, outcome),
    /**
     * run 取消入口（契约 03「取消与等待」取消矩阵；来源 = script_run abort / delete /
     * 插件卸载；shutdown 内部亦走同一路径）。按阶段执行，见 cancelRunInternal 注释。
     * 终态或未知 run 返回 false（幂等，不重复发布事件）。
     */
    cancelRun: cancelRunInternal,
    /**
     * 删除中标记（service.delete 两阶段协调，票 29）：置位期间 requestRun 对该编排
     * 一律不受理（返回 null、不产生任何 run 记录——含 skip 记录），防止删除等待窗口
     * 内新 run 落库成为孤儿。
     */
    markDeleting: (orchestrationId, on = true) => {
      if (on) deletingOrchestrations.add(orchestrationId)
      else deletingOrchestrations.delete(orchestrationId)
    },
    /** 活动视图合并入口（service.view 用）：返回内存态视图或 undefined。 */
    liveView: (runId) => {
      const overlay = live.get(runId)
      if (overlay === undefined) return undefined
      const persisted = storage.table('runs').get(runId)
      return { ...persisted, ...overlay }
    },
    /** 是否存在未终态 run（面板轮询提示等可用；限定编排可选）。 */
    hasInflight: (orchestrationId) => {
      for (const runId of [...active.keys(), ...pending]) {
        const run = currentRun(runId)
        if (run && (orchestrationId === undefined || run.orchestrationId === orchestrationId)) return true
      }
      return false
    },
    shutdown,
  }
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}
