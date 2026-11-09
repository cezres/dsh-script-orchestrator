// Windows 实际进程集成测试（票 26 验收项）：runner 对真实子进程的执行、超时终止
//（W1 实测语义 {exitCode:1, signal:null}）、输出双层收集（spill）、以及正常退出后
// 存活后代的有界等待 2000ms → terminate → descendants-terminated。
// 使用 registry 镜像的 @deepseek-ai/dsh-subprocess-local@0.2.2-rc.1（与宿主同版），
// 经最小 fake ctx 实例化（Service 基类只需要 reflect/effect 面）。
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createRunner } from '../lib/runner.js'
import { ServiceQueue } from '../lib/fifo.js'

const runtimeDisposers = []
const runtime = new LocalSubprocessRuntime({
  reflect: { provide() {}, get: () => undefined },
  effect(fn) {
    const dispose = fn()
    runtimeDisposers.push(dispose)
    return () => {}
  },
})
afterAll(async () => {
  for (const dispose of runtimeDisposers) await dispose?.()
})

const workDir = mkdtempSync(join(tmpdir(), 'orch26-'))
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const NOW = Date.now()
const iso = (ms) => new Date(ms).toISOString()

function makeStorage() {
  const tables = { orchestrations: new Map(), runs: new Map() }
  return {
    table: (name) => ({
      entries: () => tables[name].entries(),
      get: (key) => tables[name].get(key),
      put: (key, value) => {
        tables[name].set(key, value)
        return Promise.resolve()
      },
      delete: (key) => {
        tables[name].delete(key)
        return Promise.resolve()
      },
    }),
    snapshot: () => ({ orchestrations: Object.fromEntries(tables.orchestrations), runs: Object.fromEntries(tables.runs) }),
  }
}

function makeRunner(orchestrationOver = {}, configOver = {}) {
  const storage = makeStorage()
  storage.table('orchestrations').put('proc', {
    id: 'proc',
    title: '真实进程',
    enabled: true,
    overlap: 'skip',
    trigger: { kind: 'every', everySeconds: 3600, mode: 'fixed-rate' },
    script: { command: process.execPath, args: [], env: {} },
    judge: { rules: [], fallback: [] },
    actions: {},
    createdAt: iso(NOW),
    updatedAt: iso(NOW),
    status: 'active',
    nextOccurrence: iso(NOW + 3_600_000),
    ...orchestrationOver,
  })
  const emitted = []
  const runner = createRunner({
    storage,
    queue: new ServiceQueue(),
    subprocess: { spawn: (spec) => runtime.spawn(spec) },
    config: {
      maxConcurrentRuns: 2,
      defaultTimeoutSeconds: 300,
      maxOutputBytes: 262144,
      maxSpillBytes: 8388608,
      allowedRoots: [],
      maxRunsPerOrchestration: 100,
      ...configOver,
    },
    emit: (name, payload) => emitted.push([name, payload]),
    now: () => Date.now(),
    logger: console,
    hostCwd: workDir,
  })
  return { runner, storage, emitted }
}

