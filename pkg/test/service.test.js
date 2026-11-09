import { describe, it, expect } from 'vitest'
import { createManagementService } from '../lib/service.js'
import { OrchestratorError } from '../lib/errors.js'
import { ServiceQueue } from '../lib/fifo.js'

/** 内存存储 fake：记录调用序列（put/emit 次序断言用）。 */
function makeStorage() {
  const tables = { orchestrations: new Map(), runs: new Map() }
  const calls = []
  return {
    table: (name) => ({
      entries: () => tables[name].entries(),
      get: (key) => tables[name].get(key),
      put: (key, value) => {
        calls.push(['put', name, key])
        tables[name].set(key, value)
        return Promise.resolve()
      },
      delete: (key) => {
        calls.push(['delete', name, key])
        tables[name].delete(key)
        return Promise.resolve()
      },
    }),
    calls,
    snapshot: () => ({ orchestrations: Object.fromEntries(tables.orchestrations), runs: Object.fromEntries(tables.runs) }),
  }
}

const NOW = 1_790_000_000_000
const iso = (ms) => new Date(ms).toISOString()

function makeService(over = {}) {
  const storage = over.storage ?? makeStorage()
  const emitted = []
  const logs = []
  const service = createManagementService({
    storage,
    queue: new ServiceQueue(),
    config: { maxRunsPerOrchestration: 100 },
    now: over.now ?? (() => NOW),
    emit: over.emit ?? ((name, payload) => emitted.push([name, payload])),
    logger: over.logger ?? { error: (m) => logs.push(m), warn: (m) => logs.push(m) },
    actionRegistry: over.actionRegistry,
  })
  return { service, storage, emitted, logs }
}

/** 契约形状的最小合法 every 输入（01-domain-model 完整示例的裁剪）。 */
const baseInput = () => ({
  title: 'log rotate',
  trigger: { kind: 'every', everySeconds: 300 },
  script: { command: 'pwsh', args: ['-File', 'rotate.ps1'] },
  judge: { rules: [{ when: { exitCode: 0 }, actions: ['emit-ok'] }], fallback: [] },
  actions: { 'emit-ok': { kind: 'event', name: 'rotate-ok' } },
})

