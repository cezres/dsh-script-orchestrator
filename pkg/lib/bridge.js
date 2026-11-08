// Connection 桥：独立 channel /script-orchestrator 的一元 RPC（契约 docs/temp/11-web-panel.md）。
// 只做最小形状校验与 envelope 包装，业务语义全部由服务判定（零翻译 DTO）；
// abort 只终止等待，不取消已受理操作（本桥不把 signal 传给只读的 list）。
const invalid = (field, reason, message) => ({
  ok: false,
  error: { code: 'script_input_invalid', message, details: { field, reason } },
})

const internal = (message) => ({
  ok: false,
  error: { code: 'internal_error', message, details: {} },
})

/** ListQuery 的最小形状校验：active/limit/offset，多余或非法即 script_input_invalid。 */
function validateListPayload(payload) {
  if (payload === undefined) return null
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return invalid('payload', 'format', 'list 的参数必须是对象')
  }
  if ('active' in payload && typeof payload.active !== 'boolean') {
    return invalid('active', 'format', 'active 必须是布尔值')
  }
  if ('limit' in payload) {
    const { limit } = payload
    if (typeof limit !== 'number' || !Number.isInteger(limit)) {
      return invalid('limit', 'format', 'limit 必须是整数')
    }
    if (limit < 1 || limit > 500) {
      return invalid('limit', 'range', 'limit 必须在 1–500 之间')
    }
  }
  if ('offset' in payload) {
    const { offset } = payload
    if (typeof offset !== 'number' || !Number.isInteger(offset)) {
      return invalid('offset', 'format', 'offset 必须是整数')
    }
    if (offset < 0) {
      return invalid('offset', 'range', 'offset 必须是非负整数')
    }
  }
  for (const key of Object.keys(payload)) {
    if (key !== 'active' && key !== 'limit' && key !== 'offset') {
      return invalid(key, 'unexpected', `list 不接受字段 '${key}'`)
    }
  }
  return null
}

/**
 * 建 /script-orchestrator 的 rpc.handle handler。
 * @param {object} deps
 * @param {object} deps.service 管理服务（ctx.scriptOrchestrator 实现面）
 */
export function createBridgeHandler({ service }) {
  const endpoints = {
    list: async (payload) => {
      const violation = validateListPayload(payload)
      if (violation) return violation
      return { ok: true, value: await service.list(payload ?? {}) }
    },
    // view/create/edit/run/listActions 属后续票（spec §3 步骤 6；票 25–33）
  }
  return async function bridgeHandler(endpoint, payload, _signal, _peer) {
    try {
      const invoke = endpoints[endpoint]
      if (!invoke) {
        return internal(`endpoint '${String(endpoint)}' 尚未实现或不存在`)
      }
      return await invoke(payload)
    } catch (error) {
      return internal(`endpoint '${String(endpoint)}' 内部错误: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
