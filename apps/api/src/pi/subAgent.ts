/**
 * 子代理运行器:主代理的工具 → 独立 AgentSession 执行。
 *
 * - 每个子代理 = 完整 AgentSession:专属 system prompt(md 正文)、专属工具集
 *   (只读 + write 白名单;executor 全量写)、独立 JSONL(模态窗历史回看)
 * - system prompt 经 DefaultResourceLoader 注入(SDK 原生支持,无需 hack)
 * - 内部事件经 mapSessionEvent 镜像为 sub_* 事件,挂载在主代理工具调用的 callId 下
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
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
import type { SessionEvent, Workspace } from '@workflows/shared'
import type { WorkflowsStore } from '../config.js'
import type { AgentDefinition } from './agentDefs.js'
import { compileWriteMatcher, isWriteAllowed, type WriteMatcher } from './agentDefs.js'
import { createPromptOnlyLoader } from './promptLoader.js'
import type { FffIndexManager } from './fffTools.js'
import { createFffFindTool, createFffGrepTool } from './fffTools.js'
import type { RunFile } from './runManager.js'
import { guardPathTool, toToolDefinition, createWorkspaceBashHook } from './workspaceGuard.js'

import { extractText } from './history.js'

/** 子代理运行结果 */
export interface SubAgentResult {
  summary: string
  /** 产物文件(相对工作区根);无则 null */
  artifact: string | null
  /** 会话文件(相对 store.agentDir);无则 null */
  sessionFile: string | null
}

/** 产物文件与角色的映射(内置约定;自定义代理可从 write 白名单推导) */
const ROLE_ARTIFACT: Record<string, string> = {
  explorer: '01-exploration.md',
  planner: '02-plan.md',
  executor: '03-execution.md',
  reviewer: '04-review.md',
}

export interface RunSubAgentOptions {
  store: WorkflowsStore
  runtime: ModelRuntime
  fff: FffIndexManager
  workspace: Workspace
  definition: AgentDefinition
  run: RunFile
  callId: string
  /** 主代理给子代理的任务说明 */
  task: string
  model?: Model<Api>
  thinkingLevel: string
  /** 事件回调:接收带 callId 的 sub_* 镜像事件 */
  onEvent: (event: SessionEvent) => void
  /** 主工具块的进度增量(可选) */
  onProgress?: (delta: string) => void
  signal?: AbortSignal
}

/**
 * 构建子代理工具集:
 * - 只读基础:read / ls + fff 搜索(全量读)
 * - write 白名单:`write` 工具受限为白名单内路径;`**` 则全量(bash/edit/write)
 * - 工具名白名单与 customTools 对齐,内置 grep/find 不开放
 */
export function buildSubAgentTools(options: {
  workspace: Workspace
  definition: AgentDefinition
  fff: FffIndexManager
  matcher: WriteMatcher | undefined
}): { tools: ToolDefinition[]; activeNames: string[] } {
  const { workspace, definition, fff, matcher } = options
  const builtinTools = createReadOnlyTools(workspace.path).filter(
    (tool) => tool.name !== 'grep' && tool.name !== 'find',
  )
  const tools = builtinTools.map((tool) => guardPathTool(toToolDefinition(tool), workspace.path))
  const finder = fff.get(workspace.id, workspace.path)
  if (finder) {
    tools.push(
      guardPathTool(createFffFindTool(finder, workspace.path), workspace.path),
      guardPathTool(createFffGrepTool(finder, workspace.path), workspace.path),
    )
  }
  const activeNames = ['read', 'ls', ...tools.filter((t) => t.name.startsWith('fff-')).map((t) => t.name)]

  const writePatterns = definition.frontmatter.write
  // 只读工作区:executor 的全量写(`**`)降级为只读;产物白名单写保留
  // (探索/计划/审查报告是工作流自身产物,不是对用户代码的改动)
  const fullWrite = !workspace.readOnly && (writePatterns?.includes('**') ?? false)
  if (fullWrite) {
    // executor:完整读写工具集
    const coding = createCodingTools(workspace.path)
      .filter((tool) => tool.name !== 'grep' && tool.name !== 'find' && tool.name !== 'bash')
      .map((tool) => guardPathTool(toToolDefinition(tool), workspace.path))
    tools.push(...coding)
    tools.push(
      toToolDefinition(createBashTool(workspace.path, { spawnHook: createWorkspaceBashHook(workspace.path) })),
    )
    activeNames.push('bash', 'edit', 'write')
  } else if (matcher && matcher.patterns.length > 0) {
    // 白名单写:write 工具受限
    const writeTool = createCodingTools(workspace.path)
      .find((tool) => tool.name === 'write')
    if (writeTool) {
      tools.push(guardWriteTool(toToolDefinition(writeTool), workspace.path, matcher))
      activeNames.push('write')
    }
  }
  return { tools, activeNames }
}

/** 包装 write 工具:path 必须命中白名单(相对工作区根) */
function guardWriteTool(
  definition: ToolDefinition,
  workspacePath: string,
  matcher: WriteMatcher,
): ToolDefinition {
  const originalExecute = definition.execute
  definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
    const rawPath = (params as { path?: unknown }).path
    if (typeof rawPath === 'string' && rawPath !== '') {
      const rel = path.relative(workspacePath, path.resolve(workspacePath, rawPath)).replace(/\\/g, '/')
      if (!isWriteAllowed(rel, matcher)) {
        throw new Error(
          `写权限拦截:${definition.name} 无权写入「${rawPath}」` +
            `(白名单:${matcher.raw.join(', ') || '无'})。\n产物请写入自己的目录。`,
        )
      }
    }
    return originalExecute(toolCallId, params, signal, onUpdate, ctx)
  }
  return definition
}

