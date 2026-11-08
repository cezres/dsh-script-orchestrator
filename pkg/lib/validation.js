// OrchestrationInput 校验与归一化（唯一事实源：服务层；契约 docs/temp/01-domain-model.md、
// 02-triggers.md、03-execution.md、04-judge.md、05-actions.md）。
// 工具层与桥只做各自传输层的形状校验（07 / 11），语义规则全部在此定义一次。
// 票 25 范围：trigger 只接受 every；cron 属票 27（在此给出准确的「尚未支持」错误）。
import { inputInvalid, isPlainObject, isLosslessJson } from './errors.js'

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
export const ACTION_KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
export const REGISTERED_ACTION_PATTERN = /^[a-z][a-z0-9-]{0,29}\.[a-z][a-z0-9-]{0,29}$/
export const RESERVED_EVENT_NAMES = new Set(['run-started', 'run-settled', 'action-settled', 'changed'])
export const JSON_PATH_PATTERN = /^\$(\.[A-Za-z0-9_]+|\[\d+\])*$/

const isInteger = (value) => typeof value === 'number' && Number.isInteger(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0

/** 对象只含白名单键（用于 strict 校验：报出第一个多余键）。 */
function firstUnexpectedKey(object, allowed, prefix) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      return inputInvalid(
        prefix ? `${prefix}.${key}` : key,
        'unexpected',
        `字段 '${prefix ? `${prefix}.${key}` : key}' 不被接受`,
      )
    }
  }
  return null
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw inputInvalid(field, 'format', `字段 '${field}' 必须是字符串`)
  if (!allowEmpty && value.length === 0) throw inputInvalid(field, 'format', `字段 '${field}' 不能为空字符串`)
}

// ---------------- trigger ----------------

function validateEveryTrigger(trigger) {
  const unexpected = firstUnexpectedKey(trigger, new Set(['kind', 'everySeconds', 'mode']), 'trigger')
  if (unexpected) throw unexpected
  if (!('everySeconds' in trigger)) {
    throw inputInvalid('trigger.everySeconds', 'missing', "trigger.everySeconds 缺失（every 必须给出间隔秒数）")
  }
  const { everySeconds } = trigger
  if (!isInteger(everySeconds)) {
    throw inputInvalid('trigger.everySeconds', 'format', 'trigger.everySeconds 必须是整数（秒）')
  }
  // 契约 02 硬性下限：相邻两次计划时刻之差不得小于 60 秒，更密输入直接拒绝、不静默节流
  if (everySeconds < 60) {
    throw inputInvalid(
      'trigger.everySeconds',
      'too-frequent',
      `trigger.everySeconds 为 ${everySeconds}，低于 60 秒的硬性下限`,
    )
  }
  let mode = 'fixed-rate'
  if ('mode' in trigger) {
    if (trigger.mode !== 'fixed-rate' && trigger.mode !== 'fixed-delay') {
      throw inputInvalid('trigger.mode', 'format', "trigger.mode 必须是 'fixed-rate' 或 'fixed-delay'")
    }
    mode = trigger.mode
  }
  return { kind: 'every', everySeconds, mode }
}

function validateTrigger(trigger) {
  if (!isPlainObject(trigger)) throw inputInvalid('trigger', 'format', 'trigger 必须是对象')
  if (typeof trigger.kind !== 'string') {
    throw inputInvalid('trigger.kind', 'format', 'trigger.kind 缺失或不是字符串')
  }
  if (trigger.kind === 'every') return validateEveryTrigger(trigger)
  if (trigger.kind === 'cron') {
    // 契约 02 定义了 cron，但实现按票序尚未交付（票 27）：给出准确的暂不支持错误
    throw inputInvalid(
      'trigger.kind',
      'unsupported-part',
      "cron 触发尚未实现（后续票交付）；当前仅接受 kind: 'every'",
    )
  }
  throw inputInvalid('trigger.kind', 'format', `未知的 trigger.kind '${trigger.kind}'（v0.1 仅 every / cron）`)
}

// ---------------- script ----------------

