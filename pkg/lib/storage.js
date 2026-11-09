// 存储域：声明（契约 docs/temp/08-storage.md）+ 打开/关闭与写入生命周期。
// 打开后逐条「表键 = 记录内 id/runId」校验，随后执行启动维护三步（interrupted 标记、
// 孤儿清理、保留对账；票 35）。
// 记录 schema 用 zod（dsh-storage-domain 的 domainTable 约定 valueSchema.parse/raw
// 归一化，schemastery 无 .parse 会把全部记录误判为坏记录）；插件静态 Config 仍用
// schemastery（同步 Standard Schema），二者分工见 docs/temp/12-packaging.md。
// 编排记录（票 25 起）与 run 记录（票 26 起）均按实际形状收紧（strict）；写入前用
// 对应 schema 显式 parse（契约 08「写入」，Domain 运行期不复验）。
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { ID_PATTERN } from './validation.js'
import { OrchestratorError } from './errors.js'
import { createRetentionPolicy } from './retention.js'

const jsonValue = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
)

const triggerRecord = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every'), everySeconds: z.number().int().min(60), mode: z.enum(['fixed-rate', 'fixed-delay']) }).strict(),
  // cron 形状在读侧同样接受（域版本 1 的存储契约）；创建路径属票 27
  z.object({ kind: z.literal('cron'), expression: z.string().min(1), timeZone: z.string().min(1) }).strict(),
])

const scriptRecord = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    cwd: z.string().optional(),
    stdin: z.union([z.literal('ignore'), z.object({ text: z.string() }).strict()]).optional(),
    timeoutSeconds: z.number().int().min(1).max(86400).optional(),
  })
  .strict()

const judgeRecord = z
  .object({
    rules: z
      .array(z.object({ when: z.record(z.string(), z.unknown()), actions: z.array(z.string()) }).strict()),
    fallback: z.array(z.string()),
  })
  .strict()

const actionRecord = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), name: z.string().min(1), payload: jsonValue.optional() }).strict(),
  z
    .object({
      kind: z.literal('plugin'),
      action: z.string().min(1),
      payload: jsonValue.optional(),
      timeoutSeconds: z.number().int().min(1).max(300).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('session'),
      mode: z.enum(['persistent', 'ephemeral']).optional(),
      title: z.string().optional(),
      cwd: z.string().optional(),
      preset: z.string().optional(),
      model: z
        .object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() })
        .strict()
        .optional(),
      prompt: z.string(),
      framing: z.enum(['banner', 'plain']).optional(),
      idleDisposeSeconds: z.number().int().min(0).optional(),
    })
    .strict(),
])

// 编排记录 = 契约 01 全部字段 + status + createdAt/updatedAt + nextOccurrence（契约 08）
const orchestrationSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    title: z.string().min(1).max(120),
    enabled: z.boolean(),
    overlap: z.enum(['skip', 'queue']),
    trigger: triggerRecord,
    script: scriptRecord,
    judge: judgeRecord,
    actions: z.record(z.string(), actionRecord),
    createdAt: z.string(),
    updatedAt: z.string(),
    status: z.enum(['active', 'paused', 'ended']),
    nextOccurrence: z.string().nullable(),
  })
  .strict()

// run 记录（契约 08「执行记录」＝契约 01 run 全部字段）。
// 两写形状：queued 创建（startedAt/settledAt = null、空 script 壳）与终态结算
//（含 skipped 的 skipReason / spawn_failed 的 warnings）。可选键：spill 路径与
// warnings 缺省即省略（契约 01「stdoutSpillPath / stderrSpillPath …超 cap 撤回则缺省」）。
const runScriptSchema = z
  .object({
    command: z.string().min(1),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().min(0),
    stdoutTail: z.string(),
    stderrTail: z.string(),
    truncated: z.boolean(),
    stdoutSpillPath: z.string().optional(),
    stderrSpillPath: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict()

const runActionSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(['event', 'plugin', 'session']),
    // skipped：dispatching 取消时未派发的剩余动作（契约 05 status ∈ {succeeded, failed, skipped}）
    status: z.enum(['succeeded', 'failed', 'skipped']),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
    warnings: z.array(z.string()).optional(),
    sessionId: z.string().optional(),
  })
  .strict()

