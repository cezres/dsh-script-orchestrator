import { readFile } from 'node:fs/promises'

const skillUrl = new URL('../skills/script-orchestrator/SKILL.md', import.meta.url)

// 在打开存储之前读取，确保缺失资源不会留下半初始化的 Host 服务。
export async function loadSkill() {
  const content = await readFile(skillUrl, 'utf8')
  if (!content.trim()) throw new Error('script-orchestrator: bundled SKILL.md is empty')
  return {
    name: 'script-orchestrator',
    description: '创建或修改脚本编排：理解自然语言需求、澄清缺漏并确认目标后实施。',
    source: 'bundled',
    content,
    invocation: { modelInvocable: true, userInvocable: true },
  }
}
