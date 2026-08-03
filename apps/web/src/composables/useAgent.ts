import { computed, reactive, ref } from 'vue'
import type { AgentConfig, SessionEvent, SessionStatus, Workspace } from '@dag-pi/shared'

export interface UiToolRun {
  callId: string
  name: string
  output: string
  isError: boolean
  collapsed: boolean
}

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  thinking: string
  thinkingOpen: boolean
  tools: UiToolRun[]
  usage?: SessionStatus['usage']
  model?: string
  status: 'streaming' | 'done' | 'error'
  errorText?: string
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

  /** 用户手动输入 API key,保存到 .dag-pi/config.json */
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

  /** 打开工作区:恢复持久化会话历史 */
  async function openWorkspace(id: string): Promise<void> {
    if (activeWorkspaceId.value === id) return
    if (streaming.value) await abort()
    const data = await request<{ history: UiMessage[]; status: SessionStatus }>(
      `/api/agent/workspaces/${id}/open`,
      { method: 'POST' },
    )
    activeWorkspaceId.value = id
    messages.value = data.history.map((m) => ({
      ...m,
      thinking: m.thinking ?? '',
      thinkingOpen: false,
      tools: (m.tools ?? []).map((t) => ({ ...t, collapsed: true })),
      status: 'done',
    }))
    status.value = data.status
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
      text,
      thinking: '',
      thinkingOpen: false,
      tools: [],
      status: 'done',
    })
  }

  function ensurePending(): UiMessage {
    if (!pending) {
      // 必须用 reactive 包装:pending 变量持有的是代理引用,
      // 后续 text_delta / thinking_delta / tool 增量修改才能触发 UI 实时更新
      // (若 push 原始对象,只有数组内的副本被代理,外部引用的修改不触发响应式)
      pending = reactive<UiMessage>({
        id: `a${Date.now()}`,
        role: 'assistant',
        text: '',
        thinking: '',
        thinkingOpen: false,
        tools: [],
        status: 'streaming',
      })
      messages.value.push(pending)
    }
    return pending
  }

  function handleEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'message_start':
        if (event.role === 'user') pushUserMessage(`[已发送] ${Date.now()}`)
        break
      case 'text_delta':
        ensurePending().text += event.delta
        break
      case 'thinking_delta':
        ensurePending().thinking += event.delta
        break
      case 'tool_start':
        toolRuns.value.push({ ts: Date.now(), name: event.toolName, callId: event.callId, isError: false })
        ensurePending().tools.push({
          callId: event.callId,
          name: event.toolName,
          output: '',
          isError: false,
          collapsed: true,
        })
        break
      case 'tool_update': {
        const tool = ensurePending().tools.find((t) => t.callId === event.callId)
        if (tool) tool.output += event.delta
        break
      }
      case 'tool_end': {
        const run = toolRuns.value.find((r) => r.callId === event.callId)
        if (run) run.isError = event.isError
        const tool = ensurePending().tools.find((t) => t.callId === event.callId)
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
    abort,
    refreshStatus,
  }
}

export type AgentStore = ReturnType<typeof useAgent>
