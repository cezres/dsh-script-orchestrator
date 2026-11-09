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

  it('非 every/cron kind 返回 null（非法 kind 在创建校验先行拒绝）', () => {
    expect(nextOccurrence({ kind: 'daily' }, T0)).toBeNull()
    expect(nextOccurrence(undefined, T0)).toBeNull()
  })
})

describe('nextOccurrence · cron（契约 02「cron 子集」「时区与夏令时」「下次触发计算」；dsh-util-time Cron）', () => {
  const cron = (expression, timeZone = 'UTC') => ({ kind: 'cron', expression, timeZone })
  // 锚点取真实时刻，保证 DST 断言有独立事实源（IANA tzdb 固定规则）
  const at = (isoText) => Date.parse(isoText)

  it('严格大于 fromMs：fromMs 恰为匹配时刻时返回下一次', () => {
    const trigger = cron('0 3 * * *', 'UTC')
    const from = at('2026-11-09T03:00:00.000Z')
    expect(nextOccurrence(trigger, from)).toBe(at('2026-11-10T03:00:00.000Z'))
  })

  it('每日 03:00（Asia/Shanghai）：按本地钟表时间换算 UTC', () => {
    const trigger = cron('0 3 * * *', 'Asia/Shanghai')
    const from = at('2026-11-09T00:00:00.000Z')
    expect(nextOccurrence(trigger, from)).toBe(at('2026-11-09T19:00:00.000Z')) // 本地 09 日 03:00 = UTC 08 日 19:00
  })

  it('分钟列表与小时并列（0,30 9 * * *）：取列表内下一个', () => {
    const from = at('2026-11-09T09:10:00.000Z')
    expect(nextOccurrence(cron('0,30 9 * * *'), from)).toBe(at('2026-11-09T09:30:00.000Z'))
    expect(nextOccurrence(cron('0,30 9 * * *'), at('2026-11-09T09:30:00.000Z'))).toBe(at('2026-11-10T09:00:00.000Z'))
  })

  it('星期 0 与 7 同为周日：两种写法结果一致', () => {
    const from = at('2026-11-09T00:00:00.000Z') // 周一
    const by0 = nextOccurrence(cron('0 9 * * 0'), from)
    const by7 = nextOccurrence(cron('0 9 * * 7'), from)
    expect(by0).toBe(by7)
    expect(by0).toBe(at('2026-11-15T09:00:00.000Z')) // 下周日
  })

  it('每周一三五 09:00（面板每周预设的生成形态）', () => {
    const from = at('2026-11-09T00:00:00.000Z') // 周一
    expect(nextOccurrence(cron('0 9 * * 1,3,5'), from)).toBe(at('2026-11-09T09:00:00.000Z'))
    expect(nextOccurrence(cron('0 9 * * 1,3,5'), at('2026-11-09T09:00:00.000Z'))).toBe(at('2026-11-11T09:00:00.000Z')) // 周三
    expect(nextOccurrence(cron('0 9 * * 1,3,5'), at('2026-11-13T09:00:00.000Z'))).toBe(at('2026-11-16T09:00:00.000Z')) // 周五 → 下周一
  })

  it('Vixie 语义：day-of-month 与 day-of-week 同时受限取「或」', () => {
    // 每月 1 号或每周一 00:00：两个分支的最近时刻按时间先者取
    const trigger = cron('0 0 1 * 1')
    expect(nextOccurrence(trigger, at('2026-11-08T00:00:00.000Z'))).toBe(at('2026-11-09T00:00:00.000Z')) // 周一分支
    expect(nextOccurrence(trigger, at('2026-11-09T00:00:00.000Z'))).toBe(at('2026-11-16T00:00:00.000Z')) // 下一个周一
    expect(nextOccurrence(trigger, at('2026-11-30T00:00:00.000Z'))).toBe(at('2026-12-01T00:00:00.000Z')) // 1 号分支（周二）
    expect(nextOccurrence(trigger, at('2026-12-01T00:00:00.000Z'))).toBe(at('2026-12-07T00:00:00.000Z')) // 又一个周一
  })

  it('DST 春季不存在（Europe/Berlin 2027-03-28 02:30）：跳过该次，顺延下一有效时刻', () => {
    // 2027-03-28 是柏林春季跳变（02:00→03:00），本地 02:30 不存在；
    // 表达式固定每年 3 月 28 日 02:30 → 2027 年该次跳过，取 2028-03-28 02:30（非跳变日，夏令时 UTC+2）
    const trigger = cron('30 2 28 3 *', 'Europe/Berlin')
    const from = at('2027-03-01T00:00:00.000Z')
    expect(nextOccurrence(trigger, from)).toBe(at('2028-03-28T00:30:00.000Z'))
  })

  it('DST 春季跨跳变的每分钟规则：gap 内本地分钟不存在，顺延到 03:00', () => {
    // 柏林 2027-03-28 02:00–03:00 本地不存在；从跳变前一分钟起，下一次是本地 03:00 = 01:00Z
    const trigger = cron('* * * * *', 'Europe/Berlin')
    const from = at('2027-03-28T00:59:00.000Z') // 本地 01:59（冬令时 UTC+1）
    expect(nextOccurrence(trigger, from)).toBe(at('2027-03-28T01:00:00.000Z')) // 本地 03:00（夏令时 UTC+2）
  })

  it('DST 秋季重复（Europe/Berlin 2027-10-31 02:30 出现两次）：取较早瞬时', () => {
    // 柏林 2027-10-31 03:00 回拨到 02:00：本地 02:30 = 00:30Z（第一次）与 01:30Z（第二次）→ 取较早
    const trigger = cron('30 2 * * *', 'Europe/Berlin')
    const from = at('2027-10-31T00:00:00.000Z')
    expect(nextOccurrence(trigger, from)).toBe(at('2027-10-31T00:30:00.000Z'))
  })

  it('南半球时区（Australia/Sydney）按其 DST 规则换算', () => {
    const trigger = cron('0 6 * * *', 'Australia/Sydney')
    const from = at('2027-01-15T00:00:00.000Z') // 悉尼夏令时 UTC+11；本地 15 日 06:00 已过（= 14 日 19:00Z）
    expect(nextOccurrence(trigger, from)).toBe(at('2027-01-15T19:00:00.000Z')) // 本地 16 日 06:00
  })

  it('五年窗口无解 → null（契约 02：5 年窗口内有界求解）', () => {
    // 2 月 29 日规则：fromMs 取 2097-03-01（其后 2100/2101–2103 均非闰年，下一个 2/29 是 2104-02-29，
    // 距 fromMs 超 5 年窗口）→ 无解
    const trigger = cron('0 3 29 2 *', 'UTC')
    expect(nextOccurrence(trigger, at('2097-03-01T00:00:00.000Z'))).toBeNull()
    // 同一规则在 2026-11（5 年窗口内有 2028-02-29）有解
    expect(nextOccurrence(trigger, at('2026-11-09T00:00:00.000Z'))).toBe(at('2028-02-29T03:00:00.000Z'))
  })

  it('永不匹配的表达式（2 月 30 日）→ null（库 400 年地平线穷尽）', () => {
    expect(nextOccurrence(cron('0 3 30 2 *'), at('2026-11-09T00:00:00.000Z'))).toBeNull()
  })

  it('非法 cron 形状（防御面：绕过创建校验的记录）返回 null 而不抛出', () => {
    expect(nextOccurrence(cron('@daily', 'UTC'), T0)).toBeNull()
    expect(nextOccurrence(cron('*/10 * * * * *', 'UTC'), T0)).toBeNull()
    expect(nextOccurrence(cron('0 3 * * *', 'Not/AZone'), T0)).toBeNull()
    expect(nextOccurrence({ kind: 'cron', timeZone: 'UTC' }, T0)).toBeNull()
  })
})
