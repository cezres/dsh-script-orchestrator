// 动作派发器（契约 docs/temp/05-actions.md、06-events-service.md、09-states-errors.md）。
// 判定命中后按 actionKeys 声明顺序串行执行；单个动作失败只记录、不中断后续动作（失败隔离）。
// 三类动作：
// - event：发出 script-orchestrator/<短名>，载荷固定四键（契约 05）；发出即忘——listener
//   同步抛错由发布端兜底记 event_listener_failed，动作仍视为成功（契约 06 双层隔离）。
// - plugin：逐动作执行前实时查注册表（不缓存），未注册/已摘除 → failed unknown_action；
//   已注册则以 ActionContext 调用（契约 06），超时（timeoutSeconds，默认 30 秒）→ failed
//   timeout；注册面 registry.register 与 disposer 四不变量见 createActionRegistry。
// - session：persistent 投递经 sessionHost（lib/session-action.js，票 32）；ephemeral
//   投递共用同一渲染与首条消息路径，创建走 agents.create 自持 handle、回收生命周期
//   （whenIdle → idleDisposeSeconds → dispose）移交 ephemeralRegistry（票 33）。
// dispatching 取消（契约 03/09）：取消请求后停止派发剩余动作（记 skipped），在途动作经其
// signal 中止、结果如实记录——run 终态优先于动作汇总的落盘由 runner（settle）负责。
import { buildTemplateVariables, renderPayload, renderTemplate, appendWarning } from './judge.js'
import { deliverPersistentSession, deliverEphemeralSession, SessionActionError } from './session-action.js'
import { REGISTERED_ACTION_PATTERN } from './validation.js'

/** 保留前缀（契约 06：仅此一个，防冒名内置能力；其余一概不保留）。 */
const RESERVED_ACTION_PREFIX = 'script-orchestrator.'

/**
 * 动作注册表（服务实例内部表）。register（注册与 disposer 四不变量）/ resolve
 * （执行期逐动作实时查表）/ snapshot（listActions 与 availableActions 展示快照）。
 */
