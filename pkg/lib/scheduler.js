// 调度器（契约 docs/temp/02-triggers.md「下次触发计算」「重启与错过的触发」）：
// 全插件只维护一个 timer——取所有 active 且 nextOccurrence 非空编排中最早者，到点
// 后重算。到点触发经 FIFO 槽复核「nextOccurrence 仍是该计划」（防 pause/edit 后的
// 旧 timer 重入），fixed-rate 沿相位推演错过时刻并合并为一次 run；fixed-delay 触发
// 后 nextOccurrence = null 等待结算（结算推进在 runner，见 lib/runner.js）；
// cron（票 27）经 resolveCronMiss 合并错过（多次只补最近一次）并推进到下一匹配，
// 推进无解（含 5 年窗口外与形状意外）转 ended 防御终态。
import { resolveCronMiss } from './triggers.js'

const iso = (ms) => new Date(ms).toISOString()

/** 参与 timer 的触发 kind（其他形状为防御面：earliestDue 直接跳过）。 */
const SCHEDULED_KINDS = new Set(['every', 'cron'])

/**
 * 建调度器。
 * @param {object} deps
 * @param {object} deps.storage openStorage() 的返回值（内存读视图）
 * @param {object} deps.queue ServiceQueue（计划推进的持久写经 FIFO 单槽）
 * @param {object} deps.runner 执行引擎（requestRun 触发口）
 * @param {() => number} [deps.now] 时钟注入
 * @param {object} [deps.logger] 内部日志
 * @param {(name: string, payload?: unknown) => void} [deps.emit] 事件发布（changed）
 * @param {object} [deps.timers] setTimeout/clearTimeout 注入（测试 fake timer 兼容默认全局）
 */
