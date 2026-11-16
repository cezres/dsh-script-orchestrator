import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadSkill } from '../lib/skills.js'

describe('内置 script-orchestrator SKILL', () => {
  it('读取独立资源并以正式注册形状提供双调用入口', async () => {
    const skill = await loadSkill()
    const source = await readFile(new URL('../skills/script-orchestrator/SKILL.md', import.meta.url), 'utf8')
    expect(skill).toEqual({
      name: 'script-orchestrator',
      description: expect.any(String),
      source: 'bundled',
      content: source,
      invocation: { modelInvocable: true, userInvocable: true },
    })
    for (const phrase of ['1～3', '推荐', '明确确认', '实际命令和工作目录', '主要副作用', '不受 DSH 文件沙箱审批保护', '没有语义变化', 'enabled: false', 'expectedUpdatedAt', 'script_conflict', '试运行须另行', '不要回显',
      // v0.1y 固定规则：脚本目录、固定暂停、结果标记行、会话上报
      '~/scripts/<编排id>.<扩展名>', '不向用户询问写入路径', '暂停态落库', '##SCRIPT-RESULT##', 'script_report']) {
      expect(skill.content).toContain(phrase)
    }
  })

  it('包分发清单包含独立资源目录', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.files).toContain('skills')
  })
})
