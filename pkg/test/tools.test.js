import { describe, it, expect, vi } from 'vitest'
import { createToolDefinitions } from '../lib/tools.js'
import { OrchestratorError } from '../lib/errors.js'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const VIEW = {
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

const RUN_VIEW = {
  runId: 'run-7f3c1a9e',
  orchestrationId: 'log-rotate',
  trigger: 'manual',
  scheduledAt: '2026-11-09T00:00:00.000Z',
  startedAt: '2026-11-09T00:00:01.000Z',
  settledAt: '2026-11-09T00:00:02.000Z',
  status: 'succeeded',
  skipReason: null,
  script: { command: 'pwsh', exitCode: 0, signal: null, timedOut: false, durationMs: 1000, stdoutTail: '', stderrTail: '', truncated: false },
  matchedRule: null,
  usedFallback: false,
  actions: [],
}

/** 记录调用并按脚本回放的 fake 服务。 */
function fakeService(script = {}) {
  const calls = []
  return {
    calls,
    create: script.create ?? (async (input, actorSessionId, signal) => {
      calls.push(['create', input, actorSessionId, signal])
      return { ...VIEW }
    }),
    list: script.list ?? (async (query) => {
      calls.push(['list', query])
      return { items: [{ ...VIEW }], total: 1, nextOffset: null }
    }),
    view: script.view ?? (async (id, options) => {
      calls.push(['view', id, options])
      return { ...VIEW, runs: [], availableActions: [] }
    }),
    edit: script.edit ?? (async (input, actorSessionId, signal) => {
      calls.push(['edit', input, actorSessionId, signal])
      return { ...VIEW }
    }),
    run: script.run ?? (async (id, signal) => {
      calls.push(['run', id, signal])
      return { ...RUN_VIEW, status: 'queued', settledAt: null }
    }),
    waitRun: script.waitRun ?? (async (runId, id) => {
      calls.push(['waitRun', runId, id])
      return { ...RUN_VIEW }
    }),
    computeWaitBudgetMs: script.computeWaitMs ?? (() => 330_000),
    cancelRun: script.cancelRun ?? ((runId) => {
      calls.push(['cancelRun', runId])
      return true
    }),
    waitForRun: script.waitForRun ?? ((runId) => {
      calls.push(['waitForRun', runId])
      return Promise.resolve({ ...RUN_VIEW, status: 'canceled' })
    }),
  }
}

function makeTools(serviceScript, logger = { error: () => {}, warn: () => {} }) {
  const service = fakeService(serviceScript)
  const definitions = createToolDefinitions({ service, logger })
  const byName = Object.fromEntries(definitions.map((d) => [d.name, d]))
  return { service, definitions, byName }
}

const baseInput = () => ({
  title: 'log rotate',
  trigger: { kind: 'every', everySeconds: 300 },
  script: { command: 'pwsh' },
  judge: { rules: [], fallback: [] },
  actions: {},
})

describe('createToolDefinitions（契约 docs/temp/07-tools.md 适配层约定）', () => {
  it('产出 script_create / script_list / script_view / script_edit / script_run 五个定义', () => {
    const { definitions } = makeTools()
    expect(definitions.map((d) => d.name)).toEqual(['script_create', 'script_list', 'script_view', 'script_edit', 'script_run'])
    for (const definition of definitions) {
      expect(typeof definition.description).toBe('string')
      expect(definition.description.length).toBeGreaterThan(10)
      expect(definition.parameters.type).toBe('object')
      expect(definition.parameters.additionalProperties).toBe(false)
      expect(definition.output).toBeTruthy()
      expect(typeof definition.output.render).toBe('function')
    }
  })

  it('parameters 与 output.schema 均在宿主支持的 JSON Schema 子集内', () => {
    const { definitions } = makeTools()
    for (const definition of definitions) {
      expect(() => assertSupportedJsonSchema(definition.parameters)).not.toThrow()
      expect(() => assertSupportedJsonSchema(definition.output.schema)).not.toThrow()
    }
  })

  it('render 统一返回单块 JSON 文本', () => {
    const { byName } = makeTools()
    const blocks = byName.script_create.output.render({}, VIEW)
    expect(blocks).toEqual([{ type: 'text', text: JSON.stringify(VIEW) }])
  })

  it('output.schema 的 oneOf 恰一匹配：成功形状与各契约错误形状互斥', () => {
    const { byName } = makeTools()
    const detail = { ...VIEW, runs: [], availableActions: [] }
    expect(validateJsonSchemaValue(byName.script_create.output.schema, VIEW)).toEqual([])
    expect(validateJsonSchemaValue(byName.script_list.output.schema, { items: [], total: 0, nextOffset: null })).toEqual([])
    expect(validateJsonSchemaValue(byName.script_view.output.schema, detail)).toEqual([])
    const invalid = { code: 'script_input_invalid', message: 'x', details: { field: 'f', reason: 'unexpected' } }
    expect(validateJsonSchemaValue(byName.script_create.output.schema, invalid)).toEqual([])
    const unknown = { code: 'script_unknown', message: 'x', details: { id: 'y' } }
    expect(validateJsonSchemaValue(byName.script_view.output.schema, unknown)).toEqual([])
    const internal = { code: 'internal_error', message: 'x' }
    expect(validateJsonSchemaValue(byName.script_view.output.schema, internal)).toEqual([])
    // 既非成功也非错误形状的值必须被拒绝（oneOf 恰一）
    expect(validateJsonSchemaValue(byName.script_create.output.schema, { bogus: 1 })).not.toEqual([])
    expect(validateJsonSchemaValue(byName.script_view.output.schema, VIEW)).not.toEqual([])
  })
})

describe('script_create.execute', () => {
  it('合法输入 → service.create 收到原样参数 + actorSessionId + signal，返回 OrchestrationView 值', async () => {
    const { byName, service } = makeTools()
    const signal = new AbortController().signal
    const exec = { agent: { session: 'session-abc' }, signal }
    const result = await byName.script_create.execute(baseInput(), exec)
    expect(result).toEqual(VIEW)
    expect(service.calls).toEqual([['create', baseInput(), 'session-abc', signal]])
  })

  it('exec 缺 agent 时 actorSessionId 为 undefined', async () => {
    const { byName, service } = makeTools()
    await byName.script_create.execute(baseInput(), {})
    expect(service.calls[0][2]).toBeUndefined()
  })

  it.each([
    ['多余顶层字段', { ...baseInput(), extra: 1 }, 'extra', 'unexpected'],
    ['缺 title', (() => { const i = baseInput(); delete i.title; return i })(), 'title', 'missing'],
    ['title 类型错', { ...baseInput(), title: 5 }, 'title', 'format'],
    ['trigger 未声明的多余字段', { ...baseInput(), trigger: { kind: 'every', everySeconds: 300, foo: 1 } }, 'trigger.foo', 'unexpected'],
    ['trigger.kind 非法枚举', { ...baseInput(), trigger: { kind: 'daily' } }, 'trigger.kind', 'format'],
    ['everySeconds 类型错', { ...baseInput(), trigger: { kind: 'every', everySeconds: '300' } }, 'trigger.everySeconds', 'format'],
    ['mode 越枚举', { ...baseInput(), trigger: { kind: 'every', everySeconds: 300, mode: 'bogus' } }, 'trigger.mode', 'format'],
    ['expression 类型错', { ...baseInput(), trigger: { kind: 'cron', expression: 42, timeZone: 'UTC' } }, 'trigger.expression', 'format'],
    ['args 元素类型错', { ...baseInput(), script: { command: 'pwsh', args: [1] } }, 'script.args[0]', 'format'],
    ['actions 非对象', { ...baseInput(), actions: [] }, 'actions', 'format'],
    ['缺 actions', (() => { const i = baseInput(); delete i.actions; return i })(), 'actions', 'missing'],
  ])('schema 校验：%s → script_input_invalid（%s/%s）', async (_label, args, field, reason) => {
    const { byName, service } = makeTools()
    const result = await byName.script_create.execute(args, {})
    expect(result).toMatchObject({ code: 'script_input_invalid', details: { field, reason } })
    expect(service.calls).toEqual([])
  })

  it('schema 声明 trigger 字段全集：合法 cron 输入放行（每 kind 判别与语义校验归服务层）', async () => {
    const { byName, service } = makeTools()
    const cronArgs = { ...baseInput(), trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' } }
    const result = await byName.script_create.execute(cronArgs, {})
    expect(result).toEqual({ ...VIEW })
    expect(service.calls).toEqual([['create', cronArgs, undefined, undefined]])
  })

  it('every 混入 cron 字段：schema 放行、服务判别拒绝（trigger.expression unexpected）原样透传', async () => {
    const { byName, service } = makeTools({
      create: async () => {
        throw new OrchestratorError('script_input_invalid', "kind: 'every' 不接受 trigger.expression", {
          field: 'trigger.expression',
          reason: 'unexpected',
        })
      },
    })
    const result = await byName.script_create.execute(
      { ...baseInput(), trigger: { kind: 'every', everySeconds: 300, expression: '0 3 * * *' } },
      {},
    )
    expect(result).toEqual({
      code: 'script_input_invalid',
      message: "kind: 'every' 不接受 trigger.expression",
      details: { field: 'trigger.expression', reason: 'unexpected' },
    })
    expect(service.calls).toEqual([])
  })

  it('根参数非对象 → field: arguments', async () => {
    const { byName, service } = makeTools()
    const result = await byName.script_create.execute('nope', {})
    expect(result).toMatchObject({ code: 'script_input_invalid', details: { field: 'arguments', reason: 'format' } })
    expect(service.calls).toEqual([])
  })

  it('schema 放行但服务拒绝（everySeconds 30 → too-frequent）原样透传服务契约错误', async () => {
    const { byName, service } = makeTools()
    service.create = async () => {
      throw new OrchestratorError('script_input_invalid', '低于 60 秒硬性下限', {
        field: 'trigger.everySeconds',
        reason: 'too-frequent',
      })
    }
    const result = await byName.script_create.execute({ ...baseInput(), trigger: { kind: 'every', everySeconds: 30 } }, {})
    expect(result).toEqual({
      code: 'script_input_invalid',
      message: '低于 60 秒硬性下限',
      details: { field: 'trigger.everySeconds', reason: 'too-frequent' },
    })
  })

  it('服务抛未分类异常 → internal_error 值并记内部日志', async () => {
    const errors = []
    const { byName } = makeTools({ create: async () => { throw new Error('boom') } }, { error: (m) => errors.push(m), warn: () => {} })
    const result = await byName.script_create.execute(baseInput(), {})
    expect(result).toMatchObject({ code: 'internal_error' })
    expect(result.message).toContain('boom')
    expect(errors.some((m) => m.includes('script_create'))).toBe(true)
  })

  it('exec.signal 已中止 → 异常上抛（宿主 abort 规范结果接管，不吞成业务错误）', async () => {
    const { byName } = makeTools({
      create: async (_input, _actor, signal) => {
        signal.throwIfAborted()
      },
    })
    const controller = new AbortController()
    controller.abort()
    await expect(
      byName.script_create.execute(baseInput(), { signal: controller.signal }),
    ).rejects.toThrow()
  })
})

describe('script_list.execute', () => {
  it('合法查询原样透传 service.list', async () => {
    const { byName, service } = makeTools()
    const result = await byName.script_list.execute({ active: true, limit: 2, offset: 0 }, {})
    expect(result).toEqual({ items: [VIEW], total: 1, nextOffset: null })
    expect(service.calls).toEqual([['list', { active: true, limit: 2, offset: 0 }]])
  })

  it('多余字段 → unexpected；limit 类型错 → format', async () => {
    const { byName } = makeTools()
    await expect(byName.script_list.execute({ deep: 1 }, {})).resolves.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'deep', reason: 'unexpected' },
    })
    await expect(byName.script_list.execute({ limit: '20' }, {})).resolves.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'limit', reason: 'format' },
    })
  })
})

