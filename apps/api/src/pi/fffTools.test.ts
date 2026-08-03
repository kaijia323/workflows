import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFffFindTool, createFffGrepTool, FffIndexManager } from './fffTools.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

let fixture: string
const tempDirs: string[] = []

async function exec(tool: ToolDefinition, params: Record<string, unknown>): Promise<{ text: string }> {
  const result = (await tool.execute('id', params as never, undefined, undefined, undefined as never)) as {
    content: { type: string; text: string }[]
  }
  return { text: result.content[0]?.text ?? '' }
}

beforeAll(async () => {
  fixture = mkdtempSync(path.join(tmpdir(), 'wf-fff-'))
  tempDirs.push(fixture)
  mkdirSync(path.join(fixture, 'src/lib'), { recursive: true })
  mkdirSync(path.join(fixture, 'src/components'), { recursive: true })
  writeFileSync(path.join(fixture, 'src/index.ts'), 'export const version = "1.0.0"\n// TODO: bump\n')
  writeFileSync(path.join(fixture, 'src/lib/util.ts'), 'export function util() { return 1 }\n// todo: lowercase\n')
  writeFileSync(path.join(fixture, 'src/components/Button.tsx'), 'export function Button() {}\n')
  writeFileSync(path.join(fixture, 'README.md'), 'Read the docs, see TODO list\n')
  // 等待 fff 初始扫描完成
  const manager = new FffIndexManager()
  const finder = manager.get('warmup', fixture)!
  await finder.waitForScan(10_000)
  finder.destroy()
})

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTools(): { find: ToolDefinition; grep: ToolDefinition; dispose: () => void } {
  const manager = new FffIndexManager()
  const finder = manager.get('test', fixture)!
  return {
    find: createFffFindTool(finder, fixture),
    grep: createFffGrepTool(finder, fixture),
    dispose: () => manager.dispose('test'),
  }
}

describe('FffIndexManager', () => {
  it('同一工作区复用同一实例,dispose 释放原生资源', () => {
    const manager = new FffIndexManager()
    const a = manager.get('w1', fixture)
    const b = manager.get('w1', fixture)
    expect(a).toBe(b)
    expect(a).not.toBeNull()
    manager.dispose('w1')
    expect(a!.isDestroyed).toBe(true)
    // dispose 后再取:重新创建
    const c = manager.get('w1', fixture)
    expect(c).not.toBeNull()
    expect(c!.isDestroyed).toBe(false)
    c!.destroy()
  })

  it('创建失败返回 null(不存在的基路径)', () => {
    const manager = new FffIndexManager()
    expect(manager.get('w2', path.join(fixture, 'does-not-exist'))).toBeNull()
  })
})

describe('fff-find', () => {
  it('glob 裸模式归一化:*.ts 匹配任意深度(与内置 fd 语义一致)', async () => {
    const { find, dispose } = makeTools()
    const result = await exec(find, { pattern: '*.ts' })
    const lines = result.text.split('\n')
    expect(lines).toEqual(['src/index.ts', 'src/lib/util.ts'])
    dispose()
  })

  it('glob 跨目录模式', async () => {
    const { find, dispose } = makeTools()
    const result = await exec(find, { pattern: 'src/**/*.ts' })
    expect(result.text.split('\n')).toEqual(['src/index.ts', 'src/lib/util.ts'])
    dispose()
  })

  it('fuzzy 模式容忍拼写错误', async () => {
    const { find, dispose } = makeTools()
    const result = await exec(find, { pattern: 'bttn.tsx', mode: 'fuzzy' })
    expect(result.text.split('\n')).toEqual(['src/components/Button.tsx'])
    dispose()
  })

  it('path 限定子目录', async () => {
    const { find, dispose } = makeTools()
    const result = await exec(find, { pattern: '**/*', path: 'src/lib' })
    expect(result.text.split('\n')).toEqual(['src/lib/util.ts'])
    dispose()
  })

  it('path 归一化:./ 前缀、尾斜杠、点号、绝对路径等价', async () => {
    const { find, dispose } = makeTools()
    for (const p of ['src/lib', './src/lib', 'src/lib/']) {
      const result = await exec(find, { pattern: '**/*', path: p })
      expect(result.text.split('\n'), p).toEqual(['src/lib/util.ts'])
    }
    const root = await exec(find, { pattern: '**/*', path: '.' })
    expect(root.text).toContain('src/index.ts')
    // 绝对路径(正/反斜杠)
    for (const p of [path.join(fixture, 'src', 'lib'), path.join(fixture, 'src', 'lib').replace(/\\/g, '/')]) {
      const result = await exec(find, { pattern: '**/*', path: p })
      expect(result.text.split('\n'), p).toEqual(['src/lib/util.ts'])
    }
    dispose()
  })

  it('limit 截断并提示', async () => {
    const { find, dispose } = makeTools()
    const result = await exec(find, { pattern: '**/*', limit: 2 })
    const pathLines = result.text.split('\n').filter((l) => l !== '' && !l.startsWith('['))
    expect(pathLines.length).toBe(2)
    expect(result.text).toMatch(/\[2 results limit reached\]/)
    dispose()
  })

  it('无匹配返回 No files found', async () => {
    const { find, dispose } = makeTools()
    const result = await exec(find, { pattern: '*.zzz' })
    expect(result.text).toBe('No files found matching pattern')
    dispose()
  })
})

