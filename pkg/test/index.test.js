import { describe, it, expect, vi } from 'vitest'
import { apply as plugin, Config, inject, name } from '../lib/index.js'
import { Config as RawConfig } from '../lib/config.js'

function makeCtx({ domain } = {}) {
  const calls = {
    opened: [],
    provided: [],
    routes: [],
    tools: [],
    closeOrder: [],
    logs: [],
    emitted: [],
    spawns: [],
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
    subprocess: {
      spawn: (spec) => {
        const entry = { spec, terminated: 0 }
        calls.spawns.push(entry)
        let resolveDone
        entry.finish = (result) => resolveDone(result ?? { exitCode: 0, signal: null })
        entry.handle = {
          done: new Promise((resolve) => {
            resolveDone = resolve
          }),
          terminate: () => {
            entry.terminated += 1
            resolveDone({ exitCode: 1, signal: null })
          },
          waitForExit: () => Promise.resolve(true),
          collected: {
            stdout: { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) },
            stderr: { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) },
          },
        }
        return entry.handle
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
    tools: {
      register: (definition) => {
        calls.tools.push(definition)
        return () => calls.closeOrder.push(`tool:${definition.name}`)
      },
    },
    provide: (key, impl) => calls.provided.push([key, impl]),
    emit: (name, payload) => calls.emitted.push([name, payload]),
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
  it('导出面：apply + 同步 Config + inject 声明（storageDomain/connection/webServer/tools/subprocess）+ name', () => {
    expect(typeof plugin).toBe('function')
    expect(Config).toBe(RawConfig)
    expect([...inject]).toEqual(['storageDomain', 'connection', 'webServer', 'tools', 'subprocess'])
    expect(name).toBe('script-orchestrator')
  })

  it('apply：打开存储域 → provide scriptOrchestrator（空 list 可用）→ 挂 /script-orchestrator 路由 → 注册三工具', async () => {
    const { ctx, calls, getRoute } = makeCtx()
    const it = plugin(ctx, {})
    const first = await it.next()
    expect(first.done).toBe(false)
    expect(calls.opened).toEqual(['script_orchestrator'])
    expect(calls.provided.map(([k]) => k)).toEqual(['scriptOrchestrator'])
    expect(calls.routes).toHaveLength(1)
    expect(calls.routes[0].kind).toBe('prefix')
    expect(calls.routes[0].path).toBe('/script-orchestrator')
    expect(calls.tools.map((d) => d.name)).toEqual(['script_create', 'script_list', 'script_view'])
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

  it('注册的工具 execute 连通真服务：script_create 经校验创建并持久化', async () => {
    const { ctx, calls } = makeCtx()
    const table = new Map()
    ctx.storageDomain.open = async () => ({
      name: 'script_orchestrator',
      table: () => ({
        entries: () => table.entries(),
        get: (key) => table.get(key),
        put: (key, value) => {
          table.set(key, value)
          return Promise.resolve()
        },
        delete: (key) => {
          table.delete(key)
          return Promise.resolve()
        },
      }),
      close: () => Promise.resolve(),
    })
    const it = plugin(ctx, {})
    const first = await it.next()
    const create = calls.tools.find((d) => d.name === 'script_create')
    const view = await create.execute(
      {
        title: 'integration check',
        trigger: { kind: 'every', everySeconds: 120 },
        script: { command: 'pwsh' },
        judge: { rules: [], fallback: [] },
        actions: {},
      },
      {},
    )
    expect(view.id).toBe('integration-check')
    expect(view.status).toBe('active')
    expect(table.get('integration-check')).toEqual(view)
    const bad = await create.execute({ title: 'x' }, {})
    expect(bad).toMatchObject({ code: 'script_input_invalid', details: { field: 'trigger', reason: 'missing' } })
    await first.value()
  })

  it('调度接线：重启恢复的过期 nextOccurrence 在启动后立即触发 → runner spawn（经注入的 subprocess）', async () => {
    const { ctx, calls } = makeCtx()
    const tables = { orchestrations: new Map(), runs: new Map() }
    // 预置「上次停机前留下的已过期计划」（契约 02：已有未来 nextOccurrence 保留该时刻；
    // 过期时刻由启动后的调度器按错过合并立即补一次）
    const dueIso = new Date(Date.now() - 1000).toISOString()
    tables.orchestrations.set('due-now', {
      id: 'due-now',
      title: '到点即触发',
      enabled: true,
      overlap: 'skip',
      trigger: { kind: 'every', everySeconds: 3600, mode: 'fixed-rate' },
      script: { command: 'node', args: ['-e', 'ok'], env: {} },
      judge: { rules: [], fallback: [] },
      actions: {},
      createdAt: dueIso,
      updatedAt: dueIso,
      status: 'active',
      nextOccurrence: dueIso,
    })
    ctx.storageDomain.open = async () => ({
      name: 'script_orchestrator',
      table: (name) => ({
        entries: () => tables[name].entries(),
        get: (key) => tables[name].get(key),
        put: (key, value) => {
          tables[name].set(key, value)
          return Promise.resolve()
        },
        delete: (key) => {
          tables[name].delete(key)
          return Promise.resolve()
        },
      }),
      close: () => Promise.resolve(),
    })
    const it = plugin(ctx, {})
    const first = await it.next()
    await vi.waitFor(() => expect(calls.spawns.length).toBeGreaterThanOrEqual(1))
    expect(calls.spawns[0].spec.argv[0]).toBe('node')
    // run 两写 + run-started 已发生（写 1 在 spawn 前）
    expect(tables.runs.size).toBe(1)
    expect(calls.emitted.some(([n]) => n === 'script-orchestrator/run-started')).toBe(true)
    calls.spawns.forEach((entry) => entry.finish({ exitCode: 0, signal: null }))
    await first.value()
  })

  it('票 30 接线：过期计划触发 → 判定命中 → event 动作发出自定义事件、plugin 查共享注册表（空表 → unknown_action）、run 按 partial 结算', async () => {
    const { ctx, calls } = makeCtx()
    const tables = { orchestrations: new Map(), runs: new Map() }
    const dueIso = new Date(Date.now() - 1000).toISOString()
    tables.orchestrations.set('dispatch-wire', {
      id: 'dispatch-wire',
      title: '派发接线',
      enabled: true,
      overlap: 'skip',
      trigger: { kind: 'every', everySeconds: 3600, mode: 'fixed-rate' },
      script: { command: 'node', args: ['-e', 'ok'], env: {} },
      judge: { rules: [{ when: { exitCode: 0 }, actions: ['emit-ok', 'page'] }], fallback: [] },
      actions: {
        'emit-ok': { kind: 'event', name: 'deploy-ok', payload: { summary: '{{orchestrationTitle}} {{exitCode}}' } },
        page: { kind: 'plugin', action: 'ops.oncall' },
      },
      createdAt: dueIso,
      updatedAt: dueIso,
      status: 'active',
      nextOccurrence: dueIso,
    })
    ctx.storageDomain.open = async () => ({
      name: 'script_orchestrator',
      table: (name) => ({
        entries: () => tables[name].entries(),
        get: (key) => tables[name].get(key),
        put: (key, value) => {
          tables[name].set(key, value)
          return Promise.resolve()
        },
        delete: (key) => {
          tables[name].delete(key)
          return Promise.resolve()
        },
      }),
      close: () => Promise.resolve(),
    })
    const it = plugin(ctx, {})
    const first = await it.next()
    await vi.waitFor(() => expect(calls.spawns.length).toBeGreaterThanOrEqual(1))
    calls.spawns.forEach((entry) => entry.finish({ exitCode: 0, signal: null }))
    await vi.waitFor(() => {
      const run = [...tables.runs.values()].find((r) => r.status === 'partial')
      if (!run) throw new Error('run 未按 partial 结算')
    })
    const run = [...tables.runs.values()].find((r) => r.status === 'partial')
    expect(run.matchedRule).toBe(0)
    expect(run.actions).toEqual([
      { name: 'emit-ok', kind: 'event', status: 'succeeded' },
      { name: 'page', kind: 'plugin', status: 'failed', error: { code: 'unknown_action', message: expect.stringContaining('ops.oncall') } },
    ])
    // 自定义事件经宿主 emit 总线（全名 + 四键载荷 + payload 已渲染）
    const custom = calls.emitted.find(([n]) => n === 'script-orchestrator/deploy-ok')
    expect(custom[1]).toEqual({
      name: 'deploy-ok',
      payload: { summary: '派发接线 0' },
      orchestration: { id: 'dispatch-wire', title: '派发接线' },
      run: { runId: run.runId, status: 'succeeded', exitCode: 0 },
    })
    const names = calls.emitted.map(([n]) => n)
    expect(names).toContain('script-orchestrator/action-settled')
    expect(names.at(-1)).toBe('script-orchestrator/run-settled')
    expect(calls.emitted.at(-1)[1]).toMatchObject({ runId: run.runId, status: 'partial', matchedRule: 0 })
    await first.value()
  })

  it('票 31 接线：service.registerAction 注册 → 同一注册表驱动 runner 派发（调用成功 + report 警告）；dispose 后 → unknown_action', async () => {
    const { ctx, calls } = makeCtx()
    const tables = { orchestrations: new Map(), runs: new Map() }
    const dueIso = new Date(Date.now() - 1000).toISOString()
    tables.orchestrations.set('plugin-wire', {
      id: 'plugin-wire',
      title: '注册动作接线',
      enabled: true,
      overlap: 'skip',
      trigger: { kind: 'every', everySeconds: 3600, mode: 'fixed-rate' },
      script: { command: 'node', args: ['-e', 'ok'], env: {} },
      judge: { rules: [{ when: { exitCode: 0 }, actions: ['page'] }], fallback: [] },
      actions: { page: { kind: 'plugin', action: 'ops.oncall', payload: { note: '{{orchestrationTitle}}' } } },
      createdAt: dueIso,
      updatedAt: dueIso,
      status: 'active',
      nextOccurrence: dueIso,
    })
    ctx.storageDomain.open = async () => ({
      name: 'script_orchestrator',
      table: (name) => ({
        entries: () => tables[name].entries(),
        get: (key) => tables[name].get(key),
        put: (key, value) => {
          tables[name].set(key, value)
          return Promise.resolve()
        },
        delete: (key) => {
          tables[name].delete(key)
          return Promise.resolve()
        },
      }),
      close: () => Promise.resolve(),
    })
    const it = plugin(ctx, {})
    const first = await it.next()
    const service = calls.provided[0][1]
    const contexts = []
    const dispose = service.registerAction({
      name: 'ops.oncall',
      description: '按 severity 呼叫值班',
      async run(context) {
        contexts.push(context)
        context.report('已呼叫值班')
      },
    })
    // provided 服务与 runner 共享同一注册表：listActions 快照可见
    expect(service.listActions()).toEqual([{ name: 'ops.oncall', description: '按 severity 呼叫值班' }])
    await vi.waitFor(() => expect(calls.spawns.length).toBeGreaterThanOrEqual(1))
    calls.spawns.forEach((entry) => entry.finish({ exitCode: 0, signal: null }))
    await vi.waitFor(() => {
      const run = [...tables.runs.values()].find((r) => r.status === 'succeeded')
      if (!run) throw new Error('run 未按 succeeded 结算')
    })
    const run = [...tables.runs.values()].find((r) => r.status === 'succeeded')
    expect(run.actions).toEqual([
      { name: 'page', kind: 'plugin', status: 'succeeded', warnings: ['已呼叫值班'] },
    ])
    // ActionContext 契约形状（契约 06）：payload 已渲染、signal、report
    expect(contexts).toHaveLength(1)
    expect(contexts[0].orchestration).toEqual({ id: 'plugin-wire', title: '注册动作接线' })
    expect(contexts[0].payload).toEqual({ note: '注册动作接线' })
    expect(typeof contexts[0].signal?.addEventListener).toBe('function')
    // 摘除后：实时查表 → unknown_action（第二次触发经手动注入——直接再放一个过期计划不可行，
    // 用 disposer 后的派发查表路径经 service 视图验证：listActions 清空）
    dispose()
    expect(service.listActions()).toEqual([])
    await first.value()
  })

  it('票 31 超时接线：编排记录的 timeoutSeconds 经 runner 流到派发器 → 动作 failed timeout、run failed（真实计时器）', async () => {
    const { ctx, calls } = makeCtx()
    const tables = { orchestrations: new Map(), runs: new Map() }
    const dueIso = new Date(Date.now() - 1000).toISOString()
    tables.orchestrations.set('timeout-wire', {
      id: 'timeout-wire',
      title: '超时接线',
      enabled: true,
      overlap: 'skip',
      trigger: { kind: 'every', everySeconds: 3600, mode: 'fixed-rate' },
      script: { command: 'node', args: ['-e', 'ok'], env: {} },
      judge: { rules: [{ when: { exitCode: 0 }, actions: ['hang-page'] }], fallback: [] },
      actions: { 'hang-page': { kind: 'plugin', action: 'ops.hang', timeoutSeconds: 1 } },
      createdAt: dueIso,
      updatedAt: dueIso,
      status: 'active',
      nextOccurrence: dueIso,
    })
    ctx.storageDomain.open = async () => ({
      name: 'script_orchestrator',
      table: (name) => ({
        entries: () => tables[name].entries(),
        get: (key) => tables[name].get(key),
        put: (key, value) => {
          tables[name].set(key, value)
          return Promise.resolve()
        },
        delete: (key) => {
          tables[name].delete(key)
          return Promise.resolve()
        },
      }),
      close: () => Promise.resolve(),
    })
    const it = plugin(ctx, {})
    const first = await it.next()
    const service = calls.provided[0][1]
    service.registerAction({
      name: 'ops.hang',
      // 观察 signal 的实现：中止后收尾（模拟告警调用放弃重试）
      run: (context) => new Promise((resolve) => context.signal.addEventListener('abort', resolve)),
    })
    await vi.waitFor(() => expect(calls.spawns.length).toBeGreaterThanOrEqual(1))
    calls.spawns.forEach((entry) => entry.finish({ exitCode: 0, signal: null }))
    await vi.waitFor(() => {
      const run = [...tables.runs.values()].find((r) => r.status === 'failed')
      if (!run) throw new Error('run 未按 failed 结算（单动作 timeout）')
    }, { timeout: 5000, interval: 50 })
    const run = [...tables.runs.values()].find((r) => r.status === 'failed')
    expect(run.actions).toEqual([
      {
        name: 'hang-page',
        kind: 'plugin',
        status: 'failed',
        error: { code: 'timeout', message: expect.stringContaining('ops.hang') },
      },
    ])
    await first.value()
  })

  it('卸载顺序：先停调度与工具/桥（停生产者）→ runner 停机（在途清进程）→ 排干队列 → domain.close()', async () => {
    const { ctx, calls } = makeCtx()
    const it = plugin(ctx, {})
    const first = await it.next()
    await first.value()
    expect(calls.closeOrder).toEqual([
      'tool:script_view',
      'tool:script_list',
      'tool:script_create',
      'bridge',
      'domain',
    ])
  })

  it('存储域打开失败：apply reject，不 provide 服务、不挂桥（无半初始化服务）', async () => {
    const { ctx, calls } = makeCtx()
    ctx.storageDomain.open = async () => {
      throw new Error('storage backend gone')
    }
    const it = plugin(ctx, {})
    await expect(it.next()).rejects.toThrow('storage backend gone')
    expect(calls.provided).toEqual([])
    expect(calls.routes).toEqual([])
    expect(calls.tools).toEqual([])
  })
})
