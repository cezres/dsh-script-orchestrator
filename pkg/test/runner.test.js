// 执行引擎（契约 docs/temp/03-execution.md）：执行生命周期、单飞/全局并发、两写、
// 结算口径、输出收集、后代清理、事件发布时序。subprocess/fs/时钟全部注入，
// 真实 Windows 进程路径另见 test/execution.process.test.js。
import { describe, it, expect, vi } from 'vitest'
import { createRunner, buildSettledPayload } from '../lib/runner.js'
import { ServiceQueue } from '../lib/fifo.js'

const NOW = 1_790_000_000_000
const iso = (ms) => new Date(ms).toISOString()

/** 内存存储 fake（与 service.test 同款，外加 runs 写序记录）。 */
function makeStorage() {
  const tables = { orchestrations: new Map(), runs: new Map() }
  const puts = []
  const table = (name) => ({
    entries: () => tables[name].entries(),
    get: (key) => tables[name].get(key),
    put: (key, value) => {
      puts.push([name, key, value.status])
      tables[name].set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      tables[name].delete(key)
      return Promise.resolve()
    },
  })
  return {
    table,
    puts,
    snapshot: () => ({ orchestrations: Object.fromEntries(tables.orchestrations), runs: Object.fromEntries(tables.runs) }),
  }
}

/**
 * fake subprocess：默认 auto=true 在微任务里正常退出 0；auto=false 由测试手动
 * finish/fail（挂起、非零退出、超时、同步抛错等场景）。
 */
function makeFakeSubprocess({ auto = true } = {}) {
  const spawns = []
  const spawn = (spec) => {
    if (spec && spec.__throwSync) {
      throw new Error(spec.__throwSync)
    }
    const entry = {
      spec,
      terminated: 0,
      stdout: { text: '', lossy: false, nextOffset: 0 },
      stderr: { text: '', lossy: false, nextOffset: 0 },
      waitForExit: Promise.resolve(true),
    }
    spawns.push(entry)
    let resolveDone
    let rejectDone
    entry.handle = {
      done: new Promise((resolve, reject) => {
        resolveDone = resolve
        rejectDone = reject
      }),
      terminate: () => {
        entry.terminated += 1
        resolveDone({ exitCode: 1, signal: null })
      },
      waitForExit: () => entry.waitForExit,
      collected: {
        stdout: { readFrom: () => entry.stdout },
        stderr: { readFrom: () => entry.stderr },
      },
    }
    entry.finish = (result) => resolveDone(result ?? { exitCode: 0, signal: null })
    entry.fail = (error) => rejectDone(error)
    if (auto) queueMicrotask(() => entry.finish({ exitCode: 0, signal: null }))
    return entry.handle
  }
  return { spawn, spawns }
}

/** fake fs：默认目录存在；可标记缺失路径。 */
function makeFakeFs() {
  const missing = new Set()
  return {
    missing,
    stat: async (p) => {
      if (missing.has(p)) {
        const error = new Error(`ENOENT: no such file or directory, stat '${p}'`)
        error.code = 'ENOENT'
        throw error
      }
      return { isDirectory: () => true }
    },
  }
}

const BASE_CONFIG = {
  maxConcurrentRuns: 2,
  defaultTimeoutSeconds: 300,
  maxOutputBytes: 262144,
  maxSpillBytes: 8388608,
  allowedRoots: [],
  maxRunsPerOrchestration: 100,
}

function makeOrchestration(over = {}) {
  return {
    id: 'nightly',
    title: '夜间巡检',
    enabled: true,
    overlap: 'skip',
    trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-rate' },
    script: { command: 'node', args: ['check.js'], env: {} },
    judge: { rules: [], fallback: [] },
    actions: {},
    createdAt: iso(NOW - 600_000),
    updatedAt: iso(NOW - 600_000),
    status: 'active',
    nextOccurrence: iso(NOW),
    ...over,
  }
}

function makeRunner(over = {}) {
  const storage = over.storage ?? makeStorage()
  const orchestration = over.orchestration ?? makeOrchestration(over.orchestrationOver ?? {})
  if (!over.skipSeed) storage.table('orchestrations').put(orchestration.id, orchestration)
  const subprocess = over.subprocess ?? makeFakeSubprocess({ auto: over.autoSubprocess ?? true })
  const emitted = []
  const logs = []
  let clock = over.now ?? NOW
  const runner = createRunner({
    storage,
    queue: over.queue ?? new ServiceQueue(),
    subprocess,
    config: over.config ?? BASE_CONFIG,
    emit: over.emit ?? ((name, payload) => emitted.push([name, payload])),
    now: () => clock,
    logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
    fs: over.fs ?? makeFakeFs(),
    hostCwd: over.hostCwd ?? 'D:\\work\\proj',
    registry: over.registry,
    sessionHost: over.sessionHost,
    retention: over.retention,
  })
  return { runner, storage, subprocess, emitted, logs, advance: (ms) => { clock += ms } }
}

const requestAuto = (runner, scheduledAtMs = NOW) =>
  runner.requestRun({ orchestrationId: 'nightly', trigger: 'every', scheduledAtMs })

/** 等 fake spawn 实际发生（领槽在 FIFO 槽后的微任务链上完成）。 */
const waitForSpawn = (ctx, index = 0) => vi.waitFor(() => {
  if (!ctx.subprocess.spawns[index]) throw new Error(`spawn[${index}] 未发生`)
  return ctx.subprocess.spawns[index]
})

/**
 * 在 live 状态恰为 expected 的微任务边界内同步执行 fn（judging 是纯内存毫秒级、
 * 仅跨一个微任务边界，定时器轮询捕捉不到；跨 await 返回必然错过该边界）。
 */
async function atLiveStatusMicrotask(runner, runId, expected, fn, limit = 1000) {
  for (let i = 0; i < limit; i++) {
    if (runner.liveView(runId)?.status === expected) return fn()
    await Promise.resolve()
  }
  throw new Error(`live 状态未在微任务窗口内到达 '${expected}'（当前 '${runner.liveView(runId)?.status}'）`)
}