function validateScript(script) {
  if (!isPlainObject(script)) throw inputInvalid('script', 'format', 'script 必须是对象')
  const unexpected = firstUnexpectedKey(
    script,
    new Set(['command', 'args', 'cwd', 'env', 'stdin', 'timeoutSeconds']),
    'script',
  )
  if (unexpected) throw unexpected
  if (!('command' in script)) throw inputInvalid('script.command', 'missing', 'script.command 缺失')
  requireString(script.command, 'script.command')

  if ('args' in script) {
    if (!Array.isArray(script.args)) throw inputInvalid('script.args', 'format', 'script.args 必须是字符串数组')
    script.args.forEach((arg, index) => {
      if (typeof arg !== 'string') {
        throw inputInvalid('script.args', 'format', `script.args[${index}] 必须是字符串（argv 逐项传递、不经 shell）`)
      }
    })
  }
  if ('cwd' in script) requireString(script.cwd, 'script.cwd')

  let { env } = script
  if ('env' in script) {
    if (!isPlainObject(script.env)) throw inputInvalid('script.env', 'format', 'script.env 必须是对象')
    for (const [key, value] of Object.entries(script.env)) {
      if (typeof value !== 'string') {
        throw inputInvalid('script.env', 'format', `script.env['${key}'] 的值必须是字符串`)
      }
    }
  } else {
    env = {}
  }

  if ('stdin' in script && script.stdin !== undefined) {
    if (script.stdin === 'ignore') {
      // 合法
    } else if (isPlainObject(script.stdin)) {
      const keys = Object.keys(script.stdin)
      if (keys.length !== 1 || keys[0] !== 'text') {
        throw inputInvalid('script.stdin', 'unexpected', "script.stdin 只接受 'ignore' 或 { text }")
      }
      requireString(script.stdin.text, 'script.stdin.text')
    } else {
      throw inputInvalid('script.stdin', 'format', "script.stdin 必须是 'ignore' 或 { text: string }")
    }
  }

  if ('timeoutSeconds' in script) {
    const { timeoutSeconds } = script
    if (!isInteger(timeoutSeconds)) throw inputInvalid('script.timeoutSeconds', 'format', 'script.timeoutSeconds 必须是整数')
    if (timeoutSeconds < 1 || timeoutSeconds > 86400) {
      throw inputInvalid('script.timeoutSeconds', 'range', 'script.timeoutSeconds 必须在 1–86400 之间')
    }
  }

  const normalized = { command: script.command, args: script.args ?? [], env }
  if ('cwd' in script) normalized.cwd = script.cwd
  if ('stdin' in script && script.stdin !== undefined) normalized.stdin = script.stdin
  if ('timeoutSeconds' in script) normalized.timeoutSeconds = script.timeoutSeconds
  return normalized
}

// ---------------- judge ----------------

const PREDICATE_KEYS = new Set(['exitCode', 'signal', 'timedOut', 'durationMs', 'stdout', 'stderr', 'all', 'any'])
const STDOUT_KEYS = new Set(['regex', 'flags', 'contains', 'jsonPath', 'equals', 'notEquals', 'truncated'])
const STDERR_KEYS = new Set(['regex', 'flags', 'contains', 'truncated'])

