/**
 * MCP server 管理路由单测(/api/agent/mcp*)。
 *
 * 仿 piService.test.ts 的私有构造 hack 模式:mkdtempSync fake store + 私有构造 PiAgentService。
 * 覆盖:PUT 新增/覆盖/校验失败零写入、DELETE 存在/不存在、GET 配置+状态合并;
 * dispose 行为由 mcpTools.test.ts 覆盖(本文件标注为配置层测试)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { WorkflowsStore } from '../config.js'
import { mcpConfigPath } from '../mcpConfig.js'
import { PiAgentService } from '../pi/piService.js'
import { registerAgentRoutes } from './routes.js'

function makeStore(): WorkflowsStore {
  const root = mkdtempSync(path.join(tmpdir(), 'wf-mcproute-'))
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

function makeService(store: WorkflowsStore): PiAgentService {
  return new (PiAgentService as unknown as new (store: WorkflowsStore, runtime: ModelRuntime) => PiAgentService)(
    store,
    {} as unknown as ModelRuntime,
  )
}



/** 组装带 MCP 路由的 Hono app(含与 app.ts 一致的统一错误格式化;仅注册,不发真实请求到会话层) */
function makeApp(): { app: Hono; store: WorkflowsStore; dir: string; pi: PiAgentService } {
  const store = makeStore()
  const pi = makeService(store)
  const app = new Hono()
  registerAgentRoutes(app, store, pi)
  // 与 app.ts onError 一致:HTTPException → 统一响应结构(否则测试中 400/404 是纯文本)
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ code: error.status, message: error.message, data: null }, error.status)
    }
    return c.json({ code: 500, message: 'Internal Server Error', data: null }, 500)
  })
  return { app, store, dir: store.root, pi }
}

interface ApiBody {
  code: number
  message: string
  data?: unknown
}

async function requestJson(app: Hono, pathName: string, init?: RequestInit): Promise<{ status: number; body: ApiBody }> {
  const res = await app.request(pathName, init)
  const body = (await res.json()) as ApiBody
  return { status: res.status, body }
}

function diskServers(store: WorkflowsStore): unknown {
  return JSON.parse(readFileSync(mcpConfigPath(store), 'utf-8'))
}

