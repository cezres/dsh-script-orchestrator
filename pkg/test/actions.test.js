// 动作派发器（契约 docs/temp/05-actions.md、06-events-service.md、09-states-errors.md）：
// 按声明顺序串行执行、失败隔离、event 载荷、plugin 注册表查表点（注册本体属票 31）、
// session 渲染与占位（执行属票 32/33）、dispatching 取消停止剩余派发、动作汇总。
import { describe, it, expect, vi } from 'vitest'
import { dispatchActions, aggregateRunStatus, createActionRegistry } from '../lib/actions.js'

const ORCH = { id: 'nightly-deploy-check', title: '夜间部署巡检' }

const makeRun = (over = {}) => ({
  runId: 'run-7f3c1a9e',
  orchestrationId: ORCH.id,
  trigger: 'every',
  scheduledAt: '2026-11-08T20:00:00.000Z',
  startedAt: '2026-11-08T20:00:00.100Z',
  status: 'dispatching',
  script: { command: 'node', exitCode: 0, signal: null, timedOut: false, durationMs: 3606, stdoutTail: 'deploy ok', stderrTail: '', truncated: false },
  ...over,
})

const VERDICT = { matchedRule: 0, usedFallback: false, actionKeys: ['emit-ok'] }

/** 组装 dispatchActions 依赖（默认无注册动作、emit 收集、无取消）。 */
function makeDeps(over = {}) {
  const emitted = []
  const logs = []
  return {
    orchestration: ORCH,
    run: makeRun(),
    verdict: VERDICT,
    stdoutText: '',
    registry: over.registry ?? { resolve: () => undefined },
    emit: over.emit ?? ((name, payload) => emitted.push([name, payload])),
    logger: { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
    cancellation: over.cancellation ?? { requested: false, controller: null },
    ...over,
    emitted,
    logs,
  }
}

/** 结构化 fake 注册表：entries 名 → 定义；remove 后 resolve 回 undefined。 */
function makeRegistry(entries = {}) {
  const live = new Map(Object.entries(entries))
  return { resolve: (name) => live.get(name), __remove: (name) => live.delete(name) }
}

const dispatch = (deps, actionKeys, actions) =>
  dispatchActions({ ...deps, actionKeys, actions })

describe('event 动作（契约 05：发出 script-orchestrator/<name> 与固定载荷）', () => {
  it('发出正确全名与 JSON 安全载荷：name/payload（已渲染）/orchestration/run 四键', async () => {
    const deps = makeDeps()
    const { results, canceled } = await dispatch(
      deps,
      ['emit-ok'],
      { 'emit-ok': { kind: 'event', name: 'deploy-ok', payload: { region: 'cn-north', summary: '{{orchestrationTitle}} 退出码 {{exitCode}}' } } },
    )
    expect(deps.emitted).toEqual([
      [
        'script-orchestrator/deploy-ok',
        {
          name: 'deploy-ok',
          payload: { region: 'cn-north', summary: '夜间部署巡检 退出码 0' },
          orchestration: { id: 'nightly-deploy-check', title: '夜间部署巡检' },
          run: { runId: 'run-7f3c1a9e', status: 'succeeded', exitCode: 0 },
        },
      ],
    ])
    expect(results).toEqual([{ name: 'emit-ok', kind: 'event', status: 'succeeded' }])
    expect(canceled).toBe(false)
  })

  it('payload 省略时载荷不含 payload 键；未知变量 warning 进动作记录', async () => {
    const deps = makeDeps()
    const { results } = await dispatch(
      deps,
      ['emit-ok'],
      { 'emit-ok': { kind: 'event', name: 'deploy-bad', payload: '{{nope}}' } },
    )
    const [name, payload] = deps.emitted[0]
    expect(name).toBe('script-orchestrator/deploy-bad')
    expect(payload.payload).toBe('')
    const definitionWithoutPayload = await dispatch(makeDeps(), ['e2'], { e2: { kind: 'event', name: 'bare' } })
    expect(definitionWithoutPayload.results[0]).toEqual({ name: 'e2', kind: 'event', status: 'succeeded' })
    expect(results[0].warnings).toEqual(['unknown variable: {{nope}}'])
  })

  it('listener 同步抛错：记 event_listener_failed、动作仍 succeeded、后续动作照常（契约 06 发布端兜底 + 05 发出即忘）', async () => {
    const emitted = []
    const deps = makeDeps({
      emit: (name, payload) => {
        emitted.push([name, payload])
        if (name === 'script-orchestrator/first') throw new Error('listener boom')
      },
    })
    const { results } = await dispatch(
      deps,
      ['a1', 'a2'],
      { a1: { kind: 'event', name: 'first' }, a2: { kind: 'event', name: 'second' } },
    )
    expect(emitted.map(([n]) => n)).toEqual(['script-orchestrator/first', 'script-orchestrator/second'])
    expect(deps.logs.some((m) => String(m).includes('event_listener_failed') && String(m).includes('first'))).toBe(true)
    expect(results.map((r) => r.status)).toEqual(['succeeded', 'succeeded'])
  })
})

describe('plugin 动作（契约 05/06：逐动作实时查表；registerAction 属票 31）', () => {
  it('未注册（或已摘除）→ failed unknown_action，不静默跳过；后续动作继续（失败隔离）', async () => {
    const deps = makeDeps()
    const { results } = await dispatch(
      deps,
      ['page', 'emit-ok'],
      { page: { kind: 'plugin', action: 'ops.oncall' }, 'emit-ok': { kind: 'event', name: 'deploy-ok' } },
    )
    expect(results[0]).toMatchObject({ name: 'page', kind: 'plugin', status: 'failed', error: { code: 'unknown_action' } })
    expect(results[0].error.message).toContain('ops.oncall')
    expect(results[1]).toEqual({ name: 'emit-ok', kind: 'event', status: 'succeeded' })
    expect(deps.emitted).toHaveLength(1)
  })

  it('已注册 → 以 ActionContext 调用：orchestration/run（脚本阶段完成即 succeeded）/已渲染 payload/signal/report', async () => {
    const calls = []
    const registry = makeRegistry({
      'ops.oncall': {
        name: 'ops.oncall',
        description: '呼叫值班',
        run: async (context) => {
          calls.push(context)
          context.report('已呼叫')
        },
      },
    })
    const deps = makeDeps({ registry })
    const { results } = await dispatch(
      deps,
      ['page'],
      { page: { kind: 'plugin', action: 'ops.oncall', payload: { severity: 'page', summary: '{{orchestrationTitle}} {{exitCode}}' } } },
    )
    expect(calls).toHaveLength(1)
    const context = calls[0]
    expect(context.orchestration).toEqual({ id: 'nightly-deploy-check', title: '夜间部署巡检' })
    expect(context.run).toEqual({ runId: 'run-7f3c1a9e', status: 'succeeded', trigger: 'every' })
    expect(context.payload).toEqual({ severity: 'page', summary: '夜间部署巡检 0' })
    expect(typeof context.signal?.addEventListener).toBe('function')
    expect(typeof context.report).toBe('function')
    expect(results[0]).toEqual({ name: 'page', kind: 'plugin', status: 'succeeded', warnings: ['已呼叫'] })
  })

  it('run() 抛错（异步 reject 或同步 throw）→ failed action_error；payload 模板警告与 report 共用 warnings 数组（保最近 20）', async () => {
    const registry = makeRegistry({
      'bad.one': { name: 'bad.one', run: async () => { throw new Error('page service down') } },
      'bad.two': {
        name: 'bad.two',
        run: (context) => {
          for (let index = 0; index < 25; index += 1) context.report(`r${index}`)
          throw new Error('sync boom')
        },
      },
    })
    const deps = makeDeps({ registry })
    const { results } = await dispatch(
      deps,
      ['b1', 'b2'],
      { b1: { kind: 'plugin', action: 'bad.one' }, b2: { kind: 'plugin', action: 'bad.two' } },
    )
    expect(results[0]).toEqual({
      name: 'b1',
      kind: 'plugin',
      status: 'failed',
      error: { code: 'action_error', message: expect.stringContaining('page service down') },
    })
    expect(results[1].status).toBe('failed')
    expect(results[1].error.code).toBe('action_error')
    expect(results[1].warnings).toHaveLength(20)
    expect(results[1].warnings[0]).toBe('r5')
    expect(results[1].warnings[19]).toBe('r24')
  })

  it('每次执行前实时查表：同一 run 内前序成功与否不影响后续重新查表（摘除后 unknown_action）', async () => {
    const registry = makeRegistry({ 'ops.oncall': { name: 'ops.oncall', run: async () => {} } })
    registry.__remove('ops.oncall')
    const deps = makeDeps({ registry })
    const { results } = await dispatch(deps, ['page'], { page: { kind: 'plugin', action: 'ops.oncall' } })
    expect(results[0].error.code).toBe('unknown_action')
  })

  it('在途摘除不中止在途调用：执行中 dispose → 该动作照常成功结算；同 run 内再次引用该名 → unknown_action（契约 06 摘除只影响未来解析）', async () => {
    const registry = createActionRegistry()
    const dispose = registry.register({
      name: 'ops.oncall',
      async run() {
        dispose() // 执行中摘除自己：在途调用不受影响（无 signal 中止、无拒绝）
        await new Promise((resolve) => setTimeout(resolve, 10)) // 模拟摘除后仍在收尾工作
      },
    })
    const deps = makeDeps({ registry })
    const { results } = await dispatch(
      deps,
      ['call-1', 'call-2'],
      { 'call-1': { kind: 'plugin', action: 'ops.oncall' }, 'call-2': { kind: 'plugin', action: 'ops.oncall' } },
    )
    expect(results[0]).toEqual({ name: 'call-1', kind: 'plugin', status: 'succeeded' })
    expect(results[1]).toMatchObject({ name: 'call-2', kind: 'plugin', status: 'failed', error: { code: 'unknown_action' } })
  })
})

describe('session 动作（渲染属本票；执行属票 32/33）', () => {
  it('prompt 渲染（模板警告进记录）；本票执行面为 failed action_error 占位（消息注明后续票）', async () => {
    const deps = makeDeps()
    const { results } = await dispatch(
      deps,
      ['open-triage'],
      { 'open-triage': { kind: 'session', prompt: '退出码 {{exitCode}}，stdout：{{stdoutTail}}' } },
    )
    expect(results[0]).toMatchObject({ name: 'open-triage', kind: 'session', status: 'failed', error: { code: 'action_error' } })
    expect(results[0].error.message).toContain('32')
    expect(results[0].warnings).toBeUndefined()
  })

  it('prompt 渲染后去首尾空白为空 → failed template_invalid（唯一触发路径；payload 不可能触发）', async () => {
    const deps = makeDeps()
    const { results } = await dispatch(
      deps,
      ['bad', 'emit-ok'],
      { bad: { kind: 'session', prompt: '  {{unknown-var}}  ' }, 'emit-ok': { kind: 'event', name: 'deploy-ok' } },
    )
    expect(results[0]).toMatchObject({ name: 'bad', kind: 'session', status: 'failed', error: { code: 'template_invalid' } })
    expect(results[0].warnings).toEqual(['unknown variable: {{unknown-var}}'])
    expect(results[1].status).toBe('succeeded') // 渲染失败仅该动作 failed，后续照常
  })
})

describe('串行与顺序（契约 05：按声明顺序串行执行）', () => {
  it('第二动作在第一个 await 完成后才开始（顺序 = actionKeys 声明序）', async () => {
    const trace = []
    const registry = makeRegistry({
      'slow.act': {
        name: 'slow.act',
        run: async () => {
          trace.push('slow:start')
          await new Promise((resolve) => setTimeout(resolve, 10))
          trace.push('slow:end')
        },
      },
    })
    const deps = makeDeps({ registry })
    deps.emit = (name) => trace.push(`event:${name}`)
    await dispatch(
      deps,
      ['s1', 'e1', 'e2'],
      {
        s1: { kind: 'plugin', action: 'slow.act' },
        e1: { kind: 'event', name: 'after-slow-1' },
        e2: { kind: 'event', name: 'after-slow-2' },
      },
    )
    expect(trace).toEqual(['slow:start', 'slow:end', 'event:script-orchestrator/after-slow-1', 'event:script-orchestrator/after-slow-2'])
  })
})

describe('dispatching 取消（契约 03/09：停止派发剩余动作、已执行结果保留；终态优先由 runner 落）', () => {
  it('取消发生在首动作前：全部 skipped、不 emit、canceled=true', async () => {
    const deps = makeDeps({ cancellation: { requested: true, controller: null } })
    const { results, canceled } = await dispatch(
      deps,
      ['e1', 'e2'],
      { e1: { kind: 'event', name: 'one' }, e2: { kind: 'event', name: 'two' } },
    )
    expect(results).toEqual([
      { name: 'e1', kind: 'event', status: 'skipped' },
      { name: 'e2', kind: 'event', status: 'skipped' },
    ])
    expect(deps.emitted).toHaveLength(0)
    expect(canceled).toBe(true)
  })

  it('取消发生在动作执行中：当前动作经其 signal 中止（结果如实记录）、剩余动作 skipped', async () => {
    const registry = makeRegistry({
      'hang.act': {
        name: 'hang.act',
        run: (context) =>
          new Promise((resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('aborted by cancel')))
          }),
      },
    })
    const cancellation = { requested: false, controller: null }
    const deps = makeDeps({ registry, cancellation })
    const promise = dispatch(
      deps,
      ['h1', 'e1', 'e2'],
      {
        h1: { kind: 'plugin', action: 'hang.act' },
        e1: { kind: 'event', name: 'after-hang' },
        e2: { kind: 'event', name: 'never' },
      },
    )
    // 等挂起动作真正开始（controller 已挂上）再取消
    await new Promise((resolve) => setTimeout(resolve, 10))
    cancellation.controller.abort()
    cancellation.requested = true
    const { results, canceled } = await promise
    expect(results[0]).toMatchObject({ name: 'h1', kind: 'plugin', status: 'failed', error: { code: 'action_error' } })
    expect(results[1]).toEqual({ name: 'e1', kind: 'event', status: 'skipped' })
    expect(results[2]).toEqual({ name: 'e2', kind: 'event', status: 'skipped' })
    expect(deps.emitted).toHaveLength(0)
    expect(canceled).toBe(true)
  })

  it('无取消 → canceled=false，全部按序执行', async () => {
    const deps = makeDeps()
    const { canceled, results } = await dispatch(deps, ['e1'], { e1: { kind: 'event', name: 'one' } })
    expect(canceled).toBe(false)
    expect(results[0].status).toBe('succeeded')
  })
})

