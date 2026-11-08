// 契约错误（docs/temp/09-states-errors.md）：统一形状 { code, message, details? }。
// 服务层以异常承载契约错误；工具适配层与桥捕获后还原为契约错误值/envelope。
export class OrchestratorError extends Error {
  /**
   * @param {string} code 契约错误码（script_input_invalid / script_unknown / …）
   * @param {string} message 面向人的消息
   * @param {object} [details] 可编程判断的细节
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'OrchestratorError'
    this.code = code
    this.details = details
  }
}

/** script_input_invalid 快捷构造（details 至少含 field + reason，契约 02「校验错误」）。 */
export const inputInvalid = (field, reason, message, extra = {}) =>
  new OrchestratorError('script_input_invalid', message, { field, reason, ...extra })

/** 判定「纯对象」（非数组/非 null 的普通对象）。 */
export const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 判定值可无损 JSON 序列化（无 undefined/函数/循环/Symbol；BigInt 视为非法 JSON）。 */
export function isLosslessJson(value, seen = new Set()) {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'bigint':
    case 'undefined':
    case 'function':
    case 'symbol':
      return false
    case 'object': {
      if (seen.has(value)) return false
      seen.add(value)
      if (Array.isArray(value)) return value.every((entry) => isLosslessJson(entry, seen))
      if (!isPlainObject(value)) return false
      return Object.values(value).every((entry) => isLosslessJson(entry, seen))
    }
    default:
      return false
  }
}
