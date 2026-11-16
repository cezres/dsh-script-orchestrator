// 结果上报标记行（契约 docs/temp/03-execution.md「结果上报」，v0.1y）
//
// 脚本在 stdout 输出单行 `##SCRIPT-RESULT## <JSON>`；结算时从收集文本取
// 最后一条合法标记写入 run.result（summary/level/fields）。会话侧 script_report
// 复用同一形状校验。解析失败只忽略并记 warnings，不影响 run 状态。

export const RESULT_MARKER_PREFIX = '##SCRIPT-RESULT##';

export const RESULT_LEVELS = ['info', 'warn', 'error'];

export const RESULT_LIMITS = {
  summaryMax: 300,
  fieldsMaxEntries: 8,
  fieldKeyMax: 40,
  fieldValueMax: 100,
  reportsPerRun: 10,
};

const codePoints = (text) => Array.from(text).length;

// 共享形状校验：summary 必填（trim 后 1–300 cp）；level ∈ enum；fields ≤ 8 项、
// 键 1–40、值 1–100 cp。返回 { ok: true, value } 或 { ok: false, field, reason }。
export function validateResultShape({ summary, level, fields } = {}) {
  if (typeof summary !== 'string') {
    return { ok: false, field: 'summary', reason: 'format' };
  }
  const trimmed = summary.trim();
  if (codePoints(trimmed) < 1 || codePoints(trimmed) > RESULT_LIMITS.summaryMax) {
    return { ok: false, field: 'summary', reason: 'format' };
  }
  if (level !== undefined && !RESULT_LEVELS.includes(level)) {
    return { ok: false, field: 'level', reason: 'format' };
  }
  if (fields !== undefined) {
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      return { ok: false, field: 'fields', reason: 'format' };
    }
    const entries = Object.entries(fields);
    if (entries.length > RESULT_LIMITS.fieldsMaxEntries) {
      return { ok: false, field: 'fields', reason: 'format' };
    }
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || codePoints(key) < 1 || codePoints(key) > RESULT_LIMITS.fieldKeyMax) {
        return { ok: false, field: 'fields', reason: 'format' };
      }
      if (typeof value !== 'string' || codePoints(value) < 1 || codePoints(value) > RESULT_LIMITS.fieldValueMax) {
        return { ok: false, field: 'fields', reason: 'format' };
      }
    }
  }
  return {
    ok: true,
    value: {
      summary: trimmed,
      ...(level !== undefined ? { level } : {}),
      ...(fields !== undefined ? { fields } : {}),
    },
  };
}

function parseMarkerLine(line) {
  const jsonText = line.slice(RESULT_MARKER_PREFIX.length).trim();
  if (jsonText.length === 0) {
    return { kind: 'invalid' };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { kind: 'invalid' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid' };
  }
  const shape = validateResultShape(parsed);
  if (!shape.ok) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', value: shape.value };
}

// 从 stdout 收集文本解析标记行：
// - 逐行扫描，行内其余内容（前后空白）不影响；
// - 取最后一条合法标记；其后的非法标记仍计 invalid（warnings 提示）；
// - 无任何标记行 → { present: false }。
export function parseScriptResult(stdoutText) {
  const outcome = { present: false, result: null, invalidMarker: false };
  if (typeof stdoutText !== 'string' || stdoutText.length === 0) {
    return outcome;
  }
  let sawInvalid = false;
  let lastValid = null;
  for (const line of stdoutText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(RESULT_MARKER_PREFIX)) {
      continue;
    }
    const marker = parseMarkerLine(trimmed);
    if (marker.kind === 'valid') {
      lastValid = marker.value;
    } else {
      sawInvalid = true;
    }
  }
  if (lastValid === null && !sawInvalid) {
    return outcome;
  }
  return {
    present: true,
    result: lastValid,
    invalidMarker: sawInvalid,
  };
}
