// 判定求值（契约 docs/temp/04-judge.md）：纯函数，只读本次 run 的脚本结果。
// 票 26 交付谓词求值与零动作结算口径（「零动作时按契约结算」「非零退出≠执行失败」）；
// 模板渲染与三类动作执行属票 30+，此处只产出动作键列表。
import { describe, it, expect } from 'vitest'
import { evaluateJudge } from '../lib/judge.js'

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
