// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
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
      let button = [...row.querySelectorAll('button')].find((b) => b.textContent === label)
      if (!button) {
        if (row.getAttribute('data-selected') !== 'true') {
          await act(async () => row.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
        }
        const detail = container.querySelector('aside[aria-label="编排详情"]')
        button = [...(detail?.querySelectorAll('button') || [])].find((b) => b.textContent === label)
      }
      expect(button, `button '${label}' for orchestration '${needle}'`).toBeTruthy()
      await act(async () => {
        button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
    },
    modal: () => container.querySelector('div[style*="position: fixed"]') || container.querySelector('aside[aria-label="编排详情"]'),
    detail: () => container.querySelector('aside[aria-label="编排详情"]'),
    workspace: () => container.querySelector('.so-workspace'),
    row: (needle) => [...container.querySelectorAll('tbody tr')].find((tr) => tr.textContent.includes(needle)),
    closeDetail: async () => {
      const close = container.querySelector('aside[aria-label="编排详情"] button[aria-label="关闭详情"]')
      expect(close, 'button 关闭详情').toBeTruthy()
      await act(async () => close.click())
    },
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

function viewResult(orchestration = ORCH) {
  return { ok: true, value: { ...orchestration, runs: [], availableActions: [] } }
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
    expect(options.prompt).toBe('/script-orchestrator\n创建脚本编排：\n请在此描述需求：')
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
    expect(options.prompt).toBe('/script-orchestrator\n修改脚本编排 log-rotate：\n请在此描述需求：')
  })

  it('openSession 绑定：经 ctx.uiWorkspace.openSession 跳转（纯导航，透传 sessionId）', async () => {
    const { exports } = await loadClientBundle()
    const opened = []
    const { registrations } = mountRegistrations(exports, {
      uiWorkspace: {
        openSession: (...args) => {
          opened.push(args)
        },
      },
    })
    const props = panelEntry(registrations).definition.inject()
    expect(typeof props.openSession).toBe('function')
    props.openSession('session-xyz')
    expect(opened).toHaveLength(1)
    expect(opened[0]).toEqual(['session-xyz'])
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

  it('点击行 → 右侧详情经 view 回读：触发配置、状态与下次时刻、空执行记录、空注册动作；关闭恢复完整列表', async () => {
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
    expect(calls[1]).toEqual(['view', { id: 'log-rotate', runs: 50 }])
    const modal = view.detail()
    expect(modal).toBeTruthy()
    expect(modal.getAttribute('role')).not.toBe('dialog')
    expect(modal.getAttribute('aria-modal')).not.toBe('true')
    expect(view.workspace().classList.contains('so-workspace-split')).toBe(true)
    expect(view.row('log rotate')).toBeTruthy()
    expect(view.row('log rotate').getAttribute('data-selected')).toBe('true')
    const modalText = modal.textContent
    expect(modalText).toContain('触发配置')
    expect(modalText).toContain('every 5 分钟')
    expect(modalText).toContain('完成后再等')
    expect(modalText).toContain('状态与下次触发')
    expect(modalText).toContain('2026-11-09 00:05')
    expect(modalText).toContain('执行记录（0）')
    expect(modalText).toContain('还没有执行记录（创建不会立即执行脚本）')
    expect(modalText).toContain('暂无注册动作')
    await view.closeDetail()
    expect(view.detail()).toBeFalsy()
    expect(view.workspace().classList.contains('so-workspace-split')).toBe(false)
    expect(view.row('log rotate').getAttribute('data-selected')).not.toBe('true')
    view.unmount()
  })

  it('双编排直接切换：列表保持可操作，选中态与标题按钮 aria-expanded 跟随详情', async () => {
    const { exports } = await loadClientBundle()
    panelComponent = panelEntry(mountRegistrations(exports).registrations).component
    const second = { ...ORCH, id: 'nightly-check', title: '夜间巡检', script: { command: 'node' } }
    const calls = []
    const call = (endpoint, payload) => {
      calls.push([endpoint, payload])
      return Promise.resolve(endpoint === 'list' ? listResult([ORCH, second]) : viewResult(payload.id === ORCH.id ? ORCH : second))
    }
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    try {
      expect(view.detail()).toBeFalsy()
      const titleButton = (title) => [...view.row(title).querySelectorAll('button')].find((button) => button.textContent === title)
      const firstButton = titleButton(ORCH.title)
      expect(firstButton).toBeTruthy()
      expect(firstButton.getAttribute('aria-expanded')).toBe('false')
      firstButton.focus()
      expect(document.activeElement).toBe(firstButton)
      // jsdom 不模拟 Enter/Space 的浏览器默认 click；验证原生键盘按钮的激活路径。
      expect(firstButton.tagName).toBe('BUTTON')
      expect(firstButton.disabled).toBe(false)
      await act(async () => firstButton.click())
      expect(firstButton.getAttribute('aria-expanded')).toBe('true')
      expect(view.detail().textContent).toContain(ORCH.id)
      await view.clickInRow(second.title, second.title)
      expect(view.detail().textContent).toContain(second.title)
      expect(view.detail().textContent).toContain(second.id)
      expect(view.detail().textContent).not.toContain(ORCH.id)
      expect(view.row(ORCH.title).getAttribute('data-selected')).not.toBe('true')
      expect(view.row(second.title).getAttribute('data-selected')).toBe('true')
      expect(titleButton(ORCH.title).getAttribute('aria-expanded')).toBe('false')
      expect(titleButton(second.title).getAttribute('aria-expanded')).toBe('true')
      expect(calls.filter(([endpoint]) => endpoint === 'view')).toEqual([
        ['view', { id: ORCH.id, runs: 50 }], ['view', { id: second.id, runs: 50 }],
      ])
      const selectedTitle = titleButton(second.title)
      const closeButton = view.detail().querySelector('button[aria-label="关闭详情"]')
      closeButton.focus()
      expect(document.activeElement).toBe(closeButton)
      await view.closeDetail()
      expect(document.activeElement).toBe(selectedTitle)
      expect(titleButton(second.title).getAttribute('aria-expanded')).toBe('false')
    } finally {
      view.unmount()
    }
  })

  it('顶部刷新同步回读左右两列，保留选中编排并显示最新权威详情', async () => {
    const { exports } = await loadClientBundle()
    panelComponent = panelEntry(mountRegistrations(exports).registrations).component
    const calls = []
    let current = ORCH
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'list') return listResult([current])
      if (endpoint === 'view') return viewResult(current)
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    try {
      await view.clickRow(ORCH.title)
      current = { ...ORCH, title: '刷新后的权威编排', trigger: { kind: 'every', everySeconds: 600, mode: 'fixed-delay' } }
      const before = calls.length
      await view.click('刷新')
      const reads = calls.slice(before)
      expect(reads.filter(([endpoint]) => endpoint === 'list')).toEqual([['list', {}]])
      expect(reads.filter(([endpoint]) => endpoint === 'view')).toEqual([['view', { id: ORCH.id, runs: 50 }]])
      expect(view.row(current.title).textContent).toContain('every 10 分钟')
      expect(view.row(current.title).getAttribute('data-selected')).toBe('true')
      expect(view.detail().textContent).toContain(current.title)
      expect(view.detail().textContent).toContain('every 10 分钟')
      expect(view.workspace().classList.contains('so-workspace-split')).toBe(true)
    } finally {
      view.unmount()
    }
  })

  it.each(['loading', 'failed'])('详情 %s 时仍可关闭，不遮挡列表且晚到结果不重新打开详情', async (phase) => {
    const { exports } = await loadClientBundle()
    panelComponent = panelEntry(mountRegistrations(exports).registrations).component
    let resolveDetail
    const pending = new Promise((resolve) => { resolveDetail = resolve })
    const call = (endpoint) => endpoint === 'list' ? Promise.resolve(listResult()) : pending
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    try {
      await view.clickRow(ORCH.title)
      expect(view.detail()).toBeTruthy()
      expect(view.detail().textContent).toContain('加载详情')
      if (phase === 'failed') {
        await act(async () => resolveDetail({ ok: false, error: { code: 'offline', message: '详情暂不可用' } }))
        expect(view.detail().textContent).toContain('详情暂不可用')
      }
      expect(view.row(ORCH.title)).toBeTruthy()
      await view.closeDetail()
      expect(view.detail()).toBeFalsy()
      expect(view.workspace().classList.contains('so-workspace-split')).toBe(false)
      await act(async () => resolveDetail(viewResult()))
      expect(view.detail()).toBeFalsy()
    } finally {
      view.unmount()
    }
  })

  it('旧编排详情请求晚到不覆盖当前编排，切换加载时不保留旧详情内容', async () => {
    const { exports } = await loadClientBundle()
    panelComponent = panelEntry(mountRegistrations(exports).registrations).component
    const second = { ...ORCH, id: 'second', title: 'second orchestration', script: { command: 'node' } }
    const resolves = new Map()
    const call = (endpoint, payload) => endpoint === 'list'
      ? Promise.resolve(listResult([ORCH, second]))
      : new Promise((resolve) => resolves.set(payload.id, resolve))
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    try {
      await view.clickRow(ORCH.title)
      await view.clickRow(second.title)
      expect(view.detail().textContent).toContain('加载详情')
      await act(async () => resolves.get(second.id)(viewResult(second)))
      expect(view.detail().textContent).toContain(second.title)
      expect(view.detail().textContent).toContain(second.id)
      await act(async () => resolves.get(ORCH.id)(viewResult()))
      expect(view.detail().textContent).toContain(second.title)
      expect(view.detail().textContent).not.toContain(ORCH.id)
      expect(view.row(second.title).getAttribute('data-selected')).toBe('true')
      await view.clickRow(ORCH.title)
      expect(view.detail().textContent).toContain('加载详情')
      expect(view.detail().textContent).not.toContain(second.id)
      await act(async () => resolves.get(ORCH.id)(viewResult()))
      expect(view.detail().textContent).toContain(ORCH.id)
    } finally {
      view.unmount()
    }
  })

  it('详情面板「在新会话修改」按钮：点击 → startEditSession（id），不关闭详情、不额外回读（既有按钮与轮询不受影响）', async () => {
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
    const edit = [...modal.querySelectorAll('button')].find((b) => b.textContent === '在新会话修改')
    expect(edit, "button '编辑'").toBeTruthy()
    expect([...modal.querySelectorAll('button')].some((b) => b.textContent === '关闭')).toBe(true)
    const viewCallsBefore = calls.filter(([endpoint]) => endpoint === 'view').length
    await act(async () => {
      edit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(started).toEqual([['log-rotate', undefined]])
    expect(view.modal()).toBeTruthy() // 编辑入口不改面板状态（不关闭详情）
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

  it('connection/reset 时已打开的详情面板重新回读 view（详情与列表同为权威回读）', async () => {
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

  it('cron 编排：列表与详情面板显示表达式、时区与下次时刻；每日预设回显语义摘要（契约 02「每日/每周面板预设」）', async () => {
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

describe('详情面板的脚本阶段结果与活动 run 轮询（契约 11「刷新策略」3：可见且有活动 run 时每 5 秒 view）', () => {
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
    // runId 缩写为尾 4 位（v0.1x），完整 id 在 title
    expect(modalText).toContain('…1a9e')
    expect(view.modal().querySelector('[title="run-7f3c1a9e"]')).toBeTruthy()
    expect(modalText).toContain('退出码 0')
    expect(modalText).toContain('耗时 2.2 秒')
    expect(modalText).toContain('deploy ok')
    expect(modalText).toContain('跳过（重叠）')
    expect(modalText).toContain('已超时')
    expect(modalText).toContain('已截断')
    expect(modalText).toContain('descendants-terminated')
    expect(modalText).toContain('partial output…')
    // stderr 尾部直展（v0.1x），不再只能进 spill 模态
    expect(modalText).toContain('stderr 尾部')
    expect(modalText).toContain('boom')
    view.unmount()
  })

  // v0.1x：执行记录默认折叠 3 条 + 展开/收起 + 服务上限标注 + 相对时间
  it('v0.1x 折叠：5 条 run 默认只渲染最近 3 条，「展开全部执行记录」→ 5 条，可收起', async () => {
    const call = (endpoint) => {
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve({
        ok: true,
        value: { ...ORCH, runs: [5, 4, 3, 2, 1].map((n) => runView({ runId: 'run-0000000' + n })), availableActions: [] },
      })
    }
    const view = await mountPanel(call)
    await view.clickRow('log rotate')
    // 每张 run 卡片恰有一个 title=完整 runId 的元素（v0.1x runId 缩写为尾 4 位）
    const cardCount = () => view.modal().querySelectorAll('[title^="run-"]').length
    expect(cardCount()).toBe(3)
    expect(view.text()).toContain('展开全部执行记录')
    await view.click('展开全部执行记录')
    expect(cardCount()).toBe(5)
    expect(view.text()).toContain('收起，仅显示最近 3 条')
    await view.click('收起，仅显示最近 3 条')
    expect(cardCount()).toBe(3)
    view.unmount()
  })

  it('v0.1x：取回数达服务上限 50 时如实标注；不超过 3 条时不出现展开按钮与标注', async () => {
    const many = Array.from({ length: 50 }, (_, i) => runView({ runId: 'run-' + String(i).padStart(8, '0') }))
    const call = (endpoint) => {
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve({ ok: true, value: { ...ORCH, runs: many, availableActions: [] } })
    }
    const view = await mountPanel(call)
    await view.clickRow('log rotate')
    expect(view.text()).toContain('执行记录（50）')
    expect(view.text()).toContain('已达服务上限：最多显示最近 50 条执行记录')
    view.unmount()

    const few = await mountPanel((endpoint) => {
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve({ ok: true, value: { ...ORCH, runs: [runView()], availableActions: [] } })
    })
    await few.clickRow('log rotate')
    expect(few.text()).not.toContain('展开全部执行记录')
    expect(few.text()).not.toContain('已达服务上限')
    few.unmount()
  })

  it('v0.1x 直观化：未结算标「开始于」+ 相对时间，未开始标「计划于」', async () => {
    const running = runView({
      runId: 'run-running01',
      status: 'running',
      scheduledAt: new Date(Date.now() - 65e3).toISOString(),
      startedAt: new Date(Date.now() - 60e3).toISOString(),
      settledAt: null,
    })
    const queued = runView({
      runId: 'run-queued001',
      status: 'queued',
      startedAt: null,
      settledAt: null,
      scheduledAt: new Date(Date.now() + 60e3).toISOString(),
    })
    const call = (endpoint) => {
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve({ ok: true, value: { ...ORCH, runs: [running, queued], availableActions: [] } })
    }
    const view = await mountPanel(call)
    await view.clickRow('log rotate')
    const modalText = view.modal().textContent
    expect(modalText).toContain('执行中')
    expect(modalText).toContain('排队中')
    expect(modalText).toContain('开始于 1 分钟前')
    expect(modalText).toContain('计划于')
    // 相对时间的绝对时刻在 title（排障可核对）；与 client.js fmtTime 同规则
    const absTitle = (iso) => iso.replace('T', ' ').replace(/(\.\d+|Z).*$/, '')
    expect(view.modal().querySelector(`[title="${absTitle(running.startedAt)}"]`)).toBeTruthy()
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
    // 判定段（matchedRule 零下标按 N+1 展示，与详情「规则 N」编号对齐）
    expect(modalText).toContain('判定')
    expect(modalText).toContain('命中规则 1')
    expect(modalText).toContain('命中兜底')
    expect(modalText).toContain('未命中（不执行动作）')
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

  // v0.1ab 会话引用可跳转：动作行派发会话与结果块 reports 上报会话都是链接按钮
  it('v0.1ab 会话引用跳转：动作行与 reports 的 sessionId 点击经 openSession 跳转；未提供 openSession 时降级纯文本', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const call = (endpoint) => {
      if (endpoint === 'list') return Promise.resolve(listResult())
      return Promise.resolve({
        ok: true,
        value: {
          ...ORCH,
          runs: [
            runView({
              actions: [{ name: 'open-triage', kind: 'session', status: 'succeeded', sessionId: 'session-05ddf0dc-0794-4eac-bdb7-3148cfda1cee' }],
              result: {
                summary: '归档完成',
                level: 'info',
                reports: [
                  { sessionId: 'session-9f21e1aa-1111-2222-3333-444455556666', at: '2026-11-09T00:05:03.000Z', summary: '已归档 3 个文件', fields: { files: '3' } },
                ],
              },
            }),
          ],
          availableActions: [],
        },
      })
    }
    const opened = []
    const view = await renderPanel({ call, subscribeReset: () => () => {}, openSession: (id) => opened.push(id) })
    await view.clickRow('log rotate')
    const linkButtons = [...view.modal().querySelectorAll('button')].filter((b) => (b.title || '').includes('跳转到该会话'))
    expect(linkButtons).toHaveLength(2)
    // 动作行：完整 id 在 title，正文含「（可接管）」
    const actionBtn = linkButtons.find((b) => b.title.startsWith('session-05ddf0dc'))
    expect(actionBtn).toBeTruthy()
    expect(actionBtn.textContent).toContain('session-05ddf0dc-0794-4eac-bdb7-3148cfda1cee')
    expect(actionBtn.textContent).toContain('（可接管）')
    await act(async () => {
      actionBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(opened).toEqual(['session-05ddf0dc-0794-4eac-bdb7-3148cfda1cee'])
    // reports：正文为尾 8 位缩写，点击同样收到完整 id
    const reportBtn = linkButtons.find((b) => b.title.startsWith('session-9f21e1aa'))
    expect(reportBtn.textContent).toContain('…55556666')
    await act(async () => {
      reportBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    expect(opened).toEqual(['session-05ddf0dc-0794-4eac-bdb7-3148cfda1cee', 'session-9f21e1aa-1111-2222-3333-444455556666'])
    view.unmount()

    // 降级：宿主未提供 openSession → 无跳转按钮，sessionId 以纯文本展示
    const plain = await renderPanel({ call, subscribeReset: () => () => {} })
    await plain.clickRow('log rotate')
    expect(plain.modal().querySelectorAll('button[title*="跳转到该会话"]').length).toBe(0)
    expect(plain.modal().textContent).toContain('session-05ddf0dc-0794-4eac-bdb7-3148cfda1cee')
    expect(plain.modal().textContent).toContain('…55556666')
    plain.unmount()
  })

  it('活动 run 轮询：详情打开且有非终态 run → 每 5 秒 view(id)；全部终态后停止', async () => {
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

  it('停止条件：面板不可见不轮询；详情关闭后停止', async () => {
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
      // 关闭详情 → 停止（先 flush 卸载，再推进时间）
      await view.closeDetail()
      expect(view.detail()).toBeFalsy()
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

describe('详情管理操作（契约 11「面板自身承载管理与排障：详情管理操作」；票 28）', () => {
  const pausedOrch = { ...ORCH, id: 'paused-o', title: 'paused orchestration', status: 'paused', nextOccurrence: null }
  const endedOrch = { ...ORCH, id: 'ended-o', title: 'ended orchestration', status: 'ended', nextOccurrence: null }

  function actionsCall(calls, listItems = [ORCH]) {
    return async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'list') {
        return { ok: true, value: { items: listItems, total: listItems.length, nextOffset: null } }
      }
      if (endpoint === 'view') return viewResult(listItems.find((item) => item.id === payload.id))
      if (endpoint === 'edit') return { ok: true, value: { ...ORCH } }
      if (endpoint === 'run') return { ok: true, value: { runId: 'run-abcd1234', status: 'queued' } }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
  }

  it('按状态渲染详情管理操作：active → 暂停+执行+删除；paused → 恢复+执行+删除；ended → 执行+删除（删除全状态，票 29）', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const items = [ORCH, pausedOrch, endedOrch]
    const view = await renderPanel({ call: actionsCall([], items), subscribeReset: () => () => {} })
    expect([...document.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['状态', '标题', '触发', '下次'])
    for (const item of items) {
      const row = view.row(item.title)
      expect(row.querySelectorAll('td')).toHaveLength(4)
      expect([...row.querySelectorAll('button')].map((button) => button.textContent)).toEqual([item.title])
      await view.clickRow(item.title)
      const labels = [...view.detail().querySelectorAll('button')].map((button) => button.textContent)
      expect(labels).toContain('执行')
      expect(labels).toContain('删除')
      expect(labels.includes('暂停')).toBe(item.status === 'active')
      expect(labels.includes('恢复')).toBe(item.status === 'paused')
    }
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
      ['view', { id: 'log-rotate', runs: 50 }],
      ['edit', { id: 'log-rotate', action: 'pause' }],
      ['list', {}],
      ['view', { id: 'log-rotate', runs: 50 }],
    ])
    expect(view.detail()).toBeTruthy() // 操作在详情中执行，完成后保持详情
    expect(document.querySelector('div[style*="position: fixed"]')).toBeFalsy()
    view.unmount()
  })

  it('点击恢复 → edit resume；点击执行 → run {id}（受理即返回）→ 回读', async () => {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const calls = []
    const view = await renderPanel({ call: actionsCall(calls, [pausedOrch]), subscribeReset: () => () => {} })
    await view.clickInRow('paused orchestration', '恢复')
    expect(calls.filter(([endpoint]) => endpoint === 'edit')).toEqual([['edit', { id: 'paused-o', action: 'resume' }]])
    await view.clickInRow('paused orchestration', '执行')
    expect(calls.filter(([endpoint]) => endpoint === 'run')).toEqual([['run', { id: 'paused-o' }]])
    expect(calls.filter(([endpoint]) => endpoint === 'list')).toHaveLength(3)
    expect(calls.filter(([endpoint]) => endpoint === 'view')).toHaveLength(3)
    view.unmount()
  })

  it.each(['暂停', '执行'])('详情打开后详情管理%s成功立即回读 list/view，保持选中且展示权威详情', async (label) => {
    const { exports } = await loadClientBundle()
    panelComponent = panelEntry(mountRegistrations(exports).registrations).component
    const calls = []
    let current = ORCH
    const call = async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'list') return listResult([current])
      if (endpoint === 'view') return viewResult(current)
      if (endpoint === 'edit') {
        current = { ...ORCH, title: '暂停后权威标题', status: 'paused', nextOccurrence: null }
        return { ok: true, value: current }
      }
      if (endpoint === 'run') {
        current = { ...ORCH, title: '执行后权威标题' }
        return { ok: true, value: { runId: 'run-abcd1234', status: 'queued' } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    try {
      await view.clickRow(ORCH.title)
      const before = calls.length
      await view.clickInRow(ORCH.title, label)
      const writes = calls.slice(before)
      expect(writes[0]).toEqual(label === '暂停'
        ? ['edit', { id: ORCH.id, action: 'pause' }]
        : ['run', { id: ORCH.id }])
      expect(writes.filter(([endpoint]) => endpoint === 'list')).toEqual([['list', {}]])
      expect(writes.filter(([endpoint]) => endpoint === 'view')).toEqual([['view', { id: ORCH.id, runs: 50 }]])
      expect(view.detail().textContent).toContain(current.title)
      expect(view.workspace().classList.contains('so-workspace-split')).toBe(true)
      expect(view.row(current.title).getAttribute('data-selected')).toBe('true')
    } finally {
      view.unmount()
    }
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
      if (endpoint === 'view') return viewResult()
      return { ok: true, value: { items: [ORCH], total: 1, nextOffset: null } }
    }
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    await view.clickInRow('log rotate', '暂停')
    const alert = view.detail().querySelector('[role="alert"]')
    expect(alert).toBeTruthy()
    expect(alert.textContent).toContain('script_conflict')
    expect(alert.textContent).toContain('已被其他修改')
    const dismiss = [...alert.querySelectorAll('button')].find((button) => button.textContent === '关闭提示')
    expect(dismiss).toBeTruthy()
    await act(async () => dismiss.click())
    expect(view.detail().querySelector('[role="alert"]')).toBeFalsy()
    expect(view.detail()).toBeTruthy()
    view.unmount()
  })
})

describe('删除编排 · 二次确认与级联提示（契约 11「详情管理操作 + 删除二次确认」；票 29）', () => {
  function deleteCall(calls, { editResult } = {}) {
    return async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'list') return { ok: true, value: { items: [ORCH], total: 1, nextOffset: null } }
      if (endpoint === 'view') return viewResult()
      if (endpoint === 'edit') {
        return editResult ?? { ok: true, value: { id: payload.id, removedRuns: 0 } }
      }
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
  }

  it('详情提供「删除」按钮（全状态）；点击后居中确认模态：标题、级联取消与不可恢复提示，未发任何 edit', async () => {
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
    expect(calls).toEqual([['list', {}], ['view', { id: ORCH.id, runs: 50 }]]) // 确认前只读，不发 edit
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
      ['view', { id: 'log-rotate', runs: 50 }],
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
    expect(calls).toEqual([['list', {}], ['view', { id: ORCH.id, runs: 50 }]])
    expect(document.querySelector('div[style*="position: fixed"]')).toBeFalsy()
    expect(view.detail()).toBeTruthy()
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
      if (endpoint === 'view') return viewResult()
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
    expect(document.querySelector('div[style*="position: fixed"]')).toBeFalsy() // 确认关闭，详情保留
    expect(view.detail()).toBeTruthy()
    expect(view.detail().querySelector('[role="alert"]').textContent).toContain('script_conflict') // 详情就近呈现错误
    view.unmount()
  })

  it('删除成功后若详情面板正开着该编排则一并关闭（记录已不存在）', async () => {
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
    expect(view.modal()).toBeTruthy() // 详情面板开着
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
    await act(async () => {
      const close = [...view.modal().querySelectorAll('button')].find((button) => button.textContent === '关闭')
      close.click()
    })
    expect(view.text()).not.toContain('无法读取完整输出')
    expect(view.detail()).toBeTruthy()
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


describe('手动编辑', () => {
  let cleanup
  afterEach(() => { cleanup?.(); cleanup = null; vi.restoreAllMocks() })
  async function setup(result = { ok: true, value: {} }, orchestration = ORCH, override = null) {
    const { exports } = await loadClientBundle()
    panelComponent = panelEntry(mountRegistrations(exports).registrations).component
    const calls = []
    const call = vi.fn((endpoint, payload) => {
      calls.push([endpoint, payload])
      if (override) { const response = override(endpoint, payload, calls); if (response !== undefined) return response }
      if (endpoint === 'list') return Promise.resolve(listResult([orchestration]))
      if (endpoint === 'view') return Promise.resolve({ ok: true, value: { ...orchestration, runs: [], availableActions: [] } })
      if (endpoint === 'edit') return Promise.resolve(result)
      throw Error(endpoint)
    })
    const view = await renderPanel({ call, subscribeReset: () => () => {} })
    const unmount = view.unmount
    cleanup = () => { if (cleanup) { cleanup = null; unmount() } }
    view.unmount = () => cleanup?.()
    await view.clickRow(orchestration.title)
    ;[...document.querySelectorAll('button')].find(b => b.textContent === '手动修改').focus()
    await view.click('手动修改')
    const dialog = document.querySelector('[role="dialog"]')
    const field = (label) => [...dialog.querySelectorAll('label')].find(x => x.textContent.startsWith(label)).querySelector('input,select,textarea')
    const set = async (label, value) => {
      const el = field(label)
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
      await act(async () => el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })))
    }
    return { view, dialog, field, set, calls }
  }
  it('只提交改动与版本，保存后回读且不执行', async () => {
    const x = await setup()
    await x.set('标题', '新标题')
    await x.view.click('检查变更')
    expect(x.dialog.textContent).toContain('title')
    expect(x.dialog.textContent).toContain('影响后续自动执行')
    await x.view.click('确认保存')
    expect(x.calls.filter(c => c[0] === 'edit')).toEqual([['edit', { id:'log-rotate', action:'update', patch:{title:'新标题'}, expectedUpdatedAt:ORCH.updatedAt }]])
    expect(x.calls.filter(c => c[0] === 'view')).toHaveLength(2)
    expect(x.calls.filter(c => c[0] === 'list')).toHaveLength(2)
    expect(x.calls.some(c => c[0] === 'run')).toBe(false)
    x.view.unmount()
  })
  it('修改脚本保留 env 和 stdin；冲突保留草稿', async () => {
    const original = { ...ORCH, script: { command:'pwsh', env:{ SECRET:'value' }, stdin:{text:'hello'} } }
    const x = await setup({ok:false,error:{code:'script_conflict',message:'冲突'}}, original)
    await x.set('命令', 'node')
    await x.view.click('检查变更')
    expect(x.dialog.querySelector('[role=status]').textContent).not.toContain('value')
    x.dialog.querySelector('button:last-child').focus()
    await x.view.click('确认保存')
    expect(x.dialog.contains(document.activeElement)).toBe(true)
    expect(x.calls.find(c => c[0] === 'edit')[1].patch).toEqual({ script: { command:'node', env:{SECRET:'value'}, stdin:{text:'hello'} } })
    expect(x.dialog.textContent).toContain('script_conflict')
    expect(x.field('命令').value).toBe('node')
    expect(x.calls.filter(c => c[0] === 'edit')).toHaveLength(1)
    x.view.unmount()
  })
  it('传输异常保留草稿，回读前不得再次写入', async () => {
    const x = await setup(undefined, ORCH, endpoint => endpoint === 'edit' ? Promise.reject(new Error('断线')) : undefined)
    await x.set('标题', '未保存草稿')
    await x.view.click('检查变更')
    await x.view.click('确认保存')
    expect(x.dialog.textContent).toContain('保存结果未知')
    expect(x.field('标题').value).toBe('未保存草稿')
    await x.view.click('检查变更')
    expect(x.dialog.textContent).toContain('请先加载新版本')
    expect(x.calls.filter(c => c[0] === 'edit')).toHaveLength(1)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await x.view.click('加载新版本')
    expect(x.field('标题').value).toBe(ORCH.title)
    await x.set('标题', '重新确认')
    await x.view.click('检查变更')
    expect(x.dialog.textContent).toContain('变更摘要')
    await x.view.click('确认保存')
    expect(x.calls.filter(c => c[0] === 'edit')).toHaveLength(2)
  })
  it('暂停编排启用时摘要提示按计划自动执行，不试运行', async () => {
    const x = await setup(undefined, { ...ORCH, enabled:false, status:'paused' })
    await x.set('启用状态', 'true')
    await x.view.click('检查变更')
    expect(x.dialog.querySelector('[role=status]').textContent).toContain('按计划自动执行')
    expect(x.dialog.textContent).toContain('保存不会试运行')
    await x.view.click('确认保存')
    expect(x.calls.find(c => c[0] === 'edit')[1].patch).toEqual({enabled:true})
    expect(x.calls.some(c => c[0] === 'run')).toBe(false)
  })
  it('every 改为 cron 只提交触发配置，保留脚本及状态', async () => {
    const x = await setup()
    await x.set('触发方式', 'cron')
    await x.set('Cron 表达式', '0 3 * * *')
    await x.set('IANA 时区', 'Asia/Shanghai')
    await x.view.click('检查变更')
    await x.view.click('确认保存')
    expect(x.calls.find(c => c[0] === 'edit')[1].patch).toEqual({ trigger: { kind: 'cron', expression: '0 3 * * *', timeZone: 'Asia/Shanghai' } })
    x.view.unmount()
  })
  it('仅调整高级 JSON 键序或空白不构成变更', async () => {
    const original = { ...ORCH, script: { command:'pwsh', env:{A:'1', B:'2'}, stdin:{text:'hello'} } }
    const x = await setup(undefined, original)
    await x.set('脚本高级字段 JSON', '{"stdin":{"text":"hello"},"env":{"B":"2","A":"1"}}')
    await x.view.click('检查变更')
    const text = x.dialog.textContent
    const confirm = vi.spyOn(window, 'confirm')
    await x.view.click('取消')
    expect(confirm).not.toHaveBeenCalled()
    expect(document.querySelector('[role=dialog]')).toBeFalsy()
    const wrote = x.calls.some(c => c[0] === 'edit')
    x.view.unmount()
    expect(text).toContain('没有变更')
    expect(wrote).toBe(false)
  })
  it('保存未结算时双击只提交一次', async () => {
    let resolveEdit
    const pending = new Promise(resolve => { resolveEdit = resolve })
    const x = await setup(undefined, ORCH, endpoint => endpoint === 'edit' ? pending : undefined)
    await x.set('标题', '新标题')
    await x.view.click('检查变更')
    const button = [...x.dialog.querySelectorAll('button')].find(b => b.textContent === '确认保存')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(x.calls.filter(c => c[0] === 'edit')).toHaveLength(1)
    expect(button.disabled).toBe(true)
    expect(x.dialog.contains(document.activeElement)).toBe(true)
    await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true, cancelable:true})))
    expect(x.dialog.contains(document.activeElement)).toBe(true)
    await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', shiftKey:true, bubbles:true, cancelable:true})))
    expect(x.dialog.contains(document.activeElement)).toBe(true)
    await act(async () => resolveEdit({ok: true, value: {}}))
    x.view.unmount()
  })
  it('检查变更后保留模态焦点并可 Escape 关闭', async () => {
    const x = await setup()
    await x.set('标题', '修改')
    const check = [...x.dialog.querySelectorAll('button')].find(b => b.textContent === '检查变更')
    check.focus()
    await x.view.click('检查变更')
    expect(x.dialog.contains(document.activeElement)).toBe(true)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true})))
    expect(confirm).toHaveBeenCalled()
    expect(document.querySelector('[role=dialog]')).toBeFalsy()
    expect(document.activeElement.textContent).toBe('手动修改')
  })
  it('Tab 在对话框内循环并在关闭时恢复焦点', async () => {
    const x = await setup()
    const nodes = [...x.dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')]
    nodes.at(-1).focus()
    await act(async () => nodes.at(-1).dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true, cancelable:true})))
    expect(document.activeElement).toBe(nodes[0])
    await act(async () => nodes[0].dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', shiftKey:true, bubbles:true, cancelable:true})))
    expect(document.activeElement).toBe(nodes.at(-1))
    await x.view.click('取消')
    expect(document.activeElement.textContent).toBe('手动修改')
    x.view.unmount()
  })
  it('加载新版本期间禁止重复回读及编辑', async () => {
    let resolveView
    const pending = new Promise(resolve => { resolveView = resolve })
    const x = await setup(undefined, ORCH, (endpoint, _payload, calls) => endpoint === 'view' && calls.filter(c => c[0] === 'view').length > 1 ? pending : undefined)
    const reload = [...x.dialog.querySelectorAll('button')].find(b => b.textContent === '加载新版本')
    await act(async () => {
      reload.dispatchEvent(new MouseEvent('click', {bubbles:true}))
      reload.dispatchEvent(new MouseEvent('click', {bubbles:true}))
    })
    expect(x.calls.filter(c => c[0] === 'view')).toHaveLength(2)
    expect(x.field('标题').disabled).toBe(true)
    await act(async () => resolveView({ok:true,value:{...ORCH,runs:[],availableActions:[]}}))
    expect(x.field('标题').disabled).toBe(false)
    x.view.unmount()
  })
  it('保存成功但 view 回读失败时提示回读失败而不是写入失败', async () => {
    const x = await setup(undefined, ORCH, (endpoint, _payload, calls) => endpoint === 'view' && calls.filter(c => c[0] === 'view').length > 1 ? Promise.resolve({ok:false,error:{code:'offline',message:'读失败'}}) : undefined)
    await x.set('标题', '新标题')
    await x.view.click('检查变更')
    await x.view.click('确认保存')
    expect(x.view.text()).toContain('详情回读失败')
    expect(x.view.text()).toContain('保存已成功')
    expect(x.view.text()).not.toContain('保存失败')
    expect(x.calls.filter(c => c[0] === 'edit')).toHaveLength(1)
    x.view.unmount()
  })
  it('无变更和无效 JSON 不提交；Escape 脏草稿需确认并恢复焦点', async () => {
    const x = await setup()
    await x.view.click('检查变更')
    expect(x.dialog.textContent).toContain('没有变更')
    await x.set('判定 JSON', '{')
    await x.view.click('检查变更')
    expect(x.dialog.textContent).toContain('JSON 格式错误')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    await act(async () => x.dialog.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })))
    expect(document.querySelector('[role=dialog]')).toBeTruthy()
    await act(async () => x.dialog.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true })))
    expect(document.querySelector('[role=dialog]')).toBeFalsy()
    expect(document.activeElement.textContent).toBe('手动修改')
    expect(x.calls.some(c => c[0] === 'edit')).toBe(false)
    confirm.mockRestore(); x.view.unmount()
  })
})

describe('完成后行为展示与结果块（v0.1y 起；v0.1aa 去键化：契约 11「完成后行为展示」+「结果块优先展示」）', () => {
  const judgedOrch = {
    ...ORCH,
    judge: {
      rules: [
        { when: { exitCode: 0 }, actions: ['notify'] },
        { when: { any: [{ timedOut: true }, { stdout: { contains: 'ERROR' } }] }, actions: [] },
        { when: { all: [{ exitCode: { not: 0 } }, { durationMs: { min: 5000 } }] }, actions: ['notify', 'cleanup'] },
      ],
      fallback: ['archive'],
    },
    actions: {
      notify: { kind: 'event', name: 'done' },
      cleanup: { kind: 'plugin', action: 'fs.cleanup' },
      archive: { kind: 'session', mode: 'ephemeral', title: '待整理归档', prompt: '把 {{stdoutTail}} 归档到目标目录\n后续说明' },
    },
  }

  async function mountDetail(makeView) {
    const { exports } = await loadClientBundle()
    const { registrations } = mountRegistrations(exports)
    panelComponent = panelEntry(registrations).component
    const view = await renderPanel({ call: (endpoint) => endpoint === 'list' ? Promise.resolve(listResult()) : Promise.resolve(makeView()), subscribeReset: () => () => {} })
    await view.clickRow('log rotate')
    return view
  }

  it('「脚本完成后」区把 judge/actions 翻译成简体中文明话（v0.1aa 去键化）：规则行 + 动作描述行', async () => {
    const view = await mountDetail(() => viewResult(judgedOrch))
    const text = view.detail().textContent
    expect(text).toContain('脚本完成后')
    expect(text).toContain('规则 1：当 退出码 = 0')
    expect(text).toContain('规则 2：当 （任一）已超时 或 stdout 包含“ERROR” → 不执行动作')
    expect(text).toContain('规则 3：当 （全部）退出码 ≠ 0 且 耗时 介于 5000–∞ms')
    expect(text).toContain('兜底（无规则命中）')
    // 动作以缩进描述行出现
    expect(text).toContain('→ 发出事件 done')
    expect(text).toContain('→ 调用注册动作 fs.cleanup（当前未注册）')
    expect(text).toContain('→ 开启一次性会话「待整理归档」')
    expect(text).toContain('prompt：「把 {{stdoutTail}} 归档到目标目录…」')
    // 动作键不再出现；「动作说明」区块移除
    expect(text).not.toContain('notify')
    expect(text).not.toContain('→ cleanup')
    expect(text).not.toContain('、cleanup')
    expect(text).not.toContain('archive')
    expect(text).not.toContain('动作说明')
    expect(text).not.toContain('（ephemeral）')
    view.unmount()
  })

  it('v0.1aa：引用未定义动作键 → 错误色「未知动作」（唯一显示键的场景）；已定义未引用的动作弱化列出', async () => {
    const view = await mountDetail(() => viewResult({
      ...ORCH,
      judge: { rules: [{ when: { exitCode: 1 }, actions: ['ghost'] }], fallback: ['orphan-2'] },
      actions: { orphan1: { kind: 'session', mode: 'persistent', title: '备用会话' } },
    }))
    const text = view.detail().textContent
    expect(text).toContain('未知动作「ghost」（actions 里没有定义）')
    expect(text).toContain('未知动作「orphan-2」（actions 里没有定义）')
    expect(text).toContain('已定义但未引用：开启持久会话「备用会话」')
    expect(text).not.toContain('orphan1')
    view.unmount()
  })

  it('零规则且无 fallback：显示「脚本完成后不执行任何动作」，不出现规则与兜底行', async () => {
    const view = await mountDetail(() => viewResult({ ...ORCH, judge: { rules: [] } }))
    const text = view.detail().textContent
    expect(text).toContain('脚本完成后不执行任何动作')
    expect(text).not.toContain('规则 1')
    expect(text).not.toContain('兜底')
    view.unmount()
  })

  it('空 when 显示「无条件（总是命中）」', async () => {
    const view = await mountDetail(() => viewResult({ ...ORCH, judge: { rules: [{ when: {}, actions: ['a'] }], fallback: [] }, actions: { a: { kind: 'event', name: 'x' } } }))
    const text = view.detail().textContent
    expect(text).toContain('规则 1：当 无条件（总是命中）')
    expect(text).toContain('→ 发出事件 x')
    expect(text).toContain('兜底（无规则命中） → 不执行动作')
    view.unmount()
  })

  it('run 卡结果块：标记行结果（summary/level/fields）+ 会话上报（时间、sessionId 尾 8 位、fields）优先于原始输出', async () => {
    const run = {
      runId: 'run-7f3c1a9e',
      orchestrationId: 'log-rotate',
      trigger: 'manual',
      scheduledAt: '2026-11-16T00:00:00.000Z',
      startedAt: '2026-11-16T00:00:00.100Z',
      settledAt: '2026-11-16T00:00:02.000Z',
      status: 'succeeded',
      skipReason: null,
      script: { command: 'pwsh', exitCode: 0, signal: null, timedOut: false, durationMs: 1900, stdoutTail: '##SCRIPT-RESULT## {\"summary\":\"x\"}\n原始输出行', stderrTail: '', truncated: false },
      matchedRule: 0,
      usedFallback: false,
      actions: [],
      result: {
        summary: '扫描 120 个文件：3 组重复，回收 5 个',
        level: 'info',
        fields: { 扫描: '120', 回收: '5' },
        reports: [
          { at: '2026-11-16T00:01:00.000Z', sessionId: 'session-12345678-abcd', summary: '归档完成：8 个目录', level: 'warn', fields: { 目录: '8' } },
        ],
      },
    }
    const view = await mountDetail(() => ({ ok: true, value: { ...ORCH, runs: [run], availableActions: [] } }))
    const card = view.detail().querySelector('div[style*="border: 1px solid"]')
    expect(card).toBeTruthy()
    const text = card.textContent
    expect(text).toContain('结果：')
    expect(text).toContain('扫描 120 个文件：3 组重复，回收 5 个')
    expect(text).toContain('扫描：')
    expect(text).toContain('120')
    expect(text).toContain('会话上报')
    expect(text).toContain('…678-abcd')
    expect(text).toContain('归档完成：8 个目录')
    expect(text).toContain('目录：')
    // 结果块在原始输出（stdout 尾部）之前
    expect(text.indexOf('扫描 120 个文件')).toBeLessThan(text.indexOf('原始输出行'))
    view.unmount()
  })

  it('无 result 的 run 卡不渲染结果块', async () => {
    const run = {
      runId: 'run-7f3c1a9e',
      orchestrationId: 'log-rotate',
      trigger: 'manual',
      scheduledAt: '2026-11-16T00:00:00.000Z',
      startedAt: '2026-11-16T00:00:00.100Z',
      settledAt: '2026-11-16T00:00:02.000Z',
      status: 'succeeded',
      skipReason: null,
      script: { command: 'pwsh', exitCode: 0, signal: null, timedOut: false, durationMs: 1900, stdoutTail: 'done', stderrTail: '', truncated: false },
      matchedRule: null,
      usedFallback: false,
      actions: [],
    }
    const view = await mountDetail(() => ({ ok: true, value: { ...ORCH, runs: [run], availableActions: [] } }))
    const card = view.detail().querySelector('div[style*="border: 1px solid"]')
    expect(card.textContent).not.toContain('结果：')
    view.unmount()
  })

  // v0.1z：session 动作 prompt 预览点击展开完整 prompt，再点收起（契约 11「prompt 预览可展开」）
  it('session 动作 prompt 预览：点击展开完整 prompt（aria-expanded 联动），再点收起', async () => {
    const view = await mountDetail(() => viewResult(judgedOrch))
    const findToggle = () => [...view.detail().querySelectorAll('button[aria-expanded]')].find((b) => b.textContent.includes('prompt：'))
    let toggle = findToggle()
    expect(toggle, 'prompt 展开开关').toBeTruthy()
    // 折叠态：只见首行预览，完整 prompt 的后续行不可见
    expect(view.detail().textContent).toContain('prompt：「把 {{stdoutTail}} 归档到目标目录…」')
    expect(view.detail().textContent).not.toContain('后续说明')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    toggle = findToggle()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // 展开态：完整 prompt 原文（含后续行与原始换行）出现在 pre 块中
    const pre = view.detail().querySelector('pre')
    expect(pre).toBeTruthy()
    expect(pre.textContent).toBe(judgedOrch.actions.archive.prompt)
    await act(async () => { toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    expect(view.detail().textContent).not.toContain('后续说明')
    view.unmount()
  })
})
