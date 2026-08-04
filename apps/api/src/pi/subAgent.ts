/**
 * 子代理运行器:主代理的工具 → 独立 AgentSession 执行。
 *
 * - 每个子代理 = 完整 AgentSession:专属 system prompt(md 正文)、专属工具集
 *   (只读 + write 白名单;executor 全量写)、独立 JSONL(模态窗历史回看)
 * - system prompt 经 DefaultResourceLoader 注入(SDK 原生支持,无需 hack)
 * - 内部事件经 mapSessionEvent 镜像为 sub_* 事件,挂载在主代理工具调用的 callId 下
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
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
import { loadConfig, type WorkflowsStore } from '../config.js'
import type { AgentDefinition } from './agentDefs.js'
import { compileWriteMatcher, isWriteAllowed, type WriteMatcher } from './agentDefs.js'
import { createPromptOnlyLoader, skillReadRoots, type SkillLoadContext } from './promptLoader.js'
import type { FffIndexManager } from './fffTools.js'
import { createFffFindTool, createFffGrepTool } from './fffTools.js'
import { createAnySearchTools } from './anySearchTools.js'
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

/**
 * 产物文件基名与角色的映射(内置约定;自定义代理可从 write 白名单推导)。
 * 值即旧名 `NN-role.md`,仅用于推导序号名 `NN-role-N.md`(nextArtifactName)与
 * 检测前缀扫描(detectArtifact)。
 */
const ROLE_ARTIFACT: Record<string, string> = {
  explorer: '01-exploration.md',
  planner: '02-plan.md',
  executor: '03-execution.md',
  reviewer: '04-review.md',
}

/**
 * 本次调用的产物文件名:同 run 同角色第 N 次调用 → `NN-role-N.md`(从 1 起)。
 * 计数含失败调用(run.agents 已记录),保证按调用顺序稳定递增;自定义角色返回 null。
 */
