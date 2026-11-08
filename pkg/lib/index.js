// @local/dsh-script-orchestrator · Host 半侧入口（契约 docs/temp/12-packaging.md）。
// 单包双面：`.` 是本文件（Host 实现），`./client` 是预构建 Web client。
// apply 为 async 生成器：异步初始化由 Fiber 跟踪（失败即 reject，不留半初始化服务
// 或游离异步任务），yield 的注销器按「停生产者（调度器与工具/桥）→ runner 停机
//（在途 run 清进程范围）→ 排干服务层队列 → domain.close()」顺序卸载
//（契约 docs/temp/08-storage.md「关闭」+ docs/temp/03-execution.md）。
import { Config } from './config.js'
import { ServiceQueue } from './fifo.js'
import { openStorage } from './storage.js'
import { createManagementService } from './service.js'
import { createRunner } from './runner.js'
import { createScheduler } from './scheduler.js'
import { createBridgeHandler, mountBridge } from './bridge.js'
import { registerTools } from './tools.js'

export const name = 'script-orchestrator'
export { Config }
export const inject = ['storageDomain', 'connection', 'webServer', 'tools', 'subprocess']

export async function* apply(ctx, config) {
  const logger = ctx.logger('script-orchestrator')
  const queue = new ServiceQueue()
  const emit = (name, payload) => ctx.emit(name, payload)
  // 初始化失败在 provide 之前抛出：Loader 标记条目失败，不暴露半初始化服务
  //（打开后顺带执行启动维护：非终态 run 标 interrupted + fixed-delay 恢复推进）
  const storage = await openStorage({
    openDomain: (spec) => ctx.storageDomain.open(spec),
    logger,
    emit,
    now: () => Date.now(),
  })
  // 执行引擎（runner）拥有 run 生命周期；服务 run / script_run 只经其触发（spec §2）。
  // 结算推进 fixed-delay 计划后由 onOrchestrationMutated 通知调度器重算（scheduler 在
  // 其后创建，经闭包引用；启动前 reschedule 为 no-op 安全）。
  let rescheduleAfterMutation = () => {}
  const runner = createRunner({
    storage,
    queue,
    subprocess: ctx.subprocess,
    config,
    emit,
    now: () => Date.now(),
    logger,
    hostCwd: process.cwd(),
    onOrchestrationMutated: () => rescheduleAfterMutation(),
  })
  const scheduler = createScheduler({
    storage,
    queue,
    runner,
    now: () => Date.now(),
    logger,
    emit,
  })
  // 编排集合持久变更（create/结算推进等）→ 调度器重算单 timer
  const reschedule = () => scheduler.reschedule()
  rescheduleAfterMutation = reschedule
  const service = createManagementService({
    storage,
    queue,
    config,
    now: () => Date.now(),
    emit,
    logger,
    runner,
    onMutation: reschedule,
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
  // 调度器最后启动（此前已提供全部入口；启动即处理过期计划——错过合并见 lib/scheduler.js）
  scheduler.start()
  yield async () => {
    // 先停生产者：调度器（不再触发新自动 run）与工具入口/桥，再停 runner
    //（在途 run 有界等待 + terminate 清进程范围；记录留非终态由下次启动 interrupted 收尾），
    // 最后排干队列、关域（契约 08「关闭」）
    scheduler.stop()
    disposeTools()
    disposeBridge()
    await runner.shutdown()
    await queue.close()
    await storage.close()
  }
}