describe('正常执行路径（契约 03/09：两写、事件、零动作结算）', () => {
  it('空闲自动触发：写 1 queued → 领槽 running（run-started）→ 零动作 succeeded（写 2）', async () => {
    const ctx = makeRunner()
    const view = await requestAuto(ctx.runner)
    // 受理视图：写 1 完成（领槽可能已同步发生）
    expect(['queued', 'running']).toContain(view.status)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run).toMatchObject({
      orchestrationId: 'nightly',
      trigger: 'every',
      status: 'succeeded',
      skipReason: null,
      usedFallback: false,
      actions: [],
    })
    expect(run.scheduledAt).toBe(iso(NOW))
    expect(run.startedAt).toBe(iso(NOW))
    expect(run.settledAt).toBe(iso(NOW))
    expect(run.runId).toMatch(/^run-[0-9a-f]{8}$/)
    // 两写：queued 创建 + succeeded 结算（顺序）
    const runPuts = ctx.storage.puts.filter(([table, key]) => table === 'runs' && key === run.runId)
    expect(runPuts.map((p) => p[2])).toEqual(['queued', 'succeeded'])
    // spawn 形态：argv 直拼、cwd 兜底 hostCwd、env 只传覆盖、stdin ignore、graceMs 5000
    expect(ctx.subprocess.spawns).toHaveLength(1)
    expect(ctx.subprocess.spawns[0].spec.argv).toEqual(['node', 'check.js'])
    expect(ctx.subprocess.spawns[0].spec.cwd).toBe('D:\\work\\proj')
    expect(ctx.subprocess.spawns[0].spec.env).toEqual({})
    expect(ctx.subprocess.spawns[0].spec.stdio.stdin).toBe('ignore')
    expect(ctx.subprocess.spawns[0].spec.graceMs).toBe(5000)
  })

  it('run-started / run-settled 事件载荷与顺序（内存更新后发布）', async () => {
    const ctx = makeRunner({
      orchestrationOver: { script: { command: 'node', args: ['a.js'], env: { X: '1' }, cwd: 'D:\\work\\proj' } },
    })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    const names = ctx.emitted.map(([name]) => name)
    expect(names).toEqual(['script-orchestrator/run-started', 'script-orchestrator/run-settled'])
    const [startedName, started] = ctx.emitted[0]
    expect(startedName).toBe('script-orchestrator/run-started')
    expect(started).toEqual({
      runId: view.runId,
      orchestrationId: 'nightly',
      trigger: 'every',
      scheduledAt: iso(NOW),
      startedAt: iso(NOW),
    })
    const [, settled] = ctx.emitted[1]
    // RunSettled.script 不含 command/warnings（契约 06 载荷表；脚本 warnings 只进 run 记录）
    expect(settled).toMatchObject({
      runId: view.runId,
      orchestrationId: 'nightly',
      status: 'succeeded',
      trigger: 'every',
      scheduledAt: iso(NOW),
      startedAt: iso(NOW),
      settledAt: iso(NOW),
      matchedRule: null,
      usedFallback: false,
      actions: [],
      script: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
      },
      stdoutTail: '',
      stderrTail: '',
    })
    expect(Object.keys(settled.script)).toEqual(['exitCode', 'signal', 'timedOut', 'durationMs', 'truncated'])
  })

  it('非零退出码照常进入判定：零动作结算 succeeded，不是 failed（票 26 口径）', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 3, signal: null })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded')
    expect(run.script.exitCode).toBe(3)
    expect(run.script.timedOut).toBe(false)
  })

  it('判定输入装配：exitCode/stdout 文本进 judge，命中规则记 matchedRule', async () => {
    const ctx = makeRunner({
      autoSubprocess: false,
      orchestrationOver: {
        judge: { rules: [{ when: { exitCode: 0, stdout: { contains: 'READY' } }, actions: [] }], fallback: [] },
      },
    })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    spawn.stdout = { text: 'boot\nREADY\n', lossy: false, nextOffset: 11 }
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded')
    expect(run.matchedRule).toBe(0)
    expect(run.script.stdoutTail).toBe('boot\nREADY\n')
  })

  it('listener 同步抛错：发布端兜底记日志，run 照常结算（契约 06）', async () => {
    const emitted = []
    const ctx = makeRunner({
      autoSubprocess: false,
      emit: (name, payload) => {
        emitted.push([name, payload])
        if (name === 'script-orchestrator/run-started') throw new Error('listener boom')
      },
    })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    expect(emitted.map(([n]) => n)).toEqual(['script-orchestrator/run-started', 'script-orchestrator/run-settled'])
    expect(ctx.logs.some((m) => String(m).includes('event_listener_failed') && String(m).includes('run-started'))).toBe(true)
    expect(ctx.storage.snapshot().runs[view.runId].status).toBe('succeeded')
  })
})

describe('skip 与排队（契约 03「并发与单飞」）', () => {
  it('overlap:skip 且同编排上一 run 未结算 → 本次 skipped(overlap)，两写完整记录', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    await requestAuto(ctx.runner, NOW) // 占住单飞
    await waitForSpawn(ctx)
    const second = await requestAuto(ctx.runner, NOW + 300_000)
    expect(second.status).toBe('skipped')
    expect(second.skipReason).toBe('overlap')
    expect(second.scheduledAt).toBe(iso(NOW + 300_000))
    const secondPuts = ctx.storage.puts.filter(([table, key]) => table === 'runs' && key === second.runId)
    expect(secondPuts.map((p) => p[2])).toEqual(['queued', 'skipped'])
    await ctx.subprocess.spawns[0].finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
  })

  it('手动 run 不被 overlap:skip 淘汰：排队等上次结算（契约 03）', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    await requestAuto(ctx.runner, NOW)
    await waitForSpawn(ctx)
    const manual = await ctx.runner.requestRun({ orchestrationId: 'nightly', trigger: 'manual', scheduledAtMs: NOW + 1000 })
    expect(manual.status).toBe('queued') // 未被淘汰，处于排队
    await ctx.subprocess.spawns[0].finish({ exitCode: 0, signal: null })
    const second = await waitForSpawn(ctx, 1) // 上一个结算后才开始
    await second.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[manual.runId]
    expect(run.trigger).toBe('manual')
    expect(run.status).toBe('succeeded')
  })

  it('overlap:queue → 排队（单飞队列上限 1），再溢出时新者 skipped(overlap)', async () => {
    const ctx = makeRunner({ autoSubprocess: false, orchestrationOver: { overlap: 'queue' } })
    await requestAuto(ctx.runner, NOW) // running
    await waitForSpawn(ctx)
    const queued = await requestAuto(ctx.runner, NOW + 300_000)
    expect(queued.status).toBe('queued')
    const overflow = await requestAuto(ctx.runner, NOW + 600_000)
    expect(overflow.status).toBe('skipped')
    expect(overflow.skipReason).toBe('overlap')
    await ctx.subprocess.spawns[0].finish({ exitCode: 0, signal: null })
    const second = await waitForSpawn(ctx, 1)
    await second.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    // 排队项在上一个结算后接续执行
    expect(ctx.storage.snapshot().runs[queued.runId].status).toBe('succeeded')
  })

  it('全局并发：maxConcurrentRuns=1 时第二个编排排队，结算后接续（队列方向）', async () => {
    const storage = makeStorage()
    storage.table('orchestrations').put('nightly', makeOrchestration())
    storage.table('orchestrations').put('other', makeOrchestration({ id: 'other' }))
    const ctx = makeRunner({ storage, autoSubprocess: false, config: { ...BASE_CONFIG, maxConcurrentRuns: 1 } })
    const a = await ctx.runner.requestRun({ orchestrationId: 'nightly', trigger: 'every', scheduledAtMs: NOW })
    await waitForSpawn(ctx)
    const b = await ctx.runner.requestRun({ orchestrationId: 'other', trigger: 'every', scheduledAtMs: NOW })
    expect(ctx.subprocess.spawns).toHaveLength(1) // 只有第一个领槽
    await ctx.subprocess.spawns[0].finish({ exitCode: 0, signal: null })
    const second = await waitForSpawn(ctx, 1)
    await second.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    expect(ctx.subprocess.spawns).toHaveLength(2) // 结算后第二个接续
    expect(ctx.storage.snapshot().runs[a.runId].status).toBe('succeeded')
    expect(ctx.storage.snapshot().runs[b.runId].status).toBe('succeeded')
  })

  it('全局排队溢出丢最旧：上限 maxConcurrentRuns×4，被丢者 skipped(concurrency)（不区分来源，手动同样可被丢）', async () => {
    // maxConcurrentRuns=1 → 排队上限 4；running 1 + 排队 4 后，再入队丢最旧
    const ctx = makeRunner({ autoSubprocess: false, config: { ...BASE_CONFIG, maxConcurrentRuns: 1 } })
    for (const id of ['o1', 'o2', 'o3', 'o4', 'o5']) {
      ctx.storage.table('orchestrations').put(id, makeOrchestration({ id }))
    }
    await ctx.runner.requestRun({ orchestrationId: 'nightly', trigger: 'every', scheduledAtMs: NOW })
    await waitForSpawn(ctx)
    // 排队位最旧是手动 run（o1），其后 o2/o3（自动）排满 4 位
    const manualOldest = await ctx.runner.requestRun({ orchestrationId: 'o1', trigger: 'manual', scheduledAtMs: NOW })
    const manualSecond = await ctx.runner.requestRun({ orchestrationId: 'o2', trigger: 'manual', scheduledAtMs: NOW })
    expect(manualOldest.status).toBe('queued')
    expect(manualSecond.status).toBe('queued')
    const auto3 = await ctx.runner.requestRun({ orchestrationId: 'o3', trigger: 'every', scheduledAtMs: NOW })
    const auto4 = await ctx.runner.requestRun({ orchestrationId: 'o4', trigger: 'every', scheduledAtMs: NOW })
    expect(auto3.status).toBe('queued')
    expect(auto4.status).toBe('queued')
    // 第 5 个排队（o5 自动）→ 丢最旧（手动 o1）→ 可见 skipped(concurrency)，非静默
    const fifth = await ctx.runner.requestRun({ orchestrationId: 'o5', trigger: 'every', scheduledAtMs: NOW })
    expect(fifth.status).toBe('queued')
    const dropped = ctx.storage.snapshot().runs[manualOldest.runId]
    expect(dropped.status).toBe('skipped')
    expect(dropped.skipReason).toBe('concurrency')
    expect(dropped.trigger).toBe('manual')
    // 清空：逐个 finish（1 running + 4 排队按序执行）
    await ctx.subprocess.spawns[0].finish({ exitCode: 0, signal: null })
    for (let i = 1; i < 5; i += 1) {
      const spawn = await waitForSpawn(ctx, i)
      await spawn.finish({ exitCode: 0, signal: null })
    }
    await ctx.runner.waitIdle()
  })

  it('非 active 编排的自动触发 → skipped(disabled)（触发与状态变更竞态的兜底防线）', async () => {
    const ctx = makeRunner({ orchestrationOver: { status: 'paused' } })
    const view = await requestAuto(ctx.runner)
    expect(view.status).toBe('skipped')
    expect(view.skipReason).toBe('disabled')
    expect(ctx.subprocess.spawns).toHaveLength(0)
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('skipped')
    expect(run.script).toMatchObject({ exitCode: null, timedOut: false })
  })
})