export function createScheduler({ storage, queue, runner, now, logger, emit, timers }) {
  const currentTime = now ?? (() => Date.now())
  const log = logger ?? console
  const publish = emit ?? (() => {})
  const scheduleTimeout = timers?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const cancelTimeout = timers?.clearTimeout ?? ((id) => clearTimeout(id))

  let timerHandle = null
  let started = false

  function safeEmit(name, payload) {
    try {
      publish(name, payload)
    } catch (error) {
      log.error?.(
        `script-orchestrator: event_listener_failed ${name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 最早的 active 且有计划时刻的编排（内存读，不触达后端）。 */
  function earliestDue() {
    let earliest = null
    for (const [, record] of storage.table('orchestrations').entries()) {
      if (record.status !== 'active' || typeof record.nextOccurrence !== 'string') continue
      if (!SCHEDULED_KINDS.has(record.trigger?.kind)) continue // 防御形状跳过（不触发、不崩）
      const dueMs = Date.parse(record.nextOccurrence)
      if (!Number.isFinite(dueMs)) continue
      if (earliest === null || dueMs < earliest.dueMs) {
        earliest = { id: record.id, dueMs, plannedIso: record.nextOccurrence }
      }
    }
    return earliest
  }

  /** 重算单 timer：取最早者，到点（或已过期→立即）触发。 */
  function reschedule() {
    if (!started) return
    if (timerHandle !== null) {
      cancelTimeout(timerHandle)
      timerHandle = null
    }
    const due = earliestDue()
    if (due === null) return
    const delayMs = Math.max(0, due.dueMs - currentTime())
    timerHandle = scheduleTimeout(() => {
      timerHandle = null
      void fire(due.id, due.dueMs).catch((error) => {
        log.error?.(`script-orchestrator: 调度触发异常 (${due.id}): ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        reschedule()
      })
    }, delayMs)
  }

  /**
   * 到点处理：错过合并 + 计划推进 + 触发 run。
   * fixed-rate：计划时刻沿相位推演到 ≤ now 的最大值（正常到点即自身），合并为一次
   * run（scheduledAt=该时刻），随后 nextOccurrence = 该时刻 + everySeconds（若仍在
   * 过去则继续推进到未来，不逐条补跑——契约 02「重启与错过的触发」）。
   * fixed-delay：至多补一次（scheduledAt=保留的计划时刻），触发后 nextOccurrence=null。
   * cron：resolveCronMiss 合并（scheduledAt=最近一次错过的匹配时刻），推进到下一匹配；
   * 受理时刻在 FIFO 槽内取值（排队迟到按真实受理时刻合并）。
   */
  async function fire(orchestrationId, plannedMs) {
    const table = storage.table('orchestrations')
    const record = table.get(orchestrationId)
    if (record === undefined || !SCHEDULED_KINDS.has(record.trigger?.kind)) {
      reschedule()
      return
    }
    if (record.trigger.kind === 'cron') return fireCron(record)
    return fireEvery(record, plannedMs)
  }

  /** every 路径（票 26）：相位推演合并 + 推进；槽外预计算、槽内复核写入。 */
  async function fireEvery(record, plannedMs) {
    const orchestrationId = record.id
    const table = storage.table('orchestrations')
    const nowMs = currentTime()
    const everyMs = record.trigger.everySeconds * 1000
    let anchorMs = plannedMs
    if (record.trigger.mode !== 'fixed-delay') {
      // fixed-rate 错过合并：沿相位推演到 ≤ now 的最大计划时刻
      while (anchorMs + everyMs <= nowMs) {
        anchorMs += everyMs
      }
    }
    const nextMs =
      record.trigger.mode === 'fixed-delay' ? null : anchorMs + everyMs

    // 推进槽：复核 nextOccurrence 仍是本次计划（pause/edit 后旧 timer 重入 → no-op）
    await queue.enqueue(async () => {
      const current = table.get(orchestrationId)
      if (
        current === undefined ||
        current.status !== 'active' ||
        current.nextOccurrence !== record.nextOccurrence ||
        current.trigger?.kind !== 'every'
      ) {
        return
      }
      const updated = { ...current, nextOccurrence: nextMs === null ? null : iso(nextMs) }
      await table.put(current.id, updated)
      safeEmit('script-orchestrator/changed')
    })
    // 触发 run（runner 槽内自带 disabled 兜底与单飞/并发判定）
    await runner.requestRun({ orchestrationId, trigger: 'every', scheduledAtMs: anchorMs })
    reschedule()
  }

  /**
   * cron 路径（票 27）：受理时刻在槽内取值，resolveCronMiss 合并错过 → 推进/ended →
   * 触发 run。复核槽与推进槽合并为一个原子 FIFO 任务（nextOccurrence 复核 + 写入 +
   * requestRun 顺序执行；requestRun 自身再入 FIFO，顺序仍全局串行）。
   */
  async function fireCron(record) {
    const orchestrationId = record.id
    const table = storage.table('orchestrations')
    let outcome = null // { trigger: 'cron', scheduledAtMs } | null（no-op 不触发）
    await queue.enqueue(async () => {
      const current = table.get(orchestrationId)
      if (
        current === undefined ||
        current.status !== 'active' ||
        current.nextOccurrence !== record.nextOccurrence ||
        current.trigger?.kind !== 'cron'
      ) {
        return // pause/edit 后旧 timer 重入 → no-op
      }
      const acceptedMs = currentTime()
      const miss = resolveCronMiss(current.trigger, current.nextOccurrence, acceptedMs)
      if (miss === null) {
        // 防御面：形状非法（绕过创建校验）→ ended 防 timer 死循环（运行期意外无解的同族处理）
        log.error?.(
          `script-orchestrator: cron 编排 '${orchestrationId}' 计划 '${current.nextOccurrence}' 求解失败（触发配置形状非法），转入 ended`,
        )
        await table.put(current.id, { ...current, status: 'ended', nextOccurrence: null })
        safeEmit('script-orchestrator/changed')
        return
      }
      if (miss.defer) {
        return // 时钟回拨等暂态：保持计划不动，外层 reschedule 重排
      }
      const updated = { ...current, nextOccurrence: miss.nextMs === null ? null : iso(miss.nextMs) }
      if (miss.nextMs === null) {
        // 运行期意外无解（含 5 年窗口外）：ended 防御终态（契约 02「cron 子集」末段）
        updated.status = 'ended'
      }
      await table.put(current.id, updated)
      safeEmit('script-orchestrator/changed')
      outcome = { scheduledAtMs: miss.occurrenceMs }
    })
    if (outcome !== null) {
      await runner.requestRun({ orchestrationId, trigger: 'cron', scheduledAtMs: outcome.scheduledAtMs })
    }
    reschedule()
  }

  return {
    /** 启动并计算首个 timer。 */
    start() {
      started = true
      reschedule()
    },
    /** 停止 timer（编排集合变更后用 reschedule 重算）。 */
    reschedule,
    /** 停机：清 timer，不再触发新自动 run（在途 run 由 runner 继续结算）。 */
    stop() {
      started = false
      if (timerHandle !== null) {
        cancelTimeout(timerHandle)
        timerHandle = null
      }
    },
  }
}
