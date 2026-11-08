import { describe, it, expect } from 'vitest'
import { apply as plugin, Config, inject, name } from '../lib/index.js'
import { Config as RawConfig } from '../lib/config.js'

function makeCtx({ domain } = {}) {
  const calls = {
    opened: [],
    provided: [],
    routes: [],
    closeOrder: [],
    logs: [],
  }
  const fakeDomain =
    domain ??
    {
      name: 'script_orchestrator',
      table: () => ({ entries: () => new Map().entries(), get: () => undefined }),
      close: () => {
        calls.closeOrder.push('domain')
        return Promise.resolve()
      },
    }
  let route = null
  const ctx = {
    storageDomain: {
      open: async (spec) => {
        calls.opened.push(spec.name)
        return fakeDomain
      },
    },
    connection: {
      admit: () => ({ peer: { id: 'p' } }),
    },
    webServer: {
      register: (r) => {
        calls.routes.push(r)
        route = r
        return () => calls.closeOrder.push('bridge')
      },
    },
    provide: (key, impl) => calls.provided.push([key, impl]),
    logger: () => ({ error: (m) => calls.logs.push(m), warn: (m) => calls.logs.push(m) }),
  }
  return { ctx, calls, getRoute: () => route }
}

/** 用 node:http 形状的 mock 请求驱动桥路由。 */
async function callRoute(route, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  const req = {
    method: 'POST',
    url,
    headers: { host: '127.0.0.1:9999' },
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
  let status = null
  const writes = []
  const res = {
    writeHead(code) {
      status = code
    },
    end(payload) {
      writes.push(String(payload ?? ''))
    },
  }
  await route.handler(req, res)
  return { status, body: writes.join('') }
}

describe('插件入口（lib/index.js）', () => {
  it('导出面：apply + 同步 Config + inject 声明（storageDomain/connection/webServer）+ name', () => {
    expect(typeof plugin).toBe('function')
    expect(Config).toBe(RawConfig)
    expect([...inject]).toEqual(['storageDomain', 'connection', 'webServer'])
    expect(name).toBe('script-orchestrator')
  })

  it('apply：打开存储域 → provide scriptOrchestrator（空 list 可用）→ 挂 /script-orchestrator 路由', async () => {
    const { ctx, calls, getRoute } = makeCtx()
    const it = plugin(ctx, { maxRunsPerOrchestration: 100 })
    const first = await it.next()
    expect(first.done).toBe(false)
    expect(calls.opened).toEqual(['script_orchestrator'])
    expect(calls.provided.map(([k]) => k)).toEqual(['scriptOrchestrator'])
    expect(calls.routes).toHaveLength(1)
    expect(calls.routes[0].kind).toBe('prefix')
    expect(calls.routes[0].path).toBe('/script-orchestrator')
    const service = calls.provided[0][1]
    await expect(service.list()).resolves.toEqual({ items: [], total: 0, nextOffset: null })
    const rpc = await callRoute(
      getRoute(),
      '/script-orchestrator/list',
      JSON.stringify({ type: 'client-request', rpcId: 't1', method: 'list', payload: {} }),
    )
    expect(rpc.status).toBe(200)
    expect(JSON.parse(rpc.body).result).toEqual({
      ok: true,
      value: { items: [], total: 0, nextOffset: null },
    })
    await first.value()
  })

  it('卸载顺序：先摘桥（停生产者）→ 排干服务层队列 → domain.close()', async () => {
    const { ctx, calls } = makeCtx()
    const it = plugin(ctx, { maxRunsPerOrchestration: 100 })
    const first = await it.next()
    await first.value()
    expect(calls.closeOrder).toEqual(['bridge', 'domain'])
  })

  it('存储域打开失败：apply reject，不 provide 服务、不挂桥（无半初始化服务）', async () => {
    const { ctx, calls } = makeCtx()
    ctx.storageDomain.open = async () => {
      throw new Error('storage backend gone')
    }
    const it = plugin(ctx, { maxRunsPerOrchestration: 100 })
    await expect(it.next()).rejects.toThrow('storage backend gone')
    expect(calls.provided).toEqual([])
    expect(calls.routes).toEqual([])
  })
})