describe('script_view.execute', () => {
  it('id 必填、runs 可选；原样透传 service.view（runs 未给时不传）', async () => {
    const { byName, service } = makeTools()
    await byName.script_view.execute({ id: 'log-rotate' }, {})
    expect(service.calls).toEqual([['view', 'log-rotate', {}]])
    await byName.script_view.execute({ id: 'log-rotate', runs: 10 }, {})
    expect(service.calls[1]).toEqual(['view', 'log-rotate', { runs: 10 }])
  })

  it('缺 id → missing；服务 script_unknown 透传', async () => {
    const { byName } = makeTools()
    await expect(byName.script_view.execute({}, {})).resolves.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'id', reason: 'missing' },
    })
    const { byName: tools2 } = makeTools({
      view: async () => {
        throw new OrchestratorError('script_unknown', "编排 'x' 不存在", { id: 'x' })
      },
    })
    await expect(tools2.script_view.execute({ id: 'x' }, {})).resolves.toEqual({
      code: 'script_unknown',
      message: "编排 'x' 不存在",
      details: { id: 'x' },
    })
  })
})

describe('script_edit.execute（契约 07 script_edit：四 action 透传 + 乐观并发）', () => {
  it('合法 update/pause/resume 原样透传 service.edit（含 actorSessionId/signal/expectedUpdatedAt），返回 OrchestrationView 值', async () => {
    const { byName, service } = makeTools()
    const signal = new AbortController().signal
    const exec = { agent: { session: 'session-xyz' }, signal }
    const editInput = { id: 'log-rotate', action: 'update', patch: { title: 'new' }, expectedUpdatedAt: VIEW.updatedAt }
    const result = await byName.script_edit.execute(editInput, exec)
    expect(result).toEqual(VIEW)
    expect(service.calls).toEqual([['edit', editInput, 'session-xyz', signal]])
    await byName.script_edit.execute({ id: 'log-rotate', action: 'pause' }, {})
    expect(service.calls[1]).toEqual(['edit', { id: 'log-rotate', action: 'pause' }, undefined, undefined])
    await byName.script_edit.execute({ id: 'log-rotate', action: 'resume', expectedUpdatedAt: null }, {})
    expect(service.calls[2]).toEqual(['edit', { id: 'log-rotate', action: 'resume', expectedUpdatedAt: null }, undefined, undefined])
  })

  it.each([
    ['action 非法枚举', { id: 'x', action: 'bogus' }, 'action', 'format'],
    ['多余字段', { id: 'x', action: 'pause', deep: 1 }, 'deep', 'unexpected'],
    ['缺 id', { action: 'pause' }, 'id', 'missing'],
    ['patch 类型错', { id: 'x', action: 'update', patch: 'nope' }, 'patch', 'format'],
    ['patch 未声明字段', { id: 'x', action: 'update', patch: { bogus: 1 } }, 'patch.bogus', 'unexpected'],
    ['expectedUpdatedAt 类型错', { id: 'x', action: 'pause', expectedUpdatedAt: 42 }, 'expectedUpdatedAt', 'format'],
  ])('schema 校验：%s → script_input_invalid（%s/%s）', async (_label, args, field, reason) => {
    const { byName, service } = makeTools()
    const result = await byName.script_edit.execute(args, {})
    expect(result).toMatchObject({ code: 'script_input_invalid', details: { field, reason } })
    expect(service.calls).toEqual([])
  })

  it('服务契约错误原样透传：script_conflict / script_unknown / script_input_invalid', async () => {
    const { byName } = makeTools({
      edit: async () => {
        throw new OrchestratorError('script_conflict', '已被其他修改', { expected: 'a', actual: 'b' })
      },
    })
    await expect(byName.script_edit.execute({ id: 'x', action: 'pause' }, {})).resolves.toEqual({
      code: 'script_conflict',
      message: '已被其他修改',
      details: { expected: 'a', actual: 'b' },
    })
    const { byName: t2 } = makeTools({
      edit: async () => {
        throw new OrchestratorError('script_unknown', "编排 'x' 不存在", { id: 'x' })
      },
    })
    await expect(t2.script_edit.execute({ id: 'x', action: 'resume' }, {})).resolves.toMatchObject({ code: 'script_unknown' })
    const { byName: t3 } = makeTools({
      edit: async () => {
        throw new OrchestratorError('script_input_invalid', 'delete 尚未实现', { field: 'action', reason: 'unsupported-part' })
      },
    })
    await expect(t3.script_edit.execute({ id: 'x', action: 'delete' }, {})).resolves.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'action', reason: 'unsupported-part' },
    })
  })
})

