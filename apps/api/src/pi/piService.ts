import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Type } from 'typebox'
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
import { createFffFindTool, createFffGrepTool, FffIndexManager } from './fffTools.js'
import { createAnySearchTools } from './anySearchTools.js'
import { getAgentDefinitions } from './agentDefs.js'
import { createPromptOnlyLoader } from './promptLoader.js'
import { runSubAgent, SubAgentError, type SubAgentResult } from './subAgent.js'
import { renderHistory } from './history.js'
import {
  appendRunAgentCall,
  createRun,
  decideTurnEnd,
  listRuns,
  resolveCurrentRun,
  saveRun,
  toSnapshot,
  type RunFile,
} from './runManager.js'
import type {
  AgentConfig,
  HistoryItem,
  RunSnapshot,
  SessionEvent,
  SessionMeta,
  SessionStatus,
  Workspace,
} from '@workflows/shared'
import {
  createStore,
  getActiveSession,
  getSession,
  hasAnySearchApiKey,
  hasApiKey,
  listSessions,
  loadConfig,
  migrateSessionsLayout,
  mutateSessions,
  removeSession,
  removeWorkspaceSessions,
  sessionDirFor,
  sessionFileFor,
  setAnySearchApiKey,
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
  /** 当前 run(本次需求处理);无则 null */
  run: RunFile | null
  /** 本回合是否调用过 wait_for_approval(回合结束时决定 run 状态) */
  turnWaitCalled: boolean
  /** 本回合是否调用过 complete_task(显式任务完成声明) */
  turnCompleteCalled: boolean
  /** 本回合是否调用过子代理(区分中途停止与纯文本交付回合) */
  turnSubAgentCalled: boolean
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
  /** 每工作区一个 fff 索引(原生 Rust,毫秒级搜索;清理随工作区) */
  private readonly fff = new FffIndexManager()
  /** 当前 prompt 回合的 SSE 事件回调(子代理工具执行时经此转发 sub_* 事件) */
  private activeEmitter: ((event: SessionEvent) => void) | null = null

  private constructor(store: WorkflowsStore, runtime: ModelRuntime) {
    this.store = store
    this.runtime = runtime
  }

  static async create(): Promise<PiAgentService> {
    const store = createStore()
    // 旧版平铺会话文件 → sessions/<workspaceId>/ 子目录迁移
    migrateSessionsLayout(store)
    // 防御:代理定义缺失时启动即失败,避免生产环境静默降级为普通编码助手。
    // tsc 不复制 .md,构建脚本(copy-agents.mjs)负责把 agents/*.md 复制到 dist/pi/agents;
    // 一旦复制步骤失效,这里立即抛错,而不是让 orchestrator.md / 子代理工具静默消失。
    const defs = getAgentDefinitions(store)
    if (!defs.has('orchestrator')) {
      throw new Error(
        '未加载到主代理定义(orchestrator):请确认构建产物包含 agents/*.md(dist/pi/agents)。' +
          '若从源码运行请检查 src/pi/agents 目录。',
      )
    }
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

  /** 保存用户手动输入的 AnySearch API key(仅存 .workflows/config.json;工具执行时动态读取,无需运行时注入) */
  setAnySearchApiKey(key: string): void {
    setAnySearchApiKey(this.store, key)
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
      hasAnySearchApiKey: hasAnySearchApiKey(this.store),
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
    // - 搜索工具:fff 优先(每工作区常驻索引,毫秒级);fff 创建失败时回退内置 grep/find
    const builtinTools = workspace.readOnly
      ? createReadOnlyTools(workspace.path)
      : createCodingTools(workspace.path).filter((tool) => tool.name !== 'bash')
    const nonSearchTools = builtinTools
      .filter((tool) => tool.name !== 'grep' && tool.name !== 'find')
      .map((tool) => guardPathTool(toToolDefinition(tool), workspace.path))
    const finder = this.fff.get(workspace.id, workspace.path)
    const searchTools: ToolDefinition[] = finder
      ? [
          guardPathTool(createFffFindTool(finder, workspace.path), workspace.path),
          guardPathTool(createFffGrepTool(finder, workspace.path), workspace.path),
        ]
      : builtinTools
          .filter((tool) => tool.name === 'grep' || tool.name === 'find')
          .map((tool) => guardPathTool(toToolDefinition(tool), workspace.path))
    // 网络搜索工具:无 path 参数,不需 guardPathTool;key 可匿名调用,env 优先,config 回退
    // (getApiKey 动态读 config.json,保存后下次调用立即生效,无需重启会话)
    const webTools = createAnySearchTools({
      getApiKey: () => loadConfig(this.store).anySearchApiKey ?? undefined,
    })
    const webToolNames = webTools.map((tool) => tool.name)
    const guardedTools: ToolDefinition[] = workspace.readOnly
      ? [...nonSearchTools, ...searchTools, ...webTools]
      : [
          ...nonSearchTools,
          ...searchTools,
          ...webTools,
          toToolDefinition(createBashTool(workspace.path, { spawnHook: createWorkspaceBashHook(workspace.path) })),
        ]
    // 注意:SDK 的 allowedToolNames(tools 参数)会过滤 customTools 注册表,
    // 所以 fff 工具与 anysearch-search 必须显式列入;内置 grep/find 不列入即不开放
    const searchNames = searchTools.map((tool) => tool.name)
    const activeTools = workspace.readOnly
      ? ['read', 'ls', ...searchNames, ...webToolNames]
      : ['read', 'bash', 'edit', 'write', ...searchNames, ...webToolNames]

    // ---- 工作流编排:主代理 prompt(orchestrator.md)+ 子代理工具 ----
    const agentDefs = getAgentDefinitions(this.store)
    const orchestrator = agentDefs.get('orchestrator')
    // 主代理的可用子代理白名单:agents 字段;省略 = 全部已注册(除 orchestrator 自身)
    const allAgentNames = [...agentDefs.keys()].filter((n) => n !== 'orchestrator')
    const subAgentNames = orchestrator?.frontmatter.agents ?? allAgentNames
    const subAgentTools: ToolDefinition[] = []
    for (const name of subAgentNames) {
      const def = agentDefs.get(name)
      if (!def) {
        console.error(`[agents] 主代理白名单引用了不存在的子代理「${name}」,已跳过`)
        continue
      }
      subAgentTools.push(this.createSubAgentTool(workspace, def))
    }
    // 闸门工具:主代理调用后暂停等待用户批准
    subAgentTools.push(this.createWaitForApprovalTool(workspace))
    // 任务完成工具:主代理在最终交付时显式声明完成(与闸门对称,置 done + 释放)
    subAgentTools.push(this.createCompleteTaskTool(workspace))

    // 主代理 system prompt:默认 prompt + orchestrator 调度策略(追加,不替换默认规则)
    const mainResourceLoader = createPromptOnlyLoader(undefined, orchestrator ? [orchestrator.body] : undefined)

    const { session } = await createAgentSession({
      cwd: workspace.path,
      agentDir: this.store.agentDir,
      modelRuntime: this.runtime,
      model,
      thinkingLevel: (stored.thinkingLevel as ModelThinkingLevel | undefined) ?? 'off',
      sessionManager,
      resourceLoader: mainResourceLoader,
      customTools: [...guardedTools, ...subAgentTools],
      // 权限:只读工作区仅暴露只读工具;内置 grep/find 不开放,由 fff-find/fff-grep 取代
      tools: [...activeTools, ...subAgentTools.map((t) => t.name)],
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
      // 恢复:磁盘上存在未完成 / 待闸门的 run 则沿用(归并),否则下次子代理调用新建
      run: resolveCurrentRun(workspace.path, finalId, null),
      turnWaitCalled: false,
      turnCompleteCalled: false,
      turnSubAgentCalled: false,
    }
    this.handles.set(workspace.id, handle)
    return handle
  }

  /* ---------------- 工作流编排:子代理工具 ---------------- */

  /** 确保存在可用的 run:进行中归并;create=true(默认)时未命中则新建,false 时不新建并返回 null */
  private ensureRun(handle: SessionHandle): RunFile
  private ensureRun(handle: SessionHandle, create: false): RunFile | null
  private ensureRun(handle: SessionHandle, create = true): RunFile | null {
    const workspace = handle.workspace
    const currentId = handle.run?.runId ?? null
    // done 即终态:已完成的 run 不再内存归并(走 resolveCurrentRun 的 done 排除 / createRun 新建)
    const run =
      handle.run && handle.run.status !== 'done'
        ? handle.run
        : resolveCurrentRun(workspace.path, handle.sessionId, currentId)
    if (run) {
      handle.run = run
      return run
    }
    if (!create) return null
    const created = createRun(workspace.path, handle.sessionId)
    handle.run = created
    return created
  }

  /**
   * 子代理工具:主代理调用时启动独立子代理会话。
   * 事件镜像(sub_* 事件 + callId)经 activeEmitter 转发给前端。
   */
  private createSubAgentTool(workspace: Workspace, def: import('./agentDefs.js').AgentDefinition): ToolDefinition {
    const name = def.frontmatter.name
    const description = def.frontmatter.description ?? `子代理 ${name}`
    const params = Type.Object({
      task: Type.String({ description: '交给子代理的任务说明(要具体:目标、范围、约束)' }),
    })
    return {
      name,
      label: name,
      description: `${description}。调用后返回子代理的最终摘要;子代理详情会以 sub_* 事件流式呈现。`,
      promptSnippet: `Invoke sub-agent ${name}`,
      parameters: params,
      execute: async (callId, params, signal, onUpdate) => {
        const handle = this.handles.get(workspace.id)
        if (!handle) throw new Error('会话已关闭')
        // 本回合调过子代理(try 外:失败调用也计数 → 回合结束落入 keep 而非 done)
        handle.turnSubAgentCalled = true
        const run = this.ensureRun(handle)
        // 循环上限兜底(代码级,不依赖模型自觉):
        // 审查⇄执行最多 3 轮;全流程回到 planner 最多 2 次,超限强制收尾
        const reviewerCalls = run.agents.filter((a) => a.agent === 'reviewer').length
        const plannerCalls = run.agents.filter((a) => a.agent === 'planner').length
        if (name === 'executor' && reviewerCalls >= 3) {
          throw new Error('执行⇄审查循环已达 3 轮上限。立即收尾:总结仍未解决的问题清单,向用户交付,不要再调用任何子代理。')
        }
        if (name === 'planner' && plannerCalls >= 2) {
          throw new Error('重做计划已达 2 次上限。立即收尾:总结仍未解决的问题清单,向用户交付,不要再调用任何子代理。')
        }
        // 子代理运行中 run 进入执行态(闸门续跑翻回 executing;done 为终态,永不回退)
        if (run.status === 'awaiting_approval') run.status = 'executing'
        run.gate.pending = false
        saveRun(workspace.path, run)

        const task = (params as { task: string }).task
        const model = handle.session.model
        const thinkingLevel = handle.session.thinkingLevel ?? 'off'
        let result: SubAgentResult
        try {
          result = await runSubAgent({
            store: this.store,
            runtime: this.runtime,
            fff: this.fff,
            workspace,
            definition: def,
            run,
            callId,
            task,
            model,
            thinkingLevel,
            onEvent: (evt) => this.activeEmitter?.(evt),
            onProgress: (delta) => onUpdate?.({ content: [{ type: 'text' as const, text: delta }], details: undefined }),
            signal,
          })
        } catch (error) {
          // 失败也要收尾:记录调用 + 发 sub_end(isError)。
          // 否则前端模态窗永远停在「● 运行中」且光标持续闪烁。
          const message = error instanceof Error ? error.message : String(error)
          appendRunAgentCall(workspace.path, run, {
            callId,
            agent: name,
            summary: message,
            artifact: null,
            sessionFile: error instanceof SubAgentError ? error.sessionFile : null,
            ts: Date.now(),
          })
          this.activeEmitter?.({
            type: 'sub_end',
            callId,
            agentName: name,
            summary: message,
            artifact: null,
            isError: true,
          })
          throw error
        }
        // 记录调用(模态窗回看 + 快照)
        appendRunAgentCall(workspace.path, run, {
          callId,
          agent: name,
          summary: result.summary,
          artifact: result.artifact,
          sessionFile: result.sessionFile,
          ts: Date.now(),
        })
        this.activeEmitter?.({
          type: 'sub_end',
          callId,
          agentName: name,
          summary: result.summary,
          artifact: result.artifact,
          isError: false,
        })
        return { content: [{ type: 'text' as const, text: result.summary }], details: undefined }
      },
    }
  }

  /** 闸门工具:主代理调用后暂停,等待用户批准/驳回 */
  private createWaitForApprovalTool(workspace: Workspace): ToolDefinition {
    const params = Type.Object({
      summary: Type.String({ description: '给用户的计划摘要(改动范围、关键步骤)' }),
    })
    return {
      name: 'wait_for_approval',
      label: 'wait_for_approval',
      description:
        '暂停工作流等待用户批准。计划类需求在计划完成后必须调用此工具,然后立即结束回合,等待用户决定。',
      promptSnippet: 'Pause workflow and wait for user approval',
      parameters: params,
      execute: async (_callId, params) => {
        const handle = this.handles.get(workspace.id)
        if (!handle) throw new Error('会话已关闭')
        // 无进行中 run 时不新建:直接提示,不置闸门标志、不落盘
        const run = this.ensureRun(handle, false)
        if (!run) {
          return {
            content: [{ type: 'text' as const, text: '当前没有进行中的任务,无需请求批准。' }],
            details: undefined,
          }
        }
        const summary = (params as { summary: string }).summary
        run.status = 'awaiting_approval'
        run.gate = { pending: true, planFile: detectPlanFile(workspace.path, run) }
        saveRun(workspace.path, run)
        handle.turnWaitCalled = true
        this.activeEmitter?.({
          type: 'gate_required',
          runId: run.runId,
          planFile: run.gate.planFile,
          summary,
        })
        return {
          content: [
            {
              type: 'text' as const,
              text: '已请求用户批准。立即停止当前回合,不要继续调用任何工具,等待用户决定。',
            },
          ],
          details: undefined,
        }
      },
    }
  }

  /** 任务完成工具:主代理在最终交付完成时显式声明完成,run 置 done + 释放(与 wait_for_approval 对称) */
  private createCompleteTaskTool(workspace: Workspace): ToolDefinition {
    const params = Type.Object({
      summary: Type.String({ description: '交付总结(已完成内容、关键产物位置)' }),
    })
    return {
      name: 'complete_task',
      label: 'complete_task',
      description:
        '声明当前任务已全部完成(最终交付)。仅当存在进行中的任务且任务确实已完成时调用此工具并立即结束回合;' +
        '没有进行中任务时(如咨询、问答、查看状态)不要调用此工具,直接以文本回应即可。' +
        '调用后本任务的 run 标记为完成,下一次新需求将开启新的 run(新产物目录)。',
      promptSnippet: 'Mark the current task as complete',
      parameters: params,
      execute: async (_callId, _params) => {
        const handle = this.handles.get(workspace.id)
        if (!handle) throw new Error('会话已关闭')
        // 无进行中 run 时不新建:直接提示,不置完成标志、不落盘、不释放
        const run = this.ensureRun(handle, false)
        if (!run) {
          return {
            content: [{ type: 'text' as const, text: '当前没有进行中的任务,无需调用 complete_task。' }],
            details: undefined,
          }
        }
        handle.turnCompleteCalled = true
        run.status = 'done'
        run.gate = { pending: false, planFile: null }
        // 立即落盘:崩溃安全(complete_task 后进程崩溃,任务已完成状态不丢)
        saveRun(workspace.path, run)
        // 立即释放:done 即终态,收窄「complete_task 后同回合改写」窗口。
        // 配合 ensureRun 的 done 检查:后续工具调用(子代理/闸门)经 ensureRun 新建 run 而非复用本 run;
        // finally 因 handle.run 为 null 跳过三分支,闸门决策(turnWaitCalled 优先)不再能把 done 复活。
        handle.run = null
        return {
          content: [
            {
              type: 'text' as const,
              text: '任务已标记为完成。立即结束回合,向用户做最终交付总结。',
            },
          ],
          details: undefined,
        }
      },
    }
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
    // 清理工作区会话目录(主会话 JSONL 已删;残留的 sub/ 子代理会话一并清除)
    rmSync(sessionDirFor(this.store, workspace.id), { force: true, recursive: true })
    // 释放 fff 索引原生资源
    this.fff.dispose(workspace.id)
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
    // 新回合:重置回合内标志(闸门 / 任务完成 / 子代理调用),挂载事件发射器(子代理工具经此转发 sub_* 事件)
    handle.turnWaitCalled = false
    handle.turnCompleteCalled = false
    handle.turnSubAgentCalled = false
    let turnFailed = false
    this.activeEmitter = onEvent

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
      // 回合失败(错误/abort):不处置 run,保守保持(对齐 docs §8「崩溃 = 标记中止 + 手动续跑」)
      turnFailed = true
      onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      // 回合结束:三分支决策(单一事实源:decideTurnEnd)
      // - 失败(turnFailed)→ keep:不写盘、不释放,下条消息归并
      // - 闸门(turnWaitCalled)→ awaiting_approval + gate(不释放,闸门续跑归并)
      // - 完成(turnCompleteCalled)或纯文本交付回合(未调任何子代理/闸门/完成)→ done + 释放
      // - 其余(调过子代理但中途停止)→ keep:run 保持 executing,下条消息自然归并同 runId
      const run = handle.run
      if (run) {
        const decision = decideTurnEnd({
          turnFailed,
          turnWaitCalled: handle.turnWaitCalled,
          turnCompleteCalled: handle.turnCompleteCalled,
          turnSubAgentCalled: handle.turnSubAgentCalled,
        })
        if (decision === 'awaiting_approval') {
          run.status = 'awaiting_approval'
          run.gate = { pending: true, planFile: detectPlanFile(workspace.path, run) }
          saveRun(workspace.path, run)
        } else if (decision === 'done') {
          // done 已由 complete_task 落盘时不再重复写(消除 updatedAt 二次 bump);仅首次进入 done 时写盘
          if (run.status !== 'done') {
            run.status = 'done'
            run.gate.pending = false
            run.gate.planFile = null // 顺手清理残留(探索报告 §5 观察)
            saveRun(workspace.path, run)
          }
          // 任务完成释放:done 的 run 不再被本会话后续需求复用
          // (keep / awaiting_approval 分支不置空:前者内存归并,后者闸门续跑归并)
          handle.run = null
        }
        // decision === 'keep':不写盘、不释放。
        // 中途停止回合:status 已在子代理工具 execute 时置 executing 并落盘,
        // 这里不写盘避免无谓写盘与 updatedAt 漂移;handle.run 保留 → 下回合 ensureRun 直接内存归并。
      }
      unsubscribe()
      handle.busy = false
      handle.lastActivityAt = Date.now()
      this.activeEmitter = null
      updateSessionMeta(this.store, workspace.id, handle.sessionId, {
        messageCount: handle.session.messages.length,
      })
    }
  }

  /* ---------------- run 快照与子代理历史 ---------------- */

  /** 当前 run 快照(前端 / 恢复用);无 run 返回 null(含已完成 run,供历史展示) */
  getRunSnapshot(workspace: Workspace, sessionId: string): RunSnapshot | null {
    const handle = this.handles.get(workspace.id)
    const run =
      handle?.run ??
      listRuns(workspace.path).find((r) => r.sessionId === sessionId) ??
      null
    if (!run) return null
    // 方案 A 配套:只回填非 done run——否则磁盘上已完成的 run 会被重新挂回 handle,
    // 下一任务再次复用旧 runId,回合释放(handle.run = null)失效
    if (handle && !handle.run && run.status !== 'done') handle.run = run
    return toSnapshot(run)
  }

  /** 子代理调用历史(模态窗回看):从 sub JSONL 恢复会话并渲染 */
  async getSubAgentHistory(workspace: Workspace, sessionId: string, callId: string): Promise<HistoryItem[]> {
    // callId 可能属于该会话的任意一个 run(不一定是最新),遍历查找
    const run = listRuns(workspace.path).find(
      (r) => r.sessionId === sessionId && r.agents.some((a) => a.callId === callId),
    )
    const call = run?.agents.find((a) => a.callId === callId)
    if (!call?.sessionFile) return []
    const file = path.join(this.store.agentDir, call.sessionFile)
    if (!existsSync(file)) return []
    const manager = SessionManager.open(file)
    const { session } = await createAgentSession({
      cwd: workspace.path,
      agentDir: this.store.agentDir,
      modelRuntime: this.runtime,
      sessionManager: manager,
      tools: [],
    })
    const history = renderHistory(session)
    session.dispose()
    return history
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

/**
 * 检测计划文件(相对工作区根);不存在返回 null。
 * 前缀扫描:取 run 目录下最新 `02-plan*.md`(支持首次 02-plan-1.md 与重做 02-plan-2.md)。
 */
function detectPlanFile(workspacePath: string, run: RunFile): string | null {
  const dir = path.join(workspacePath, '.wf-runs', run.runId)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const matches = entries
    .filter((name) => name.startsWith('02-plan') && name.endsWith('.md'))
    .map((name) => {
      const stat = statSync(path.join(dir, name), { throwIfNoEntry: false })
      return { name, isFile: stat?.isFile() ?? false, mtimeMs: stat?.mtimeMs ?? 0 }
    })
    .filter((m) => m.isFile)
  if (matches.length === 0) return null
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1))
  return path.join('.wf-runs', run.runId, matches[0].name)
}