describe('真实进程执行（Windows · 实际子进程）', () => {
  it('正常退出：stdout 收集、exitCode=0、零动作 succeeded；argv 不经 shell（引号空格保持字面量）', async () => {
    const arg = 'has "quotes" and spaces'
    const ctx = makeRunner({
      script: { command: process.execPath, args: ['-e', `console.log(JSON.stringify(process.argv.slice(1)))`, 'x', arg], env: {} },
    })
    const view = await ctx.runner.requestRun({ orchestrationId: 'proc', trigger: 'manual', scheduledAtMs: Date.now() })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded')
    expect(run.script.exitCode).toBe(0)
    expect(run.script.truncated).toBe(false)
    const echoed = JSON.parse(run.script.stdoutTail)
    expect(echoed).toEqual(['x', arg]) // 未经 shell 拼接，字面量保真
    expect(ctx.emitted.map(([n]) => n)).toEqual(['script-orchestrator/run-started', 'script-orchestrator/run-settled'])
  }, 30_000)

  it('非零退出（exit 3）：不是执行失败——照常判定、零动作 succeeded、exitCode=3', async () => {
    const ctx = makeRunner({
      script: { command: process.execPath, args: ['-e', 'process.exit(3)'], env: {} },
    })
    const view = await ctx.runner.requestRun({ orchestrationId: 'proc', trigger: 'manual', scheduledAtMs: Date.now() })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded')
    expect(run.script.exitCode).toBe(3)
    expect(run.script.timedOut).toBe(false)
  }, 30_000)

  it('超时：timeoutSeconds=1 挂起脚本 → terminate → timedOut=true + Windows Job 语义 {exitCode:1, signal:null}', async () => {
    const ctx = makeRunner({
      script: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, timeoutSeconds: 1 },
    })
    const view = await ctx.runner.requestRun({ orchestrationId: 'proc', trigger: 'manual', scheduledAtMs: Date.now() })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.status).toBe('succeeded') // 超时不是执行失败
    expect(run.script.timedOut).toBe(true)
    expect(run.script.exitCode).toBe(1) // W1 实测：Job 终止 done resolve {1, null}
    expect(run.script.signal).toBe(null)
    expect(run.script.durationMs).toBeGreaterThanOrEqual(900)
  }, 30_000)

  it('输出双层收集：超 maxBytes(500) 的输出 → lossy=true、truncated=true、spill 文件可读全量（W2a 语义）', async () => {
    // 200 行 × 16 字节 = 3200 字节 > maxBytes 500；spill 8MiB 承载全量
    const ctx = makeRunner(
      { script: { command: process.execPath, args: ['-e', 'for (let i = 0; i < 200; i++) console.log("line-" + String(i).padStart(4, "0"))'], env: {} } },
      { maxOutputBytes: 500 },
    )
    const view = await ctx.runner.requestRun({ orchestrationId: 'proc', trigger: 'manual', scheduledAtMs: Date.now() })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.script.truncated).toBe(true)
    expect(run.script.stdoutTail).toContain('line-0199') // 尾部含末行
    expect(run.script.stdoutTail).not.toContain('line-0000') // 首行已被内存尾部截掉
    expect(typeof run.script.stdoutSpillPath).toBe('string') // 溢写成立
    const { readFile } = await import('node:fs/promises')
    const spill = await readFile(run.script.stdoutSpillPath, 'utf8')
    expect(spill).toContain('line-0000') // 全量同时含首末行
    expect(spill).toContain('line-0199')
  }, 30_000)
})