describe('script_run.execute（契约 07 script_run：wait 语义）', () => {
  it('wait 默认 true：受理后尽力等待，返回终态 RunView 值', async () => {
    const { byName, service } = makeTools()
    const result = await byName.script_run.execute({ id: 'log-rotate' }, {})
    expect(result).toEqual(RUN_VIEW)
    expect(service.calls).toEqual([['run', 'log-rotate', undefined], ['waitRun', 'run-7f3c1a9e', 'log-rotate']])
  })

  it('wait:false 立即返回简形 { runId, status }（受理即回，不等结算）', async () => {
    const { byName, service } = makeTools()
    const result = await byName.script_run.execute({ id: 'log-rotate', wait: false }, {})
    expect(result).toEqual({ runId: 'run-7f3c1a9e', status: 'queued' })
    expect(service.calls).toEqual([['run', 'log-rotate', undefined]])
  })

  it('wait:true 等待超限：返回非终态 RunView、不报错（服务 waitRun 语义透传）', async () => {
    const { byName } = makeTools({
      run: async () => ({ ...RUN_VIEW, status: 'queued', settledAt: null }),
      waitRun: async () => ({ ...RUN_VIEW, status: 'queued', settledAt: null }),
    })
    const result = await byName.script_run.execute({ id: 'log-rotate' }, {})
    expect(result).toMatchObject({ runId: 'run-7f3c1a9e', status: 'queued' })
  })

  it('schema 校验：wait 类型错 → format；多余字段 → unexpected；服务 script_unknown 透传', async () => {
    const { byName, service } = makeTools()
    await expect(byName.script_run.execute({ id: 'x', wait: 'yes' }, {})).resolves.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'wait', reason: 'format' },
    })
    await expect(byName.script_run.execute({ id: 'x', deep: 1 }, {})).resolves.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'deep', reason: 'unexpected' },
    })
    expect(service.calls).toEqual([])
    const { byName: t2 } = makeTools({
      run: async () => {
        throw new OrchestratorError('script_unknown', "编排 'x' 不存在", { id: 'x' })
      },
    })
    await expect(t2.script_run.execute({ id: 'x' }, {})).resolves.toEqual({
      code: 'script_unknown',
      message: "编排 'x' 不存在",
      details: { id: 'x' },
    })
  })
})

