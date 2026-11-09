// 判定求值与模板渲染（契约 docs/temp/04-judge.md）：纯函数，只读本次 run 的脚本结果，
// 不做 I/O、不调脚本、不写存储。按顺序求值 rules，第一条命中者生效。
// 票 26 交付谓词求值与「零动作」结算口径；票 30 交付模板渲染（变量表、json: 路径、
// \{{ 转义、递归 payload、warnings 纪律）与变量折算——动作执行编排在 lib/actions.js。
// 谓词取值形态在创建/更新时已经 validatePredicate 静态校验（lib/validation.js），
// 此处按契约语义求值即可，不再重复形状检查。
import { isPlainObject } from './errors.js'

/** 谓词求值的事实集（由 runner 从脚本结果装配）。 */
// facts: { exitCode, signal, timedOut, durationMs, stdoutText, stderrText, stdoutTruncated, stderrTruncated }

/** 极简 JSON 路径取值（$ 开头，. 属性，[n] 下标）；解析失败/路径不存在返回 undefined。 */
export function readJsonPath(value, path) {
  if (typeof path !== 'string' || !path.startsWith('$')) return undefined
  let current = value
  const rest = path.slice(1)
  const token = /\.[A-Za-z0-9_]+|\[\d+\]/g
  let index = 0
  let match
  while ((match = token.exec(rest)) !== null) {
    if (match.index !== index) return undefined // 路径里有无法识别的段（创建校验已拦，防御）
    const part = match[0]
    if (part.startsWith('.')) {
      if (current === null || typeof current !== 'object') return undefined
      current = current[part.slice(1)]
    } else {
      if (!Array.isArray(current)) return undefined
      current = current[Number.parseInt(part.slice(1, -1), 10)]
    }
    index = match.index + part.length
  }
  if (index !== rest.length) return undefined
  return current
}

const strictEqual = (a, b) => a === b

/** JSON 标量/结构深比较（契约 04：不做类型转换，对象数组严格深比较）。 */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((entry, i) => deepEqual(entry, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    return keysA.every((key) => key in b && deepEqual(a[key], b[key]))
  }
  return false
}

/** stdout/stderr 文本谓词（契约 04 谓词表；同对象多键 AND）。 */
function evaluateTextPredicate(spec, text, truncated) {
  let jsonRoot
  let jsonParsed = false
  const parsedJson = () => {
    if (!jsonParsed) {
      jsonParsed = true
      try {
        jsonRoot = JSON.parse(text)
      } catch {
        jsonRoot = undefined
      }
    }
    return jsonRoot
  }
  if ('regex' in spec) {
    if (!new RegExp(spec.regex, spec.flags ?? '').test(text)) return false
  }
  if ('contains' in spec && !text.includes(spec.contains)) return false
  if ('truncated' in spec && spec.truncated !== truncated) return false
  if ('jsonPath' in spec || 'equals' in spec || 'notEquals' in spec) {
    // equals/notEquals 作用于 jsonPath 取值；缺省 jsonPath 时作用于整份解析结果（$）
    const picked = 'jsonPath' in spec ? readJsonPath(parsedJson(), spec.jsonPath) : parsedJson()
    if ('equals' in spec && !deepEqual(picked, spec.equals)) return false
    if ('notEquals' in spec && deepEqual(picked, spec.notEquals)) return false
  }
  return true
}

