/**
 * 图片上传路由单测(POST /api/agent/workspaces/:id/uploads)。
 *
 * 仿 visionRoutes.test.ts 的私有构造 hack 模式:mkdtempSync fake store + 私有构造 PiAgentService。
 * 覆盖:成功落盘+路径形状 / 体积超限 400(零写盘)/ 非法 mime 400(零写盘)/ 空 body 400 /
 * 只读 403(零写盘)/ 工作区不存在 404 / 文件名字段不可信 / 惰性清理(>30 天旧文件)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { WorkflowsStore } from '../config.js'
import { PiAgentService } from '../pi/piService.js'
import { registerAgentRoutes } from './routes.js'

/** 1×1 PNG(70 字节,合法 PNG 签名 + IHDR) */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_1X1_BASE64, 'base64')

/** 合法 JPEG 魔数(FF D8 FF …) */
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('jfif-payload')])

const UPLOADS_DIR = '.wf-uploads'
const DAY_MS = 24 * 60 * 60 * 1000

function makeStore(): WorkflowsStore {
  const root = mkdtempSync(path.join(tmpdir(), 'wf-uploadroute-'))
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
  const runtime = {
    getModels: () => [],
    getModel: () => undefined,
  } as unknown as ModelRuntime
  return new (PiAgentService as unknown as new (store: WorkflowsStore, runtime: ModelRuntime) => PiAgentService)(
    store,
    runtime,
  )
}

/** 组装带上传路由的 Hono app(与 app.ts 一致的统一错误格式化;仅注册,不发真实请求到会话层) */
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

/** fake store 中注册一个指向真实 mkdtemp 目录的工作区 */
function registerWorkspace(store: WorkflowsStore, readOnly = false): { wsPath: string; wsId: string } {
  const wsPath = mkdtempSync(path.join(tmpdir(), 'wf-upload-ws-'))
  const wsId = 'ws-upload-1'
  writeFileSync(
    store.workspacesPath,
    JSON.stringify({ workspaces: [{ id: wsId, path: wsPath, name: 'upload-ws', readOnly, createdAt: 0 }] }),
  )
  return { wsPath, wsId }
}

interface ApiBody {
  code: number
  message: string
  data?: { path?: string } | null
}

async function requestJson(app: Hono, pathName: string, init?: RequestInit): Promise<{ status: number; body: ApiBody }> {
  const res = await app.request(pathName, init)
  const body = (await res.json()) as ApiBody
  return { status: res.status, body }
}

