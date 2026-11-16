// @echo/dsh-script-orchestrator · Host 半侧入口（契约 docs/temp/12-packaging.md）。
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
import { createActionRegistry } from './actions.js'
import { createEphemeralRegistry } from './ephemeral-lifecycle.js'
import { createRetentionPolicy } from './retention.js'
import { loadSkill } from './skills.js'
import { promises as nodeFs } from 'node:fs'

export const name = 'script-orchestrator'
export { Config }
export const inject = [
  'storageDomain',
  'connection',
  'webServer',
  'tools',
  'skills',
  'subprocess',
  'sessionController',
  'sessions',
  'agents',
  'agentDefaultModel',
]

export async function* apply(ctx, config) {
  const skill = await loadSkill()
  const logger = ctx.logger('script-orchestrator')
  // 契约 03「安全边界」：allowedRoots 为空 = 不限制，首次激活记一条警告（每次应用仅一条）
  if ((config.allowedRoots ?? []).length === 0) {
    logger.warn('script-orchestrator: allowedRoots 未配置，脚本与会话 cwd 不受路径根限制（契约 03）')
  }
  const queue = new ServiceQueue()
  const emit = (name, payload) => ctx.emit(name, payload)
  // 动作注册表：service.listActions 快照与 runner 执行期逐动作实时查表同源
  //（registerAction 注册面属票 31；plugin 动作在注册前查表得 unknown_action）
  const actionRegistry = createActionRegistry()
  // 初始化失败在 provide 之前抛出：Loader 标记条目失败，不暴露半初始化服务
  //（打开后顺带执行启动维护：非终态 run 标 interrupted + fixed-delay 恢复推进）
  const storage = await openStorage({
    openDomain: (spec) => ctx.storageDomain.open(spec),
    logger,
    emit,
    now: () => Date.now(),
    config,
    fs: nodeFs, // 票 35：启动保留对账时被裁 run 的溢写文件 best-effort 清理
    // I/O 结果未知恢复：域重开并重建内存视图后重算调度器单 timer（闭包在 scheduler
    // 创建前为 no-op，恢复只可能发生在运行期→此时已指向真实 reschedule）
    onRecovered: () => rescheduleAfterMutation(),
  })
  // 执行引擎（runner）拥有 run 生命周期；服务 run / script_run 只经其触发（spec §2）。
  // 结算推进 fixed-delay 计划后由 onOrchestrationMutated 通知调度器重算（scheduler 在
  // 其后创建，经闭包引用；启动前 reschedule 为 no-op 安全）。
  let rescheduleAfterMutation = () => {}
  // ephemeral 会话生命周期登记器（票 33）：投递成功 adopt（whenIdle → idleDisposeSeconds
  // → dispose）、失败 retain 保留现场；卸载序列在 runner 停机后 disposeAll 收口
  const ephemeralRegistry = createEphemeralRegistry({ logger })
  // 保留裁剪（票 34；契约 08「保留与裁剪」）：run 结算写入后在 runner 的同一 FIFO 槽内
  // 顺带执行；被裁 run 的溢写文件 best-effort unlink
  const retention = createRetentionPolicy({ storage, config, fs: nodeFs, logger })
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
    registry: actionRegistry,
    // session 动作投递面（契约 05/决策 21；票 32 persistent / 票 33 ephemeral）：
    // persistent 经 sessionController.create()（Host 代 compose 缺省 preset/model）；
    // ephemeral 经 agents.create 自持 handle（agentDefaultModel.currentSelection +
    // agentPresets resolve/mount）；sessionTitle 经 ctx.get 惰性取（可选服务）
    sessionHost: {
      sessionController: ctx.sessionController,
      sessions: ctx.sessions,
      getSessionTitle: () => ctx.get('sessionTitle'),
      agents: ctx.agents,
      agentDefaultModel: ctx.agentDefaultModel,
      getAgentPresets: () => ctx.get('agentPresets'),
    },
    ephemeralRegistry,
    retention,
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
    actionRegistry,
    fs: nodeFs, // 票 34：delete 级联的 spill 清理与 readSpill 读文件
  })
  // 工具：profile 根作用域各注册一次（契约 07；票 25 交付 create/list/view）
  const disposeTools = registerTools({ tools: ctx.tools, service, logger })
  let disposeSkill
  try {
    disposeSkill = ctx.skills.register(skill)
  } catch (error) {
    // 注册发生在 storage 打开之后、scheduler 启动之前；失败时主动撤销已建资源。
    disposeTools()
    await runner.shutdown()
    await ephemeralRegistry.disposeAll()
    await queue.close()
    await storage.close()
    throw error
  }
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
    // 再对 ephemeral 会话做确定性 teardown（票 33：live handle 全量 dispose；宿主
    // owner-fiber teardown 兜底之下显式收口，保证顺序可测），最后排干队列、关域
    //（契约 08「关闭」）
    scheduler.stop()
    disposeSkill()
    disposeTools()
    disposeBridge()
    await runner.shutdown()
    await ephemeralRegistry.disposeAll()
    await queue.close()
    await storage.close()
  }
}
