// 触发纯函数（契约 docs/temp/02-triggers.md「下次触发计算」）。
// 只计算后继时刻，不判断暂停、执行中、编辑代际、重启或手动 run（那些由调度器持有）。
// every：fixed-rate / fixed-delay 首次计划同为锚点 + everySeconds。
// cron（票 27）：dsh-util-time 的 Cron（五位 Vixie + 显式 IANA 时区 + DST 规则）；
// 契约的 5 年有界窗口由本层施加（库自身的搜索地平线是 400 年，见下方 CRON_WINDOW_MS）。
import { Cron } from '@deepseek-ai/dsh-util-time'

/** cron 求解窗口（契约 02：任何 cron 在 5 年窗口内无解即视为无解，不允许无限循环）。
 * 取 5 × 366 天：保证覆盖任意起点向后 5 个日历年的全部时刻（含闰年边界）。 */
export const CRON_WINDOW_MS = 5 * 366 * 24 * 60 * 60 * 1000

/** Cron 实例缓存（冻结值、无状态；键 = 记录里的 expression + timeZone 原样）。
 * 规模受编排数上界约束，不做淘汰。 */
const cronCache = new Map()

function parseCron(trigger) {
  if (typeof trigger.expression !== 'string' || typeof trigger.timeZone !== 'string') return undefined
  const key = `${trigger.timeZone}\u0000${trigger.expression}`
  let rule = cronCache.get(key)
  if (rule === undefined) {
    const parsed = Cron.parse(trigger.expression, trigger.timeZone)
    if (parsed.kind !== 'accepted') {
      // 防御面：创建/更新校验已拒绝的形状（库 400 年地平线内永无解的表达式在此同样为 null）
      rule = null
    } else {
      rule = parsed.rule
    }
    cronCache.set(key, rule)
  }
  return rule ?? undefined
}

/**
 * 返回严格大于 fromMs 的下一个计划时刻（毫秒）；无解返回 null。
 * @param {object} trigger 已通过创建/编辑校验的触发配置
 * @param {number} fromMs 锚点毫秒（创建=createdAt、恢复=resumedAt、编辑=editedAt、
 *   fixed-rate 后续=上一次 scheduledAt、fixed-delay 后续=上一次自动 run 的 settledAt、
 *   cron=本次需要计算其后继时刻的参考时刻）
 * @returns {number | null}
 */
export function nextOccurrence(trigger, fromMs) {
  if (!Number.isFinite(fromMs)) return null
  if (trigger?.kind === 'every' && Number.isInteger(trigger.everySeconds)) {
    return fromMs + trigger.everySeconds * 1000
  }
  if (trigger?.kind === 'cron') {
    const rule = parseCron(trigger)
    if (rule === undefined) return null
    // Cron.next：严格晚于 after 的下一次出现（跳过 DST gap、重复取较早瞬时），
    // 库内部搜索有界（400 年地平线 + 四位数年份界限），永不无限循环
    const nextIso = rule.next(fromMs)
    if (nextIso === undefined) return null
    const nextMs = Date.parse(nextIso)
    // 契约 5 年窗口：超出即视为无解（由调用方在创建/更新时拒绝、运行期转 ended）
    if (nextMs > fromMs + CRON_WINDOW_MS) return null
    return nextMs
  }
  // 未知 kind 在创建校验阶段已被拒绝，此处的 null 只是纯函数的全函数兜底。
  return null
}

/**
 * cron 错过合并（契约 02「重启与错过的触发」）：多次错过只取最近一次到期的匹配时刻，
 * 并给出受理时刻之后的下一计划。纯计算，不判断暂停/编辑/手动 run（调度器职责）。
 *
 * 库 Cron.resolve 的语义与契约一致（不重放积压，取最近到期）；nextScheduledAt 再套
 * 本层 5 年窗口（与 nextOccurrence 同一判定：超窗即视为无解，调度器据此转 ended）。
 *
 * @param {object} trigger cron 触发配置（expression/timeZone）
 * @param {string} plannedIso 保留的计划时刻（ISO，RFC 3339 毫秒）
 * @param {number} acceptedMs 受理时刻（≥ 计划时刻；FIFO 槽内取值，迟到即真实受理时刻）
 * @returns {{ occurrenceMs: number, nextMs: number | null } | { defer: true } | null}
 *   null = 触发配置形状非法（防御面，创建校验已拒；调用方记日志并转 ended 防死循环）；
 *   { defer } = 暂态不可解（受理时刻早于计划时刻的时钟回拨）：保持计划、重排 timer。
 */
export function resolveCronMiss(trigger, plannedIso, acceptedMs) {
  const rule = parseCron(trigger)
  if (rule === undefined || !Number.isFinite(acceptedMs)) return null
  try {
    const resolved = rule.resolve(plannedIso, acceptedMs)
    const nextMs =
      resolved.nextScheduledAt === undefined ? null : Date.parse(resolved.nextScheduledAt)
    if (nextMs !== null && (Number.isNaN(nextMs) || nextMs > acceptedMs + CRON_WINDOW_MS)) {
      return { occurrenceMs: Date.parse(resolved.occurrenceAt), nextMs: null }
    }
    return { occurrenceMs: Date.parse(resolved.occurrenceAt), nextMs }
  } catch {
    return { defer: true }
  }
}
