// 执行引擎（契约 docs/temp/03-execution.md）：run 生命周期唯一拥有者。
// 单飞屏障 + 全局并发/排队、两写结算、argv 直传 spawn（不经 shell）、cwd/allowedRoots
// 预检、超时（cancelReason 自置标志位分类）、输出按流解码尾部、正常退出后存活后代
// 的有界等待与清理、run-started/run-settled 事件（持久写入与内存更新后发布）。
// 服务 run / script_run 只经 requestRun 触发，不另造排队或结算逻辑（spec §2）。
// 取消矩阵（abort/delete/卸载 → canceled）属票 29；本票仅预留信号面与终态唯一防线。
import { evaluateJudge } from './judge.js'
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
 */
export function createRunner({ storage, queue, subprocess, config, emit, now, logger, fs, hostCwd, onOrchestrationMutated }) {
  const currentTime = now ?? (() => Date.now())
  const publish = emit ?? (() => {})
  const log = logger ?? console
  const hostWorkingDir = hostCwd ?? (typeof process !== 'undefined' ? process.cwd() : '')
  const maxConcurrentRuns = config.maxConcurrentRuns ?? 2
  const queueCapacity = maxConcurrentRuns * 4
  const mutating = onOrchestrationMutated ?? (() => {})

  // 活动视图：runId → live 记录（内存态 running/judging/dispatching；queued 的覆盖字段）。
  // 中途状态不落盘（契约 08「只写两次」）；service.view 合并此视图对外呈现。
  const live = new Map()
  // pending：已入队（写 1 完成）等待并发槽/单飞的 runId，FIFO；active：已领槽执行中。
  const pending = []
  const active = new Map() // runId → handle（shutdown 清理进程范围用）
  const activeHandles = new Map()
  let shuttingDown = false
  const idleWaiters = new Set()

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
    wakeIdleWaiters()
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
    await settle(runId, outcome)
    active.delete(runId)
    activeHandles.delete(runId)
    wakeIdleWaiters()
    pump()
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
   * 结算（写 2）：spawn_failed → failed（跳过判定）；脚本完成 → judging →（动作派发
   * 属票 30+，当前空派发）→ 汇总。终态唯一：已终态的 run 迟到结算为 no-op。
   */
  async function settle(runId, outcome) {
    return queue.enqueue(async () => {
      const persisted = storage.table('runs').get(runId)
      if (persisted === undefined || TERMINAL_STATUSES.has(persisted.status)) {
        return persisted ?? null // first-write-wins（契约 03「取消与等待」）
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
        // 脚本启动成功即进判定：exitCode/signal/timedOut 是判定输入，不是失败判据
        const orchestration = orchestrationOf(run)
        const verdict = orchestration
          ? evaluateJudge(orchestration.judge, outcome.facts)
          : { matchedRule: null, usedFallback: false, actionKeys: [] }
        run.matchedRule = verdict.matchedRule
        run.usedFallback = verdict.usedFallback
        if (verdict.actionKeys.length > 0) {
          // 动作执行器属票 30+：当前空派发（不产生动作结果记录），按契约 09 汇总表
          // 0 成功/0 失败 → succeeded；票 30 接入真实派发后按汇总结算。票序边界声明。
          run.actions = []
        }
        run.status = 'succeeded'
      }

      await storage.table('runs').put(runId, structuredCloneSafe(run))
      live.delete(runId)
      wakeIdleWaiters()
      // fixed-delay 序列推进：仅自动 run 终态、编排仍 active、当前触发配置仍为
      // fixed-delay（用当前持久 trigger 而非触发时快照＝编辑代际防线，契约 02 编辑表）
      const current = orchestrationOf(run)
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
      safeEmit('script-orchestrator/run-settled', buildSettledPayload(run))
      return run
    })
  }

  /**
   * 停机（插件卸载序列）：停新触发；在途 run 有界等待后 terminate 清理进程范围
   *（进程树生命周期以 run 为上限，不留后台存活者）；记录保持非终态，由下次启动的
   * interrupted 维护收尾（契约 03「重启与崩溃」）。完整取消矩阵（结算 canceled）属票 29。
   */
  async function shutdown() {
    shuttingDown = true
    if (active.size > 0 || pending.length > 0) {
      await Promise.race([waitForIdle(), delay(2000)])
    }
    for (const [runId] of [...active]) {
      try {
        activeHandles.get(runId)?.terminate()
      } catch {
        /* 进程可能已退出 */
      }
    }
    // terminate → done resolve → 结算槽排干（等待有界，避免无限挂卸载）
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