function validatePredicate(predicate, field) {
  if (!isPlainObject(predicate)) throw inputInvalid(field, 'format', `谓词 '${field}' 必须是对象`)
  const keys = Object.keys(predicate)
  if (keys.length === 0) {
    throw inputInvalid(field, 'format', `谓词 '${field}' 必须至少含一个谓词键`)
  }
  for (const key of keys) {
    if (!PREDICATE_KEYS.has(key)) {
      throw inputInvalid(`${field}.${key}`, 'format', `未知谓词键 '${key}'（'${field}'）`)
    }
  }
  const value = predicate
  if ('exitCode' in value) {
    const ec = value.exitCode
    if (typeof ec === 'number') {
      if (!Number.isFinite(ec)) throw inputInvalid(`${field}.exitCode`, 'format', 'exitCode 必须是有限数字')
    } else if (isPlainObject(ec)) {
      const ecKeys = Object.keys(ec)
      if (ecKeys.length === 1 && ecKeys[0] === 'not') {
        if (typeof ec.not !== 'number' || !Number.isFinite(ec.not)) {
          throw inputInvalid(`${field}.exitCode.not`, 'format', 'exitCode.not 必须是数字')
        }
      } else if (ecKeys.length === 1 && ecKeys[0] === 'in') {
        if (!Array.isArray(ec.in) || ec.in.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
          throw inputInvalid(`${field}.exitCode.in`, 'format', 'exitCode.in 必须是数字数组')
        }
      } else if (ecKeys.every((k) => k === 'min' || k === 'max') && ecKeys.length > 0) {
        for (const k of ecKeys) {
          if (typeof ec[k] !== 'number' || !Number.isFinite(ec[k])) {
            throw inputInvalid(`${field}.exitCode.${k}`, 'format', `exitCode.${k} 必须是数字`)
          }
        }
      } else {
        throw inputInvalid(
          `${field}.exitCode`,
          'format',
          'exitCode 取值必须是数字、{ not }、{ in } 或 { min, max }',
        )
      }
    } else {
      throw inputInvalid(`${field}.exitCode`, 'format', 'exitCode 取值必须是数字或对象')
    }
  }
  if ('signal' in value && value.signal !== null && typeof value.signal !== 'string') {
    throw inputInvalid(`${field}.signal`, 'format', 'signal 必须是字符串或 null')
  }
  if ('timedOut' in value && typeof value.timedOut !== 'boolean') {
    throw inputInvalid(`${field}.timedOut`, 'format', 'timedOut 必须是布尔值')
  }
  if ('durationMs' in value) {
    const duration = value.durationMs
    if (!isPlainObject(duration)) {
      throw inputInvalid(`${field}.durationMs`, 'format', 'durationMs 必须是 { min?, max? } 对象')
    }
    const dKeys = Object.keys(duration)
    if (!dKeys.every((k) => k === 'min' || k === 'max') || dKeys.length === 0) {
      throw inputInvalid(`${field}.durationMs`, 'format', 'durationMs 只接受 min/max（至少一个）')
    }
    for (const k of dKeys) {
      if (typeof duration[k] !== 'number' || !Number.isFinite(duration[k])) {
        throw inputInvalid(`${field}.durationMs.${k}`, 'format', `durationMs.${k} 必须是数字`)
      }
    }
  }
  if ('stdout' in value) validateTextPredicate(value.stdout, `${field}.stdout`, STDOUT_KEYS)
  if ('stderr' in value) validateTextPredicate(value.stderr, `${field}.stderr`, STDERR_KEYS)
  if ('all' in value) validatePredicateArray(value.all, `${field}.all`)
  if ('any' in value) validatePredicateArray(value.any, `${field}.any`)
}

function validateTextPredicate(spec, field, allowedKeys) {
  if (!isPlainObject(spec)) throw inputInvalid(field, 'format', `'${field}' 谓词必须是对象`)
  for (const key of Object.keys(spec)) {
    if (!allowedKeys.has(key)) {
      throw inputInvalid(`${field}.${key}`, 'format', `'${field}' 不接受键 '${key}'`)
    }
  }
  if ('flags' in spec) {
    if (typeof spec.flags !== 'string' || [...spec.flags].some((c) => !'ims'.includes(c))) {
      throw inputInvalid(`${field}.flags`, 'format', `'${field}.flags' 只接受 i/m/s 的组合`)
    }
  }
  if ('regex' in spec) {
    requireString(spec.regex, `${field}.regex`)
    try {
      new RegExp(spec.regex, spec.flags ?? '')
    } catch {
      throw inputInvalid(`${field}.regex`, 'format', `'${field}.regex' 不是合法的 JS RegExp（内联开关 (?i) 不支持）`)
    }
  }
  if ('contains' in spec) requireString(spec.contains, `${field}.contains`)
  if ('jsonPath' in spec) {
    requireString(spec.jsonPath, `${field}.jsonPath`)
    if (!JSON_PATH_PATTERN.test(spec.jsonPath)) {
      throw inputInvalid(
        `${field}.jsonPath`,
        'format',
        `'${field}.jsonPath' 只支持极简路径（$ 开头，. 访问属性，[n] 访问下标）`,
      )
    }
  }
  for (const key of ['equals', 'notEquals']) {
    if (key in spec && !isLosslessJson(spec[key])) {
      throw inputInvalid(`${field}.${key}`, 'format', `'${field}.${key}' 必须是合法 JSON 值`)
    }
  }
  if ('truncated' in spec && typeof spec.truncated !== 'boolean') {
    throw inputInvalid(`${field}.truncated`, 'format', `'${field}.truncated' 必须是布尔值`)
  }
}

function validatePredicateArray(list, field) {
  if (!Array.isArray(list)) throw inputInvalid(field, 'format', `'${field}' 必须是谓词数组`)
  list.forEach((entry, index) => validatePredicate(entry, `${field}[${index}]`))
}

