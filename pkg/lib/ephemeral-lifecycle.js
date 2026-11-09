// ephemeral 会话回收生命周期（契约 docs/temp/05-actions.md 两模式表与回收语义、
// docs/temp/09-states-errors.md；决策票 20（ephemeral 定案）、21 #5（插件自持计时、
// 新活动重置）、原型票 23 E3（whenIdle 挂 agent、dispose=teardown））。
// 生命周期 = 投递首条 → agent.whenIdle() 收敛（宿主 do-while 语义天然含用户接管期间的
// 对话——有人活动就不算 idle）→ 等 idleDisposeSeconds（默认 0；延迟期间的新活动重置，
// 经 agent/status 事件观察）→ handle.dispose()。dispose 是 teardown 不是删除：持久化
// 日志与 Workspace 关系保留，会话变冷、历史可读、可重新打开续聊。
// 如实声明（契约 05）：到期 dispose 恰逢发消息的微小竞态不承诺原子——已 flush 进
// durable inbox 的消息不丢，会话重开后仍会被处理。
// 登记表为内存态：插件重启不重新认领历史 ephemeral（未回收者已随卸载 owner-fiber
// teardown，冷会话保留）；disposeAll 供插件卸载序列对全部 live 条目做确定性 teardown。
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** 经事件循环让步（macrotask，1ms）：打断病态 agent 下的微任务自旋；固定步进保证假计时器窗口有界。 */
const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 1))

/**
 * 建 ephemeral 会话登记与回收器。
 * @param {object} [deps]
 * @param {object} [deps.logger] 内部日志（warn 面；缺省 console）
 * @returns {{
 *   adopt: (handle: { agent, dispose }, agent: object, sessionId: string, idleDisposeSeconds?: number) => void,
 *   retain: (handle: { agent, dispose }, sessionId: string) => void,
 *   isLive: (sessionId: string) => boolean,
 *   liveCount: () => number,
 *   disposeAll: () => Promise<void>,
 * }}
 */
export function createEphemeralRegistry({ logger } = {}) {
  const log = logger ?? console
  // sessionId → entry { sessionId, handle, stopped, timer, notifyActivity, disposing }
  const live = new Map()

  /** 单条目的确定性 teardown：幂等（disposing 守卫）、清计时、吞 dispose 错误、移出登记。 */
  function settleDispose(entry) {
    if (entry.disposing !== null) return entry.disposing
    entry.stopped = true
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    entry.disposing = (async () => {
      try {
        await entry.handle.dispose()
      } catch (error) {
        log.warn?.(`script-orchestrator: ephemeral session ${entry.sessionId} dispose 失败：${messageOf(error)}`)
      } finally {
        live.delete(entry.sessionId)
      }
    })()
    return entry.disposing
  }

  /**
   * 回收循环：whenIdle 收敛 →（idleDisposeSeconds > 0 时）延迟窗口与新活动竞速。
   * 新活动观察面 = agent.ctx 上的 agent/status 事件（宿主 setPhase 在 idle↔running
   * 跃迁时发布）；起臂延迟前回读 agent.status 兜底「事件已发过」的窗口。无事件面的
   * agent 退化为只靠 whenIdle（契约竞态声明已覆盖残余窗口）。
   */
  async function runLifecycle(entry, agent, idleDisposeSeconds) {
    let watchOff = null
    if (typeof agent.ctx?.on === 'function') {
      try {
        watchOff = agent.ctx.on('agent/status', (payload) => {
          if (payload?.status !== 'idle') entry.notifyActivity?.()
        })
      } catch {
        watchOff = null // 防御：事件面不可用不阻断回收路径
      }
    }
    try {
      for (;;) {
        try {
          await agent.whenIdle()
        } catch (error) {
          // 防御：whenIdle 不应抛；无法观测 idle 时尽力回收，不留永久 live
          log.warn?.(`script-orchestrator: ephemeral session ${entry.sessionId} whenIdle 异常：${messageOf(error)}`)
          break
        }
        if (entry.stopped) return
        if (!(idleDisposeSeconds > 0)) break // 零延迟（契约序列字面）：收敛即 dispose
        // 决策 21 #5「新活动重置」：延迟期间的用户接管/对话活动把计时推回 whenIdle 收敛
        const activity = new Promise((resolve) => {
          entry.notifyActivity = () => resolve('activity')
        })
        if (agent.status !== 'idle') {
          // armed 之后回读：armed 前已发生的活动在此捕获（事件已错过）。
          // 必须经事件循环让步再回到 whenIdle——病态 agent（whenIdle 立即返回而 status
          // 恒非 idle）下纯微任务 continue 会饿死事件循环（vitest 假计时器实测复现）。
          entry.notifyActivity = null
          await yieldToEventLoop()
          continue
        }
        const delay = new Promise((resolve) => {
          entry.timer = setTimeout(() => resolve('delay'), idleDisposeSeconds * 1000)
        })
        const winner = await Promise.race([delay, activity])
        if (entry.timer !== null) {
          clearTimeout(entry.timer)
          entry.timer = null
        }
        entry.notifyActivity = null
        if (entry.stopped) return
        if (winner === 'activity') continue // 新活动：重新收敛后再起延迟
        break
      }
    } finally {
      watchOff?.()
    }
    await settleDispose(entry)
  }

  return {
    /**
     * 投递成功后启动回收生命周期（fire-and-forget；任务由登记表与 disposeAll 跟踪收口）。
     * @param {{ agent, dispose }} handle agents.create 返回的自持 handle
     * @param {object} agent live Agent（whenIdle/status/ctx 面）
     * @param {string} sessionId 会话 id
     * @param {number} [idleDisposeSeconds] 空闲多少秒后回收（缺省 0 = 收敛即回收）
     */
    adopt(handle, agent, sessionId, idleDisposeSeconds = 0) {
      if (live.has(sessionId)) {
        log.warn?.(`script-orchestrator: ephemeral session ${sessionId} 重复 adopt（防御忽略；每次 run 应新建会话）`)
        return
      }
      const entry = { sessionId, handle, stopped: false, timer: null, notifyActivity: null, disposing: null }
      live.set(sessionId, entry)
      runLifecycle(entry, agent, idleDisposeSeconds).catch((error) => {
        log.warn?.(`script-orchestrator: ephemeral 回收任务异常退出（${sessionId}）：${messageOf(error)}`)
        settleDispose(entry)
      })
    },
    /**
     * 投递失败现场保留（契约 05「投递失败的 ephemeral 不启动回收计时」）：
     * 只登记供卸载 teardown，不启动任何回收（stopped 预置 true），会话可被人工接管。
     */
    retain(handle, sessionId) {
      if (live.has(sessionId)) return
      live.set(sessionId, { sessionId, handle, stopped: true, timer: null, notifyActivity: null, disposing: null })
    },
    /** 会话是否仍由本实例跟踪（live 或失败保留）。 */
    isLive: (sessionId) => live.has(sessionId),
    liveCount: () => live.size,
    /**
     * 全量 teardown（插件卸载序列调用）：停新回收、清在途计时、对全部登记条目确定性
     * dispose（幂等；宿主 owner-fiber teardown 兜底之下仍显式收口，保证顺序可测）。
     */
    async disposeAll() {
      const entries = [...live.values()]
      await Promise.all(
        entries.map((entry) => {
          entry.stopped = true
          entry.notifyActivity?.() // 唤醒可能在延迟竞速中挂起的循环（看到 stopped 即退出）
          return settleDispose(entry)
        }),
      )
    },
  }
}
