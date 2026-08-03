import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addWorkspace, listDirectory, samePath, type WorkflowsStore } from './config.js'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-ls-'))
  tempDirs.push(dir)
  return dir
}

/** 隔离的测试存储(不触碰仓库 .workflows) */
function createTestStore(): WorkflowsStore {
  const root = path.join(makeTempDir(), '.workflows')
  mkdirSync(root, { recursive: true })
  return {
    root,
    agentDir: path.join(root, 'agent'),
    agentsDir: path.join(root, 'agents'),
    configPath: path.join(root, 'config.json'),
    workspacesPath: path.join(root, 'workspaces.json'),
    sessionsPath: path.join(root, 'workspace-sessions.json'),
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('listDirectory', () => {
  it('仅返回子目录,自然排序,隐藏目录也包含', () => {
    const dir = makeTempDir()
    mkdirSync(path.join(dir, 'node_modules'))
    mkdirSync(path.join(dir, 'apps'))
    mkdirSync(path.join(dir, '.git'))
    mkdirSync(path.join(dir, 'pkg-2'))
    mkdirSync(path.join(dir, 'pkg-10'))
    writeFileSync(path.join(dir, 'README.md'), 'x')
    writeFileSync(path.join(dir, 'file.txt'), 'x')

    const listing = listDirectory(dir)

    expect(listing?.entries.map((e) => e.name)).toEqual(['.git', 'apps', 'node_modules', 'pkg-2', 'pkg-10'])
    expect(listing?.parent).toBe(path.dirname(dir))
    expect(listing?.path).toBe(dir)
  })

  it('父目录指向上级;根目录的 parent 为 null', () => {
    const dir = makeTempDir()
    const listing = listDirectory(dir)
    expect(listing?.parent).toBe(path.dirname(dir))

    const root = path.parse(dir).root
    const rootListing = listDirectory(root)
    expect(rootListing?.path).toBe(root)
    expect(rootListing?.parent).toBeNull()
  })

  it('不存在或不可读的目录返回 undefined', () => {
    expect(listDirectory(path.join(makeTempDir(), 'nope'))).toBeUndefined()
    expect(listDirectory('')).toBeUndefined()
  })

  it('自然排序:数字感知且大小写不敏感', () => {
    const dir = makeTempDir()
    for (const n of ['Zeta', 'pkg-10', 'alpha', 'pkg-2', '.hidden', 'Pkg-3']) mkdirSync(path.join(dir, n))

    const listing = listDirectory(dir)

    expect(listing?.entries.map((e) => e.name)).toEqual(['.hidden', 'alpha', 'pkg-2', 'Pkg-3', 'pkg-10', 'Zeta'])
  })

  it('包含符号链接指向的目录,忽略断链', () => {
    const dir = makeTempDir()
    mkdirSync(path.join(dir, 'real'))
    try {
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      symlinkSync(path.join(dir, 'missing'), path.join(dir, 'broken'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      // 平台不支持创建符号链接(如 Windows 未开开发者模式)→ 跳过
      return
    }

    const listing = listDirectory(dir)

    expect(listing?.entries.map((e) => e.name)).toEqual(['link', 'real'])
  })

  it('samePath:Windows/macOS 大小写不敏感,Linux 敏感', () => {
    expect(samePath('C:\\Foo\\Bar', 'c:\\foo\\bar', 'win32')).toBe(true)
    expect(samePath('/Foo/Bar', '/foo/bar', 'darwin')).toBe(true)
    expect(samePath('/Foo/Bar', '/foo/bar', 'linux')).toBe(false)
    expect(samePath('/a/b', '/a/b', 'linux')).toBe(true)
  })

  it('addWorkspace 在大小写不敏感平台上不重复添加同一目录', () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return
    const dir = makeTempDir()
    const store = createTestStore()

    expect(addWorkspace(store, dir)?.path).toBe(path.resolve(dir))
    expect(addWorkspace(store, dir.toUpperCase())).toBeUndefined()
  })
})