describe('script_run · exec.signal 贯穿（契约 03「exec.signal 贯穿与静止」；票 29）', () => {
  it('signal 已中止（预取消）→ 异常上抛、不受理（无 run 记录动作）', async () => {
    const controller = new AbortController()
    controller.abort()
    const { byName, service } = makeTools({
      run: async (_id, signal) => {
        signal?.throwIfAborted()
        throw new Error('不应受理')
      },
    })
    await expect(byName.script_run.execute({ id: 'log-rotate' }, { signal: controller.signal })).rejects.toThrow()
    expect(service.calls).toEqual([])
  })

  it('wait:true + 等待中 abort：先 cancelRun → 等 run 结算持久化（waitForRun）→ 才以 AbortError 静止', async () => {
    const controller = new AbortController()
    let releaseWait
    const { byName, service } = makeTools({
      run: async () => ({ ...RUN_VIEW, status: 'running', settledAt: null }),
      waitRun: () =>
        new Promise((resolve) => {
          releaseWait = resolve
        }),
    })
    const pending = byName.script_run.execute({ id: 'log-rotate' }, { signal: controller.signal })
    // 拒绝断言预先挂接（避免拒绝后短窗口无处理器被 Node 记为 unhandled）
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort() // 等待中中止
    await new Promise((resolve) => setTimeout(resolve, 10))
    // 顺序：cancelRun 先于 waitForRun；AbortError 在 waitForRun 完成后才抛
    const cancelIndex = service.calls.findIndex(([op]) => op === 'cancelRun')
    const waitIndex = service.calls.findIndex(([op]) => op === 'waitForRun')
    expect(cancelIndex).toBeGreaterThanOrEqual(0)
    expect(waitIndex).toBeGreaterThan(cancelIndex)
    await assertion
  })

  it('wait:true + 结算后到达的 abort：不取消（自然完成返回 RunView，迟到 cancelRun 不发生）', async () => {
    const controller = new AbortController()
    const { byName, service } = makeTools()
    const result = await byName.script_run.execute({ id: 'log-rotate' }, { signal: controller.signal })
    expect(result).toEqual(RUN_VIEW)
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(service.calls.some(([op]) => op === 'cancelRun')).toBe(false)
  })

  it('wait:false + 返回后 abort：受理的 run 同样被取消（取消不依赖等待者），工具值已静止', async () => {
    const controller = new AbortController()
    const { byName, service } = makeTools({
      run: async () => ({ ...RUN_VIEW, status: 'running', settledAt: null }),
    })
    const result = await byName.script_run.execute({ id: 'log-rotate', wait: false }, { signal: controller.signal })
    expect(result).toEqual({ runId: 'run-7f3c1a9e', status: 'running' })
    expect(service.calls.some(([op]) => op === 'cancelRun')).toBe(false) // 返回前未取消
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(service.calls.some(([op]) => op === 'cancelRun')).toBe(true) // 返回后取消照常发生
  })
})
