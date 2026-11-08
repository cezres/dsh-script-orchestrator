// 存储域：声明（契约 docs/temp/08-storage.md）+ 打开/关闭生命周期。
// 打开后逐条「表键 = 记录内 id/runId」校验；启动维护（interrupted 标记、孤儿清理、
// 保留对账）属票 26/35。
// 记录 schema 用 zod（dsh-storage-domain 的 domainTable 约定 valueSchema.parse/raw
// 归一化，schemastery 无 .parse 会把全部记录误判为坏记录）；插件静态 Config 仍用
// schemastery（同步 Standard Schema），二者分工见 docs/temp/12-packaging.md。
// 票 25 起编排记录按实际形状收紧（strict）；runs 表保持最小骨架，完整 run 形状
// 随票 26 两写落地时收紧。
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { ID_PATTERN } from './validation.js'

// 全库 run 上限（契约 08「保留与裁剪」表：固定值，不是配置）
export const MAX_TOTAL_RUNS = 1000

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
    status: z.enum(['succeeded', 'failed']),
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
 * 等价行为 = 持久移除；见票 24 Comments。）
 *
 * 打开后执行启动维护（契约 03「重启与崩溃」+ 08「启动维护」①）：
 * 非终态 run 统一标 interrupted（维护写不计入「只写两次」）、各发一条
 * run-settled(interrupted)、不自动重放；fixed-delay 编排的自动 run 以恢复结算时刻
 * 推进序列（不额外立即补跑，契约 02「重启与错过的触发」）。孤儿清理与保留对账属票 35。
 *
 * @param {object} deps
 * @param {(spec: object) => Promise<object>} deps.openDomain ctx.storageDomain.open
 * @param {object} [deps.logger]
 * @param {(name: string, payload?: unknown) => void} [deps.emit] 事件发布（run-settled/changed）
 * @param {() => number} [deps.now] 时钟注入（interrupted 的 settledAt 用恢复时刻）
 */
export async function openStorage({ openDomain, logger, emit, now }) {
  const domain = await openDomain(domainSpec)
  const publish = emit ?? (() => {})
  const currentTime = now ?? (() => Date.now())
  for (const [tableName, keyField] of Object.entries(KEY_FIELD)) {
    const table = domain.table(tableName)
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
  await reconcileStartupRuns({ domain, logger, emit: publish, now: currentTime })
  return {
    domain,
    table: (name) => domain.table(name),
    close: () => domain.close(),
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