describe('/api/agent/mcp* 路由', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('PUT/DELETE 成功后各调用一次 refreshMcpForOpenSessions(保存即生效接线)', async () => {
    const { app, pi } = makeApp()
    const refresh = vi.spyOn(pi, 'refreshMcpForOpenSessions').mockResolvedValue()

    await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node' }),
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    await requestJson(app, '/api/agent/mcp/echo', { method: 'DELETE' })
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('GET 返回配置 + 状态(空配置 → 空列表)', async () => {
    const { app } = makeApp()
    const { status, body } = await requestJson(app, '/api/agent/mcp')
    expect(status).toBe(200)
    expect(body.code).toBe(0)
    const data = body.data as { servers: unknown[]; status: unknown[] }
    expect(data.servers).toEqual([])
    expect(data.status).toEqual([])
  })

  it('PUT 新增:校验通过落盘,返回列表含新项;enabled 缺省语义透传', async () => {
    const { app, store } = makeApp()
    const { status, body } = await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node', args: ['-e', 'x'], enabled: true }),
    })
    expect(status).toBe(200)
    expect(body.code).toBe(0)
    const data = body.data as {
      servers: Array<{ name: string; command: string; enabled: boolean }>
      status: Array<{ name: string; state: string; error?: string; toolCount?: number }>
    }
    expect(data.servers).toHaveLength(1)
    expect(data.servers[0]).toMatchObject({ name: 'echo', command: 'node', enabled: true })
    // 磁盘 mcp.json 内容
    expect(diskServers(store)).toMatchObject({ mcpServers: [{ name: 'echo', command: 'node', args: ['-e', 'x'], enabled: true }] })
    // status 合并:已配置但未连接(manager 无记录)→ enabled 推导为 not_connected(中性,非 error 态)
    expect(data.status).toHaveLength(1)
    expect(data.status[0]).toMatchObject({ name: 'echo', state: 'not_connected', toolCount: 0 })
    expect(data.status[0].error).toBeUndefined()
  })

  it('PUT 重名 → 覆盖更新(upsert 语义,列表长度不变)', async () => {
    const { app } = makeApp()
    await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node', args: ['-e', 'v1'], enabled: true }),
    })
    const { body } = await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'python', enabled: false }),
    })
    const data = body.data as { servers: Array<{ name: string; command: string; enabled: boolean; args?: string[] }> }
    expect(data.servers).toHaveLength(1)
    expect(data.servers[0]).toMatchObject({ command: 'python', enabled: false })
    expect(data.servers[0].args).toBeUndefined()
  })

  it('PUT 非法 name(URL 参数非法)→ 400 且 mcp.json 未变(校验失败零写入)', async () => {
    const { app, store } = makeApp()
    await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node' }),
    })
    const before = readFileSync(mcpConfigPath(store), 'utf-8')
    const { status, body } = await requestJson(app, '/api/agent/mcp/bad%20name', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node' }),
    })
    expect(status).toBe(400)
    expect(body.message).toContain('MCP server 名称非法')
    expect(readFileSync(mcpConfigPath(store), 'utf-8')).toBe(before)
  })

  it('PUT 空 command → 400 且 mcp.json 未变', async () => {
    const { app, store } = makeApp()
    // 先写入合法数据,再验证失败更新零写入
    await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node', args: ['-e', 'x'] }),
    })
    const before = readFileSync(mcpConfigPath(store), 'utf-8')
    const { status, body } = await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: '   ' }),
    })
    expect(status).toBe(400)
    expect(body.message).toContain('缺少启动命令')
    expect(readFileSync(mcpConfigPath(store), 'utf-8')).toBe(before)
  })

  it('PUT args 含非字符串 → 400(零写入)', async () => {
    const { app, store } = makeApp()
    const { status, body } = await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node', args: ['ok', 42] }),
    })
    expect(status).toBe(400)
    expect(body.message).toContain('args 必须是字符串数组')
    // 校验失败零写入:文件未被创建
    expect(existsSync(mcpConfigPath(store))).toBe(false)
  })

  it('PUT args 非数组(如字符串)→ 400(路由透传原始值,校验层统一拒绝,零写入)', async () => {
    const { app, store } = makeApp()
    const { status, body } = await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node', args: 'foo' }),
    })
    expect(status).toBe(400)
    expect(body.message).toContain('args 必须是字符串数组')
    expect(existsSync(mcpConfigPath(store))).toBe(false)
  })

  it('PUT enabled 非布尔(如字符串)→ 400(路由透传原始值,校验层统一拒绝,零写入)', async () => {
    const { app, store } = makeApp()
    const { status, body } = await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node', enabled: 'yes' }),
    })
    expect(status).toBe(400)
    expect(body.message).toContain('enabled 必须是布尔值')
    expect(existsSync(mcpConfigPath(store))).toBe(false)
  })

  it('PUT 新增:env 透传落盘并返回', async () => {
    const { app, store } = makeApp()
    const { status, body } = await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node', args: ['-e', 'x'], enabled: true, env: { DISPLAY: ':0' } }),
    })
    expect(status).toBe(200)
    expect(body.code).toBe(0)
    const data = body.data as {
      servers: Array<{ name: string; command: string; enabled: boolean; env?: Record<string, string> }>
    }
    expect(data.servers).toHaveLength(1)
    expect(data.servers[0]).toMatchObject({ name: 'echo', command: 'node', enabled: true, env: { DISPLAY: ':0' } })
    // 磁盘 mcp.json 内容保留 env
    expect(diskServers(store)).toMatchObject({
      mcpServers: [{ name: 'echo', command: 'node', args: ['-e', 'x'], enabled: true, env: { DISPLAY: ':0' } }],
    })
  })

  it('PUT env 非对象(字符串)→ 400 且 mcp.json 未变', async () => {
    const { app, store } = makeApp()
    await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node' }),
    })
    const before = readFileSync(mcpConfigPath(store), 'utf-8')
    const { status, body } = await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node', env: 'x' }),
    })
    expect(status).toBe(400)
    expect(body.message).toContain('env 必须是字符串键值对对象')
    expect(readFileSync(mcpConfigPath(store), 'utf-8')).toBe(before)
  })

  it('PUT env 值非字符串 → 400 且 mcp.json 未变', async () => {
    const { app, store } = makeApp()
    await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node' }),
    })
    const before = readFileSync(mcpConfigPath(store), 'utf-8')
    const { status, body } = await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node', env: { A: 1 } }),
    })
    expect(status).toBe(400)
    expect(body.message).toContain('env 必须是字符串键值对对象')
    expect(readFileSync(mcpConfigPath(store), 'utf-8')).toBe(before)
  })

  it('PUT 覆盖不带 env → env 被清空(字段级替换语义,与 args 同构)', async () => {
    const { app } = makeApp()
    await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node', env: { DISPLAY: ':0' } }),
    })
    const { body } = await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'python' }),
    })
    const data = body.data as { servers: Array<{ env?: Record<string, string> }> }
    expect(data.servers).toHaveLength(1)
    expect(data.servers[0].env).toBeUndefined()
  })

  it('DELETE 存在 → 200 且列表减少;不存在 → 404', async () => {
    const { app } = makeApp()
    await requestJson(app, '/api/agent/mcp/echo', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'node' }),
    })
    const del = await requestJson(app, '/api/agent/mcp/echo', { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((del.body.data as { servers: unknown[] }).servers).toEqual([])

    const missing = await requestJson(app, '/api/agent/mcp/nope', { method: 'DELETE' })
    expect(missing.status).toBe(404)
    expect(missing.body.message).toContain('不存在')
  })

  it('POST /:name/test:server 不存在 → 404;存在 → 返回 ok/error 结构(不污染缓存)', async () => {
    const { app } = makeApp()
    const missing = await requestJson(app, '/api/agent/mcp/ghost/test', { method: 'POST' })
    expect(missing.status).toBe(404)

    // 配置一个不存在的可执行文件 → 测试返回 { ok: false, error }
    await requestJson(app, '/api/agent/mcp/badcmd', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'no-such-binary-xyz-123' }),
    })
    const tested = await requestJson(app, '/api/agent/mcp/badcmd/test', { method: 'POST' })
    expect(tested.status).toBe(200)
    expect(tested.body.code).toBe(0)
    const data = tested.body.data as { ok: boolean; error?: string }
    expect(data.ok).toBe(false)
    expect(data.error).toBeTruthy()
  })
})
