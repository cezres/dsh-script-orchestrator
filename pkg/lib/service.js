// 管理服务（ctx.scriptOrchestrator 的实现面，契约 docs/temp/06-events-service.md）。
// 语义唯一权威：校验规则、错误码、分页过滤都在此定义一次；工具（07）与桥（11）是薄适配层。
// 票 25 范围：create（every）/list/view/listActions；edit/run/registerAction 属票 28/26/31。
// 一切持久写入经服务层 FIFO 整槽（契约 08「写入」）；changed 在持久写入完成后发布（契约 06）。
// 票 30：动作注册表可与 runner 共享同一实例（index.js 装配）——listActions 取快照、
// runner 逐动作实时查表用同一张表；registerAction 的注册面属票 31。
import { OrchestratorError, inputInvalid, isPlainObject } from './errors.js'
import { validateOrchestrationInput } from './validation.js'
import { nextOccurrence } from './triggers.js'
import { createActionRegistry } from './actions.js'

/** 键排序的稳定 JSON（调度字段变化的深比较；配置对象均为可序列化 JSON 值）。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const iso = (ms) => new Date(ms).toISOString()

/** 由标题生成 id 基名（01：创建时可省略 id，由标题生成并保证唯一）。 */
function slugifyTitle(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  return slug || 'orchestration'
}

/**
 * 建管理服务。
 * @param {object} deps
 * @param {object} deps.storage openStorage() 的返回值（内存读视图）
 * @param {object} deps.queue ServiceQueue（一切持久写入的复合槽位；只读操作不占槽）
 * @param {object} deps.config 已验证的插件配置
 * @param {() => number} [deps.now] 时钟注入（默认 Date.now；测试定锚）
 * @param {(name: string, payload?: unknown) => void} [deps.emit] 事件发布（默认 no-op）
 * @param {object} [deps.logger] 内部日志（发布端兜底等）
 * @param {object} [deps.runner] 执行引擎（liveView 合并活动 run 的内存态到 view）
 * @param {() => void} [deps.onMutation] 编排集合持久变更后的回调（调度器重算 timer）
 * @param {object} [deps.actionRegistry] 动作注册表（缺省自建；与 runner 共享同一实例时
 *   listActions 快照与执行期查表同源，契约 06 listActions/registerAction；注册面属票 31）
 */
