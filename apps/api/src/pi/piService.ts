import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Api, Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent'
import type {
  AgentConfig,
  SessionEvent,
  SessionStatus,
  Workspace,
} from '@dag-pi/shared'
import {
  createStore,
  hasApiKey,
  loadConfig,
  saveSessionEntry,
  setApiKey,
  sessionFileFor,
  type DagPiStore,
} from '../config.js'

const DEFAULT_MODEL = 'deepseek-v4-flash'
const ALL_THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export interface HistoryItem {
  id: string
  role: 'user' | 'assistant'
  text: string
  thinking?: string
  tools: Array<{ name: string; args: Record<string, unknown>; output?: string; isError?: boolean }>
  usage?: SessionStatus['usage']
  model?: string
}

interface SessionHandle {
  workspace: Workspace
  session: AgentSession
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }
  busy: boolean
  lastActivityAt: number | null
}

/**
 * pi SDK 服务层:
 * - 使用 pi SDK(与 pi CLI 无关),不读取/修改任何 pi 全局配置(~/.pi/agent)
 * - ModelRuntime 的 auth/models 路径全部隔离到 .dag-pi/agent 下
 * - DeepSeek API key 由用户手动输入,保存在 .dag-pi/config.json,运行时注入
 * - 每个工作区一个持久化会话(上下文严格限定在该工作区目录)
 */
export class PiAgentService {
  private readonly store: DagPiStore
  private readonly runtime: ModelRuntime
  private readonly handles = new Map<string, SessionHandle>()

  private constructor(store: DagPiStore, runtime: ModelRuntime) {
    this.store = store
    this.runtime = runtime
  }

  static async create(): Promise<PiAgentService> {
    const store = createStore()
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

  /** 保存用户手动输入的 API key(仅存 .dag-pi/config.json,运行时注入,不写任何 pi 配置) */
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

  /** 保存模型/思考级别到 .dag-pi/config.json(不落任何 pi 配置) */
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

  private async openSession(workspace: Workspace): Promise<SessionHandle> {
    const existing = this.handles.get(workspace.id)
    if (existing) return existing

    const stored = loadConfig(this.store)
    const model = this.runtime.getModel('deepseek', stored.model ?? DEFAULT_MODEL) ?? undefined
    const sessionFile = sessionFileFor(this.store, workspace.id)
    const sessionDir = path.join(this.store.agentDir, 'sessions')
    const sessionManager = sessionFile
      ? SessionManager.open(sessionFile)
      : // 关键:显式指定 sessionDir,会话文件落在 .dag-pi/agent/sessions 下,
      // 绝不写入用户全局 ~/.pi/agent/sessions
      SessionManager.create(workspace.path, sessionDir)

    const { session } = await createAgentSession({
      cwd: workspace.path,
      agentDir: this.store.agentDir,
      modelRuntime: this.runtime,
      model,
      thinkingLevel: (stored.thinkingLevel as ModelThinkingLevel | undefined) ?? 'off',
      sessionManager,
      // 权限:只读工作区仅暴露只读工具,其余用默认工具(read/bash/edit/write),cwd 均绑定工作区
      tools: workspace.readOnly ? ['read', 'grep', 'find', 'ls'] : undefined,
    })

    if (session.sessionFile) {
      saveSessionEntry(this.store, workspace.id, session.sessionFile)
    } else if (sessionFile) {
      saveSessionEntry(this.store, workspace.id, sessionFile)
    }

    const handle: SessionHandle = {
      workspace,
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

function renderHistory(session: AgentSession): HistoryItem[] {
  const items: HistoryItem[] = []
  let lastAssistantIndex = -1
  const lastToolOutput = new Map<string, { output?: string; isError?: boolean }>()

  for (const message of session.messages) {
    if (message.role === 'user') {
      const text = extractText(message.content)
      if (!text) continue
      items.push({ id: `u${message.timestamp}`, role: 'user', text, tools: [] })
      lastAssistantIndex = -1
    } else if (message.role === 'assistant') {
      const thinking = extractThinking(message.content)
      const text = extractText(message.content)
      const tools = message.content
        .filter((c): c is Extract<typeof c, { type: 'toolCall' }> => c.type === 'toolCall')
        .map((call) => ({
          name: call.name,
          args: call.arguments as Record<string, unknown>,
          output: lastToolOutput.get(call.id)?.output,
          isError: lastToolOutput.get(call.id)?.isError,
        }))
      if (!text && !thinking && tools.length === 0) continue
      items.push({
        id: `a${message.timestamp}`,
        role: 'assistant',
        text,
        thinking,
        tools,
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
      lastAssistantIndex = items.length - 1
    } else if (message.role === 'toolResult') {
      lastToolOutput.set(message.toolCallId, {
        output: extractText(message.content),
        isError: message.isError,
      })
      if (lastAssistantIndex >= 0) {
        const target = items[lastAssistantIndex]
        const tool = target.tools.find((t) => t.name === message.toolName && t.output === undefined)
        if (tool) {
          tool.output = extractText(message.content)
          tool.isError = message.isError
        }
      }
    }
  }
  return items
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('')
}

function extractThinking(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts = content
    .filter((c) => c.type === 'thinking')
    .map((c) => (c as { thinking: string }).thinking)
  return parts.length > 0 ? parts.join('\n') : undefined
}

