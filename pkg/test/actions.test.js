// 动作派发器（契约 docs/temp/05-actions.md、06-events-service.md、09-states-errors.md）：
// 按声明顺序串行执行、失败隔离、event 载荷、plugin 注册表查表点（注册本体属票 31）、
// session persistent 投递（执行面属本票；ephemeral 属票 33）、dispatching 取消停止剩余派发、动作汇总。
import { describe, it, expect } from 'vitest'
import { dispatchActions, aggregateRunStatus, createActionRegistry } from '../lib/actions.js'
import { buildFirstMessageText } from '../lib/session-action.js'

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
})

describe('session 动作（persistent 执行面属票 32；ephemeral 属票 33）', () => {
  /** fake 宿主会话服务（记录调用，可注入投递各环节失败）。 */
  function makeSessionHost(over = {}) {
    const calls = { create: [], rename: [], followup: [], flush: [] }
    const fakeSession = { id: 'fake-session' }
    const agent = {
      session: fakeSession,
      model: { select: () => {} },
      followup: (message) => {
        calls.followup.push(message)
        if (over.followupError) throw over.followupError
      },
    }
    return {
      host: {
        sessionController: {
          create: async (request) => {
            calls.create.push(request)
            if (over.createError) throw over.createError
            return { sessionId: request.sessionId }
          },
          resolveAgent: async () => ({ agent }),
        },
        sessions: {
          flush: async () => {
            calls.flush.push(true)
            if (over.flushError) throw over.flushError
            return true
          },
        },
        getSessionTitle: () =>
          over.noTitleService
            ? undefined
            : { rename: (session, title) => { calls.rename.push(title); if (over.renameError) throw over.renameError } },
      },
      calls,
    }
  }

  const sessionEnv = { allowedRoots: [], defaultCwd: undefined, hostCwd: 'D:\\host', scriptCwd: 'D:\\proj' }

  it('persistent：prompt 渲染进首条消息正文（模板警告进记录），投递成功 → succeeded 且记录 sessionId', async () => {
    const { host, calls } = makeSessionHost()
    const deps = makeDeps({ sessionHost: host, sessionEnv })
    const { results } = await dispatch(
      deps,
      ['open-triage'],
      { 'open-triage': { kind: 'session', prompt: '退出码 {{exitCode}}，stdout：{{stdoutTail}}' } },
    )
    expect(results[0]).toMatchObject({ name: 'open-triage', kind: 'session', status: 'succeeded' })
    expect(results[0].sessionId).toBe(calls.create[0].sessionId) // run.actions[].sessionId = create 返回的会话 id
    expect(results[0].sessionId).toMatch(/^session-[0-9a-f-]{36}$/)
    expect(results[0].warnings).toBeUndefined() // 无警告时省略键
    expect(calls.rename).toEqual(['夜间部署巡检 · 1a9e'])
    const message = calls.followup[0]
    expect(message.role).toBe('user')
    expect(message.source).toEqual({ kind: 'user' })
    expect(message.content[0].text).toBe(
      buildFirstMessageText({
        run: deps.run,
        verdict: { matchedRule: VERDICT.matchedRule, usedFallback: VERDICT.usedFallback },
        prompt: '退出码 0，stdout：deploy ok',
        framing: 'banner',
      }),
    )
  })

  it('followup 抛错（已 dispose 会话实证路径）→ failed delivery_failed，sessionId 保留在动作记录（失败隔离：后续动作照常）', async () => {
    const { host } = makeSessionHost({ followupError: new Error('cannot append outside a SessionStore') })
    const deps = makeDeps({ sessionHost: host, sessionEnv })
    const { results } = await dispatch(
      deps,
      ['bad-session', 'emit-ok'],
      { 'bad-session': { kind: 'session', prompt: 'p' }, 'emit-ok': { kind: 'event', name: 'deploy-ok' } },
    )
    expect(results[0]).toMatchObject({ status: 'failed', error: { code: 'delivery_failed' } })
    expect(results[0].sessionId).toMatch(/^session-/)
    expect(results[0].error.message).toContain(results[0].sessionId)
    expect(results[1].status).toBe('succeeded')
  })

  it('session cwd 越界（sessionEnv.allowedRoots）→ failed cwd_not_allowed，不创建会话', async () => {
    const { host, calls } = makeSessionHost()
    const deps = makeDeps({
      sessionHost: host,
      sessionEnv: { ...sessionEnv, allowedRoots: ['D:\\proj'] },
    })
    const { results } = await dispatch(
      deps,
      ['s1'],
      { s1: { kind: 'session', prompt: 'p', cwd: 'E:\\evil' } },
    )
    expect(results[0]).toMatchObject({ status: 'failed', error: { code: 'cwd_not_allowed' } })
    expect(results[0].sessionId).toBeUndefined()
    expect(calls.create).toEqual([])
  })

  it('preset 解析失败 → failed preset_unknown；rename 失败仅记 warnings 不失败动作', async () => {
    const presetHost = makeSessionHost({ createError: Object.assign(new Error('Unknown agent preset: nope'), { code: 'agent-preset/not-found' }) })
    const depsA = makeDeps({ sessionHost: presetHost.host, sessionEnv })
    const { results: resultsA } = await dispatch(depsA, ['s1'], { s1: { kind: 'session', prompt: 'p', preset: 'nope' } })
    expect(resultsA[0]).toMatchObject({ status: 'failed', error: { code: 'preset_unknown' } })
    expect(resultsA[0].sessionId).toBeUndefined()

    const renamedHost = makeSessionHost({ renameError: new Error('title invalid') })
    const depsB = makeDeps({ sessionHost: renamedHost.host, sessionEnv })
    const { results: resultsB } = await dispatch(depsB, ['s2'], { s2: { kind: 'session', prompt: 'p' } })
    expect(resultsB[0].status).toBe('succeeded')
    expect(resultsB[0].warnings.some((w) => w.includes('标题重命名失败'))).toBe(true)
  })

  it('宿主会话服务未注入（防御）→ failed internal_error', async () => {
    const deps = makeDeps()
    const { results } = await dispatch(deps, ['s1'], { s1: { kind: 'session', prompt: 'p' } })
    expect(results[0]).toMatchObject({ status: 'failed', error: { code: 'internal_error' } })
    expect(results[0].error.message).toContain('宿主会话服务')
  })

  it('mode: ephemeral 执行面属票 33：failed action_error 占位（消息注明票 33，不含 32）', async () => {
    const { host } = makeSessionHost()
    const deps = makeDeps({ sessionHost: host, sessionEnv })
    const { results } = await dispatch(
      deps,
      ['s1'],
      { s1: { kind: 'session', mode: 'ephemeral', prompt: 'p', idleDisposeSeconds: 5 } },
    )
    expect(results[0]).toMatchObject({ status: 'failed', error: { code: 'action_error' } })
    expect(results[0].error.message).toContain('33')
    expect(results[0].error.message).not.toContain('32')
    expect(results[0].sessionId).toBeUndefined()
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

describe('dispatchActions · 进度回调与防御', () => {
  it('onActionResult 在每个动作结算后即时回调（runner 用于 live overlay）', async () => {
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