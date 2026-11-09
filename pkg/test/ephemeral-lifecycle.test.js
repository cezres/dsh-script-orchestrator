// ephemeral 回收生命周期（契约 05 两模式表 + 决策 20/21；票 33）：
// 投递首条 → whenIdle() 收敛（挂 agent；含用户接管期间的对话——有人活动就不算 idle）
// → idleDisposeSeconds（默认 0；延迟期间新活动重置，决策 21 #5）→ handle.dispose()
// （teardown 不是删除：日志与 Workspace 关系保留，冷会话可重开）。
// 投递失败经 retain 只登记卸载清理、不启动回收计时；disposeAll 供插件卸载序列全量 teardown。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEphemeralRegistry } from '../lib/ephemeral-lifecycle.js'

/** fake agent：宿主诚实语义——初始 running（刚 followup），whenIdle 等当前 activityDone 门闩。 */
function makeFakeAgent() {
  const listeners = []
  let activityDone = Promise.withResolvers()
  const agent = {
    id: 'session-x',
    status: 'running',
    whenIdleCalls: 0,
    whenIdle() {
      agent.whenIdleCalls += 1
      return activityDone.promise
    },
    ctx: {
      on: (name, callback) => {
        listeners.push(callback)
        return () => {}
      },
    },
    /** 当前活动（turn/对话）结束：status → idle、发事件、放行 whenIdle 门闩。 */
    __endActivity: () => {
      agent.status = 'idle'
      for (const callback of listeners) callback({ status: 'idle' })
      activityDone.resolve()
    },
    /** 新活动开始（用户接管/新对话）：status → running、发事件、换上新门闩。 */
    __startActivity: () => {
      if (agent.status !== 'idle') return
      agent.status = 'running'
      for (const callback of listeners) callback({ status: 'running' })
      activityDone = Promise.withResolvers()
    },
  }
  return agent
}

const makeHandle = (calls = []) => ({ dispose: async () => { calls.push('dispose') } })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createEphemeralRegistry · 回收序列（whenIdle → idleDisposeSeconds → dispose）', () => {
  it('零延迟（缺省 0）：whenIdle 收敛后立即 dispose（契约序列字面：无计时窗口）', async () => {
    const agent = makeFakeAgent()
    const calls = []
    const registry = createEphemeralRegistry({ logger: { warn: (m) => calls.push(m) } })
    registry.adopt(makeHandle(calls), agent, 'session-x')
    expect(registry.isLive('session-x')).toBe(true)
    expect(calls).toEqual([]) // 活动（turn）未结束不回收
    agent.__endActivity()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(['dispose'])
    expect(registry.isLive('session-x')).toBe(false)
  })

  it('延迟回收（idleDisposeSeconds=5）：收敛后未到时不 dispose，到点 dispose', async () => {
    const agent = makeFakeAgent()
    const calls = []
    const registry = createEphemeralRegistry()
    registry.adopt(makeHandle(calls), agent, 'session-x', 5)
    agent.__endActivity()
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual(['dispose'])
    expect(registry.isLive('session-x')).toBe(false)
  })

  it('延迟期间新活动（含用户接管对话）重置计时：重新等 whenIdle 收敛后再起延迟（决策 21 #5）', async () => {
    const agent = makeFakeAgent()
    const calls = []
    const registry = createEphemeralRegistry()
    registry.adopt(makeHandle(calls), agent, 'session-x', 5)
    agent.__endActivity() // 首轮收敛，5s 延迟起臂
    await vi.advanceTimersByTimeAsync(2)
    agent.__startActivity() // 延迟窗口内用户接管/新对话开始
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls).toEqual([]) // 原延迟被重置：未到点
    agent.__endActivity() // 活动结束重新收敛
    await vi.advanceTimersByTimeAsync(4999)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual(['dispose'])
    expect(agent.whenIdleCalls).toBe(2) // 第二轮重新等了 whenIdle
  })

  it('病态防御：whenIdle 立即返回而 status 恒非 idle——不自旋（advance 能返回即证明）、不误 dispose；恢复健康后正常回收', async () => {
    const calls = []
    const registry = createEphemeralRegistry({ logger: { warn: (m) => calls.push(`warn:${m}`) } })
    const pathological = {
      id: 'session-patho',
      status: 'running',
      whenIdle: async () => {},
      ctx: { on: () => () => {} },
    }
    registry.adopt(makeHandle(calls), pathological, 'session-patho', 1)
    await vi.advanceTimersByTimeAsync(50) // 每轮经 1ms macrotask 让步：窗口有界、不饿死事件循环
    expect(calls.filter((c) => c !== 'dispose')).toEqual([])
    pathological.status = 'idle' // 恢复健康：回读通过 → 起臂延迟
    await vi.advanceTimersByTimeAsync(2000) // 窗口留余（让步计时各消耗 1ms）
    expect(calls).toContain('dispose')
    expect(calls.filter((c) => c === 'dispose')).toHaveLength(1)
  })
})

