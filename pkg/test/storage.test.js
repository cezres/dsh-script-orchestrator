import { describe, it, expect } from 'vitest'
import { domainSpec, openStorage } from '../lib/storage.js'
import { createManagementService } from '../lib/service.js'
import { ServiceQueue } from '../lib/fifo.js'

function fakeDomain({ orchestrations = [], runs = [] } = {}) {
  const tables = {
    orchestrations: new Map(orchestrations),
    runs: new Map(runs),
  }
  const log = { deleted: [], closed: 0 }
  return {
    name: domainSpec.name,
    table: (name) => ({
      entries: () => tables[name].entries(),
      get: (key) => tables[name].get(key),
      put: (key, value) => {
        tables[name].set(key, value)
        return Promise.resolve()
      },
      delete: (key) => {
        log.deleted.push([name, key])
        tables[name].delete(key)
        return Promise.resolve()
      },
    }),
    close: () => {
      log.closed += 1
      return Promise.resolve()
    },
    snapshot: () => ({
      orchestrations: Object.fromEntries(tables.orchestrations),
      runs: Object.fromEntries(tables.runs),
    }),
    log,
  }
}

describe('domainSpec（存储域声明，契约 docs/temp/08-storage.md）', () => {
  it('域名 script_orchestrator、版本 1、per-record、backup-and-skip、两张表、省略 global', () => {
    expect(domainSpec.name).toBe('script_orchestrator')
    expect(domainSpec.version).toBe(1)
    expect(domainSpec.layout).toBe('per-record')
    expect(domainSpec.invalidRecords).toBe('backup-and-skip')
    expect(Object.keys(domainSpec.tables).sort()).toEqual(['orchestrations', 'runs'])
    expect('global' in domainSpec).toBe(false)
  })

  it('编排记录 schema 按实际形状收紧（票 25 起）：完整记录通过，骨架/多余字段/坏形状被拒（→ 宿主 backup-and-skip）', () => {
    const orch = domainSpec.tables.orchestrations.valueSchema
    expect(typeof orch.parse).toBe('function')
    const good = {
      id: 'nightly-check',
      title: '夜间部署巡检',
      enabled: true,
      overlap: 'skip',
      trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-rate' },
      script: { command: 'pwsh', args: ['-File', 'check.ps1'], env: {}, timeoutSeconds: 300 },
      judge: {
        rules: [{ when: { exitCode: 0 }, actions: ['emit-ok'] }],
        fallback: [],
      },
      actions: { 'emit-ok': { kind: 'event', name: 'deploy-ok' } },
      createdAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
      status: 'active',
      nextOccurrence: '2026-11-09T00:05:00.000Z',
    }
    expect(orch.parse(good)).toEqual(good)
    // cron 形状在读侧同样接受（域版本 1 的存储契约；创建路径属票 27）
    expect(() =>
      orch.parse({ ...good, trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' }, nextOccurrence: null }),
    ).not.toThrow()
    // 票 24 时代的最小骨架记录（只有 id/title/status）按坏记录处置
    expect(() => orch.parse({ id: 'x', title: '骨架', status: 'active' })).toThrow()
    // 多余字段 / 坏形状
    expect(() => orch.parse({ ...good, extra: 1 })).toThrow()
    expect(() => orch.parse({ ...good, status: 'running' })).toThrow()
    expect(() => orch.parse({ ...good, trigger: { kind: 'every', everySeconds: 30, mode: 'fixed-rate' } })).toThrow()
    expect(() => orch.parse({ ...good, actions: { bad: { kind: 'event', name: 'x', extra: 1 } } })).toThrow()
    // runs 表自票 26 起按两写实际形状收紧（完整断言见下方「run 记录 schema」组）
    const runs = domainSpec.tables.runs.valueSchema
    expect(() => runs.parse({ runId: 'run-1' })).toThrow()
  })

  it('对齐：service.create 写入的记录恰好通过编排记录 schema（写入前 parse 的读侧等价）', async () => {
    const storage = await openStorage({ openDomain: async () => fakeDomain(), logger: null })
    const service = createManagementService({
      storage,
      queue: new ServiceQueue(),
      config: { maxRunsPerOrchestration: 100 },
      now: () => 1_790_000_000_000,
      emit: () => {},
    })
    const view = await service.create({
      title: 'log rotate',
      trigger: { kind: 'every', everySeconds: 90, mode: 'fixed-delay' },
      script: { command: 'pwsh', args: ['-File', 'r.ps1'], cwd: 'D:\\logs', env: { A: '1' }, timeoutSeconds: 120 },
      judge: { rules: [{ when: { exitCode: { not: 0 } }, actions: ['emit-bad'] }] },
      actions: { 'emit-bad': { kind: 'session', mode: 'ephemeral', prompt: 'p', idleDisposeSeconds: 0 } },
      enabled: false,
    })
    expect(() => domainSpec.tables.orchestrations.valueSchema.parse(view)).not.toThrow()
  })

  it('对齐（cron，票 27）：service.create 写入的 cron 记录（含 ended 状态）恰好通过编排记录 schema', async () => {
    const storage = await openStorage({ openDomain: async () => fakeDomain(), logger: null })
    const service = createManagementService({
      storage,
      queue: new ServiceQueue(),
      config: { maxRunsPerOrchestration: 100 },
      now: () => 1_790_000_000_000,
      emit: () => {},
    })
    const active = await service.create({
      title: 'nightly check',
      trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' },
      script: { command: 'pwsh' },
      judge: { rules: [], fallback: [] },
      actions: {},
    })
    expect(active.trigger).toEqual({ kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' })
    expect(() => domainSpec.tables.orchestrations.valueSchema.parse(active)).not.toThrow()
    // cron 编排 run（trigger: 'cron'）也须通过 run schema（自动执行的持久化形状）
    expect(() =>
      domainSpec.tables.runs.valueSchema.parse({
        runId: 'run-7f3c1a9e',
        orchestrationId: active.id,
        trigger: 'cron',
        scheduledAt: '2026-09-21T19:00:00.000Z',
        startedAt: null,
        settledAt: null,
        status: 'queued',
        skipReason: null,
        script: { command: 'pwsh', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', truncated: false },
        matchedRule: null,
        usedFallback: false,
        actions: [],
      }),
    ).not.toThrow()
  })
})

describe('openStorage（打开与键校验）', () => {
  it('键 = id/runId 的记录保留；不一致的记录按坏记录移除并记日志', async () => {
    const goodRun = {
      runId: 'run-1a2b3c4d',
      orchestrationId: 'orch-a',
      trigger: 'manual',
      scheduledAt: '2026-11-09T00:00:00.000Z',
      startedAt: '2026-11-09T00:00:00.100Z',
      settledAt: '2026-11-09T00:00:01.000Z',
      status: 'succeeded', // 终态：启动维护不触碰（焦点保持在键校验）
      skipReason: null,
      script: { command: 'pwsh', exitCode: 0, signal: null, timedOut: false, durationMs: 900, stdoutTail: '', stderrTail: '', truncated: false },
      matchedRule: null,
      usedFallback: false,
      actions: [],
    }
    const domain = fakeDomain({
      orchestrations: [
        ['orch-a', { id: 'orch-a', title: '好的' }],
        ['orch-bad', { id: 'orch-other' }],
      ],
      runs: [
        ['run-1a2b3c4d', goodRun],
        ['run-bad', { runId: 'run-zzz' }],
      ],
    })
    const errors = []
    const storage = await openStorage({
      openDomain: async (spec) => {
        expect(spec).toBe(domainSpec)
        return domain
      },
      logger: { error: (msg) => errors.push(msg) },
    })
    expect(domain.snapshot()).toEqual({
      orchestrations: { 'orch-a': { id: 'orch-a', title: '好的' } },
      runs: { 'run-1a2b3c4d': goodRun },
    })
    expect(domain.log.deleted).toEqual([
      ['orchestrations', 'orch-bad'],
      ['runs', 'run-bad'],
    ])
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain('orch-bad')
  })

  it('close() 委托 domain.close()（幂等性由 domain 层保证）', async () => {
    const domain = fakeDomain()
    const storage = await openStorage({ openDomain: async () => domain, logger: null })
    await storage.close()
    expect(domain.log.closed).toBe(1)
  })
})

describe('run 记录 schema（契约 08「执行记录」：run 全部字段，票 26 两写落地时收紧）', () => {
  const goodRun = () => ({
    runId: 'run-7f3c1a9e',
    orchestrationId: 'nightly-check',
    trigger: 'every',
    scheduledAt: '2026-11-09T00:05:00.000Z',
    startedAt: '2026-11-09T00:05:00.100Z',
    settledAt: '2026-11-09T00:05:02.300Z',
    status: 'succeeded',
    skipReason: null,
    script: {
      command: 'pwsh',
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 2200,
      stdoutTail: 'ok',
      stderrTail: '',
      truncated: false,
      stdoutSpillPath: 'C:\\Temp\\dsh-subprocess-x\\a-stdout.log',
      warnings: ['descendants-terminated'],
    },
    matchedRule: 0,
    usedFallback: false,
    actions: [],
  })

  it('完整结算记录通过（含可选 spill/warnings）；缺省可选字段同样通过', () => {
    const runs = domainSpec.tables.runs.valueSchema
    expect(runs.parse(goodRun())).toEqual(goodRun())
    const minimal = goodRun()
    delete minimal.script.stdoutSpillPath
    delete minimal.script.warnings
    expect(() => runs.parse(minimal)).not.toThrow()
  })

  it('skipped / queued / interrupted 形状通过（skipReason、未启动的空 script 壳）', () => {
    const runs = domainSpec.tables.runs.valueSchema
    const skipped = {
      ...goodRun(),
      status: 'skipped',
      skipReason: 'overlap',
      startedAt: null,
      settledAt: '2026-11-09T00:05:00.050Z',
      script: { command: 'pwsh', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', truncated: false },
      matchedRule: null,
      usedFallback: false,
    }
    expect(() => runs.parse(skipped)).not.toThrow()
  })

  it('票 30 动作结果形状通过：succeeded 带_warnings、failed 带 error、skipped（dispatching 取消的剩余动作）', () => {
    const runs = domainSpec.tables.runs.valueSchema
    const dispatched = goodRun()
    dispatched.status = 'partial'
    dispatched.actions = [
      { name: 'emit-ok', kind: 'event', status: 'succeeded', warnings: ['unknown variable: {{nope}}'] },
      { name: 'page', kind: 'plugin', status: 'failed', error: { code: 'unknown_action', message: '注册动作 ops.oncall 未注册' }, warnings: ['json path missing: $.x'] },
      { name: 'emit-late', kind: 'event', status: 'skipped' },
    ]
    expect(() => runs.parse(dispatched)).not.toThrow()
  })

  it('坏形状被拒（→ 宿主 backup-and-skip）：状态枚举外、缺必填、多余字段、动作结果缺键', () => {
    const runs = domainSpec.tables.runs.valueSchema
    expect(() => runs.parse({ ...goodRun(), status: 'exploded' })).toThrow()
    expect(() => runs.parse({ runId: 'run-1' })).toThrow()
    expect(() => runs.parse({ ...goodRun(), extra: 1 })).toThrow()
    expect(() =>
      runs.parse({ ...goodRun(), actions: [{ name: 'a', kind: 'event', status: 'succeeded', oops: 1 }] }),
    ).toThrow()
  })

  it('对齐：runner 两写产出的记录恰好通过 schema（queued 创建写与 succeeded 结算写）', async () => {
    // 见 runner.test 的行为断言；此处校验 schema 对象本身由 runner 的记录形状驱动
    const runs = domainSpec.tables.runs.valueSchema
    expect(() =>
      runs.parse({
        ...goodRun(),
        status: 'queued',
        startedAt: null,
        settledAt: null,
        script: { command: 'pwsh', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', truncated: false },
      }),
    ).not.toThrow()
  })
})

describe('启动维护（契约 03「重启与崩溃」+ 08「启动维护」①；孤儿清理/保留对账属票 35）', () => {
  const NOW = 1_790_000_000_000
  const iso = (ms) => new Date(ms).toISOString()

  const pendingRun = (id, orchestrationId, over = {}) => ({
    runId: id,
    orchestrationId,
    trigger: 'every',
    scheduledAt: iso(NOW - 60_000),
    startedAt: iso(NOW - 59_000),
    settledAt: null,
    status: 'running',
    skipReason: null,
    script: { command: 'pwsh', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', truncated: false },
    matchedRule: null,
    usedFallback: false,
    actions: [],
    ...over,
  })

  it('非终态 run 统一标 interrupted（维护写不计两写）、发 run-settled(interrupted)、不自动重放', async () => {
    const domain = fakeDomain({
      orchestrations: [['fixed', {
        id: 'fixed',
        title: 'f',
        enabled: true,
        overlap: 'skip',
        trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-rate' },
        script: { command: 'pwsh', args: [], env: {} },
        judge: { rules: [], fallback: [] },
        actions: {},
        createdAt: iso(NOW - 3600_000),
        updatedAt: iso(NOW - 3600_000),
        status: 'active',
        nextOccurrence: iso(NOW + 240_000),
      }]],
      runs: [
        ['run-aaaaaaaa', pendingRun('run-aaaaaaaa', 'fixed')],
        ['run-bbbbbbbb', pendingRun('run-bbbbbbbb', 'fixed', { status: 'queued', startedAt: null })],
      ],
    })
    const emitted = []
    const storage = await openStorage({
      openDomain: async () => domain,
      logger: null,
      emit: (name, payload) => emitted.push([name, payload]),
      now: () => NOW,
    })
    const { runs } = domain.snapshot()
    expect(runs['run-aaaaaaaa']).toMatchObject({ status: 'interrupted', settledAt: iso(NOW) })
    expect(runs['run-bbbbbbbb']).toMatchObject({ status: 'interrupted', settledAt: iso(NOW) })
    const settledEvents = emitted.filter(([name]) => name === 'script-orchestrator/run-settled')
    expect(settledEvents).toHaveLength(2)
    expect(settledEvents.map(([, payload]) => payload.status)).toEqual(['interrupted', 'interrupted'])
  })

  it('fixed-delay 编排的 interrupted 自动 run 以恢复结算时刻推进序列（不额外立即补跑）', async () => {
    const domain = fakeDomain({
      orchestrations: [['delayed', {
        id: 'delayed',
        title: 'd',
        enabled: true,
        overlap: 'skip',
        trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' },
        script: { command: 'pwsh', args: [], env: {} },
        judge: { rules: [], fallback: [] },
        actions: {},
        createdAt: iso(NOW - 3600_000),
        updatedAt: iso(NOW - 3600_000),
        status: 'active',
        nextOccurrence: null,
      }]],
      runs: [['run-cccccccc', pendingRun('run-cccccccc', 'delayed')]],
    })
    const emitted = []
    await openStorage({
      openDomain: async () => domain,
      logger: null,
      emit: (name, payload) => emitted.push([name, payload]),
      now: () => NOW,
    })
    expect(domain.snapshot().orchestrations.delayed.nextOccurrence).toBe(iso(NOW + 300_000))
    expect(emitted.some(([name]) => name === 'script-orchestrator/changed')).toBe(true)
  })

  it('paused 编排 / 手动 run 的 interrupted 不推进序列；终态 run 原样保留', async () => {
    const domain = fakeDomain({
      orchestrations: [['delayed', {
        id: 'delayed',
        title: 'd',
        enabled: true,
        overlap: 'skip',
        trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' },
        script: { command: 'pwsh', args: [], env: {} },
        judge: { rules: [], fallback: [] },
        actions: {},
        createdAt: iso(NOW - 3600_000),
        updatedAt: iso(NOW - 3600_000),
        status: 'paused',
        nextOccurrence: null,
      }]],
      runs: [
        ['run-dddddddd', pendingRun('run-dddddddd', 'delayed')],
        ['run-eeeeeeee', pendingRun('run-eeeeeeee', 'delayed', { trigger: 'manual' })],
        ['run-ffffffff', pendingRun('run-ffffffff', 'delayed', { status: 'succeeded', settledAt: iso(NOW - 1000) })],
      ],
    })
    await openStorage({
      openDomain: async () => domain,
      logger: null,
      emit: () => {},
      now: () => NOW,
    })
    const { orchestrations, runs } = domain.snapshot()
    expect(orchestrations.delayed.nextOccurrence).toBeNull() // paused 不推进
    expect(runs['run-dddddddd']).toMatchObject({ status: 'interrupted' })
    expect(runs['run-eeeeeeee']).toMatchObject({ status: 'interrupted' })
    expect(runs['run-ffffffff']).toMatchObject({ status: 'succeeded', settledAt: iso(NOW - 1000) }) // 终态原样
  })
})