describe('create（契约 docs/temp/06-events-service.md：校验 → 生成 id → 落库 → 计算 nextOccurrence → 发 changed）', () => {
  it('成功创建 active 编排：返回完整 OrchestrationView（默认值归一化、下次时刻 = createdAt + everySeconds）', async () => {
    const { service } = makeService()
    const view = await service.create(baseInput())
    expect(view).toEqual({
      id: 'log-rotate',
      title: 'log rotate',
      enabled: true,
      overlap: 'skip',
      trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-rate' },
      script: { command: 'pwsh', args: ['-File', 'rotate.ps1'], env: {} },
      judge: { rules: [{ when: { exitCode: 0 }, actions: ['emit-ok'] }], fallback: [] },
      actions: { 'emit-ok': { kind: 'event', name: 'rotate-ok' } },
      createdAt: iso(NOW),
      updatedAt: iso(NOW),
      status: 'active',
      nextOccurrence: iso(NOW + 300_000),
    })
  })

  it('fixed-delay 首次计划同为 createdAt + everySeconds（契约 02「创建」）', async () => {
    const { service } = makeService()
    const view = await service.create({ ...baseInput(), trigger: { kind: 'every', everySeconds: 1800, mode: 'fixed-delay' } })
    expect(view.status).toBe('active')
    expect(view.nextOccurrence).toBe(iso(NOW + 1_800_000))
  })

  it('持久化到 orchestrations 表且在持久写入完成后发布一次 changed（无载荷）', async () => {
    const { service, storage, emitted } = makeService()
    const view = await service.create(baseInput())
    const record = storage.table('orchestrations').get('log-rotate')
    expect(record).toEqual(view)
    expect(emitted).toEqual([['script-orchestrator/changed', undefined]])
    // put 先于 emit（契约 06 回读一致性：changed 在持久写入完成后）
    const putIndex = storage.calls.findIndex(([op, table]) => op === 'put' && table === 'orchestrations')
    expect(putIndex).toBe(0)
  })

  it('enabled:false 创建为 paused、nextOccurrence = null，仍持久化并发布 changed', async () => {
    const { service, emitted } = makeService()
    const view = await service.create({ ...baseInput(), enabled: false })
    expect(view.status).toBe('paused')
    expect(view.enabled).toBe(false)
    expect(view.nextOccurrence).toBeNull()
    expect(emitted).toHaveLength(1)
  })

  it('创建不立即执行脚本：runs 表无任何写入', async () => {
    const { service, storage } = makeService()
    await service.create(baseInput())
    expect(storage.snapshot().runs).toEqual({})
    expect(storage.calls.filter(([op, table]) => op === 'put' && table === 'runs')).toEqual([])
  })

  it('id 省略由标题生成；纯中文标题回退 orchestration；重名追加 -2 后缀', async () => {
    const { service } = makeService()
    expect((await service.create(baseInput())).id).toBe('log-rotate')
    expect((await service.create({ ...baseInput(), title: '  log  rotate! ' })).id).toBe('log-rotate-2')
    expect((await service.create({ ...baseInput(), title: '夜间巡检' })).id).toBe('orchestration')
    expect((await service.create({ ...baseInput(), title: '部署' })).id).toBe('orchestration-2')
  })

  it('显式 id 保留；重复 id → script_input_invalid（reason: taken）', async () => {
    const { service } = makeService()
    const view = await service.create({ ...baseInput(), id: 'nightly-check' })
    expect(view.id).toBe('nightly-check')
    await expect(service.create({ ...baseInput(), id: 'nightly-check' })).rejects.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'id', reason: 'taken' },
    })
  })

  it('emit listener 同步抛错：create 仍成功，logger 记 event_listener_failed（发布端兜底）', async () => {
    const { service, logs } = makeService({
      emit: () => {
        throw new Error('listener boom')
      },
    })
    const view = await service.create(baseInput())
    expect(view.id).toBe('log-rotate')
    expect(logs.some((m) => m.includes('event_listener_failed') && m.includes('script-orchestrator/changed'))).toBe(true)
  })
})