const runSchema = z
  .object({
    runId: z.string().regex(/^run-[0-9a-f]{8}$/),
    orchestrationId: z.string().regex(ID_PATTERN),
    trigger: z.enum(['every', 'cron', 'manual']),
    scheduledAt: z.string(),
    startedAt: z.string().nullable(),
    settledAt: z.string().nullable(),
    status: z.enum([
      'queued',
      'running',
      'judging',
      'dispatching',
      'succeeded',
      'partial',
      'failed',
      'skipped',
      'canceled',
      'interrupted',
    ]),
    skipReason: z.enum(['overlap', 'disabled', 'concurrency']).nullable(),
    script: runScriptSchema,
    matchedRule: z.number().int().nullable(),
    usedFallback: z.boolean(),
    actions: z.array(runActionSchema),
  })
  .strict()

export const domainSpec = defineDomain({
  name: 'script_orchestrator',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    orchestrations: domainTable(orchestrationSchema),
    runs: domainTable(runSchema),
  },
})

/** 每张表的「记录内主键」字段：表键必须与之相等（契约 08「打开」）。 */
const KEY_FIELD = { orchestrations: 'id', runs: 'runId' }

/**
 * 打开存储域：openDomain(domainSpec) → 逐表逐条校验表键 = 记录内 id/runId。
 * 键不一致的记录按坏记录处置（视为不存在）：经 domain 写链删除并记 error 日志。
 * （.bak 备份是宿主 domain 层 schema 校验的实现细节，插件层无 backupRecord 面，
 * 等价行为 = 持久移除；见票 24 Comments。畸形 JSON / 不可读 / 版本不接受文档由宿主
 * 语义静默缺席——它们不会出现在 entries() 中，插件打开照常进行。）
 *
 * 打开后执行启动维护（契约 08「启动维护」三步）：
 * ① 非终态 run 统一标 interrupted（维护写不计入「只写两次」）、各发一条
 * run-settled(interrupted)、不自动重放；fixed-delay 编排的自动 run 以恢复结算时刻
 * 推进序列（不额外立即补跑，契约 02「重启与错过的触发」）；
 * ② 孤儿清理：删除 orchestrationId 无父记录的全部 run（级联删除的崩溃残留，幂等）；
 * ③ 保留对账：按保留规则重算并补裁（票 34 的同一策略；未结算 run 不淘汰）。
 *
 * I/O 结果未知的恢复（契约 08「I/O 结果未知」）：写入 Promise 被拒**不证明磁盘未变**。
 * 处置固定：映射 script_storage_unavailable → 关闭域 → 重新打开读实际状态 →
 * 重建内存视图与调度器（onRecovered 回调触发重算）→ 继续服务；不做盲目重试。
 * 恢复期间到达的管理操作以 script_storage_unavailable 失败。
 *
 * @param {object} deps
 * @param {(spec: object) => Promise<object>} deps.openDomain ctx.storageDomain.open
 * @param {object} [deps.logger]
 * @param {(name: string, payload?: unknown) => void} [deps.emit] 事件发布（run-settled/changed）
 * @param {() => number} [deps.now] 时钟注入（interrupted 的 settledAt 用恢复时刻）
 * @param {object} [deps.config] 已验证配置（启动保留对账用 maxRunsPerOrchestration）
 * @param {object} [deps.fs] { unlink }（保留对账时被裁 run 的溢写文件 best-effort 清理）
 * @param {() => void} [deps.onRecovered] 域重开并重建后回调（调度器重算 timer）
 */
