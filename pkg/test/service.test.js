import { describe, it, expect } from 'vitest'
import { createManagementService } from '../lib/service.js'

function fakeStorage(orchestrations = []) {
  const map = new Map(orchestrations)
  return {
    table: (name) => ({
      entries: () => map.entries(),
      get: (key) => map.get(key),
    }),
    _map: map,
  }
}

describe('createManagementService().list（契约 docs/temp/06-events-service.md）', () => {
  it('空存储返回 { items: [], total: 0, nextOffset: null }', async () => {
    const service = createManagementService({ storage: fakeStorage(), queue: null, config: null })
    await expect(service.list()).resolves.toEqual({ items: [], total: 0, nextOffset: null })
    await expect(service.list({})).resolves.toEqual({ items: [], total: 0, nextOffset: null })
  })

  const rows = [
    { id: 'b-second', status: 'active' },
    { id: 'a-first', status: 'paused' },
    { id: 'c-third', status: 'active' },
    { id: 'd-ended', status: 'ended' },
  ]

  it('active 过滤：true → active；false → paused/ended；省略 → 全部；按 id 稳定排序', async () => {
    const service = createManagementService({ storage: fakeStorage(rows.map((r) => [r.id, r])), queue: null, config: null })
    const all = await service.list()
    expect(all.items.map((o) => o.id)).toEqual(['a-first', 'b-second', 'c-third', 'd-ended'])
    expect(all.total).toBe(4)
    const act = await service.list({ active: true })
    expect(act.items.map((o) => o.id)).toEqual(['b-second', 'c-third'])
    expect(act.total).toBe(2)
    const inact = await service.list({ active: false })
    expect(inact.items.map((o) => o.id)).toEqual(['a-first', 'd-ended'])
    expect(inact.total).toBe(2)
  })

  it('分页与 nextOffset：未取尽给 offset+items.length，取尽为 null', async () => {
    const service = createManagementService({ storage: fakeStorage(rows.map((r) => [r.id, r])), queue: null, config: null })
    const page1 = await service.list({ limit: 2, offset: 0 })
    expect(page1.items.map((o) => o.id)).toEqual(['a-first', 'b-second'])
    expect(page1.total).toBe(4)
    expect(page1.nextOffset).toBe(2)
    const page2 = await service.list({ limit: 2, offset: 2 })
    expect(page2.items.map((o) => o.id)).toEqual(['c-third', 'd-ended'])
    expect(page2.nextOffset).toBeNull()
    const beyond = await service.list({ limit: 2, offset: 4 })
    expect(beyond.items).toEqual([])
    expect(beyond.nextOffset).toBeNull()
  })

})