describe('正常退出后存活后代（Windows · 实际进程，票 26 验收项）', () => {
  // 宿主现实（本机实测 dsh-subprocess-local@0.2.2-rc.1）：target 退出但 Job 内有存活
  // 后代时，done 与 waitForExit 均悬挂、target-exit 事实不可达，直至 terminate()。
  // 契约 03「done 结算脚本事实后有界等待 waitForExit() 2000ms」的顺序在该场景不可
  // 达（见票 26 Comments 偏差声明）；实际行为 = 由 timeoutSeconds 兜底 terminate →
  // done {exitCode:1, signal:null}（W1 语义）→ timedOut=true，进程树以 run 为上限
  // （Job 全杀）。descendants-terminated 的记录路径（done 已结算但范围未清）以
  // runner.test 的 fake 单测覆盖，此处验证真实进程的完整行为。
  it('父退出留后代：done 悬挂由超时兜底 → terminate 清 Job（后代确实死亡）→ timedOut 结算', async () => {
    const parentScript = `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      console.log('PARENT-DONE DESC:' + child.pid)
    `
    const ctx = makeRunner({
      script: { command: process.execPath, args: ['-e', parentScript], env: {}, timeoutSeconds: 2 },
    })
    const view = await ctx.runner.requestRun({ orchestrationId: 'proc', trigger: 'manual', scheduledAtMs: Date.now() })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    // 超时兜底：不是执行失败；Job 终止语义 {1, null}；父进程输出仍被完整收集
    expect(run.status).toBe('succeeded')
    expect(run.script.timedOut).toBe(true)
    expect(run.script.exitCode).toBe(1)
    expect(run.script.signal).toBe(null)
    expect(run.script.durationMs).toBeGreaterThanOrEqual(1900)
    expect(run.script.stdoutTail).toContain('PARENT-DONE')
    // 进程树生命周期以 run 为上限：后代进程已被 terminate 清理（ESRCH = 不存在）
    const match = /DESC:(\d+)/.exec(run.script.stdoutTail)
    expect(match).not.toBeNull()
    const descendantPid = Number.parseInt(match[1], 10)
    await vi.waitFor(() => {
      expect(() => process.kill(descendantPid, 0)).toThrow()
    })
  }, 60_000)

  it('无存活后代：done 即结算（exitCode=0）、无 descendants-terminated', async () => {
    const ctx = makeRunner({
      script: { command: process.execPath, args: ['-e', 'console.log("clean-exit")'], env: {} },
    })
    const view = await ctx.runner.requestRun({ orchestrationId: 'proc', trigger: 'manual', scheduledAtMs: Date.now() })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.script.warnings).toBeUndefined()
    expect(run.script.exitCode).toBe(0)
  }, 30_000)
})

describe('输出溢写边界（Windows · 实际子进程，票 34：W2b 与 UTF-8）', () => {
  it('超 spill cap 撤回：spill.maxBytes 500 + 3200 字节输出 → spillPath 缺省、truncated 仍 true、内存尾部不受影响（W2b）', async () => {
    const ctx = makeRunner(
      { script: { command: process.execPath, args: ['-e', 'for (let i = 0; i < 200; i++) console.log("line-" + String(i).padStart(4, "0"))'], env: {} } },
      { maxOutputBytes: 500, maxSpillBytes: 500 },
    )
    const view = await ctx.runner.requestRun({ orchestrationId: 'proc', trigger: 'manual', scheduledAtMs: Date.now() })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.script.truncated).toBe(true) // truncated 判定即 lossy，不受 spill 存在与否影响
    expect(run.script.stdoutSpillPath).toBeUndefined() // 超 cap 撤回
    expect(run.script.stdoutTail).toContain('line-0199') // 内存尾部不受影响
  }, 30_000)

  it('UTF-8 字节截断：多字节字符被切 → tail 为解码后文本末段、末行完整；maxSpillBytes=0 禁用溢写', async () => {
    const ctx = makeRunner(
      { script: { command: process.execPath, args: ['-e', 'for (let i = 0; i < 200; i++) console.log("中文" + String(i).padStart(4, "0"))'], env: {} } },
      { maxOutputBytes: 500, maxSpillBytes: 0 },
    )
    const view = await ctx.runner.requestRun({ orchestrationId: 'proc', trigger: 'manual', scheduledAtMs: Date.now() })
    await ctx.runner.waitIdle()
    const run = ctx.storage.snapshot().runs[view.runId]
    expect(run.script.truncated).toBe(true)
    expect(run.script.stdoutSpillPath).toBeUndefined() // 0 = 禁用溢写，仅内存尾部
    const tail = run.script.stdoutTail
    expect(Array.from(tail).length).toBeLessThanOrEqual(2048) // tail 上限 = 解码后末 2048 code point
    expect(tail).toContain('0199') // 末行仍在（尾部策略）
    // 解码结果必须是有效文本：编码/解码往返一致（无孤立代理项；宿主按 UTF-8 字节边界安全截断）
    expect(Buffer.from(tail, 'utf8').toString('utf8')).toBe(tail)
    expect(tail).toContain('中文')
  }, 30_000)
})