export async function openStorage({ openDomain, logger, emit, now, config, fs, onRecovered }) {
  const publish = emit ?? (() => {})
  const currentTime = now ?? (() => Date.now())
  let domain = await openDomain(domainSpec)
  let recovering = false
  let broken = false

  /** 启动维护三步（首次打开与 I/O 恢复重开共用；幂等）。 */
  async function runStartupMaintenance(target) {
    for (const [tableName, keyField] of Object.entries(KEY_FIELD)) {
      const table = target.table(tableName)
      for (const [key, record] of table.entries()) {
        if (record?.[keyField] !== key) {
          logger?.error?.(
            `script-orchestrator: 表 ${tableName} 记录键 '${key}' 与其 ${keyField} '${String(
              record?.[keyField],
            )}' 不一致，按坏记录处置（移除）`,
          )
          await table.delete(key)
        }
      }
    }
    await reconcileStartupRuns({ domain: target, logger, emit: publish, now: currentTime })
    await cleanupOrphanRuns({ domain: target, logger })
    await reconcileRetention({ domain: target, config, fs, logger })
  }

  /** 恢复期/坏域：读写一律以 script_storage_unavailable 明确失败（不静默返回空视图）。 */
  function ensureAvailable() {
    if (recovering || broken) {
      throw new OrchestratorError(
        'script_storage_unavailable',
        recovering ? '存储域正在恢复（关闭-重开-对账），请稍后重试' : '存储域不可用（重开失败），请检查宿主存储',
        { cause: recovering ? 'recovering' : 'unavailable' },
      )
    }
  }

  function storageUnavailable(error) {
    const cause = error?.code !== undefined ? String(error.code) : error instanceof Error ? error.message : String(error)
    return new OrchestratorError('script_storage_unavailable', `存储写入被拒（${cause}）`, { cause })
  }

  /** 写失败 → 关闭-重开-对账（不盲目重试当前写；当前调用以 script_storage_unavailable 失败）。 */
  function handleWriteFailure(error) {
    logger?.error?.(
      `script-orchestrator: 存储写入被拒（${
        error instanceof Error ? error.message : String(error)
      }），执行关闭-重开-对账恢复（当前写不重试）`,
    )
    if (recovering || broken) return
    recovering = true
    void recover()
  }

  async function recover() {
    try {
      try {
        await domain.close()
      } catch (closeError) {
        logger?.error?.(
          `script-orchestrator: 恢复期间关闭存储域失败（继续重开）: ${
            closeError instanceof Error ? closeError.message : String(closeError)
          }`,
        )
      }
      domain = await openDomain(domainSpec)
      await runStartupMaintenance(domain)
      recovering = false
      logger?.warn?.('script-orchestrator: 存储域已重新打开并完成启动对账，继续服务')
      try {
        onRecovered?.()
      } catch (callbackError) {
        logger?.error?.(
          `script-orchestrator: 恢复后回调失败: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
        )
      }
    } catch (reopenError) {
      broken = true
      recovering = false
      logger?.error?.(
        `script-orchestrator: 存储域重开失败，保持不可用（管理操作将以 script_storage_unavailable 失败）: ${
          reopenError instanceof Error ? reopenError.message : String(reopenError)
        }`,
      )
    }
  }

  function wrapWrite(operation) {
    return async (...args) => {
      ensureAvailable()
      try {
        return await operation(...args)
      } catch (error) {
        handleWriteFailure(error)
        throw storageUnavailable(error)
      }
    }
  }

  /**
   * 写入前显式 schema 校验（契约 08「写入」：写入前由插件用对应 schema 显式 `parse`，
   * Domain 运行期不复验）。正常路径绝不应触发；失败是插件内部不变量被破坏，按
   * `internal_error` 抛出并记 error 日志——**不**走 I/O 恢复（不是存储写入被拒）。
   */
  function assertRecordShape(name, key, value) {
    const schema = domainSpec.tables[name]?.valueSchema
    if (schema === undefined) {
      throw new OrchestratorError('internal_error', `存储表 '${String(name)}' 未在域声明中定义`, { table: name })
    }
    try {
      schema.parse(value)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger?.error?.(
        `script-orchestrator: 存储写入前 schema 校验失败（表 '${name}'，键 '${String(key)}'）: ${reason}`,
      )
      throw new OrchestratorError(
        'internal_error',
        `存储写入前 schema 校验失败（表 '${name}'，键 '${String(key)}'）：${reason}`,
        { table: name, key },
      )
    }
  }

  /** 表门面：读写都作用于「当前 domain」（恢复重开后自动指向新域）。 */
  function table(name) {
    const facade = {
      entries: () => {
        ensureAvailable()
        return domain.table(name).entries()
      },
      get: (key) => {
        ensureAvailable()
        return domain.table(name).get(key)
      },
      put: async (key, value) => {
        // async 包装：恢复期/坏形状的失败以 Promise rejection 表达（与 domain 写语义一致）
        ensureAvailable()
        assertRecordShape(name, key, value)
        return wrapWrite(() => domain.table(name).put(key, value))()
      },
      delete: (key) => wrapWrite(() => domain.table(name).delete(key))(key),
    }
    // deleteMany 可选面：域表有则透传，无则逐键删除
    facade.deleteMany = (ids) =>
      wrapWrite(async () => {
        const target = domain.table(name)
        if (typeof target.deleteMany === 'function') return target.deleteMany(ids)
        for (const id of ids) await target.delete(id)
      })()
    return facade
  }

  await runStartupMaintenance(domain)

  return {
    domain,
    table,
    /** 恢复状态（诊断/测试）：recovering（重开中）或 broken（重开失败）。 */
    isRecovering: () => recovering || broken,
    /** 显式触发恢复（仅供测试；生产路径由写失败自动触发）。 */
    recover,
    close: () => domain.close(),
  }
}

/** 启动维护②：孤儿清理——删除 orchestrationId 无父记录的全部 run（幂等）。 */
async function cleanupOrphanRuns({ domain, logger }) {
  const orchestrations = domain.table('orchestrations')
  const runs = domain.table('runs')
  const parentIds = new Set([...orchestrations.entries()].map(([id]) => id))
  for (const [runId, run] of [...runs.entries()]) {
    if (parentIds.has(run?.orchestrationId)) continue
    logger?.warn?.(
      `script-orchestrator: 启动维护孤儿清理：删除无父 run '${runId}'（orchestrationId '${String(run?.orchestrationId)}'）`,
    )
    await runs.delete(runId)
  }
}

/** 启动维护③：保留对账——按票 34 策略重算并补裁（未结算 run 不淘汰）。 */
async function reconcileRetention({ domain, config, fs, logger }) {
  const policy = createRetentionPolicy({
    storage: { table: (name) => domain.table(name) },
    config,
    fs,
    logger,
  })
  const result = await policy.enforce()
  if (result.removed.length > 0) {
    logger?.warn?.(`script-orchestrator: 启动保留对账补裁 ${result.removed.length} 条 run`)
  }
}

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'partial', 'failed', 'skipped', 'canceled', 'interrupted'])

/** 启动维护①：非终态 run 标 interrupted（各发 run-settled）+ fixed-delay 恢复推进。 */
async function reconcileStartupRuns({ domain, logger, emit, now }) {
  const orchestrations = domain.table('orchestrations')
  const runs = domain.table('runs')
  const resumedMs = now()
  const resumedIso = new Date(resumedMs).toISOString()
  for (const [runId, run] of runs.entries()) {
    if (TERMINAL_RUN_STATUSES.has(run?.status)) continue
    const settled = {
      ...run,
      status: 'interrupted',
      settledAt: resumedIso,
    }
    try {
      await runs.put(runId, settled)
      const orchestration = orchestrations.get(run.orchestrationId)
      if (
        settled.trigger !== 'manual' &&
        orchestration?.status === 'active' &&
        orchestration.trigger?.kind === 'every' &&
        orchestration.trigger.mode === 'fixed-delay'
      ) {
        await orchestrations.put(orchestration.id, {
          ...orchestration,
          nextOccurrence: new Date(resumedMs + orchestration.trigger.everySeconds * 1000).toISOString(),
        })
        safeEmit(emit, logger, 'script-orchestrator/changed')
      }
      safeEmit(emit, logger, 'script-orchestrator/run-settled', {
        runId: settled.runId,
        orchestrationId: settled.orchestrationId,
        status: 'interrupted',
        trigger: settled.trigger,
        scheduledAt: settled.scheduledAt,
        startedAt: settled.startedAt,
        settledAt: settled.settledAt,
        script: {
          exitCode: settled.script?.exitCode ?? null,
          signal: settled.script?.signal ?? null,
          timedOut: settled.script?.timedOut === true,
          durationMs: settled.script?.durationMs ?? 0,
          truncated: settled.script?.truncated === true,
        },
        stdoutTail: settled.script?.stdoutTail ?? '',
        stderrTail: settled.script?.stderrTail ?? '',
        matchedRule: settled.matchedRule ?? null,
        usedFallback: settled.usedFallback === true,
        actions: [],
      })
    } catch (error) {
      logger?.error?.(
        `script-orchestrator: 启动维护标记 interrupted 失败 (${runId}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function safeEmit(emit, logger, name, payload) {
  try {
    emit(name, payload)
  } catch (error) {
    logger?.error?.(
      `script-orchestrator: event_listener_failed ${name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
