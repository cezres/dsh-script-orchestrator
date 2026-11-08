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
    expect(id).toBe('@local/dsh-script-orchestrator')
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
})
