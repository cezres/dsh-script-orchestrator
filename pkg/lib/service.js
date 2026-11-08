// 管理服务（ctx.scriptOrchestrator 的实现面，契约 docs/temp/06-events-service.md）。
// 票 24 骨架：只实现 list；create/view/edit/run/listActions/registerAction 属后续票
//（spec §3 步骤 6 与票 25–33）。
/**
 * 建管理服务。
 * @param {object} deps
 * @param {object} deps.storage openStorage() 的返回值（内存读视图）
 * @param {object} deps.queue ServiceQueue（一切持久写入的复合槽位；list 只读不占槽）
 * @param {object} deps.config 已验证的插件配置
 */
export function createManagementService({ storage, queue, config }) {
  void queue
  void config
  return {
    /** 分页列出编排；active 过滤 + nextOffset 语义见契约 06 ListQuery/ListResult。 */
    async list(query = {}) {
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
  }
}
