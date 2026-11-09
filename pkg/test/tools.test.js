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
  it('产出 script_create / script_list / script_view 三个定义', () => {
    const { definitions } = makeTools()
    expect(definitions.map((d) => d.name)).toEqual(['script_create', 'script_list', 'script_view'])
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
