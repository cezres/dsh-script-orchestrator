// 调度器（契约 docs/temp/02-triggers.md）：单 timer、到点触发、错过合并、
// fixed-rate 相位推进 / fixed-delay 等待结算。nextOccurrence 纯函数（lib/triggers.js）
// 已在 triggers.test 覆盖；本文件测调度状态机：锚点选择、timer 重算与触发竞争复核。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createScheduler } from '../lib/scheduler.js'
import { ServiceQueue } from '../lib/fifo.js'
import { createRunner } from '../lib/runner.js'

const T0 = 1_790_000_000_000
const iso = (ms) => new Date(ms).toISOString()

function makeStorage() {
  const tables = { orchestrations: new Map(), runs: new Map() }
  const puts = []
  const table = (name) => ({
    entries: () => tables[name].entries(),
    get: (key) => tables[name].get(key),
    put: (key, value) => {
      puts.push([name, key])
      tables[name].set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      tables[name].delete(key)
      return Promise.resolve()
    },
  })
  return { table, puts, snapshot: () => ({ orchestrations: Object.fromEntries(tables.orchestrations), runs: Object.fromEntries(tables.runs) }) }
}

/** 记录型 fake subprocess：spawn 即记、done 挂起由测试手动放行（默认立即成功）。 */
function makeFakeSubprocess({ auto = true } = {}) {
  const spawns = []
  const spawn = (spec) => {
    const entry = { spec, terminated: 0, stdout: { text: '', lossy: false, nextOffset: 0 }, stderr: { text: '', lossy: false, nextOffset: 0 } }
    spawns.push(entry)
    let resolveDone
    entry.handle = {
      done: new Promise((resolve) => {
        resolveDone = resolve
      }),
      terminate: () => {
        entry.terminated += 1
        resolveDone({ exitCode: 1, signal: null })
      },
      waitForExit: () => Promise.resolve(true),
      collected: {
        stdout: { readFrom: () => entry.stdout },
        stderr: { readFrom: () => entry.stderr },
      },
    }
    entry.finish = (result) => resolveDone(result ?? { exitCode: 0, signal: null })
    if (auto) queueMicrotask(() => entry.finish())
    return entry.handle
  }
  return { spawn, spawns }
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
    createdAt: iso(T0),
    updatedAt: iso(T0),
    status: 'active',
    nextOccurrence: iso(T0 + 300_000),
    ...over,
  }
}

