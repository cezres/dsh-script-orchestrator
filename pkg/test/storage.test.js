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
    // runs 表保持最小骨架（完整 run 形状属票 26 两写落地时收紧）
    const runs = domainSpec.tables.runs.valueSchema
    expect(() => runs.parse({ runId: 'run-1' })).not.toThrow()
    expect(() => runs.parse({ id: '键字段错' })).toThrow()
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
})

describe('openStorage（打开与键校验）', () => {
  it('键 = id/runId 的记录保留；不一致的记录按坏记录移除并记日志', async () => {
    const domain = fakeDomain({
      orchestrations: [
        ['orch-a', { id: 'orch-a', title: '好的' }],
        ['orch-bad', { id: 'orch-other' }],
      ],
      runs: [
        ['run-1a2b3c4d', { runId: 'run-1a2b3c4d' }],
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
      runs: { 'run-1a2b3c4d': { runId: 'run-1a2b3c4d' } },
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