describe('fixed-delay 结算推进（契约 02：只有自动 run 终态推进序列）', () => {
  it('active 编排的自动 run 结算后 nextOccurrence = settledAt + everySeconds，并发布 changed', async () => {
    const ctx = makeRunner({ orchestrationOver: { trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' } } })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    expect(ctx.storage.snapshot().runs[view.runId].status).toBe('succeeded')
    expect(ctx.storage.snapshot().orchestrations.nightly.nextOccurrence).toBe(iso(NOW + 300_000))
    expect(ctx.emitted.some(([name]) => name === 'script-orchestrator/changed')).toBe(true)
  })

  it('手动 run 结算不推进自动序列；paused 编排的自动 run 结算不推进', async () => {
    const ctx = makeRunner({
      autoSubprocess: false,
      orchestrationOver: { trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' } },
    })
    const manual = await ctx.runner.requestRun({ orchestrationId: 'nightly', trigger: 'manual', scheduledAtMs: NOW })
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    expect(ctx.storage.snapshot().runs[manual.runId].status).toBe('succeeded')
    expect(ctx.storage.snapshot().orchestrations.nightly.nextOccurrence).toBe(iso(NOW)) // 保持原计划

    // 「触发时 active、结算前被暂停」的在途 run：结算照常，但不写新自动计划
    const racing = makeRunner({
      autoSubprocess: false,
      orchestrationOver: { trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' } },
    })
    const inflight = await requestAuto(racing.runner, NOW)
    const racingSpawn = await waitForSpawn(racing)
    racing.storage.table('orchestrations').put('nightly', {
      ...racing.storage.snapshot().orchestrations.nightly,
      status: 'paused',
      nextOccurrence: null,
    })
    await racingSpawn.finish({ exitCode: 0, signal: null })
    await racing.runner.waitIdle()
    expect(racing.storage.snapshot().runs[inflight.runId].status).toBe('succeeded')
    expect(racing.storage.snapshot().orchestrations.nightly.nextOccurrence).toBeNull() // 暂停期间结算不写新计划
  })

  it('fixed-delay 编排的自动 run 被 overlap:skip 淘汰时，以其 settledAt 推进序列（契约 02 末段）', async () => {
    // 手动 run 占用单飞 → 到点自动触发被 skip(overlap) → skipped run 结算推进下一计划
    const ctx = makeRunner({
      autoSubprocess: false,
      orchestrationOver: { overlap: 'skip', trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' } },
    })
    await ctx.runner.requestRun({ orchestrationId: 'nightly', trigger: 'manual', scheduledAtMs: NOW })
    await waitForSpawn(ctx)
    const skipped = await requestAuto(ctx.runner, NOW + 300_000)
    expect(skipped.status).toBe('skipped')
    expect(skipped.skipReason).toBe('overlap')
    // skipped 自动 run 结算后推进：settledAt(=NOW) + 300s
    expect(ctx.storage.snapshot().orchestrations.nightly.nextOccurrence).toBe(iso(NOW + 300_000))
    await ctx.subprocess.spawns[0].finish({ exitCode: 0, signal: null })
    // 手动 run 结算不覆盖已推进的计划
    await ctx.runner.waitIdle()
    expect(ctx.storage.snapshot().orchestrations.nightly.nextOccurrence).toBe(iso(NOW + 300_000))
  })

  it('fixed-rate 编排的 run 结算不改 nextOccurrence（相位推进只发生在触发时，属 scheduler）', async () => {
    const ctx = makeRunner()
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    expect(ctx.storage.snapshot().runs[view.runId].status).toBe('succeeded')
    expect(ctx.storage.snapshot().orchestrations.nightly.nextOccurrence).toBe(iso(NOW))
  })
})

describe('失败与取消分类（契约 03「失败与取消分类」：自置 cancelReason 标志位，不猜 rejection）', () => {
  it('cwd 目录不存在 → spawn 前 spawn_failed 预检失败 → run failed（不 spawn）', async () => {
    const fs = makeFakeFs()
    fs.missing.add('D:\\work\\proj')
    const ctx = makeRunner({ autoSubprocess: false, fs })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('failed')
    expect(run.script.exitCode).toBeNull()
    expect(run.script.warnings[0]).toMatch(/spawn_failed: cwd 'D:\\work\\proj' 不存在/)
    expect(ctx.subprocess.spawns).toHaveLength(0) // spawn 前预检，未调宿主
  })

  it('cwd 不在 allowedRoots → 预检失败 spawn_failed（warnings 记 cwd_not_allowed）', async () => {
    const ctx = makeRunner({
      autoSubprocess: false,
      orchestrationOver: { script: { command: 'node', args: [], env: {}, cwd: 'D:\\work\\proj' } },
      config: { ...BASE_CONFIG, allowedRoots: ['D:\\sandbox'] },
    })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('failed')
    expect(run.script.warnings[0]).toMatch(/cwd_not_allowed/)
    expect(ctx.subprocess.spawns).toHaveLength(0)
  })

  it('cwd 解析顺序：script.cwd → defaultCwd → hostCwd；落在根下时通过（前缀匹配规范化）', async () => {
    const ctx = makeRunner({
      autoSubprocess: false,
      config: { ...BASE_CONFIG, defaultCwd: 'D:\\work', allowedRoots: ['D:\\work'] },
      orchestrationOver: { script: { command: 'node', args: [], env: {} } },
    })
    await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    expect(spawn.spec.cwd).toBe('D:\\work') // defaultCwd 覆盖 hostCwd
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
  })

  it('spawn 同步 throw → spawn_failed（details 保留 cause）；run failed', async () => {
    const subprocess = makeFakeSubprocess({ auto: false })
    subprocess.spawn = () => {
      throw new Error('argv invalid: ENOENT node-missing')
    }
    const ctx = makeRunner({ autoSubprocess: false, subprocess })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('failed')
    expect(run.script.warnings[0]).toContain('spawn_failed')
    expect(run.script.warnings[0]).toContain('ENOENT node-missing')
  })

  it('done 异步 reject（未置 cancelReason）→ spawn_failed；超时置位后 reject → 按超时结算（timedOut=true 进判定）', async () => {
    const ctx = makeRunner({
      autoSubprocess: false,
      orchestrationOver: { script: { command: 'node', args: [], env: {}, timeoutSeconds: 1 } },
    })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.fail(new Error('spawn ENOENT: node'))
    await ctx.runner.waitIdle()
    let run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('failed')
    expect(run.script.warnings[0]).toContain('spawn_failed')

    // 超时路径：timeoutSeconds=1 → 1 秒后 terminate；done 以 reject 反馈（宿主对
    // terminate 的异常反馈路径），cancelReason 已置位 → 按超时结算、exitCode/signal 未知为 null
    const ctx2 = makeRunner({
      autoSubprocess: false,
      orchestrationOver: { script: { command: 'node', args: [], env: {}, timeoutSeconds: 1 } },
    })
    const view2 = await requestAuto(ctx2.runner)
    const spawn2 = await waitForSpawn(ctx2)
    spawn2.handle.terminate = () => {
      spawn2.terminated += 1
      spawn2.fail(new Error('terminated'))
    }
    await ctx2.runner.waitIdle()
    run = ctx2.storage.snapshot().runs[view2.runId]
    expect(run.status).toBe('succeeded') // 超时不是执行失败：照常判定、零动作 succeeded
    expect(run.script.timedOut).toBe(true)
    expect(spawn2.terminated).toBe(1)
  })

  it('超时后 done 正常 resolve（Windows Job 实测 {exitCode:1,signal:null}）→ timedOut=true + exitCode=1', async () => {
    const ctx = makeRunner({
      autoSubprocess: false,
      orchestrationOver: { script: { command: 'node', args: [], env: {}, timeoutSeconds: 1 } },
    })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    // fake terminate → done resolve {exitCode:1, signal:null}（Windows Job 实测语义）
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded')
    expect(run.script).toMatchObject({ timedOut: true, exitCode: 1, signal: null })
    expect(spawn.terminated).toBe(1)
  })
})

describe('输出收集（契约 03「输出收集」：truncated 判定即 lossy，tail 末 2048 code point）', () => {
  it('未超限：truncated=false、tail 为全文；超限：truncated=true、tail 取解码后末 2048 code point', async () => {
    const short = 'a'.repeat(100)
    const ctx = makeRunner({ autoSubprocess: false })
    const view = await requestAuto(ctx.runner)
    let spawn = await waitForSpawn(ctx)
    spawn.stdout = { text: short, lossy: false, nextOffset: 100 }
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    expect(ctx.storage.snapshot().runs[view.runId].script).toMatchObject({ stdoutTail: short, truncated: false })

    // 3000 个 code point、lossy=true（内存只留尾部）→ tail 取末 2048；stderr 未截 → truncated 仍 true（任一）
    const long = '字'.repeat(3000)
    const ctx2 = makeRunner({ autoSubprocess: false })
    const view2 = await requestAuto(ctx2.runner)
    spawn = await waitForSpawn(ctx2)
    spawn.stdout = { text: long, lossy: true, nextOffset: 9000 }
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx2.runner.waitIdle()
    const script = ctx2.storage.snapshot().runs[view2.runId].script
    expect(script.truncated).toBe(true)
    expect(Array.from(script.stdoutTail)).toHaveLength(2048)
    expect(Array.from(script.stdoutTail)[0]).toBe('字')
  })

  it('字节截断产生的 U+FFFD 如实保留并计入 2048；spillPath 存在时记入对应字段、不改变 truncated', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    const textWithReplacement = 'x'.repeat(2047) + '\uFFFD'
    spawn.stdout = { text: textWithReplacement, lossy: true, nextOffset: 2048, spillPath: 'C:\\Temp\\dsh-subprocess-x\\1-stdout.log' }
    spawn.stderr = { text: 'err-tail', lossy: true, nextOffset: 8 }
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    const script = ctx.storage.snapshot().runs[view.runId].script
    expect(script.stdoutTail).toBe(textWithReplacement)
    expect(script.stdoutTail.includes('\uFFFD')).toBe(true)
    expect(script.stdoutSpillPath).toBe('C:\\Temp\\dsh-subprocess-x\\1-stdout.log')
    expect(script.truncated).toBe(true) // 溢写存在不改变 truncated（判定即 lossy）
  })

  it('stdin {text} 适配为宿主 {data}；env 只传覆盖项（契约 03 调用形态）', async () => {
    const ctx = makeRunner({
      autoSubprocess: false,
      orchestrationOver: { script: { command: 'node', args: [], env: { ONLY: 'override' }, stdin: { text: 'feed-me' } } },
    })
    await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    expect(spawn.spec.stdio.stdin).toEqual({ data: 'feed-me' })
    expect(spawn.spec.env).toEqual({ ONLY: 'override' })
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
  })
})

describe('正常退出后存活后代（契约 03：有界等待 waitForExit() 2000ms → terminate → descendants-terminated）', () => {
  it('后代已清空：无 warning；后代存活超 2000ms：terminate 清范围并记 descendants-terminated', async () => {
    const clean = makeRunner({ autoSubprocess: false })
    const cleanView = await requestAuto(clean.runner)
    const cleanSpawn = await waitForSpawn(clean)
    cleanSpawn.waitForExit = Promise.resolve(true)
    await cleanSpawn.finish({ exitCode: 0, signal: null })
    await clean.runner.waitIdle()
    expect(clean.storage.snapshot().runs[cleanView.runId].script.warnings).toBeUndefined()

    // 挂住的 waitForExit（后代存活）：2000ms 后 terminate + warning（真实时间等待）
    const stuck = makeRunner({ autoSubprocess: false })
    const stuckView = await requestAuto(stuck.runner)
    const stuckSpawn = await waitForSpawn(stuck)
    let waitForExitRejected = false
    stuckSpawn.waitForExit = new Promise(() => {}) // 永不完成
    stuckSpawn.handle.waitForExit = () => {
      waitForExitRejected = true
      return stuckSpawn.waitForExit
    }
    await stuckSpawn.finish({ exitCode: 0, signal: null })
    await stuck.runner.waitIdle()
    const script = stuck.storage.snapshot().runs[stuckView.runId].script
    expect(waitForExitRejected).toBe(true)
    expect(stuckSpawn.terminated).toBe(1)
    expect(script.warnings).toEqual(['descendants-terminated'])
    // warnings 只进 run 记录，不进事件载荷
    const settled = stuck.emitted.find(([name]) => name === 'script-orchestrator/run-settled')?.[1]
    expect(settled.script.warnings).toBeUndefined()
  })
})

describe('终态唯一与停机（first-write-wins；进程树生命周期以 run 为上限）', () => {
  it('已终态 run 的迟到结算为 no-op（不覆写、不重发事件）', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    // 直接构造第二笔结算竞争（票 29 取消矩阵的防御面）：对同一 run 再结算
    const before = ctx.emitted.filter(([n]) => n === 'script-orchestrator/run-settled').length
    const result = await ctx.runner.settleExternal(view.runId, { kind: 'canceled', script: ctx.storage.snapshot().runs[view.runId].script })
    expect(result).toBeNull() // no-op
    expect(ctx.storage.snapshot().runs[view.runId].status).toBe('succeeded')
    expect(ctx.emitted.filter(([n]) => n === 'script-orchestrator/run-settled').length).toBe(before)
  })

  it('shutdown：停新触发；在途 run 有界等待后取消结算 canceled（卸载=取消来源，票 29 语义）', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    const shutdownPromise = ctx.runner.shutdown()
    // shutdown 的 2 秒有界等待内 run 仍未结算 → 取消（terminate）→ 结算 canceled
    await ctx.runner.waitIdle().catch(() => {})
    await shutdownPromise
    const run = Object.values(ctx.storage.snapshot().runs)[0]
    expect(run.status).toBe('canceled')
    expect(spawn.terminated).toBeGreaterThanOrEqual(1)
    // 停机后拒绝新触发
    await expect(ctx.runner.requestRun({ orchestrationId: 'nightly', trigger: 'manual', scheduledAtMs: NOW })).rejects.toThrow(/shutting down/)
  }, 15000)
})

// ---------------- 判定与动作派发（契约 04/05/09；票 30） ----------------

const judgeWithActions = (judge, actions) => ({ judge, actions })

describe('buildSettledPayload · 64 KiB 计量与 tail 兜底（契约 06）', () => {
  it('超限时对 stdoutTail/stderrTail 依次减半保留末尾（按 code point 切割，不产生半个代理对），其余字段不截', () => {
    const run = {
      runId: 'run-00000001',
      orchestrationId: 'nightly',
      status: 'succeeded',
      trigger: 'every',
      scheduledAt: iso(NOW),
      startedAt: iso(NOW),
      settledAt: iso(NOW),
      script: {
        command: 'node',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 100,
        // 30000 个三字节汉字 = 90000 字节 > 65536 → 减半到 15000 码点（45000 字节）
        stdoutTail: '字'.repeat(30000),
        stderrTail: 'err',
        truncated: true,
      },
      matchedRule: 0,
      usedFallback: false,
      actions: [{ name: 'emit-ok', kind: 'event', status: 'succeeded', error: undefined, warnings: ['w'] }],
    }
    const payload = buildSettledPayload(run)
    expect(Array.from(payload.stdoutTail)).toHaveLength(15000)
    expect(payload.stdoutTail.endsWith('字')).toBe(true)
    expect(payload.stderrTail).toBe('err') // 尚未超限不再截
    expect(payload.actions).toEqual([{ name: 'emit-ok', kind: 'event', status: 'succeeded' }])
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(65536)
  })

  it('星形字符（代理对）减半不产生半个代理对；stdout 依次先减、耗尽后轮到 stderrTail', () => {
    // stdout 20000 星形码点（80000 字节）、stderr 30000 汉字（90000 字节）均超 65536：
    // 「依次减半」= stdout 先反复减半直至耗尽仍超限（stderr 独占 90000），随后 stderr 减半
    const run = {
      runId: 'run-00000002',
      orchestrationId: 'nightly',
      status: 'succeeded',
      trigger: 'every',
      scheduledAt: iso(NOW),
      startedAt: iso(NOW),
      settledAt: iso(NOW),
      script: {
        command: 'node',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 100,
        stdoutTail: '𝕏'.repeat(20000),
        stderrTail: '字'.repeat(30000),
        truncated: true,
      },
      matchedRule: null,
      usedFallback: false,
      actions: [],
    }
    const payload = buildSettledPayload(run)
    expect(payload.stdoutTail).toBe('') // 先耗尽 stdout 再轮到 stderr（依次）
    expect(Array.from(payload.stderrTail)).toHaveLength(15000)
    expect(payload.stderrTail.endsWith('字')).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(65536)
  })
})

describe('判定 → 派发 → 汇总（契约 04/05/09：脚本启动成功即进判定，动作按汇总定终态）', () => {
  it('event 动作端到端：发出全名与四键载荷（payload 已渲染）；run.actions[] 落盘；汇总 succeeded', async () => {
    const ctx = makeRunner({
      orchestrationOver: judgeWithActions(
        { rules: [{ when: { exitCode: 0 }, actions: ['emit-ok'] }], fallback: [] },
        { 'emit-ok': { kind: 'event', name: 'deploy-ok', payload: { summary: '{{orchestrationTitle}} 退出码 {{exitCode}}' } } },
      ),
    })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded')
    expect(run.matchedRule).toBe(0)
    expect(run.usedFallback).toBe(false)
    expect(run.actions).toEqual([{ name: 'emit-ok', kind: 'event', status: 'succeeded' }])
    const custom = ctx.emitted.find(([name]) => name === 'script-orchestrator/deploy-ok')
    expect(custom).toBeTruthy()
    expect(custom[1]).toEqual({
      name: 'deploy-ok',
      payload: { summary: '夜间巡检 退出码 0' },
      orchestration: { id: 'nightly', title: '夜间巡检' },
      run: { runId: view.runId, status: 'succeeded', exitCode: 0 },
    })
  })

  it('票 32：persistent session 动作经 runner 派发——sessionEnv 由 config/hostCwd/编排 script.cwd 组装；成功记录 sessionId 并落盘', async () => {
    const creates = []
    const sessionHost = {
      sessionController: {
        create: async (request) => {
          creates.push(request)
          return { sessionId: request.sessionId }
        },
        resolveAgent: async (id) => ({ agent: { session: { id }, model: { select: () => {} }, followup: () => {} } }),
      },
      sessions: { flush: async () => true },
      getSessionTitle: () => undefined,
    }
    const ctx = makeRunner({
      orchestrationOver: judgeWithActions(
        { rules: [{ when: { exitCode: 0 }, actions: ['open-triage'] }], fallback: [] },
        { 'open-triage': { kind: 'session', prompt: '排查 {{exitCode}}' } },
      ),
      sessionHost,
    })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded')
    expect(run.actions[0]).toMatchObject({ name: 'open-triage', kind: 'session', status: 'succeeded' })
    expect(run.actions[0].sessionId).toBe(creates[0].sessionId)
    // 编排 script.cwd 未设 → session cwd 缺省链落到 hostCwd（与脚本 cwd 解析同链）
    expect(creates[0].cwd).toBe('D:\\work\\proj')
  })

  it('票 32：config.allowedRoots 约束 session cwd（动作显式 cwd 越界；脚本 cwd 在界内正常执行）→ cwd_not_allowed，不创建会话', async () => {
    const creates = []
    const sessionHost = {
      sessionController: {
        create: async (request) => {
          creates.push(request)
          return { sessionId: request.sessionId }
        },
        resolveAgent: async (id) => ({ agent: { session: { id }, model: { select: () => {} }, followup: () => {} } }),
      },
      sessions: { flush: async () => true },
      getSessionTitle: () => undefined,
    }
    const ctx = makeRunner({
      config: { ...BASE_CONFIG, allowedRoots: ['D:\\work'] },
      orchestrationOver: {
        script: { command: 'node', args: ['check.js'], env: {}, cwd: 'D:\\work\\proj' },
        ...judgeWithActions(
          { rules: [{ when: { exitCode: 0 }, actions: ['open-triage'] }], fallback: [] },
          { 'open-triage': { kind: 'session', prompt: 'p', cwd: 'E:\\evil' } },
        ),
      },
      sessionHost,
    })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('failed') // 脚本正常执行进判定；唯一动作 cwd_not_allowed → 0 成 1 败
    expect(run.actions[0]).toMatchObject({ status: 'failed', error: { code: 'cwd_not_allowed' } })
    expect(run.actions[0].sessionId).toBeUndefined()
    expect(creates).toEqual([])
  })

  it('动作汇总矩阵：一成一败 → partial；全败 → failed（零动作 succeeded 已由上文覆盖）', async () => {
    const partial = makeRunner({
      orchestrationOver: judgeWithActions(
        { rules: [], fallback: ['page', 'emit-ok'] },
        { page: { kind: 'plugin', action: 'ops.oncall' }, 'emit-ok': { kind: 'event', name: 'deploy-ok' } },
      ),
    })
    const partialView = await requestAuto(partial.runner)
    await partial.runner.waitIdle()
    const partialRun = partial.storage.snapshot().runs[partialView.runId]
    expect(partialRun.status).toBe('partial')
    expect(partialRun.usedFallback).toBe(true)
    expect(partialRun.matchedRule).toBeNull()
    expect(partialRun.actions).toEqual([
      { name: 'page', kind: 'plugin', status: 'failed', error: { code: 'unknown_action', message: expect.stringContaining('ops.oncall') } },
      { name: 'emit-ok', kind: 'event', status: 'succeeded' },
    ])

    const failed = makeRunner({
      orchestrationOver: judgeWithActions(
        { rules: [{ when: { exitCode: 0 }, actions: ['p1', 'p2'] }], fallback: [] },
        { p1: { kind: 'plugin', action: 'a.one' }, p2: { kind: 'plugin', action: 'b.two' } },
      ),
    })
    const failedView = await requestAuto(failed.runner)
    await failed.runner.waitIdle()
    expect(failed.storage.snapshot().runs[failedView.runId].status).toBe('failed')
  })

  it('action-settled 按动作执行序发布：在 run 持久写之后、run-settled 之前；listener 立即回读已见终态', async () => {
    const storage = makeStorage()
    const emitted = []
    const readBack = []
    const ctx = makeRunner({
      storage,
      autoSubprocess: false,
      orchestration: makeOrchestration(
        judgeWithActions(
          { rules: [], fallback: ['e1', 'e2'] },
          { e1: { kind: 'event', name: 'first' }, e2: { kind: 'event', name: 'second' } },
        ),
      ),
      emit: (name, payload) => {
        emitted.push([name, payload])
        if (name === 'script-orchestrator/action-settled') {
          readBack.push(storage.table('runs').get(payload.runId)?.status)
        }
      },
    })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    // 事件时序：自定义事件（动作效果，派发期间发出）→ action-settled×2（写 2 后、按执行序）→ run-settled
    expect(emitted.map(([name]) => name)).toEqual([
      'script-orchestrator/run-started',
      'script-orchestrator/first',
      'script-orchestrator/second',
      'script-orchestrator/action-settled',
      'script-orchestrator/action-settled',
      'script-orchestrator/run-settled',
    ])
    const settledPayloads = emitted.filter(([name]) => name === 'script-orchestrator/action-settled').map(([, payload]) => payload)
    const [first, second] = settledPayloads
    expect(first).toEqual({ runId: view.runId, orchestrationId: 'nightly', name: 'e1', kind: 'event', status: 'succeeded' })
    expect(second).toEqual({ runId: view.runId, orchestrationId: 'nightly', name: 'e2', kind: 'event', status: 'succeeded' })
    // 回读一致性：每个 action-settled 到达时 run 记录已含终态与完整动作结果（写 2 已落）
    expect(readBack).toEqual(['succeeded', 'succeeded'])
    expect(storage.snapshot().runs[view.runId].actions).toHaveLength(2)
  })

  it('action-settled 对 failed 动作携带 error（{ code, message }，无堆栈）', async () => {
    const ctx = makeRunner({
      orchestrationOver: judgeWithActions(
        { rules: [], fallback: ['page'] },
        { page: { kind: 'plugin', action: 'ops.oncall' } },
      ),
    })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    const settled = ctx.emitted.find(([name]) => name === 'script-orchestrator/action-settled')?.[1]
    expect(settled).toEqual({
      runId: view.runId,
      orchestrationId: 'nightly',
      name: 'page',
      kind: 'plugin',
      status: 'failed',
      error: { code: 'unknown_action', message: expect.any(String) },
    })
  })

  it('dispatching 内存态：判定字段与逐动作进度经 liveView 可见（中途状态不落盘）', async () => {
    let releaseSlow
    const registry = {
      resolve: (name) =>
        name === 'slow.act'
          ? { name, run: () => new Promise((resolve) => { releaseSlow = resolve }) }
          : undefined,
    }
    const ctx = makeRunner({
      autoSubprocess: false,
      registry,
      orchestrationOver: judgeWithActions(
        { rules: [{ when: { exitCode: 0 }, actions: ['slow', 'emit-ok'] }], fallback: [] },
        { slow: { kind: 'plugin', action: 'slow.act' }, 'emit-ok': { kind: 'event', name: 'after-slow' } },
      ),
    })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 0, signal: null })
    await vi.waitFor(() => {
      if (ctx.runner.liveView(view.runId)?.status !== 'dispatching') throw new Error('not dispatching')
    })
    const live = ctx.runner.liveView(view.runId)
    expect(live.matchedRule).toBe(0)
    expect(live.usedFallback).toBe(false)
    expect(live.actions).toEqual([]) // 挂起动作尚未结算
    // 中途状态不落盘：持久记录仍是 queued 形状（status 来自写 1）
    expect(ctx.storage.snapshot().runs[view.runId].status).toBe('queued')
    releaseSlow()
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded')
    expect(run.actions.map((a) => [a.name, a.status])).toEqual([['slow', 'succeeded'], ['emit-ok', 'succeeded']])
  })

  it('非零退出码照常派发（退出码是判定输入不是失败判据）：exitCode 谓词命中并执行动作', async () => {
    const ctx = makeRunner({
      autoSubprocess: false,
      orchestrationOver: judgeWithActions(
        { rules: [{ when: { exitCode: { not: 0 } }, actions: ['emit-bad'] }], fallback: [] },
        { 'emit-bad': { kind: 'event', name: 'deploy-bad' } },
      ),
    })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 3, signal: null })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.matchedRule).toBe(0)
    expect(run.status).toBe('succeeded')
    expect(run.actions).toEqual([{ name: 'emit-bad', kind: 'event', status: 'succeeded' }])
  })

  it('spawn_failed 跳过判定与派发：无动作执行、无 action-settled、matchedRule 保持 null', async () => {
    const fs = makeFakeFs()
    fs.missing.add('D:\\work\\proj')
    const ctx = makeRunner({
      autoSubprocess: false,
      fs,
      orchestrationOver: judgeWithActions(
        { rules: [{ when: { exitCode: 0 }, actions: ['emit-ok'] }], fallback: [] },
        { 'emit-ok': { kind: 'event', name: 'deploy-ok' } },
      ),
    })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('failed')
    expect(run.actions).toEqual([])
    expect(run.matchedRule).toBeNull()
    expect(ctx.emitted.some(([name]) => name === 'script-orchestrator/action-settled')).toBe(false)
    expect(ctx.emitted.some(([name]) => name === 'script-orchestrator/deploy-ok')).toBe(false)
  })
})