export function createActionRegistry() {
  const entries = new Map() // name → { name, description?, run, token }
  return {
    /**
     * 注册一个具名动作（契约 06 registerAction）；返回 disposer。
     * 校验失败与重名均同步抛 Error（不进契约 09 错误码表——这是对插件作者的
     * 编程错误，不是编排配置错误）。disposer 四不变量：
     * 幂等（重复调用无害）、同步（返回前完成摘除）、按注册 token 精确删除
     * （只删自己那次，同名新注册不被旧 disposer 误删）、注册表为实例内部表
     * （服务整体替换时旧实例 disposer 不影响新实例）。
     * 所有权只属调用方 ctx.effect（本注册表不绑定任何清理）。
     */
    register(definition) {
      if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
        throw new Error('registerAction 的 definition 必须是对象 { name, description?, run }')
      }
      const { name, description, run } = definition
      if (typeof name !== 'string' || !REGISTERED_ACTION_PATTERN.test(name)) {
        throw new Error(
          `注册动作名 '${String(name)}' 不合规：必须形如 <namespace>.<verb>（恰好一个点，两段各 ^[a-z][a-z0-9-]{0,29}$，整体最长 61）`,
        )
      }
      if (name.startsWith(RESERVED_ACTION_PREFIX)) {
        throw new Error(`注册动作名 '${name}' 使用保留前缀 '${RESERVED_ACTION_PREFIX}'（防冒名内置能力），不可注册`)
      }
      if (description !== undefined && typeof description !== 'string') {
        throw new Error(`注册动作 '${name}' 的 description 必须是字符串（省略即可）`)
      }
      if (typeof run !== 'function') {
        throw new Error(`注册动作 '${name}' 的 run 必须是函数 run(context): Promise<void>`)
      }
      if (entries.has(name)) {
        // 重名同步抛错（契约 06）：不覆盖；「先 dispose 再注册」由调用方生命周期保证
        throw new Error(`注册动作名 '${name}' 已被注册（重复注册不覆盖；同一存活期内不应重复注册）`)
      }
      const token = Symbol('orchestrator-action-token')
      entries.set(name, { name, ...(description !== undefined ? { description } : {}), run, token })
      let disposed = false
      return () => {
        if (disposed) return // ①幂等
        disposed = true
        // ②同步：返回前完成摘除；③按 token 精确删除：只删自己那次注册
        const current = entries.get(name)
        if (current !== undefined && current.token === token) entries.delete(name)
        // ④实例隔离由闭包内的 entries（每实例一张表）自然保证
      }
    },
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

/** plugin 动作默认超时（契约 05 公共约束：30 秒，可由 timeoutSeconds 覆盖 1–300）。 */
export const DEFAULT_ACTION_TIMEOUT_SECONDS = 30

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
 * @param {object} [deps.sessionHost] 宿主会话服务面（persistent 投递；index.js 由
 *   ctx.sessionController/ctx.sessions/ctx.get('sessionTitle') 装配；缺省时 session 动作
 *   failed internal_error——宿主语义面不可伪造）
 * @param {object} [deps.sessionEnv] session cwd 解析环境 { allowedRoots, defaultCwd, hostCwd, scriptCwd }
 * @param {object} [deps.ephemeralRegistry] ephemeral 生命周期登记器（lib/ephemeral-lifecycle.js
 *   createEphemeralRegistry；投递成功 adopt 启动回收、失败 retain 保留现场；index.js 装配）
 * @param {object} [deps.logger] 内部日志（event_listener_failed 等）
 * @param {{ requested: boolean, controller: AbortController | null }} [deps.cancellation]
 *   dispatching 取消面：runner 持有并在取消时置 requested + abort 当前动作 controller。
 * @param {(result: object) => void} [deps.onActionResult] 每动作结算回调（live overlay 更新）
 * @returns {Promise<{ results: Array<{name,kind,status,error?,warnings?,sessionId?}>, canceled: boolean }>}
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
  sessionHost,
  sessionEnv,
  ephemeralRegistry,
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
    const fail = (code, message, extra) =>
      record({
        name: key,
        kind: definition.kind,
        status: 'failed',
        error: { code, message },
        ...(extra?.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      })

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
      // 超时（契约 05 公共约束）：默认 30 秒，timeoutSeconds 覆盖（1–300，创建期已校验）。
      // 渲染已在执行前完成（不计入超时）；到期先中止 signal（动作实现应收尾），不再等
      // 待其 Promise——串行继续（实现完全无视 signal 时不得挂死整个 run）。
      const timeoutSeconds = definition.timeoutSeconds ?? DEFAULT_ACTION_TIMEOUT_SECONDS
      const timeoutMs = timeoutSeconds * 1000
      let timeoutArmed = null // { promise, timer }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutArmed = { timer: null, promise: null }
        timeoutArmed.promise = new Promise((resolve) => {
          timeoutArmed.timer = setTimeout(() => resolve('timeout'), timeoutMs)
        })
      }
      // 动作实现的执行结果（同步 throw 也归入 reject 分支）；迟到结算由下方吞掉，
      // 不让游离 rejection 外溢（宿主纪律：未捕获 rejection 可能致命）
      const execution = Promise.resolve()
        .then(() =>
          registration.run({
            orchestration: { id: orchestration.id, title: orchestration.title },
            run: { runId: run.runId, status: 'succeeded', trigger: run.trigger },
            payload: renderedPayload ?? null,
            // 中止来源仅两个：动作超时（本处置 abort）与整个 run 被取消（cancellation）；
            // 注册摘除不触发（契约 06）
            signal: controller.signal,
            report: (message) => appendWarning(warnings, String(message)),
          }),
        )
        .then(
          () => 'done',
          (error) => ({ error }),
        )
      let settled
      try {
        settled = await (timeoutArmed === null ? execution : Promise.race([execution, timeoutArmed.promise]))
      } finally {
        if (timeoutArmed?.timer !== null) clearTimeout(timeoutArmed.timer)
        if (cancellation?.controller === controller) cancellation.controller = null
      }
      if (settled === 'timeout') {
        try {
          controller.abort() // 契约 06：动作超时是 signal 的中止来源之一
        } catch {
          /* abort 不应抛；防御 */
        }
        execution.catch(() => {}) // 吞掉迟到的成功/失败（已按 timeout 结算）
        fail('timeout', `plugin 动作 '${key}'（${definition.action}）超过 ${timeoutSeconds} 秒未完成`)
        continue
      }
      if (typeof settled === 'object' && settled !== null && 'error' in settled) {
        fail('action_error', `plugin 动作 '${key}'（${definition.action}）执行失败：${messageOf(settled.error)}`)
        continue
      }
      record({ name: key, kind: 'plugin', status: 'succeeded', ...(warnings.length > 0 ? { warnings } : {}) })
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
      const ephemeral = definition.mode === 'ephemeral'
      if (sessionHost === undefined) {
        // 防御：正常装配（index.js）总会注入；宿主会话服务缺失时不得伪造成功
        fail('internal_error', `session 动作 '${key}' 无法执行：宿主会话服务未注入（sessionHost）`)
        continue
      }
      if (ephemeral && ephemeralRegistry === undefined) {
        // 防御：ephemeral 的生命周期（回收/卸载 teardown）必须可跟踪，否则语义不成立
        fail('internal_error', `session 动作 '${key}' 无法执行：ephemeral 生命周期登记器未注入（ephemeralRegistry）`)
        continue
      }
      try {
        // 两模式共用同一段渲染与首条消息投递（契约 05），只差创建路径与生命周期归属
        const delivered = ephemeral
          ? await deliverEphemeralSession({
              host: sessionHost,
              definition,
              renderedPrompt: renderedPrompt.text,
              orchestration,
              run,
              verdict,
              warnings,
              sessionEnv,
            })
          : {
              ...(await deliverPersistentSession({
                host: sessionHost,
                definition,
                renderedPrompt: renderedPrompt.text,
                orchestration,
                run,
                verdict,
                warnings,
                sessionEnv,
              })),
            }
        if (ephemeral) {
          // 投递成功 → 启动回收生命周期（whenIdle → idleDisposeSeconds → dispose；
          // 缺省 0 = 收敛即回收）。任务由登记表与 disposeAll 跟踪收口。
          ephemeralRegistry.adopt(delivered.handle, delivered.agent, delivered.sessionId, definition.idleDisposeSeconds ?? 0)
        }
        record({
          name: key,
          kind: 'session',
          status: 'succeeded',
          sessionId: delivered.sessionId,
          ...(warnings.length > 0 ? { warnings } : {}),
        })
      } catch (error) {
        // SessionActionError 携带 code ∈ {cwd_not_allowed, preset_unknown, delivery_failed, internal_error}；
        // delivery_failed 时 sessionId 已在 error 上——保留在动作记录（失败现场不回滚）。
        // ephemeral 投递失败的 handle 经 retain 只登记卸载清理，不启动回收计时（契约 05）
        if (error instanceof SessionActionError) {
          if (ephemeral && error.handle !== undefined && ephemeralRegistry !== undefined) {
            ephemeralRegistry.retain(error.handle, error.sessionId)
          }
          fail(error.code, error.message, error)
        } else {
          fail('internal_error', `session 动作 '${key}' 执行失败：${messageOf(error)}`)
        }
      }
      continue
    }

    fail('internal_error', `未知动作 kind '${definition.kind}'（动作 '${key}'）`)
  }

  return { results, canceled: canceled || cancellation?.requested === true }
}
