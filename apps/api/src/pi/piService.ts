import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  createBashTool,
  createCodingTools,
  createReadOnlyTools,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { createWorkspaceBashHook, guardPathTool, toToolDefinition } from './workspaceGuard.js'
import type {
  AgentConfig,
  HistoryBlock,
  HistoryItem,
  SessionEvent,
  SessionMeta,
  SessionStatus,
  Workspace,
} from '@workflows/shared'
import {
  createStore,
  getActiveSession,
  getSession,
  hasApiKey,
  listSessions,
  loadConfig,
  migrateSessionsLayout,
  mutateSessions,
  removeSession,
  removeWorkspaceSessions,
  sessionDirFor,
  sessionFileFor,
  setApiKey,
  updateSessionMeta,
  type WorkflowsStore,
} from '../config.js'

const DEFAULT_MODEL = 'deepseek-v4-flash'
const ALL_THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

interface SessionHandle {
  workspace: Workspace
  /** 当前打开的会话 id */
  sessionId: string
  session: AgentSession
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }
  busy: boolean
  lastActivityAt: number | null
}

/**
 * pi SDK 服务层:
 * - 使用 pi SDK(与 pi CLI 无关),不读取/修改任何 pi 全局配置(~/.pi/agent)
 * - ModelRuntime 的 auth/models 路径全部隔离到 .workflows/agent 下
 * - DeepSeek API key 由用户手动输入,保存在 .workflows/config.json,运行时注入
 * - 每个工作区一个持久化会话(上下文严格限定在该工作区目录)
 */
export class PiAgentService {
  private readonly store: WorkflowsStore
  private readonly runtime: ModelRuntime
  private readonly handles = new Map<string, SessionHandle>()

  private constructor(store: WorkflowsStore, runtime: ModelRuntime) {
    this.store = store
    this.runtime = runtime
  }

  static async create(): Promise<PiAgentService> {
    const store = createStore()
    // 旧版平铺会话文件 → sessions/<workspaceId>/ 子目录迁移
    migrateSessionsLayout(store)
    const runtime = await ModelRuntime.create({
      authPath: path.join(store.agentDir, 'auth.json'),
      modelsPath: path.join(store.agentDir, 'models.json'),
    })
    const config = loadConfig(store)
    if (config.apiKey) {
      runtime.setRuntimeApiKey('deepseek', config.apiKey)
    }
    return new PiAgentService(store, runtime)
  }

  /* ---------------- 配置 ---------------- */

  /** 保存用户手动输入的 API key(仅存 .workflows/config.json,运行时注入,不写任何 pi 配置) */
  setApiKey(key: string): void {
    setApiKey(this.store, key)
    this.runtime.setRuntimeApiKey('deepseek', key.trim())
  }

