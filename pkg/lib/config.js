// 脚本编排插件静态配置（同步 Standard Schema）。
// 契约：docs/temp/12-packaging.md（schemastery 自装、同步校验）、
// docs/temp/03-execution.md（maxOutputBytes 262144 / maxSpillBytes 8388608（0 禁用）/
// defaultTimeoutSeconds 300 / allowedRoots）、docs/temp/03「并发与单飞」
//（maxConcurrentRuns 默认 2；排队上限 = maxConcurrentRuns × 4 在 runner 内实现）、
// docs/temp/08-storage.md（maxRunsPerOrchestration 默认 100）。
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  // 每条编排保留最近 run 数（保留裁剪规则之一；全库 1000 上限为固定常量，见 lib/retention.js）
  maxRunsPerOrchestration: z.number().step(1).min(1).max(10000).default(100),
  // 同时运行的 run 上限（契约 03「并发与单飞」：默认 2，超出排队）
  maxConcurrentRuns: z.number().step(1).min(1).max(64).default(2),
  // 脚本超时缺省（script.timeoutSeconds 缺省时使用；1–86400 与契约 03 定义字段一致）
  defaultTimeoutSeconds: z.number().step(1).min(1).max(86400).default(300),
  // 每条输出流的内存收集上限（字节；溢写与 truncated 判定见契约 03「输出收集」）
  maxOutputBytes: z.number().step(1).min(1).max(67108864).default(262144),
  // 每条输出流的溢写文件上限（字节；0 禁用溢写，仅内存尾部）
  maxSpillBytes: z.number().step(1).min(0).max(1073741824).default(8388608),
  // cwd 允许根（空数组 = 不限制；插件首次激活时记一条警告，见 lib/index.js 与契约 03）
  allowedRoots: z.array(z.string()).default([]),
  // cwd 解析的第二优先级（script.cwd → defaultCwd → Host 工作目录）；
  // default(undefined) = 可选键：未提供时从结果中省略（类型错仍拒绝）
  defaultCwd: z.string().default(undefined),
})