function postUpload(app: Hono, wsId: string, payload: unknown): Promise<{ status: number; body: ApiBody }> {
  return requestJson(app, `/api/agent/workspaces/${wsId}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

describe('POST /api/agent/workspaces/:id/uploads', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('成功:合法 PNG base64 → 200 + data.path 匹配 .wf-uploads/<uuid>.png,文件落盘且内容一致', async () => {
    const { app, store } = makeApp()
    const { wsPath, wsId } = registerWorkspace(store)
    try {
      const { status, body } = await postUpload(app, wsId, { data: PNG_1X1_BASE64 })
      expect(status).toBe(200)
      expect(body.code).toBe(0)
      expect(body.data?.path).toMatch(/^\.wf-uploads\/[0-9a-f-]{36}\.png$/)
      // 文件落盘:字节与源一致(base64 往返)
      expect(readFileSync(path.join(wsPath, body.data!.path!)).equals(PNG_BYTES)).toBe(true)
      expect(readFileSync(path.join(wsPath, body.data!.path!), 'base64')).toBe(PNG_1X1_BASE64)
    } finally {
      // 清理由 tmpdir 生命周期兜底,不强制 rmSync(避免 win32 打开句柄竞态)
    }
  })

  it('JPEG base64 → .jpeg 落盘(魔数嗅探决定扩展名,非客户端声明)', async () => {
    const { app, store } = makeApp()
    const { wsPath, wsId } = registerWorkspace(store)
    try {
      const { status, body } = await postUpload(app, wsId, { data: JPEG_BYTES.toString('base64') })
      expect(status).toBe(200)
      expect(body.data?.path).toMatch(/^\.wf-uploads\/[0-9a-f-]{36}\.jpeg$/)
      expect(readFileSync(path.join(wsPath, body.data!.path!)).equals(JPEG_BYTES)).toBe(true)
    } finally {
      // 同上
    }
  })

  it('体积超限(粗判阶段,>10MB)→ 400,零写盘', async () => {
    const { app, store } = makeApp()
    const { wsPath, wsId } = registerWorkspace(store)
    try {
      const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41).toString('base64')
      const { status, body } = await postUpload(app, wsId, { data: big })
      expect(status).toBe(400)
      expect(body.message).toContain('图片数据超过大小上限')
      expect(existsSync(path.join(wsPath, UPLOADS_DIR))).toBe(false)
    } finally {
      // 同上
    }
  })

  it('非法 mime(随机字节)→ 400「不支持的图片格式」,零写盘', async () => {
    const { app, store } = makeApp()
    const { wsPath, wsId } = registerWorkspace(store)
    try {
      const { status, body } = await postUpload(app, wsId, { data: Buffer.from('not an image').toString('base64') })
      expect(status).toBe(400)
      expect(body.message).toBe('不支持的图片格式(支持 JPEG/PNG/GIF/WebP)')
      expect(existsSync(path.join(wsPath, UPLOADS_DIR))).toBe(false)
    } finally {
      // 同上
    }
  })

  it('空 body / 缺 data → 400,零写盘', async () => {
    const { app, store } = makeApp()
    const { wsPath, wsId } = registerWorkspace(store)
    try {
      const missing = await postUpload(app, wsId, {})
      expect(missing.status).toBe(400)
      expect(missing.body.message).toBe('缺少图片数据(data)')

      const emptyData = await postUpload(app, wsId, { data: '   ' })
      expect(emptyData.status).toBe(400)
      expect(emptyData.body.message).toBe('缺少图片数据(data)')
      expect(existsSync(path.join(wsPath, UPLOADS_DIR))).toBe(false)
    } finally {
      // 同上
    }
  })

  it('只读工作区 → 403,零写盘', async () => {
    const { app, store } = makeApp()
    const { wsPath, wsId } = registerWorkspace(store, true)
    try {
      const { status, body } = await postUpload(app, wsId, { data: PNG_1X1_BASE64 })
      expect(status).toBe(403)
      expect(body.message).toBe('只读工作区不支持上传图片')
      expect(existsSync(path.join(wsPath, UPLOADS_DIR))).toBe(false)
    } finally {
      // 同上
    }
  })

  it('工作区不存在 → 404', async () => {
    const { app } = makeApp()
    const { status, body } = await postUpload(app, 'ws-nope', { data: PNG_1X1_BASE64 })
    expect(status).toBe(404)
    expect(body.message).toBe('工作区不存在')
  })

  it('文件名字段不可信:body 带 fileName → 响应路径仍为服务端 uuid 名,无 evil 文件', async () => {
    const { app, store } = makeApp()
    const { wsPath, wsId } = registerWorkspace(store)
    try {
      const { status, body } = await postUpload(app, wsId, { data: PNG_1X1_BASE64, fileName: '../../evil.png' })
      expect(status).toBe(200)
      expect(body.data?.path).toMatch(/^\.wf-uploads\/[0-9a-f-]{36}\.png$/)
      expect(body.data?.path).not.toContain('evil')
      expect(existsSync(path.join(wsPath, 'evil.png'))).toBe(false)
      expect(existsSync(path.join(wsPath, '..', 'evil.png'))).toBe(false)
    } finally {
      // 同上
    }
  })

  it('惰性清理:预置 31 天前 mtime 旧文件,本次上传后旧文件被删、新文件保留', async () => {
    const { app, store } = makeApp()
    const { wsPath, wsId } = registerWorkspace(store)
    try {
      const uploadDir = path.join(wsPath, UPLOADS_DIR)
      mkdirSync(uploadDir, { recursive: true })
      const oldFile = path.join(uploadDir, 'old.png')
      writeFileSync(oldFile, PNG_BYTES)
      const past = new Date(Date.now() - 31 * DAY_MS)
      utimesSync(oldFile, past, past)

      const { status, body } = await postUpload(app, wsId, { data: PNG_1X1_BASE64 })
      expect(status).toBe(200)
      // 旧文件被清,新文件保留且内容一致
      expect(existsSync(oldFile)).toBe(false)
      expect(existsSync(path.join(wsPath, body.data!.path!))).toBe(true)
      expect(readFileSync(path.join(wsPath, body.data!.path!)).equals(PNG_BYTES)).toBe(true)
    } finally {
      // 同上
    }
  })

  it('惰性清理:30 天内新文件不受影响', async () => {
    const { app, store } = makeApp()
    const { wsPath, wsId } = registerWorkspace(store)
    try {
      const uploadDir = path.join(wsPath, UPLOADS_DIR)
      mkdirSync(uploadDir, { recursive: true })
      const recent = path.join(uploadDir, 'recent.png')
      writeFileSync(recent, PNG_BYTES)
      const recentTime = new Date(Date.now() - 10 * DAY_MS)
      utimesSync(recent, recentTime, recentTime)

      const { status } = await postUpload(app, wsId, { data: PNG_1X1_BASE64 })
      expect(status).toBe(200)
      expect(existsSync(recent)).toBe(true)
      // 目录内 = 旧保留 + 新上传
      expect(statSync(uploadDir).isDirectory()).toBe(true)
    } finally {
      // 同上
    }
  })
})
