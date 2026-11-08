import { describe, it, expect } from 'vitest'
import { ServiceQueue } from '../lib/fifo.js'

describe('ServiceQueue（服务层 FIFO）', () => {
  it('槽位按入队顺序串行执行，槽内多步不与后续槽交错', async () => {
    const q = new ServiceQueue()
    const trace = []
    const jobA = () =>
      q.enqueue(async () => {
        trace.push('A1')
        await Promise.resolve()
        trace.push('A2')
      })
    const jobB = () =>
      q.enqueue(async () => {
        trace.push('B1')
        await Promise.resolve()
        trace.push('B2')
      })
    const a = jobA()
    const b = jobB()
    await Promise.all([a, b])
    expect(trace).toEqual(['A1', 'A2', 'B1', 'B2'])
  })

  it('单槽失败只影响该槽调用方，后续槽照常执行', async () => {
    const q = new ServiceQueue()
    const trace = []
    const failing = q.enqueue(async () => {
      trace.push('fail')
      throw new Error('boom')
    })
    const after = q.enqueue(async () => {
      trace.push('after')
      return 42
    })
    await expect(failing).rejects.toThrow('boom')
    await expect(after).resolves.toBe(42)
    expect(trace).toEqual(['fail', 'after'])
  })

  it('close() 排干已入队槽位，之后的新槽被拒绝', async () => {
    const q = new ServiceQueue()
    const trace = []
    const pending = q.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      trace.push('drained')
    })
    const closing = q.close()
    await expect(q.enqueue(async () => trace.push('never'))).rejects.toThrow('closed')
    await Promise.all([pending, closing])
    expect(trace).toEqual(['drained'])
  })

})
