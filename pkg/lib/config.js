// 脚本编排插件静态配置（同步 Standard Schema）。
// 契约：docs/temp/12-packaging.md（schemastery 自装、同步校验）、
// docs/temp/08-storage.md（maxRunsPerOrchestration 默认 100）。
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  // 每条编排保留最近 run 数（保留裁剪规则之一；全库 1000 上限为固定常量，见 lib/storage.js）
  maxRunsPerOrchestration: z.number().step(1).min(1).max(10000).default(100),
})
