import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { DirListing, Workspace } from '@workflows/shared'

/**
 * .workflows 配置根目录(分环境):
 * - 开发环境:NODE_ENV !== production → <repo>/.workflows
 * - 生产环境:NODE_ENV === production  → ~/.workflows
 *
 * 说明:src/ 与 dist/ 下均向上三级到仓库根,两条路径一致。
 */
export function workflowsRoot(): string {
  const isProduction = process.env.NODE_ENV === 'production'
  if (isProduction) {
    return path.join(homedir(), '.workflows')
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.workflows')
}

interface StoredConfig {
  apiKey?: string
  /** AnySearch 搜索 API key(可选;env ANYSEARCH_API_KEY 优先于配置文件) */
  anySearchApiKey?: string
  /** 视觉模型开关(默认关;开启且配置 key 后,主/子代理注册 vision-understand 工具) */
  visionEnabled?: boolean
  /** 小米视觉 API key(可选;env XIAOMI_API_KEY 优先于配置文件;明文存储,不回传前端) */
  visionApiKey?: string
  model?: string
  thinkingLevel?: string
  /** planner 重做上限(可选):缺省/0/负数 = 无上限;≥1 的数字 = 同一 run 内 planner 最多调用 N 次 */
  plannerMaxRetries?: number
}

export interface WorkflowsStore {
  /** 配置根目录 */
  root: string
  /** agent 隔离目录(auth/models/settings/sessions 均在此,不触碰 ~/.pi/agent) */
  agentDir: string
  /** 用户自定义代理目录(同名覆盖内置 agents) */
  agentsDir: string
  /** 工作台 skills 目录(<root>/.workflows/skills,来源之一) */
  skillsDir: string
  configPath: string
  workspacesPath: string
  sessionsPath: string
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function createStore(): WorkflowsStore {
  const root = workflowsRoot()
  ensureDir(root)
  const agentDir = path.join(root, 'agent')
  ensureDir(agentDir)
  const agentsDir = path.join(root, 'agents')
  ensureDir(agentsDir)
  const skillsDir = path.join(root, 'skills')
  ensureDir(skillsDir)
  return {
    root,
    agentDir,
    agentsDir,
    skillsDir,
    configPath: path.join(root, 'config.json'),
    workspacesPath: path.join(root, 'workspaces.json'),
    sessionsPath: path.join(root, 'workspace-sessions.json'),
  }
}

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

/* ---------------- config.json ---------------- */

export function loadConfig(store: WorkflowsStore): StoredConfig {
  return readJson<StoredConfig>(store.configPath, {})
}

export function saveConfig(store: WorkflowsStore, patch: Partial<StoredConfig>): StoredConfig {
  const next = { ...loadConfig(store), ...patch }
  // 显式清除字段(空字符串视为删除)
  for (const [key, value] of Object.entries(patch)) {
    if (value === '' || value === null) {
      delete (next as Record<string, unknown>)[key]
    }
  }
  writeJson(store.configPath, next)
  return next
}

/** 保存用户手动输入的 API key 到 .workflows/config.json */
export function setApiKey(store: WorkflowsStore, key: string): void {
  saveConfig(store, { apiKey: key.trim() })
}

/** 是否已配置 key(不把 key 本身返回给前端) */
export function hasApiKey(store: WorkflowsStore): boolean {
  return Boolean(loadConfig(store).apiKey)
}

/** 保存用户手动输入的 AnySearch API key 到 .workflows/config.json(空串=删除,由 saveConfig 处理) */
export function setAnySearchApiKey(store: WorkflowsStore, key: string): void {
  saveConfig(store, { anySearchApiKey: key.trim() })
}

/** 是否已配置 AnySearch key(不把 key 本身返回给前端) */
export function hasAnySearchApiKey(store: WorkflowsStore): boolean {
  return Boolean(loadConfig(store).anySearchApiKey)
}

/**
 * 保存视觉模型开关与小米 key(空串 apiKey = 删除,由 saveConfig 处理;开关翻转由 piService 负责会话重建)。
 * patch 用业务键(enabled/apiKey),映射到存储键(visionEnabled/visionApiKey);未提供的字段不触碰。
 */
export function setVisionConfig(store: WorkflowsStore, patch: { enabled?: boolean; apiKey?: string }): void {
  const stored: Partial<StoredConfig> = {}
  if (patch.enabled !== undefined) stored.visionEnabled = patch.enabled
  if (patch.apiKey !== undefined) stored.visionApiKey = patch.apiKey
  saveConfig(store, stored)
}

/** 视觉模型开关是否开启(默认关) */
export function getVisionEnabled(store: WorkflowsStore): boolean {
  return loadConfig(store).visionEnabled === true
}

/** 是否已配置小米视觉 key(env XIAOMI_API_KEY 优先于配置文件;不把 key 本身返回给前端) */
export function hasVisionApiKey(store: WorkflowsStore): boolean {
  if (process.env.XIAOMI_API_KEY?.trim()) return true
  return Boolean(loadConfig(store).visionApiKey)
}

/**
 * 视觉工具注册门(主/子代理共用单一事实源):开关开 && (env XIAOMI_API_KEY || 配置 key)。
 * 任一不满足 → 不注册(模型视野中无 vision-understand 工具)。
 */
export function visionAvailable(store: WorkflowsStore): boolean {
  return getVisionEnabled(store) && Boolean(process.env.XIAOMI_API_KEY?.trim() || hasVisionApiKey(store))
}

/* ---------------- workspaces.json ---------------- */

interface StoredWorkspaces {
  workspaces: Workspace[]
}

export function loadWorkspaces(store: WorkflowsStore): Workspace[] {
  return readJson<StoredWorkspaces>(store.workspacesPath, { workspaces: [] }).workspaces
}

export function addWorkspace(store: WorkflowsStore, dir: string): Workspace | undefined {
  const resolved = path.resolve(dir)
  if (!isDirectory(resolved)) return undefined
  const workspaces = loadWorkspaces(store)
  // Windows/macOS 大小写不敏感:同一目录不同大小写写法视为重复
  if (workspaces.some((w) => samePath(w.path, resolved))) return undefined
  const workspace: Workspace = {
    id: randomUUID(),
    path: resolved,
    name: path.basename(resolved),
    readOnly: false,
    createdAt: Date.now(),
  }
  writeJson(store.workspacesPath, { workspaces: [...workspaces, workspace] })
  return workspace
}

export function updateWorkspace(
  store: WorkflowsStore,
  id: string,
  patch: Partial<Pick<Workspace, 'readOnly'>>,
): Workspace | undefined {
  const workspaces = loadWorkspaces(store)
  const index = workspaces.findIndex((w) => w.id === id)
  if (index === -1) return undefined
  const next = { ...workspaces[index], ...patch }
  workspaces[index] = next
  writeJson(store.workspacesPath, { workspaces })
  return next
}

export function removeWorkspace(store: WorkflowsStore, id: string): boolean {
  const workspaces = loadWorkspaces(store)
  const next = workspaces.filter((w) => w.id !== id)
  if (next.length === workspaces.length) return false
  writeJson(store.workspacesPath, { workspaces: next })
  return true
}

function isDirectory(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 路径等价比较:Windows/macOS 默认大小写不敏感,折叠大小写后比较;Linux 严格比较 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = platform === 'win32' || platform === 'darwin'
  return fold ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 目录名分块:数字段与文本段交替,如 "pkg-10" → ["pkg-", "10"] */
const NAME_CHUNK_RE = /(\d+)|(\D+)/g

function nameChunks(name: string): string[] {
  return name.toLowerCase().match(NAME_CHUNK_RE) ?? []
}

/** 比较两个分块数组:数字段按数值、文本段按字典序;与系统 locale 无关(跨平台结果一致) */
function compareChunks(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ca = a[i]
    const cb = b[i]
    if (ca === undefined) return -1
    if (cb === undefined) return 1
    if (ca === cb) continue
    const aNum = ca[0] >= '0' && ca[0] <= '9'
    const bNum = cb[0] >= '0' && cb[0] <= '9'
    if (aNum && bNum) {
      // 数字段:去前导零后先比长度(避免数值精度问题),再按字典序;相等则继续
      const na = ca.replace(/^0+/, '') || '0'
      const nb = cb.replace(/^0+/, '') || '0'
      if (na.length !== nb.length) return na.length - nb.length
      if (na !== nb) return na < nb ? -1 : 1
      continue
    }
    return ca < cb ? -1 : 1
  }
  return 0
}

/** 目录名自然排序:数字感知(README-2 < README-10)、大小写不敏感、隐藏目录在前。确定性且跨平台一致。 */
function sortNames(names: string[]): string[] {
  const chunks = names.map(nameChunks)
  const order = names.map((_, i) => i)
  order.sort((i, j) => {
    const byChunks = compareChunks(chunks[i], chunks[j])
    if (byChunks !== 0) return byChunks
    // 分块相等(如大小写变体)时按原始名称定序,保证全序确定性
    return names[i] < names[j] ? -1 : names[i] > names[j] ? 1 : 0
  })
  return order.map((i) => names[i])
}

/**
 * 列出目录下的子目录(供前端目录选择器浏览)。
 * 仅返回目录、自然排序、含隐藏目录;符号链接指向的目录(pnpm 链接、macOS /tmp、Windows junction)一并包含,
 * 断链忽略。不可读或不存在时返回 undefined。
 */
export function listDirectory(dir: string): DirListing | undefined {
  try {
    if (!isDirectory(dir)) return undefined
    const names: string[] = []
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory()) {
        names.push(d.name)
      } else if (d.isSymbolicLink()) {
        // 仅对符号链接 stat(普通目录零额外系统调用):跟随链接确认目标为目录
        try {
          if (statSync(path.join(dir, d.name)).isDirectory()) names.push(d.name)
        } catch {
          // 断链或目标不可达,忽略
        }
      }
    }
    const parent = path.parse(dir).root === dir ? null : path.dirname(dir)
    return { path: dir, parent, entries: sortNames(names).map((name) => ({ name })) }
  } catch {
    return undefined
  }
}

