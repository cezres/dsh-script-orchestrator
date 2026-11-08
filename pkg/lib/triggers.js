// 触发纯函数（契约 docs/temp/02-triggers.md「下次触发计算」）。
// 只计算后继时刻，不判断暂停、执行中、编辑代际、重启或手动 run（那些由调度器持有）。
// 票 25 范围：every（fixed-rate / fixed-delay 首次计划同为锚点 + everySeconds）；
// cron 的五位表达式与五年有界窗口属票 27。

/**
 * 返回严格大于 fromMs 的下一个计划时刻（毫秒）；无解返回 null。
 * @param {object} trigger 已通过创建/编辑校验的触发配置
 * @param {number} fromMs 锚点毫秒（创建=createdAt、恢复=resumedAt、编辑=editedAt、
 *   fixed-rate 后续=上一次 scheduledAt、fixed-delay 后续=上一次自动 run 的 settledAt）
 * @returns {number | null}
 */
export function nextOccurrence(trigger, fromMs) {
  if (trigger?.kind === 'every' && Number.isInteger(trigger.everySeconds)) {
    return fromMs + trigger.everySeconds * 1000
  }
  // cron（票 27）与未知 kind：无解。未知 kind 在创建校验阶段已被拒绝，
  // 此处的 null 只是纯函数的全函数兜底，不用于业务判断。
  return null
}