describe('dispatching 取消（契约 03/09：停止派发剩余动作、已执行结果保留、终态优先）', () => {
  it('requestCancel：在途动作经 signal 中止、剩余 skipped、终态 canceled（即使已有成功动作）', async () => {
    const registry = {
      resolve: (name) =>
        name === 'hang.act'
          ? {
              name,
              run: (context) =>
                new Promise((resolve, reject) => {
                  context.signal.addEventListener('abort', () => reject(new Error('aborted')))
                }),
            }
          : undefined,
    }
    const ctx = makeRunner({
      autoSubprocess: false,
      registry,
      orchestrationOver: judgeWithActions(
        { rules: [], fallback: ['emit-ok', 'hang', 'emit-late'] },
        {
          'emit-ok': { kind: 'event', name: 'first' },
          hang: { kind: 'plugin', action: 'hang.act' },
          'emit-late': { kind: 'event', name: 'never' },
        },
      ),
    })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 0, signal: null })
    await vi.waitFor(() => {
      if (ctx.runner.liveView(view.runId)?.status !== 'dispatching') throw new Error('not dispatching')
    })
    expect(ctx.runner.cancelRun(view.runId)).toBe(true)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('canceled') // 终态优先于动作汇总（已有一个成功动作也不改 partial）
    expect(run.actions.map((a) => [a.name, a.status])).toEqual([
      ['emit-ok', 'succeeded'],
      ['hang', 'failed'],
      ['emit-late', 'skipped'],
    ])
    expect(run.actions[1].error.code).toBe('action_error')
    // 事件时序：自定义事件（动作效果）→ 三个 action-settled（含 skipped）按执行序 → run-settled(canceled)
    const names = ctx.emitted.map(([name]) => name)
    expect(names).toEqual([
      'script-orchestrator/run-started',
      'script-orchestrator/first',
      'script-orchestrator/action-settled',
      'script-orchestrator/action-settled',
      'script-orchestrator/action-settled',
      'script-orchestrator/run-settled',
    ])
    expect(ctx.emitted.at(-1)[1]).toMatchObject({ runId: view.runId, status: 'canceled' })
    // 剩余动作未派发：never 事件未发出
    expect(ctx.emitted.some(([name]) => name === 'script-orchestrator/never')).toBe(false)
  })

  it('cancelRun 对终态或未知 run 返回 false（幂等）', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    const view = await requestAuto(ctx.runner)
    await waitForSpawn(ctx)
    await ctx.subprocess.spawns[0].finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
    expect(ctx.runner.cancelRun(view.runId)).toBe(false) // 自然结算先到（first-write-wins）
    expect(ctx.runner.cancelRun('run-00000000')).toBe(false) // 未知 run
  })
})

