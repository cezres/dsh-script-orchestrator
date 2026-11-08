import { describe, it, expect, vi } from 'vitest'
import { createBridgeHandler, mountBridge } from '../lib/bridge.js'
import { OrchestratorError } from '../lib/errors.js'

const SAMPLE_VIEW = {
  id: 'log-rotate',
  title: 'log rotate',
  enabled: true,
  overlap: 'skip',
  trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-rate' },
  script: { command: 'pwsh', args: [], env: {} },
  judge: { rules: [], fallback: [] },
  actions: {},
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  status: 'active',
  nextOccurrence: '2026-11-09T00:05:00.000Z',
}

const sampleCreateInput = () => ({
  title: 'log rotate',
  trigger: { kind: 'every', everySeconds: 300 },
  script: { command: 'pwsh' },
  judge: { rules: [], fallback: [] },
  actions: {},
})

function fakeService(over = {}) {
  return {
    list: over.list ?? (async () => ({ items: [], total: 0, nextOffset: null })),
    create: over.create ?? (async () => ({ ...SAMPLE_VIEW })),
    view: over.view ?? (async () => ({ ...SAMPLE_VIEW, runs: [], availableActions: [] })),
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
    for (const endpoint of ['edit', 'run', 'listActions', 'bogus']) {
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

describe('create 端点（最小形状校验 + 零翻译 DTO + 契约错误透传）', () => {
  it('合法输入原样透传 service.create，返回 { ok: true, value: OrchestrationView }', async () => {
    const seen = []
    const handler = createBridgeHandler({
      service: fakeService({ create: async (input) => { seen.push(input); return { ...SAMPLE_VIEW } } }),
    })
    const input = sampleCreateInput()
    const result = await handler('create', input, undefined, {})
    expect(seen).toEqual([input])
    expect(result).toEqual({ ok: true, value: SAMPLE_VIEW })
  })

  it.each([
    ['payload 非对象', 'nope', 'payload', 'format'],
    ['缺 title', (() => { const i = sampleCreateInput(); delete i.title; return i })(), 'title', 'missing'],
    ['顶层多余字段', { ...sampleCreateInput(), extra: 1 }, 'extra', 'unexpected'],
    ['title 非字符串', { ...sampleCreateInput(), title: 42 }, 'title', 'format'],
    ['trigger 非对象', { ...sampleCreateInput(), trigger: 'every' }, 'trigger', 'format'],
    ['enabled 非布尔', { ...sampleCreateInput(), enabled: 'yes' }, 'enabled', 'format'],
  ])('最小形状校验：%s → script_input_invalid（%s/%s）', async (_label, payload, field, reason) => {
    const handler = createBridgeHandler({ service: fakeService() })
    const result = await handler('create', payload, undefined, {})
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('script_input_invalid')
    expect(result.error.details).toMatchObject({ field, reason })
  })

  it('深层语义由服务判定：服务契约错误原样透传（不升级 internal_error）', async () => {
    const handler = createBridgeHandler({
      service: fakeService({
        create: async () => {
          throw new OrchestratorError('script_input_invalid', '低于 60 秒硬性下限', {
            field: 'trigger.everySeconds',
            reason: 'too-frequent',
          })
        },
      }),
    })
    const result = await handler('create', { ...sampleCreateInput(), trigger: { kind: 'every', everySeconds: 30 } }, undefined, {})
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'script_input_invalid',
        message: '低于 60 秒硬性下限',
        details: { field: 'trigger.everySeconds', reason: 'too-frequent' },
      },
    })
  })

  it('服务抛未分类异常 → internal_error envelope', async () => {
    const handler = createBridgeHandler({
      service: fakeService({ create: async () => { throw new Error('queue poisoned') } }),
    })
    const result = await handler('create', sampleCreateInput(), undefined, {})
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('internal_error')
  })
})

describe('view 端点（契约 11 端点表：与服务同形）', () => {
  it('{ id } → service.view(id, {})，返回 ok value', async () => {
    const seen = []
    const handler = createBridgeHandler({
      service: fakeService({ view: async (id, options) => { seen.push([id, options]); return { ...SAMPLE_VIEW, runs: [], availableActions: [] } } }),
    })
    const result = await handler('view', { id: 'log-rotate' }, undefined, {})
    expect(seen).toEqual([['log-rotate', {}]])
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ ...SAMPLE_VIEW, runs: [], availableActions: [] })
  })

  it('{ id, runs } 原样透传 runs 选项', async () => {
    const seen = []
    const handler = createBridgeHandler({
      service: fakeService({ view: async (id, options) => { seen.push([id, options]); return { ...SAMPLE_VIEW, runs: [], availableActions: [] } } }),
    })
    await handler('view', { id: 'x', runs: 10 }, undefined, {})
    expect(seen).toEqual([['x', { runs: 10 }]])
  })

  it.each([
    ['缺 id', {}, 'id', 'missing'],
    ['id 非字符串', { id: 42 }, 'id', 'format'],
    ['多余字段', { id: 'x', deep: 1 }, 'deep', 'unexpected'],
    ['runs 非整数', { id: 'x', runs: '5' }, 'runs', 'format'],
    ['runs 越界', { id: 'x', runs: 51 }, 'runs', 'range'],
    ['payload 非对象', null, 'payload', 'format'],
  ])('形状校验：%s → script_input_invalid（%s/%s）', async (_label, payload, field, reason) => {
    const handler = createBridgeHandler({ service: fakeService() })
    const result = await handler('view', payload, undefined, {})
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('script_input_invalid')
    expect(result.error.details).toMatchObject({ field, reason })
  })

  it('script_unknown 原样透传', async () => {
    const handler = createBridgeHandler({
      service: fakeService({
        view: async () => { throw new OrchestratorError('script_unknown', "编排 'x' 不存在", { id: 'x' }) },
      }),
    })
    const result = await handler('view', { id: 'x' }, undefined, {})
    expect(result).toEqual({
      ok: false,
      error: { code: 'script_unknown', message: "编排 'x' 不存在", details: { id: 'x' } },
    })
  })
})

