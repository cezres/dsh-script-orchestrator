// 判定求值与模板渲染（契约 docs/temp/04-judge.md）：纯函数，只读本次 run 的脚本结果。
// 票 26 交付谓词求值与「零动作」结算口径；票 30 交付模板渲染（变量/json:/转义/递归
// payload/warnings）与 buildTemplateVariables 变量折算；动作执行编排属 lib/actions.js。
import { describe, it, expect } from 'vitest'
import {
  evaluateJudge,
  renderTemplate,
  renderPayload,
  buildTemplateVariables,
  appendWarning,
  WARNING_LIMIT,
} from '../lib/judge.js'

const facts = (over = {}) => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 1200,
  stdoutText: '',
  stderrText: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  ...over,
})

describe('evaluateJudge · 判定结果三态（契约 04 判定结果表）', () => {
  it('规则下标 N 命中 → matchedRule=N、usedFallback=false', () => {
    const result = evaluateJudge(
      { rules: [{ when: { exitCode: 0 }, actions: ['a'] }, { when: { exitCode: 1 }, actions: ['b'] }], fallback: ['c'] },
      facts(),
    )
    expect(result).toEqual({ matchedRule: 0, usedFallback: false, actionKeys: ['a'] })
  })

  it('无规则命中且省略 fallback → matchedRule=null、usedFallback=false、零动作', () => {
    const result = evaluateJudge({ rules: [{ when: { exitCode: 2 }, actions: ['a'] }], fallback: [] }, facts())
    expect(result).toEqual({ matchedRule: null, usedFallback: false, actionKeys: [] })
  })

  it('无规则命中走 fallback → usedFallback=true', () => {
    const result = evaluateJudge(
      { rules: [{ when: { exitCode: 2 }, actions: ['a'] }], fallback: ['b', 'c'] },
      facts({ exitCode: 1 }),
    )
    expect(result).toEqual({ matchedRule: null, usedFallback: true, actionKeys: ['b', 'c'] })
  })

  it('规则命中但 actions 为空 → 零动作、不再看 fallback', () => {
    const result = evaluateJudge(
      { rules: [{ when: { exitCode: 0 }, actions: [] }], fallback: ['b'] },
      facts(),
    )
    expect(result).toEqual({ matchedRule: 0, usedFallback: false, actionKeys: [] })
  })

  it('第一条命中即停，其余规则不求值（契约 04：按顺序首匹配生效）', () => {
    const result = evaluateJudge(
      { rules: [{ when: { exitCode: { not: 0 } }, actions: ['first'] }, { when: { exitCode: 1 }, actions: ['second'] }], fallback: [] },
      facts({ exitCode: 1 }),
    )
    expect(result.matchedRule).toBe(0)
    expect(result.actionKeys).toEqual(['first'])
  })

  it('rules 为空数组且无 fallback → 零动作（票 26「零动作按契约结算」的基础路径）', () => {
    expect(evaluateJudge({ rules: [], fallback: [] }, facts())).toEqual({
      matchedRule: null,
      usedFallback: false,
      actionKeys: [],
    })
  })
})

