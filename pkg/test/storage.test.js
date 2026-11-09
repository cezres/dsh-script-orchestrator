import { describe, it, expect, vi } from 'vitest'
import { domainSpec, openStorage } from '../lib/storage.js'
import { createManagementService } from '../lib/service.js'
import { createRunner } from '../lib/runner.js'
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

describe('写入前显式 schema 校验（契约 08「写入」：插件 parse、Domain 运行期不复验）', () => {
  it('坏形状 → internal_error + error 日志；不落库、不触发关闭-重开（不是 I/O 失败）', async () => {
    const domain = fakeDomain()
    const logs = []
    const storage = await openStorage({
      openDomain: async () => domain,
      logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
    })
    await expect(
      storage.table('orchestrations').put('bad', { id: 'bad', title: '', status: 'active' }),
    ).rejects.toMatchObject({ code: 'internal_error', details: { table: 'orchestrations', key: 'bad' } })
    await expect(
      storage.table('runs').put('run-bbbbbbbb', { runId: 'run-bbbbbbbb' }),
    ).rejects.toMatchObject({ code: 'internal_error', details: { table: 'runs', key: 'run-bbbbbbbb' } })
    expect(domain.snapshot()).toEqual({ orchestrations: {}, runs: {} }) // 一条都未落库
    expect(domain.log.closed).toBe(0) // 不走 I/O 恢复（关闭-重开）
    expect(storage.isRecovering()).toBe(false)
    expect(logs.some((m) => m.includes('schema 校验失败') && m.includes('orchestrations'))).toBe(true)
    expect(logs.some((m) => m.includes('schema 校验失败') && m.includes('runs'))).toBe(true)
    await storage.close()
  })

  it('正常路径不误报：编排 active/paused/ended 写入与 run 两写都通过写入前 parse', async () => {
    const domain = fakeDomain()
    const storage = await openStorage({ openDomain: async () => domain, logger: { error: () => {}, warn: () => {} } })
    const now = 1_790_000_000_000
    const service = createManagementService({
      storage,
      queue: new ServiceQueue(),
      config: { maxRunsPerOrchestration: 100 },
      now: () => now,
      emit: () => {},
    })
    const created = await service.create({
      id: 'nightly-check',
      title: 'log rotate',
      trigger: { kind: 'every', everySeconds: 90, mode: 'fixed-rate' },
      script: { command: 'pwsh', args: ['-File', 'r.ps1'], env: {}, timeoutSeconds: 120 },
      judge: { rules: [{ when: { exitCode: { not: 0 } }, actions: ['emit-bad'] }] },
      actions: { 'emit-bad': { kind: 'event', name: 'bad' } },
    })
    expect(created.status).toBe('active')
    // 状态写入：paused（enabled:false）与 active（enabled:true）都须通过 parse
    const paused = await service.edit({ id: 'nightly-check', action: 'pause' })
    expect(paused).toMatchObject({ status: 'paused', enabled: false })
    const resumed = await service.edit({ id: 'nightly-check', action: 'resume' })
    expect(resumed.status).toBe('active')

    // run 两写（queued 创建 + succeeded 结算）经同一写入门面
    const runner = createRunner({
      storage,
      queue: new ServiceQueue(),
      subprocess: {
        spawn: () => ({
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate: () => {},
          waitForExit: () => Promise.resolve(true),
          collected: {
            stdout: { readFrom: () => ({ text: 'ok', lossy: false, nextOffset: 0 }) },
            stderr: { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) },
          },
        }),
      },
      config: {
        maxConcurrentRuns: 2,
        defaultTimeoutSeconds: 300,
        maxOutputBytes: 262144,
        maxSpillBytes: 0,
        allowedRoots: [],
        maxRunsPerOrchestration: 100,
      },
      emit: () => {},
      now: () => now,
      fs: { stat: async () => ({ isDirectory: () => true }) },
      hostCwd: 'D:\\work',
    })
    const runView = await runner.requestRun({ orchestrationId: 'nightly-check', trigger: 'every', scheduledAtMs: now })
    await runner.waitIdle()
    expect(storage.table('runs').get(runView.runId)).toMatchObject({ status: 'succeeded' })

    // ended 防御终态写入（运行期无解的落点形状）
    await storage.table('orchestrations').put('nightly-check', { ...resumed, status: 'ended', nextOccurrence: null })
    expect(storage.table('orchestrations').get('nightly-check').status).toBe('ended')
    expect(domain.log.closed).toBe(0) // 全程未触发恢复
    await storage.close()
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

// ---------------- 票 35：启动维护②③、坏记录、I/O 结果未知的恢复 ----------------

const NOW35 = 1_790_000_000_000
const iso35 = (ms = NOW35) => new Date(ms).toISOString()

function makeOrchestration35(id) {
  return {
    id,
    title: id,
    enabled: true,
    overlap: 'skip',
    trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-rate' },
    script: { command: 'pwsh', args: [], env: {} },
    judge: { rules: [], fallback: [] },
    actions: {},
    createdAt: iso35(),
    updatedAt: iso35(),
    status: 'active',
    nextOccurrence: null,
  }
}

function makeSettledRun35(runId, orchestrationId, settledMs, extra = {}) {
  return {
    runId,
    orchestrationId,
    trigger: 'every',
    scheduledAt: iso35(settledMs - 1000),
    startedAt: iso35(settledMs - 1000),
    settledAt: iso35(settledMs),
    status: 'succeeded',
    skipReason: null,
    script: {
      command: 'pwsh',
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1000,
      stdoutTail: '',
      stderrTail: '',
      truncated: false,
    },
    matchedRule: null,
    usedFallback: false,
    actions: [],
    ...extra,
  }
}

function makeRecoverableDomain({ orchestrations = [], runs = [], rejectRunsPut = 0 } = {}) {
  const tables = { orchestrations: new Map(orchestrations), runs: new Map(runs) }
  const log = { closed: 0, puts: 0, deletes: [] }
  let remainingFailures = rejectRunsPut
  const domain = {
    name: 'script_orchestrator',
    table: (name) => ({
      entries: () => tables[name].entries(),
      get: (key) => tables[name].get(key),
      put: (key, value) => {
        log.puts += 1
        if (name === 'runs' && remainingFailures > 0) {
          remainingFailures -= 1
          return Promise.reject(new Error('EACCES: write rejected'))
        }
        tables[name].set(key, value)
        return Promise.resolve()
      },
      delete: (key) => {
        log.deletes.push([name, key])
        tables[name].delete(key)
        return Promise.resolve()
      },
    }),
    close: () => {
      log.closed += 1
      return Promise.resolve()
    },
    snapshot: () => ({ orchestrations: Object.fromEntries(tables.orchestrations), runs: Object.fromEntries(tables.runs) }),
    log,
  }
  return { domain, log, setRunsPutFailures: (count) => { remainingFailures = count } }
}

describe('启动维护②孤儿清理与③保留对账（票 35；契约 08「启动维护」）', () => {
  it('孤儿清理：删除 orchestrationId 无父记录的全部 run（含未结算）；有父保留；重开幂等', async () => {
    const parent = makeOrchestration35('o1')
    const runWithParent = makeSettledRun35('run-aaaaaaaa', 'o1', NOW35)
    const orphanSettled = makeSettledRun35('run-bbbbbbbb', 'ghost', NOW35)
    const orphanUnsettled = {
      ...makeSettledRun35('run-cccccccc', 'ghost', NOW35),
      status: 'running',
      settledAt: null,
      startedAt: iso35(),
    }
    const repo = makeRecoverableDomain({
      orchestrations: [['o1', parent]],
      runs: [
        ['run-aaaaaaaa', runWithParent],
        ['run-bbbbbbbb', orphanSettled],
        ['run-cccccccc', orphanUnsettled],
      ],
    })
    const logs = []
    const opened = []
    const storage = await openStorage({
      openDomain: async () => {
        opened.push(1)
        return repo.domain
      },
      logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
      NOW35: () => NOW35,
      config: { maxRunsPerOrchestration: 100 },
    })
    const snapshot = repo.domain.snapshot()
    expect(Object.keys(snapshot.runs)).toEqual(['run-aaaaaaaa']) // 两个孤儿被清理
    expect(snapshot.orchestrations.o1).toBeTruthy()
    expect(logs.some((m) => m.includes('孤儿清理') && m.includes('run-bbbbbbbb'))).toBe(true)
    expect(logs.some((m) => m.includes('孤儿清理') && m.includes('run-cccccccc'))).toBe(true)

    // 重开（同一域数据）→ 幂等：无孤儿可删、有父记录不受影响
    await storage.close()
    const again = await openStorage({
      openDomain: async () => repo.domain,
      logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
      NOW35: () => NOW35,
      config: { maxRunsPerOrchestration: 100 },
    })
    expect(Object.keys(repo.domain.snapshot().runs)).toEqual(['run-aaaaaaaa'])
    await again.close()
  })

  it('保留对账：超每编排上限补裁（settledAt 定序），未结算 run 保护；启动后即收敛', async () => {
    const parent = makeOrchestration35('o1')
    const runs = [
      ['run-11111111', makeSettledRun35('run-11111111', 'o1', NOW35 - 4000)],
      ['run-22222222', makeSettledRun35('run-22222222', 'o1', NOW35 - 3000)],
      ['run-33333333', makeSettledRun35('run-33333333', 'o1', NOW35 - 2000)],
      ['run-44444444', makeSettledRun35('run-44444444', 'o1', NOW35 - 1000)],
      [
        'run-55555555',
        {
          ...makeSettledRun35('run-55555555', 'o1', NOW35),
          status: 'running',
          settledAt: null,
          startedAt: iso35(),
        },
      ],
    ]
    const repo = makeRecoverableDomain({ orchestrations: [['o1', parent]], runs })
    const logs = []
    const storage = await openStorage({
      openDomain: async () => repo.domain,
      logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
      NOW35: () => NOW35,
      config: { maxRunsPerOrchestration: 2 },
    })
    const remaining = Object.keys(repo.domain.snapshot().runs).sort()
    // 启动维护①：原 running run-55555555 先被标 interrupted（settledAt=恢复时刻），
    // 随后②保留对账按 settledAt 定序补裁到每编排 2 条 → 保留最新的
    // run-44444444 与 run-55555555（interrupted）；更早的三条被裁。
    //（「未结算 run 不淘汰」的纯规则由 retention.test 覆盖——启动维护会把非终态先收敛）
    expect(remaining).toEqual(['run-44444444', 'run-55555555'])
    expect(logs.some((m) => m.includes('保留对账补裁'))).toBe(true)
    await storage.close()
  })

  it('坏记录（两类）：键≠id 由插件写链移除并记日志；宿主 schema 坏记录（畸形 JSON/不可读/版本不接受）在 entries 缺席即视为不存在——打开不崩、只服务有效记录', async () => {
    const good = makeOrchestration35('good-orch')
    const keyMismatch = makeOrchestration35('real-id')
    // 宿主语义：schema 坏记录由 domain 层 backup-and-skip，entries 中不出现（fake 只给有效记录）
    const repo = makeRecoverableDomain({ orchestrations: [['good-orch', good], ['wrong-key', keyMismatch]], runs: [] })
    const logs = []
    const storage = await openStorage({
      openDomain: async () => repo.domain,
      logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
      NOW35: () => NOW35,
      config: { maxRunsPerOrchestration: 100 },
    })
    // 键≠id：坏记录移除 + 日志
    expect(repo.domain.snapshot().orchestrations['wrong-key']).toBeUndefined()
    expect(logs.some((m) => m.includes("记录键 'wrong-key'"))).toBe(true)
    // 服务只看到有效记录（坏记录缺席）
    const service = createManagementService({
      storage,
      queue: new ServiceQueue(),
      config: { maxRunsPerOrchestration: 100 },
      NOW35: () => NOW35,
      logger: { error: () => {}, warn: () => {} },
    })
    const listed = await service.list({})
    expect(listed.items.map((o) => o.id)).toEqual(['good-orch'])
    // 未知（缺席）记录：view 明确 script_unknown，而不是崩溃
    await expect(service.view('bad-json-record')).rejects.toMatchObject({ code: 'script_unknown' })
    await storage.close()
  })
})

describe('I/O 结果未知的恢复（票 35；契约 08「I/O 结果未知的恢复」）', () => {
  it('写入被拒 → script_storage_unavailable（当前写不重试）→ 关闭旧域 → 重开 → 启动对账重跑 → onRecovered → 继续服务', async () => {
    const first = makeRecoverableDomain({
      orchestrations: [['o1', makeOrchestration35('o1')]],
      rejectRunsPut: 1,
    })
    const second = makeRecoverableDomain({ orchestrations: [['o1', makeOrchestration35('o1')]] })
    const opened = []
    const recovered = []
    const logs = []
    const storage = await openStorage({
      openDomain: async () => {
        opened.push(1)
        return opened.length === 1 ? first.domain : second.domain
      },
      logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
      NOW35: () => NOW35,
      config: { maxRunsPerOrchestration: 100 },
      onRecovered: () => recovered.push('onRecovered'),
    })

    const failedWrite = storage.table('runs').put('run-aaaaaaaa', makeSettledRun35('run-aaaaaaaa', 'o1', NOW35))
    await expect(failedWrite).rejects.toMatchObject({
      code: 'script_storage_unavailable',
      details: { cause: 'EACCES: write rejected' },
    })
    // 恢复流程：关闭旧域 → 重开 → 启动对账 → onRecovered（不盲目重试当前写）
    await vi.waitFor(() => {
      expect(storage.isRecovering()).toBe(false)
      expect(recovered).toHaveLength(1)
    })
    expect(first.log.closed).toBe(1)
    expect(first.log.puts).toBe(1) // 被拒的写只发生一次（不重试）
    expect(opened).toHaveLength(2) // 第二次 open = 重开
    // 恢复后服务照常（新域写入与读取）
    await storage.table('orchestrations').put('o2', makeOrchestration35('o2'))
    expect(storage.table('orchestrations').get('o2')).toBeTruthy()
    await storage.close()
  })

  it('恢复期间到达的管理操作以 script_storage_unavailable 失败；恢复完成后恢复', async () => {
    const first = makeRecoverableDomain({ rejectRunsPut: 1 })
    const second = makeRecoverableDomain()
    const gate = Promise.withResolvers()
    const logs = []
    let openCount = 0
    const storage = await openStorage({
      openDomain: async () => {
        openCount += 1
        if (openCount === 1) return first.domain
        await gate.promise // 恢复中：重开挂起，暴露 recovering 窗口
        return second.domain
      },
      logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
      NOW35: () => NOW35,
      config: { maxRunsPerOrchestration: 100 },
    })
    await expect(storage.table('runs').put('run-aaaaaaaa', makeSettledRun35('run-aaaaaaaa', 'o1', NOW35))).rejects.toMatchObject({
      code: 'script_storage_unavailable',
    })
    await vi.waitFor(() => expect(storage.isRecovering()).toBe(true))
    // 恢复期间：读与写都明确失败（不静默返回空视图）
    expect(() => storage.table('orchestrations').entries()).toThrow(
      expect.objectContaining({ code: 'script_storage_unavailable', details: { cause: 'recovering' } }),
    )
    await expect(storage.table('runs').put('run-bbbbbbbb', makeSettledRun35('run-bbbbbbbb', 'o1', NOW35))).rejects.toMatchObject({
      code: 'script_storage_unavailable',
      details: { cause: 'recovering' },
    })
    gate.resolve()
    await vi.waitFor(() => expect(storage.isRecovering()).toBe(false))
    // 恢复完成：读写恢复（新域为空，恢复后写入可见）
    await storage.table('runs').put('run-cccccccc', makeSettledRun35('run-cccccccc', 'o1', NOW35))
    expect(storage.table('runs').get('run-cccccccc')).toBeTruthy()
    await storage.close()
  })

  it('重开失败 → 保持不可用（broken）：后续操作持续以 script_storage_unavailable 失败并记日志', async () => {
    const first = makeRecoverableDomain({ rejectRunsPut: 1 })
    const logs = []
    let openCount = 0
    const storage = await openStorage({
      openDomain: async () => {
        openCount += 1
        if (openCount === 1) return first.domain
        throw new Error('EIO: reopen failed')
      },
      logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
      NOW35: () => NOW35,
      config: { maxRunsPerOrchestration: 100 },
    })
    await expect(storage.table('runs').put('run-aaaaaaaa', makeSettledRun35('run-aaaaaaaa', 'o1', NOW35))).rejects.toMatchObject({
      code: 'script_storage_unavailable',
    })
    await vi.waitFor(() => {
      expect(logs.some((m) => m.includes('重开失败'))).toBe(true)
      expect(storage.isRecovering()).toBe(true) // broken 态保持不可用
    })
    await expect(storage.table('runs').put('run-bbbbbbbb', makeSettledRun35('run-bbbbbbbb', 'o1', NOW35))).rejects.toMatchObject({
      code: 'script_storage_unavailable',
      details: { cause: 'unavailable' },
    })
  })
})