/** 组装 scheduler + runner（时钟与 fake timer 同源：默认用 Date.now()，由 vi 驱动）。 */
function makeWorld(over = {}) {
  const storage = over.storage ?? makeStorage()
  const orchestration = over.orchestration ?? makeOrchestration(over.orchestrationOver ?? {})
  if (!over.skipSeed) storage.table('orchestrations').put(orchestration.id, orchestration)
  const queue = new ServiceQueue()
  const subprocess = over.subprocess ?? makeFakeSubprocess()
  const emitted = []
  const logs = []
  const clock = over.now ?? (() => Date.now())
  const runner = createRunner({
    storage,
    queue,
    subprocess,
    config: {
      maxConcurrentRuns: 2,
      defaultTimeoutSeconds: 300,
      maxOutputBytes: 262144,
      maxSpillBytes: 8388608,
      allowedRoots: [],
      maxRunsPerOrchestration: 100,
    },
    emit: (name, payload) => emitted.push([name, payload]),
    now: clock,
    logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
    fs: { stat: async () => ({ isDirectory: () => true }) },
    hostCwd: 'D:\\work\\proj',
  })
  const scheduler = createScheduler({
    storage,
    queue,
    runner,
    now: clock,
    logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
    emit: (name, payload) => emitted.push([name, payload]),
  })
  return { scheduler, runner, storage, subprocess, emitted, logs }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fixed-rate 到点触发与相位推进（契约 02「fixed-rate」）', () => {
  it('到点触发：run.scheduledAt = 计划时刻，nextOccurrence = scheduledAt + everySeconds（相位不变）', async () => {
    const world = makeWorld()
    world.scheduler.start()
    await vi.advanceTimersByTimeAsync(299_999)
    expect(world.storage.snapshot().runs).toEqual({})
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(Object.keys(world.storage.snapshot().runs)).toHaveLength(1))
    const [run] = Object.values(world.storage.snapshot().runs)
    expect(run.scheduledAt).toBe(iso(T0 + 300_000))
    expect(run.trigger).toBe('every')
    const orch = world.storage.snapshot().orchestrations.nightly
    expect(orch.nextOccurrence).toBe(iso(T0 + 600_000))
    expect(run.status).toBe('succeeded') // fake subprocess 自动完成
    world.scheduler.stop()
  })

  it('到点延迟执行不改变后续相位：scheduledAt 记原计划时刻', async () => {
    // fake subprocess 挂起：触发后时钟再走，相位仍按 scheduledAt 推进
    const world = makeWorld({ subprocess: makeFakeSubprocess({ auto: false }) })
    world.scheduler.start()
    await vi.advanceTimersByTimeAsync(300_000 + 120_000) // 计划后 120 秒才被处理
    await vi.waitFor(() => expect(Object.keys(world.storage.snapshot().runs)).toHaveLength(1))
    const [run] = Object.values(world.storage.snapshot().runs)
    expect(run.scheduledAt).toBe(iso(T0 + 300_000)) // 原计划时刻
    expect(world.storage.snapshot().orchestrations.nightly.nextOccurrence).toBe(iso(T0 + 600_000))
    world.subprocess.spawns[0].finish({ exitCode: 0, signal: null })
    await world.runner.waitIdle()
    world.scheduler.stop()
  })

  it('停机/迟到错过多个计划合并为一次：按最近一次错过的计划时刻建一个 run，推进到未来', async () => {
    // nextOccurrence = T0+300s，时钟在 T0+1300s（错过 300/600/900/1200 四次）才启动
    const world = makeWorld()
    vi.setSystemTime(T0 + 1_300_000)
    world.scheduler.start()
    await vi.waitFor(() => expect(Object.keys(world.storage.snapshot().runs)).toHaveLength(1))
    const [run] = Object.values(world.storage.snapshot().runs)
    expect(run.scheduledAt).toBe(iso(T0 + 1_200_000)) // 最近一次错过的计划时刻
    expect(world.storage.snapshot().orchestrations.nightly.nextOccurrence).toBe(iso(T0 + 1_500_000)) // 未来
    expect(Object.keys(world.storage.snapshot().runs)).toHaveLength(1) // 只一个 run，不逐条补
    world.scheduler.stop()
  })
})

