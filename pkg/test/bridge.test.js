import { describe, it, expect } from 'vitest'
import { createBridgeHandler } from '../lib/bridge.js'

function fakeService(over = {}) {
  return {
    list: over.list ?? (async () => ({ items: [], total: 0, nextOffset: null })),
    ...over,
  }
}

describe('createBridgeHandler（/script-orchestrator 一元 RPC，契约 docs/temp/11-web-panel.md）', () => {
  it("endpoint 'list' 空查询返回服务值并包装为 { ok: true, value }", async () => {
    const handler = createBridgeHandler({ service: fakeService() })
    await expect(handler('list', undefined, undefined, {})).resolves.toEqual({
      ok: true,
      value: { items: [], total: 0, nextOffset: null },
    })
  })

  it('合法 ListQuery 原样透传给服务（零翻译 DTO）', async () => {
    const seen = []
    const handler = createBridgeHandler({
      service: fakeService({ list: async (query) => { seen.push(query); return { items: [], total: 0, nextOffset: null } } }),
    })
    await handler('list', { active: true, limit: 20, offset: 40 }, undefined, {})
    expect(seen).toEqual([{ active: true, limit: 20, offset: 40 }])
  })

  it('多余字段映射 script_input_invalid（reason: unexpected + 准确 field）', async () => {
    const handler = createBridgeHandler({ service: fakeService() })
    const result = await handler('list', { active: true, extra: 1 }, undefined, {})
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('script_input_invalid')
    expect(result.error.details).toMatchObject({ field: 'extra', reason: 'unexpected' })
  })

  it.each([
    ['active 类型错', { active: 'yes' }, 'active', 'format'],
    ['limit 越下界', { limit: 0 }, 'limit', 'range'],
    ['limit 越上界', { limit: 501 }, 'limit', 'range'],
    ['limit 非整数', { limit: 1.5 }, 'limit', 'format'],
    ['limit 类型错', { limit: '20' }, 'limit', 'format'],
    ['offset 负数', { offset: -1 }, 'offset', 'range'],
    ['offset 类型错', { offset: null }, 'offset', 'format'],
    ['payload 非 object', 'nope', 'payload', 'format'],
  ])('形状校验：%s → script_input_invalid（%s/%s）', async (_label, payload, field, reason) => {
    const handler = createBridgeHandler({ service: fakeService() })
    const result = await handler('list', payload, undefined, {})
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('script_input_invalid')
    expect(result.error.details).toMatchObject({ field, reason })
  })

  it('未实现/未知 endpoint 返回 internal_error envelope（不抛给传输层）', async () => {
    const handler = createBridgeHandler({ service: fakeService() })
    for (const endpoint of ['view', 'create', 'edit', 'run', 'listActions', 'bogus']) {
      const result = await handler(endpoint, {}, undefined, {})
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('internal_error')
      expect(result.error.message).toContain(endpoint)
    }
  })

  it('服务抛错兜底 internal_error envelope，message 保留原因', async () => {
    const handler = createBridgeHandler({
      service: fakeService({ list: async () => { throw new Error('storage exploded') } }),
    })
    const result = await handler('list', {}, undefined, {})
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('internal_error')
    expect(result.error.message).toContain('storage exploded')
  })
})