/* ---------------- workspace-sessions.json ---------------- */
// workspaceId → 会话状态(一个工作区多个持久化会话,JSONL 按工作区隔离在 agentDir/sessions/<workspaceId>/)
// 旧格式(单会话:workspaceId → 文件路径)在读取时自动迁移

export interface StoredSessionMeta {
  id: string
  sessionFile: string
  createdAt: number
  messageCount: number
}

export interface WorkspaceSessionsState {
  sessions: Record<string, StoredSessionMeta>
  active: string | null
}

type StoredSessionsFile = Record<string, WorkspaceSessionsState | string>

function saveSessionsFile(store: WorkflowsStore, file: Record<string, WorkspaceSessionsState>): void {
  writeJson(store.sessionsPath, file)
}

function loadSessionsFile(store: WorkflowsStore): Record<string, WorkspaceSessionsState> {
  const raw = readJson<StoredSessionsFile>(store.sessionsPath, {})
  const out: Record<string, WorkspaceSessionsState> = {}
  let migrated = false
  for (const [workspaceId, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      // 旧格式单会话映射 → 迁移为新结构(JSONL 文件本身不动)
      const id = randomUUID()
      out[workspaceId] = {
        sessions: { [id]: { id, sessionFile: value, createdAt: Date.now(), messageCount: 0 } },
        active: id,
      }
      migrated = true
    } else if (value && typeof value === 'object') {
      out[workspaceId] = value
    }
  }
  if (migrated) saveSessionsFile(store, out)
  return out
}

