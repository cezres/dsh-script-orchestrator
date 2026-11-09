// 保留裁剪（契约 docs/temp/08-storage.md「保留与裁剪」；票 34）。
// 规则：run 结算写入后同一服务槽位内顺带执行；淘汰已结算 run 中超出
// 「每编排 maxRunsPerOrchestration」或「全库 1000」的最旧者；未结算不计入淘汰、
// 不可被裁剪删除；次序 settledAt 升序、并列 runId 字典序；目标键去重后一次
// deleteMany；失败容忍暂时超限；被裁 run 的 spill 文件 best-effort unlink。
import { describe, it, expect } from 'vitest'
import { createRetentionPolicy, MAX_TOTAL_RUNS } from '../lib/retention.js'

function makeStorage() {
  const tables = { runs: new Map() }
  const deleted = []
  const deleteManyCalls = []
  let deleteManyMode = 'present' // 'present' | 'missing' | 'throw'
  return {
    table: (name) => {
      const table = {
        entries: () => tables[name].entries(),
        get: (key) => tables[name].get(key),
        put: (key, value) => {
          tables[name].set(key, value)
          return Promise.resolve()
        },
        delete: (key) => {
          deleted.push(key)
          tables[name].delete(key)
          return Promise.resolve()
        },
      }
      if (deleteManyMode === 'present' || deleteManyMode === 'throw') {
        table.deleteMany = (ids) => {
          if (deleteManyMode === 'throw') return Promise.reject(new Error('domain write rejected'))
          deleteManyCalls.push([...ids])
          for (const id of ids) tables[name].delete(id)
          return Promise.resolve()
        }
      }
      return table
    },
    seed: (runs) => {
      for (const run of runs) tables.runs.set(run.runId, run)
    },
    ids: () => [...tables.runs.keys()].sort(),
    deleted,
    deleteManyCalls,
    setDeleteManyMode: (mode) => {
      deleteManyMode = mode
    },
  }
}

const run = (runId, orchestrationId, settledAt, extra = {}) => ({
  runId,
  orchestrationId,
  status: settledAt === null ? 'running' : 'succeeded',
  settledAt,
  script: {},
  ...extra,
})

const makePolicy = (storage, over = {}) =>
  createRetentionPolicy({
    storage,
    config: { maxRunsPerOrchestration: over.maxRunsPerOrchestration ?? 100 },
    fs: over.fs,
    logger: over.logger ?? { error: () => {} },
    maxTotalRuns: over.maxTotalRuns ?? MAX_TOTAL_RUNS,
  })