function validateJudge(judge) {
  if (!isPlainObject(judge)) throw inputInvalid('judge', 'format', 'judge 必须是对象')
  const unexpected = firstUnexpectedKey(judge, new Set(['rules', 'fallback']), 'judge')
  if (unexpected) throw unexpected
  if (!('rules' in judge)) throw inputInvalid('judge.rules', 'missing', 'judge.rules 缺失')
  if (!Array.isArray(judge.rules)) throw inputInvalid('judge.rules', 'format', 'judge.rules 必须是数组')
  if (judge.rules.length > 32) {
    throw inputInvalid('judge.rules', 'range', `规则数 ${judge.rules.length} 超过上限 32`)
  }
  judge.rules.forEach((rule, index) => {
    const field = `judge.rules[${index}]`
    if (!isPlainObject(rule)) throw inputInvalid(field, 'format', `规则 '${field}' 必须是对象`)
    const ruleUnexpected = firstUnexpectedKey(rule, new Set(['when', 'actions']), field)
    if (ruleUnexpected) throw ruleUnexpected
    if (!('when' in rule)) throw inputInvalid(`${field}.when`, 'missing', `规则 '${field}' 缺少 when`)
    validatePredicate(rule.when, `${field}.when`)
    if (!('actions' in rule)) throw inputInvalid(`${field}.actions`, 'missing', `规则 '${field}' 缺少 actions`)
    if (!Array.isArray(rule.actions)) throw inputInvalid(`${field}.actions`, 'format', `规则 '${field}' 的 actions 必须是数组`)
    rule.actions.forEach((key, actionIndex) => {
      if (typeof key !== 'string') {
        throw inputInvalid(`${field}.actions[${actionIndex}]`, 'format', '动作键必须是字符串')
      }
    })
  })
  if ('fallback' in judge && judge.fallback !== undefined) {
    if (!Array.isArray(judge.fallback)) throw inputInvalid('judge.fallback', 'format', 'judge.fallback 必须是数组')
    judge.fallback.forEach((key, index) => {
      if (typeof key !== 'string') {
        throw inputInvalid(`judge.fallback[${index}]`, 'format', '动作键必须是字符串')
      }
    })
  }
  return { rules: judge.rules, fallback: judge.fallback ?? [] }
}

// ---------------- actions ----------------

