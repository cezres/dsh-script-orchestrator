// 动作派发器（契约 docs/temp/05-actions.md、06-events-service.md、09-states-errors.md）。
// 判定命中后按 actionKeys 声明顺序串行执行；单个动作失败只记录、不中断后续动作（失败隔离）。
// 三类动作：
// - event：发出 script-orchestrator/<短名>，载荷固定四键（契约 05）；发出即忘——listener
//   同步抛错由发布端兜底记 event_listener_failed，动作仍视为成功（契约 06 双层隔离）。
// - plugin：逐动作执行前实时查注册表（不缓存），未注册/已摘除 → failed unknown_action；
//   已注册则以 ActionContext 调用（契约 06）；registerAction/disposer 四不变量属票 31。
// - session：本票交付 prompt 渲染与 template_invalid 判定；创建/投递/回收执行属票 32/33。
// dispatching 取消（契约 03/09）：取消请求后停止派发剩余动作（记 skipped），在途动作经其
// signal 中止、结果如实记录——run 终态优先于动作汇总的落盘由 runner（settle）负责。
import { buildTemplateVariables, renderPayload, renderTemplate, appendWarning } from './judge.js'

/**
 * 动作注册表（服务实例内部表）。票 30 只需查表（resolve）与快照（snapshot）面；
 * registerAction 的注册/重名/disposer 四不变量属票 31。
 */
export function createActionRegistry() {
  const entries = new Map()
  return {
    /** 逐动作执行前实时查表（契约 06：不缓存解析结果）。 */
    resolve(name) {
      return entries.get(name)
    },
    /** 展示快照（listActions / script_view 的 availableActions），按 name 排序。 */
    snapshot() {
      return [...entries.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ name, description }) => (description === undefined ? { name } : { name, description }))
    },
  }
}

