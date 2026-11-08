import { describe, it, expect } from 'vitest'
import { nextOccurrence } from '../lib/triggers.js'

const T0 = 1_790_000_000_000 // 任意锚点（毫秒）

describe('nextOccurrence（纯函数，契约 docs/temp/02-triggers.md「下次触发计算」）', () => {
  it('every：返回 fromMs + everySeconds*1000（fixed-rate 创建锚点 = createdAt）', () => {
    expect(nextOccurrence({ kind: 'every', everySeconds: 300, mode: 'fixed-rate' }, T0)).toBe(T0 + 300_000)
  })

  it('every：fixed-delay 的首次计划同为 createdAt + everySeconds（02「创建」）', () => {
    expect(nextOccurrence({ kind: 'every', everySeconds: 60, mode: 'fixed-delay' }, T0)).toBe(T0 + 60_000)
  })

  it('返回值严格大于 fromMs', () => {
    for (const seconds of [60, 61, 3600, 86_400]) {
      expect(nextOccurrence({ kind: 'every', everySeconds: seconds }, T0)).toBeGreaterThan(T0)
    }
  })

  it('everySeconds 缺省 mode 不影响计算（mode 由创建校验归一化，函数只读 kind/everySeconds）', () => {
    expect(nextOccurrence({ kind: 'every', everySeconds: 120 }, T0)).toBe(T0 + 120_000)
  })

  it('非 every kind 返回 null（cron 属票 27；非法 kind 在创建校验先行拒绝）', () => {
    expect(nextOccurrence({ kind: 'cron' }, T0)).toBeNull()
    expect(nextOccurrence(undefined, T0)).toBeNull()
    expect(nextOccurrence({ kind: 'daily' }, T0)).toBeNull()
  })
})
