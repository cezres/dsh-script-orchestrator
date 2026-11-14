// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

/** 捕获 window.__ModuleLoader__.load 注册的 bundle 定义。 */
async function loadClientBundle() {
  vi.resetModules()
  let captured = null
  window.__ModuleLoader__ = {
    load: (def) => {
      captured = def
    },
  }
  await import('../lib/client.js')
  expect(captured).toBeTruthy()
  // factory 自建 module/exports 并返回 module.exports
  const mod = captured.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require '${id}'`)
  })
  expect(mod).toBeTruthy()
  return { id: captured.id, exports: mod }
}

/** 用 mock slots ctx 驱动 apply 生成器到完成，捕获面板注册与注销器。 */
function mountRegistrations(clientExports, overCtx = {}) {
  const registrations = []
  const disposers = []
  const ctx = {
    effect: (fn) => fn(),
    on: () => () => {},
    slots: {
      inject: (slot, register) => {
        registrations.push({ slot, registration: register() })
        return () => {}
      },
      register: (definition, component) => ({ definition, component }),
    },
    ...overCtx,
  }
  const it = clientExports.apply(ctx)
  let result = it.next()
  while (!result.done) {
    // 每个 yield 的注销器必须是函数（宿主 Fiber 语义）
    expect(typeof result.value).toBe('function')
    disposers.push(result.value)
    result = it.next()
  }
  return { registrations, disposers }
}

const PANEL_KEY = 'script-orchestrator'

function panelEntry(registrations) {
  const entry = registrations.find(
    (r) => r.slot === 'main' && r.registration.definition.key === PANEL_KEY,
  )
  expect(entry).toBeTruthy()
  return entry.registration
}

async function renderPanel(props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(panelComponent, props))
  })
  return {
    text: () => container.textContent,
    click: async (label) => {
      const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
      expect(button, `button '${label}'`).toBeTruthy()
      await act(async () => {
        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
    },
    clickRow: async (needle) => {
      const row = [...container.querySelectorAll('tr')].find((tr) => tr.textContent.includes(needle))
      expect(row, `row containing '${needle}'`).toBeTruthy()
      await act(async () => {
        row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
    },
    clickInRow: async (needle, label) => {
      const row = [...container.querySelectorAll('tr')].find((tr) => tr.textContent.includes(needle))
      expect(row, `row containing '${needle}'`).toBeTruthy()
      const button = [...row.querySelectorAll('button')].find((b) => b.textContent === label)
      expect(button, `button '${label}' in row '${needle}'`).toBeTruthy()
      await act(async () => {
        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
    },
    modal: () => container.querySelector('div[style*="position: fixed"]'),
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

let panelComponent = null

const ORCH = {
  id: 'log-rotate',
  title: 'log rotate',
  enabled: true,
  overlap: 'skip',
  trigger: { kind: 'every', everySeconds: 300, mode: 'fixed-delay' },
  script: { command: 'pwsh', args: [], env: {} },
  judge: { rules: [], fallback: [] },
  actions: {},
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
  status: 'active',
  nextOccurrence: '2026-11-09T00:05:00.000Z',
}

function listResult(items = [ORCH]) {
  return { ok: true, value: { items, total: items.length, nextOffset: null } }
}

function viewResult() {
  return { ok: true, value: { ...ORCH, runs: [], availableActions: [] } }
}

describe('Web client（lib/client.js，简化档 lazy-CJS）', () => {
  it('bundle id 为包名，导出 apply（生成器）+ inject（slots/connection/uiWorkspace）', async () => {
    const { id, exports } = await loadClientBundle()
    expect(id).toBe('@echo/dsh-script-orchestrator')
    expect(exports.inject).toEqual(['slots', 'connection', 'uiWorkspace'])
    const it = exports.apply({ effect: (fn) => fn(), on: () => () => {}, slots: { inject: () => () => {}, register: () => ({}) } })
    expect(typeof it.next).toBe('function')
    expect(typeof it.next().value).toBe('function')
  })

  it('apply 注册 main 面板与 sidebar.panellist 图标（带 label）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    const slots = registrations.map((r) => r.slot).sort()
    expect(slots).toEqual(['main', 'sidebar.panellist'])
    const sidebar = registrations.find((r) => r.slot === 'sidebar.panellist').registration
    expect(sidebar.definition.id).toBe(PANEL_KEY)
    expect(sidebar.definition.label()).toContain('编排')
    const main = panelEntry(registrations)
    panelComponent = main.component
    const props = main.definition.inject()
    expect(typeof props.call).toBe('function')
    expect(typeof props.subscribeReset).toBe('function')
  })

  it('sidebar 图标是尺寸自适应 SVG：跟随宿主 16/18 尺寸、继承 currentColor、无字形文本', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    const icon = registrations.find((r) => r.slot === 'sidebar.panellist').registration.component
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(React.createElement(icon, { size: 16, active: false }))
      })
      const svg = container.querySelector('svg')
      expect(svg).toBeTruthy()
      expect(svg.getAttribute('width')).toBe('16')
      expect(svg.getAttribute('height')).toBe('16')
      expect(svg.getAttribute('viewBox')).toBe('0 0 20 20')
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(container.textContent).toBe('')
      // 全部笔画走 currentColor，宿主明暗/选中态自动生效
      expect([...svg.querySelectorAll('[stroke]')].every((el) => el.getAttribute('stroke') === 'currentColor')).toBe(true)
      // 折叠 rail 传 18
      await act(async () => {
        root.render(React.createElement(icon, { size: 18, active: true }))
      })
      expect(container.querySelector('svg').getAttribute('width')).toBe('18')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('面板三态：加载中 → 空列表（Host 权威数据）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    let resolveFirst
    const first = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const call = (endpoint, payload) => {
      calls.push([endpoint, payload])
      return first
    }
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    expect(view.text()).toContain('加载中')
    expect(calls).toEqual([['list', {}]])
    await act(async () => {
      resolveFirst({ ok: true, value: { items: [], total: 0, nextOffset: null } })
    })
    expect(view.text()).toContain('还没有编排')
    view.unmount()
  })

  it('传输/业务错误态：显示错误与重试按钮，重试重新拉取', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    let fail = true
    const call = () =>
      fail ? Promise.reject(new Error('transport failure for /script-orchestrator/list: HTTP 500')) : Promise.resolve({ ok: true, value: { items: [], total: 0, nextOffset: null } })
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    expect(view.text()).toContain('加载失败')
    expect(view.text()).toContain('HTTP 500')
    fail = false
    await view.click('重试')
    expect(view.text()).toContain('还没有编排')
    view.unmount()
  })

  it('connection/reset 事件触发权威回读', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const resetListeners = new Set()
    let calls = 0
    const call = () => {
      calls += 1
      return Promise.resolve({ ok: true, value: { items: [], total: 0, nextOffset: null } })
    }
    const view = await renderPanel({
      call,
      subscribeReset: (l) => {
        resetListeners.add(l)
        return () => resetListeners.delete(l)
      },
    })
    expect(calls).toBe(1)
    await act(async () => {
      for (const listener of [...resetListeners]) listener()
    })
    expect(calls).toBe(2)
    view.unmount()
  })

  it('startCreateSession 绑定：经 ctx.uiWorkspace.startSession 注入引导 prompt（含 script_create、whenDraftExists: append）', async () => {
    const { exports } = await loadClientBundle()
    const sessions = []
    const { registrations } = mountRegistrations(exports, {
      uiWorkspace: {
        startSession: (...args) => {
          sessions.push(args)
        },
      },
    })
    const props = panelEntry(registrations).definition.inject()
    expect(typeof props.startCreateSession).toBe('function')
    props.startCreateSession()
    expect(sessions).toHaveLength(1)
    const [sessionId, options] = sessions[0]
    expect(sessionId).toBeUndefined()
    expect(options.whenDraftExists).toBe('append')
    expect(options.prompt).toContain('script_create')
    expect(options.prompt).toContain('every')
    // 票 27：引导 prompt 覆盖 cron（五位表达式、显式时区、每日/每周预设生成 cron、周日为 0）
    expect(options.prompt).toContain('cron')
    expect(options.prompt).toContain('时区')
    expect(options.prompt).toContain('0 3 * * *')
    expect(options.prompt).toContain('周日')
  })

  it('startEditSession 绑定：经 ctx.uiWorkspace.startSession 注入编辑 prompt（含编排 id、script_view 先看、script_edit 修改）', async () => {
    const { exports } = await loadClientBundle()
    const sessions = []
    const { registrations } = mountRegistrations(exports, {
      uiWorkspace: {
        startSession: (...args) => {
          sessions.push(args)
        },
      },
    })
    const props = panelEntry(registrations).definition.inject()
    expect(typeof props.startEditSession).toBe('function')
    props.startEditSession('log-rotate', 'log rotate')
    expect(sessions).toHaveLength(1)
    const [sessionId, options] = sessions[0]
    expect(sessionId).toBeUndefined()
    expect(options.whenDraftExists).toBe('append')
    expect(options.prompt).toContain('log-rotate')
    expect(options.prompt).toContain('script_view')
    expect(options.prompt).toContain('script_edit')
    expect(options.prompt).toContain('当前配置')
  })

  it('面板渲染列表项：every 触发摘要、状态、下次时刻', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const view = await renderPanel({ call: () => Promise.resolve(listResult()), subscribeReset: () => () => {} })
    const text = view.text()
    expect(text).toContain('log rotate')
    expect(text).toContain('log-rotate')
    expect(text).toContain('every 5 分钟')
    expect(text).toContain('完成后再等')
    expect(text).toContain('运行中')
    expect(text).toContain('2026-11-09 00:05')
    expect(text).toContain('共 1 条')
    view.unmount()
  })

  it('点击行 → 居中模态经 view 回读详情：触发配置、状态与下次时刻、空执行记录、空注册动作；可关闭', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    const call = (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve(viewResult())
    }
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    expect(calls).toEqual([['list', {}]])
    await view.clickRow('log rotate')
    expect(calls[1]).toEqual(['view', { id: 'log-rotate' }])
    const modal = view.modal()
    expect(modal).toBeTruthy()
    expect(modal.getAttribute('style')).toContain('position: fixed')
    expect(modal.getAttribute('style')).toContain('center')
    const modalText = modal.textContent
    expect(modalText).toContain('触发配置')
    expect(modalText).toContain('every 5 分钟')
    expect(modalText).toContain('完成后再等')
    expect(modalText).toContain('状态与下次触发')
    expect(modalText).toContain('2026-11-09 00:05')
    expect(modalText).toContain('执行记录（0）')
    expect(modalText).toContain('还没有执行记录（创建不会立即执行脚本）')
    expect(modalText).toContain('暂无注册动作')
    await act(async () => {
      const close = [...modal.querySelectorAll('button')].find((b) => b.textContent === '关闭')
      close.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(view.modal()).toBeFalsy()
    view.unmount()
  })

  it('详情模态「编辑」按钮：点击 → startEditSession（id/title），不关闭模态、不额外回读（既有按钮与轮询不受影响）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    const started = []
    const call = (endpoint, payload) => {
      calls.push([endpoint, payload])
      return Promise.resolve(endpoint === 'list' ? listResult() : viewResult())
    }
    const view = await renderPanel({
      call,
      subscribeReset: () => () => {},
      startEditSession: (id, title) => started.push([id, title]),
    })
    await view.clickRow('log rotate')
    const modal = view.modal()
    const edit = [...modal.querySelectorAll('button')].find((b) => b.textContent === '编辑')
    expect(edit, "button '编辑'").toBeTruthy()
    expect([...modal.querySelectorAll('button')].some((b) => b.textContent === '关闭')).toBe(true)
    const viewCallsBefore = calls.filter(([endpoint]) => endpoint === 'view').length
    await act(async () => {
      edit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(started).toEqual([['log-rotate', 'log rotate']])
    expect(view.modal()).toBeTruthy() // 编辑入口不改面板状态（不关闭模态）
    expect(calls.filter(([endpoint]) => endpoint === 'view')).toHaveLength(viewCallsBefore) // 不额外回读
    view.unmount()
  })

  it('「新建」按钮触发对话式创建（不渲染任何配置表单）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const started = []
    const view = await renderPanel({
      call: () => Promise.resolve(listResult()),
      subscribeReset: () => () => {},
      startCreateSession: () => started.push(1),
    })
    await view.click('＋ 新建')
    expect(started).toHaveLength(1)
    expect(view.text()).not.toContain('保存')
    view.unmount()
  })

  it('刷新按钮触发 list 重读；页面回到可见触发回读', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    let calls = 0
    const call = () => {
      calls += 1
      return Promise.resolve(listResult())
    }
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    expect(calls).toBe(1)
    await view.click('刷新')
    expect(calls).toBe(2)
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new window.Event('visibilitychange'))
    })
    expect(calls).toBe(3)
    view.unmount()
  })

  it('connection/reset 时已打开的详情模态重新回读 view（详情与列表同为权威回读）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const resetListeners = new Set()
    const calls = []
    const call = (endpoint, payload) => {
      calls.push(endpoint)
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve(viewResult())
    }
    const view = await renderPanel({
      call,
      subscribeReset: (l) => {
        resetListeners.add(l)
        return () => resetListeners.delete(l)
      },
    })
    await view.clickRow('log rotate')
    expect(calls).toEqual(['list', 'view'])
    await act(async () => {
      for (const listener of [...resetListeners]) listener()
    })
    expect(calls).toEqual(['list', 'view', 'list', 'view'])
    view.unmount()
  })

  it('cron 编排：列表与详情模态显示表达式、时区与下次时刻；每日预设回显语义摘要（契约 02「每日/每周面板预设」）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const cronOrch = {
      ...ORCH,
      id: 'nightly-check',
      title: '夜间巡检',
      trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' },
    }
    const call = (endpoint) =>
      Promise.resolve(endpoint === 'list'
        ? { ok: true, value: { items: [cronOrch], total: 1, nextOffset: null } }
        : { ok: true, value: { ...cronOrch, runs: [], availableActions: [] } })
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    let text = view.text()
    expect(text).toContain('0 3 * * *')
    expect(text).toContain('Asia/Shanghai')
    expect(text).toContain('每天 03:00')
    expect(text).toContain('2026-11-09 00:05')
    await view.clickRow('夜间巡检')
    const modal = view.modal()
    expect(modal.textContent).toContain('0 3 * * *')
    expect(modal.textContent).toContain('Asia/Shanghai')
    expect(modal.textContent).toContain('每天 03:00')
    expect(modal.textContent).toContain('2026-11-09 00:05')
    view.unmount()
  })

  it('每周预设回显语义摘要（0 9 * * 1,3,5 / 周日 0 与 7 等价）；复杂表达式只显示原文', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const weekly = { ...ORCH, id: 'w', title: 'w', trigger: { kind: 'cron', expression: '0 9 * * 1,3,5', timeZone: 'UTC' } }
    const sunday = { ...ORCH, id: 's', title: 's', trigger: { kind: 'cron', expression: '0 9 * * 0', timeZone: 'UTC' } }
    const sunday7 = { ...ORCH, id: 's7', title: 's7', trigger: { kind: 'cron', expression: '0 9 * * 7', timeZone: 'UTC' } }
    const complex = { ...ORCH, id: 'c', title: 'c', trigger: { kind: 'cron', expression: '*/15 3 * * *', timeZone: 'UTC' } }
    const call = () =>
      Promise.resolve({ ok: true, value: { items: [weekly, sunday, sunday7, complex], total: 4, nextOffset: null } })
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    const text = view.text()
    expect(text).toContain('每周一/三/五 09:00')
    expect(text).toContain('每周日 09:00')
    expect(text).not.toContain('每天 09:00')
    // 复杂表达式（step）不强行回显简单摘要，只显示原文
    const complexRow = [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes('*/15'))
    expect(complexRow).toBeTruthy()
    expect(complexRow.textContent).toContain('*/15 3 * * *')
    view.unmount()
  })
})

describe('详情模态的脚本阶段结果与活动 run 轮询（契约 11「刷新策略」3：可见且有活动 run 时每 5 秒 view）', () => {
  const runView = (over = {}) => ({
    runId: 'run-7f3c1a9e',
    orchestrationId: 'log-rotate',
    trigger: 'every',
    scheduledAt: '2026-11-09T00:05:00.000Z',
    startedAt: '2026-11-09T00:05:00.100Z',
    settledAt: '2026-11-09T00:05:02.300Z',
    status: 'succeeded',
    skipReason: null,
    script: {
      command: 'pwsh',
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 2200,
      stdoutTail: 'deploy ok\nall checks passed',
      stderrTail: '',
      truncated: false,
    },
    matchedRule: 0,
    usedFallback: false,
    actions: [],
    ...over,
  })

  async function mountPanel(call) {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    return renderPanel({ call, subscribeReset: () => () => {} })
  }

  it('run 记录展示脚本阶段结果：状态/退出码/超时/耗时/截断/输出尾部/warnings/skipReason', async () => {
    const call = (endpoint) => {
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve({
        ok: true,
        value: {
          ...ORCH,
          runs: [
            runView(),
            runView({
              runId: 'run-00000002',
              status: 'skipped',
              skipReason: 'overlap',
              startedAt: null,
              settledAt: '2026-11-09T00:10:00.000Z',
              script: { command: 'pwsh', exitCode: null, signal: null, timedOut: false, durationMs: 0, stdoutTail: '', stderrTail: '', truncated: false },
              matchedRule: null,
              usedFallback: false,
            }),
            runView({
              runId: 'run-00000003',
              status: 'succeeded',
              script: {
                command: 'pwsh',
                exitCode: 1,
                signal: null,
                timedOut: true,
                durationMs: 3000,
                stdoutTail: 'partial output…',
                stderrTail: 'boom',
                truncated: true,
                warnings: ['descendants-terminated'],
              },
            }),
          ],
          availableActions: [],
        },
      })
    }
    const view = await mountPanel(call)
    await view.clickRow('log rotate')
    const modalText = view.modal().textContent
    expect(modalText).toContain('run-7f3c1a9e')
    expect(modalText).toContain('退出码 0')
    expect(modalText).toContain('2200ms')
    expect(modalText).toContain('deploy ok')
    expect(modalText).toContain('跳过（重叠）')
    expect(modalText).toContain('已超时')
    expect(modalText).toContain('已截断')
    expect(modalText).toContain('descendants-terminated')
    expect(modalText).toContain('partial output…')
    view.unmount()
  })

  it('票 30 三段结果：判定段（命中规则/fallback/未命中）与动作段（名/类型/状态/error/warnings）', async () => {
    const call = (endpoint) => {
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve({
        ok: true,
        value: {
          ...ORCH,
          runs: [
            runView({
              status: 'partial',
              matchedRule: 0,
              usedFallback: false,
              actions: [
                { name: 'emit-ok', kind: 'event', status: 'succeeded', warnings: ['unknown variable: {{nope}}'] },
                { name: 'page', kind: 'plugin', status: 'failed', error: { code: 'unknown_action', message: '注册动作 ops.oncall 未注册' } },
                { name: 'open-triage', kind: 'session', status: 'skipped' },
              ],
            }),
            runView({
              runId: 'run-00000009',
              status: 'succeeded',
              matchedRule: null,
              usedFallback: true,
              actions: [{ name: 'emit-bad', kind: 'event', status: 'succeeded' }],
            }),
            runView({
              runId: 'run-0000000a',
              status: 'succeeded',
              matchedRule: null,
              usedFallback: false,
              actions: [],
            }),
          ],
          availableActions: [],
        },
      })
    }
    const view = await mountPanel(call)
    await view.clickRow('log rotate')
    const modalText = view.modal().textContent
    // 判定段
    expect(modalText).toContain('判定')
    expect(modalText).toContain('命中规则 0')
    expect(modalText).toContain('fallback')
    expect(modalText).toContain('未命中（零动作）')
    // 动作段：名称、类型、状态、错误码、warnings
    expect(modalText).toContain('emit-ok')
    expect(modalText).toContain('page')
    expect(modalText).toContain('open-triage')
    expect(modalText).toContain('事件')
    expect(modalText).toContain('注册动作')
    expect(modalText).toContain('会话')
    expect(modalText).toContain('unknown variable: {{nope}}')
    expect(modalText).toContain('unknown_action')
    expect(modalText).toContain('已跳过')
    view.unmount()
  })

  it('票 31 注册动作展示：plugin 动作成功 + report() 警告、timeout 错误码、可用注册动作（name + description）', async () => {
    const call = (endpoint) => {
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve({
        ok: true,
        value: {
          ...ORCH,
          runs: [
            runView({
              status: 'partial',
              matchedRule: 0,
              usedFallback: false,
              actions: [
                { name: 'page', kind: 'plugin', status: 'succeeded', warnings: ['已呼叫值班'] },
                { name: 'slow-page', kind: 'plugin', status: 'failed', error: { code: 'timeout', message: "plugin 动作 'slow-page'（ops.slow）超过 2 秒未完成" } },
              ],
            }),
          ],
          availableActions: [
            { name: 'alpha.ping' },
            { name: 'ops.oncall', description: '按 severity 呼叫值班' },
          ],
        },
      })
    }
    const view = await mountPanel(call)
    await view.clickRow('log rotate')
    const modalText = view.modal().textContent
    // 动作段：plugin 成功与失败（timeout 错误码）、report() 警告
    expect(modalText).toContain('page')
    expect(modalText).toContain('slow-page')
    expect(modalText).toContain('timeout')
    expect(modalText).toContain('已呼叫值班')
    // 可用注册动作段：name 与 description
    expect(modalText).toContain('可用注册动作')
    expect(modalText).toContain('ops.oncall')
    expect(modalText).toContain('按 severity 呼叫值班')
    expect(modalText).toContain('alpha.ping')
    view.unmount()
  })

  it('票 32 会话引用：session 动作展示 sessionId 与「可接管」提示；delivery_failed 的 sessionId 同样展示（排障入口）', async () => {
    const call = (endpoint) => {
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve({
        ok: true,
        value: {
          ...ORCH,
          runs: [
            runView({
              actions: [{ name: 'open-triage', kind: 'session', status: 'succeeded', sessionId: 'session-05ddf0dc-0794-4eac-bdb7-3148cfda1cee' }],
            }),
            runView({
              runId: 'run-0000000b',
              status: 'partial',
              matchedRule: 0,
              actions: [
                { name: 'open-triage', kind: 'session', status: 'failed', sessionId: 'session-8c574c72-8422-4e02-ad00-55e4bbcf2a3b', error: { code: 'delivery_failed', message: '会话已创建（session-8c574c72-8422-4e02-ad00-55e4bbcf2a3b）但 flush 拒绝' } },
              ],
            }),
          ],
          availableActions: [],
        },
      })
    }
    const view = await mountPanel(call)
    await view.clickRow('log rotate')
    const modalText = view.modal().textContent
    expect(modalText).toContain('session-05ddf0dc-0794-4eac-bdb7-3148cfda1cee')
    expect(modalText).toContain('可接管')
    expect(modalText).toContain('session-8c574c72-8422-4e02-ad00-55e4bbcf2a3b')
    expect(modalText).toContain('delivery_failed')
    view.unmount()
  })

  it('活动 run 轮询：模态打开且有非终态 run → 每 5 秒 view(id)；全部终态后停止', async () => {
    vi.useFakeTimers()
    try {
      const calls = []
      let phase = 'running'
      const call = (endpoint, payload) => {
        calls.push([endpoint, payload, phase])
        if (endpoint === 'list') return Promise.resolve(listResult())
        const status = phase === 'running' ? 'running' : 'succeeded'
        return Promise.resolve({
          ok: true,
          value: {
            ...ORCH,
            runs: [
              runView({ status, startedAt: status === 'running' ? '2026-11-09T00:05:00.100Z' : '2026-11-09T00:05:00.100Z', settledAt: status === 'running' ? null : '2026-11-09T00:05:09.000Z' }),
            ],
            availableActions: [],
          },
        })
      }
      const view = await mountPanel(call)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await view.clickRow('log rotate')
      expect(calls.filter(([e]) => e === 'view')).toHaveLength(1)
      // 5 秒后轮询一次（活动 run 存在）
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(calls.filter(([e]) => e === 'view')).toHaveLength(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(calls.filter(([e]) => e === 'view')).toHaveLength(3)
      // run 结算为终态 → 本轮完成后停止
      phase = 'settled'
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(calls.filter(([e]) => e === 'view')).toHaveLength(4)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000)
      })
      expect(calls.filter(([e]) => e === 'view')).toHaveLength(4) // 停止轮询
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('停止条件：面板不可见不轮询；模态关闭后停止', async () => {
    vi.useFakeTimers()
    try {
      const calls = []
      const call = (endpoint) => {
        calls.push(endpoint)
        if (endpoint === 'list') return Promise.resolve(listResult())
        return Promise.resolve({
          ok: true,
          value: { ...ORCH, runs: [runView({ status: 'running', settledAt: null })], availableActions: [] },
        })
      }
      const view = await mountPanel(call)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await view.clickRow('log rotate')
      expect(calls.filter((e) => e === 'view')).toHaveLength(1)
      // 面板隐藏 → 不轮询
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      await act(async () => {
        document.dispatchEvent(new window.Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(12000)
      })
      expect(calls.filter((e) => e === 'view')).toHaveLength(1)
      // 回到可见 → 恢复轮询
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      await act(async () => {
        document.dispatchEvent(new window.Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(calls.filter((e) => e === 'view')).toHaveLength(2)
      // 关闭模态 → 停止（先 flush 卸载，再推进时间）
      await act(async () => {
        const close = [...view.modal().querySelectorAll('button')].find((b) => b.textContent === '关闭')
        close.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000)
      })
      expect(calls.filter((e) => e === 'view')).toHaveLength(2)
      view.unmount()
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      vi.useRealTimers()
    }
  })
})

describe('行内管理操作（契约 11「面板自身承载管理与排障：行内操作」；票 28）', () => {
  const pausedOrch = { ...ORCH, id: 'paused-o', title: 'paused orchestration', status: 'paused', nextOccurrence: null }
  const endedOrch = { ...ORCH, id: 'ended-o', title: 'ended orchestration', status: 'ended', nextOccurrence: null }

  function actionsCall(calls, listItems = [ORCH]) {
    return async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'list') {
        return { ok: true, value: { items: listItems, total: listItems.length, nextOffset: null } }
      }
      if (endpoint === 'edit') return { ok: true, value: { ...ORCH } }
      if (endpoint === 'run') return { ok: true, value: { runId: 'run-abcd1234', status: 'queued' } }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
  }

  it('按状态渲染行内操作：active → 暂停+执行+删除；paused → 恢复+执行+删除；ended → 执行+删除（删除全状态，票 29）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const items = [ORCH, pausedOrch, endedOrch]
    const view = await renderPanel({ call: actionsCall([], items), subscribeReset: () => () => {} })
    await view.clickInRow('log rotate', '暂停')
    const activeRow = [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes('log rotate'))
    expect([...activeRow.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['暂停', '执行', '删除'])
    const pausedRow = [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes('paused orchestration'))
    expect([...pausedRow.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['恢复', '执行', '删除'])
    const endedRow = [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes('ended orchestration'))
    expect([...endedRow.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['执行', '删除'])
    view.unmount()
  })

  it('点击暂停 → call edit {id, action} → 立即回读 list（写后权威回读）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    const view = await renderPanel({ call: actionsCall(calls), subscribeReset: () => () => {} })
    await view.clickInRow('log rotate', '暂停')
    expect(calls).toEqual([
      ['list', {}],
      ['edit', { id: 'log-rotate', action: 'pause' }],
      ['list', {}],
    ])
    expect(view.modal()).toBeFalsy() // 行内操作不打开模态
    view.unmount()
  })

  it('点击恢复 → edit resume；点击执行 → run {id}（受理即返回）→ 回读', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    const view = await renderPanel({ call: actionsCall(calls, [pausedOrch]), subscribeReset: () => () => {} })
    await view.clickInRow('paused orchestration', '恢复')
    expect(calls[1]).toEqual(['edit', { id: 'paused-o', action: 'resume' }])
    await view.clickInRow('paused orchestration', '执行')
    expect(calls[3]).toEqual(['run', { id: 'paused-o' }])
    expect(calls[4]).toEqual(['list', {}])
    view.unmount()
  })

  it('操作失败显示契约错误（如 script_conflict），可继续重试其他操作', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'edit') {
        return { ok: false, error: { code: 'script_conflict', message: '已被其他修改', details: { expected: 'a', actual: 'b' } } }
      }
      return { ok: true, value: { items: [ORCH], total: 1, nextOffset: null } }
    }
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    await view.clickInRow('log rotate', '暂停')
    expect(view.text()).toContain('script_conflict')
    expect(view.text()).toContain('已被其他修改')
    view.unmount()
  })
})

describe('删除编排 · 二次确认与级联提示（契约 11「行内操作 + 删除二次确认」；票 29）', () => {
  function deleteCall(calls, { editResult } = {}) {
    return async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'list') return { ok: true, value: { items: [ORCH], total: 1, nextOffset: null } }
      if (endpoint === 'edit') {
        return editResult ?? { ok: true, value: { id: payload.id, removedRuns: 0 } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
  }

  it('每行都有「删除」按钮（全状态）；点击后居中确认模态：标题、级联取消与不可恢复提示，未发任何 edit', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    const view = await renderPanel({ call: deleteCall(calls), subscribeReset: () => () => {} })
    await view.clickInRow('log rotate', '删除')
    const modal = view.modal()
    expect(modal).toBeTruthy()
    const text = modal.textContent
    expect(text).toContain('删除编排')
    expect(text).toContain('log rotate')
    expect(text).toContain('取消在途 run')
    expect(text).toContain('不可恢复')
    expect(calls).toEqual([['list', {}]]) // 确认前不发 edit
    view.unmount()
  })

  it('确认删除 → call edit {id, action:"delete"} → 成功后关闭确认并回读列表（写后权威回读）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    const view = await renderPanel({ call: deleteCall(calls), subscribeReset: () => () => {} })
    await view.clickInRow('log rotate', '删除')
    await act(async () => {
      const confirm = [...view.modal().querySelectorAll('button')].find((b) => b.textContent === '确认删除')
      confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(calls).toEqual([
      ['list', {}],
      ['edit', { id: 'log-rotate', action: 'delete' }],
      ['list', {}],
    ])
    expect(view.modal()).toBeFalsy() // 确认模态已关闭
    view.unmount()
  })

  it('取消确认 → 不发 edit、模态关闭', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    const view = await renderPanel({ call: deleteCall(calls), subscribeReset: () => () => {} })
    await view.clickInRow('log rotate', '删除')
    await act(async () => {
      const cancel = [...view.modal().querySelectorAll('button')].find((b) => b.textContent === '取消')
      cancel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(calls).toEqual([['list', {}]])
    expect(view.modal()).toBeFalsy()
    view.unmount()
  })

  it('删除期间状态清晰：确认按钮禁用并显示「删除中…」；失败显示契约错误条（可重试）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    let resolveEdit
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'list') return { ok: true, value: { items: [ORCH], total: 1, nextOffset: null } }
      if (endpoint === 'edit') {
        return new Promise((resolve) => { resolveEdit = resolve })
      }
      throw new Error('unexpected')
    }
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    await view.clickInRow('log rotate', '删除')
    await act(async () => {
      const confirm = [...view.modal().querySelectorAll('button')].find((b) => b.textContent === '确认删除')
      confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    // 删除进行中：模态仍在、按钮显示删除中且禁用（UI abort 不取消已受理删除——无取消按钮）
    const modalText = view.modal().textContent
    expect(modalText).toContain('删除中')
    const inFlightButtons = [...view.modal().querySelectorAll('button')]
    expect(inFlightButtons.every((b) => b.disabled || b.textContent.includes('删除中'))).toBe(true)
    await act(async () => {
      resolveEdit({ ok: false, error: { code: 'script_conflict', message: '已被其他修改' } })
    })
    expect(view.modal()).toBeFalsy() // 确认模态关闭
    expect(view.text()).toContain('script_conflict') // 错误条呈现
    view.unmount()
  })

  it('删除成功后若详情模态正开着该编排则一并关闭（记录已不存在）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'list') return { ok: true, value: { items: [ORCH], total: 1, nextOffset: null } }
      if (endpoint === 'view') return { ok: true, value: { ...ORCH, runs: [], availableActions: [] } }
      if (endpoint === 'edit') return { ok: true, value: { id: payload.id, removedRuns: 2 } }
      throw new Error('unexpected')
    }
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    await view.clickRow('log rotate')
    expect(view.modal()).toBeTruthy() // 详情模态开着
    await view.clickInRow('log rotate', '删除')
    await act(async () => {
      const confirm = [...view.modal().querySelectorAll('button')].find((b) => b.textContent === '确认删除')
      confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(view.modal()).toBeFalsy() // 确认与详情一并关闭
    view.unmount()
  })
})

describe('完整溢写输出读取（票 34：spill 端点；文件不存在排障态）', () => {
  const spillRunView = (over = {}) => ({
    runId: 'run-spill',
    orchestrationId: 'log-rotate',
    trigger: 'every',
    scheduledAt: '2026-11-09T00:05:00.000Z',
    startedAt: '2026-11-09T00:05:00.100Z',
    settledAt: '2026-11-09T00:05:02.300Z',
    status: 'succeeded',
    skipReason: null,
    script: {
      command: 'pwsh',
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 2200,
      stdoutTail: 'tail',
      stderrTail: '',
      truncated: true,
      stdoutSpillPath: 'C:/tmp/dsh-subprocess-x/out.log',
      stderrSpillPath: 'C:/tmp/dsh-subprocess-x/err.log',
    },
    matchedRule: 0,
    usedFallback: false,
    actions: [],
    ...over,
  })

  const makeCall = (spillResponse) => {
    const calls = []
    const call = (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'list') return Promise.resolve({ ok: true, value: { items: [ORCH], total: 1, nextOffset: null } })
      if (endpoint === 'view') return Promise.resolve({ ok: true, value: { ...ORCH, availableActions: [], runs: [spillRunView()] } })
      if (endpoint === 'spill') return Promise.resolve(spillResponse)
      return Promise.resolve({ ok: true, value: {} })
    }
    return { call, calls }
  }

  it('有溢写路径的 run 显示「stdout 全量」：点击 → call spill → 模态展示全文与字节数', async () => {
    const { call, calls } = makeCall({
      ok: true,
      value: { runId: 'run-spill', stream: 'stdout', path: 'C:/tmp/dsh-subprocess-x/out.log', content: 'line-0000\nline-0199\n', bytes: 20 },
    })
    const view = await renderPanel({ call })
    await view.clickRow('log rotate')
    expect(view.text()).toContain('stdout 全量')
    expect(view.text()).toContain('stderr 全量')
    await view.click('stdout 全量')
    expect(calls).toContainEqual(['spill', { runId: 'run-spill', stream: 'stdout' }])
    expect(view.text()).toContain('完整输出 · stdout')
    expect(view.text()).toContain('line-0000')
    expect(view.text()).toContain('line-0199')
    expect(view.text()).toContain('20 字节')
    view.unmount()
  })

  it('文件已不存在：spill 返回 script_storage_unavailable → 模态显示排障态（code + message），可关闭', async () => {
    const { call } = makeCall({
      ok: false,
      error: { code: 'script_storage_unavailable', message: '溢写文件已不存在或不可读（ENOENT）', details: { cause: 'ENOENT' } },
    })
    const view = await renderPanel({ call })
    await view.clickRow('log rotate')
    await view.click('stderr 全量')
    expect(view.text()).toContain('无法读取完整输出')
    expect(view.text()).toContain('script_storage_unavailable')
    expect(view.text()).toContain('溢写文件已不存在或不可读（ENOENT）')
    await view.click('关闭')
    expect(view.text()).not.toContain('无法读取完整输出')
    view.unmount()
  })

  it('无溢写路径的 run（未超上限/撤回）不显示全量按钮', async () => {
    const { call } = makeCall({ ok: true, value: {} })
    const callWithoutSpill = (endpoint, payload) => {
      if (endpoint === 'view') {
        return Promise.resolve({
          ok: true,
          value: {
            ...ORCH,
            availableActions: [],
            runs: [spillRunView({ script: { command: 'pwsh', exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutTail: 'ok', stderrTail: '', truncated: false } })],
          },
        })
      }
      return call(endpoint, payload)
    }
    const view = await renderPanel({ call: callWithoutSpill })
    await view.clickRow('log rotate')
    expect(view.text()).not.toContain('stdout 全量')
    view.unmount()
  })
})