describe('evaluateJudge · 谓词求值（契约 04 谓词表）', () => {
  it('exitCode：数字相等 / not / in / min-max', () => {
    const judge = (when) => evaluateJudge({ rules: [{ when, actions: ['x'] }], fallback: [] }, facts())
    expect(judge({ exitCode: 0 }).matchedRule).toBe(0)
    expect(judge({ exitCode: 1 }).matchedRule).toBe(null)
    expect(judge({ exitCode: { not: 0 } }).matchedRule).toBe(null)
    expect(judge({ exitCode: { not: 1 } }).matchedRule).toBe(0)
    expect(judge({ exitCode: { in: [0, 2] } }).matchedRule).toBe(0)
    expect(judge({ exitCode: { in: [2, 3] } }).matchedRule).toBe(null)
    expect(judge({ exitCode: { min: 0, max: 5 } }).matchedRule).toBe(0)
    expect(judge({ exitCode: { min: 1 } }).matchedRule).toBe(null)
  })

  it('signal 与 timedOut、durationMs 区间', () => {
    const judge = (when, over) => evaluateJudge({ rules: [{ when, actions: ['x'] }], fallback: [] }, facts(over))
    expect(judge({ signal: null }).matchedRule).toBe(0)
    expect(judge({ signal: 'SIGTERM' }, { signal: 'SIGTERM', exitCode: null }).matchedRule).toBe(0)
    expect(judge({ timedOut: true }).matchedRule).toBe(null)
    expect(judge({ timedOut: true }, { timedOut: true }).matchedRule).toBe(0)
    expect(judge({ durationMs: { max: 1000 } }).matchedRule).toBe(null)
    expect(judge({ durationMs: { min: 1000, max: 2000 } }).matchedRule).toBe(0)
  })

  it('stdout/stderr：contains / regex+flags / truncated 按流', () => {
    const over = { stdoutText: 'deploy DEGRADED\n', stderrText: 'warn: disk', stderrTruncated: true }
    const judge = (when) => evaluateJudge({ rules: [{ when, actions: ['x'] }], fallback: [] }, facts(over))
    expect(judge({ stdout: { contains: 'DEGRADED' } }).matchedRule).toBe(0)
    expect(judge({ stdout: { contains: 'missing' } }).matchedRule).toBe(null)
    expect(judge({ stdout: { regex: 'degraded', flags: 'i' } }).matchedRule).toBe(0)
    expect(judge({ stdout: { regex: 'degraded' } }).matchedRule).toBe(null)
    expect(judge({ stderr: { truncated: true } }).matchedRule).toBe(0)
    expect(judge({ stderr: { truncated: false } }).matchedRule).toBe(null)
  })

  it('stdout jsonPath + equals / notEquals：合法 JSON 按极简路径取值；路径缺失为不成立', () => {
    const over = { stdoutText: JSON.stringify({ status: 'ok', items: [{ state: 'bad' }] }) }
    const judge = (when) => evaluateJudge({ rules: [{ when, actions: ['x'] }], fallback: [] }, facts(over))
    expect(judge({ stdout: { jsonPath: '$.status', equals: 'ok' } }).matchedRule).toBe(0)
    expect(judge({ stdout: { jsonPath: '$.status', equals: 'bad' } }).matchedRule).toBe(null)
    expect(judge({ stdout: { jsonPath: '$.status', notEquals: 'bad' } }).matchedRule).toBe(0)
    expect(judge({ stdout: { jsonPath: '$.items[0].state', equals: 'bad' } }).matchedRule).toBe(0)
    expect(judge({ stdout: { jsonPath: '$.missing.deep', equals: 'ok' } }).matchedRule).toBe(null)
  })

  it('stdout 非合法 JSON 时 jsonPath 谓词不成立（解析失败按路径不存在）', () => {
    const judge = (when) => evaluateJudge({ rules: [{ when, actions: ['x'] }], fallback: [] }, facts({ stdoutText: 'not-json' }))
    expect(judge({ stdout: { jsonPath: '$.status', equals: 'ok' } }).matchedRule).toBe(null)
  })

  it('同一谓词对象多键 AND；all/any 组合', () => {
    const judge = (when, over) => evaluateJudge({ rules: [{ when, actions: ['x'] }], fallback: [] }, facts(over))
    expect(judge({ exitCode: 0, stdout: { contains: 'ok' } }, { stdoutText: 'ok' }).matchedRule).toBe(0)
    expect(judge({ exitCode: 0, stdout: { contains: 'nope' } }, { stdoutText: 'ok' }).matchedRule).toBe(null)
    expect(judge({ any: [{ exitCode: 5 }, { timedOut: true }] }, { timedOut: true }).matchedRule).toBe(0)
    expect(judge({ all: [{ exitCode: 5 }, { timedOut: true }] }, { timedOut: true }).matchedRule).toBe(null)
    expect(judge({ all: [{ exitCode: 0 }, { timedOut: true }] }, { timedOut: true }).matchedRule).toBe(0)
  })

  it('非零退出码不被当失败处理：exitCode 谓词照常可命中（票 26 口径）', () => {
    const result = evaluateJudge(
      { rules: [{ when: { exitCode: 1 }, actions: [] }], fallback: [] },
      facts({ exitCode: 1 }),
    )
    expect(result.matchedRule).toBe(0)
    expect(result.actionKeys).toEqual([])
  })
})

// ---------------- 模板渲染（契约 04「模板变量」；票 30） ----------------

const VARS = {
  orchestrationId: 'nightly-deploy-check',
  orchestrationTitle: '夜间部署巡检',
  runId: 'run-7f3c1a9e',
  trigger: 'every',
  scheduledAt: '2026-11-08T20:00:00.000Z',
  startedAt: '2026-11-08T20:00:00.100Z',
  exitCode: '0',
  signal: 'null',
  timedOut: 'false',
  durationMs: '3606',
  stdoutTail: 'deploy ok',
  stderrTail: '',
  truncated: 'false',
  matchedRule: '0',
}