/** 谓词对象求值（未知谓词键在创建校验已拒绝；同对象多键 AND）。 */
export function evaluatePredicate(predicate, facts) {
  if ('exitCode' in predicate) {
    const ec = facts.exitCode
    const expected = predicate.exitCode
    let ok
    if (typeof expected === 'number') {
      ok = ec === expected
    } else if (typeof expected === 'object' && expected !== null) {
      if ('not' in expected) ok = ec !== expected.not
      else if ('in' in expected) ok = ec !== null && expected.in.includes(ec)
      else {
        // { min?, max? } 闭区间；null（信号杀死）不落区间
        ok = ec !== null
        if (ok && 'min' in expected) ok = ec >= expected.min
        if (ok && 'max' in expected) ok = ec <= expected.max
      }
    } else {
      ok = false
    }
    if (!ok) return false
  }
  if ('signal' in predicate && !(facts.signal === predicate.signal || strictEqual(facts.signal, predicate.signal))) {
    return false
  }
  if ('timedOut' in predicate && facts.timedOut !== predicate.timedOut) return false
  if ('durationMs' in predicate) {
    const { min, max } = predicate.durationMs
    if (min !== undefined && facts.durationMs < min) return false
    if (max !== undefined && facts.durationMs > max) return false
  }
  if ('stdout' in predicate && !evaluateTextPredicate(predicate.stdout, facts.stdoutText, facts.stdoutTruncated)) {
    return false
  }
  if ('stderr' in predicate && !evaluateTextPredicate(predicate.stderr, facts.stderrText, facts.stderrTruncated)) {
    return false
  }
  if ('all' in predicate) {
    if (!predicate.all.every((entry) => evaluatePredicate(entry, facts))) return false
  }
  if ('any' in predicate) {
    if (!predicate.any.some((entry) => evaluatePredicate(entry, facts))) return false
  }
  return true
}

/**
 * 判定求值主入口（契约 04「判定结果」表）。
 * @param {object} judge 编排的 judge 配置（{ rules, fallback }，已静态校验）
 * @param {object} facts 脚本结果事实集
 * @returns {{ matchedRule: number | null, usedFallback: boolean, actionKeys: string[] }}
 *   规则 N 命中 → { N, false, rules[N].actions }；走 fallback → { null, true, fallback }；
 *   无 fallback 全未命中（或 fallback 为空）→ { null, false, [] }（零动作）。
 */
export function evaluateJudge(judge, facts) {
  for (let index = 0; index < judge.rules.length; index += 1) {
    const rule = judge.rules[index]
    if (evaluatePredicate(rule.when, facts)) {
      return { matchedRule: index, usedFallback: false, actionKeys: [...rule.actions] }
    }
  }
  if (judge.fallback !== undefined && judge.fallback.length > 0) {
    return { matchedRule: null, usedFallback: true, actionKeys: [...judge.fallback] }
  }
  return { matchedRule: null, usedFallback: false, actionKeys: [] }
}

// ---------------- 模板渲染（契约 04「模板变量」；票 30） ----------------

/** run.actions[].warnings / run.script.warnings 的保留上限（契约 01/04：保最近 20 条）。 */
export const WARNING_LIMIT = 20

/** 追加 warning 并维持「保留最近 20 条、超出丢最旧」（模板警告与 report() 共用）。 */
export function appendWarning(warnings, item) {
  warnings.push(item)
  if (warnings.length > WARNING_LIMIT) warnings.splice(0, warnings.length - WARNING_LIMIT)
  return warnings
}

/**
 * stdout JSON 惰性视图：单次解析，路径查找区分「非合法 JSON」与「路径不存在」
 * （契约 04：两者都替换为空串并各记一条警告，与未知变量完全同构，不抛错）。
 */
function createStdoutJson(stdoutText) {
  let parsed = null
  return {
    lookup(path) {
      if (parsed === null) {
        try {
          parsed = { valid: true, value: JSON.parse(stdoutText) }
        } catch {
          parsed = { valid: false }
        }
      }
      if (!parsed.valid) return { reason: 'invalid' }
      const value = readJsonPath(parsed.value, path)
      return value === undefined ? { reason: 'missing' } : { value }
    },
  }
}

const JSON_PREFIX = 'json:'