/** 模拟 node:http 的 req/res，驱动 mountBridge 挂的路由 handler。 */
async function callRoute(route, { method = 'POST', url, body, admission }) {
  const chunks = method === 'POST' && body !== undefined ? [Buffer.from(body)] : []
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:9999' },
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
  const writes = []
  let status = null
  let headers = null
  const res = {
    writeHead(code, hdrs) {
      status = code
      headers = hdrs
    },
    end(payload) {
      writes.push(String(payload ?? ''))
    },
  }
  await route.handler(req, res)
  return { status, headers, body: writes.join('') }
}

describe('mountBridge（HTTP 挂载：webServer 路由 + connection.admit + envelope）', () => {
  const peer = { id: 'peer-1' }
  function makeDeps(admission = { peer }) {
    const routes = []
    return {
      connection: {
        admit: () => admission,
      },
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => routes.splice(routes.indexOf(route), 1)
        },
      },
      routes,
    }
  }
  const handler = createBridgeHandler({ service: fakeService() })

  it('注册 /script-orchestrator prefix 路由，返回 disposer', () => {
    const deps = makeDeps()
    const dispose = mountBridge({ ...deps, handler })
    expect(deps.routes).toHaveLength(1)
    expect(deps.routes[0].kind).toBe('prefix')
    expect(deps.routes[0].path).toBe('/script-orchestrator')
    dispose()
    expect(deps.routes).toHaveLength(0)
  })

  it('认证拒绝：401/403 无 body 透传（复用 connection.admit）', async () => {
    const deps = makeDeps({ rejection: 401 })
    mountBridge({ ...deps, handler })
    const r401 = await callRoute(deps.routes[0], { url: '/script-orchestrator/list', body: '{}' })
    expect(r401.status).toBe(401)
    expect(r401.body).toBe('unauthorized')
    const deps403 = makeDeps({ rejection: 403 })
    mountBridge({ ...deps403, handler })
    const r403 = await callRoute(deps403.routes[0], { url: '/script-orchestrator/list', body: '{}' })
    expect(r403.status).toBe(403)
    expect(r403.body).toBe('forbidden')
  })

  it('合法请求：POST + JSON envelope → server-response envelope（client rpc.call 可解析形状）', async () => {
    const deps = makeDeps()
    mountBridge({ ...deps, handler })
    const r = await callRoute(deps.routes[0], {
      url: '/script-orchestrator/list',
      body: JSON.stringify({ type: 'client-request', rpcId: 'r-1', method: 'list', payload: {} }),
    })
    expect(r.status).toBe(200)
    const envelope = JSON.parse(r.body)
    expect(envelope).toEqual({
      type: 'server-response',
      rpcId: 'r-1',
      result: { ok: true, value: { items: [], total: 0, nextOffset: null } },
    })
  })

  it('方法与端点不一致 / 非 JSON / GET：按传输层错误处理', async () => {
    const deps = makeDeps()
    mountBridge({ ...deps, handler })
    const mismatch = await callRoute(deps.routes[0], {
      url: '/script-orchestrator/list',
      body: JSON.stringify({ type: 'client-request', rpcId: 'r-2', method: 'other', payload: {} }),
    })
    expect(mismatch.status).toBe(200)
    expect(JSON.parse(mismatch.body).result.ok).toBe(false)
    expect(JSON.parse(mismatch.body).result.error.code).toBe('gateway/bad-request')
    const notJson = await callRoute(deps.routes[0], { url: '/script-orchestrator/list', body: 'not-json' })
    expect(notJson.status).toBe(400)
  })

  it('handler 抛错 → HTTP 500 文本（与 rpc.handle 传输层一致）', async () => {
    const deps = makeDeps()
    mountBridge({
      ...deps,
      handler: () => {
        throw new Error('boom')
      },
    })
    const r = await callRoute(deps.routes[0], {
      url: '/script-orchestrator/list',
      body: JSON.stringify({ type: 'client-request', rpcId: 'r-3', method: 'list', payload: {} }),
    })
    expect(r.status).toBe(500)
    expect(r.body).toContain('boom')
  })
})