describe('renderTemplate · 变量替换（契约 04 模板变量表）', () => {
  it('已知变量替换为折算后的文本', () => {
    const result = renderTemplate('{{orchestrationTitle}} 退出码 {{exitCode}}（{{durationMs}}ms）', VARS)
    expect(result.text).toBe('夜间部署巡检 退出码 0（3606ms）')
    expect(result.warnings).toEqual([])
  })

  it('未知变量替换为空字符串并记一条 warning（不整体失败）', () => {
    const result = renderTemplate('前 {{nope}} 后', VARS)
    expect(result.text).toBe('前  后')
    expect(result.warnings).toEqual(['unknown variable: {{nope}}'])
  })

  it('同一未知变量出现两次记两条（逐次出现逐条记录，确定性文案）', () => {
    const result = renderTemplate('{{a}}{{a}}', VARS)
    expect(result.warnings).toEqual(['unknown variable: {{a}}', 'unknown variable: {{a}}'])
  })

  it('字面量 {{ 用 \\{{ 转义：渲染为 {{ 且不展开其中的变量、不记 warning', () => {
    const result = renderTemplate('\\{{exitCode}} 与 \\{{json:$.x}}', VARS)
    expect(result.text).toBe('{{exitCode}} 与 {{json:$.x}}')
    expect(result.warnings).toEqual([])
  })

  it('替换只做一次：变量值中的 {{…}} 不再展开（避免注入式套娃）', () => {
    const result = renderTemplate('{{stdoutTail}}', { ...VARS, stdoutTail: '{{exitCode}}' })
    expect(result.text).toBe('{{exitCode}}')
    expect(result.warnings).toEqual([])
  })

  it('未闭合的 {{ 原样保留、不记 warning', () => {
    const result = renderTemplate('a {{ b', VARS)
    expect(result.text).toBe('a {{ b')
    expect(result.warnings).toEqual([])
  })

  it('无变量的纯文本原样返回', () => {
    const result = renderTemplate('plain text 100%', VARS)
    expect(result).toEqual({ text: 'plain text 100%', warnings: [] })
  })
})

describe('renderTemplate · json: 路径（与未知变量对称处理）', () => {
  it('stdout 为合法 JSON 且路径存在：插入取值（字符串原样）', () => {
    const result = renderTemplate('status={{json:$.status}}', VARS, { stdoutText: '{"status":"degraded"}' })
    expect(result.text).toBe('status=degraded')
    expect(result.warnings).toEqual([])
  })

  it('json: 取到非字符串值：按其 JSON 文本插入（数字/布尔/对象/数组/null）', () => {
    const stdoutText = '{"count":5,"ok":true,"meta":{"a":1},"list":[1,2],"n":null}'
    expect(renderTemplate('{{json:$.count}}', VARS, { stdoutText }).text).toBe('5')
    expect(renderTemplate('{{json:$.ok}}', VARS, { stdoutText }).text).toBe('true')
    expect(renderTemplate('{{json:$.meta}}', VARS, { stdoutText }).text).toBe('{"a":1}')
    expect(renderTemplate('{{json:$.list}}', VARS, { stdoutText }).text).toBe('[1,2]')
    expect(renderTemplate('{{json:$.n}}', VARS, { stdoutText }).text).toBe('null')
  })

  it('stdout 非合法 JSON：空字符串 + warning「stdout is not valid JSON」（不抛错）', () => {
    const result = renderTemplate('v={{json:$.status}}', VARS, { stdoutText: 'not json at all' })
    expect(result.text).toBe('v=')
    expect(result.warnings).toEqual(['stdout is not valid JSON'])
  })

  it('路径不存在/解析失败：空字符串 + warning「json path missing: <path>」', () => {
    const missing = renderTemplate('{{json:$.missing}}', VARS, { stdoutText: '{"status":"ok"}' })
    expect(missing.text).toBe('')
    expect(missing.warnings).toEqual(['json path missing: $.missing'])
    const deep = renderTemplate('{{json:$.items[3].state}}', VARS, { stdoutText: '{"items":[]}' })
    expect(deep.text).toBe('')
    expect(deep.warnings).toEqual(['json path missing: $.items[3].state'])
  })

  it('空 stdout 同按非合法 JSON 处理', () => {
    const result = renderTemplate('{{json:$.x}}', VARS, { stdoutText: '' })
    expect(result.text).toBe('')
    expect(result.warnings).toEqual(['stdout is not valid JSON'])
  })

  it('$ 根路径取整份 JSON', () => {
    const result = renderTemplate('{{json:$}}', VARS, { stdoutText: '{"a":1}' })
    expect(result.text).toBe('{"a":1}')
    expect(result.warnings).toEqual([])
  })
})