describe('createEphemeralRegistry · retain 与卸载（失败不回收；disposeAll 全量 teardown）', () => {
  it('retain（投递失败现场）：不启动回收——长期空闲也不 dispose；disposeAll 时统一 teardown', async () => {
    const calls = []
    const registry = createEphemeralRegistry()
    const handle = makeHandle(calls)
    registry.retain(handle, 'session-failed')
    expect(registry.isLive('session-failed')).toBe(true)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls).toEqual([]) // 失败现场不得秒回收（契约 05）
    await registry.disposeAll()
    expect(calls).toEqual(['dispose'])
    expect(registry.liveCount()).toBe(0)
  })

  it('disposeAll：清掉在途延迟计时并 dispose 全部 live（含延迟中条目）；此后生命周期不再 dispose（幂等，恰一次）', async () => {
    const pending = makeFakeAgent()
    const delayed = makeFakeAgent()
    const calls = []
    const registry = createEphemeralRegistry()
    registry.adopt(makeHandle(calls), pending, 'session-pending', 30) // 尚未收敛
    registry.adopt(makeHandle(calls), delayed, 'session-delayed', 30)
    delayed.__endActivity()
    await vi.advanceTimersByTimeAsync(5)
    await registry.disposeAll()
    expect(calls).toEqual(['dispose', 'dispose'])
    expect(registry.liveCount()).toBe(0)
    // 计时已清、条目已停：旧计时到点不再触发第二次 dispose
    await vi.advanceTimersByTimeAsync(120_000)
    pending.__endActivity()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls).toEqual(['dispose', 'dispose'])
  })

  it('dispose 抛错被吞（记日志不外溢）；whenIdle 抛错（防御）→ 记日志并尽力 dispose', async () => {
    const logs = []
    const registry = createEphemeralRegistry({ logger: { warn: (m) => logs.push(m) } })
    const bad = makeFakeAgent()
    const failing = { dispose: async () => { throw new Error('dispose boom') } }
    registry.adopt(failing, bad, 'session-bad', 0)
    bad.__endActivity()
    await vi.advanceTimersByTimeAsync(0)
    expect(logs.some((m) => String(m).includes('dispose'))).toBe(true)
    expect(registry.isLive('session-bad')).toBe(false) // 失败也移出登记（不重试）

    const angry = { id: 'session-angry', status: 'idle', whenIdle: async () => { throw new Error('whenIdle boom') }, ctx: { on: () => () => {} } }
    const calls = []
    registry.adopt(makeHandle(calls), angry, 'session-angry', 30)
    await vi.advanceTimersByTimeAsync(0)
    expect(logs.some((m) => String(m).includes('whenIdle'))).toBe(true)
    expect(calls).toEqual(['dispose']) // 无法观测 idle 时尽力回收，不留永久 live
  })
})