describe('view（契约 06：单条详情 + 最近 runs + availableActions）', () => {
  it('返回记录 + runs: [] + availableActions: []（票 25 无执行、无注册动作）', async () => {
    const { service } = makeService()
    const created = await service.create(baseInput())
    const detail = await service.view(created.id)
    expect(detail).toEqual({ ...created, runs: [], availableActions: [] })
  })

  it('注入共享注册表时 listActions/availableActions 委托其 snapshot（票 30 查表点接线；registerAction 属票 31）', async () => {
    const { service } = makeService({
      actionRegistry: {
        resolve: () => undefined,
        snapshot: () => [
          { name: 'ops.oncall', description: '按 severity 呼叫值班' },
          { name: 'ops.notify' },
        ],
      },
    })
    expect(service.listActions()).toEqual([
      { name: 'ops.oncall', description: '按 severity 呼叫值班' },
      { name: 'ops.notify' },
    ])
    const created = await service.create(baseInput())
    await expect(service.view(created.id)).resolves.toMatchObject({
      availableActions: [
        { name: 'ops.oncall', description: '按 severity 呼叫值班' },
        { name: 'ops.notify' },
      ],
    })
  })

  it('runs 选项默认 5，0–50 合法，越界/非整数 → script_input_invalid（range/format）', async () => {
    const { service } = makeService()
    const created = await service.create(baseInput())
    await expect(service.view(created.id, { runs: 50 })).resolves.toMatchObject({ runs: [] })
    await expect(service.view(created.id, { runs: 0 })).resolves.toMatchObject({ runs: [] })
    await expect(service.view(created.id, { runs: 51 })).rejects.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'runs', reason: 'range' },
    })
    await expect(service.view(created.id, { runs: 1.5 })).rejects.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'runs', reason: 'format' },
    })
  })

  it('未知 id → script_unknown（details.id）', async () => {
    const { service } = makeService()
    await expect(service.view('nope')).rejects.toMatchObject({
      code: 'script_unknown',
      details: { id: 'nope' },
    })
  })

  it('多余选项字段 → unexpected', async () => {
    const { service } = makeService()
    await expect(service.view('x', { runs: 1, deep: true })).rejects.toMatchObject({
      details: { field: 'deep', reason: 'unexpected' },
    })
  })

  it('合并 runner 活动视图：内存态（running 等）实时出现在 runs（中途状态不落盘）', async () => {
    // fake runner：liveView 对特定 runId 给出 running 覆盖
    const storage = makeStorage()
    const queue = new ServiceQueue()
    await queue.enqueue(async () => {
      storage.table('orchestrations').put('log-rotate', {
        id: 'log-rotate',
        title: 'log rotate',
        enabled: true,
        overlap: 'skip',
        trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-rate' },
        script: { command: 'pwsh', args: ['-File', 'rotate.ps1'], env: {} },
        judge: { rules: [], fallback: [] },
        actions: {},
        createdAt: iso(NOW - 600_000),
        updatedAt: iso(NOW - 600_000),
        status: 'active',
        nextOccurrence: iso(NOW),
      })
      storage.table('runs').put('run-00000001', {
        runId: 'run-00000001',
        orchestrationId: 'log-rotate',
        trigger: 'every',
        scheduledAt: iso(NOW),
        startedAt: null,
        settledAt: null,
        status: 'queued',
        skipReason: null,
        script: { command: 'pwsh', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', truncated: false },
        matchedRule: null,
        usedFallback: false,
        actions: [],
      })
    })
    const live = new Map([['run-00000001', { status: 'running', startedAt: iso(NOW + 5_000) }]])
    const service = createManagementService({
      storage,
      queue,
      config: { maxRunsPerOrchestration: 100 },
      now: () => NOW,
      runner: { liveView: (runId) => (live.has(runId) ? { ...live.get(runId) } : undefined) },
    })
    const detail = await service.view('log-rotate')
    expect(detail.runs).toHaveLength(1)
    expect(detail.runs[0]).toMatchObject({ runId: 'run-00000001', status: 'running', startedAt: iso(NOW + 5_000) })
    // runner 视图消失后回落到持久记录（结算写完成后的形态）
    live.delete('run-00000001')
    const detail2 = await service.view('log-rotate')
    expect(detail2.runs[0]).toMatchObject({ status: 'queued' })
  })
})