// ---------------- 完整取消矩阵与卸载取消（契约 03「取消与等待」；票 29） ----------------

describe('cancelRun · 取消矩阵四阶段（契约 03：queued/running/judging/dispatching）', () => {
  it('queued（pending 中）：直接结算 canceled 不 spawn，两写完整、run-settled(canceled) 发布', async () => {
    // maxConcurrentRuns=1 + 一个 running 占槽 → 第二个编排的 run 排队
    const storage = makeStorage()
    storage.table('orchestrations').put('nightly', makeOrchestration())
    storage.table('orchestrations').put('other', makeOrchestration({ id: 'other' }))
    const ctx = makeRunner({ storage, autoSubprocess: false, config: { ...BASE_CONFIG, maxConcurrentRuns: 1 } })
    await ctx.runner.requestRun({ orchestrationId: 'nightly', trigger: 'manual', scheduledAtMs: NOW })
    await waitForSpawn(ctx) // 占住唯一槽
    const queued = await ctx.runner.requestRun({ orchestrationId: 'other', trigger: 'manual', scheduledAtMs: NOW + 1 })
    expect(queued.status).toBe('queued')

    expect(ctx.runner.cancelRun(queued.runId)).toBe(true)
    await vi.waitFor(() => {
      const run = ctx.storage.snapshot().runs[queued.runId]
      if (run?.status !== 'canceled') throw new Error('not canceled yet')
    })
    const run = ctx.storage.snapshot().runs[queued.runId]
    expect(run.skipReason).toBeNull()
    expect(run.startedAt).toBeNull() // 未启动
    const puts = ctx.storage.puts.filter(([table, key]) => table === 'runs' && key === queued.runId)
    expect(puts.map((p) => p[2])).toEqual(['queued', 'canceled']) // 两写完整
    const canceledEvent = ctx.emitted
      .filter(([n]) => n === 'script-orchestrator/run-settled')
      .map(([, p]) => p)
      .find((p) => p.runId === queued.runId)
    expect(canceledEvent).toMatchObject({ runId: queued.runId, status: 'canceled', startedAt: null })
    // 清理：结束占槽 run
    await ctx.subprocess.spawns[0].finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
  })

  it('running：terminate 后 done 以 resolve（Windows Job 语义）结算 canceled，不是 succeeded', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    expect(ctx.runner.cancelRun(view.runId)).toBe(true)
    await ctx.runner.waitIdle()
    expect(spawn.terminated).toBe(1) // 终止进程
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('canceled') // terminate 的 {exitCode:1} 不进判定、不结算 succeeded
    expect(run.script.exitCode).toBeNull()
    expect(run.matchedRule).toBeNull()
    expect(ctx.emitted.filter(([n]) => n === 'script-orchestrator/run-settled').map(([, p]) => p)[0]).toMatchObject({
      runId: view.runId,
      status: 'canceled',
    })
  })

  it('running：terminate 后 done 以 reject 结算同样 canceled（不记 spawn_failed）', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    spawn.handle.terminate = () => {
      spawn.terminated += 1
      spawn.fail(new Error('terminated by cancel'))
    }
    expect(ctx.runner.cancelRun(view.runId)).toBe(true)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('canceled')
    expect(run.script.warnings).toBeUndefined() // 不是 spawn_failed
  })

  it('judging：取消被忽略（返回 false、不置标志）、动作照常执行、终态按动作汇总', async () => {
    const ctx = makeRunner({
      autoSubprocess: false,
      orchestrationOver: judgeWithActions(
        { rules: [{ when: { exitCode: 0 }, actions: ['emit-ok', 'emit-two'] }], fallback: [] },
        { 'emit-ok': { kind: 'event', name: 'one' }, 'emit-two': { kind: 'event', name: 'two' } },
      ),
    })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 0, signal: null })
    // judging 是纯内存毫秒级：以微任务粒度捕捉该内存态（判定与派发之间的边界），
    // 并在边界内同步发起取消（返回 false 才是「不响应」）
    const canceled = await atLiveStatusMicrotask(ctx.runner, view.runId, 'judging', () =>
      ctx.runner.cancelRun(view.runId),
    )
    expect(canceled).toBe(false)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded') // 不出现「全 skipped + canceled」，按动作汇总
    expect(run.matchedRule).toBe(0) // 判定照常
    expect(run.actions.map((a) => [a.name, a.status])).toEqual([
      ['emit-ok', 'succeeded'],
      ['emit-two', 'succeeded'],
    ])
    expect(ctx.emitted.filter(([n]) => n === 'script-orchestrator/one')).toHaveLength(1)
    expect(ctx.emitted.filter(([n]) => n === 'script-orchestrator/two')).toHaveLength(1)
    expect(ctx.emitted.at(-1)[1]).toMatchObject({ runId: view.runId, status: 'succeeded' })
  })

  it('judging（零动作）：取消仍返回 false，run 自然结算 succeeded（不出现 canceled/skipped）', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 0, signal: null })
    const canceled = await atLiveStatusMicrotask(ctx.runner, view.runId, 'judging', () =>
      ctx.runner.cancelRun(view.runId),
    )
    expect(canceled).toBe(false)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run).toMatchObject({ status: 'succeeded', skipReason: null, actions: [] })
  })

  it('dispatching：在途动作经 signal 中止、剩余 skipped、已执行保留（与 requestCancel 同路径）', async () => {
    const registry = {
      resolve: (name) =>
        name === 'hang.act'
          ? { name, run: (context) => new Promise((resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted')))) }
          : undefined,
    }
    const ctx = makeRunner({
      autoSubprocess: false,
      registry,
      orchestrationOver: judgeWithActions(
        { rules: [], fallback: ['emit-ok', 'hang', 'emit-late'] },
        { 'emit-ok': { kind: 'event', name: 'first' }, hang: { kind: 'plugin', action: 'hang.act' }, 'emit-late': { kind: 'event', name: 'never' } },
      ),
    })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 0, signal: null })
    await vi.waitFor(() => {
      if (ctx.runner.liveView(view.runId)?.status !== 'dispatching') throw new Error('not dispatching')
    })
    expect(ctx.runner.cancelRun(view.runId)).toBe(true)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('canceled')
    expect(run.actions.map((a) => [a.name, a.status])).toEqual([
      ['emit-ok', 'succeeded'],
      ['hang', 'failed'],
      ['emit-late', 'skipped'],
    ])
  })

  it('终态或未知 run → false；已 canceled 后迟到自然结算 no-op（first-write-wins 不重发事件）', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    const view = await requestAuto(ctx.runner)
    const spawn = await waitForSpawn(ctx)
    expect(ctx.runner.cancelRun(view.runId)).toBe(true)
    await ctx.runner.waitIdle()
    expect(ctx.storage.snapshot().runs[view.runId].status).toBe('canceled')
    // 取消已生效：再次取消 false；终态后 false
    expect(ctx.runner.cancelRun(view.runId)).toBe(false)
    expect(ctx.runner.cancelRun('run-00000000')).toBe(false)
    const before = ctx.emitted.filter(([n]) => n === 'script-orchestrator/run-settled').length
    // 迟到的自然结算（模拟取消与自然结算的竞争路径）：first-write-wins no-op
    const late = await ctx.runner.settleExternal(view.runId, {
      kind: 'script',
      script: ctx.storage.snapshot().runs[view.runId].script,
      verdict: { matchedRule: null, usedFallback: false, actionKeys: [] },
      actionResults: [],
      dispatchCanceled: false,
    })
    expect(late).toBeNull()
    expect(ctx.emitted.filter(([n]) => n === 'script-orchestrator/run-settled').length).toBe(before)
    expect(ctx.storage.snapshot().runs[view.runId].status).toBe('canceled')
  })
})