/** 镜像主会话事件为 sub_* 事件(挂载 callId) */
function toSubEvents(callId: string, event: AgentSessionEvent, onProgress?: (delta: string) => void): SessionEvent[] {
  const out: SessionEvent[] = []
  const push = (evt: SessionEvent): void => {
    out.push(evt)
  }
  switch (event.type) {
    case 'message_start': {
      // user 消息(子代理任务)直接附带完整文本,否则前端无法渲染任务内容
      const text = event.message.role === 'user' ? extractText(event.message.content) : undefined
      push({
        type: 'sub_message_start',
        callId,
        role: event.message.role === 'user' ? 'user' : 'assistant',
        id: `${event.message.timestamp}-${event.message.role}`,
        text,
      })
      return out
    }
    case 'message_update': {
      const e = event.assistantMessageEvent
      if (e.type === 'text_delta') {
        push({ type: 'sub_text_delta', callId, delta: e.delta })
      } else if (e.type === 'thinking_delta') {
        push({ type: 'sub_thinking_delta', callId, delta: e.delta })
      }
      return out
    }
    case 'tool_execution_start':
      push({ type: 'sub_tool_start', callId, toolCallId: event.toolCallId, toolName: event.toolName })
      if (onProgress) onProgress(`[子代理] ${event.toolName} …`)
      return out
    case 'tool_execution_update': {
      const partial = event.partialResult
      const delta = typeof partial === 'string' ? partial : ''
      if (delta) push({ type: 'sub_tool_update', callId, toolCallId: event.toolCallId, delta })
      return out
    }
    case 'tool_execution_end':
      push({
        type: 'sub_tool_end',
        callId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        output: stringifyResult(event.result),
      })
      return out
    default:
      return out
  }
}

/** 从子代理会话消息中提取最终摘要(最后一条 assistant 文本) */
function extractSummary(session: AgentSession): string {
  const messages = session.messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const content = msg.content as unknown
    if (typeof content === 'string') return content.slice(0, 2000)
    if (Array.isArray(content)) {
      const parts = content as Array<{ type?: string; text?: string }>
      const text = parts
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')
      if (text.trim()) return text.slice(0, 2000)
    }
  }
  return '(子代理未产出文本摘要)'
}

/** 子代理结束时产物文件检测(相对工作区根) */
function detectArtifact(workspace: Workspace, run: RunFile, definition: AgentDefinition): string | null {
  const roleName = definition.frontmatter.name
  const fixed = ROLE_ARTIFACT[roleName]
  if (fixed) {
    const p = path.join('.wf-runs', run.runId, fixed)
    return workspaceHasFile(workspace.path, p) ? p : null
  }
  // 自定义代理:从 write 白名单推导(单层 * 匹配 runId 的产物模式)
  const patterns = definition.frontmatter.write ?? []
  for (const pattern of patterns) {
    const starIdx = pattern.indexOf('*')
    if (starIdx < 0) continue
    const candidate = pattern.replace('*', run.runId)
    if (workspaceHasFile(workspace.path, candidate)) return candidate
  }
  return null
}

function workspaceHasFile(workspacePath: string, relPath: string): boolean {
  return existsSync(path.join(workspacePath, relPath))
}

/**
 * 运行子代理:创建独立会话(prompt = 任务 + 产物目录说明),镜像事件,返回摘要。
 */
export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
  const { store, runtime, fff, workspace, definition, run, callId, task, model, thinkingLevel, onEvent, signal } = options
  const name = definition.frontmatter.name
  const matcher = compileWriteMatcher(definition.frontmatter.write)
  const { tools, activeNames } = buildSubAgentTools({ workspace, definition, fff, matcher })

  // 子代理会话目录:每个调用一个 JSONL(模态窗按 callId 回看)
  const sessionDir = path.join(store.agentDir, 'sessions', workspace.id, 'sub', run.runId)
  const sessionManager = SessionManager.create(workspace.path, sessionDir)

  // system prompt:md 正文 + 任务运行约定;经轻量 ResourceLoader 注入(SDK 原生支持)
  const resourceLoader = createPromptOnlyLoader(definition.body)

  const { session } = await createAgentSession({
    cwd: workspace.path,
    agentDir: store.agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: thinkingLevel as never,
    sessionManager,
    resourceLoader,
    customTools: tools,
    tools: activeNames,
  })

  const disposeOnAbort = (): void => {
    void session.abort()
  }
  if (signal) {
    if (signal.aborted) disposeOnAbort()
    else signal.addEventListener('abort', disposeOnAbort, { once: true })
  }

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // 原始事件 → sub_* 镜像(带 callId),user 消息附带完整任务文本
    for (const evt of toSubEvents(callId, event, options.onProgress)) {
      onEvent(evt)
    }
  })

  try {
    const runDirRel = `.wf-runs/${run.runId}`
    await session.prompt(`${task}\n\n产物目录(相对工作区根):${runDirRel}\n最终回复只给摘要。`)
    const summary = extractSummary(session)
    const artifact = detectArtifact(workspace, run, definition)
    const sessionFile = session.sessionFile ? path.relative(store.agentDir, session.sessionFile) : null
    session.dispose()
    return { summary, artifact, sessionFile }
  } catch (error) {
    session.dispose()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`子代理 ${name} 执行失败:${message}`, { cause: error })
  } finally {
    unsubscribe()
    if (signal) signal.removeEventListener('abort', disposeOnAbort)
  }
}

/** 主会话事件 → SessionEvent 映射(与 piService 一致的最小实现) */
function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === undefined || result === null) return ''
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