/** 动作汇总 → run 终态（契约 09 结算规则 4；skipped 不计入成功/失败，仅出现在 canceled run）。 */
export function aggregateRunStatus(results) {
  let succeeded = 0
  let failed = 0
  for (const result of results) {
    if (result.status === 'succeeded') succeeded += 1
    else if (result.status === 'failed') failed += 1
  }
  if (failed === 0) return 'succeeded' // 含零动作（0/0）
  if (succeeded === 0) return 'failed'
  return 'partial'
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * 串行派发判定选出的动作。
 * @param {object} deps
 * @param {string[]} deps.actionKeys 判定选出的动作键（声明序）
 * @param {Record<string, object>} deps.actions 编排的动作定义（键 → 定义）
 * @param {object} deps.orchestration { id, title }
 * @param {object} deps.run run 视图（含 script 结果、trigger、runId、时间线）
 * @param {object} deps.verdict 判定结果 { matchedRule, usedFallback }
 * @param {string} deps.stdoutText 收集到的 stdout 全文（{{json:}} 解析源）
 * @param {object} deps.registry { resolve(name) }（createActionRegistry 或结构等同物）
 * @param {(name: string, payload?: unknown) => void} deps.emit 事件发布（宿主 ctx.emit）
 * @param {object} [deps.logger] 内部日志（event_listener_failed 等）
 * @param {{ requested: boolean, controller: AbortController | null }} [deps.cancellation]
 *   dispatching 取消面：runner 持有并在取消时置 requested + abort 当前动作 controller。
 * @param {(result: object) => void} [deps.onActionResult] 每动作结算回调（live overlay 更新）
 * @returns {Promise<{ results: Array<{name,kind,status,error?,warnings?}>, canceled: boolean }>}
 */
export async function dispatchActions({
  actionKeys,
  actions,
  orchestration,
  run,
  verdict,
  stdoutText,
  registry,
  emit,
  logger,
  cancellation,
  onActionResult,
}) {
  const log = logger ?? console
  const publish = emit ?? (() => {})
  const results = []
  const variables = buildTemplateVariables({ orchestration, run, script: run.script, verdict })
  const jsonSource = { stdoutText: stdoutText ?? '' }
  let canceled = false

  const record = (result) => {
    results.push(result)
    onActionResult?.(result)
  }

  for (const key of actionKeys) {
    const definition = actions?.[key]
    if (definition === undefined) {
      // 防御：创建/更新静态校验后不应出现；kind 取值仅为满足记录形状
      record({
        name: key,
        kind: 'event',
        status: 'failed',
        error: { code: 'internal_error', message: `动作键 '${key}' 未在编排 actions 中定义（静态校验缺口）` },
      })
      continue
    }
    if (cancellation?.requested === true) {
      canceled = true
      record({ name: key, kind: definition.kind, status: 'skipped' })
      continue
    }

    const warnings = []
    const fail = (code, message) =>
      record({ name: key, kind: definition.kind, status: 'failed', error: { code, message }, ...(warnings.length > 0 ? { warnings } : {}) })

    if (definition.kind === 'event') {
      const renderedPayload =
        definition.payload === undefined ? undefined : renderPayload(definition.payload, variables, jsonSource, warnings)
      // 契约 06 载荷纪律：发布前构造全新对象（不复用 run 记录引用），保证 JSON 安全
      const payload = {
        name: definition.name,
        ...(renderedPayload === undefined ? {} : { payload: renderedPayload }),
        orchestration: { id: orchestration.id, title: orchestration.title },
        // 能进派发的 run 脚本阶段必已正常完成（spawn_failed 直接 failed 跳过判定），
        // status 恒为 succeeded（与契约 05 示例一致）；真实退出码由 exitCode 携带
        run: { runId: run.runId, status: 'succeeded', exitCode: run.script.exitCode ?? null },
      }
      try {
        publish(`script-orchestrator/${definition.name}`, payload)
      } catch (error) {
        // 发布端兜底（契约 06）：listener 同步抛错只记内部日志，不影响动作与后续动作
        log.error?.(`script-orchestrator: event_listener_failed script-orchestrator/${definition.name}: ${messageOf(error)}`)
      }
      record({ name: key, kind: 'event', status: 'succeeded', ...(warnings.length > 0 ? { warnings } : {}) })
      continue
    }

    if (definition.kind === 'plugin') {
      const renderedPayload =
        definition.payload === undefined ? undefined : renderPayload(definition.payload, variables, jsonSource, warnings)
      const registration = registry?.resolve(definition.action)
      if (registration === undefined) {
        // 契约 05：不静默跳过——最容易误配的一条
        fail('unknown_action', `注册动作 '${definition.action}' 未注册（或注册已被摘除），无法执行 plugin 动作 '${key}'`)
        continue
      }
      const controller = new AbortController()
      if (cancellation) cancellation.controller = controller
      try {
        await registration.run({
          orchestration: { id: orchestration.id, title: orchestration.title },
          run: { runId: run.runId, status: 'succeeded', trigger: run.trigger },
          payload: renderedPayload ?? null,
          // 中止来源仅两个：动作超时（票 31 接线）与整个 run 被取消（契约 06）
          signal: controller.signal,
          report: (message) => appendWarning(warnings, String(message)),
        })
        record({ name: key, kind: 'plugin', status: 'succeeded', ...(warnings.length > 0 ? { warnings } : {}) })
      } catch (error) {
        fail('action_error', `plugin 动作 '${key}'（${definition.action}）执行失败：${messageOf(error)}`)
      } finally {
        if (cancellation?.controller === controller) cancellation.controller = null
      }
      continue
    }

    if (definition.kind === 'session') {
      const renderedPrompt = renderTemplate(definition.prompt, variables, jsonSource)
      for (const warning of renderedPrompt.warnings) appendWarning(warnings, warning)
      if (renderedPrompt.text.trim() === '') {
        // 契约 04/09：prompt 渲染后去首尾空白为空 → template_invalid（payload 恒为合法 JSON 不可能触发）
        fail('template_invalid', `session 动作 '${key}' 的 prompt 渲染后去首尾空白为空（field: prompt）`)
        continue
      }
      // 票序边界：session 动作的创建/投递/回收执行属票 32（persistent）/33（ephemeral），
      // 本票交付渲染与失败隔离骨架；执行面以 action_error 占位，后续票替换
      fail('action_error', `session 动作 '${key}' 的执行尚未实现（票 32/33 交付）；prompt 已按模板渲染`)
      continue
    }

    fail('internal_error', `未知动作 kind '${definition.kind}'（动作 '${key}'）`)
  }

  return { results, canceled: canceled || cancellation?.requested === true }
}