describe('卸载取消与删除中标记（契约 03 取消矩阵来源含插件卸载；票 29）', () => {
  it('shutdown：在途 run 有界等待后取消并结算 canceled（不留继续派发动作的孤儿执行）', async () => {
    const ctx = makeRunner({ autoSubprocess: false })
    const view = await requestAuto(ctx.runner)
    await waitForSpawn(ctx)
    await ctx.runner.shutdown()
    await vi.waitFor(() => {
      const run = ctx.storage.snapshot().runs[view.runId]
      if (run?.status !== 'canceled') throw new Error('not canceled by shutdown')
    })
    expect(ctx.subprocess.spawns[0].terminated).toBeGreaterThanOrEqual(1)
  })

  it('markDeleting：删除中编排的 requestRun 一律不受理（无 run 记录，自动/手动同拒）', async () => {
    const ctx = makeRunner()
    ctx.runner.markDeleting?.('nightly', true)
    const auto = await requestAuto(ctx.runner)
    const manual = await ctx.runner.requestRun({ orchestrationId: 'nightly', trigger: 'manual', scheduledAtMs: NOW })
    expect(auto).toBeNull()
    expect(manual).toBeNull()
    expect(ctx.storage.snapshot().runs).toEqual({}) // 不产生任何 run 记录（含 skip）
    expect(ctx.subprocess.spawns).toHaveLength(0)
    ctx.runner.markDeleting?.('nightly', false)
    const again = await requestAuto(ctx.runner)
    expect(again?.status).toMatch(/queued|running/)
    await ctx.runner.waitIdle()
  })
})

