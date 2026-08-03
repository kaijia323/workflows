/**
 * DAG 图节点
 */
export interface DagNode {
  id: string
  label: string
  description?: string
}

/**
 * DAG 图边
 */
export interface DagEdge {
  source: string
  target: string
}

/**
 * DAG 图数据
 */
export interface DagGraph {
  nodes: DagNode[]
  edges: DagEdge[]
}

/**
 * 统一 API 响应结构
 */
export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

/**
 * 工作区(项目)目录
 */
export interface Workspace {
  id: string
  path: string
  name: string
  /** 只读模式:agent 仅可读,不可写 */
  readOnly: boolean
  createdAt: number
}

/**
 * agent 可用模型(来自 pi 内置 deepseek provider)
 */
export interface AgentModel {
  provider: string
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
}

/**
 * agent 运行配置
 */
export interface AgentConfig {
  /** 是否已配置 DeepSeek API key */
  hasApiKey: boolean
  /** 当前模型 id */
  model: string
  /** 当前思考级别 */
  thinkingLevel: string
  /** 可用模型列表 */
  models: AgentModel[]
  /** 可用思考级别列表 */
  thinkingLevels: string[]
}

/**
 * 会话状态快照
 */
export interface SessionStatus {
  workspaceId: string
  model: string
  thinkingLevel: string
  messageCount: number
  streaming: boolean
  lastActivityAt: number | null
  usage?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    totalTokens: number
    cost: number
  }
}

/**
 * 工作区下的会话条目(一个工作区可含多个持久化会话,JSONL 均保留)
 */
export interface SessionMeta {
  id: string
  /** JSONL 会话文件路径 */
  sessionFile: string
  createdAt: number
  /** 最近一次打开时的消息数(未打开过的会话为 0) */
  messageCount: number
}

/**
 * 会话列表(含当前激活会话)
 */
export interface SessionList {
  sessions: SessionMeta[]
  activeSessionId: string | null
}

/**
 * 历史消息内容块(按模型输出顺序排列:思考 / 正文 / 工具调用交错出现)
 */
export type HistoryBlock =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; callId: string; name: string; args: Record<string, unknown>; output?: string; isError?: boolean }

/**
 * 会话历史消息
 */
export interface HistoryItem {
  id: string
  role: 'user' | 'assistant'
  blocks: HistoryBlock[]
  usage?: SessionStatus['usage']
  model?: string
}

/**
 * 会话事件(SSE 流)
 */
export type SessionEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_start'; toolName: string; callId: string }
  | { type: 'tool_update'; callId: string; delta: string }
  | { type: 'tool_end'; callId: string; toolName: string; isError: boolean; output: string }
  | { type: 'message_start'; role: 'user' | 'assistant'; id: string }
  | { type: 'agent_start' }
  | { type: 'agent_end'; usage: SessionStatus['usage'] }
  | { type: 'error'; message: string }
  | { type: 'done' }