  getConfig(): AgentConfig {
    const stored = loadConfig(this.store)
    const models = this.listModels()
    const current = stored.model ?? DEFAULT_MODEL
    const model = this.runtime.getModel('deepseek', current) ?? models[0]
    const thinkingLevels = model ? this.availableThinkingLevels(model) : ['off']
    const thinkingLevel = stored.thinkingLevel ?? 'off'
    return {
      hasApiKey: hasApiKey(this.store),
      model: model?.id ?? DEFAULT_MODEL,
      thinkingLevel: thinkingLevels.includes(thinkingLevel as ModelThinkingLevel) ? thinkingLevel : 'off',
      models: models.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: m.reasoning,
      })),
      thinkingLevels,
    }
  }

  async setModel(workspaceId: string | undefined, modelId: string): Promise<AgentConfig> {
    const model = this.runtime.getModel('deepseek', modelId)
    if (!model) throw new Error(`未知模型:${modelId}`)
    const handle = workspaceId ? this.handles.get(workspaceId) : undefined
    if (handle) {
      await handle.session.setModel(model)
    }
    this.storeConfig({ model: modelId })
    return this.getConfig()
  }

  async setThinkingLevel(workspaceId: string | undefined, level: string): Promise<AgentConfig> {
    const handle = workspaceId ? this.handles.get(workspaceId) : undefined
    if (handle) {
      handle.session.setThinkingLevel(level as ModelThinkingLevel)
    }
    this.storeConfig({ thinkingLevel: level })
    return this.getConfig()
  }

  /** 保存模型/思考级别到 .workflows/config.json(不落任何 pi 配置) */
  private storeConfig(patch: { model?: string; thinkingLevel?: string }): void {
    const file = this.store.configPath
    const current = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>) : {}
    writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2) + '\n', 'utf-8')
  }

  private listModels(): Model<Api>[] {
    return [...this.runtime.getModels('deepseek')]
  }

  private availableThinkingLevels(model: Model<Api>): string[] {
    const map = model.thinkingLevelMap
    if (!map) return ['off', ...ALL_THINKING_LEVELS.filter((l) => l !== 'off')]
    return ALL_THINKING_LEVELS.filter((level) => map[level] !== null)
  }

  /* ---------------- 会话 ---------------- */

  /**
   * 打开工作区会话。
   * - sessionId 缺省:打开激活会话;尚无任何会话时自动创建并注册
   * - 已打开同 id 会话直接复用;打开不同 id 时先释放旧会话(旧 JSONL 不动)
   */
  private async openSession(workspace: Workspace, sessionId?: string): Promise<SessionHandle> {
    const existing = this.handles.get(workspace.id)
    const targetId = sessionId ?? getActiveSession(this.store, workspace.id)?.id ?? null
    if (existing) {
      if (existing.sessionId === targetId) return existing
      existing.session.dispose()
      this.handles.delete(workspace.id)
    }

    const stored = loadConfig(this.store)
    const model = this.runtime.getModel('deepseek', stored.model ?? DEFAULT_MODEL) ?? undefined
    // 会话文件按工作区隔离在 .workflows/agent/sessions/<workspaceId>/ 下,
    // 绝不写入用户全局 ~/.pi/agent/sessions
    const sessionDir = sessionDirFor(this.store, workspace.id)
    const sessionFile = targetId ? sessionFileFor(this.store, workspace.id, targetId) : undefined
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile)
      : // 关键:显式指定 sessionDir,会话文件落在 .workflows/agent/sessions 下,
      // 绝不写入用户全局 ~/.pi/agent/sessions
      SessionManager.create(workspace.path, sessionDir)

    // 工作区边界守卫:所有工具都无法逃逸到工作区目录之外
    // - bash:createBashTool 注入 spawnHook,unbash 解析命令静态审计(重定向/文件命令/cd/嵌套替换)
    // - read/write/edit/grep/find/ls:包装 execute,参数路径先校验
    const guardedTools: ToolDefinition[] = workspace.readOnly
      ? createReadOnlyTools(workspace.path).map((tool) => guardPathTool(toToolDefinition(tool), workspace.path))
      : [
          ...createCodingTools(workspace.path)
            .filter((tool) => tool.name !== 'bash')
            .map((tool) => guardPathTool(toToolDefinition(tool), workspace.path)),
          toToolDefinition(createBashTool(workspace.path, { spawnHook: createWorkspaceBashHook(workspace.path) })),
        ]

    const { session } = await createAgentSession({
      cwd: workspace.path,
      agentDir: this.store.agentDir,
      modelRuntime: this.runtime,
      model,
      thinkingLevel: (stored.thinkingLevel as ModelThinkingLevel | undefined) ?? 'off',
      sessionManager,
      customTools: guardedTools,
      // 权限:只读工作区仅暴露只读工具,其余用默认工具(read/bash/edit/write),cwd 均绑定工作区
      tools: workspace.readOnly ? ['read', 'grep', 'find', 'ls'] : undefined,
    })

    // 注册/回填会话条目:新建的会话文件路径写回存储,消息数同步
    const finalId = targetId ?? randomUUID()
    const actualFile = session.sessionFile ?? sessionFile
    if (actualFile) {
      mutateSessions(this.store, workspace.id, (state) => {
        const meta = state.sessions[finalId]
        if (meta) {
          if (meta.sessionFile !== actualFile) meta.sessionFile = actualFile
          meta.messageCount = session.messages.length
        } else {
          state.sessions[finalId] = {
            id: finalId,
            sessionFile: actualFile,
            createdAt: Date.now(),
            messageCount: session.messages.length,
          }
        }
        state.active = finalId
      })
    }

    const handle: SessionHandle = {
      workspace,
      sessionId: finalId,
      session,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
      busy: false,
      lastActivityAt: null,
    }
    this.handles.set(workspace.id, handle)
    return handle
  }

  /** 切换工作区权限(只读/读写),已打开的会话需重建工具集 */
  async reopenIfOpen(workspace: Workspace): Promise<void> {
    const handle = this.handles.get(workspace.id)
    if (!handle) return
    handle.session.dispose()
    this.handles.delete(workspace.id)
    await this.openSession(workspace)
  }

  /** 新建会话:保留旧会话(JSONL 不动),创建全新会话并激活 */
  async createSession(workspace: Workspace): Promise<SessionHandle> {
    const existing = this.handles.get(workspace.id)
    if (existing) {
      if (existing.busy) await existing.session.abort()
      existing.session.dispose()
      this.handles.delete(workspace.id)
    }
    // 先注册空条目并激活,openSession 会创建新 JSONL 并回填路径
    const newId = randomUUID()
    mutateSessions(this.store, workspace.id, (state) => {
      state.sessions[newId] = { id: newId, sessionFile: '', createdAt: Date.now(), messageCount: 0 }
      state.active = newId
    })
    return this.openSession(workspace, newId)
  }

  /** 切换到指定会话(历史已持久化,直接加载) */
  async switchSession(workspace: Workspace, sessionId: string): Promise<HistoryItem[]> {
    const handle = await this.openSession(workspace, sessionId)
    return renderHistory(handle.session)
  }

  /** 删除会话:删 JSONL + 存储条目;删除激活会话时自动激活剩余最新会话 */
  async deleteSession(workspace: Workspace, sessionId: string): Promise<void> {
    const meta = getSession(this.store, workspace.id, sessionId)
    if (!meta) throw new Error('会话不存在')
    const handle = this.handles.get(workspace.id)
    if (handle?.sessionId === sessionId) {
      if (handle.busy) await handle.session.abort()
      handle.session.dispose()
      this.handles.delete(workspace.id)
    }
    if (meta.sessionFile) rmSync(meta.sessionFile, { force: true })
    removeSession(this.store, workspace.id, sessionId)
  }

  /** 删除工作区时清理其所有会话(JSONL + 映射) */
  async cleanupWorkspaceSessions(workspace: Workspace): Promise<void> {
    const handle = this.handles.get(workspace.id)
    if (handle) {
      handle.session.dispose()
      this.handles.delete(workspace.id)
    }
    for (const meta of removeWorkspaceSessions(this.store, workspace.id)) {
      if (meta.sessionFile) rmSync(meta.sessionFile, { force: true })
    }
    // 清理工作区目录(空目录才删;若残留孤儿文件则保留)
    rmSync(sessionDirFor(this.store, workspace.id), { force: true })
  }

  /** 会话列表(当前打开的会话消息数实时回写) */
  listSessionMetas(workspace: Workspace): SessionMeta[] {
    const handle = this.handles.get(workspace.id)
    if (handle?.sessionId) {
      updateSessionMeta(this.store, workspace.id, handle.sessionId, {
        messageCount: handle.session.messages.length,
      })
    }
    return listSessions(this.store, workspace.id).map((s) => ({ ...s }))
  }

  /** 恢复会话历史(前端打开工作区时调用) */
  async getHistory(workspace: Workspace): Promise<HistoryItem[]> {
    const handle = await this.openSession(workspace)
    return renderHistory(handle.session)
  }

  getStatus(workspace: Workspace): SessionStatus {
    const handle = this.handles.get(workspace.id)
    const config = this.getConfig()
    return {
      workspaceId: workspace.id,
      model: handle?.session.model?.id ?? config.model,
      thinkingLevel: handle?.session.thinkingLevel ?? config.thinkingLevel,
      messageCount: handle ? handle.session.messages.length : 0,
      streaming: handle?.busy ?? false,
      lastActivityAt: handle?.lastActivityAt ?? null,
      usage: handle ? { ...handle.usage } : undefined,
    }
  }

  /** 发送消息,事件通过回调流式转发(SSE) */
  async prompt(
    workspace: Workspace,
    text: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    const handle = await this.openSession(workspace)
    if (handle.busy) throw new Error('agent 正在处理中,请稍候')
    handle.busy = true
    handle.lastActivityAt = Date.now()

    const unsubscribe = handle.session.subscribe((event) => {
      for (const mapped of mapSessionEvent(event)) {
        onEvent(mapped)
      }
      // 累计 token 用量
      if (event.type === 'turn_end' && event.message.role === 'assistant') {
        const u = event.message.usage
        const acc = handle.usage
        acc.input += u.input
        acc.output += u.output
        acc.cacheRead += u.cacheRead
        acc.cacheWrite += u.cacheWrite
        acc.totalTokens += u.totalTokens
        acc.cost = (acc.cost ?? 0) + u.cost.total
      }
    })

    try {
      await handle.session.prompt(text)
      onEvent({ type: 'done' })
    } catch (error) {
      onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      unsubscribe()
      handle.busy = false
      handle.lastActivityAt = Date.now()
      updateSessionMeta(this.store, workspace.id, handle.sessionId, {
        messageCount: handle.session.messages.length,
      })
    }
  }

  async abort(workspaceId: string): Promise<void> {
    const handle = this.handles.get(workspaceId)
    if (handle?.busy) {
      await handle.session.abort()
    }
  }
}

