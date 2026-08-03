import { createEventStream, eventHandler, HTTPError, readBody, type H3 } from 'h3'
import { addWorkspace, hasApiKey, loadWorkspaces, removeWorkspace, updateWorkspace, type DagPiStore } from '../config.js'
import { PiAgentService } from '../pi/piService.js'

export function registerAgentRoutes(app: H3, store: DagPiStore, pi: PiAgentService): void {
  /* ---------------- 元信息 ---------------- */

  app.get('/api/agent/meta', () => ({
    code: 0,
    message: 'ok',
    data: {
      dagPiRoot: store.root,
      environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    },
  }))

  /* ---------------- 配置 ---------------- */

  // 运行配置(模型/思考级别/是否已配置 key)
  app.get('/api/agent/config', () => ({ code: 0, message: 'ok', data: pi.getConfig() }))

  // 用户手动输入 DeepSeek API key,保存到 .dag-pi/config.json
  app.put(
    '/api/agent/config/key',
    eventHandler(async (event) => {
      const body = await readBody<{ apiKey?: string }>(event)
      const key = body?.apiKey?.trim()
      if (!key) throw HTTPError.status(400, 'API key 不能为空')
      pi.setApiKey(key)
      return { code: 0, message: '已保存', data: pi.getConfig() }
    }),
  )

  app.post(
    '/api/agent/config/model',
    eventHandler(async (event) => {
      const body = await readBody<{ modelId?: string; workspaceId?: string }>(event)
      if (!body?.modelId) throw HTTPError.status(400, '缺少 modelId')
      const config = await pi.setModel(body.workspaceId, body.modelId)
      return { code: 0, message: '已切换模型', data: config }
    }),
  )

  app.post(
    '/api/agent/config/thinking',
    eventHandler(async (event) => {
      const body = await readBody<{ level?: string; workspaceId?: string }>(event)
      if (!body?.level) throw HTTPError.status(400, '缺少 level')
      const config = body.workspaceId
        ? await pi.setThinkingLevel(body.workspaceId, body.level)
        : await pi.setThinkingLevel(undefined, body.level)
      return { code: 0, message: '已切换思考级别', data: config }
    }),
  )

  /* ---------------- 工作区 ---------------- */

  app.get('/api/agent/workspaces', () => ({ code: 0, message: 'ok', data: loadWorkspaces(store) }))

  app.post(
    '/api/agent/workspaces',
    eventHandler(async (event) => {
      const body = await readBody<{ path?: string }>(event)
      if (!body?.path?.trim()) throw HTTPError.status(400, '请输入目录路径')
      const workspace = addWorkspace(store, body.path)
      if (!workspace) throw HTTPError.status(400, '目录不存在或已添加')
      return { code: 0, message: '已添加工作区', data: workspace }
    }),
  )

  app.patch(
    '/api/agent/workspaces/:id',
    eventHandler(async (event) => {
      const body = await readBody<{ readOnly?: boolean }>(event)
      if (typeof body?.readOnly !== 'boolean') throw HTTPError.status(400, '缺少 readOnly')
      const updated = updateWorkspace(store, event.context.params?.id ?? '', { readOnly: body.readOnly })
      if (!updated) throw HTTPError.status(404, '工作区不存在')
      await pi.reopenIfOpen(updated)
      return { code: 0, message: '已更新工作区', data: updated }
    }),
  )

  app.delete(
    '/api/agent/workspaces/:id',
    eventHandler((event) => {
      if (!removeWorkspace(store, event.context.params?.id ?? '')) throw HTTPError.status(404, '工作区不存在')
      return { code: 0, message: '已移除', data: null }
    }),
  )

  /* ---------------- 会话 ---------------- */

  // 打开工作区会话并恢复历史
  app.post(
    '/api/agent/workspaces/:id/open',
    eventHandler(async (event) => {
      const workspace = requireWorkspace(store, event.context.params?.id ?? '')
      const history = await pi.getHistory(workspace)
      return { code: 0, message: 'ok', data: { history, status: pi.getStatus(workspace) } }
    }),
  )

  app.get(
    '/api/agent/workspaces/:id/status',
    eventHandler((event) => {
      const workspace = requireWorkspace(store, event.context.params?.id ?? '')
      return { code: 0, message: 'ok', data: pi.getStatus(workspace) }
    }),
  )

  // 发送消息:SSE 流式返回 agent 事件
  app.post(
    '/api/agent/workspaces/:id/prompt',
    eventHandler(async (event) => {
      const workspace = requireWorkspace(store, event.context.params?.id ?? '')
      if (!hasApiKey(store)) throw HTTPError.status(400, '尚未配置 DeepSeek API key,请在左下角设置中填写')
      const body = await readBody<{ text?: string }>(event)
      const text = body?.text?.trim()
      if (!text) throw HTTPError.status(400, '消息不能为空')

      const stream = createEventStream(event)
      void (async () => {
        try {
          await pi.prompt(workspace, text, (evt) => {
            void stream.push(JSON.stringify(evt)).catch(() => {})
          })
        } finally {
          stream.close()
        }
      })()
      return stream
    }),
  )

  app.post(
    '/api/agent/workspaces/:id/abort',
    eventHandler(async (event) => {
      requireWorkspace(store, event.context.params?.id ?? '')
      await pi.abort(event.context.params?.id ?? '')
      return { code: 0, message: '已中止', data: null }
    }),
  )
}

function requireWorkspace(store: DagPiStore, id: string) {
  const workspace = loadWorkspaces(store).find((w) => w.id === id)
  if (!workspace) throw HTTPError.status(404, '工作区不存在')
  return workspace
}
