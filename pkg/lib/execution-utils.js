// 执行辅助纯函数（与宿主环境解耦：路径比较与尾部截断，供 runner 与测试复用）。
import path from 'node:path'

/** 前缀匹配（路径规范化后）：cwd 必须落在某个根之下（契约 03 安全边界）。 */
export function isWithin(child, parent) {
  const resolvedChild = path.resolve(child)
  const resolvedParent = path.resolve(parent)
  if (resolvedChild === resolvedParent) return true
  const relative = path.relative(resolvedParent, resolvedChild)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** 解码后文本取末 N 个 code point（U+FFFD 等如实保留、计入；契约 03「输出收集」）。 */
export function tailText(text, limit = 2048) {
  if (typeof text !== 'string' || text.length <= limit) return text ?? ''
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(points.length - limit).join('')
}
