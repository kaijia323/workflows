import { computed, reactive, ref } from 'vue'
import type { AgentConfig, HistoryItem, SessionEvent, SessionList, SessionMeta, SessionStatus, Workspace } from '@workflows/shared'

export interface UiToolRun {
  callId: string
  name: string
  output: string
  isError: boolean
  collapsed: boolean
}

/**
 * 消息内容片段,按模型输出顺序排列(思考 / 正文 / 工具调用交错)。
 * 连续到达的同类型增量会合并到同一个片段。
 */
export type UiSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; callId: string; name: string; output: string; isError: boolean; collapsed: boolean }

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  /** 内容片段序列 = 大模型输出顺序,前端按此渲染 */
  segments: UiSegment[]
  /** 消息级开关:展开/折叠全部思考片段 */
  thinkingOpen: boolean
  usage?: SessionStatus['usage']
  model?: string
  status: 'streaming' | 'done' | 'error'
  errorText?: string
}

/** 聚合:正文全文(按片段顺序拼接) */
export function messageText(m: UiMessage): string {
  return m.segments
    .filter((s): s is Extract<UiSegment, { kind: 'text' }> => s.kind === 'text')
    .map((s) => s.text)
    .join('')
}

/** 聚合:思考全文 */
export function messageThinking(m: UiMessage): string {
  return m.segments
    .filter((s): s is Extract<UiSegment, { kind: 'thinking' }> => s.kind === 'thinking')
    .map((s) => s.text)
    .join('\n')
}

/** 是否有思考内容 */
export function hasThinking(m: UiMessage): boolean {
  return m.segments.some((s) => s.kind === 'thinking')
}

/** 查找工具片段 */
export function findToolSegment(m: UiMessage, callId: string): Extract<UiSegment, { kind: 'tool' }> | undefined {
  return m.segments.find((s): s is Extract<UiSegment, { kind: 'tool' }> => s.kind === 'tool' && s.callId === callId)
}

const TOOL_LABELS: Record<string, string> = {
  read: '读取',
  bash: '执行',
  edit: '修改',
  write: '写入',
  grep: '搜索',
  find: '查找',
  ls: '列出',
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

interface ApiErrorBody {
  message?: string
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string; data?: T }
  if (!res.ok || (body.code !== undefined && body.code !== 0)) {
    throw new Error(body.message ?? `请求失败 (HTTP ${res.status})`)
  }
  return body.data as T
}

/**
 * agent 前端状态中心:配置 / 工作区 / 会话 / SSE 流式消息
 */
