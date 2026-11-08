// 执行引擎（契约 docs/temp/03-execution.md）：执行生命周期、单飞/全局并发、两写、
// 结算口径、输出收集、后代清理、事件发布时序。subprocess/fs/时钟全部注入，
// 真实 Windows 进程路径另见 test/execution.process.test.js。
import { describe, it, expect, vi } from 'vitest'
import { createRunner } from '../lib/runner.js'
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

  it('fixed-rate 编排的 run 结算不改 nextOccurrence（相位推进只发生在触发时，属 scheduler）', async () => {
    const ctx = makeRunner()
    const view = await requestAuto(ctx.runner)
    await ctx.runner.waitIdle()
    expect(ctx.storage.snapshot().runs[view.runId].status).toBe('succeeded')
    expect(ctx.storage.snapshot().orchestrations.nightly.nextOccurrence).toBe(iso(NOW))
  })
})
