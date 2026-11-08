import { describe, it, expect } from 'vitest'
import { Config } from '../lib/config.js'

describe('Config（同步 Standard Schema）', () => {
  it('未提供配置时给出契约默认值（maxRunsPerOrchestration = 100）', () => {
    const result = Config['~standard'].validate(undefined)
    expect(result.issues).toBeFalsy()
    expect(result.value).toEqual({
      maxRunsPerOrchestration: 100,
      maxConcurrentRuns: 2,
      defaultTimeoutSeconds: 300,
      maxOutputBytes: 262144,
      maxSpillBytes: 8388608,
      allowedRoots: [],
    })
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

  // ---- 票 26：执行配置（契约 03 调用形态 / 并发与单飞 / 安全边界） ----

  it('执行默认值：maxConcurrentRuns=2、defaultTimeoutSeconds=300、maxOutputBytes=262144、maxSpillBytes=8388608、allowedRoots=[]', () => {
    const result = Config['~standard'].validate(undefined)
    expect(result.value).toMatchObject({
      maxConcurrentRuns: 2,
      defaultTimeoutSeconds: 300,
      maxOutputBytes: 262144,
      maxSpillBytes: 8388608,
      allowedRoots: [],
    })
  })

  it('maxSpillBytes=0 合法（禁用溢写，仅内存尾部）；defaultCwd 可选字符串', () => {
    const result = Config['~standard'].validate({ maxSpillBytes: 0, defaultCwd: 'D:\\work' })
    expect(result.issues).toBeFalsy()
    expect(result.value.maxSpillBytes).toBe(0)
    expect(result.value.defaultCwd).toBe('D:\\work')
  })

  it.each([
    ['maxConcurrentRuns 非法', { maxConcurrentRuns: 0 }],
    ['defaultTimeoutSeconds 超上界', { defaultTimeoutSeconds: 86401 }],
    ['defaultTimeoutSeconds 低于 1', { defaultTimeoutSeconds: 0 }],
    ['maxOutputBytes 非整数', { maxOutputBytes: 1.5 }],
    ['maxOutputBytes 低于 1', { maxOutputBytes: 0 }],
    ['maxSpillBytes 负数', { maxSpillBytes: -1 }],
    ['allowedRoots 非数组', { allowedRoots: 'D:\\work' }],
    ['allowedRoots 元素非字符串', { allowedRoots: ['D:\\work', 42] }],
    ['defaultCwd 非字符串', { defaultCwd: 42 }],
  ])('%s 被拒绝（非法配置不产生半初始化服务）', (_label, input) => {
    const result = Config['~standard'].validate(input)
    expect(result.issues?.length).toBeGreaterThan(0)
  })
})
