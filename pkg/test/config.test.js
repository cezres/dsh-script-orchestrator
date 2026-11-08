import { describe, it, expect } from 'vitest'
import { Config } from '../lib/config.js'

describe('Config（同步 Standard Schema）', () => {
  it('未提供配置时给出契约默认值（maxRunsPerOrchestration = 100）', () => {
    const result = Config['~standard'].validate(undefined)
    expect(result.issues).toBeFalsy()
    expect(result.value).toEqual({ maxRunsPerOrchestration: 100 })
  })

  it('显式合法值覆盖默认值（schemastery 对未知键透传，不属于诊断范围）', () => {
    const result = Config['~standard'].validate({ maxRunsPerOrchestration: 50, unknownKey: true })
    expect(result.issues).toBeFalsy()
    expect(result.value.maxRunsPerOrchestration).toBe(50)
  })

  it('null 按 schemastery 语义视为未提供，回落默认值', () => {
    const result = Config['~standard'].validate({ maxRunsPerOrchestration: null })
    expect(result.issues).toBeFalsy()
    expect(result.value.maxRunsPerOrchestration).toBe(100)
  })

  it.each([
    ['低于下界', 0],
    ['负数', -1],
    ['非整数', 1.5],
    ['类型错误（字符串）', '100'],
    ['类型错误（布尔）', true],
  ])('非法值 %s 被拒绝并给出 issues 诊断', (_label, input) => {
    const result = Config['~standard'].validate({ maxRunsPerOrchestration: input })
    expect(result.issues?.length).toBeGreaterThan(0)
  })

})