describe('aggregateRunStatus（契约 09 动作汇总表）', () => {
  const item = (name, status) => ({ name, kind: 'event', status })
  it('零动作 → succeeded；全成功 → succeeded；混合 → partial；全失败 → failed；skipped 不计入成功/失败', () => {
    expect(aggregateRunStatus([])).toBe('succeeded')
    expect(aggregateRunStatus([item('a', 'succeeded'), item('b', 'succeeded')])).toBe('succeeded')
    expect(aggregateRunStatus([item('a', 'succeeded'), item('b', 'failed')])).toBe('partial')
    expect(aggregateRunStatus([item('a', 'failed'), item('b', 'failed')])).toBe('failed')
    expect(aggregateRunStatus([item('a', 'succeeded'), item('b', 'skipped')])).toBe('succeeded')
    expect(aggregateRunStatus([item('a', 'skipped')])).toBe('succeeded')
  })
})

describe('dispatchActions · 进度回调与防御', () => {  it('onActionResult 在每个动作结算后即时回调（runner 用于 live overlay）', async () => {
    const seen = []
    const deps = makeDeps({ onActionResult: (result) => seen.push(result.status) })
    await dispatch(deps, ['e1', 'e2'], { e1: { kind: 'event', name: 'one' }, e2: { kind: 'event', name: 'two' } })
    expect(seen).toEqual(['succeeded', 'succeeded'])
  })

  it('动作键未在 actions 定义（静态校验缺口的防御）→ failed internal_error，不中断后续', async () => {
    const deps = makeDeps()
    const { results } = await dispatch(deps, ['ghost', 'e1'], { e1: { kind: 'event', name: 'one' } })
    expect(results[0]).toMatchObject({ name: 'ghost', status: 'failed', error: { code: 'internal_error' } })
    expect(results[1].status).toBe('succeeded')
  })
})

