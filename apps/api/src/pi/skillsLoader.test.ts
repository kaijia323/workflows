/**
 * skills 四来源加载单测。
 *
 * 隔离:PI_CODING_AGENT_DIR 环境变量重定向 SDK getAgentDir()(来源 a ~/.pi/agent/skills)
 * + SkillLoadContext.homeDir 注入(来源 d ~/.agents/skills),全程不触碰真实用户目录。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifySkillSource,
  createPromptOnlyLoader,
  loadWorkspaceSkills,
  toSkillInfo,
  type SkillLoadContext,
} from './promptLoader.js'

let tmpHome: string
let tmpStore: string
let tmpWs: string
let ctx: SkillLoadContext

/** 写一个带 frontmatter 的 SKILL.md(或任意 .md 文件) */
function writeSkill(dir: string, name: string, description: string, fileName = 'SKILL.md'): string {
  const file = path.join(dir, fileName)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n正文指令`, 'utf-8')
  return file
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'wf-skills-home-'))
  tmpStore = mkdtempSync(path.join(tmpdir(), 'wf-skills-store-'))
  tmpWs = mkdtempSync(path.join(tmpdir(), 'wf-skills-ws-'))
  // 来源 a 重定向:SDK getAgentDir() 优先读该环境变量(官方机制)
  vi.stubEnv('PI_CODING_AGENT_DIR', path.join(tmpHome, 'pi-agent'))
  ctx = { cwd: tmpWs, skillsDir: path.join(tmpStore, 'skills'), homeDir: tmpHome }
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of [tmpHome, tmpStore, tmpWs]) rmSync(dir, { recursive: true, force: true })
})

/** 四来源各放一个 skill */
function setupFourSources(): void {
  // 来源 a:~/.pi/agent/skills(经 PI_CODING_AGENT_DIR 重定向)
  writeSkill(path.join(tmpHome, 'pi-agent', 'skills', 'greet'), 'greet', '用中文打招呼')
  // 来源 b:<workspace>/.pi/skills
  writeSkill(path.join(tmpWs, '.pi', 'skills', 'refactor'), 'refactor', '重构代码')
  // 来源 c:<root>/.workflows/skills
  writeSkill(path.join(tmpStore, 'skills', 'summarize'), 'summarize', '总结内容')
  // 来源 d:~/.agents/skills(homeDir 注入)
  writeSkill(path.join(tmpHome, '.agents', 'skills', 'translate'), 'translate', '翻译文本')
}

describe('loadWorkspaceSkills 四来源', () => {
  it('四来源各一个 SKILL.md 全部加载,来源分类正确', () => {
    setupFourSources()

    const result = loadWorkspaceSkills(ctx)
    const infos = result.skills.map((s) => toSkillInfo(s, ctx))

    expect(result.skills.map((s) => s.name).sort()).toEqual(['greet', 'refactor', 'summarize', 'translate'])
    const byName = new Map(infos.map((i) => [i.name, i.source]))
    expect(byName.get('greet')).toBe('pi-agent')
    expect(byName.get('refactor')).toBe('pi-project')
    expect(byName.get('summarize')).toBe('workspace')
    expect(byName.get('translate')).toBe('global-agents')
    // 分类函数本身与 toSkillInfo 一致
    for (const s of result.skills) {
      expect(classifySkillSource(s, ctx)).toBe(byName.get(s.name))
    }
  })

  it('扫描根散落 .md:frontmatter 有 name 用之;无 name 回退父目录名', () => {
    // 散落 .md 只在扫描根(此处 = <workspace>/.pi/skills)被加载;子目录仅递归找 SKILL.md
    writeSkill(path.join(tmpWs, '.pi', 'skills'), 'loose-a', '散落文件 A', 'a.md')
    writeSkill(path.join(tmpWs, '.pi', 'skills'), '', '散落文件 B', 'b.md')

    const result = loadWorkspaceSkills(ctx)
    const names = result.skills.map((s) => s.name)
    expect(names).toContain('loose-a')
    expect(names).toContain('skills') // 无 name → 回退父目录名(= 扫描根 basename)
  })

  it('缺 description 不加载 + warning 诊断;同名冲突先到先得(collision 诊断,不抛错)', () => {
    setupFourSources()
    // 缺 description:直接写无 frontmatter 的 md
    const nodDir = path.join(tmpHome, 'pi-agent', 'skills', 'nod')
    mkdirSync(nodDir, { recursive: true })
    writeFileSync(path.join(nodDir, 'SKILL.md'), '没有 frontmatter 的文件', 'utf-8')
    // 同名冲突:workspace 来源再放一个 greet(与 pi-agent 的 greet 冲突)
    writeSkill(path.join(tmpStore, 'skills', 'greet'), 'greet', '冲突副本')

    const result = loadWorkspaceSkills(ctx)

    expect(result.skills.some((s) => s.name === 'nod')).toBe(false)
    // 冲突:先到者(pi-agent 的 greet)胜出,只有一个 greet
    const greets = result.skills.filter((s) => s.name === 'greet')
    expect(greets).toHaveLength(1)
    expect(classifySkillSource(greets[0], ctx)).toBe('pi-agent')
    expect(result.diagnostics.some((d) => d.type === 'warning' && d.message === 'description is required')).toBe(true)
    expect(result.diagnostics.some((d) => d.type === 'collision')).toBe(true)
  })

  it('可选目录不存在(如无 ~/.agents/skills)不抛错;缺失路径诊断降噪为 debug', () => {
    // 只有来源 b 存在,其余来源目录都不建
    writeSkill(path.join(tmpWs, '.pi', 'skills', 'refactor'), 'refactor', '重构代码')

    const result = loadWorkspaceSkills(ctx)

    expect(result.skills.map((s) => s.name)).toEqual(['refactor'])
    expect(result.skills).toHaveLength(1)
    // 缺失目录的诊断存在(降噪逻辑在 logSkillDiagnostics,此处验证诊断本身)
    const missing = result.diagnostics.filter((d) => d.message === 'skill path does not exist')
    expect(missing.length).toBeGreaterThanOrEqual(1)
  })

  it('toSkillInfo 字段完整(name/description/filePath/baseDir/source/sourcePath/disableModelInvocation)', () => {
    writeSkill(path.join(tmpHome, '.agents', 'skills', 'translate'), 'translate', '翻译文本')

    const result = loadWorkspaceSkills(ctx)
    const info = toSkillInfo(result.skills[0], ctx)

    expect(info).toEqual({
      name: 'translate',
      description: '翻译文本',
      filePath: path.join(tmpHome, '.agents', 'skills', 'translate', 'SKILL.md'),
      baseDir: path.join(tmpHome, '.agents', 'skills', 'translate'),
      source: 'global-agents',
      sourcePath: path.join(tmpHome, '.agents', 'skills', 'translate'),
      disableModelInvocation: false,
    })
  })

  it('disableModelInvocation:true 透传', () => {
    const dir = path.join(tmpHome, 'pi-agent', 'skills', 'invoke-only')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: invoke-only\ndescription: 仅显式调用\ndisable-model-invocation: true\n---\n正文', 'utf-8')

    const result = loadWorkspaceSkills(ctx)
    const info = toSkillInfo(result.skills[0], ctx)

    expect(info.disableModelInvocation).toBe(true)
  })

  it('.workflows/agent/skills 不作为来源(不加载)', () => {
    writeSkill(path.join(tmpStore, 'agent', 'skills', 'legacy'), 'legacy', '旧约定目录')

    const result = loadWorkspaceSkills(ctx)

    expect(result.skills.some((s) => s.name === 'legacy')).toBe(false)
  })
})

describe('createPromptOnlyLoader skills 集成', () => {
  it('传入 skills 上下文时 getSkills() 返回真实加载结果', () => {
    setupFourSources()

    const loader = createPromptOnlyLoader({ skills: ctx })
    const result = loader.getSkills() as { skills: Array<{ name: string }> }

    expect(result.skills.map((s) => s.name).sort()).toEqual(['greet', 'refactor', 'summarize', 'translate'])
  })

  it('不带 skills 上下文时 getSkills() 仍返回空(回归)', () => {
    setupFourSources()

    const loader = createPromptOnlyLoader({ systemPrompt: 'x' })
    const result = loader.getSkills() as { skills: unknown[] }

    expect(result.skills).toEqual([])
  })
})