describe('list 查询校验（服务为语义权威）', () => {
  const rows = [
    { id: 'b-second', status: 'active' },
    { id: 'a-first', status: 'paused' },
    { id: 'c-third', status: 'active' },
    { id: 'd-ended', status: 'ended' },
  ]

  function serviceWithRows() {
    const storage = makeStorage()
    for (const row of rows) storage.table('orchestrations').put(row.id, row) // fake put 同步落 Map
    return makeService({ storage }).service
  }

  it('空存储返回 { items: [], total: 0, nextOffset: null }', async () => {
    const { service } = makeService()
    await expect(service.list()).resolves.toEqual({ items: [], total: 0, nextOffset: null })
    await expect(service.list({})).resolves.toEqual({ items: [], total: 0, nextOffset: null })
  })

  it('active 过滤：true → active；false → paused/ended；省略 → 全部；按 id 稳定排序', async () => {
    const service = serviceWithRows()
    const all = await service.list()
    expect(all.items.map((o) => o.id)).toEqual(['a-first', 'b-second', 'c-third', 'd-ended'])
    expect(all.total).toBe(4)
    const act = await service.list({ active: true })
    expect(act.items.map((o) => o.id)).toEqual(['b-second', 'c-third'])
    const inact = await service.list({ active: false })
    expect(inact.items.map((o) => o.id)).toEqual(['a-first', 'd-ended'])
  })

  it('分页与 nextOffset：未取尽给 offset+items.length，取尽为 null', async () => {
    const service = serviceWithRows()
    const page1 = await service.list({ limit: 2, offset: 0 })
    expect(page1.items.map((o) => o.id)).toEqual(['a-first', 'b-second'])
    expect(page1.nextOffset).toBe(2)
    const page2 = await service.list({ limit: 2, offset: 2 })
    expect(page2.items.map((o) => o.id)).toEqual(['c-third', 'd-ended'])
    expect(page2.nextOffset).toBeNull()
    const beyond = await service.list({ limit: 2, offset: 4 })
    expect(beyond.items).toEqual([])
    expect(beyond.nextOffset).toBeNull()
  })

  it('非法 limit/offset/active/未知键 → script_input_invalid', async () => {
    const service = serviceWithRows()
    const cases = [
      [{ limit: 0 }, 'limit', 'range'],
      [{ limit: 501 }, 'limit', 'range'],
      [{ limit: 1.5 }, 'limit', 'format'],
      [{ offset: -1 }, 'offset', 'range'],
      [{ active: 'yes' }, 'active', 'format'],
      [{ deep: 1 }, 'deep', 'unexpected'],
    ]
    for (const [query, field, reason] of cases) {
      await expect(service.list(query)).rejects.toMatchObject({
        code: 'script_input_invalid',
        details: { field, reason },
      })
    }
  })
})

describe('错误模型', () => {
  it('OrchestratorError 携带 code/message/details', () => {
    const error = new OrchestratorError('script_unknown', '消息', { id: 'x' })
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('script_unknown')
    expect(error.details).toEqual({ id: 'x' })
  })
})