/** 变更工作区会话状态,自动持久化;返回变更后的状态 */
export function mutateSessions(
  store: WorkflowsStore,
  workspaceId: string,
  mutate: (state: WorkspaceSessionsState) => void,
): WorkspaceSessionsState {
  const file = loadSessionsFile(store)
  const state: WorkspaceSessionsState = file[workspaceId] ?? { sessions: {}, active: null }
  mutate(state)
  file[workspaceId] = state
  saveSessionsFile(store, file)
  return state
}

/** 工作区会话列表(按创建时间降序,最新在前) */
export function listSessions(store: WorkflowsStore, workspaceId: string): StoredSessionMeta[] {
  const state = loadSessionsFile(store)[workspaceId]
  if (!state) return []
  return Object.values(state.sessions).sort((a, b) => b.createdAt - a.createdAt)
}

/** 当前激活会话 */
export function getActiveSession(store: WorkflowsStore, workspaceId: string): StoredSessionMeta | undefined {
  const state = loadSessionsFile(store)[workspaceId]
  if (!state?.active) return undefined
  return state.sessions[state.active]
}

/** 指定会话(不存在返回 undefined) */
export function getSession(store: WorkflowsStore, workspaceId: string, sessionId: string): StoredSessionMeta | undefined {
  return loadSessionsFile(store)[workspaceId]?.sessions[sessionId]
}

