import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  BUILTIN_AGENTS_DIR,
  compileWriteMatcher,
  isWriteAllowed,
  loadAgentDefinitions,
  parseFrontmatter,
  parseAgentFile,
} from './agentDefs.js'

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-agents-'))
  return dir
}

describe('parseFrontmatter', () => {
  it('解析标量字段', () => {
    const fm = parseFrontmatter('name: explorer\ndescription: 探索仓库\n')
    expect(fm.name).toBe('explorer')
    expect(fm.description).toBe('探索仓库')
  })

  it('解析行内数组', () => {
    const fm = parseFrontmatter('name: orchestrator\nagents: [explorer, planner, executor]\n')
    expect(fm.agents).toEqual(['explorer', 'planner', 'executor'])
  })

  it('解析多行数组(缩进 - item)', () => {
    const fm = parseFrontmatter('name: reviewer\nwrite:\n  - "04-review.md"\n  - docs/**\n')
    expect(fm.write).toEqual(['04-review.md', 'docs/**'])
  })

  it('解析带引号值', () => {
    const fm = parseFrontmatter('name: "explorer"\ndescription: \'探索仓库需求\'\n')
    expect(fm.name).toBe('explorer')
    expect(fm.description).toBe('探索仓库需求')
  })

  it('忽略未知字段与注释行', () => {
    const fm = parseFrontmatter('# 注释\nname: a\nfuture-field: x\n')
    expect(fm.name).toBe('a')
  })

  it('缺少 name 抛错', () => {
    expect(() => parseFrontmatter('description: x\n')).toThrow(/name/)
  })
})

describe('parseAgentFile / 内置定义', () => {
  it('内置 5 个代理文件均可解析', () => {
    const files = ['explorer', 'planner', 'executor', 'reviewer', 'orchestrator']
    for (const name of files) {
      const def = parseAgentFile(path.join(BUILTIN_AGENTS_DIR, `${name}.md`))
      expect(def.frontmatter.name).toBe(name)
      expect(def.body.length).toBeGreaterThan(50)
    }
  })

  it('内置 orchestrator 声明 4 个子代理白名单', () => {
    const def = parseAgentFile(path.join(BUILTIN_AGENTS_DIR, 'orchestrator.md'))
    expect(def.frontmatter.agents).toEqual(['explorer', 'planner', 'executor', 'reviewer'])
  })

  it('内置 executor 全量写,其余白名单写', () => {
    const executor = parseAgentFile(path.join(BUILTIN_AGENTS_DIR, 'executor.md'))
    expect(executor.frontmatter.write).toContain('**')
    for (const name of ['explorer', 'planner', 'reviewer']) {
      const def = parseAgentFile(path.join(BUILTIN_AGENTS_DIR, `${name}.md`))
      expect(def.frontmatter.write?.some((w) => w.includes('01-exploration.md') || w.includes('02-plan.md') || w.includes('04-review.md'))).toBe(true)
    }
  })
})

describe('loadAgentDefinitions(用户覆盖)', () => {
  it('用户目录同名覆盖内置,新名字新增', () => {
    const dir = makeTempDir()
    const agentsDir = path.join(dir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      path.join(agentsDir, 'explorer.md'),
      '---\nname: explorer\ndescription: 用户自定义覆盖\n---\n自定义正文',
    )
    writeFileSync(path.join(agentsDir, 'my-agent.md'), '---\nname: my-agent\n---\n自定义代理正文')
    const store = { root: dir, agentDir: dir, agentsDir } as never
    const defs = loadAgentDefinitions(store as never)
    expect(defs.get('explorer')?.frontmatter.description).toBe('用户自定义覆盖')
    expect(defs.get('my-agent')?.body).toBe('自定义代理正文')
    expect(defs.has('planner')).toBe(true) // 内置仍存在
    rmSync(dir, { recursive: true, force: true })
  })

  it('用户文件损坏时跳过并保留内置', () => {
    const dir = makeTempDir()
    const agentsDir = path.join(dir, 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(path.join(agentsDir, 'broken.md'), '没有 frontmatter 的文件')
    const store = { root: dir, agentDir: dir, agentsDir } as never
    const defs = loadAgentDefinitions(store as never)
    expect(defs.has('broken')).toBe(false)
    expect(defs.has('explorer')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('compileWriteMatcher / isWriteAllowed', () => {
  it('省略 write = 纯只读', () => {
    expect(isWriteAllowed('any/file.md', compileWriteMatcher(undefined))).toBe(false)
    expect(isWriteAllowed('any/file.md', compileWriteMatcher([]))).toBe(false)
  })

  it('** = 全量写', () => {
    const m = compileWriteMatcher(['**'])
    expect(isWriteAllowed('deep/nested/file.ts', m)).toBe(true)
    expect(isWriteAllowed('', m)).toBe(true)
  })

  it('精确路径匹配', () => {
    const m = compileWriteMatcher(['04-review.md'])
    expect(isWriteAllowed('04-review.md', m)).toBe(true)
    expect(isWriteAllowed('other.md', m)).toBe(false)
  })

  it('glob 匹配 runId 动态目录(单层 *)', () => {
    const m = compileWriteMatcher(['.wf-runs/*/01-exploration.md'])
    expect(isWriteAllowed('.wf-runs/r1/01-exploration.md', m)).toBe(true)
    expect(isWriteAllowed('.wf-runs/r1/02-plan.md', m)).toBe(false)
    expect(isWriteAllowed('.wf-runs/a/b/01-exploration.md', m)).toBe(false) // * 不跨层
    expect(isWriteAllowed('01-exploration.md', m)).toBe(false)
  })

  it('目录 glob', () => {
    const m = compileWriteMatcher(['docs/**'])
    expect(isWriteAllowed('docs/a.md', m)).toBe(true)
    expect(isWriteAllowed('docs/sub/b.md', m)).toBe(true)
    expect(isWriteAllowed('src/a.ts', m)).toBe(false)
  })

  it('绝对路径 / .. 逃逸一律拒绝', () => {
    const m = compileWriteMatcher(['**'])
    expect(isWriteAllowed('C:/Users/x/secret.md', m)).toBe(false)
    expect(isWriteAllowed('../outside.md', m)).toBe(false)
    expect(isWriteAllowed('..', m)).toBe(false)
  })

  it('win32 反斜杠归一', () => {
    const m = compileWriteMatcher(['docs/**'])
    expect(isWriteAllowed('docs\\a.md', m)).toBe(true)
  })

  it('非法模式编译抛错(不静默放行)', () => {
    expect(() => compileWriteMatcher(['[unclosed'])).toThrow()
  })
})
