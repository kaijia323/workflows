import { computed, reactive, ref } from 'vue'
import type { AgentConfig, HistoryItem, McpServerConfig, McpServerStatus, McpToolInfo, RunSnapshot, SessionEvent, SessionList, SessionMeta, SessionStatus, SkillInfo, Workspace } from '@workflows/shared'

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
  /** 用户消息附带的图片缩略图(objectURL,仅会话内展示,不持久化;决策 6) */
  images?: Array<{ path: string; thumb: string }>
  /** 用户手动操作过的思考块(标记后展开状态完全以用户为准,不再自动收起/展开) */
  thinkingTouched: Set<string>
  /** 思考块展开状态:key 为渲染块 key(thinking-N),仅对 thinkingTouched 的块生效 */
  thinkingOpen: Set<string>
  usage?: SessionStatus['usage']
  model?: string
  status: 'streaming' | 'done' | 'error'
  errorText?: string
}

/** 子代理会话(模态窗数据容器):按主代理工具调用的 callId 归集 */
export interface UiSubSession {
  callId: string
  agentName: string
  messages: UiMessage[]
  status: 'running' | 'done' | 'error'
  summary: string
  artifact: string | null
}

/** 闸门请求(planner 完成后等待用户批准) */
export interface UiGateRequest {
  runId: string
  planFile: string | null
  summary: string
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

/**
 * 渲染块:把 segments 按输出顺序转成可视块(相邻 text/thinking 合并,
 * 避免 markdown 被工具调用截断成半截)。key 在流式过程中保持稳定,
 * 思考块的展开状态按 key 逐个记录,互不影响。
 */
export type PlanBlock =
  | { key: string; kind: 'text' | 'thinking'; text: string }
  | { key: string; kind: 'tool'; tool: Extract<UiSegment, { kind: 'tool' }> }

export function planBlocks(message: Pick<UiMessage, 'segments'>): PlanBlock[] {
  const out: PlanBlock[] = []
  for (const seg of message.segments) {
    if (seg.kind === 'text' || seg.kind === 'thinking') {
      const last = out.at(-1)
      if (last && last.kind === seg.kind) {
        last.text += seg.text
      } else {
        out.push({ key: `${seg.kind}-${out.length}`, kind: seg.kind, text: seg.text })
      }
    } else {
      out.push({ key: `tool-${seg.callId}`, kind: 'tool', tool: seg })
    }
  }
  return out
}

/**
 * 思考块展开判定(默认策略):
 * - 用户手动操作过该块 → 完全以用户状态为准;
 * - 未操作 → 流式期间「正在思考」的最后一块自动展开;思考结束
 *   (后续正文/工具插入,或回合结束)自动收起。
 */
export function isThinkingBlockOpen(message: UiMessage, blocks: PlanBlock[], key: string): boolean {
  if (message.thinkingTouched.has(key)) return message.thinkingOpen.has(key)
  const last = blocks.at(-1)
  return message.status === 'streaming' && last?.kind === 'thinking' && last.key === key
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
  // ---- 工作流编排 ----
  /** run 快照(右侧 DAG 图 / 恢复用) */
  const run = ref<RunSnapshot | null>(null)
  /** 子代理会话容器:callId → 实时消息(模态窗) */
  const subSessions = reactive(new Map<string, UiSubSession>())
  /** 闸门请求(等待用户批准) */
  const gateRequest = ref<UiGateRequest | null>(null)
  /** 当前工作区可用 skills(输入框 / 搜索下拉数据源) */
  const skills = ref<SkillInfo[]>([])
  /** MCP server 配置 + 运行时状态(设置面板) */
  const mcp = ref<{ servers: McpServerConfig[]; status: McpServerStatus[] } | null>(null)

  // 当前流式 assistant 消息(增量累积)
  let pending: UiMessage | null = null
  let abortController: AbortController | null = null

  const activeWorkspace = computed(() => workspaces.value.find((w) => w.id === activeWorkspaceId.value) ?? null)
  const hasApiKey = computed(() => config.value?.hasApiKey ?? false)
  const hasAnySearchApiKey = computed(() => config.value?.hasAnySearchApiKey ?? false)
  const visionEnabled = computed(() => config.value?.visionEnabled ?? false)
  const hasVisionApiKey = computed(() => config.value?.hasVisionApiKey ?? false)

  async function refreshConfig(): Promise<void> {
    config.value = await request<AgentConfig>('/api/agent/config')
  }

  async function refreshWorkspaces(): Promise<void> {
    workspaces.value = await request<Workspace[]>('/api/agent/workspaces')
  }

  async function init(): Promise<void> {
    try {
      // MCP 配置拉取失败静默(mcp 为 null,面板显示空),不阻塞聊天
      await Promise.all([refreshConfig(), refreshWorkspaces(), refreshMcp().catch(() => {})])
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

  /** 用户手动输入 AnySearch API key,保存到 .workflows/config.json(空串=清空配置) */
  async function saveAnySearchApiKey(key: string): Promise<void> {
    await request('/api/agent/config/anysearch-key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    })
    await refreshConfig()
  }

  /** 保存视觉模型开关与小米 key(开关翻转后端会重建已打开会话;空串 apiKey=清空配置) */
  async function saveVisionConfig(patch: { enabled: boolean; apiKey?: string }): Promise<void> {
    await request('/api/agent/config/vision', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    await refreshConfig()
  }

  /* ---- MCP 外部工具(独立 mcp.json;全部走 /api/agent/mcp*) ---- */

  /** 拉取 MCP server 配置 + 运行时状态 */
  async function refreshMcp(): Promise<void> {
    mcp.value = await request<{ servers: McpServerConfig[]; status: McpServerStatus[] }>('/api/agent/mcp')
  }

  /** 新增/更新 server(upsert 语义;保存后后端断开旧连接,新会话生效) */
  async function saveMcpServer(server: McpServerConfig): Promise<void> {
    await request(`/api/agent/mcp/${encodeURIComponent(server.name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: server.name,
        command: server.command,
        args: server.args ?? [],
        enabled: server.enabled ?? false,
        // 透传 env:有值保留(防 toggleEnabled 等 spread 保存把手写 env 抹掉);
        // undefined 时 JSON.stringify 自动省略该键,磁盘不写出 "env": {}
        env: server.env,
      }),
    })
    await refreshMcp()
  }

  /** 删除 server */
  async function deleteMcpServer(name: string): Promise<void> {
    await request(`/api/agent/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await refreshMcp()
  }

  /** 一次性测试连接(不污染缓存、不注册进会话);返回 { ok, tools?, error? } */
  async function testMcpServer(name: string): Promise<{ ok: boolean; tools?: McpToolInfo[]; error?: string }> {
    return request<{ ok: boolean; tools?: McpToolInfo[]; error?: string }>(`/api/agent/mcp/${encodeURIComponent(name)}/test`, {
      method: 'POST',
    })
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
    subSessions.clear()
    gateRequest.value = null
    messages.value = data.history.map((item) => ({
      id: item.id,
      role: item.role,
      // 历史块按原顺序还原为片段,与实时流渲染一致
      segments: item.blocks.map((block) =>
        block.type === 'tool'
          ? { kind: 'tool', callId: block.callId, name: block.name, output: block.output ?? '', isError: block.isError ?? false, collapsed: true }
          : { kind: block.type, text: block.text },
      ),
      thinkingTouched: new Set(),
      thinkingOpen: new Set(),
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
    await Promise.all([refreshRun(), refreshSkills()])
  }

  /** 新建会话:旧会话 JSONL 全部保留,新会话成为当前 */
  async function newSession(): Promise<void> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) throw new Error('请先选择工作区')
    if (streaming.value) await abort()
    const data = await request<SessionData>(`/api/agent/workspaces/${workspaceId}/sessions`, { method: 'POST' })
    applySessionData(data)
    await refreshRun()
  }

  /** 切换会话:加载该会话历史并激活 */
  async function switchSession(sessionId: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) throw new Error('请先选择工作区')
    if (streaming.value) await abort()
    const data = await request<SessionData>(`/api/agent/workspaces/${workspaceId}/sessions/${sessionId}`, { method: 'POST' })
    applySessionData(data)
    await refreshRun()
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
      await refreshRun()
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

  function pushUserMessage(text: string, images?: UiMessage['images']): void {
    messages.value.push({
      id: `u${Date.now()}`,
      role: 'user',
      segments: [{ kind: 'text', text }],
      images,
      thinkingTouched: new Set(),
      thinkingOpen: new Set(),
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
        thinkingTouched: new Set(),
        thinkingOpen: new Set(),
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
        // 回合异常中断:子代理调用一并收尾,否则模态窗光标永久闪烁
        finalizeSubSessions('error')
        break
      case 'done':
        streaming.value = false
        if (pending) {
          pending.status = 'done'
          pending = null
        }
        // 回合正常结束:仍缺 sub_end 的子代理(中断/流丢失)一律收尾
        finalizeSubSessions('done')
        void refreshRun()
        break
      /* ---- 工作流编排事件 ---- */
      case 'sub_message_start': {
        const sub = ensureSubSession(event.callId, '')
        const msg: UiMessage = reactive({
          id: event.id,
          role: event.role,
          // user 消息(子代理任务)由后端附带完整文本
          segments: event.text ? [{ kind: 'text', text: event.text }] : [],
          thinkingTouched: new Set(),
          thinkingOpen: new Set(),
          status: 'streaming',
        })
        sub.messages.push(msg)
        break
      }
      case 'sub_text_delta': {
        const msg = lastSubMessage(event.callId)
        if (msg) appendSegment(msg, { kind: 'text', text: event.delta })
        break
      }
      case 'sub_thinking_delta': {
        const msg = lastSubMessage(event.callId)
        if (msg) appendSegment(msg, { kind: 'thinking', text: event.delta })
        break
      }
      case 'sub_tool_start': {
        const msg = lastSubMessage(event.callId)
        if (msg) {
          msg.segments.push({
            kind: 'tool',
            callId: event.toolCallId,
            name: event.toolName,
            output: '',
            isError: false,
            collapsed: true,
          })
        }
        break
      }
      case 'sub_tool_update': {
        const msg = lastSubMessage(event.callId)
        if (msg) {
          const tool = findToolSegment(msg, event.toolCallId)
          if (tool) tool.output += event.delta
        }
        break
      }
      case 'sub_tool_end': {
        const msg = lastSubMessage(event.callId)
        if (msg) {
          const tool = findToolSegment(msg, event.toolCallId)
          if (tool) {
            tool.output = event.output
            tool.isError = event.isError
          }
        }
        break
      }
      case 'sub_end': {
        // 该次调用下所有还在 streaming 的消息统一收尾,避免历史消息残留流式光标
        const sub = subSessions.get(event.callId)
        if (sub) {
          for (const m of sub.messages) {
            if (m.status === 'streaming') m.status = 'done'
          }
          sub.status = event.isError ? 'error' : 'done'
          sub.agentName = event.agentName
          sub.summary = event.summary
          sub.artifact = event.artifact
        }
        break
      }
      case 'gate_required':
        gateRequest.value = {
          runId: event.runId,
          planFile: event.planFile,
          summary: event.summary,
        }
        void refreshRun()
        break
    }
  }

  /** 收尾仍处于运行/流式状态的子代理会话(幂等;回合正常结束或异常中断时调用) */
  function finalizeSubSessions(status: 'done' | 'error'): void {
    for (const sub of subSessions.values()) {
      if (sub.status === 'running') sub.status = status
      for (const m of sub.messages) {
        // 消息统一置 done:只停光标,保留内容与错误标记
        if (m.status === 'streaming') m.status = 'done'
      }
    }
  }

  /** 确保子代理会话容器存在(模态窗数据源) */
  function ensureSubSession(callId: string, agentName: string): UiSubSession {
    let sub = subSessions.get(callId)
    if (!sub) {
      sub = reactive<UiSubSession>({
        callId,
        agentName,
        messages: [],
        status: 'running',
        summary: '',
        artifact: null,
      })
      subSessions.set(callId, sub)
    }
    if (agentName && !sub.agentName) sub.agentName = agentName
    return sub
  }

  /** 该 callId 当前流式消息(增量事件的目标);无流式消息时取最后一条 */
  function lastSubMessage(callId: string): UiMessage | null {
    const sub = subSessions.get(callId)
    if (!sub) return null
    for (let i = sub.messages.length - 1; i >= 0; i--) {
      const m = sub.messages[i]
      if (m.status === 'streaming') return m
    }
    return sub.messages.at(-1) ?? null
  }

  /** 拉取 run 快照(打开工作区 / 回合结束 / 闸门时刷新) */
  async function refreshRun(): Promise<void> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) {
      run.value = null
      return
    }
    try {
      run.value = await request<RunSnapshot | null>(`/api/agent/workspaces/${workspaceId}/run`)
    } catch {
      // 忽略:run 不可用不影响聊天
    }
  }

  /** 拉取当前工作区 skills(输入框 / 搜索);失败静默置空,不阻塞聊天 */
  async function refreshSkills(): Promise<void> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) {
      skills.value = []
      return
    }
    try {
      skills.value = await request<SkillInfo[]>(`/api/agent/workspaces/${workspaceId}/skills`)
    } catch {
      skills.value = []
    }
  }

  /** 子代理历史回看(模态窗;实时数据缺失时调用) */
  async function fetchSubHistory(callId: string): Promise<UiMessage[]> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) return []
    const history = await request<HistoryItem[]>(`/api/agent/workspaces/${workspaceId}/run/agents/${callId}`)
    return history.map((item) => ({
      id: item.id,
      role: item.role,
      segments: item.blocks.map((block) =>
        block.type === 'tool'
          ? { kind: 'tool' as const, callId: block.callId, name: block.name, output: block.output ?? '', isError: block.isError ?? false, collapsed: true }
          : { kind: block.type, text: block.text },
      ),
      thinkingTouched: new Set(),
      thinkingOpen: new Set(),
      status: 'done' as const,
    }))
  }

  /** 上传粘贴图片(压缩后 base64)→ 返回工作区相对路径(如 .wf-uploads/<uuid>.png) */
  async function uploadImage(dataUrl: string): Promise<string> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) throw new Error('请先选择工作区')
    const data = await request<{ path: string }>(`/api/agent/workspaces/${workspaceId}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 纯 base64 payload(去 data: 前缀,后端魔数嗅探定 mime,不信客户端)
      body: JSON.stringify({ data: dataUrl.split(',')[1] ?? dataUrl }),
    })
    return data.path
  }

  /** 发送消息:POST 后通过 SSE 流式接收 agent 事件 */
  async function sendMessage(text: string, images?: UiMessage['images']): Promise<void> {
    const workspaceId = activeWorkspaceId.value
    if (!workspaceId) throw new Error('请先选择工作区')
    pushUserMessage(text, images)
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
      // 兜底:流无论以何种方式结束(正常 done / 后端 error / 连接断开 / 中断),
      // 都必须收尾所有流式状态。否则只有工具块(无正文)的消息、子代理模态窗
      // 的流式光标会永久闪烁。
      if (pending) {
        pending.status = 'done'
        pending = null
      }
      finalizeSubSessions('done')
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

  /** 清除闸门提示(用户已批准/驳回,消息已续跑) */
  function dismissGate(): void {
    gateRequest.value = null
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
    run,
    subSessions,
    gateRequest,
    skills,
    mcp,
    hasApiKey,
    hasAnySearchApiKey,
    visionEnabled,
    hasVisionApiKey,
    init,
    refreshConfig,
    refreshWorkspaces,
    saveApiKey,
    saveAnySearchApiKey,
    saveVisionConfig,
    refreshMcp,
    saveMcpServer,
    deleteMcpServer,
    testMcpServer,
    addWorkspace,
    removeWorkspace,
    toggleReadOnly,
    openWorkspace,
    switchModel,
    switchThinking,
    sendMessage,
    uploadImage,
    newSession,
    switchSession,
    deleteSession,
    abort,
    refreshStatus,
    refreshRun,
    refreshSkills,
    fetchSubHistory,
    dismissGate,
  }
}

export type AgentStore = ReturnType<typeof useAgent>