/* ---------------- 事件映射 ---------------- */

function mapSessionEvent(event: AgentSessionEvent): SessionEvent[] {
  switch (event.type) {
    case 'message_start': {
      const role = event.message.role === 'user' ? 'user' : 'assistant'
      return [{ type: 'message_start', role, id: `${event.message.timestamp}-${role}` }]
    }
    case 'message_update': {
      const e = event.assistantMessageEvent
      if (e.type === 'text_delta') return [{ type: 'text_delta', delta: e.delta }]
      if (e.type === 'thinking_delta') return [{ type: 'thinking_delta', delta: e.delta }]
      return []
    }
    case 'tool_execution_start':
      return [{
        type: 'tool_start',
        callId: event.toolCallId,
        toolName: event.toolName,
      }]
    case 'tool_execution_update': {
      const partial = event.partialResult
      const delta = typeof partial === 'string' ? partial : ''
      return delta ? [{ type: 'tool_update', callId: event.toolCallId, delta }] : []
    }
    case 'tool_execution_end':
      return [{
        type: 'tool_end',
        callId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        output: stringifyResult(event.result),
      }]
    case 'agent_start':
      return [{ type: 'agent_start' }]
    case 'agent_end':
      return [{ type: 'agent_end', usage: undefined }]
    case 'message_end': {
      const msg = event.message
      if (msg.role === 'assistant' && msg.stopReason === 'error') {
        return [{ type: 'error', message: msg.errorMessage ?? 'agent 执行出错' }]
      }
      return []
    }
    default:
      return []
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === undefined || result === null) return ''
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

/* ---------------- 历史渲染 ---------------- */

/**
 * 恢复会话历史。
 * 与实时 SSE 一致:按 assistant 消息 content 数组的原始顺序输出 blocks,
 * 思考 / 正文 / 工具调用交错排列,不按类型归纳。
 */
function renderHistory(session: AgentSession): HistoryItem[] {
  const items: HistoryItem[] = []
  // toolResult 消息单独成条,按 toolCallId 挂到对应工具块上
  const lastToolOutput = new Map<string, { output?: string; isError?: boolean }>()

  for (const message of session.messages) {
    if (message.role === 'user') {
      const text = extractText(message.content)
      if (!text) continue
      items.push({
        id: `u${message.timestamp}`,
        role: 'user',
        blocks: [{ type: 'text', text }],
      })
    } else if (message.role === 'assistant') {
      const blocks = renderBlocks(message, lastToolOutput)
      if (blocks.length === 0) continue
      items.push({
        id: `a${message.timestamp}`,
        role: 'assistant',
        blocks,
        usage: {
          input: message.usage?.input ?? 0,
          output: message.usage?.output ?? 0,
          cacheRead: message.usage?.cacheRead ?? 0,
          cacheWrite: message.usage?.cacheWrite ?? 0,
          totalTokens: message.usage?.totalTokens ?? 0,
          cost: message.usage?.cost.total ?? 0,
        },
        model: message.model,
      })
    } else if (message.role === 'toolResult') {
      lastToolOutput.set(message.toolCallId, {
        output: extractText(message.content),
        isError: message.isError,
      })
    }
  }
  return items
}

/** 按 content 数组顺序将消息渲染为块序列 */
function renderBlocks(
  message: { content: unknown },
  lastToolOutput: Map<string, { output?: string; isError?: boolean }>,
): HistoryBlock[] {
  if (!Array.isArray(message.content)) return []
  const blocks: HistoryBlock[] = []
  for (const part of message.content) {
    const type = (part as { type?: string }).type
    if (type === 'thinking') {
      const text = (part as { thinking: string }).thinking
      if (text) blocks.push({ type: 'thinking', text })
    } else if (type === 'text') {
      const text = (part as { text: string }).text
      if (text) blocks.push({ type: 'text', text })
    } else if (type === 'toolCall') {
      const call = part as { id: string; name: string; arguments: Record<string, unknown> }
      const result = lastToolOutput.get(call.id)
      blocks.push({
        type: 'tool',
        callId: call.id,
        name: call.name,
        args: call.arguments ?? {},
        output: result?.output,
        isError: result?.isError,
      })
    }
  }
  return blocks
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('')
}

