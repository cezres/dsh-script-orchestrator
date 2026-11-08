// 判定求值（契约 docs/temp/04-judge.md）：纯函数，只读本次 run 的脚本结果，
// 不做 I/O、不调脚本、不写存储。按顺序求值 rules，第一条命中者生效。
// 票 26 交付谓词求值与「零动作」结算口径（actionKeys 为空数组）；
// 模板渲染与三类动作执行属票 30+——调用方拿到 actionKeys 后自行决定派发。
// 谓词取值形态在创建/更新时已经 validatePredicate 静态校验（lib/validation.js），
// 此处按契约语义求值即可，不再重复形状检查。

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
