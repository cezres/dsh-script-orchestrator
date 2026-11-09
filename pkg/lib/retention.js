// 保留裁剪（契约 docs/temp/08-storage.md「保留与裁剪」）。
//
// 裁剪时机：run 结算写入后，在同一个服务槽位内顺带执行（runner.settle/settleSkip
// 已在服务层 FIFO 的槽内，写入域表后立即调用本策略；不另起定时器，不做定期清理）。
// 淘汰对象：已结算 run 中超出「每编排 maxRunsPerOrchestration」或「全库 1000」的最旧者；
// 未结算 run（settledAt: null）不计入淘汰、不可被裁剪删除。
// 淘汰次序：settledAt 升序（ISO UTC 字符串字典序即时间序），并列按 runId 字典序。
// 执行方式：目标键 =「每编排超限 ∪ 全库超限」去重后一次 deleteMany；失败容忍暂时超限，
// 由后续结算写入与启动对账收敛（票 35）。被裁 run 的溢写文件 best-effort unlink
// （契约 03「输出收集」spill 注记）；删除记录与文件清理的失败均只记内部日志。
export const MAX_TOTAL_RUNS = 1000

/**
 * 建保留裁剪策略。
 * @param {object} deps
 * @param {object} deps.storage openStorage() 的返回值（内存读视图；runs 表 entries/get/delete/deleteMany）
 * @param {object} [deps.config] 已验证的插件配置（maxRunsPerOrchestration 默认 100）
 * @param {object} [deps.fs] { unlink }（被裁 run 的溢写文件 best-effort 清理；缺省不清理）
 * @param {object} [deps.logger] 内部日志
 * @param {number} [deps.maxTotalRuns] 全库 run 上限（默认契约值 1000；测试注入）
 */
export function createRetentionPolicy({ storage, config, fs, logger, maxTotalRuns = MAX_TOTAL_RUNS }) {
  const log = logger ?? console
  const perOrchestration = config?.maxRunsPerOrchestration ?? 100

  /** 域表 deleteMany 优先；fake/旧域无该面时逐键删除（与 service.deleteRunRecords 同策略）。 */
  async function removeRuns(table, runIds) {
    if (typeof table.deleteMany === 'function') return table.deleteMany(runIds)
    for (const runId of runIds) await table.delete(runId)
  }

  return {
    /**
     * 重算并裁剪。永不抛出（裁剪失败只容忍暂时超限）。
     * @returns {Promise<{ removed: string[] }>} 被删 runId（测试/诊断用）
     */
    async enforce() {
      try {
        const table = storage.table('runs')
        const all = [...table.entries()].map(([runId, run]) => ({ runId, run }))
        const settled = all.filter(({ run }) => run?.settledAt !== null && run?.settledAt !== undefined)
        if (settled.length === 0) return { removed: [] }

        // 次序：settledAt 升序，并列按 runId 字典序
        settled.sort((a, b) => {
          if (a.run.settledAt < b.run.settledAt) return -1
          if (a.run.settledAt > b.run.settledAt) return 1
          if (a.runId < b.runId) return -1
          if (a.runId > b.runId) return 1
          return 0
        })

        const evict = new Set()

        // ① 每编排超限：淘汰该编排最旧的 settled run
        const byOrchestration = new Map()
        for (const entry of settled) {
          const key = entry.run.orchestrationId
          const group = byOrchestration.get(key)
          if (group === undefined) byOrchestration.set(key, [entry])
          else group.push(entry)
        }
        for (const group of byOrchestration.values()) {
          const excess = group.length - perOrchestration
          for (let index = 0; index < excess; index++) evict.add(group[index].runId)
        }

        // ② 全库超限：未结算 run 计入总数但不可淘汰；只从 settled 头部继续淘汰
        const total = all.length
        for (const entry of settled) {
          if (total - evict.size <= maxTotalRuns) break
          if (!evict.has(entry.runId)) evict.add(entry.runId)
        }

        const runIds = [...evict]
        if (runIds.length === 0) return { removed: [] }

        // 被裁 run 的溢写文件：先取路径（删除后记录没了），再删记录，最后 best-effort unlink
        const spillPaths = []
        for (const runId of runIds) {
          const run = table.get(runId)
          const script = run?.script ?? {}
          if (typeof script.stdoutSpillPath === 'string') spillPaths.push(script.stdoutSpillPath)
          if (typeof script.stderrSpillPath === 'string') spillPaths.push(script.stderrSpillPath)
        }
        await removeRuns(table, runIds)
        for (const spillPath of spillPaths) {
          try {
            await fs?.unlink?.(spillPath)
          } catch {
            // best-effort：文件清理失败不影响记录删除（契约 03）
          }
        }
        return { removed: runIds }
      } catch (error) {
        // 失败容忍：暂时超限由后续结算写入与启动对账收敛（契约 08）
        log.error?.(
          `script-orchestrator: 保留裁剪失败（容忍暂时超限）: ${error instanceof Error ? error.message : String(error)}`,
        )
        return { removed: [] }
      }
    },
  }
}
