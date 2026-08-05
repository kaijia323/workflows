/**
 * 视觉模型配置路由单测(PUT /api/agent/config/vision)。
 *
 * 仿 mcpRoutes.test.ts 的私有构造 hack 模式:mkdtempSync fake store + 私有构造 PiAgentService。
 * 覆盖:保存开关+key 落盘 / 非法 body 400(零写入)/ 空串清空 / 响应不含明文 key /
 * 开关翻转触发 refreshOpenSessions(key-only 变更不触发)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { WorkflowsStore } from '../config.js'
import { PiAgentService } from '../pi/piService.js'
import { registerAgentRoutes } from './routes.js'

function makeStore(): WorkflowsStore {
  const root = mkdtempSync(path.join(tmpdir(), 'wf-visionroute-'))
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
  // runtime stub:getConfig 需要 getModels/getModel(返回空模型列表,其余字段不触达)
  const runtime = {
    getModels: () => [],
    getModel: () => undefined,
  } as unknown as ModelRuntime
  return new (PiAgentService as unknown as new (store: WorkflowsStore, runtime: ModelRuntime) => PiAgentService)(
    store,
    runtime,
  )
}

/** 组装带视觉路由的 Hono app(与 app.ts 一致的统一错误格式化;仅注册,不发真实请求到会话层) */
function makeApp(): { app: Hono; store: WorkflowsStore; pi: PiAgentService } {
  const store = makeStore()
  const pi = makeService(store)
  const app = new Hono()
  registerAgentRoutes(app, store, pi)
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ code: error.status, message: error.message, data: null }, error.status)
    }
    return c.json({ code: 500, message: 'Internal Server Error', data: null }, 500)
  })
  return { app, store, pi }
}

interface ApiBody {
  code: number
  message: string
  data?: Record<string, unknown>
}

async function requestJson(app: Hono, pathName: string, init?: RequestInit): Promise<{ status: number; body: ApiBody }> {
  const res = await app.request(pathName, init)
  const body = (await res.json()) as ApiBody
  return { status: res.status, body }
}

function putVision(app: Hono, payload: unknown): Promise<{ status: number; body: ApiBody }> {
  return requestJson(app, '/api/agent/config/vision', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function diskConfig(store: WorkflowsStore): Record<string, unknown> {
  return JSON.parse(readFileSync(store.configPath, 'utf-8')) as Record<string, unknown>
}

describe('PUT /api/agent/config/vision', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('保存开关 + key:200,config.json 落盘,响应 config 含 visionEnabled/hasVisionApiKey 且无 key 明文', async () => {
    const { app, store } = makeApp()
    const { status, body } = await putVision(app, { enabled: true, apiKey: 'sk-xiaomi-secret' })

    expect(status).toBe(200)
    expect(body.code).toBe(0)
    // 磁盘落盘(明文,既有设计)
    const disk = diskConfig(store)
    expect(disk.visionEnabled).toBe(true)
    expect(disk.visionApiKey).toBe('sk-xiaomi-secret')
    // 响应 config:有开关与 hasVisionApiKey,不含 key 明文
    const data = body.data as Record<string, unknown>
    expect(data.visionEnabled).toBe(true)
    expect(data.hasVisionApiKey).toBe(true)
    expect(JSON.stringify(data)).not.toContain('sk-xiaomi-secret')
    expect('visionApiKey' in data).toBe(false)
  })

  it('enabled 非布尔(缺省/字符串)→ 400 且 config.json 零写入', async () => {
    const { app, store } = makeApp()
    const missing = await putVision(app, { apiKey: 'sk-x' })
    expect(missing.status).toBe(400)
    expect(missing.body.message).toContain('缺少 enabled(布尔)')
    expect(existsSync(store.configPath)).toBe(false)

    const badType = await putVision(app, { enabled: 'yes', apiKey: 'sk-x' })
    expect(badType.status).toBe(400)
    expect(badType.body.message).toContain('缺少 enabled(布尔)')
    expect(existsSync(store.configPath)).toBe(false)
  })

  it('apiKey 非字符串(数字)→ 400 且 config.json 零写入', async () => {
    const { app, store } = makeApp()
    const { status, body } = await putVision(app, { enabled: true, apiKey: 123 })
    expect(status).toBe(400)
    expect(body.message).toBe('apiKey 必须是字符串')
    expect(existsSync(store.configPath)).toBe(false)
  })

  it('空串 apiKey = 清空(磁盘删除字段)', async () => {
    const { app, store } = makeApp()
    await putVision(app, { enabled: true, apiKey: 'sk-x' })
    expect(diskConfig(store).visionApiKey).toBe('sk-x')

    const { status, body } = await putVision(app, { enabled: true, apiKey: '   ' })
    expect(status).toBe(200)
    expect(body.code).toBe(0)
    const disk = diskConfig(store)
    expect(disk.visionApiKey).toBeUndefined()
    expect(disk.visionEnabled).toBe(true)
    expect((body.data as Record<string, unknown>).hasVisionApiKey).toBe(false)
  })

  it('关闭开关也可保存(仅提交 enabled:false;key 保留)', async () => {
    const { app, store } = makeApp()
    await putVision(app, { enabled: true, apiKey: 'sk-x' })
    const { status } = await putVision(app, { enabled: false })
    expect(status).toBe(200)
    const disk = diskConfig(store)
    expect(disk.visionEnabled).toBe(false)
    expect(disk.visionApiKey).toBe('sk-x')
  })

  it('开关翻转触发 refreshOpenSessions;key-only 变更不触发', async () => {
    const { app, pi } = makeApp()
    const refresh = vi.spyOn(pi, 'refreshOpenSessions').mockResolvedValue()

    // 默认关 → 开:翻转,重建一次
    await putVision(app, { enabled: true, apiKey: 'sk-a' })
    expect(refresh).toHaveBeenCalledTimes(1)

    // 开关不变,仅 key 变更:不重建
    await putVision(app, { enabled: true, apiKey: 'sk-b' })
    expect(refresh).toHaveBeenCalledTimes(1)

    // 开 → 关:翻转,再重建
    await putVision(app, { enabled: false })
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