describe('createActionRegistry（票 30 只需查表与快照面；registerAction 属票 31）', () => {
  it('初始为空：resolve 回 undefined、snapshot 为空数组', () => {
    const registry = createActionRegistry()
    expect(registry.resolve('ops.oncall')).toBeUndefined()
    expect(registry.snapshot()).toEqual([])
  })
})

describe('registry.register / disposer（契约 06 注册动作：票 31 注册面）', () => {
  const definition = (name, over = {}) => ({
    name,
    ...(over.description !== undefined ? { description: over.description } : {}),
    run: over.run ?? (async () => {}),
  })

  it('注册合法动作：resolve 命中并可调用 run；snapshot 按 name 排序返回 { name, description? }', () => {
    const registry = createActionRegistry()
    registry.register(definition('ops.oncall', { description: '按 severity 呼叫值班' }))
    registry.register(definition('alpha.ping'))
    const resolved = registry.resolve('ops.oncall')
    expect(resolved?.name).toBe('ops.oncall')
    expect(resolved?.description).toBe('按 severity 呼叫值班')
    expect(typeof resolved?.run).toBe('function')
    expect(registry.snapshot()).toEqual([
      { name: 'alpha.ping' },
      { name: 'ops.oncall', description: '按 severity 呼叫值班' },
    ])
  })

  it('不合规名字同步抛错（恰好一个点、两段各 ^[a-z][a-z0-9-]{0,29}$）', () => {
    const registry = createActionRegistry()
    for (const bad of [
      'oncall', // 无点
      'ops.oncall.extra', // 两个点
      'Ops.oncall', // 大写
      'ops.Oncall',
      '0ps.oncall', // 段首数字
      'ops.0oncall',
      'ops-oncall', // 无点（连字符）
      `ops.${'a'.repeat(31)}`, // verb 段超长（>30 字符）
      `${'a'.repeat(31)}.oncall`, // namespace 段超长
      'ops.on call', // 空格
      '', // 空串
    ]) {
      expect(() => registry.register(definition(bad)), `名字 '${bad}' 应被拒绝`).toThrow()
    }
  })

  it('边界长度合法：两段各恰好 30 字符（[a-z]+29，整体 61）可注册；31 字符拒绝', () => {
    const registry = createActionRegistry()
    const name = `${'a'.repeat(30)}.${'b'.repeat(30)}`
    expect(name).toHaveLength(61)
    expect(() => registry.register(definition(name))).not.toThrow()
    expect(registry.resolve(name)?.name).toBe(name)
    expect(() => registry.register(definition(`ops.${'a'.repeat(31)}`))).toThrow()
  })

  it('保留前缀 script-orchestrator. 注册即抛错（防冒名内置能力），其余前缀不保留', () => {
    const registry = createActionRegistry()
    expect(() => registry.register(definition('script-orchestrator.oncall'))).toThrow(/script-orchestrator/)
    expect(() => registry.register(definition('script-orchestrator.a'))).toThrow()
    // 非保留前缀正常注册
    expect(() => registry.register(definition('my-plugin.echo'))).not.toThrow()
  })

  it('definition 形状校验：非对象 / name 非字符串 / run 非函数 / description 非字符串 → 同步抛错', () => {
    const registry = createActionRegistry()
    expect(() => registry.register(null)).toThrow()
    expect(() => registry.register(undefined)).toThrow()
    expect(() => registry.register({ description: 'x', run: async () => {} })).toThrow()
    expect(() => registry.register({ name: 'ops.oncall', description: 'x' })).toThrow() // 缺 run
    expect(() => registry.register({ name: 'ops.oncall', run: 'not-a-function' })).toThrow()
    expect(() => registry.register(definition('ops.oncall', { description: 42 }))).toThrow()
  })

  it('重名注册同步抛 Error（消息含冲突名，不覆盖既有注册）', () => {
    const registry = createActionRegistry()
    let called = 0
    registry.register(definition('ops.oncall', { run: async () => { called += 1 } }))
    expect(() => registry.register(definition('ops.oncall', { run: async () => {} }))).toThrow(/ops\.oncall/)
    // 既有注册未被覆盖
    expect(typeof registry.resolve('ops.oncall')?.run).toBe('function')
    expect(registry.snapshot()).toHaveLength(1)
    void registry.resolve('ops.oncall').run()
    expect(called).toBe(1)
  })

  it('disposer 摘除：resolve 回 undefined、snapshot 移除', () => {
    const registry = createActionRegistry()
    const dispose = registry.register(definition('ops.oncall'))
    dispose()
    expect(registry.resolve('ops.oncall')).toBeUndefined()
    expect(registry.snapshot()).toEqual([])
  })

  it('不变量①幂等：disposer 重复调用无害', () => {
    const registry = createActionRegistry()
    const dispose = registry.register(definition('ops.oncall'))
    dispose()
    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow()
  })

  it('不变量②同步：disposer 返回前完成摘除——紧随其后的同名重注册不误冲突', () => {
    const registry = createActionRegistry()
    const dispose1 = registry.register(definition('ops.oncall'))
    dispose1()
    // 同步紧随重注册：若摘除异步，这里会误抛重名冲突
    expect(() => registry.register(definition('ops.oncall'))).not.toThrow()
    expect(registry.snapshot()).toEqual([{ name: 'ops.oncall' }])
  })

  it('不变量③按 token 精确删除：旧 disposer 不误删同名新注册', () => {
    const registry = createActionRegistry()
    const disposeOld = registry.register(definition('ops.oncall', { description: 'v1' }))
    disposeOld()
    const disposeNew = registry.register(definition('ops.oncall', { description: 'v2' }))
    disposeOld() // 旧 disposer 再次调用：不得影响新注册
    expect(registry.resolve('ops.oncall')?.description).toBe('v2')
    expect(registry.snapshot()).toEqual([{ name: 'ops.oncall', description: 'v2' }])
    disposeNew()
    expect(registry.resolve('ops.oncall')).toBeUndefined()
  })

  it('不变量④服务实例隔离：两个注册表实例互不影响（旧实例 disposer 不伤新实例注册表）', () => {
    const oldRegistry = createActionRegistry()
    const newRegistry = createActionRegistry()
    const disposeOld = oldRegistry.register(definition('ops.oncall'))
    disposeOld()
    const disposeNew = newRegistry.register(definition('ops.oncall', { description: '新实例' }))
    // 旧实例的任何操作不影响新实例的表
    expect(newRegistry.resolve('ops.oncall')?.description).toBe('新实例')
    disposeOld()
    expect(newRegistry.resolve('ops.oncall')?.description).toBe('新实例')
    disposeNew()
    expect(newRegistry.resolve('ops.oncall')).toBeUndefined()
  })

  it('disposer 是注册时即刻返回的同步函数（非 Promise）', () => {
    const registry = createActionRegistry()
    const dispose = registry.register(definition('ops.oncall'))
    expect(typeof dispose).toBe('function')
    expect(dispose() === undefined || dispose() === null).toBe(true) // 无返回值负担
  })
})

