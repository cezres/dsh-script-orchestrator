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

/**
 * 把桥挂到 webServer（独立 channel 的 prefix 路由）。
 *
 * 契约 docs/temp/11-web-panel.md 指定 `connection.rpc.handle(channel, handler)`；但
 * dsh-client-connection@0.2.2-rc.1 的实现经 Cordis trace 机制把 `owner.webServer`
 * 的解析锚定到服务提供者 fiber（client-connection 自身未注入 webServer），第三方
 * 插件调用 rpc.handle 必然抛 "cannot get property \"webServer\" without inject"
 * （沙箱实测复现）。此处内联与 rpc.handle/register 逐行等价的挂载：
 *   - 认证与 Host/Origin fence 复用 connection.admit（内建，不自造）；
 *   - envelope 协议（client-request / server-response / gateway/bad-request /
 *     handler failure → HTTP 500）与 rpcFetchHandler 对齐，浏览器侧
 *     ctx.connection.rpc.call(channel, endpoint, payload) 零改动可用。
 * @param {object} deps
 * @param {object} deps.connection 宿主 connection 服务（ctx.connection）
 * @param {object} deps.webServer 宿主 webServer 服务（ctx.webServer）
 * @param {Function} deps.handler createBridgeHandler 的返回值
 * @param {string} [deps.channel] 通道名，默认 /script-orchestrator
 * @returns {Function} disposer（注销路由）
 */
export function mountBridge({ connection, webServer, handler, channel = '/script-orchestrator' }) {
  return webServer.register({
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      const admission = connection.admit(req)
      if ('rejection' in admission) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await respondRpc(req, res, handler, channel, admission.peer)
    },
  })
}

/** node:http 请求 → envelope 校验 → handler → server-response（对齐 rpcFetchHandler 行为）。 */
async function respondRpc(req, res, handler, channel, peer) {
  const endpoint = (req.url ?? '').slice(channel.length + 1)
  if (req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let message = null
  try {
    message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('body is not JSON')
    return
  }
  const badRequest = (rpcId, messageText) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(
      JSON.stringify({
        type: 'server-response',
        rpcId,
        result: { ok: false, error: { code: 'gateway/bad-request', message: messageText, details: {} } },
      }),
    )
  }
  if (
    typeof message !== 'object' ||
    message === null ||
    message.type !== 'client-request' ||
    typeof message.rpcId !== 'string' ||
    typeof message.method !== 'string'
  ) {
    badRequest('invalid-request', 'invalid client-request message')
    return
  }
  if (message.method !== endpoint) {
    badRequest(
      message.rpcId,
      `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
    )
    return
  }
  try {
    const result = await handler(endpoint, message.payload, undefined, peer)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result }))
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`handler failure: ${String(error)}`)
  }
}
