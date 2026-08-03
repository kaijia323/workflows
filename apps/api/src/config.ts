import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Workspace } from '@workflows/shared'

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
  model?: string
  thinkingLevel?: string
}

export interface WorkflowsStore {
  /** 配置根目录 */
  root: string
  /** agent 隔离目录(auth/models/settings/sessions 均在此,不触碰 ~/.pi/agent) */
  agentDir: string
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
  return {
    root,
    agentDir,
    configPath: path.join(root, 'config.json'),
    workspacesPath: path.join(root, 'workspaces.json'),
    sessionsPath: path.join(root, 'workspace-sessions.json'),
  }
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
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
  if (workspaces.some((w) => w.path === resolved)) return undefined
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

/** 工作区会话列表(按创建时间升序) */
export function listSessions(store: WorkflowsStore, workspaceId: string): StoredSessionMeta[] {
  const state = loadSessionsFile(store)[workspaceId]
  if (!state) return []
  return Object.values(state.sessions).sort((a, b) => a.createdAt - b.createdAt)
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