describe('保留裁剪接线（票 34；契约 08「结算写入后同一服务槽位内顺带执行」）', () => {
  it('结算：写 2 之后调用 retention.enforce，run-settled 照常发布', async () => {
    const order = []
    const ctx = makeRunner({
      retention: {
        enforce: async () => {
          order.push('retention')
        },
      },
    })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    expect(order).toEqual(['retention'])
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded')
    // 裁剪在写 2 之后（同一槽位内顺带执行）
    expect(ctx.storage.puts.some(([table, , status]) => table === 'runs' && status === 'succeeded')).toBe(true)
    expect(ctx.emitted.some(([name]) => name === 'script-orchestrator/run-settled')).toBe(true)
  })

  it('裁剪异常不影响结算与事件发布（契约 08：失败容忍暂时超限）', async () => {
    const ctx = makeRunner({
      retention: {
        enforce: async () => {
          throw new Error('domain write rejected')
        },
      },
    })
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded')
    expect(ctx.logs.some((m) => m.includes('保留裁剪异常'))).toBe(true)
    expect(ctx.emitted.some(([name]) => name === 'script-orchestrator/run-settled')).toBe(true)
  })

  it('skipped 结算同样触发裁剪', async () => {
    const calls = []
    const ctx = makeRunner({
      autoSubprocess: false,
      retention: {
        enforce: async () => {
          calls.push('retention')
        },
      },
    })
    const first = await requestAuto(ctx.runner)
    expect(['queued', 'running']).toContain(first.status)
    const second = await requestAuto(ctx.runner) // 单飞占用中自动触发 → overlap skip
    expect(second.status).toBe('skipped')
    expect(calls).toEqual(['retention'])
    // 收尾：让首 run 正常结算，不遗留挂起执行
    const spawn = await waitForSpawn(ctx)
    await spawn.finish({ exitCode: 0, signal: null })
    await ctx.runner.waitIdle()
  })

  it('tailText：取解码后末 2048 code point，U+FFFD 如实保留并计入', async () => {
    const { tailText } = await import('../lib/execution-utils.js')
    const text = 'x'.repeat(3000) + '\uFFFD中'
    const tail = tailText(text, 2048)
    expect(Array.from(tail).length).toBe(2048)
    expect(tail.endsWith('\uFFFD中')).toBe(true) // 替换字符保留（契约 03：U+FFFD 如实保留并计入）
  })
})
