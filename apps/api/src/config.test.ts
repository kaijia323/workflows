import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addWorkspace,
  getVisionEnabled,
  hasVisionApiKey,
  listDirectory,
  loadConfig,
  samePath,
  setVisionConfig,
  visionAvailable,
  type WorkflowsStore,
} from './config.js'

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
    skillsDir: path.join(root, 'skills'),
    configPath: path.join(root, 'config.json'),
    workspacesPath: path.join(root, 'workspaces.json'),
    sessionsPath: path.join(root, 'workspace-sessions.json'),
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
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

describe('vision 配置(visionEnabled / visionApiKey)', () => {
  it('setVisionConfig 持久化开关与 key;getVisionEnabled 默认关', () => {
    const store = createTestStore()
    expect(getVisionEnabled(store)).toBe(false)
    expect(hasVisionApiKey(store)).toBe(false)
    expect(visionAvailable(store)).toBe(false)

    setVisionConfig(store, { enabled: true, apiKey: 'sk-xiaomi-123' })

    const stored = loadConfig(store)
    expect(stored.visionEnabled).toBe(true)
    expect(stored.visionApiKey).toBe('sk-xiaomi-123')
    expect(getVisionEnabled(store)).toBe(true)
    expect(hasVisionApiKey(store)).toBe(true)
    expect(visionAvailable(store)).toBe(true)
  })

  it('空串 apiKey = 删除(复用 saveConfig 语义)', () => {
    const store = createTestStore()
    setVisionConfig(store, { enabled: true, apiKey: 'sk-x' })
    setVisionConfig(store, { enabled: true, apiKey: '' })

    expect(loadConfig(store).visionApiKey).toBeUndefined()
    expect(loadConfig(store).visionEnabled).toBe(true)
    expect(hasVisionApiKey(store)).toBe(false)
    expect(visionAvailable(store)).toBe(false)
  })

  it('visionAvailable 门 = 开关开 && 有 key(env XIAOMI_API_KEY 或配置 key)', () => {
    const store = createTestStore()
    // 开关关 + key → false
    setVisionConfig(store, { enabled: false, apiKey: 'sk-x' })
    expect(visionAvailable(store)).toBe(false)
    // 开关开 + 无 key → false
    setVisionConfig(store, { enabled: true, apiKey: '' })
    expect(visionAvailable(store)).toBe(false)
    // 开关开 + 配置 key → true
    setVisionConfig(store, { apiKey: 'sk-x' })
    expect(visionAvailable(store)).toBe(true)
  })

  it('env XIAOMI_API_KEY 优先:注入后 hasVisionApiKey/visionAvailable 为 true,卸载后回退配置', () => {
    const store = createTestStore()
    // 无 env、无配置 → false
    expect(hasVisionApiKey(store)).toBe(false)

    vi.stubEnv('XIAOMI_API_KEY', 'env-key')
    setVisionConfig(store, { enabled: true })
    expect(hasVisionApiKey(store)).toBe(true)
    expect(visionAvailable(store)).toBe(true)

    vi.unstubAllEnvs()
    // env 卸载后回退配置:配置无 key → false
    expect(hasVisionApiKey(store)).toBe(false)
    expect(visionAvailable(store)).toBe(false)
    // 配置 key 兜底
    setVisionConfig(store, { apiKey: 'sk-cfg' })
    expect(hasVisionApiKey(store)).toBe(true)
    expect(visionAvailable(store)).toBe(true)
  })
})
