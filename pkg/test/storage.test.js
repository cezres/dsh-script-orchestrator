import { describe, it, expect } from 'vitest'
import { domainSpec, openStorage } from '../lib/storage.js'

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