describe('fff-grep', () => {
  it('plain 模式输出 path:line: content(默认大小写敏感)', async () => {
    const { grep, dispose } = makeTools()
    const result = await exec(grep, { pattern: 'TODO' })
    const lines = result.text.split('\n')
    expect(lines).toContain('src/index.ts:2: // TODO: bump')
    expect(lines).toContain('README.md:1: Read the docs, see TODO list')
    // 小写 todo 不命中(默认敏感)
    expect(result.text).not.toContain('src/lib/util.ts')
    dispose()
  })

  it('regex 模式', async () => {
    const { grep, dispose } = makeTools()
    const result = await exec(grep, { pattern: 'bump|lowercase' })
    expect(result.text.split('\n')).toEqual(['src/index.ts:2: // TODO: bump', 'src/lib/util.ts:2: // todo: lowercase'])
    dispose()
  })

  it('ignoreCase 忽略大小写(?i 内联标志)', async () => {
    const { grep, dispose } = makeTools()
    const result = await exec(grep, { pattern: 'todo', ignoreCase: true })
    expect(result.text).toContain('src/index.ts:2:')
    expect(result.text).toContain('src/lib/util.ts:2:')
    dispose()
  })

  it('literal + ignoreCase 组合(转义后走 regex)', async () => {
    const { grep, dispose } = makeTools()
    const result = await exec(grep, { pattern: 'version', literal: true, ignoreCase: true })
    expect(result.text).toContain('src/index.ts:1: export const version = "1.0.0"')
    dispose()
  })

  it('context 上下文行(path-line- 前缀)', async () => {
    const { grep, dispose } = makeTools()
    const result = await exec(grep, { pattern: 'export const version', context: 1 })
    expect(result.text.split('\n')).toEqual(['src/index.ts:1: export const version = "1.0.0"', 'src/index.ts-1- // TODO: bump'])
    dispose()
  })

  it('path 限定搜索目录', async () => {
    const { grep, dispose } = makeTools()
    // src/lib/util.ts 里是小写 todo(默认大小写敏感,只命中它)
    const result = await exec(grep, { pattern: 'todo', path: 'src/lib' })
    expect(result.text).toContain('src/lib/util.ts')
    expect(result.text).not.toContain('src/index.ts')
    expect(result.text).not.toContain('README.md')
    dispose()
  })

  it('path 归一化:./ 前缀、点号、绝对路径等价于不传/限定子树', async () => {
    const { grep, dispose } = makeTools()
    // '.' 等价于不传
    const dot = await exec(grep, { pattern: 'TODO', path: '.' })
    const none = await exec(grep, { pattern: 'TODO' })
    expect(dot.text).toBe(none.text)
    // './src/lib' 与 'src/lib' 等价
    const a = await exec(grep, { pattern: 'todo', path: 'src/lib' })
    const b = await exec(grep, { pattern: 'todo', path: './src/lib' })
    expect(a.text).toBe(b.text)
    // 绝对路径(正/反斜杠)
    for (const p of [path.join(fixture, 'src', 'lib'), path.join(fixture, 'src', 'lib').replace(/\\/g, '/')]) {
      const result = await exec(grep, { pattern: 'todo', path: p })
      expect(result.text, p).toBe(a.text)
    }
    dispose()
  })

  it('path 大小写不敏感(win32)', async () => {
    const { grep, dispose } = makeTools()
    if (process.platform === 'win32') {
      const result = await exec(grep, { pattern: 'todo', path: 'SRC/LIB' })
      expect(result.text).toContain('src/lib/util.ts')
    }
    dispose()
  })

  it('glob 限定文件类型', async () => {
    const { grep, dispose } = makeTools()
    const result = await exec(grep, { pattern: 'TODO', glob: '*.ts' })
    expect(result.text).not.toContain('README.md')
    expect(result.text).toContain('src/index.ts')
    dispose()
  })

  it('limit 截断并提示(可翻倍续查)', async () => {
    const { grep, dispose } = makeTools()
    const result = await exec(grep, { pattern: 'TODO', limit: 1 })
    // 结果按 frecency 排序,不假设首个文件;只验证单条 + 提示
    const matchLines = result.text.split('\n').filter((l) => l.includes(':') && !l.startsWith('['))
    expect(matchLines.length).toBe(1)
    expect(result.text).toMatch(/\[1 matches limit reached\. Use limit=2 for more, or refine pattern\]/)
    dispose()
  })

  it('无匹配返回 No matches found', async () => {
    const { grep, dispose } = makeTools()
    const result = await exec(grep, { pattern: 'NOTHING_MATCHES' })
    expect(result.text).toBe('No matches found')
    dispose()
  })
})