describe('fixed-delay 到点触发与结算推进（契约 02「fixed-delay」）', () => {
  it('触发后 nextOccurrence = null（等待结算）；结算后从 settledAt + everySeconds 推进', async () => {
    const world = makeWorld({
      orchestrationOver: { trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' } },
      subprocess: makeFakeSubprocess({ auto: false }),
    })
    world.scheduler.start()
    await vi.advanceTimersByTimeAsync(300_000)
    await vi.waitFor(() => expect(Object.keys(world.storage.snapshot().runs)).toHaveLength(1))
    expect(world.storage.snapshot().orchestrations.nightly.nextOccurrence).toBeNull() // 等待结算
    // 时钟走到 T0+310s 再结算：settledAt = T0+310s → 下一计划 T0+610s
    //（waitFor 轮询会推进 fake timer 数十毫秒，断言按毫秒差校验）
    await vi.advanceTimersByTimeAsync(10_000)
    world.subprocess.spawns[0].finish({ exitCode: 0, signal: null })
    await world.runner.waitIdle()
    const nextMs = Date.parse(world.storage.snapshot().orchestrations.nightly.nextOccurrence)
    expect(Math.abs(nextMs - (T0 + 610_000))).toBeLessThan(1_000)
    world.scheduler.stop()
  })

  it('手动 run 不影响自动序列：fixed-rate 手动触发后到点照常触发（run.trigger = manual 不推进相位由 runner 管）', async () => {
    const world = makeWorld()
    await world.runner.requestRun({ orchestrationId: 'nightly', trigger: 'manual', scheduledAtMs: T0 + 5_000 })
    await world.runner.waitIdle()
    world.scheduler.start()
    expect(world.storage.snapshot().orchestrations.nightly.nextOccurrence).toBe(iso(T0 + 300_000)) // 手动未改变计划
    await vi.advanceTimersByTimeAsync(300_000)
    await vi.waitFor(() => expect(Object.values(world.storage.snapshot().runs).some((r) => r.trigger === 'every')).toBe(true))
    const auto = Object.values(world.storage.snapshot().runs).find((r) => r.trigger === 'every')
    expect(auto.scheduledAt).toBe(iso(T0 + 300_000))
    world.scheduler.stop()
  })
})

describe('timer 纪律（契约 02「下次触发计算」：全插件一个 timer，取最早者）', () => {
  it('多编排取最早者逐个触发；paused 编排不进 timer', async () => {
    const world = makeWorld({ skipSeed: true })
    world.storage.table('orchestrations').put('early', makeOrchestration({ id: 'early', nextOccurrence: iso(T0 + 100_000) }))
    world.storage.table('orchestrations').put('late', makeOrchestration({ id: 'late', nextOccurrence: iso(T0 + 200_000) }))
    world.storage.table('orchestrations').put('paused-o', makeOrchestration({ id: 'paused-o', status: 'paused', nextOccurrence: iso(T0 + 50_000) }))
    world.scheduler.start()
    await vi.advanceTimersByTimeAsync(100_000)
    await vi.waitFor(() => expect(Object.values(world.storage.snapshot().runs).some((r) => r.orchestrationId === 'early')).toBe(true))
    // paused-o 的更早时刻不触发（暂停不产生新自动 run）
    expect(Object.values(world.storage.snapshot().runs).some((r) => r.orchestrationId === 'paused-o')).toBe(false)
    await vi.advanceTimersByTimeAsync(100_000)
    await vi.waitFor(() => expect(Object.values(world.storage.snapshot().runs).some((r) => r.orchestrationId === 'late')).toBe(true))
    world.scheduler.stop()
  })

  it('pause 后残留的旧 timer 到点复核 no-op：不产生 run、不改计划', async () => {
    const world = makeWorld({ subprocess: makeFakeSubprocess({ auto: false }) })
    world.scheduler.start()
    // 到点前把编排暂停（模拟 pause 与 timer 的竞态：nextOccurrence 已被置 null）
    world.storage.table('orchestrations').put('nightly', {
      ...world.storage.snapshot().orchestrations.nightly,
      status: 'paused',
      nextOccurrence: null,
    })
    world.scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(world.storage.snapshot().runs).toEqual({}) // 复核发现计划已消失 → no-op
    world.scheduler.stop()
  })

  it('reschedule 由编排集合变更驱动：create 后新编排纳入 timer', async () => {
    const world = makeWorld({ skipSeed: true })
    world.scheduler.start()
    expect(world.storage.snapshot().runs).toEqual({})
    world.storage.table('orchestrations').put('fresh', makeOrchestration({ id: 'fresh', nextOccurrence: iso(T0 + 100_000) }))
    world.scheduler.reschedule()
    await vi.advanceTimersByTimeAsync(100_000)
    await vi.waitFor(() => expect(Object.values(world.storage.snapshot().runs).some((r) => r.orchestrationId === 'fresh')).toBe(true))
    world.scheduler.stop()
  })

  it('stop 后不再触发', async () => {
    const world = makeWorld()
    world.scheduler.start()
    world.scheduler.stop()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(world.storage.snapshot().runs).toEqual({})
  })

  it('cron kind 编排（存储读侧接受的防御形状）不触发、不崩（实现属票 27）', async () => {
    const world = makeWorld({ skipSeed: true })
    world.storage.table('orchestrations').put('cron-o', makeOrchestration({
      id: 'cron-o',
      trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' },
      nextOccurrence: iso(T0 + 60_000),
    }))
    world.scheduler.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(world.storage.snapshot().runs).toEqual({})
    world.scheduler.stop()
  })
})
