/**
 * DAG 图节点
 */
export interface DagNode {
  id: string
  label: string
  description?: string
  /** 工作流运行状态(前端 DAG 图渲染用) */
  status?: 'idle' | 'running' | 'done' | 'error'
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
 * 目录浏览条目(仅目录;添加工作区时供前端浏览文件系统)
 */
export interface DirEntry {
  name: string
}

/**
 * 目录列表响应(路径为平台原生格式,如 C:\\Users\\dev)
 */
export interface DirListing {
  /** 当前目录绝对路径 */
  path: string
  /** 上级目录;已在根目录时为 null */
  parent: string | null
  /** 子目录列表(自然排序,含隐藏目录) */
  entries: DirEntry[]
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
 * 子代理内部会话事件镜像(挂载在主代理工具调用的 callId 下)。
 * 与主会话事件同构,前端按 callId 归入子代理模态窗数据容器。
 */
export type SubAgentEvent =
  | { type: 'sub_message_start'; callId: string; role: 'user' | 'assistant'; id: string; text?: string }
  | { type: 'sub_text_delta'; callId: string; delta: string }
  | { type: 'sub_thinking_delta'; callId: string; delta: string }
  | { type: 'sub_tool_start'; callId: string; toolCallId: string; toolName: string }
  | { type: 'sub_tool_update'; callId: string; toolCallId: string; delta: string }
  | { type: 'sub_tool_end'; callId: string; toolCallId: string; toolName: string; isError: boolean; output: string }

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
  // 子代理编排:sub_* 事件挂载在主代理工具调用的 callId 下
  | SubAgentEvent
  // 子代理结束(主代理工具调用收尾前的镜像)
  | { type: 'sub_end'; callId: string; agentName: string; summary: string; artifact: string | null }
  // 闸门请求:planner 产出计划后等待用户批准/驳回
  | { type: 'gate_required'; runId: string; planFile: string | null; summary: string }

/* ---------------- 工作流 run ---------------- */

/** run 状态机 */
export type RunStatus = 'planning' | 'awaiting_approval' | 'executing' | 'reviewing' | 'done'

/** run 中一次子代理调用记录 */
export interface RunAgentCall {
  callId: string
  /** 子代理名(explorer / planner / executor / reviewer …) */
  agent: string
  /** 子代理最终输出摘要 */
  summary: string
  /** 产物文件(相对工作区根,如 .wf-runs/r1/01-exploration.md);无则 null */
  artifact: string | null
  /** 子代理会话文件(相对 .workflows,供模态窗历史回看) */
  sessionFile: string | null
  ts: number
}

/** run 快照(恢复 / 断连重建 UI 用) */
export interface RunSnapshot {
  runId: string
  sessionId: string
  status: RunStatus
  gate: { pending: boolean; planFile: string | null }
  /** 产物文件列表(相对工作区根) */
  artifacts: Array<{ name: string; path: string }>
  /** 本 run 已完成的子代理调用(按时间序) */
  agents: RunAgentCall[]
}