describe('renderPayload · 递归 payload 渲染（结构保留，恒为合法 JSON）', () => {
  it('只对字符串值替换；对象键不渲染（含 {{ 的键字面保留）；数字/布尔/null 原样；数组递归', () => {
    const payload = {
      '{{exitCode}}': '{{exitCode}}',
      severity: 'page',
      count: 7,
      enabled: false,
      nothing: null,
      summary: '{{orchestrationTitle}} 退出码 {{exitCode}}',
      nested: { list: ['{{runId}}', 3, { deep: '{{trigger}}' }] },
    }
    const rendered = renderPayload(payload, VARS)
    expect(rendered).toEqual({
      '{{exitCode}}': '0',
      severity: 'page',
      count: 7,
      enabled: false,
      nothing: null,
      summary: '夜间部署巡检 退出码 0',
      nested: { list: ['run-7f3c1a9e', 3, { deep: 'every' }] },
    })
  })

  it('字符串值中的 json: 取非字符串值按 JSON 文本插入；标量顶层 payload 原样', () => {
    const rendered = renderPayload({ msg: 'count={{json:$.count}}' }, VARS, { stdoutText: '{"count":9}' })
    expect(rendered).toEqual({ msg: 'count=9' })
    expect(renderPayload('top {{exitCode}}', VARS)).toBe('top 0')
    expect(renderPayload(42, VARS)).toBe(42)
  })

  it('warnings 汇入同一数组（与模板警告同源），不修改原 payload', () => {
    const warnings = []
    const payload = { a: '{{unknown-var}}', b: '{{json:$.gone}}' }
    const rendered = renderPayload(payload, VARS, { stdoutText: '{"x":1}' }, warnings)
    expect(rendered).toEqual({ a: '', b: '' })
    expect(warnings).toEqual(['unknown variable: {{unknown-var}}', 'json path missing: $.gone'])
    expect(payload).toEqual({ a: '{{unknown-var}}', b: '{{json:$.gone}}' })
  })
})

describe('buildTemplateVariables · 变量折算（契约 04 变量表）', () => {
  const base = () => ({
    orchestration: { id: 'nightly-deploy-check', title: '夜间部署巡检' },
    run: { runId: 'run-7f3c1a9e', trigger: 'every', scheduledAt: '2026-11-08T20:00:00.000Z', startedAt: '2026-11-08T20:00:00.100Z' },
    script: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 3606,
      stdoutTail: 'deploy ok',
      stderrTail: '',
      truncated: false,
    },
    verdict: { matchedRule: 0, usedFallback: false, actionKeys: [] },
  })

  it('全变量折算：标识/时间/脚本结果；truncated 渲染 true/false 字面量', () => {
    expect(buildTemplateVariables(base())).toEqual(VARS)
  })

  it('matchedRule 折算：命中 → 下标；fallback → "fallback"；全未命中 → "none"', () => {
    expect(buildTemplateVariables({ ...base(), verdict: { matchedRule: 0, usedFallback: false } }).matchedRule).toBe('0')
    expect(buildTemplateVariables({ ...base(), verdict: { matchedRule: null, usedFallback: true } }).matchedRule).toBe('fallback')
    expect(buildTemplateVariables({ ...base(), verdict: { matchedRule: null, usedFallback: false } }).matchedRule).toBe('none')
  })

  it('exitCode/signal 为 null（信号杀死）时折算为 "null"；timedOut/truncated 为 true', () => {
    const variables = buildTemplateVariables({
      ...base(),
      script: { exitCode: null, signal: 'SIGTERM', timedOut: true, durationMs: 500, stdoutTail: '', stderrTail: 'x', truncated: true },
    })
    expect(variables.exitCode).toBe('null')
    expect(variables.signal).toBe('SIGTERM')
    expect(variables.timedOut).toBe('true')
    expect(variables.truncated).toBe('true')
  })
})

describe('appendWarning · warnings 纪律（保留最近 20 条，超出丢最旧）', () => {
  it('追加到 20 条上限后继续追加丢最旧', () => {
    const warnings = []
    for (let index = 0; index < 25; index += 1) appendWarning(warnings, `w${index}`)
    expect(warnings).toHaveLength(WARNING_LIMIT)
    expect(warnings[0]).toBe('w5')
    expect(warnings[19]).toBe('w24')
  })
})
