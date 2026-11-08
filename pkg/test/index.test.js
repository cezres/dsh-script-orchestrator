import { describe, it, expect } from 'vitest'
import { apply as plugin, Config, inject, name } from '../lib/index.js'
import { Config as RawConfig } from '../lib/config.js'

function makeCtx({ domain } = {}) {
  const calls = {
    opened: [],
    provided: [],
    channels: [],
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
  let handler = null
  const ctx = {
    storageDomain: {
      open: async (spec) => {
        calls.opened.push(spec.name)
        return fakeDomain
      },
    },
    connection: {
      rpc: {
        handle: (channel, h) => {
          calls.channels.push(channel)
          handler = h
          return () => calls.closeOrder.push('bridge')
        },
      },
    },
    provide: (key, impl) => calls.provided.push([key, impl]),
    logger: () => ({ error: (m) => calls.logs.push(m), warn: (m) => calls.logs.push(m) }),
  }
  return { ctx, calls, getHandler: () => handler }
}

describe('插件入口（lib/index.js）', () => {
  it('导出面：apply + 同步 Config + inject 声明（storageDomain/connection/webServer）+ name', () => {
    expect(typeof plugin).toBe('function')
    expect(Config).toBe(RawConfig)
    expect([...inject]).toEqual(['storageDomain', 'connection', 'webServer'])
    expect(name).toBe('script-orchestrator')
  })

  it('apply：打开存储域 → provide scriptOrchestrator（空 list 可用）→ 挂 /script-orchestrator 桥', async () => {
    const { ctx, calls, getHandler } = makeCtx()
    const it = plugin(ctx, { maxRunsPerOrchestration: 100 })
    const first = await it.next()
    expect(first.done).toBe(false)
    expect(calls.opened).toEqual(['script_orchestrator'])
    expect(calls.provided.map(([k]) => k)).toEqual(['scriptOrchestrator'])
    expect(calls.channels).toEqual(['/script-orchestrator'])
    const service = calls.provided[0][1]
    await expect(service.list()).resolves.toEqual({ items: [], total: 0, nextOffset: null })
    const result = await getHandler()('list', undefined, undefined, {})
    expect(result).toEqual({ ok: true, value: { items: [], total: 0, nextOffset: null } })
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
    expect(calls.channels).toEqual([])
  })
})