/** 单串渲染核心：\{{ 转义 → {{name}} / {{json:<path>}} → 单次替换（不对结果再展开）。 */
function renderString(text, variables, stdoutJson, warnings) {
  let result = ''
  let index = 0
  while (index < text.length) {
    if (text.startsWith('\\{{', index)) {
      result += '{{'
      index += 3
      continue
    }
    if (!text.startsWith('{{', index)) {
      result += text[index]
      index += 1
      continue
    }
    const close = text.indexOf('}}', index + 2)
    if (close === -1) {
      // 未闭合的 {{ 原样保留（无警告：不是一次变量引用）
      result += text.slice(index)
      break
    }
    const content = text.slice(index + 2, close)
    if (content.startsWith(JSON_PREFIX)) {
      const path = content.slice(JSON_PREFIX.length)
      const found = stdoutJson.lookup(path)
      if (found.reason === 'invalid') {
        appendWarning(warnings, 'stdout is not valid JSON')
      } else if (found.reason === 'missing') {
        appendWarning(warnings, `json path missing: ${path}`)
      } else {
        // 非字符串值按其 JSON 文本插入（契约 04 递归渲染规则）
        result += typeof found.value === 'string' ? found.value : JSON.stringify(found.value)
      }
    } else if (Object.hasOwn(variables, content)) {
      result += variables[content]
    } else {
      appendWarning(warnings, `unknown variable: {{${content}}}`)
    }
    index = close + 2
  }
  return result
}

/**
 * 渲染一段模板文本（契约 04 模板变量表）。
 * @param {string} text 待渲染文本
 * @param {Record<string, string>} variables 变量名 → 折算后的文本（buildTemplateVariables 产出）
 * @param {{ stdoutText?: string }} [jsonSource] {{json:}} 的解析源（收集到的 stdout 全文）
 * @returns {{ text: string, warnings: string[] }}
 */
export function renderTemplate(text, variables, jsonSource) {
  const warnings = []
  const stdoutJson = createStdoutJson(jsonSource?.stdoutText ?? '')
  return { text: renderString(text ?? '', variables, stdoutJson, warnings), warnings }
}

/**
 * payload 按结构递归渲染（契约 04）：只对字符串值做变量替换；对象键不渲染（含 {{ 的键
 * 按字面量保留）；数字/布尔/null 原样；{{json:}} 取非字符串值按其 JSON 文本插入。
 * 结构保留使渲染结果恒为合法 JSON（payload 不再可能触发 template_invalid）。
 * @param {unknown} value 已静态校验为 JSON 安全的 payload
 * @param {Record<string, string>} variables
 * @param {{ stdoutText?: string }} [jsonSource]
 * @param {string[]} [warnings] 汇入的警告数组（与模板警告同数组；缺省自建）
 * @returns {unknown} 渲染后的新结构（不修改原 payload）
 */
export function renderPayload(value, variables, jsonSource, warnings = []) {
  const stdoutJson = createStdoutJson(jsonSource?.stdoutText ?? '')
  return renderValue(value, variables, stdoutJson, warnings)
}

function renderValue(value, variables, stdoutJson, warnings) {
  if (typeof value === 'string') return renderString(value, variables, stdoutJson, warnings)
  if (Array.isArray(value)) return value.map((entry) => renderValue(entry, variables, stdoutJson, warnings))
  if (isPlainObject(value)) {
    const rendered = {}
    for (const [key, entry] of Object.entries(value)) {
      rendered[key] = renderValue(entry, variables, stdoutJson, warnings)
    }
    return rendered
  }
  return value
}

/**
 * 变量折算（契约 04 模板变量表）：把编排/run/脚本结果/判定结果折算为变量名 → 文本。
 * exitCode/signal 为 null（信号杀死）折算为 "null"；timedOut/truncated 渲染 true/false；
 * matchedRule 折算为命中下标或 "fallback" / "none"。
 */
export function buildTemplateVariables({ orchestration, run, script, verdict }) {
  return {
    orchestrationId: String(orchestration.id),
    orchestrationTitle: String(orchestration.title),
    runId: String(run.runId),
    trigger: String(run.trigger),
    scheduledAt: String(run.scheduledAt),
    startedAt: String(run.startedAt),
    exitCode: String(script.exitCode),
    signal: String(script.signal),
    timedOut: String(script.timedOut === true),
    durationMs: String(script.durationMs ?? 0),
    stdoutTail: script.stdoutTail ?? '',
    stderrTail: script.stderrTail ?? '',
    truncated: String(script.truncated === true),
    matchedRule:
      verdict.matchedRule === null ? (verdict.usedFallback ? 'fallback' : 'none') : String(verdict.matchedRule),
  }
}
