// 管理服务（ctx.scriptOrchestrator 的实现面，契约 docs/temp/06-events-service.md）。
// 语义唯一权威：校验规则、错误码、分页过滤都在此定义一次；工具（07）与桥（11）是薄适配层。
// 票 25 范围：create（every）/list/view/listActions；edit/run/registerAction 属票 28/26/31。
// 一切持久写入经服务层 FIFO 整槽（契约 08「写入」）；changed 在持久写入完成后发布（契约 06）。
import { OrchestratorError, inputInvalid } from './errors.js'
import { validateOrchestrationInput } from './validation.js'
import { nextOccurrence } from './triggers.js'

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
 */
export function createManagementService({ storage, queue, config, now, emit, logger, runner }) {
  void config
  const currentTime = now ?? (() => Date.now())
  const publish = emit ?? (() => {})
  const log = logger ?? console

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

  // 注册动作表（票 31 才开放 registerAction；listActions 已按契约返回排序快照）
  const actionRegistry = new Map()

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
        // 持久写入完成（内存视图已更新）后才发布（契约 06 回读一致性）
        safeEmit('script-orchestrator/changed')
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
      return [...actionRegistry.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, description }) =>
        description === undefined ? { name } : { name, description },
      )
    },
  }
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