export function createManagementService({ storage, queue, config, now, emit, logger, runner, onMutation, actionRegistry }) {
  void config
  const currentTime = now ?? (() => Date.now())
  const publish = emit ?? (() => {})
  const log = logger ?? console
  const registry = actionRegistry ?? createActionRegistry()

  // 发布端兜底（契约 06：listener 同步抛错只记内部日志，绝不影响主流程）
  function safeEmit(name, payload) {
    try {
      publish(name, payload)
    } catch (error) {
      log.error?.(
        `script-orchestrator: event_listener_failed ${name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // 注册动作表（共享实例时与 runner 查表同源；registerAction 注册面属票 31）
  const notifyMutation = onMutation ?? (() => {})

  return {
    /** 新建编排：校验 → 生成 id → 落库 → 计算 nextOccurrence → 发 changed（全部在 FIFO 单槽内）。 */
    async create(input, _actorSessionId, signal) {
      return queue.enqueue(async () => {
        signal?.throwIfAborted()
        // 校验在落库前完成：任一不通过则不写入任何记录（契约 07 script_create）
        const normalized = validateOrchestrationInput(input)
        const orchestrations = storage.table('orchestrations')

        // id 唯一性在同一槽内判定，避免并发创建竞态
        const taken = (candidate) => orchestrations.get(candidate) !== undefined
        let id
        if (normalized.id !== undefined) {
          if (taken(normalized.id)) {
            throw inputInvalid('id', 'taken', `id '${normalized.id}' 已存在`)
          }
          id = normalized.id
        } else {
          const base = slugifyTitle(normalized.title)
          id = base
          for (let suffix = 2; taken(id); suffix += 1) {
            id = `${base}-${suffix}`.slice(0, 64)
          }
        }

        const createdAtMs = currentTime()
        const createdAt = new Date(createdAtMs).toISOString()
        // 契约 02「cron 子集」：创建/更新时从校验参考时刻起 5 年内无任何有效计划时刻 → 拒绝，
        // 不写入立即 ended 的编排（错误 reason: no-occurrence）；与 enabled 无关（配置永不有效）。
        if (normalized.trigger.kind === 'cron' && nextOccurrence(normalized.trigger, createdAtMs) === null) {
          throw inputInvalid(
            'trigger.expression',
            'no-occurrence',
            'cron 表达式在创建时刻起的 5 年内没有任何有效计划时刻',
          )
        }
        // 契约 02「创建」：enabled:false → paused、nextOccurrence = null；
        // 两种 every 模式首次计划均为 createdAt + everySeconds，不立即执行。
        const status = normalized.enabled ? 'active' : 'paused'
        const nextMs = status === 'active' ? nextOccurrence(normalized.trigger, createdAtMs) : null
        const record = {
          id,
          title: normalized.title,
          enabled: normalized.enabled,
          overlap: normalized.overlap,
          trigger: normalized.trigger,
          script: normalized.script,
          judge: normalized.judge,
          actions: normalized.actions,
          createdAt,
          updatedAt: createdAt,
          status,
          nextOccurrence: nextMs === null ? null : new Date(nextMs).toISOString(),
        }
        await orchestrations.put(id, record)
        // 持久写入完成（内存视图已更新）后才发布（契约 06 回读一致性）；
        // 编排集合变更 → 调度器重算单 timer
        safeEmit('script-orchestrator/changed')
        notifyMutation()
        return record
      })
    },

    /** 分页列出编排；active 过滤 + nextOffset 语义见契约 06 ListQuery/ListResult。 */
    async list(query = {}) {
      validateListQuery(query)
      const all = [...storage.table('orchestrations').entries()]
        .map(([, record]) => record)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const filtered =
        query.active === undefined
          ? all
          : all.filter((o) =>
              query.active ? o.status === 'active' : o.status === 'paused' || o.status === 'ended',
            )
      const offset = query.offset ?? 0
      const limit = query.limit ?? 100
      const items = filtered.slice(offset, offset + limit)
      const next = offset + items.length
      return {
        items,
        total: filtered.length,
        nextOffset: next < filtered.length ? next : null,
      }
    },

    /** 单条详情 + 最近 runs（默认 5，最多 50）+ availableActions（注册动作表快照）。 */
    async view(id, options = {}) {
      validateViewOptions(id, options)
      const record = storage.table('orchestrations').get(id)
      if (record === undefined) {
        throw new OrchestratorError('script_unknown', `编排 '${id}' 不存在`, { id })
      }
      const runs = [...storage.table('runs').entries()]
        .map(([, run]) => run)
        .filter((run) => run.orchestrationId === id)
        .map((run) => {
          // 合并执行引擎的活动视图：running/judging/dispatching 等内存态实时可见
          //（中途状态不落盘，契约 08「只写两次」；结算后 live 视图移除、回落持久记录）
          const overlay = runner?.liveView?.(run.runId)
          return overlay === undefined ? run : { ...run, ...overlay }
        })
        .sort((a, b) => String(b.scheduledAt).localeCompare(String(a.scheduledAt)) || String(b.runId).localeCompare(String(a.runId)))
        .slice(0, options.runs ?? 5)
      return { ...record, runs, availableActions: this.listActions() }
    },

    /** 注册动作表快照，按 name 排序（契约 06）。 */
    listActions() {
      return registry.snapshot()
    },

    /**
     * 管理动作（契约 06/07 EditInput）：update / pause / resume（delete 属票 29）。
     * 一切在 FIFO 单槽内：CAS → 动作分派 → 持久写入 → changed（持久写入完成后）。
     */
    async edit(input, _actorSessionId, signal) {
      return queue.enqueue(async () => {
        signal?.throwIfAborted()
        const { id, action, patch } = validateEditInput(input)
        const orchestrations = storage.table('orchestrations')
        const current = orchestrations.get(id)
        if (current === undefined) {
          throw new OrchestratorError('script_unknown', `编排 '${id}' 不存在`, { id })
        }
        // 乐观并发（契约 06/09）：expectedUpdatedAt 对各 action 均可选；null = 此前没有
        // 更新时间（本域记录恒有 updatedAt，故 null 恒冲突——防御面等价）；不匹配 → script_conflict
        if ('expectedUpdatedAt' in input && input.expectedUpdatedAt !== undefined) {
          const expected = input.expectedUpdatedAt
          if (expected !== current.updatedAt) {
            throw new OrchestratorError('script_conflict', `编排 '${id}' 已被其他修改（乐观并发冲突）`, {
              expected: expected ?? null,
              actual: current.updatedAt ?? null,
            })
          }
        }
        if (action === 'delete') {
          // 契约定义了 delete（取消级联删除），实现按票序属票 29：给出准确的暂不支持错误
          throw inputInvalid('action', 'unsupported-part', 'delete 动作尚未实现（票 29 交付）')
        }
        if (action === 'pause') {
          // 状态设置语义（契约 09）：仅从 active 生效；其余状态幂等 no-op（不改任何计时、不写库）
          if (current.status !== 'active') return current
          const updated = {
            ...current,
            status: 'paused',
            nextOccurrence: null,
            updatedAt: iso(currentTime()),
          }
          await orchestrations.put(id, updated)
          safeEmit('script-orchestrator/changed')
          notifyMutation()
          return updated
        }
        if (action === 'resume') {
          // 状态设置语义（契约 09）：仅从 paused 生效；active/ended 幂等 no-op（不重锚、不写库）
          if (current.status !== 'paused') return current
          // 契约 02「恢复」表：不补暂停期——cron 取严格晚于 resumedAt 的下一匹配，
          // fixed-rate 从 resumedAt 加间隔，fixed-delay 视未结算旧自动 run 决定锚定或等待。
          // 运行期意外无解（含 5 年窗口外）→ ended 防御终态。
          const resumedMs = currentTime()
          const hasUnsettledAutoRun = hasUnsettledAutomaticRun(storage.table('runs'), id)
          const waitingForOldRun =
            hasUnsettledAutoRun && current.trigger.kind === 'every' && current.trigger.mode === 'fixed-delay'
          const nextMs = waitingForOldRun ? null : nextOccurrence(current.trigger, resumedMs)
          const updated = {
            ...current,
            status: nextMs === null && !waitingForOldRun ? 'ended' : 'active',
            nextOccurrence: nextMs === null ? null : iso(nextMs),
            updatedAt: iso(resumedMs),
          }
          await orchestrations.put(id, updated)
          safeEmit('script-orchestrator/changed')
          notifyMutation()
          return updated
        }
        // action === 'update'
        return applyUpdate({
          storage,
          current,
          patch,
          nowMs: currentTime(),
          safeEmit,
          notifyMutation,
        })
      })
    },
  }
}

/**
 * update 的合并校验与持久化（契约 02「编辑」+ 07）。非调度编辑不重锚；调度字段变化按
 * 编辑表重建；enabled 走暂停/恢复规则；ended 可经重算触发复活为 active。
 * @param {object} deps.storage openStorage() 的返回值（读写 orchestrations/runs 表）
 */
async function applyUpdate({ storage, current, patch, nowMs, safeEmit, notifyMutation }) {
  if ('id' in patch && patch.id !== undefined && patch.id !== current.id) {
    throw inputInvalid('patch.id', 'unexpected', `id 不可修改（当前 '${current.id}'）`)
  }
  // patch 与当前值合并成完整 OrchestrationInput 再走 create 同源校验（enabled/overlap
  // 必须显式携带当前值：校验器的默认值会覆盖未给出的字段）
  const merged = {
    title: patch.title ?? current.title,
    trigger: patch.trigger ?? current.trigger,
    script: patch.script ?? current.script,
    judge: patch.judge ?? current.judge,
    actions: patch.actions ?? current.actions,
    overlap: patch.overlap ?? current.overlap,
    enabled: patch.enabled ?? current.enabled,
  }
  const normalized = validateOrchestrationInput(merged)
  const schedulingChanged = stableStringify(normalized.trigger) !== stableStringify(current.trigger)
  const enabledChanged = 'enabled' in patch && patch.enabled !== undefined && patch.enabled !== current.enabled

  const updatedAt = iso(nowMs)
  let status = current.status
  let nextIso = current.nextOccurrence

  if (enabledChanged && patch.enabled === false) {
    // 修改 enabled 走暂停/恢复规则（契约 02「编辑」）：false = 暂停（任何原状态）
    status = 'paused'
    nextIso = null
  } else if (schedulingChanged || (enabledChanged && patch.enabled === true && current.status !== 'active')) {
    // 调度字段变化 → 编辑表重建；enabled:true 对非 active 编排 = 恢复语义（恢复表与编辑表
    // 在「无未结算旧自动 run」时同一锚点 now）；ended 可经重算触发复活为 active（契约 07）
    const hasUnsettledAutoRun = hasUnsettledAutomaticRun(storage.table('runs'), current.id)
    if (hasUnsettledAutoRun && normalized.trigger.kind === 'every' && normalized.trigger.mode === 'fixed-delay') {
      // fixed-delay 旧自动 run 未结算：保持 null，旧 run 结算后按新 everySeconds 推进（编辑代际）
      status = 'active'
      nextIso = null
    } else {
      const nextMs = nextOccurrence(normalized.trigger, nowMs)
      if (nextMs === null) {
        // 更新路径的五年无解拒绝（契约 02「cron 子集」；与 create 同一规则）
        throw inputInvalid(
          'trigger.expression',
          'no-occurrence',
          'cron 表达式在编辑时刻起的 5 年内没有任何有效计划时刻',
        )
      }
      status = 'active'
      nextIso = iso(nextMs)
    }
  }
  // 其余情形（非调度编辑且 enabled 未变/enabled:true 且原已 active）：状态与计划原样保留

  const updated = {
    ...current,
    title: normalized.title,
    overlap: normalized.overlap,
    trigger: normalized.trigger,
    script: normalized.script,
    judge: normalized.judge,
    actions: normalized.actions,
    enabled: normalized.enabled,
    updatedAt,
    status,
    nextOccurrence: nextIso,
  }
  await storage.table('orchestrations').put(current.id, updated)
  safeEmit('script-orchestrator/changed')
  notifyMutation()
  return updated
}

/** 是否存在未结算的旧自动 run（fixed-delay 等待判定；手动 run 不推进序列故不计）。 */
function hasUnsettledAutomaticRun(runs, id) {
  for (const [, run] of runs.entries()) {
    if (run?.orchestrationId === id && run.trigger !== 'manual' && !TERMINAL_RUN_STATUSES.has(run?.status)) {
      return true
    }
  }
  return false
}

/** run 终态集合（与 runner/储层同口径）。 */
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'partial', 'failed', 'skipped', 'canceled', 'interrupted'])

/** EditInput 形状校验（契约 06）。 */
function validateEditInput(input) {
  if (!isPlainObject(input)) throw inputInvalid('input', 'format', 'edit 输入必须是对象')
  const allowed = new Set(['id', 'action', 'patch', 'expectedUpdatedAt'])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw inputInvalid(key, 'unexpected', `edit 不接受字段 '${key}'`)
  }
  if (!('id' in input)) throw inputInvalid('id', 'missing', 'edit 缺少必填字段 id')
  if (typeof input.id !== 'string' || input.id.length === 0) {
    throw inputInvalid('id', 'format', 'id 必须是非空字符串')
  }
  if (!('action' in input)) throw inputInvalid('action', 'missing', 'edit 缺少必填字段 action')
  const action = input.action
  if (!['update', 'pause', 'resume', 'delete'].includes(action)) {
    throw inputInvalid('action', 'format', "action 必须是 'update' | 'pause' | 'resume' | 'delete'")
  }
  if ('patch' in input && input.patch !== undefined) {
    if (action !== 'update') {
      throw inputInvalid('patch', 'unexpected', `patch 仅 action:'update' 接受（当前 '${action}'）`)
    }
    if (!isPlainObject(input.patch)) throw inputInvalid('patch', 'format', 'patch 必须是对象')
    if (Object.keys(input.patch).length === 0) {
      throw inputInvalid('patch', 'format', 'patch 至少包含一个字段')
    }
  } else if (action === 'update') {
    throw inputInvalid('patch', 'missing', "action:'update' 必须给出 patch")
  }
  if (
    'expectedUpdatedAt' in input &&
    input.expectedUpdatedAt !== undefined &&
    input.expectedUpdatedAt !== null &&
    typeof input.expectedUpdatedAt !== 'string'
  ) {
    throw inputInvalid('expectedUpdatedAt', 'format', 'expectedUpdatedAt 必须是 ISO 时间字符串或 null')
  }
  return { id: input.id, action, patch: input.patch }
}

function validateListQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw inputInvalid('query', 'format', 'list 查询必须是对象')
  }
  const allowed = new Set(['active', 'limit', 'offset'])
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) throw inputInvalid(key, 'unexpected', `list 不接受字段 '${key}'`)
  }
  if ('active' in query && typeof query.active !== 'boolean') {
    throw inputInvalid('active', 'format', 'active 必须是布尔值')
  }
  if ('limit' in query && query.limit !== undefined) {
    if (!Number.isInteger(query.limit)) throw inputInvalid('limit', 'format', 'limit 必须是整数')
    if (query.limit < 1 || query.limit > 500) throw inputInvalid('limit', 'range', 'limit 必须在 1–500 之间')
  }
  if ('offset' in query && query.offset !== undefined) {
    if (!Number.isInteger(query.offset)) throw inputInvalid('offset', 'format', 'offset 必须是整数')
    if (query.offset < 0) throw inputInvalid('offset', 'range', 'offset 必须是非负整数')
  }
}

function validateViewOptions(id, options) {
  if (typeof id !== 'string' || id.length === 0) {
    throw inputInvalid('id', 'format', 'id 必须是非空字符串')
  }
  const allowed = new Set(['runs'])
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw inputInvalid(key, 'unexpected', `view 不接受字段 '${key}'`)
  }
  if ('runs' in options && options.runs !== undefined) {
    if (!Number.isInteger(options.runs)) throw inputInvalid('runs', 'format', 'runs 必须是整数')
    if (options.runs < 0 || options.runs > 50) throw inputInvalid('runs', 'range', 'runs 必须在 0–50 之间')
  }
}
