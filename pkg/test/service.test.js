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

describe('registerAction / listActions（契约 06 注册动作：票 31）', () => {
  it('registerAction 是同步方法：返回 disposer 函数（非 Promise）', () => {
    const { service } = makeService()
    const dispose = service.registerAction({ name: 'ops.oncall', run: async () => {} })
    expect(typeof dispose).toBe('function')
    expect(dispose).not.toBeInstanceOf(Promise)
  })

  it('注册后 listActions() 按 name 排序返回 { name, description? }；view 的 availableActions 与服务一致', async () => {
    const { service } = makeService()
    service.registerAction({ name: 'ops.oncall', description: '按 severity 呼叫值班', run: async () => {} })
    service.registerAction({ name: 'alpha.ping', run: async () => {} })
    const expected = [
      { name: 'alpha.ping' },
      { name: 'ops.oncall', description: '按 severity 呼叫值班' },
    ]
    expect(service.listActions()).toEqual(expected)
    const created = await service.create(baseInput())
    const detail = await service.view(created.id)
    expect(detail.availableActions).toEqual(expected)
    expect(detail.availableActions).toEqual(service.listActions())
  })

  it('不合规名字 / 保留前缀 / definition 形状错误 → 同步抛 Error（非 rejected Promise）', () => {
    const { service } = makeService()
    expect(() => service.registerAction({ name: 'oncall', run: async () => {} })).toThrow()
    expect(() => service.registerAction({ name: 'a.b.c', run: async () => {} })).toThrow()
    expect(() => service.registerAction({ name: 'script-orchestrator.echo', run: async () => {} })).toThrow(/script-orchestrator/)
    expect(() => service.registerAction({ name: 'ops.oncall' })).toThrow() // 缺 run
  })

  it('重名注册同步抛 Error（消息含冲突名），既有注册不受影响', () => {
    const { service } = makeService()
    service.registerAction({ name: 'ops.oncall', run: async () => {} })
    expect(() => service.registerAction({ name: 'ops.oncall', run: async () => {} })).toThrow(/ops\.oncall/)
    expect(service.listActions()).toEqual([{ name: 'ops.oncall' }])
  })

  it('disposer 摘除后 listActions 与 view.availableActions 同步反映（幂等、可重注册）', async () => {
    const { service } = makeService()
    const dispose = service.registerAction({ name: 'ops.oncall', description: 'v1', run: async () => {} })
    dispose()
    dispose() // 幂等
    expect(service.listActions()).toEqual([])
    // 同步紧随的重注册不误冲突（disposer 同步完成摘除）
    const dispose2 = service.registerAction({ name: 'ops.oncall', description: 'v2', run: async () => {} })
    expect(service.listActions()).toEqual([{ name: 'ops.oncall', description: 'v2' }])
    const created = await service.create(baseInput())
    expect((await service.view(created.id)).availableActions).toEqual([{ name: 'ops.oncall', description: 'v2' }])
    dispose2()
    expect((await service.view(created.id)).availableActions).toEqual([])
  })

  it('缺省自建注册表（未注入 actionRegistry）与注入共享实例行为一致：注册 → 快照 → 摘除', () => {
    const { service } = makeService() // 未注入 actionRegistry
    const dispose = service.registerAction({ name: 'ops.oncall', run: async () => {} })
    expect(service.listActions()).toEqual([{ name: 'ops.oncall' }])
    dispose()
    expect(service.listActions()).toEqual([])
  })
})

