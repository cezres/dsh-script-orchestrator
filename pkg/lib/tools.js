// 工具适配层（契约 docs/temp/07-tools.md）：script_create / script_list / script_view。
// 严格 JSON Schema 校验 + 全部映射 script_input_invalid；语义以服务为准（06），工具不自带业务规则。
// 原始 ctx.tools.register 注册（不用 defineTool 简写——其参数校验抛宿主 INVALID_ARGS，
// 破坏单一错误面）；execute 返回 JSON 值，output.render 单块 JSON 文本。
// create 覆盖 every（票 25）与 cron（票 27）；list/view 属票 25；script_run/script_edit 属票 26/28。
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { OrchestratorError } from './errors.js'

/** 宿主校验器 violation 文案 → 契约 details（field + reason）。 */
function violationToDetails(violation) {
  let match = violation.match(/^missing required property "(.*)"$/)
  if (match) return { field: match[1], reason: 'missing' }
  match = violation.match(/^"(.*)" is not a declared property/)
  if (match) return { field: match[1], reason: 'unexpected' }
  match = violation.match(/^"(.*)" must /)
  if (match) return { field: match[1], reason: 'format' }
  return { field: 'arguments', reason: 'format' }
}

const errorValue = (error) =>
  error.details === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, details: error.details }

/** 包装 execute：schema 校验 → 服务调用 → 契约错误值；abort 异常上抛交宿主规范结果。 */
function wrapExecute({ name, parameters, invoke, logger }) {
  return async (args, exec) => {
    try {
      // 严格参数校验：根 additionalProperties:false；缺失/多余/类型错全映射 script_input_invalid
      const violations = validateJsonSchemaValue(parameters, args, '')
      if (violations.length > 0) {
        const details = violationToDetails(violations[0])
        return {
          code: 'script_input_invalid',
          message: `${name} 参数不合法：${violations[0]}`,
          details,
        }
      }
      return await invoke(args, exec)
    } catch (error) {
      if (error instanceof OrchestratorError) return errorValue(error)
      if (exec?.signal?.aborted || error?.name === 'AbortError') throw error
      logger?.error?.(
        `script-orchestrator: internal_error in ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      )
      return { code: 'internal_error', message: `${name} 内部错误：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

// ---------------- JSON Schema（宿主支持子集：type/properties/required/additionalProperties/items/enum/const） ----------------
// 数值范围、字符串长度、键名格式无法在子集内表达，由服务层语义校验兜底（reason: range/too-frequent/format）。

const stringSchema = { type: 'string' }

// trigger 声明 every/cron 两种 kind 的字段全集（additionalProperties:false 拦未声明字段）；
// 每 kind 的判别（kind=cron 时 everySeconds/mode 多余、反之 expression/timeZone 多余）、
// 数值范围与 cron 子集语义全部由服务层校验兜底并给出准确 field/reason/part。
const triggerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['every', 'cron'], description: "触发类型：'every' 间隔或 'cron' 五位表达式" },
    everySeconds: { type: 'integer', description: 'every 专用：间隔秒数，整数且 ≥ 60（下限由服务校验）' },
    mode: { type: 'string', enum: ['fixed-rate', 'fixed-delay'], description: 'every 专用：省略默认 fixed-rate' },
    expression: { type: 'string', description: 'cron 专用：五位表达式 minute hour day-of-month month day-of-week（子集由服务校验）' },
    timeZone: { type: 'string', description: 'cron 专用：显式 IANA 时区名（如 Asia/Shanghai）' },
  },
}

const scriptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: { type: 'string', description: '绝对路径或 PATH 上可解析的裸命令名，不含参数' },
    args: { type: 'array', items: stringSchema, description: '逐项 argv，不经 shell' },
    cwd: stringSchema,
    env: { type: 'object', description: '环境变量覆盖（键 → 字符串值，值类型由服务校验）' },
    stdin: { description: "'ignore' 或 { text: string }（形态由服务校验）" },
    timeoutSeconds: { type: 'integer', description: '1–86400（范围由服务校验）' },
  },
}

const judgeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rules'],
  properties: {
    rules: {
      type: 'array',
      description: '0–32 条，按顺序首匹配生效（条数上限由服务校验）',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['when', 'actions'],
        properties: {
          when: { type: 'object', description: '谓词对象（谓词键与取值形态由服务校验）' },
          actions: { type: 'array', items: stringSchema, description: '动作键，可空数组' },
        },
      },
    },
    fallback: { type: 'array', items: stringSchema, description: '无规则命中时执行的动作键' },
  },
}

const createParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'trigger', 'script', 'judge', 'actions'],
  properties: {
    id: { type: 'string', description: '^[a-z0-9][a-z0-9-]{0,63}$，可省略（由标题生成并保证唯一）' },
    title: { type: 'string', description: '1–120 字符（去首尾空白后，长度由服务校验）' },
    enabled: { type: 'boolean', description: '默认 true；false 等同暂停' },
    overlap: { type: 'string', enum: ['skip', 'queue'], description: '默认 skip' },
    trigger: triggerSchema,
    script: scriptSchema,
    judge: judgeSchema,
    actions: { type: 'object', description: '动作键 → 动作定义（event/plugin/session；键与定义由服务校验）' },
  },
}

const listParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    active: { type: 'boolean', description: 'true → active；false → paused/ended；省略 → 全部' },
    limit: { type: 'integer', description: '1–500，默认 100（范围由服务校验）' },
    offset: { type: 'integer', description: '非负整数（由服务校验）' },
  },
}

const viewParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', description: '编排 id' },
    runs: { type: 'integer', description: '返回最近执行记录条数，0–50，默认 5（由服务校验）' },
  },
}

// ---------------- output schema（oneOf：成功形状 + 每个契约错误形状，分支互斥） ----------------

/** OrchestrationView 顶层不变量（深层配置对象不做形状重复，事实源在服务层）。 */
const orchestrationViewProperties = {
  id: stringSchema,
  title: stringSchema,
  enabled: { type: 'boolean' },
  overlap: { type: 'string', enum: ['skip', 'queue'] },
  trigger: { type: 'object' },
  script: { type: 'object' },
  judge: { type: 'object' },
  actions: { type: 'object' },
  createdAt: stringSchema,
  updatedAt: stringSchema,
  status: { type: 'string', enum: ['active', 'paused', 'ended'] },
  nextOccurrence: { oneOf: [stringSchema, { type: 'null' }] },
}

const errorBranch = (code) => ({
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    // 宿主子集要求 const 必须搭配标量 type（无 type 的 const 不被求值）
    code: { type: 'string', const: code },
    message: stringSchema,
    details: { type: 'object' },
  },
})

const createOutputSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(orchestrationViewProperties),
      properties: orchestrationViewProperties,
    },
    errorBranch('script_input_invalid'),
    errorBranch('internal_error'),
  ],
}

const listOutputSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'total', 'nextOffset'],
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        total: { type: 'integer' },
        nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      },
    },
    errorBranch('script_input_invalid'),
    errorBranch('internal_error'),
  ],
}

const viewOutputSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: [...Object.keys(orchestrationViewProperties), 'runs', 'availableActions'],
      properties: {
        ...orchestrationViewProperties,
        runs: { type: 'array', items: { type: 'object' } },
        availableActions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: { name: stringSchema, description: stringSchema },
          },
        },
      },
    },
    errorBranch('script_input_invalid'),
    errorBranch('script_unknown'),
    errorBranch('internal_error'),
  ],
}

/**
 * 建三个工具定义（供 registerTools 与测试直接消费）。
 * @param {object} deps
 * @param {object} deps.service 管理服务（ctx.scriptOrchestrator 实现面）
 * @param {object} [deps.logger] 内部日志
 */
export function createToolDefinitions({ service, logger }) {
  return [
    {
      name: 'script_create',
      description:
        '新建脚本编排：定时运行脚本，按判定规则执行动作（event/plugin/session）。触发支持 every（everySeconds ≥ 60，fixed-rate/fixed-delay）或 cron（五位表达式 + 显式 IANA 时区，如 { "kind": "cron", "expression": "0 3 * * *", "timeZone": "Asia/Shanghai" }；每日/每周等预设也生成 cron）。返回完整 OrchestrationView。',
      parameters: createParameters,
      output: { schema: createOutputSchema, render },
      execute: wrapExecute({
        name: 'script_create',
        parameters: createParameters,
        logger,
        // actorSessionId 自动取 exec.agent?.session（契约 07 分层总则第 4 条）
        invoke: (args, exec) => {
          const actorSessionId = typeof exec?.agent?.session === 'string' ? exec.agent.session : undefined
          return service.create(args, actorSessionId, exec?.signal)
        },
      }),
    },
    {
      name: 'script_list',
      description: '分页列出脚本编排（active 过滤；默认 limit=100）。返回 { items, total, nextOffset }。',
      parameters: listParameters,
      output: { schema: listOutputSchema, render },
      // list/view 不带 signal（服务签名如此，契约 07 分层总则第 5 条）
      execute: wrapExecute({ name: 'script_list', parameters: listParameters, logger, invoke: (args) => service.list(args) }),
    },
    {
      name: 'script_view',
      description:
        '查看单个编排详情：完整 OrchestrationView + 最近 runs（默认 5，最多 50）+ availableActions（注册动作表快照，供核对拼写）。',
      parameters: viewParameters,
      output: { schema: viewOutputSchema, render },
      execute: wrapExecute({
        name: 'script_view',
        parameters: viewParameters,
        logger,
        invoke: (args) => service.view(args.id, 'runs' in args ? { runs: args.runs } : {}),
      }),
    },
  ]
}

/**
 * 把工具注册进宿主（profile 根作用域各一次）。
 * @param {object} deps
 * @param {object} deps.tools 宿主 tools 服务（ctx.tools）
 * @param {object} deps.service 管理服务
 * @param {object} [deps.logger] 内部日志
 * @returns {() => void} disposer（逆序注销全部工具）
 */
export function registerTools({ tools, service, logger }) {
  const disposers = createToolDefinitions({ service, logger })
    .map((definition) => tools.register(definition))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
