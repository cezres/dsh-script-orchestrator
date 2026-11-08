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

const runSchema = z.object({ runId: z.string() }).passthrough()

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
 */
export async function openStorage({ openDomain, logger }) {
  const domain = await openDomain(domainSpec)
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
  return {
    domain,
    table: (name) => domain.table(name),
    close: () => domain.close(),
  }
}