function validateActionDefinition(definition, field) {
  if (!isPlainObject(definition)) throw inputInvalid(field, 'format', `动作 '${field}' 必须是对象`)
  const kind = definition.kind
  if (typeof kind !== 'string') throw inputInvalid(`${field}.kind`, 'missing', `动作 '${field}' 缺少 kind`)
  if (kind === 'event') {
    const unexpected = firstUnexpectedKey(definition, new Set(['kind', 'name', 'payload']), field)
    if (unexpected) throw unexpected
    if (!('name' in definition)) throw inputInvalid(`${field}.name`, 'missing', `event 动作 '${field}' 缺少 name`)
    requireString(definition.name, `${field}.name`)
    if (!EVENT_NAME_PATTERN.test(definition.name)) {
      throw inputInvalid(`${field}.name`, 'format', `事件短名 '${definition.name}' 不符合 ^[a-z][a-z0-9-]{0,63}$（无点号）`)
    }
    if (RESERVED_EVENT_NAMES.has(definition.name)) {
      throw inputInvalid(
        `${field}.name`,
        'reserved',
        `事件短名 '${definition.name}' 是保留名（防遮蔽内置事件），不可用`,
      )
    }
    if ('payload' in definition && definition.payload !== undefined && !isLosslessJson(definition.payload)) {
      throw inputInvalid(`${field}.payload`, 'format', `payload 必须是合法 JSON 值`)
    }
    return { kind: 'event', name: definition.name, ...(definition.payload !== undefined ? { payload: definition.payload } : {}) }
  }
  if (kind === 'plugin') {
    const unexpected = firstUnexpectedKey(definition, new Set(['kind', 'action', 'payload', 'timeoutSeconds']), field)
    if (unexpected) throw unexpected
    if (!('action' in definition)) throw inputInvalid(`${field}.action`, 'missing', `plugin 动作 '${field}' 缺少 action`)
    requireString(definition.action, `${field}.action`)
    if (!REGISTERED_ACTION_PATTERN.test(definition.action)) {
      throw inputInvalid(
        `${field}.action`,
        'format',
        `注册动作名 '${definition.action}' 必须形如 <namespace>.<verb>（恰好一个点，两段各 ^[a-z][a-z0-9-]{0,29}$）`,
      )
    }
    if ('payload' in definition && definition.payload !== undefined && !isLosslessJson(definition.payload)) {
      throw inputInvalid(`${field}.payload`, 'format', `payload 必须是合法 JSON 值`)
    }
    if ('timeoutSeconds' in definition && definition.timeoutSeconds !== undefined) {
      assertRange(definition.timeoutSeconds, 1, 300, `${field}.timeoutSeconds`)
    }
    return {
      kind: 'plugin',
      action: definition.action,
      ...(definition.payload !== undefined ? { payload: definition.payload } : {}),
      ...(definition.timeoutSeconds !== undefined ? { timeoutSeconds: definition.timeoutSeconds } : {}),
    }
  }
  if (kind === 'session') {
    const unexpected = firstUnexpectedKey(
      definition,
      new Set(['kind', 'mode', 'title', 'cwd', 'preset', 'model', 'prompt', 'framing', 'idleDisposeSeconds']),
      field,
    )
    if (unexpected) throw unexpected
    let mode = 'persistent'
    if ('mode' in definition && definition.mode !== undefined) {
      if (definition.mode !== 'persistent' && definition.mode !== 'ephemeral') {
        throw inputInvalid(`${field}.mode`, 'format', `mode 必须是 'persistent' 或 'ephemeral'`)
      }
      mode = definition.mode
    }
    if ('title' in definition && definition.title !== undefined) {
      requireString(definition.title, `${field}.title`, { allowEmpty: true })
      if (definition.title.length > 120) throw inputInvalid(`${field}.title`, 'range', 'title 最长 120 字符')
    }
    if ('cwd' in definition && definition.cwd !== undefined) requireString(definition.cwd, `${field}.cwd`)
    if ('preset' in definition && definition.preset !== undefined) requireString(definition.preset, `${field}.preset`)
    if ('model' in definition && definition.model !== undefined) {
      if (!isPlainObject(definition.model)) throw inputInvalid(`${field}.model`, 'format', 'model 必须是对象')
      const modelUnexpected = firstUnexpectedKey(definition.model, new Set(['provider', 'model', 'reasoningEffort']), `${field}.model`)
      if (modelUnexpected) throw modelUnexpected
      requireString(definition.model.provider, `${field}.model.provider`)
      requireString(definition.model.model, `${field}.model.model`)
      if ('reasoningEffort' in definition.model && definition.model.reasoningEffort !== undefined) {
        requireString(definition.model.reasoningEffort, `${field}.model.reasoningEffort`)
      }
    }
    if ('framing' in definition && definition.framing !== undefined) {
      if (definition.framing !== 'banner' && definition.framing !== 'plain') {
        throw inputInvalid(`${field}.framing`, 'format', `framing 必须是 'banner' 或 'plain'`)
      }
    }
    if ('idleDisposeSeconds' in definition && definition.idleDisposeSeconds !== undefined) {
      if (mode !== 'ephemeral') {
        throw inputInvalid(
          `${field}.idleDisposeSeconds`,
          'unexpected',
          'idleDisposeSeconds 仅 ephemeral 模式可用，persistent 拒绝该字段',
        )
      }
      if (!isInteger(definition.idleDisposeSeconds) || definition.idleDisposeSeconds < 0) {
        throw inputInvalid(`${field}.idleDisposeSeconds`, 'range', 'idleDisposeSeconds 必须是非负整数')
      }
    }
    if (!('prompt' in definition)) throw inputInvalid(`${field}.prompt`, 'missing', `session 动作 '${field}' 缺少 prompt`)
    requireString(definition.prompt, `${field}.prompt`)
    if (new TextEncoder().encode(definition.prompt).length > 32 * 1024) {
      throw inputInvalid(`${field}.prompt`, 'range', 'prompt 最长 32 KiB')
    }
    return {
      kind: 'session',
      ...(mode !== 'persistent' ? { mode } : {}),
      ...(definition.title !== undefined ? { title: definition.title } : {}),
      ...(definition.cwd !== undefined ? { cwd: definition.cwd } : {}),
      ...(definition.preset !== undefined ? { preset: definition.preset } : {}),
      ...(definition.model !== undefined ? { model: definition.model } : {}),
      prompt: definition.prompt,
      ...(definition.framing !== undefined ? { framing: definition.framing } : {}),
      ...(definition.idleDisposeSeconds !== undefined ? { idleDisposeSeconds: definition.idleDisposeSeconds } : {}),
    }
  }
  throw inputInvalid(`${field}.kind`, 'format', `未知动作 kind '${kind}'（event / plugin / session）`)
}