export function useAgent() {
  const config = ref<AgentConfig | null>(null)
  const workspaces = ref<Workspace[]>([])
  const activeWorkspaceId = ref<string | null>(null)
  const sessionList = ref<SessionList | null>(null)
  const messages = ref<UiMessage[]>([])
  const streaming = ref(false)
  const status = ref<SessionStatus | null>(null)
  const toolRuns = ref<Array<{ ts: number; name: string; callId: string; isError: boolean }>>([])
  const connectionError = ref<string | null>(null)

  // 当前流式 assistant 消息(增量累积)
  let pending: UiMessage | null = null
  let abortController: AbortController | null = null

  const activeWorkspace = computed(() => workspaces.value.find((w) => w.id === activeWorkspaceId.value) ?? null)
  const hasApiKey = computed(() => config.value?.hasApiKey ?? false)

  async function refreshConfig(): Promise<void> {
    config.value = await request<AgentConfig>('/api/agent/config')
  }

  async function refreshWorkspaces(): Promise<void> {
    workspaces.value = await request<Workspace[]>('/api/agent/workspaces')
  }

  async function init(): Promise<void> {
    try {
      await Promise.all([refreshConfig(), refreshWorkspaces()])
      connectionError.value = null
    } catch (error) {
      connectionError.value = error instanceof Error ? error.message : String(error)
    }
  }

  /** 用户手动输入 API key,保存到 .workflows/config.json */
  async function saveApiKey(key: string): Promise<void> {
    await request('/api/agent/config/key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    })
    await refreshConfig()
  }

  async function addWorkspace(path: string): Promise<void> {
    await request<Workspace>('/api/agent/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    await refreshWorkspaces()
  }

  async function removeWorkspace(id: string): Promise<void> {
    await request(`/api/agent/workspaces/${id}`, { method: 'DELETE' })
    if (activeWorkspaceId.value === id) {
      activeWorkspaceId.value = null
      messages.value = []
      sessionList.value = null
    }
    await refreshWorkspaces()
  }

  async function toggleReadOnly(id: string, readOnly: boolean): Promise<void> {
    await request(`/api/agent/workspaces/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ readOnly }),
    })
    await refreshWorkspaces()
  }

  /** 打开/切换会话的完整数据(历史 + 状态 + 会话列表) */
  interface SessionData {
    history: HistoryItem[]
    status: SessionStatus
    sessions: SessionMeta[]
    activeSessionId: string | null
  }

  /** 应用会话数据:渲染历史、重置流式状态、刷新会话列表 */
  function applySessionData(data: SessionData): void {
    pending = null
    toolRuns.value = []
    messages.value = data.history.map((item) => ({
      id: item.id,
      role: item.role,
      // 历史块按原顺序还原为片段,与实时流渲染一致
      segments: item.blocks.map((block) =>
        block.type === 'tool'
          ? { kind: 'tool', callId: block.callId, name: block.name, output: block.output ?? '', isError: block.isError ?? false, collapsed: true }
          : { kind: block.type, text: block.text },
      ),
      thinkingOpen: false,
      usage: item.usage,
      model: item.model,
      status: 'done',
    }))
    status.value = data.status
    sessionList.value = { sessions: data.sessions, activeSessionId: data.activeSessionId }
  }

  /** 打开工作区:恢复激活会话历史与会话列表 */
  async function openWorkspace(id: string): Promise<void> {
    if (activeWorkspaceId.value === id) return
    if (streaming.value) await abort()
    const data = await request<SessionData>(`/api/agent/workspaces/${id}/open`, { method: 'POST' })
    activeWorkspaceId.value = id
    applySessionData(data)
  }

  /** 新建会话:旧会话 JSONL 全部保留,新会话成为当前 */
  async function newSession(): Promise<void> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) throw new Error('请先选择工作区')
    if (streaming.value) await abort()
    const data = await request<SessionData>(`/api/agent/workspaces/${workspaceId}/sessions`, { method: 'POST' })
    applySessionData(data)
  }

  /** 切换会话:加载该会话历史并激活 */
  async function switchSession(sessionId: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) throw new Error('请先选择工作区')
    if (streaming.value) await abort()
    const data = await request<SessionData>(`/api/agent/workspaces/${workspaceId}/sessions/${sessionId}`, { method: 'POST' })
    applySessionData(data)
  }

  /** 删除会话;删除的是当前会话时,自动切到剩余最新会话 */
  async function deleteSession(sessionId: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) throw new Error('请先选择工作区')
    if (streaming.value) await abort()
    const wasActive = sessionList.value?.activeSessionId === sessionId
    const data = await request<{ sessions: SessionMeta[]; activeSessionId: string | null }>(
      `/api/agent/workspaces/${workspaceId}/sessions/${sessionId}`,
      { method: 'DELETE' },
    )
    sessionList.value = { sessions: data.sessions, activeSessionId: data.activeSessionId }
    if (wasActive) {
      // 重新打开:后端已自动激活剩余最新会话
      const open = await request<SessionData>(`/api/agent/workspaces/${workspaceId}/open`, { method: 'POST' })
      applySessionData(open)
    }
  }

  async function switchModel(modelId: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value ?? undefined
    config.value = await request<AgentConfig>('/api/agent/config/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelId, workspaceId }),
    })
    if (status.value) status.value.model = modelId
  }

  async function switchThinking(level: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value ?? undefined
    config.value = await request<AgentConfig>('/api/agent/config/thinking', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level, workspaceId }),
    })
    if (status.value) status.value.thinkingLevel = level
  }

  function pushUserMessage(text: string): void {
    messages.value.push({
      id: `u${Date.now()}`,
      role: 'user',
      segments: [{ kind: 'text', text }],
      thinkingOpen: false,
      status: 'done',
    })
  }

  /** 向最后一个片段追加增量;若最后一个片段类型不同,则新开一个片段 */
  function appendSegment(pending: UiMessage, seg: UiSegment): void {
    const last = pending.segments.at(-1)
    if (last && last.kind === seg.kind && seg.kind !== 'tool') {
      ;(last as Extract<UiSegment, { kind: 'text' | 'thinking' }>).text += (seg as { text: string }).text
    } else {
      pending.segments.push(seg)
    }
  }

  function ensurePending(): UiMessage {
    if (!pending) {
      // 必须用 reactive 包装:pending 变量持有的是代理引用,
      // 后续 text_delta / thinking_delta / tool 增量修改才能触发 UI 实时更新
      // (若 push 原始对象,只有数组内的副本被代理,外部引用的修改不触发响应式)
      pending = reactive<UiMessage>({
        id: `a${Date.now()}`,
        role: 'assistant',
        segments: [],
        thinkingOpen: false,
        status: 'streaming',
      })
      messages.value.push(pending)
    }
    return pending
  }

  function handleEvent(event: SessionEvent): void {
    switch (event.type) {
      // 注意:不处理 message_start。用户消息已在 sendMessage() 中即时推送,
      // 若这里再按 SSE 回传的 message_start(含 user 角色)push 一条,
      // 会导致用户消息重复、并在真实消息与回复之间插入一条占位垃圾消息。
      case 'text_delta':
        appendSegment(ensurePending(), { kind: 'text', text: event.delta })
        break
      case 'thinking_delta':
        appendSegment(ensurePending(), { kind: 'thinking', text: event.delta })
        break
      case 'tool_start':
        toolRuns.value.push({ ts: Date.now(), name: event.toolName, callId: event.callId, isError: false })
        ensurePending().segments.push({
          kind: 'tool',
          callId: event.callId,
          name: event.toolName,
          output: '',
          isError: false,
          collapsed: true,
        })
        break
      case 'tool_update': {
        const tool = findToolSegment(ensurePending(), event.callId)
        if (tool) tool.output += event.delta
        break
      }
      case 'tool_end': {
        const run = toolRuns.value.find((r) => r.callId === event.callId)
        if (run) run.isError = event.isError
        const tool = findToolSegment(ensurePending(), event.callId)
        if (tool) {
          tool.output = event.output
          tool.isError = event.isError
        }
        break
      }
      case 'agent_start':
        streaming.value = true
        break
      case 'agent_end':
        if (pending) {
          pending.status = 'done'
          pending = null
        }
        break
      case 'error':
        if (pending) {
          pending.status = 'error'
          pending.errorText = event.message
          pending = null
        } else {
          connectionError.value = event.message
        }
        break
      case 'done':
        streaming.value = false
        if (pending) {
          pending.status = 'done'
          pending = null
        }
        break
    }
  }

  /** 发送消息:POST 后通过 SSE 流式接收 agent 事件 */
  async function sendMessage(text: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) throw new Error('请先选择工作区')
    pushUserMessage(text)
    streaming.value = true
    abortController = new AbortController()
    let buffer = ''

    try {
      const res = await fetch(`/api/agent/workspaces/${workspaceId}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: abortController.signal,
      })
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorBody
        throw new Error(body.message ?? `请求失败 (HTTP ${res.status})`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload) continue
          handleEvent(JSON.parse(payload) as SessionEvent)
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // 用户中止:标记当前消息
        if (pending) {
          pending.status = 'done'
          pending = null
        }
      } else {
        connectionError.value = error instanceof Error ? error.message : String(error)
      }
    } finally {
      streaming.value = false
      abortController = null
      await refreshStatus()
    }
  }

  async function abort(): Promise<void> {
    abortController?.abort()
    const workspaceId = activeWorkspaceId.value
    if (workspaceId) {
      await request(`/api/agent/workspaces/${workspaceId}/abort`, { method: 'POST' }).catch(() => {})
    }
  }

  async function refreshStatus(): Promise<void> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) return
    try {
      status.value = await request<SessionStatus>(`/api/agent/workspaces/${workspaceId}/status`)
    } catch {
      // 忽略状态刷新失败
    }
  }

  return {
    config,
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    sessionList,
    messages,
    streaming,
    status,
    toolRuns,
    connectionError,
    hasApiKey,
    init,
    refreshConfig,
    refreshWorkspaces,
    saveApiKey,
    addWorkspace,
    removeWorkspace,
    toggleReadOnly,
    openWorkspace,
    switchModel,
    switchThinking,
    sendMessage,
    newSession,
    switchSession,
    deleteSession,
    abort,
    refreshStatus,
  }
}

export type AgentStore = ReturnType<typeof useAgent>
