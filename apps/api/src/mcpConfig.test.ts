/**
 * mcp.json 配置存储单测(独立于 config.json,config.test.ts 零改动)。
 *
 * 覆盖:容错 / 存取往返 / 校验失败零写入 / upsert / remove / 原子写。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServerConfig } from '@workflows/shared'
import type { WorkflowsStore } from './config.js'
import { loadMcpServers, mcpConfigPath, removeMcpServer, saveMcpServers, upsertMcpServer } from './mcpConfig.js'

const tempDirs: string[] = []

function makeStore(): WorkflowsStore {
  const root = mkdtempSync(path.join(tmpdir(), 'wf-mcp-'))
  tempDirs.push(root)
  const dir = path.join(root, '.workflows')
  mkdirSync(dir, { recursive: true })
  return {
    root: dir,
    agentDir: path.join(dir, 'agent'),
    agentsDir: path.join(dir, 'agents'),
    skillsDir: path.join(dir, 'skills'),
    configPath: path.join(dir, 'config.json'),
    workspacesPath: path.join(dir, 'workspaces.json'),
    sessionsPath: path.join(dir, 'workspace-sessions.json'),
  }
}

function writeRaw(store: WorkflowsStore, content: string): void {
  writeFileSync(mcpConfigPath(store), content, 'utf-8')
}

function diskContent(store: WorkflowsStore): string {
  return readFileSync(mcpConfigPath(store), 'utf-8')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const validServer: McpServerConfig = { name: 'echo', command: 'node', args: ['-e', 'x'], enabled: true }

describe('loadMcpServers 容错', () => {
  it('文件不存在 → []', () => {
    const store = makeStore()
    expect(loadMcpServers(store)).toEqual([])
  })

  it.each([
    ['空对象', '{}'],
    ['缺 mcpServers', '{"foo": 1}'],
    ['mcpServers 非数组', '{"mcpServers": {"a": 1}}'],
    ['mcpServers 为字符串', '{"mcpServers": "x"}'],
    ['JSON 损坏', '{broken'],
  ])('%s → []', (_label, content) => {
    const store = makeStore()
    writeRaw(store, content)
    expect(loadMcpServers(store)).toEqual([])
  })
})

describe('saveMcpServers 存取往返', () => {
  it('保存后重新加载一致;磁盘内容仅含 mcpServers 键(不含 config.json 字段)', () => {
    const store = makeStore()
    const servers: McpServerConfig[] = [
      { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], enabled: true },
      { name: 'fs', command: 'node', args: ['server.js'] },
    ]
    saveMcpServers(store, servers)
    expect(loadMcpServers(store)).toEqual(servers)
    const parsed = JSON.parse(diskContent(store)) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['mcpServers'])
  })

  it('enabled 缺省时文件中原样缺省(不补写)', () => {
    const store = makeStore()
    saveMcpServers(store, [{ name: 'fs', command: 'node' }])
    expect(diskContent(store)).not.toContain('enabled')
    expect(loadMcpServers(store)).toEqual([{ name: 'fs', command: 'node' }])
  })

  it('env 合法对象:存取往返一致,磁盘保留 env', () => {
    const store = makeStore()
    const env = { DISPLAY: ':0', XAUTHORITY: '/tmp/x' }
    saveMcpServers(store, [{ name: 'browser', command: 'npx', env }])
    expect(loadMcpServers(store)).toEqual([{ name: 'browser', command: 'npx', env }])
    const parsed = JSON.parse(diskContent(store)) as { mcpServers: Array<{ env?: Record<string, string> }> }
    expect(parsed.mcpServers[0].env).toEqual(env)
  })

  it('saveMcpServers 返回传入的 servers', () => {
    const store = makeStore()
    const servers = [validServer]
    expect(saveMcpServers(store, servers)).toBe(servers)
  })
})

describe('校验失败零写入', () => {
  it.each<[string, Record<string, unknown>]>([
    ['空 name', { ...validServer, name: '' }],
    ['含空格 name', { ...validServer, name: 'a b' }],
    ['含点 name', { ...validServer, name: 'a.b' }],
    ['中文 name', { ...validServer, name: '服务' }],
    ['超 40 字符 name', { ...validServer, name: 'a'.repeat(41) }],
    ['空 command', { ...validServer, command: '  ' }],
    ['args 含非字符串', { ...validServer, args: ['ok', 42] }],
    ['enabled 非布尔', { ...validServer, enabled: 'yes' }],
    ['env 非对象(字符串)', { ...validServer, env: 'x' }],
    ['env 为数组', { ...validServer, env: ['A=1'] }],
    ['env 为 null', { ...validServer, env: null }],
    ['env 值非字符串', { ...validServer, env: { A: 1 } }],
    ['env 值为布尔', { ...validServer, env: { A: true } }],
  ])('%s → 抛 Error 且文件内容未变', (_label, bad) => {
    const store = makeStore()
    saveMcpServers(store, [validServer])
    const before = diskContent(store)
    expect(() => saveMcpServers(store, [bad as unknown as McpServerConfig])).toThrow(/MCP server/)
    expect(diskContent(store)).toBe(before)
  })

  it('重名 → 抛 Error 且文件内容未变', () => {
    const store = makeStore()
    saveMcpServers(store, [validServer])
    const before = diskContent(store)
    expect(() => saveMcpServers(store, [validServer, { ...validServer, args: ['y'] }])).toThrow('名称重复')
    expect(diskContent(store)).toBe(before)
  })

  it('文件不存在时校验失败也不创建文件(零写入)', () => {
    const store = makeStore()
    expect(() => saveMcpServers(store, [{ name: 'bad name', command: 'x' }])).toThrow()
    expect(existsSync(mcpConfigPath(store))).toBe(false)
  })
})

describe('upsertMcpServer', () => {
  it('新增:追加到列表末尾', () => {
    const store = makeStore()
    upsertMcpServer(store, validServer)
    const next = upsertMcpServer(store, { name: 'fs', command: 'node' })
    expect(next.map((s) => s.name)).toEqual(['echo', 'fs'])
  })

  it('同 name 覆盖:字段级替换,列表长度不变', () => {
    const store = makeStore()
    upsertMcpServer(store, validServer)
    const next = upsertMcpServer(store, { name: 'echo', command: 'python', enabled: false })
    expect(next).toHaveLength(1)
    expect(next[0]).toEqual({ name: 'echo', command: 'python', enabled: false })
  })

  it('非法输入 → 抛错且文件未变', () => {
    const store = makeStore()
    upsertMcpServer(store, validServer)
    const before = diskContent(store)
    expect(() => upsertMcpServer(store, { name: 'x y', command: 'node' })).toThrow()
    expect(diskContent(store)).toBe(before)
  })
})

describe('removeMcpServer', () => {
  it('存在 → true 且列表减少', () => {
    const store = makeStore()
    saveMcpServers(store, [validServer, { name: 'fs', command: 'node' }])
    expect(removeMcpServer(store, 'echo')).toBe(true)
    expect(loadMcpServers(store).map((s) => s.name)).toEqual(['fs'])
  })

  it('不存在 → false 且文件不变', () => {
    const store = makeStore()
    saveMcpServers(store, [validServer])
    const before = diskContent(store)
    expect(removeMcpServer(store, 'nope')).toBe(false)
    expect(diskContent(store)).toBe(before)
  })

  it('删除最后一个后文件写入空列表(可再追加)', () => {
    const store = makeStore()
    saveMcpServers(store, [validServer])
    expect(removeMcpServer(store, 'echo')).toBe(true)
    expect(loadMcpServers(store)).toEqual([])
    const next = upsertMcpServer(store, { name: 'fs', command: 'node' })
    expect(next.map((s) => s.name)).toEqual(['fs'])
  })
})

describe('原子写', () => {
  it('写入后文件完整可解析,tmp 无残留', () => {
    const store = makeStore()
    saveMcpServers(store, [validServer])
    expect(existsSync(`${mcpConfigPath(store)}.tmp`)).toBe(false)
    expect(() => JSON.parse(diskContent(store))).not.toThrow()
  })

  it('连续写入(含失败)后文件始终完整,tmp 无残留', () => {
    const store = makeStore()
    for (let i = 0; i < 3; i++) {
      saveMcpServers(store, [{ name: `s${i}`, command: 'node' }])
      expect(() => JSON.parse(diskContent(store))).not.toThrow()
      expect(() => saveMcpServers(store, [{ name: 'bad name', command: 'x' }])).toThrow()
      expect(existsSync(`${mcpConfigPath(store)}.tmp`)).toBe(false)
    }
    expect(loadMcpServers(store).map((s) => s.name)).toEqual(['s2'])
  })
})