/** 工作区会话目录:sessions/<workspaceId>/,每个工作区独立子目录,与 pi SDK 默认按 cwd 编码隔离的精神一致 */
export function sessionDirFor(store: WorkflowsStore, workspaceId: string): string {
  const dir = path.join(store.agentDir, 'sessions', workspaceId)
  ensureDir(dir)
  return dir
}

/**
 * 迁移旧版平铺会话布局(所有 JSONL 直接落在 agentDir/sessions/)
 * → 按工作区隔离(sessions/<workspaceId>/)。移动文件并回写 sessionFile 引用。
 * 返回实际移动的文件数。
 */
export function migrateSessionsLayout(store: WorkflowsStore): number {
  const file = loadSessionsFile(store)
  let moved = 0
  for (const [workspaceId, state] of Object.entries(file)) {
    const targetDir = sessionDirFor(store, workspaceId)
    for (const meta of Object.values(state.sessions)) {
      if (!meta.sessionFile) continue
      const oldFile = meta.sessionFile
      const newFile = path.join(targetDir, path.basename(oldFile))
      const already = path.dirname(oldFile) === targetDir
      if (!already && existsSync(oldFile) && !existsSync(newFile)) {
        renameSync(oldFile, newFile)
        moved++
      }
      if (existsSync(newFile)) {
        // 旧文件缺失但目标已就位(或已移动成功)→ 修正引用即可
        if (!already) meta.sessionFile = newFile
      } else if (!existsSync(oldFile)) {
        // 源与目标均不存在(引用失效)→ 置空,待会话创建时回填
        meta.sessionFile = ''
      }
    }
  }
  saveSessionsFile(store, file)
  return moved
}

/** 会话文件路径(条目缺失或文件已删除返回 undefined) */
export function sessionFileFor(store: WorkflowsStore, workspaceId: string, sessionId?: string): string | undefined {
  const meta = sessionId ? getSession(store, workspaceId, sessionId) : getActiveSession(store, workspaceId)
  if (!meta) return undefined
  return existsSync(meta.sessionFile) ? meta.sessionFile : undefined
}

/** 设置激活会话(会话必须已存在) */
export function setActiveSession(store: WorkflowsStore, workspaceId: string, sessionId: string): void {
  mutateSessions(store, workspaceId, (state) => {
    if (state.sessions[sessionId]) state.active = sessionId
  })
}

/** 更新会话元信息(如消息数) */
export function updateSessionMeta(
  store: WorkflowsStore,
  workspaceId: string,
  sessionId: string,
  patch: Partial<Pick<StoredSessionMeta, 'messageCount'>>,
): void {
  mutateSessions(store, workspaceId, (state) => {
    const meta = state.sessions[sessionId]
    if (meta) Object.assign(meta, patch)
  })
}

/** 删除会话条目;若删的是激活会话,自动激活剩余最新会话。返回删除后的状态 */
export function removeSession(store: WorkflowsStore, workspaceId: string, sessionId: string): WorkspaceSessionsState {
  return mutateSessions(store, workspaceId, (state) => {
    delete state.sessions[sessionId]
    if (state.active === sessionId) {
      const remaining = Object.values(state.sessions).sort((a, b) => a.createdAt - b.createdAt)
      state.active = remaining.at(-1)?.id ?? null
    }
  })
}

/** 删除工作区时移除其所有会话条目(JSONL 文件由调用方删除),返回被删条目 */
export function removeWorkspaceSessions(store: WorkflowsStore, workspaceId: string): StoredSessionMeta[] {
  const file = loadSessionsFile(store)
  const state = file[workspaceId]
  if (!state) return []
  const metas = Object.values(state.sessions)
  delete file[workspaceId]
  saveSessionsFile(store, file)
  return metas
}