describe('保留裁剪（契约 08「保留与裁剪」）', () => {
  it('未达上限：不产生任何删除', async () => {
    const storage = makeStorage()
    storage.seed([run('r1', 'a', '2026-01-01T00:00:01.000Z'), run('r2', 'a', '2026-01-01T00:00:02.000Z')])
    const result = await makePolicy(storage, { maxRunsPerOrchestration: 2 }).enforce()
    expect(result.removed).toEqual([])
    expect(storage.deleteManyCalls).toEqual([])
    expect(storage.ids()).toEqual(['r1', 'r2'])
  })

  it('每编排超限：按 settledAt 升序淘汰最旧；未结算 run 保留且不参与淘汰', async () => {
    const storage = makeStorage()
    storage.seed([
      run('old', 'a', '2026-01-01T00:00:01.000Z'),
      run('mid', 'a', '2026-01-01T00:00:02.000Z'),
      run('new', 'a', '2026-01-01T00:00:03.000Z'),
      run('live', 'a', null), // 未结算：不可淘汰
    ])
    const result = await makePolicy(storage, { maxRunsPerOrchestration: 2 }).enforce()
    expect(result.removed).toEqual(['old']) // 保留最近两个 settled（mid/new）；未结算 live 保留
    expect(storage.ids()).toEqual(['live', 'mid', 'new'])
  })

  it('settledAt 并列：按 runId 字典序决定淘汰顺序', async () => {
    const storage = makeStorage()
    const at = '2026-01-01T00:00:00.000Z'
    storage.seed([run('b', 'a', at), run('a', 'a', at), run('c', 'a', at)])
    const result = await makePolicy(storage, { maxRunsPerOrchestration: 1 }).enforce()
    expect(result.removed.sort()).toEqual(['a', 'b'])
    expect(storage.ids()).toEqual(['c'])
  })

  it('全库超限：未结算 run 计入总数但不可淘汰；只从已结算的全局最旧者淘汰', async () => {
    const storage = makeStorage()
    storage.seed([
      run('a-old', 'a', '2026-01-01T00:00:01.000Z'),
      run('a-new', 'a', '2026-01-01T00:00:02.000Z'),
      run('b-old', 'b', '2026-01-01T00:00:03.000Z'),
      run('b-live', 'b', null),
    ])
    // 总数 4 > 3；每编排上限 100 不触发，只触发全库
    const result = await makePolicy(storage, { maxRunsPerOrchestration: 100, maxTotalRuns: 3 }).enforce()
    expect(result.removed).toEqual(['a-old'])
    expect(storage.ids()).toEqual(['a-new', 'b-live', 'b-old'])
  })

  it('每编排超限与全库超限的并集去重后一次 deleteMany', async () => {
    const storage = makeStorage()
    storage.seed([
      run('a1', 'a', '2026-01-01T00:00:01.000Z'),
      run('a2', 'a', '2026-01-01T00:00:02.000Z'),
      run('a3', 'a', '2026-01-01T00:00:03.000Z'),
      run('b1', 'b', '2026-01-01T00:00:04.000Z'),
    ])
    // 每编排上限 1 → a 淘汰 a1/a2；全库上限 1 → 再淘汰 a3（并集与前者不重复）
    const result = await makePolicy(storage, { maxRunsPerOrchestration: 1, maxTotalRuns: 1 }).enforce()
    expect(storage.deleteManyCalls).toHaveLength(1) // 一次 deleteMany
    expect(storage.deleteManyCalls[0].sort()).toEqual(['a1', 'a2', 'a3'])
    expect(result.removed.sort()).toEqual(['a1', 'a2', 'a3'])
    expect(storage.ids()).toEqual(['b1'])
  })

  it('全库超限但全部未结算：无可淘汰者，容忍暂时超限', async () => {
    const storage = makeStorage()
    storage.seed([run('l1', 'a', null), run('l2', 'a', null), run('l3', 'a', null)])
    const result = await makePolicy(storage, { maxTotalRuns: 1 }).enforce()
    expect(result.removed).toEqual([])
    expect(storage.deleteManyCalls).toEqual([])
  })

  it('deleteMany 抛错：不抛出、记内部日志（容忍暂时超限）', async () => {
    const storage = makeStorage()
    storage.seed([run('old', 'a', '2026-01-01T00:00:01.000Z'), run('new', 'a', '2026-01-01T00:00:02.000Z')])
    const logs = []
    storage.setDeleteManyMode('throw')
    const result = await makePolicy(storage, { maxRunsPerOrchestration: 1, logger: { error: (m) => logs.push(m) } }).enforce()
    expect(result.removed).toEqual([])
    expect(logs.some((m) => m.includes('保留裁剪失败'))).toBe(true)
  })

  it('域表无 deleteMany 时逐键 delete（fake/旧域兼容）', async () => {
    const storage = makeStorage()
    storage.seed([run('old', 'a', '2026-01-01T00:00:01.000Z'), run('new', 'a', '2026-01-01T00:00:02.000Z')])
    storage.setDeleteManyMode('missing')
    const result = await makePolicy(storage, { maxRunsPerOrchestration: 1 }).enforce()
    expect(result.removed).toEqual(['old'])
    expect(storage.deleted).toEqual(['old'])
    expect(storage.ids()).toEqual(['new'])
  })

  it('被裁 run 的 spill 文件 best-effort unlink；unlink 失败不影响记录删除', async () => {
    const storage = makeStorage()
    storage.seed([
      run('old', 'a', '2026-01-01T00:00:01.000Z', {
        script: { stdoutSpillPath: 'C:/tmp/old-out.log', stderrSpillPath: 'C:/tmp/old-err.log' },
      }),
      run('new', 'a', '2026-01-01T00:00:02.000Z', { script: { stdoutSpillPath: 'C:/tmp/new-out.log' } }),
    ])
    const unlinked = []
    const fs = {
      unlink: async (path) => {
        if (path === 'C:/tmp/old-err.log') throw new Error('EBUSY')
        unlinked.push(path)
      },
    }
    const result = await makePolicy(storage, { maxRunsPerOrchestration: 1, fs }).enforce()
    expect(result.removed).toEqual(['old'])
    expect(unlinked).toEqual(['C:/tmp/old-out.log'])
    expect(storage.ids()).toEqual(['new'])
  })

  it('被淘汰 run 无 spill 字段时不调用 unlink', async () => {
    const storage = makeStorage()
    storage.seed([run('old', 'a', '2026-01-01T00:00:01.000Z'), run('new', 'a', '2026-01-01T00:00:02.000Z')])
    const unlinked = []
    await makePolicy(storage, { maxRunsPerOrchestration: 1, fs: { unlink: async (p) => unlinked.push(p) } }).enforce()
    expect(unlinked).toEqual([])
  })
})