export function nextArtifactName(run: RunFile, roleName: string): string | null {
  const base = ROLE_ARTIFACT[roleName]
  if (!base) return null
  const seq = run.agents.filter((a) => a.agent === roleName).length + 1
  return `${base.replace(/\.md$/, '')}-${seq}.md`
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
  /** anysearch API key 回调(env ANYSEARCH_API_KEY 优先逻辑在 anySearchTools 内部) */
  getAnySearchApiKey?: () => string | undefined
  /** 工作区外只读放行根(见 promptLoader.skillReadRoots);缺省 [] 保持现有行为 */
  extraAllowedRoots?: string[]
}): { tools: ToolDefinition[]; activeNames: string[] } {
  const { workspace, definition, fff, matcher, getAnySearchApiKey, extraAllowedRoots = [] } = options
  const builtinTools = createReadOnlyTools(workspace.path).filter(
    (tool) => tool.name !== 'grep' && tool.name !== 'find',
  )
  const tools = builtinTools.map((tool) => guardPathTool(toToolDefinition(tool), workspace.path, extraAllowedRoots))
  const finder = fff.get(workspace.id, workspace.path)
  if (finder) {
    tools.push(
      guardPathTool(createFffFindTool(finder, workspace.path), workspace.path, extraAllowedRoots),
      guardPathTool(createFffGrepTool(finder, workspace.path), workspace.path, extraAllowedRoots),
    )
  }
  // 网络搜索:子代理联网(与主代理同一工厂;独立会话注册表,无去重问题)
  tools.push(...createAnySearchTools({ getApiKey: getAnySearchApiKey }))
  const activeNames = [
    'read',
    'ls',
    ...tools.filter((t) => t.name.startsWith('fff-')).map((t) => t.name),
    'anysearch-search',
  ]

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

/** 镜像主会话事件为 sub_* 事件(挂载 callId)。导出供单测。 */
export function toSubEvents(callId: string, event: AgentSessionEvent, onProgress?: (delta: string) => void): SessionEvent[] {
  const out: SessionEvent[] = []
  const push = (evt: SessionEvent): void => {
    out.push(evt)
  }
  switch (event.type) {
    case 'message_start': {
      // 只镜像 user / assistant 消息。工具结果消息(SDK 以 role=toolResult 推送)
      // 不镜像:内容已由 sub_tool_end 携带,镜像会在前端模态窗产生一条条
      // 只有闪烁光标(showCaretRow)的空消息。
      const role = event.message.role
      if (role !== 'user' && role !== 'assistant') return out
      // user 消息(子代理任务)直接附带完整文本,否则前端无法渲染任务内容
      const text = role === 'user' ? extractText(event.message.content) : undefined
      push({
        type: 'sub_message_start',
        callId,
        role,
        id: `${event.message.timestamp}-${role}`,
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

/**
 * 子代理结束时产物文件检测(相对工作区根)。导出供单测。
 * 优先级:
 * 1. 精确命中:服务端注入的预期名(expectedName)存在 → 直接返回(快路径)
 * 2. 前缀扫描兜底:内置角色按 ROLE_ARTIFACT 基名推导前缀,取 run 目录下最新命中文件
 *    (覆盖模型写成旧名/近似名的容错)
 * 3. 自定义代理:保留原逻辑(白名单单层 * 替换 runId 后精确 existsSync)
 */
export function detectArtifact(
  workspace: Workspace,
  run: RunFile,
  definition: AgentDefinition,
  expectedName: string | null,
): string | null {
  if (expectedName) {
    const p = path.join('.wf-runs', run.runId, expectedName)
    if (workspaceHasFile(workspace.path, p)) return p
  }
  const roleName = definition.frontmatter.name
  const fixed = ROLE_ARTIFACT[roleName]
  if (fixed) {
    const prefix = fixed.replace(/\.md$/, '')
    return newestArtifactInRunDir(workspace.path, run, (name) => name.startsWith(prefix) && name.endsWith('.md'))
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
 * run 产物目录中最新命中谓词的文件(相对工作区根);无则 null。
 * 排序:(mtimeMs, 文件名)双键降序——同时刻按文件名降序,保证确定性。
 */
function newestArtifactInRunDir(
  workspacePath: string,
  run: RunFile,
  predicate: (name: string) => boolean,
): string | null {
  const dir = path.join(workspacePath, '.wf-runs', run.runId)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const matches = entries
    .filter((name) => predicate(name))
    .map((name) => {
      const stat = statSync(path.join(dir, name), { throwIfNoEntry: false })
      return { name, isFile: stat?.isFile() ?? false, mtimeMs: stat?.mtimeMs ?? 0 }
    })
    .filter((m) => m.isFile)
  if (matches.length === 0) return null
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1))
  return path.join('.wf-runs', run.runId, matches[0].name)
}

/** 子代理执行失败(携带会话文件,供失败调用在模态窗回看) */
export class SubAgentError extends Error {
  readonly sessionFile: string | null
  constructor(message: string, sessionFile: string | null, cause?: unknown) {
    super(message, { cause })
    this.name = 'SubAgentError'
    this.sessionFile = sessionFile
  }
}

/**
 * 运行子代理:创建独立会话(prompt = 任务 + 产物目录说明),镜像事件,返回摘要。
 */
export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
  const { store, runtime, fff, workspace, definition, run, callId, task, model, thinkingLevel, onEvent, signal } = options
  const name = definition.frontmatter.name
  const matcher = compileWriteMatcher(definition.frontmatter.write)
  // 与主代理共用同一 SkillLoadContext 与放行根(主/子代理 skills 与只读边界一致)
  const skillCtx: SkillLoadContext = { cwd: workspace.path, skillsDir: store.skillsDir }
  const { tools, activeNames } = buildSubAgentTools({
    workspace,
    definition,
    fff,
    matcher,
    getAnySearchApiKey: () => loadConfig(store).anySearchApiKey ?? undefined,
    extraAllowedRoots: skillReadRoots(skillCtx),
  })

  // 子代理会话目录:每个调用一个 JSONL(模态窗按 callId 回看)
  const sessionDir = path.join(store.agentDir, 'sessions', workspace.id, 'sub', run.runId)
  const sessionManager = SessionManager.create(workspace.path, sessionDir)

  // system prompt:md 正文 + 任务运行约定;经轻量 ResourceLoader 注入(SDK 原生支持)
  // skills:与主代理共用同一 SkillLoadContext(四来源),保证主/子代理 skills 一致
  const resourceLoader = createPromptOnlyLoader({
    systemPrompt: definition.body,
    skills: skillCtx,
  })

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
    // 方案 B:调用前按 run.agents 同角色计数算序号,注入权威产物文件名
    // (白名单只允许 `NN-role-*.md`,模型无自由度写旧名覆盖历史产物)
    const artifactName = nextArtifactName(run, name)
    const runDirRel = `.wf-runs/${run.runId}`
    const promptText = artifactName
      ? `${task}\n\n产物目录(相对工作区根):${runDirRel}\n产物文件:${`.wf-runs/${run.runId}/${artifactName}`}\n最终回复只给摘要。`
      : `${task}\n\n产物目录(相对工作区根):${runDirRel}\n最终回复只给摘要。`
    await session.prompt(promptText)
    const summary = extractSummary(session)
    const artifact = detectArtifact(workspace, run, definition, artifactName)
    const sessionFile = session.sessionFile ? path.relative(store.agentDir, session.sessionFile) : null
    session.dispose()
    return { summary, artifact, sessionFile }
  } catch (error) {
    // 先取会话文件再 dispose:失败调用也要能回看历史(模态窗)
    const sessionFile = session.sessionFile ? path.relative(store.agentDir, session.sessionFile) : null
    session.dispose()
    const message = error instanceof Error ? error.message : String(error)
    throw new SubAgentError(`子代理 ${name} 执行失败:${message}`, sessionFile, error)
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