function assertRange(value, min, max, field) {
  if (!isInteger(value)) throw inputInvalid(field, 'format', `'${field}' 必须是整数`)
  if (value < min || value > max) throw inputInvalid(field, 'range', `'${field}' 必须在 ${min}–${max} 之间`)
}

function validateActions(actions) {
  if (!isPlainObject(actions)) throw inputInvalid('actions', 'format', 'actions 必须是对象（动作键 → 动作定义）')
  const keys = Object.keys(actions)
  if (keys.length > 16) throw inputInvalid('actions', 'range', `动作数 ${keys.length} 超过上限 16`)
  const normalized = {}
  for (const key of keys) {
    if (!ACTION_KEY_PATTERN.test(key)) {
      throw inputInvalid(
        `actions.${key}`,
        'format',
        `动作键 '${key}' 不符合 ^[a-z][a-z0-9-]{0,63}$（无点号）`,
      )
    }
    normalized[key] = validateActionDefinition(actions[key], `actions.${key}`)
  }
  return normalized
}

/** 校验规则/回退引用的动作键都已在 actions 中定义（契约 04/07：静态校验）。 */
function validateActionReferences(judge, actions) {
  const defined = new Set(Object.keys(actions))
  judge.rules.forEach((rule, index) => {
    rule.actions.forEach((key, actionIndex) => {
      if (!defined.has(key)) {
        throw inputInvalid(
          `judge.rules[${index}].actions[${actionIndex}]`,
          'missing',
          `规则 ${index} 引用的动作键 '${key}' 未在 actions 中定义`,
        )
      }
    })
  })
  judge.fallback.forEach((key, index) => {
    if (!defined.has(key)) {
      throw inputInvalid(
        `judge.fallback[${index}]`,
        'missing',
        `fallback 引用的动作键 '${key}' 未在 actions 中定义`,
      )
    }
  })
}

/**
 * 校验并归一化 OrchestrationInput（契约 01 全字段）。
 * 任一不通过即抛 script_input_invalid；通过则返回归一化输入（默认值已填充、title 已去首尾空白）。
 * @param {object} input 原始输入
 * @returns {{id?: string, title: string, enabled: boolean, overlap: string, trigger: object, script: object, judge: object, actions: object}}
 */
export function validateOrchestrationInput(input) {
  if (!isPlainObject(input)) throw inputInvalid('input', 'format', '编排输入必须是对象')
  const unexpected = firstUnexpectedKey(
    input,
    new Set(['id', 'title', 'enabled', 'overlap', 'trigger', 'script', 'judge', 'actions']),
    '',
  )
  if (unexpected) throw unexpected

  if (!('title' in input)) throw inputInvalid('title', 'missing', 'title 缺失')
  if (typeof input.title !== 'string') throw inputInvalid('title', 'format', 'title 必须是字符串')
  const title = input.title.trim()
  if (title.length < 1 || title.length > 120) {
    throw inputInvalid('title', 'range', 'title 去首尾空白后长度必须在 1–120 之间')
  }

  if ('id' in input && input.id !== undefined) {
    if (typeof input.id !== 'string') throw inputInvalid('id', 'format', 'id 必须是字符串')
    if (!ID_PATTERN.test(input.id)) {
      throw inputInvalid('id', 'format', "id 必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$")
    }
  }

  if ('enabled' in input && input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw inputInvalid('enabled', 'format', 'enabled 必须是布尔值')
  }
  const enabled = input.enabled ?? true

  if ('overlap' in input && input.overlap !== undefined) {
    if (input.overlap !== 'skip' && input.overlap !== 'queue') {
      throw inputInvalid('overlap', 'format', "overlap 必须是 'skip' 或 'queue'")
    }
  }
  const overlap = input.overlap ?? 'skip'

  if (!('trigger' in input)) throw inputInvalid('trigger', 'missing', 'trigger 缺失')
  const trigger = validateTrigger(input.trigger)
  if (!('script' in input)) throw inputInvalid('script', 'missing', 'script 缺失')
  const script = validateScript(input.script)
  if (!('judge' in input)) throw inputInvalid('judge', 'missing', 'judge 缺失')
  const judge = validateJudge(input.judge)
  if (!('actions' in input)) throw inputInvalid('actions', 'missing', 'actions 缺失')
  const actions = validateActions(input.actions)

  validateActionReferences(judge, actions)

  const normalized = { title, enabled, overlap, trigger, script, judge, actions }
  if (input.id !== undefined) normalized.id = input.id
  return normalized
}
