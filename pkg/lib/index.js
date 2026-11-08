// @local/dsh-script-orchestrator · Host 半侧入口（契约 docs/temp/12-packaging.md）。
// 单包双面：`.` 是本文件（Host 实现），`./client` 是预构建 Web client。
// apply 为 async 生成器：异步初始化由 Fiber 跟踪（失败即 reject，不留半初始化服务
// 或游离异步任务），yield 的注销器按「停生产者（工具与桥）→ 排干服务层队列 →
// domain.close()」顺序卸载（契约 docs/temp/08-storage.md「关闭」）。
import { Config } from './config.js'
import { ServiceQueue } from './fifo.js'
import { openStorage } from './storage.js'
import { createManagementService } from './service.js'
import { createBridgeHandler, mountBridge } from './bridge.js'
import { registerTools } from './tools.js'

export const name = 'script-orchestrator'
export { Config }
export const inject = ['storageDomain', 'connection', 'webServer', 'tools']

export async function* apply(ctx, config) {
  const logger = ctx.logger('script-orchestrator')
  const queue = new ServiceQueue()
  // 初始化失败在 provide 之前抛出：Loader 标记条目失败，不暴露半初始化服务
  const storage = await openStorage({
    openDomain: (spec) => ctx.storageDomain.open(spec),
    logger,
  })
  const service = createManagementService({
    storage,
    queue,
    config,
    now: () => Date.now(),
    // changed 等事件经宿主 emit 发布（契约 06：发布端兜底在服务层 safeEmit）
    emit: (name, payload) => ctx.emit(name, payload),
    logger,
  })
  // 工具：profile 根作用域各注册一次（契约 07；票 25 交付 create/list/view）
  const disposeTools = registerTools({ tools: ctx.tools, service, logger })
  // 桥挂载为独立 channel 的 prefix 路由（rpc.handle 在 0.2.2-rc.1 对第三方不可用，
  // 见 lib/bridge.js mountBridge 注释；浏览器侧契约面不变）
  const disposeBridge = mountBridge({
    connection: ctx.connection,
    webServer: ctx.webServer,
    handler: createBridgeHandler({ service }),
  })
  ctx.provide('scriptOrchestrator', service)
  yield async () => {
    // 先停生产者：工具入口与桥均拒绝/摘除新操作，再排干队列、关域
    disposeTools()
    disposeBridge()
    await queue.close()
    await storage.close()
  }
}
