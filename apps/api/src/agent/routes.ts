import type { Context } from 'hono'
import type { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'
import { addWorkspace, hasApiKey, loadWorkspaces, removeWorkspace, updateWorkspace, type DagPiStore } from '../config.js'
import { PiAgentService } from '../pi/piService.js'

export function registerAgentRoutes(app: Hono, store: DagPiStore, pi: PiAgentService): void {
  /* ---------------- 元信息 ---------------- */

  app.get('/api/agent/meta', (c) =>
    c.json({
      code: 0,
      message: 'ok',
      data: {
        dagPiRoot: store.root,
        environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      },
    }),
  )

  /* ---------------- 配置 ---------------- */

  // 运行配置(模型/思考级别/是否已配置 key)
  app.get('/api/agent/config', (c) => c.json({ code: 0, message: 'ok', data: pi.getConfig() }))

  // 用户手动输入 DeepSeek API key,保存到 .dag-pi/config.json
  app.put('/api/agent/config/key', async (c) => {
    const body = await readJson<{ apiKey?: string }>(c)
    const key = body?.apiKey?.trim()
    if (!key) throw new HTTPException(400, { message: 'API key 不能为空' })
    pi.setApiKey(key)
    return c.json({ code: 0, message: '已保存', data: pi.getConfig() })
  })

  app.post('/api/agent/config/model', async (c) => {
    const body = await readJson<{ modelId?: string; workspaceId?: string }>(c)
    if (!body?.modelId) throw new HTTPException(400, { message: '缺少 modelId' })
    const config = await pi.setModel(body.workspaceId, body.modelId)
    return c.json({ code: 0, message: '已切换模型', data: config })
  })

  app.post('/api/agent/config/thinking', async (c) => {
    const body = await readJson<{ level?: string; workspaceId?: string }>(c)
    if (!body?.level) throw new HTTPException(400, { message: '缺少 level' })
    const config = body.workspaceId
      ? await pi.setThinkingLevel(body.workspaceId, body.level)
      : await pi.setThinkingLevel(undefined, body.level)
    return c.json({ code: 0, message: '已切换思考级别', data: config })
  })

  /* ---------------- 工作区 ---------------- */

  app.get('/api/agent/workspaces', (c) => c.json({ code: 0, message: 'ok', data: loadWorkspaces(store) }))

  app.post('/api/agent/workspaces', async (c) => {
    const body = await readJson<{ path?: string }>(c)
    if (!body?.path?.trim()) throw new HTTPException(400, { message: '请输入目录路径' })
    const workspace = addWorkspace(store, body.path)
    if (!workspace) throw new HTTPException(400, { message: '目录不存在或已添加' })
    return c.json({ code: 0, message: '已添加工作区', data: workspace })
  })

  app.patch('/api/agent/workspaces/:id', async (c) => {
    const body = await readJson<{ readOnly?: boolean }>(c)
    if (typeof body?.readOnly !== 'boolean') throw new HTTPException(400, { message: '缺少 readOnly' })
    const updated = updateWorkspace(store, c.req.param('id'), { readOnly: body.readOnly })
    if (!updated) throw new HTTPException(404, { message: '工作区不存在' })
    await pi.reopenIfOpen(updated)
    return c.json({ code: 0, message: '已更新工作区', data: updated })
  })

  app.delete('/api/agent/workspaces/:id', (c) => {
    if (!removeWorkspace(store, c.req.param('id'))) throw new HTTPException(404, { message: '工作区不存在' })
    return c.json({ code: 0, message: '已移除', data: null })
  })

  /* ---------------- 会话 ---------------- */

  // 打开工作区会话并恢复历史
  app.post('/api/agent/workspaces/:id/open', async (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    const history = await pi.getHistory(workspace)
    return c.json({ code: 0, message: 'ok', data: { history, status: pi.getStatus(workspace) } })
  })

  app.get('/api/agent/workspaces/:id/status', (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    return c.json({ code: 0, message: 'ok', data: pi.getStatus(workspace) })
  })

  // 发送消息:SSE 流式返回 agent 事件
  app.post('/api/agent/workspaces/:id/prompt', async (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    if (!hasApiKey(store)) throw new HTTPException(400, { message: '尚未配置 DeepSeek API key,请在左下角设置中填写' })
    const body = await readJson<{ text?: string }>(c)
    const text = body?.text?.trim()
    if (!text) throw new HTTPException(400, { message: '消息不能为空' })

    return streamSSE(c, async (stream) => {
      await pi.prompt(workspace, text, (evt) => {
        void stream.writeSSE({ data: JSON.stringify(evt) }).catch(() => {})
      })
    })
  })

  app.post('/api/agent/workspaces/:id/abort', async (c) => {
    const id = c.req.param('id')
    requireWorkspace(store, id)
    await pi.abort(id)
    return c.json({ code: 0, message: '已中止', data: null })
  })
}

/** 读取 JSON body,空 body / 非法 JSON 时返回空对象(兼容 h3 readBody 的宽松行为) */
async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T
  } catch {
    return {} as T
  }
}

function requireWorkspace(store: DagPiStore, id: string) {
  const workspace = loadWorkspaces(store).find((w) => w.id === id)
  if (!workspace) throw new HTTPException(404, { message: '工作区不存在' })
  return workspace
}
