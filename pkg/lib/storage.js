// 存储域：声明（契约 docs/temp/08-storage.md）+ 打开/关闭生命周期。
// 票 24 骨架：per-record 域打开、逐条「表键 = 记录内 id/runId」校验、关闭；
// 启动维护（interrupted 标记、孤儿清理、保留对账）与完整记录 schema 属后续票。
// 记录 schema 用 zod（dsh-storage-domain 的 domainTable 约定 valueSchema.parse/raw
// 归一化，schemastery 无 .parse 会把全部记录误判为坏记录）；插件静态 Config 仍用
// schemastery（同步 Standard Schema），二者分工见 docs/temp/12-packaging.md。
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

// 全库 run 上限（契约 08「保留与裁剪」表：固定值，不是配置）
export const MAX_TOTAL_RUNS = 1000

// 记录 schema：票 24 为最小骨架（键校验所需字段 + passthrough 保真现存字段）；
// 票 25+ 引入完整字段与静态校验时收紧。
const orchestrationSchema = z.object({ id: z.string() }).passthrough()
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