describe('plugin 动作超时（契约 05 公共约束：默认 30 秒，timeoutSeconds 覆盖；契约 06 ActionContext.signal 中止来源之一）', () => {
  /** 永不自行结算、只在 signal 中止时结算的动作（观察 signal 的合规实现）。 */
  const hangUntilAborted = (onAbort) => ({
    name: 'ops.hang',
    run: (context) =>
      new Promise((resolve) => {
        if (context.signal.aborted) {
          onAbort?.()
          resolve()
          return
        }
        context.signal.addEventListener('abort', () => {
          onAbort?.()
          resolve()
        })
      }),
  })

  it('显式 timeoutSeconds：超时 → failed timeout（消息含动作名与秒数），后续动作照常执行（串行不挂死）', async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      const registry = createActionRegistry()
      registry.register(hangUntilAborted(() => { aborted = true }))
      const deps = makeDeps({ registry })
      const promise = dispatch(
        deps,
        ['hang-page', 'emit-after'],
        {
          'hang-page': { kind: 'plugin', action: 'ops.hang', timeoutSeconds: 2 },
          'emit-after': { kind: 'event', name: 'still-alive' },
        },
      )
      await vi.advanceTimersByTimeAsync(2000)
      const { results, canceled } = await promise
      expect(results[0]).toMatchObject({
        name: 'hang-page',
        kind: 'plugin',
        status: 'failed',
        error: { code: 'timeout', message: expect.stringMatching(/hang-page.*ops\.hang.*2/) },
      })
      expect(results[1]).toEqual({ name: 'emit-after', kind: 'event', status: 'succeeded' })
      expect(deps.emitted[0]?.[0]).toBe('script-orchestrator/still-alive')
      expect(canceled).toBe(false)
      expect(aborted).toBe(true) // 超时即中止 signal（契约 06）
    } finally {
      vi.useRealTimers()
    }
  })

  it('默认 30 秒：未给 timeoutSeconds 的动作按 30 秒超时', async () => {
    vi.useFakeTimers()
    try {
      const registry = createActionRegistry()
      registry.register(hangUntilAborted())
      const deps = makeDeps({ registry })
      const promise = dispatch(deps, ['page'], { page: { kind: 'plugin', action: 'ops.hang' } })
      await vi.advanceTimersByTimeAsync(29_999)
      await expect(Promise.race([promise.then(() => 'done'), Promise.resolve('pending')])).resolves.toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      const { results } = await promise
      expect(results[0]).toMatchObject({ status: 'failed', error: { code: 'timeout' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('在超时内完成 → succeeded（计时器清理，不误判）', async () => {
    vi.useFakeTimers()
    try {
      const registry = createActionRegistry()
      registry.register({
        name: 'ops.quick',
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        },
      })
      const deps = makeDeps({ registry })
      const promise = dispatch(deps, ['page'], { page: { kind: 'plugin', action: 'ops.quick', timeoutSeconds: 5 } })
      await vi.advanceTimersByTimeAsync(1000)
      const { results } = await promise
      expect(results[0]).toEqual({ name: 'page', kind: 'plugin', status: 'succeeded' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('超时优先于迟到失败：timeout 已胜出后实现的 reject 不改写为 action_error，也不产生 unhandled rejection', async () => {
    vi.useFakeTimers()
    try {
      const registry = createActionRegistry()
      registry.register({
        name: 'ops.late-reject',
        run: (context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('aborted too late')))
          }),
      })
      const deps = makeDeps({ registry })
      const promise = dispatch(deps, ['page'], { page: { kind: 'plugin', action: 'ops.late-reject', timeoutSeconds: 1 } })
      await vi.advanceTimersByTimeAsync(1000)
      const { results } = await promise
      expect(results[0].error.code).toBe('timeout')
      // 迟到的 reject 被吞掉（等待一个宏任务回合，若有 unhandled rejection vitest 会失败）
      await vi.advanceTimersByTimeAsync(10)
      await Promise.resolve()
    } finally {
      vi.useRealTimers()
    }
  })

  it('超时前 report() 的 warnings 保留在 failed 记录（与模板警告同数组）', async () => {
    vi.useFakeTimers()
    try {
      const registry = createActionRegistry()
      registry.register({
        name: 'ops.report-then-hang',
        run: async (context) => {
          context.report('已开始呼叫')
          await new Promise((resolve) => context.signal.addEventListener('abort', resolve))
        },
      })
      const deps = makeDeps({ registry })
      const promise = dispatch(deps, ['page'], { page: { kind: 'plugin', action: 'ops.report-then-hang', timeoutSeconds: 1 } })
      await vi.advanceTimersByTimeAsync(1000)
      const { results } = await promise
      expect(results[0]).toMatchObject({ status: 'failed', error: { code: 'timeout' }, warnings: ['已开始呼叫'] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('超时映射进 run 汇总：单动作超时 → failed；与成功动作混合 → partial（aggregateRunStatus）', () => {
    expect(aggregateRunStatus([{ name: 'a', kind: 'plugin', status: 'failed', error: { code: 'timeout', message: '' } }])).toBe('failed')
    expect(
      aggregateRunStatus([
        { name: 'a', kind: 'event', status: 'succeeded' },
        { name: 'b', kind: 'plugin', status: 'failed', error: { code: 'timeout', message: '' } },
      ]),
    ).toBe('partial')
  })
})