describe('create cron 校验（契约 02「cron 子集」「时区与夏令时」「校验错误」；票 27）', () => {
  /** 基线合法 cron 输入。 */
  const cronInput = (over = {}) => ({
    ...baseInput(),
    trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' },
    ...over,
  })

  // [标签, expression, 期望 reason, 期望 part]（timeZone 基线合法；expression 变异）
  const expressionCases = [
    ['宏 @daily', '@daily', 'unsupported-part', 'macro'],
    ['宏 @weekly 带时区前缀空格', ' @weekly', 'format', undefined],
    ['秒字段（六位）', '*/10 * * * * *', 'unsupported-part', 'second-field'],
    ['秒字段 + 年（七位）', '0 0 0 1 1 * 2030', 'unsupported-part', 'second-field'],
    ['月份名称 JAN', '0 3 1 JAN *', 'unsupported-part', 'month'],
    ['星期名称 MON', '0 3 * * MON', 'unsupported-part', 'day-of-week'],
    ['minute 越界 60', '60 3 * * *', 'range', 'minute'],
    ['minute 越界 -5', '-5 3 * * *', 'format', 'minute'],
    ['hour 越界 24', '0 24 * * *', 'range', 'hour'],
    ['day-of-month 越界 0', '0 3 0 * *', 'range', 'day-of-month'],
    ['day-of-month 越界 32', '0 3 32 * *', 'range', 'day-of-month'],
    ['month 越界 13', '0 3 * 13 *', 'range', 'month'],
    ['month 越界 0', '0 3 * 0 *', 'range', 'month'],
    ['day-of-week 越界 8', '0 3 * * 8', 'range', 'day-of-week'],
    ['范围反转 50-10', '50-10 3 * * *', 'format', 'minute'],
    ['step 为 0', '*/0 3 * * *', 'format', 'minute'],
    ['step 非整数', '*/1.5 3 * * *', 'format', 'minute'],
    ['无范围 step 5/15（仅 */n 允许）', '5/15 * * * *', 'format', 'minute'],
    ['star-step 用于 day-of-month', '0 3 */2 * *', 'unsupported-part', 'day-of-month'],
    ['star-step 用于 month', '0 3 * */2 *', 'unsupported-part', 'month'],
    ['star-step 用于 day-of-week', '0 3 * * */2', 'unsupported-part', 'day-of-week'],
    ['星与列表混用 *,5', '*,5 3 * * *', 'format', 'minute'],
    ['star-step 与列表混用 */5,30', '*/5,30 3 * * *', 'format', 'minute'],
    ['空列表元素 5,,6', '5,,6 3 * * *', 'format', 'minute'],
    ['逗号结尾 5,', '5, 3 * * *', 'format', 'minute'],
    ['四字段', '0 3 * *', 'format', undefined],
    ['空字符串', '', 'format', undefined],
    ['首尾空白', ' 0 3 * * * ', 'format', undefined],
    ['列表内范围步进越界 a-b/n 的 b 越界', '0 3 1-32/2 * *', 'range', 'day-of-month'],
  ]

  it.each(expressionCases)('expression %s → script_input_invalid（%s）', async (_label, expression, reason, part) => {
    const { service, storage, emitted } = makeService()
    await expect(service.create(cronInput({ trigger: { kind: 'cron', expression, timeZone: 'Asia/Shanghai' } }))).rejects.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'trigger.expression', reason, ...(part === undefined ? {} : { part }) },
    })
    expect(storage.snapshot().orchestrations).toEqual({})
    expect(emitted).toEqual([])
  })

  // [标签, timeZone, 期望 reason]
  const timeZoneCases = [
    ['缩写 GMT', 'GMT', 'format'],
    ['缩写 CST', 'CST', 'format'],
    ['偏移写法 UTC+8', 'UTC+8', 'format'],
    ['数字偏移 +08:00', '+08:00', 'format'],
    ['未知名 Asia/Nope', 'Asia/Nope', 'format'],
    ['单段名 Shanghai', 'Shanghai', 'format'],
  ]

  it.each(timeZoneCases)('timeZone %s → script_input_invalid（format）', async (_label, timeZone, reason) => {
    const { service } = makeService()
    await expect(service.create(cronInput({ trigger: { kind: 'cron', expression: '0 3 * * *', timeZone } }))).rejects.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'trigger.timeZone', reason },
    })
  })

  it('timeZone 缺失 → missing；非字符串 → format；cron 带 everySeconds/mode → unexpected', async () => {
    const { service } = makeService()
    await expect(service.create(cronInput({ trigger: { kind: 'cron', expression: '0 3 * * *' } }))).rejects.toMatchObject({
      details: { field: 'trigger.timeZone', reason: 'missing' },
    })
    await expect(service.create(cronInput({ trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 8 } }))).rejects.toMatchObject({
      details: { field: 'trigger.timeZone', reason: 'format' },
    })
    await expect(
      service.create(cronInput({ trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'UTC', everySeconds: 300, mode: 'fixed-rate' } })),
    ).rejects.toMatchObject({ details: { field: 'trigger.everySeconds', reason: 'unexpected' } })
  })

  it('expression 缺失 → missing；非字符串 → format', async () => {
    const { service } = makeService()
    await expect(service.create(cronInput({ trigger: { kind: 'cron', timeZone: 'UTC' } }))).rejects.toMatchObject({
      details: { field: 'trigger.expression', reason: 'missing' },
    })
    await expect(service.create(cronInput({ trigger: { kind: 'cron', expression: 42, timeZone: 'UTC' } }))).rejects.toMatchObject({
      details: { field: 'trigger.expression', reason: 'format' },
    })
  })

  it('合法子集通过：dow 7 与 0 同为周日；别名时区可接受（规范名随平台）', async () => {
    const { service } = makeService()
    const view = await service.create(cronInput({ trigger: { kind: 'cron', expression: '0 9 * * 1,3,5', timeZone: 'Asia/Calcutta' } }))
    // canonicalizeTimeZone 委托 Intl resolvedOptions：本机 ICU 对别名保留原样（Asia/Calcutta），
    // 其他平台可能规范化为 Asia/Kolkata——两者都表示同一 zone，断言集合成员而非具体值。
    expect(['Asia/Calcutta', 'Asia/Kolkata']).toContain(view.trigger.timeZone)
    expect(view.trigger.expression).toBe('0 9 * * 1,3,5')
    expect(view.trigger.kind).toBe('cron')
    const sunday = await service.create(cronInput({ id: 'sunday', title: 'sunday', trigger: { kind: 'cron', expression: '0 9 * * 7', timeZone: 'Etc/GMT-8' } }))
    expect(sunday.trigger).toEqual({ kind: 'cron', expression: '0 9 * * 7', timeZone: 'Etc/GMT-8' })
    // minute/hour 的 */n、a-b/n、逗号列表均属契约子集
    const stepped = await service.create(cronInput({ id: 'stepped', title: 'stepped', trigger: { kind: 'cron', expression: '*/15 3 * * *', timeZone: 'UTC' } }))
    expect(stepped.trigger.expression).toBe('*/15 3 * * *')
    const listed = await service.create(cronInput({ id: 'listed', title: 'listed', trigger: { kind: 'cron', expression: '0,30 3 1-7/2 * *', timeZone: 'UTC' } }))
    expect(listed.trigger.expression).toBe('0,30 3 1-7/2 * *')
  })

  it('创建 active cron：nextOccurrence = 严格晚于 createdAt 的下一匹配（独立手算）', async () => {
    const { service } = makeService()
    // NOW = 2026-09-21T14:13:20Z = 上海本地 22:13 → 下一个本地 03:00 是 09-22 03:00 = 09-21T19:00Z
    const view = await service.create(cronInput())
    expect(view.status).toBe('active')
    expect(view.nextOccurrence).toBe('2026-09-21T19:00:00.000Z')
  })

  it('createdAt 恰为匹配时刻：nextOccurrence 严格大于（取次日同时刻）', async () => {
    const { service } = makeService({ now: () => Date.parse('2026-09-21T19:00:00.000Z') }) // 上海本地 09-22 03:00
    const view = await service.create(cronInput())
    expect(view.nextOccurrence).toBe('2026-09-22T19:00:00.000Z') // 次日本地 03:00
  })

  it('enabled:false 的 cron 创建为 paused、nextOccurrence = null（仍持久化并发布 changed）', async () => {
    const { service, emitted } = makeService()
    const view = await service.create(cronInput({ enabled: false }))
    expect(view.status).toBe('paused')
    expect(view.nextOccurrence).toBeNull()
    expect(emitted).toEqual([['script-orchestrator/changed', undefined]])
  })

  it('五年窗口内无解 → script_input_invalid（reason: no-occurrence）且失败不产生任何记录', async () => {
    const { service, storage, emitted } = makeService()
    // 2 月 30 日：库 400 年地平线内永无解
    await expect(
      service.create(cronInput({ trigger: { kind: 'cron', expression: '0 3 30 2 *', timeZone: 'UTC' } })),
    ).rejects.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'trigger.expression', reason: 'no-occurrence' },
    })
    // 2 月 29 日在 2097 年视角：下一个 2/29 是 2104（其间 2100 非闰年），距参考时刻超 5 年窗口
    const future = makeService({ now: () => Date.parse('2097-03-01T00:00:00.000Z') })
    await expect(
      future.service.create(cronInput({ trigger: { kind: 'cron', expression: '0 3 29 2 *', timeZone: 'UTC' } })),
    ).rejects.toMatchObject({ details: { field: 'trigger.expression', reason: 'no-occurrence' } })
    // 同一 2/29 表达式在 2026 年视角有解（2028-02-29 在窗口内）：正常创建
    const ok = await service.create(cronInput({ trigger: { kind: 'cron', expression: '0 3 29 2 *', timeZone: 'UTC' } }))
    expect(ok.nextOccurrence).toBe('2028-02-29T03:00:00.000Z')
    expect(storage.snapshot().orchestrations).toHaveProperty('log-rotate')
    expect(emitted).toEqual([['script-orchestrator/changed', undefined]])
  })

  it('无解拒绝与 enabled 无关：paused 创建同样拒绝（配置永不有效，契约 02「不写入立即 ended 的编排」）', async () => {
    const { service, storage } = makeService()
    await expect(
      service.create(cronInput({ enabled: false, trigger: { kind: 'cron', expression: '0 3 30 2 *', timeZone: 'UTC' } })),
    ).rejects.toMatchObject({ details: { field: 'trigger.expression', reason: 'no-occurrence' } })
    expect(storage.snapshot().orchestrations).toEqual({})
  })
})

