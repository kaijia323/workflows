import type { Context } from 'hono'
import type { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'
import { homedir } from 'node:os'
import path from 'node:path'
import type { HistoryItem, McpServerConfig, McpServerStatus, McpToolInfo } from '@workflows/shared'
import { addWorkspace, getActiveSession, getSession, hasApiKey, listDirectory, loadWorkspaces, removeWorkspace, updateWorkspace, type WorkflowsStore } from '../config.js'
import { loadMcpServers, removeMcpServer, upsertMcpServer } from '../mcpConfig.js'
import { testMcpServer } from '../pi/mcpTools.js'
import { PiAgentService } from '../pi/piService.js'

export function registerAgentRoutes(app: Hono, store: WorkflowsStore, pi: PiAgentService): void {
  /* ---------------- 元信息 ---------------- */

  app.get('/api/agent/meta', (c) =>
    c.json({
      code: 0,
      message: 'ok',
      data: {
        workflowsRoot: store.root,
        environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      },
    }),
  )

  /* ---------------- 配置 ---------------- */

  // 运行配置(模型/思考级别/是否已配置 key)
  app.get('/api/agent/config', (c) => c.json({ code: 0, message: 'ok', data: pi.getConfig() }))

  // 用户手动输入 DeepSeek API key,保存到 .workflows/config.json
  app.put('/api/agent/config/key', async (c) => {
    const body = await readJson<{ apiKey?: string }>(c)
    const key = body?.apiKey?.trim()
    if (!key) throw new HTTPException(400, { message: 'API key 不能为空' })
    pi.setApiKey(key)
    return c.json({ code: 0, message: '已保存', data: pi.getConfig() })
  })

  // 用户手动输入 AnySearch API key,保存到 .workflows/config.json(空串=清空;key 明文不返回前端)
  app.put('/api/agent/config/anysearch-key', async (c) => {
    const body = await readJson<{ apiKey?: string }>(c)
    const raw = body?.apiKey
    const key = typeof raw === 'string' ? raw.trim() : ''
    pi.setAnySearchApiKey(key)
    return c.json({ code: 0, message: '已保存', data: pi.getConfig() })
  })

  // 视觉模型配置(开关 + 小米 key;空串 apiKey=清空;key 明文不返回前端;开关翻转触发已打开会话重建)
  app.put('/api/agent/config/vision', async (c) => {
    const body = await readJson<{ enabled?: unknown; apiKey?: unknown }>(c)
    if (typeof body?.enabled !== 'boolean') throw new HTTPException(400, { message: '缺少 enabled(布尔)' })
    const rawKey = body.apiKey
    if (rawKey !== undefined && typeof rawKey !== 'string') throw new HTTPException(400, { message: 'apiKey 必须是字符串' })
    const apiKey = typeof rawKey === 'string' ? rawKey.trim() : undefined
    await pi.setVisionConfig({ enabled: body.enabled, apiKey })
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

  /* ---------------- MCP server 管理(独立 mcp.json;与 config 区段解耦) ---------------- */

  // 配置 + 运行时状态按 name 合并:已连接/尝试过的 server 用 manager 状态;
  // 其余由配置推导:disabled 或 not_connected(已启用但从未尝试连接,中性提示,非错误态)
  function mcpOverview(): { servers: McpServerConfig[]; status: McpServerStatus[] } {
    const servers = loadMcpServers(store)
    const statusByName = new Map(pi.getMcpStatus().map((s) => [s.name, s]))
    const status: McpServerStatus[] = servers.map((server) => {
      const existing = statusByName.get(server.name)
      if (existing) return existing
      return {
        name: server.name,
        state: server.enabled === true ? 'not_connected' : 'disabled',
        error: undefined,
        toolCount: 0,
        lastCheckedAt: null,
      }
    })
    return { servers, status }
  }

  // 配置列表 + 运行时状态
  app.get('/api/agent/mcp', (c) => c.json({ code: 0, message: 'ok', data: mcpOverview() }))

  // 新增/更新 server(upsert 语义;name 以 URL 参数为准;校验失败 400 零写入)
  app.put('/api/agent/mcp/:name', async (c) => {
    const name = c.req.param('name')
    const raw = await readJson<{ command?: unknown; args?: unknown; enabled?: unknown; env?: unknown }>(c)
    const server: McpServerConfig = {
      name,
      command: typeof raw?.command === 'string' ? raw.command : '',
      // 透传原始值:args/enabled/env 不做类型收窄,由存储层 validateMcpServers 统一校验
      // (非数组 args / 非布尔 enabled / 非对象 env → 400,校验失败零写入)
      args: raw?.args as string[] | undefined,
      enabled: raw?.enabled as boolean | undefined,
      env: raw?.env as Record<string, string> | undefined,
    }
    try {
      upsertMcpServer(store, server)
    } catch (error) {
      throw new HTTPException(400, { message: error instanceof Error ? error.message : String(error) })
    }
    // 断旧连接 + 清缓存,再重建已打开会话:保存即生效(空闲立即重建,忙碌挂起下回合生效)
    await pi.disposeMcpServer(name)
    await pi.refreshMcpForOpenSessions()
    return c.json({ code: 0, message: '已保存 MCP server', data: mcpOverview() })
  })

  // 删除 server(404 若不存在)+ 断开连接
  app.delete('/api/agent/mcp/:name', async (c) => {
    const name = c.req.param('name')
    if (!removeMcpServer(store, name)) throw new HTTPException(404, { message: `MCP server「${name}」不存在` })
    // 断旧连接 + 清缓存,再重建已打开会话:保存即生效(空闲立即重建,忙碌挂起下回合生效)
    await pi.disposeMcpServer(name)
    await pi.refreshMcpForOpenSessions()
    return c.json({ code: 0, message: '已删除', data: mcpOverview() })
  })

  // 一次性测试连接(connect + listTools + close):不污染 manager 缓存、不注册进会话;
  // testMcpServer 内部已含 10s connect + 10s list 超时,外层再加 15s 整体上限兜底
  app.post('/api/agent/mcp/:name/test', async (c) => {
    const name = c.req.param('name')
    const server = loadMcpServers(store).find((s) => s.name === name)
    if (!server) throw new HTTPException(404, { message: `MCP server「${name}」不存在` })
    let result: { ok: true; tools: McpToolInfo[] } | { ok: false; error: string }
    try {
      result = await withTimeout(testMcpServer(server), 15_000, '测试超时(15000ms)')
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return c.json({ code: 0, message: result.ok ? 'ok' : '连接失败', data: result })
  })

  /* ---------------- 工作区 ---------------- */

  // 目录浏览:添加工作区时的选择器数据源。本地开发工具,agent 本就可读全盘,故无额外鉴权。
  app.get('/api/agent/fs/list', (c) => {
    const raw = c.req.query('path')?.trim()
    const dir = raw ? path.resolve(raw) : homedir()
    const listing = listDirectory(dir)
    if (!listing) throw new HTTPException(400, { message: '目录不存在或不可读' })
    return c.json({ code: 0, message: 'ok', data: listing })
  })

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

  app.delete('/api/agent/workspaces/:id', async (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    await pi.cleanupWorkspaceSessions(workspace)
    if (!removeWorkspace(store, workspace.id)) throw new HTTPException(404, { message: '工作区不存在' })
    return c.json({ code: 0, message: '已移除', data: null })
  })

  /* ---------------- 会话(一个工作区多个持久化会话,可切换) ---------------- */

  // 会话列表(含激活会话)
  app.get('/api/agent/workspaces/:id/sessions', (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    const sessions = pi.listSessionMetas(workspace)
    const activeSessionId = sessions.find((s) => s.id === getActiveSession(store, workspace.id)?.id)?.id ?? null
    return c.json({ code: 0, message: 'ok', data: { sessions, activeSessionId } })
  })

  // 新建会话:旧会话 JSONL 全部保留,新会话成为当前会话
  app.post('/api/agent/workspaces/:id/sessions', async (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    const handle = await pi.createSession(workspace)
    return c.json({
      code: 0,
      message: '已新建会话',
      data: {
        history: renderEmptyHistory(),
        status: pi.getStatus(workspace),
        sessions: pi.listSessionMetas(workspace),
        activeSessionId: handle.sessionId,
      },
    })
  })

  // 切换会话:加载该会话历史并激活
  app.post('/api/agent/workspaces/:id/sessions/:sessionId', async (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    const sessionId = c.req.param('sessionId')
    if (!getSession(store, workspace.id, sessionId)) throw new HTTPException(404, { message: '会话不存在' })
    const history = await pi.switchSession(workspace, sessionId)
    return c.json({
      code: 0,
      message: '已切换会话',
      data: {
        history,
        status: pi.getStatus(workspace),
        sessions: pi.listSessionMetas(workspace),
        activeSessionId: sessionId,
      },
    })
  })

  // 删除会话(删 JSONL;若删的是激活会话,自动激活剩余最新会话)
  app.delete('/api/agent/workspaces/:id/sessions/:sessionId', async (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    const sessionId = c.req.param('sessionId')
    await pi.deleteSession(workspace, sessionId)
    const sessions = pi.listSessionMetas(workspace)
    const activeSessionId = sessions.find((s) => s.id === getActiveSession(store, workspace.id)?.id)?.id ?? null
    return c.json({ code: 0, message: '已删除会话', data: { sessions, activeSessionId } })
  })

  /* ---------------- 会话 ---------------- */

  // 工作区可用 skills 列表(输入框 / 搜索数据源;每次现扫,新增 skill 立即可见)
  app.get('/api/agent/workspaces/:id/skills', (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    return c.json({ code: 0, message: 'ok', data: pi.listSkills(workspace) })
  })

  // 打开工作区会话并恢复历史
  app.post('/api/agent/workspaces/:id/open', async (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    const history = await pi.getHistory(workspace)
    const sessions = pi.listSessionMetas(workspace)
    const activeSessionId = sessions.find((s) => s.id === getActiveSession(store, workspace.id)?.id)?.id ?? null
    return c.json({ code: 0, message: 'ok', data: { history, status: pi.getStatus(workspace), sessions, activeSessionId } })
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

  /* ---------------- 工作流 run ---------------- */

  // 当前(或最近)run 快照:前端 / 断连恢复重建 DAG 图与闸门状态
  app.get('/api/agent/workspaces/:id/run', (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    const sessionId = getActiveSession(store, workspace.id)?.id ?? null
    if (!sessionId) return c.json({ code: 0, message: 'ok', data: null })
    return c.json({ code: 0, message: 'ok', data: pi.getRunSnapshot(workspace, sessionId) })
  })

  // 子代理调用历史(模态窗回看):从 sub JSONL 恢复渲染
  app.get('/api/agent/workspaces/:id/run/agents/:callId', async (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    const sessionId = getActiveSession(store, workspace.id)?.id ?? null
    if (!sessionId) throw new HTTPException(404, { message: '会话不存在' })
    const history = await pi.getSubAgentHistory(workspace, sessionId, c.req.param('callId'))
    return c.json({ code: 0, message: 'ok', data: history })
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

/** Promise.race 超时包装:超时 reject 中文文案(原 promise 的 rejection 被吞掉,防 unhandledRejection) */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function requireWorkspace(store: WorkflowsStore, id: string) {
  const workspace = loadWorkspaces(store).find((w) => w.id === id)
  if (!workspace) throw new HTTPException(404, { message: '工作区不存在' })
  return workspace
}

/** 空历史(新建会话时使用) */
function renderEmptyHistory(): HistoryItem[] {
  return []
}