describe('create 校验矩阵（契约 01–05；失败不产生任何记录、不发布 changed、不毒化队列）', () => {
  // mutator 在基线输入上做一处变异；期望为 [field, reason]
  const cases = [
    ['输入非对象', () => 'nope', 'input', 'format'],
    ['顶层多余字段', (i) => { i.extra = 1 }, 'extra', 'unexpected'],
    ['title 缺失', (i) => { delete i.title }, 'title', 'missing'],
    ['title 非字符串', (i) => { i.title = 42 }, 'title', 'format'],
    ['title 空白串', (i) => { i.title = '   ' }, 'title', 'range'],
    ['title 超 120 字符', (i) => { i.title = 'x'.repeat(121) }, 'title', 'range'],
    ['id 非法字符', (i) => { i.id = 'Bad_ID' }, 'id', 'format'],
    ['enabled 非布尔', (i) => { i.enabled = 'yes' }, 'enabled', 'format'],
    ['overlap 非法', (i) => { i.overlap = 'both' }, 'overlap', 'format'],
    ['trigger 缺失', (i) => { delete i.trigger }, 'trigger', 'missing'],
    ['trigger.kind cron（尚未实现）', (i) => { i.trigger = { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' } }, 'trigger.kind', 'unsupported-part'],
    ['trigger.kind 未知', (i) => { i.trigger = { kind: 'daily' } }, 'trigger.kind', 'format'],
    ['every + 多余字段', (i) => { i.trigger.expression = '0 3 * * *' }, 'trigger.expression', 'unexpected'],
    ['everySeconds 缺失', (i) => { delete i.trigger.everySeconds }, 'trigger.everySeconds', 'missing'],
    ['everySeconds 59（低于 60 秒硬性下限）', (i) => { i.trigger.everySeconds = 59 }, 'trigger.everySeconds', 'too-frequent'],
    ['everySeconds 字符串', (i) => { i.trigger.everySeconds = '300' }, 'trigger.everySeconds', 'format'],
    ['everySeconds 非整数', (i) => { i.trigger.everySeconds = 300.5 }, 'trigger.everySeconds', 'format'],
    ['mode 非法', (i) => { i.trigger.mode = 'bogus' }, 'trigger.mode', 'format'],
    ['script 缺失', (i) => { delete i.script }, 'script', 'missing'],
    ['script.command 缺失', (i) => { delete i.script.command }, 'script.command', 'missing'],
    ['script.command 空串', (i) => { i.script.command = '' }, 'script.command', 'format'],
    ['script.args 非数组', (i) => { i.script.args = '-File' }, 'script.args', 'format'],
    ['script.args 元素非字符串', (i) => { i.script.args = [1] }, 'script.args', 'format'],
    ['script.env 值非字符串', (i) => { i.script.env = { A: 1 } }, 'script.env', 'format'],
    ['script.timeoutSeconds 0', (i) => { i.script.timeoutSeconds = 0 }, 'script.timeoutSeconds', 'range'],
    ['script.timeoutSeconds 86401', (i) => { i.script.timeoutSeconds = 86401 }, 'script.timeoutSeconds', 'range'],
    ['script.stdin 非法形态', (i) => { i.script.stdin = 'pipe' }, 'script.stdin', 'format'],
    ['script 多余字段', (i) => { i.script.shell = true }, 'script.shell', 'unexpected'],
    ['judge 缺失', (i) => { delete i.judge }, 'judge', 'missing'],
    ['judge.rules 33 条', (i) => {
      i.judge = { rules: Array.from({ length: 33 }, () => ({ when: { exitCode: 0 }, actions: [] })), fallback: [] }
    }, 'judge.rules', 'range'],
    ['规则缺 when', (i) => { delete i.judge.rules[0].when }, 'judge.rules[0].when', 'missing'],
    ['谓词空对象', (i) => { i.judge.rules[0].when = {} }, 'judge.rules[0].when', 'format'],
    ['谓词未知键', (i) => { i.judge.rules[0].when = { stdout2: 'x' } }, 'judge.rules[0].when.stdout2', 'format'],
    ['regex 非法', (i) => { i.judge.rules[0].when = { stdout: { regex: '(' } } }, 'judge.rules[0].when.stdout.regex', 'format'],
    ['内联开关 (?i)', (i) => { i.judge.rules[0].when = { stdout: { regex: '(?i)abc' } } }, 'judge.rules[0].when.stdout.regex', 'format'],
    ['flags 非法字符', (i) => { i.judge.rules[0].when = { stdout: { regex: 'a', flags: 'x' } } }, 'judge.rules[0].when.stdout.flags', 'format'],
    ['jsonPath 语法错', (i) => { i.judge.rules[0].when = { stdout: { jsonPath: 'status' } } }, 'judge.rules[0].when.stdout.jsonPath', 'format'],
    ['exitCode.not 非数字', (i) => { i.judge.rules[0].when = { exitCode: { not: '0' } } }, 'judge.rules[0].when.exitCode.not', 'format'],
    ['exitCode 混用形态', (i) => { i.judge.rules[0].when = { exitCode: { not: 0, in: [1] } } }, 'judge.rules[0].when.exitCode', 'format'],
    ['规则缺 actions', (i) => { delete i.judge.rules[0].actions }, 'judge.rules[0].actions', 'missing'],
    ['规则引用未定义动作键', (i) => { i.judge.rules[0].actions = ['nope'] }, 'judge.rules[0].actions[0]', 'missing'],
    ['fallback 引用未定义动作键', (i) => { i.judge.fallback = ['nope'] }, 'judge.fallback[0]', 'missing'],
    ['judge 多余字段', (i) => { i.judge.else = [] }, 'judge.else', 'unexpected'],
    ['actions 缺失', (i) => { delete i.actions }, 'actions', 'missing'],
    ['动作键大写', (i) => { i.actions = { EmitOk: { kind: 'event', name: 'ok' } }; i.judge.rules[0].actions = ['EmitOk'] }, 'actions.EmitOk', 'format'],
    ['17 个动作', (i) => {
      const actions = {}
      for (let n = 0; n < 17; n++) actions[`a-${n}`] = { kind: 'event', name: `e-${n}` }
      i.actions = actions
      i.judge.rules[0].actions = ['a-0']
    }, 'actions', 'range'],
    ['event name 含点号', (i) => { i.actions['emit-ok'].name = 'deploy.ok' }, 'actions.emit-ok.name', 'format'],
    ['event name 保留名', (i) => { i.actions['emit-ok'].name = 'changed' }, 'actions.emit-ok.name', 'reserved'],
    ['event 缺 name', (i) => { delete i.actions['emit-ok'].name }, 'actions.emit-ok.name', 'missing'],
    ['plugin action 无点号', (i) => { i.actions['emit-ok'] = { kind: 'plugin', action: 'oncall' } }, 'actions.emit-ok.action', 'format'],
    ['plugin timeoutSeconds 301', (i) => { i.actions['emit-ok'] = { kind: 'plugin', action: 'ops.oncall', timeoutSeconds: 301 } }, 'actions.emit-ok.timeoutSeconds', 'range'],
    ['session 缺 prompt', (i) => { i.actions['emit-ok'] = { kind: 'session' } }, 'actions.emit-ok.prompt', 'missing'],
    ['session prompt 超 32 KiB', (i) => { i.actions['emit-ok'] = { kind: 'session', prompt: 'x'.repeat(32 * 1024 + 1) } }, 'actions.emit-ok.prompt', 'range'],
    ['persistent + idleDisposeSeconds', (i) => { i.actions['emit-ok'] = { kind: 'session', prompt: 'p', idleDisposeSeconds: 30 } }, 'actions.emit-ok.idleDisposeSeconds', 'unexpected'],
    ['idleDisposeSeconds 负数', (i) => { i.actions['emit-ok'] = { kind: 'session', mode: 'ephemeral', prompt: 'p', idleDisposeSeconds: -1 } }, 'actions.emit-ok.idleDisposeSeconds', 'range'],
    ['未知动作 kind', (i) => { i.actions['emit-ok'] = { kind: 'webhook' } }, 'actions.emit-ok.kind', 'format'],
  ]

  it.each(cases)('%s → script_input_invalid（%s/%s）且无写入、无 changed', async (_label, mutate, field, reason) => {
    const { service, storage, emitted } = makeService()
    const input = baseInput()
    const mutated = mutate(input)
    await expect(service.create(mutated ?? input)).rejects.toMatchObject({
      code: 'script_input_invalid',
      details: { field, reason },
    })
    expect(storage.snapshot().orchestrations).toEqual({})
    expect(emitted).toEqual([])
  })

  it('矩阵全部失败后队列不毒化：一次合法 create 仍成功', async () => {
    const { service, storage } = makeService()
    for (const [, mutate] of cases) {
      const input = baseInput()
      const mutated = mutate(input)
      await service.create(mutated ?? input).catch(() => {})
    }
    const view = await service.create(baseInput())
    expect(view.id).toBe('log-rotate')
    expect(Object.keys(storage.snapshot().orchestrations)).toEqual(['log-rotate'])
  })

  it('深层谓词与合法 every 输入通过校验（all/any 嵌套、jsonPath、min/max）', async () => {
    const { service } = makeService()
    const view = await service.create({
      ...baseInput(),
      judge: {
        rules: [
          {
            when: {
              all: [
                { any: [{ exitCode: { in: [0, 2] } }, { timedOut: true }] },
                { stdout: { regex: '\\bfail(ed|ure)\\b', flags: 'i', jsonPath: '$.items[0].state', equals: 'bad' } },
                { durationMs: { min: 0, max: 60000 } },
              ],
            },
            actions: ['emit-ok'],
          },
        ],
        fallback: [],
      },
      script: { command: 'pwsh' },
    })
    expect(view.script.args).toEqual([])
    expect(view.script.env).toEqual({})
    expect(view.status).toBe('active')
  })
})