describe('edit · 形状校验、乐观并发与 update 基本路径（契约 06/07；票 28）', () => {
  it('形状校验：id/action 必填、action 枚举、多余字段、patch 仅 update、update 至少一个字段', async () => {
    const { service } = makeService()
    await service.create(baseInput())
    await expect(service.edit({ action: 'pause' })).rejects.toMatchObject({ details: { field: 'id', reason: 'missing' } })
    await expect(service.edit({ id: 'log-rotate' })).rejects.toMatchObject({ details: { field: 'action', reason: 'missing' } })
    await expect(service.edit({ id: 'log-rotate', action: 'bogus' })).rejects.toMatchObject({ details: { field: 'action', reason: 'format' } })
    await expect(service.edit({ id: 'log-rotate', action: 'pause', extra: 1 })).rejects.toMatchObject({ details: { field: 'extra', reason: 'unexpected' } })
    await expect(service.edit({ id: 'log-rotate', action: 'pause', patch: { title: 'x' } })).rejects.toMatchObject({ details: { field: 'patch', reason: 'unexpected' } })
    await expect(service.edit({ id: 'log-rotate', action: 'update' })).rejects.toMatchObject({ details: { field: 'patch', reason: 'missing' } })
    await expect(service.edit({ id: 'log-rotate', action: 'update', patch: {} })).rejects.toMatchObject({ details: { field: 'patch', reason: 'format' } })
  })

  it('未知 id → script_unknown（各 action 一致）', async () => {
    const { service } = makeService()
    for (const action of ['update', 'pause', 'resume']) {
      await expect(service.edit({ id: 'nope', action, ...(action === 'update' ? { patch: { title: 'x' } } : {}) }))
        .rejects.toMatchObject({ code: 'script_unknown', details: { id: 'nope' } })
    }
  })

  it('delete action：准确暂不支持错误（票 29 交付），不触碰记录', async () => {
    const { service, storage } = makeService()
    await service.create(baseInput())
    await expect(service.edit({ id: 'log-rotate', action: 'delete' })).rejects.toMatchObject({
      code: 'script_input_invalid',
      details: { field: 'action', reason: 'unsupported-part' },
    })
    expect(Object.keys(storage.snapshot().orchestrations)).toEqual(['log-rotate'])
  })

  it('expectedUpdatedAt 乐观并发：匹配通过、不匹配 script_conflict、null 对已有 updatedAt 恒冲突', async () => {
    let t = NOW
    const { service, storage, emitted } = makeService({ now: () => t })
    const created = await service.create(baseInput())
    await expect(
      service.edit({ id: 'log-rotate', action: 'pause', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({
      code: 'script_conflict',
      details: { expected: '2020-01-01T00:00:00.000Z', actual: created.updatedAt },
    })
    await expect(service.edit({ id: 'log-rotate', action: 'pause', expectedUpdatedAt: null })).rejects.toMatchObject({
      code: 'script_conflict',
    })
    // 匹配则通过；冲突失败不改任何记录、不新增 changed（create 的那一条仍在）
    expect(storage.snapshot().orchestrations['log-rotate'].status).toBe('active')
    expect(emitted).toEqual([['script-orchestrator/changed', undefined]])
    t = NOW + 60_000
    const view = await service.edit({ id: 'log-rotate', action: 'pause', expectedUpdatedAt: created.updatedAt })
    expect(view.status).toBe('paused')
  })

  it('update 非调度字段（title）：合并校验、写库、updatedAt 推进、发 changed；nextOccurrence 不重锚', async () => {
    let t = NOW
    const { service, storage, emitted } = makeService({ now: () => t })
    const created = await service.create(baseInput())
    t = NOW + 120_000
    const view = await service.edit({ id: 'log-rotate', action: 'update', patch: { title: '  new title  ' } })
    expect(view.title).toBe('new title') // 归一化与 create 同源
    expect(view.updatedAt).toBe(iso(NOW + 120_000)) // 内容编辑推进 updatedAt（CAS 依据）
    expect(view.nextOccurrence).toBe(created.nextOccurrence) // 非调度编辑不重锚
    expect(view.trigger).toEqual(created.trigger)
    expect(storage.snapshot().orchestrations['log-rotate']).toEqual(view)
    expect(emitted.filter(([n]) => n === 'script-orchestrator/changed')).toHaveLength(2) // create + edit
  })

  it('update 非法 patch 字段值走 create 同源校验（title 空 → range；everySeconds 59 → too-frequent）', async () => {
    const { service } = makeService()
    await service.create(baseInput())
    await expect(service.edit({ id: 'log-rotate', action: 'update', patch: { title: '   ' } })).rejects.toMatchObject({
      details: { field: 'title', reason: 'range' },
    })
    await expect(
      service.edit({ id: 'log-rotate', action: 'update', patch: { trigger: { kind: 'every', everySeconds: 59 } } }),
    ).rejects.toMatchObject({ details: { field: 'trigger.everySeconds', reason: 'too-frequent' } })
  })
})

describe('edit · pause/resume 状态设置语义（契约 09 + 02「创建、编辑、暂停与恢复」；票 28）', () => {
  async function makePaused(over = {}) {
    let t = over.t0 ?? NOW
    const world = makeService({ now: () => t })
    const created = await world.service.create({ ...baseInput(), enabled: false, ...over.input })
    return { ...world, created, setTime: (ms) => { t = ms } }
  }

  it('pause 仅从 active 生效：paused → paused 与 ended → pause 均幂等 no-op（不改记录、不发 changed、不改 updatedAt）', async () => {
    const world = await makePaused()
    const before = { ...world.storage.snapshot().orchestrations['log-rotate'] }
    const view = await world.service.edit({ id: 'log-rotate', action: 'pause' })
    expect(view.status).toBe('paused')
    expect(view).toEqual(before)
    expect(world.storage.snapshot().orchestrations['log-rotate']).toEqual(before)
    expect(world.emitted).toEqual([['script-orchestrator/changed', undefined]]) // 仅 create 那条
    // ended 同样 no-op
    world.storage.table('orchestrations').put('log-rotate', { ...before, status: 'ended' })
    const endedView = await world.service.edit({ id: 'log-rotate', action: 'pause' })
    expect(endedView.status).toBe('ended')
    expect(world.emitted).toHaveLength(1)
  })

  it('pause 对 active 生效：nextOccurrence=null、paused、updatedAt 推进、发 changed', async () => {
    let t = NOW
    const { service, storage, emitted } = makeService({ now: () => t })
    await service.create(baseInput())
    t = NOW + 30_000
    const view = await service.edit({ id: 'log-rotate', action: 'pause' })
    expect(view.status).toBe('paused')
    expect(view.nextOccurrence).toBeNull()
    expect(view.updatedAt).toBe(iso(NOW + 30_000))
    expect(storage.snapshot().orchestrations['log-rotate'].status).toBe('paused')
    expect(emitted).toHaveLength(2)
  })

  it('resume 仅从 paused 生效：active/ended 幂等 no-op（不重锚 fixed-delay）', async () => {
    let t = NOW
    const { service, emitted } = makeService({ now: () => t })
    await service.create({ ...baseInput(), trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' } })
    // active 上的 resume：no-op（fixed-delay 未被错误重锚——nextOccurrence 保持不变）
    const activeView = await service.edit({ id: 'log-rotate', action: 'resume' })
    expect(activeView.status).toBe('active')
    expect(activeView.nextOccurrence).toBe(iso(NOW + 300_000))
    expect(emitted).toHaveLength(1)
    // ended 上的 resume：no-op
    const paused = await service.edit({ id: 'log-rotate', action: 'pause' })
    expect(paused.status).toBe('paused')
    // 手工置 ended 后 resume → no-op
    const storage2 = makeService({ now: () => t })
    await storage2.service.create(baseInput())
    storage2.storage.table('orchestrations').put('log-rotate', {
      ...storage2.storage.snapshot().orchestrations['log-rotate'],
      status: 'ended',
      nextOccurrence: null,
    })
    const endedResume = await storage2.service.edit({ id: 'log-rotate', action: 'resume' })
    expect(endedResume.status).toBe('ended')
    expect(endedResume.nextOccurrence).toBeNull()
    expect(storage2.emitted).toHaveLength(1)
  })

  it('resume 恢复表：fixed-rate 从 resumedAt 重新锚定；不补暂停期', async () => {
    const world = await makePaused()
    world.setTime(NOW + 600_000) // 暂停 10 分钟后恢复
    const view = await world.service.edit({ id: 'log-rotate', action: 'resume' })
    expect(view.status).toBe('active')
    expect(view.nextOccurrence).toBe(iso(NOW + 600_000 + 300_000)) // resumedAt + everySeconds，不补暂停期
    expect(view.updatedAt).toBe(iso(NOW + 600_000))
  })

  it('resume 恢复表：cron 取严格晚于 resumedAt 的下一匹配', async () => {
    let t = Date.parse('2026-09-21T14:13:20.000Z')
    const { service } = makeService({ now: () => t })
    await service.create({
      ...baseInput(),
      enabled: false,
      trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' },
    })
    t = Date.parse('2026-09-22T10:00:00.000Z') // 上海本地 18:00
    const view = await service.edit({ id: 'log-rotate', action: 'resume' })
    expect(view.status).toBe('active')
    expect(view.nextOccurrence).toBe('2026-09-22T19:00:00.000Z') // 次日本地 03:00
  })

  it('resume 恢复表：fixed-delay 无未结算旧自动 run → resumedAt + everySeconds；有 → 保持 null 等结算', async () => {
    const world = await makePaused({ input: { trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' } } })
    world.setTime(NOW + 60_000)
    const view = await world.service.edit({ id: 'log-rotate', action: 'resume' })
    expect(view.nextOccurrence).toBe(iso(NOW + 60_000 + 300_000))
    // 有未结算旧自动 run：保持 null（结算后由 runner 以当前 everySeconds 推进）
    const world2 = await makePaused({ input: { trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' } } })
    world2.storage.table('runs').put('run-aaaaaaaa', {
      runId: 'run-aaaaaaaa',
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
    const view2 = await world2.service.edit({ id: 'log-rotate', action: 'resume' })
    expect(view2.status).toBe('active')
    expect(view2.nextOccurrence).toBeNull()
    // 手动 run 在途不阻塞恢复锚定（手动不推进序列）
    const world3 = await makePaused({ input: { trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' } } })
    world3.storage.table('runs').put('run-bbbbbbbb', {
      runId: 'run-bbbbbbbb',
      orchestrationId: 'log-rotate',
      trigger: 'manual',
      scheduledAt: iso(NOW),
      startedAt: iso(NOW),
      settledAt: null,
      status: 'running',
      skipReason: null,
      script: { command: 'pwsh', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', truncated: false },
      matchedRule: null,
      usedFallback: false,
      actions: [],
    })
    const view3 = await world3.service.edit({ id: 'log-rotate', action: 'resume' })
    expect(view3.nextOccurrence).toBe(iso(NOW + 300_000))
  })

  it('resume 运行期意外无解（cron）→ 转为 ended 防御终态（契约 02「恢复」）', async () => {
    let t = Date.parse('2097-03-01T00:00:00.000Z')
    const { service, storage } = makeService({ now: () => t })
    // 直接落一条 paused 的 2/29 cron 编排（创建期在 2097 视角会被拒绝，故模拟「曾经合法、时过境迁」）
    storage.table('orchestrations').put('feb29', {
      id: 'feb29',
      title: '2月29',
      enabled: true,
      overlap: 'skip',
      trigger: { kind: 'cron', expression: '0 3 29 2 *', timeZone: 'UTC' },
      script: { command: 'pwsh', args: [], env: {} },
      judge: { rules: [], fallback: [] },
      actions: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'paused',
      nextOccurrence: null,
    })
    const view = await service.edit({ id: 'feb29', action: 'resume' })
    expect(view.status).toBe('ended') // 下一个 2/29 是 2104，距 resumedAt 超 5 年窗口
    expect(view.nextOccurrence).toBeNull()
    expect(storage.snapshot().orchestrations.feb29.status).toBe('ended')
  })
})

describe('edit · update 调度重锚与编辑代际（契约 02「编辑」表；票 28）', () => {
  it('调度字段变化（everySeconds/mode/expression/timeZone/kind）→ 编辑表重建；fixed-rate = editedAt + 新间隔', async () => {
    let t = NOW
    const { service } = makeService({ now: () => t })
    await service.create(baseInput()) // next = NOW+300s
    t = NOW + 100_000
    const view = await service.edit({ id: 'log-rotate', action: 'update', patch: { trigger: { kind: 'every', everySeconds: 600, mode: 'fixed-rate' } } })
    expect(view.trigger).toEqual({ kind: 'every', everySeconds: 600, mode: 'fixed-rate' })
    expect(view.nextOccurrence).toBe(iso(NOW + 100_000 + 600_000)) // editedAt + 新 everySeconds
    // cron → 严格晚于 editedAt 的下一匹配
    t = NOW + 200_000
    const cronView = await service.edit({
      id: 'log-rotate',
      action: 'update',
      patch: { trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' } },
    })
    // editedAt = NOW+200s = 2026-09-21T14:16:40Z = 上海 22:16 → 次日本地 03:00 = 09-21T19:00Z
    expect(cronView.trigger).toEqual({ kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' })
    expect(cronView.nextOccurrence).toBe('2026-09-21T19:00:00.000Z')
    // 相同值的 trigger（内容不变）不重锚：nextOccurrence 保持
    const sameView = await service.edit({
      id: 'log-rotate',
      action: 'update',
      patch: { trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' } },
    })
    expect(sameView.nextOccurrence).toBe('2026-09-21T19:00:00.000Z')
  })

  it('update 更新路径 cron 五年无解 → no-occurrence 拒绝且不写库（票 27 留的单点接入）', async () => {
    const { service, storage, emitted } = makeService()
    await service.create(baseInput())
    await expect(
      service.edit({ id: 'log-rotate', action: 'update', patch: { trigger: { kind: 'cron', expression: '0 3 30 2 *', timeZone: 'UTC' } } }),
    ).rejects.toMatchObject({ details: { field: 'trigger.expression', reason: 'no-occurrence' } })
    expect(storage.snapshot().orchestrations['log-rotate'].trigger.kind).toBe('every')
    expect(emitted).toHaveLength(1)
  })

  it('update 的 enabled 走暂停/恢复规则：true→false 暂停；false→true 恢复重锚', async () => {
    let t = NOW
    const { service } = makeService({ now: () => t })
    await service.create(baseInput())
    t = NOW + 50_000
    const paused = await service.edit({ id: 'log-rotate', action: 'update', patch: { enabled: false } })
    expect(paused.status).toBe('paused')
    expect(paused.nextOccurrence).toBeNull()
    expect(paused.enabled).toBe(false)
    t = NOW + 200_000
    const resumed = await service.edit({ id: 'log-rotate', action: 'update', patch: { enabled: true } })
    expect(resumed.status).toBe('active')
    expect(resumed.nextOccurrence).toBe(iso(NOW + 200_000 + 300_000)) // 恢复表：resumedAt + everySeconds
    expect(resumed.enabled).toBe(true)
  })

  it('paused 编排的非调度编辑不解暂停：状态与 nextOccurrence 保持；调度编辑也不预写计划（恢复时按新配置重算）', async () => {
    let t = NOW
    const { service } = makeService({ now: () => t })
    await service.create({ ...baseInput(), enabled: false }) // paused
    const titled = await service.edit({ id: 'log-rotate', action: 'update', patch: { title: 'renamed' } })
    expect(titled.status).toBe('paused')
    expect(titled.nextOccurrence).toBeNull()
    const schedEdit = await service.edit({
      id: 'log-rotate',
      action: 'update',
      patch: { trigger: { kind: 'every', everySeconds: 900, mode: 'fixed-rate' } },
    })
    expect(schedEdit.status).toBe('paused') // 显式暂停不被字段编辑意外解除
    expect(schedEdit.nextOccurrence).toBeNull()
    // 恢复时按新配置重锚
    const resumed = await service.edit({ id: 'log-rotate', action: 'resume' })
    expect(resumed.status).toBe('active')
    expect(Date.parse(resumed.nextOccurrence)).toBeGreaterThan(NOW)
  })

  it('ended 可经重算触发复活为 active（契约 07）；非调度编辑不复活', async () => {
    let t = NOW
    const { service, storage } = makeService({ now: () => t })
    await service.create(baseInput())
    storage.table('orchestrations').put('log-rotate', {
      ...storage.snapshot().orchestrations['log-rotate'],
      status: 'ended',
      nextOccurrence: null,
    })
    const nonSched = await service.edit({ id: 'log-rotate', action: 'update', patch: { title: 'still ended' } })
    expect(nonSched.status).toBe('ended')
    expect(nonSched.nextOccurrence).toBeNull()
    t = NOW + 100_000
    const revived = await service.edit({
      id: 'log-rotate',
      action: 'update',
      patch: { trigger: { kind: 'every', everySeconds: 120, mode: 'fixed-rate' } },
    })
    expect(revived.status).toBe('active')
    expect(revived.nextOccurrence).toBe(iso(NOW + 100_000 + 120_000))
  })

  it('fixed-delay 调度编辑且旧自动 run 未结算：保持 null；旧 run 结算后按新 everySeconds 推进（编辑代际）', async () => {
    // 本用例打在 runner 集成面：结算推进用「当前持久 trigger」＝编辑代际防线（runner 既有实现），
    // 此处锚定 service 侧「编辑时保持 null」与其协同结果
    let t = NOW
    const storage = makeStorage()
    const emitted = []
    const queue = new ServiceQueue()
    const { createRunner } = await import('../lib/runner.js')
    const { service } = (() => {
      const service = createManagementService({
        storage,
        queue,
        config: { maxRunsPerOrchestration: 100 },
        now: () => t,
        emit: (name, payload) => emitted.push([name, payload]),
        logger: { error: () => {}, warn: () => {} },
      })
      return { service }
    })()
    let resolveDone
    const subprocess = {
      spawn: () => ({
        done: new Promise((resolve) => { resolveDone = resolve }),
        terminate: () => resolveDone({ exitCode: 1, signal: null }),
        waitForExit: () => Promise.resolve(true),
        collected: {
          stdout: { readFrom: () => ({ text: '', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      }),
    }
    const runner = createRunner({
      storage,
      queue,
      subprocess,
      config: { maxConcurrentRuns: 2, defaultTimeoutSeconds: 300, maxOutputBytes: 262144, maxSpillBytes: 8388608, allowedRoots: [] },
      emit: (name, payload) => emitted.push([name, payload]),
      now: () => t,
      logger: { error: () => {}, warn: () => {} },
      fs: { stat: async () => ({ isDirectory: () => true }) },
    })
    await service.create({ ...baseInput(), trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' } })
    // 模拟旧自动 run 在途（手动落一条 queued 的自动 run 并泵起来）
    await runner.requestRun({ orchestrationId: 'log-rotate', trigger: 'every', scheduledAtMs: NOW })
    // 触发编辑（everySeconds 300 → 120，仍是 fixed-delay）
    const view = await service.edit({
      id: 'log-rotate',
      action: 'update',
      patch: { trigger: { kind: 'every', everySeconds: 120, mode: 'fixed-delay' } },
    })
    expect(view.trigger.everySeconds).toBe(120)
    expect(view.nextOccurrence).toBeNull() // 旧自动 run 未结算：保持 null（契约 02 编辑表）
    // 旧 run 结算（t = NOW+10s）：advanceFixedDelayIfDue 用当前（新）everySeconds 推进
    t = NOW + 10_000
    resolveDone({ exitCode: 0, signal: null })
    await runner.waitIdle()
    const after = storage.snapshot().orchestrations['log-rotate']
    expect(after.trigger.everySeconds).toBe(120)
    const nextMs = Date.parse(after.nextOccurrence)
    expect(Math.abs(nextMs - (NOW + 10_000 + 120_000))).toBeLessThan(1_000) // settledAt + 新 everySeconds
  })

  it('旧 run 结算不覆盖编辑后的 fixed-rate 计划（fixed-rate 无结算推进，天然满足；锚定行为）', async () => {
    // fixed-rate 的推进只发生在调度器 fire（沿 scheduledAt 相位），run 结算从不写 nextOccurrence
    let t = NOW
    const { service, storage } = makeService({ now: () => t })
    await service.create(baseInput()) // fixed-rate, next=NOW+300s
    storage.table('runs').put('run-cccccccc', {
      runId: 'run-cccccccc',
      orchestrationId: 'log-rotate',
      trigger: 'every',
      scheduledAt: iso(NOW),
      startedAt: iso(NOW),
      settledAt: null,
      status: 'running',
      skipReason: null,
      script: { command: 'pwsh', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', truncated: false },
      matchedRule: null,
      usedFallback: false,
      actions: [],
    })
    t = NOW + 100_000
    const view = await service.edit({ id: 'log-rotate', action: 'update', patch: { trigger: { kind: 'every', everySeconds: 900, mode: 'fixed-rate' } } })
    expect(view.nextOccurrence).toBe(iso(NOW + 100_000 + 900_000))
    expect(storage.snapshot().orchestrations['log-rotate'].nextOccurrence).toBe(iso(NOW + 100_000 + 900_000))
  })
})

/** service+runner 共享存储/队列的执行世界（run 服务契约测试用）。
 * auto=true：脚本自动成功；false：挂起等待 spawns[i].release(...) 手动放行。 */
async function makeRunnerWorld(over = {}) {
  let t = over.t0 ?? NOW
  const storage = makeStorage()
  const emitted = []
  const queue = new ServiceQueue()
  const { createRunner } = await import('../lib/runner.js')
  const spawns = []
  const subprocess = {
    spawn: () => {
      const entry = { finish: null }
      entry.release = (result) => entry.finish(result ?? { exitCode: 0, signal: null })
      entry.handle = {
        done: new Promise((resolve) => { entry.finish = resolve }),
        terminate: () => entry.release({ exitCode: 1, signal: null }),
        waitForExit: () => Promise.resolve(true),
        collected: {
          stdout: { readFrom: () => ({ text: 'MANUAL-OK', lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      }
      if (over.auto !== false) queueMicrotask(() => entry.release())
      spawns.push(entry)
      return entry.handle
    },
  }
  const runner = createRunner({
    storage,
    queue,
    subprocess,
    config: { maxConcurrentRuns: over.maxConcurrentRuns ?? 2, defaultTimeoutSeconds: 300, maxOutputBytes: 262144, maxSpillBytes: 8388608, allowedRoots: [] },
    emit: (name, payload) => emitted.push([name, payload]),
    now: () => t,
    logger: { error: () => {}, warn: () => {} },
    fs: { stat: async () => ({ isDirectory: () => true }) },
  })
  const service = createManagementService({
    storage,
    queue,
    config: { maxRunsPerOrchestration: 100, defaultTimeoutSeconds: 300, maxConcurrentRuns: over.maxConcurrentRuns ?? 2 },
    now: () => t,
    emit: (name, payload) => emitted.push([name, payload]),
    logger: { error: () => {}, warn: () => {} },
    runner,
  })
  return { service, runner, storage, emitted, spawns, setTime: (ms) => { t = ms }, getTime: () => t }
}

describe('run 服务契约（契约 06/07 script_run：手动执行、尽力等待；票 28）', () => {
  it('手动 run：受理即触发（trigger=manual），等结算成功；不改下次自动触发时刻', async () => {
    const world = await makeRunnerWorld()
    await world.service.create({ ...baseInput(), trigger: { kind: 'every', everySeconds: 3600, mode: 'fixed-rate' } })
    const auto = world.storage.snapshot().orchestrations['log-rotate'].nextOccurrence
    const accepted = await world.service.run('log-rotate')
    expect(accepted.trigger).toBe('manual')
    expect(['queued', 'running', 'succeeded']).toContain(accepted.status)
    const final = await world.service.waitRun(accepted.runId, 'log-rotate')
    expect(final.status).toBe('succeeded')
    expect(final.script.exitCode).toBe(0)
    expect(final.script.stdoutTail).toContain('MANUAL-OK')
    // 手动 run 不移动自动计划（契约 07）
    expect(world.storage.snapshot().orchestrations['log-rotate'].nextOccurrence).toBe(auto)
  })

  it('paused / ended 编排均允许手动执行（拒绝仅 id 不存在）', async () => {
    const world = await makeRunnerWorld()
    await world.service.create({ ...baseInput(), enabled: false }) // paused
    const pausedRun = await world.service.run('log-rotate')
    expect(['queued', 'running', 'succeeded']).toContain(pausedRun.status)
    await world.service.waitRun(pausedRun.runId, 'log-rotate')
    world.storage.table('orchestrations').put('log-rotate', {
      ...world.storage.snapshot().orchestrations['log-rotate'],
      status: 'ended',
    })
    const endedRun = await world.service.run('log-rotate')
    expect(['queued', 'running', 'succeeded']).toContain(endedRun.status)
    await world.service.waitRun(endedRun.runId, 'log-rotate')
    await expect(world.service.run('nope')).rejects.toMatchObject({ code: 'script_unknown', details: { id: 'nope' } })
  })

  it('手动 run 不被 overlap:skip 淘汰：自动 run 在跑时显式排队等上次结算', async () => {
    const world = await makeRunnerWorld({ auto: false })
    await world.service.create({ ...baseInput(), trigger: { kind: 'every', everySeconds: 3600 } }) // overlap 默认 skip
    const auto = await world.runner.requestRun({ orchestrationId: 'log-rotate', trigger: 'every', scheduledAtMs: NOW })
    expect(auto.status).toBe('running') // 占住单飞
    const manual = await world.service.run('log-rotate')
    expect(manual.status).toBe('queued') // 不被 skip（显式意图排队）
    expect(manual.skipReason).toBeNull()
    // 自动结算后手动才开始，其脚本也需放行（auto:false），最终成功
    world.spawns[0].release({ exitCode: 0, signal: null })
    await new Promise((resolve) => setTimeout(resolve, 10))
    world.spawns[1]?.release({ exitCode: 0, signal: null })
    const final = await world.service.waitRun(manual.runId, 'log-rotate')
    expect(final.status).toBe('succeeded')
  })

  it('全局队列溢出丢最旧不豁免手动：被丢时返回可见 skipped RunView（skipReason: concurrency）', async () => {
    // maxConcurrentRuns=1 → 全局排队上限 4；先占槽 + 手动最先入队，随后 4 个自动挤满 → 手动被丢
    const world = await makeRunnerWorld({ maxConcurrentRuns: 1, auto: false })
    await world.service.create(baseInput())
    // 编排 A 的自动 run 占住唯一并发槽（挂起）
    await world.service.create({ ...baseInput(), id: 'blocker', title: 'blocker', trigger: { kind: 'every', everySeconds: 3600 } })
    await world.runner.requestRun({ orchestrationId: 'blocker', trigger: 'every', scheduledAtMs: NOW })
    // log-rotate 手动 run 最先排队（最旧）
    const manual = await world.service.run('log-rotate')
    expect(manual.status).toBe('queued')
    // 再塞 4 个不同编排的 run 挤满全局队列（上限 4：blocker 占槽 + pending 4）
    for (let n = 0; n < 4; n++) {
      const id = `fill-${n}`
      await world.service.create({ ...baseInput(), id, title: id, trigger: { kind: 'every', everySeconds: 3600 } })
      await world.runner.requestRun({ orchestrationId: id, trigger: 'every', scheduledAtMs: NOW })
    }
    // 手动（最旧 pending）被丢为 skipped(concurrency)，可见非静默
    expect(manual.status).toBe('queued') // 受理视图仍是当时快照
    const dropped = world.storage.snapshot().runs[manual.runId]
    expect(dropped.status).toBe('skipped')
    expect(dropped.skipReason).toBe('concurrency')
    // 放行占槽脚本；fills 依次领槽，逐个放行直至排干
    world.spawns[0].release({ exitCode: 0, signal: null })
    for (let round = 0; round < 20 && world.runner.hasInflight(); round += 1) {
      for (const spawnEntry of world.spawns) spawnEntry.release({ exitCode: 0, signal: null })
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await world.runner.waitIdle()
  })

  it('waitRun 尽力等待：上限内结算返回终态；超限不报错、返回当前（可能非终态的）视图', async () => {
    const world = await makeRunnerWorld({ auto: false, maxConcurrentRuns: 1 })
    await world.service.create({ ...baseInput(), trigger: { kind: 'every', everySeconds: 3600 } })
    // 占槽挂起脚本 → 手动 run 排队（非终态）
    await world.service.create({ ...baseInput(), id: 'blocker2', title: 'blocker2', trigger: { kind: 'every', everySeconds: 3600 } })
    await world.runner.requestRun({ orchestrationId: 'blocker2', trigger: 'every', scheduledAtMs: NOW })
    const manual = await world.service.run('log-rotate')
    expect(manual.status).toBe('queued')
    // 等待上限 50ms（注入）：超限返回非终态视图、不报错（契约 07 wait 语义）
    const timedOut = await world.service.waitRun(manual.runId, 'log-rotate', { maxWaitMs: 50 })
    expect(timedOut.status).toBe('queued')
    // 放行后等待立即拿到终态
    world.spawns[0].release({ exitCode: 0, signal: null })
    await new Promise((resolve) => setTimeout(resolve, 10))
    world.spawns[1]?.release({ exitCode: 0, signal: null })
    const final = await world.service.waitRun(manual.runId, 'log-rotate')
    expect(final.status).toBe('succeeded')
  })

  it('waitRun 默认等待上限 = script.timeoutSeconds + 30 秒（公式锚定）', async () => {
    const world = await makeRunnerWorld()
    await world.service.create({ ...baseInput(), script: { command: 'pwsh', timeoutSeconds: 90 } })
    const manual = await world.service.run('log-rotate')
    // 直接受理并结算（无阻塞），公式只影响上限——此处锚定 service 暴露的公式函数
    expect(typeof world.service.computeWaitBudgetMs).toBe('function')
    const budget = world.service.computeWaitBudgetMs('log-rotate')
    expect(budget).toBe(90_000 + 30_000)
    await world.service.waitRun(manual.runId, 'log-rotate')
  })
})
