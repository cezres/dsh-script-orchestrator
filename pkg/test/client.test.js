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
function mountRegistrations(clientExports) {
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
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

let panelComponent = null

describe('Web client（lib/client.js，简化档 lazy-CJS）', () => {
  it('bundle id 为包名，导出 apply（生成器）+ inject（slots/connection）', async () => {
    const { id, exports } = await loadClientBundle()
    expect(id).toBe('@local/dsh-script-orchestrator')
    expect(exports.inject).toEqual(['slots', 'connection'])
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
})
