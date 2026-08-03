import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Workspace } from '@dag-pi/shared'

/**
 * .dag-pi 配置根目录(分环境):
 * - 开发环境:NODE_ENV !== production → <repo>/dag-pi/.dag-pi
 * - 生产环境:NODE_ENV === production  → ~/.dag-pi
 *
 * 说明:src/ 与 dist/ 下均向上三级到仓库根,两条路径一致。
 */
export function dagPiRoot(): string {
  const isProduction = process.env.NODE_ENV === 'production'
  if (isProduction) {
    return path.join(homedir(), '.dag-pi')
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.dag-pi')
}

interface StoredConfig {
  apiKey?: string
  model?: string
  thinkingLevel?: string
}

export interface DagPiStore {
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

export function createStore(): DagPiStore {
  const root = dagPiRoot()
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

export function loadConfig(store: DagPiStore): StoredConfig {
  return readJson<StoredConfig>(store.configPath, {})
}

export function saveConfig(store: DagPiStore, patch: Partial<StoredConfig>): StoredConfig {
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

/** 保存用户手动输入的 API key 到 .dag-pi/config.json */
export function setApiKey(store: DagPiStore, key: string): void {
  saveConfig(store, { apiKey: key.trim() })
}

/** 是否已配置 key(不把 key 本身返回给前端) */
export function hasApiKey(store: DagPiStore): boolean {
  return Boolean(loadConfig(store).apiKey)
}

/* ---------------- workspaces.json ---------------- */

interface StoredWorkspaces {
  workspaces: Workspace[]
}

export function loadWorkspaces(store: DagPiStore): Workspace[] {
  return readJson<StoredWorkspaces>(store.workspacesPath, { workspaces: [] }).workspaces
}

export function addWorkspace(store: DagPiStore, dir: string): Workspace | undefined {
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
  store: DagPiStore,
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

export function removeWorkspace(store: DagPiStore, id: string): boolean {
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
// workspaceId → 会话文件路径(agentDir/sessions 下,与 pi 自身 session 存储一致)

export function loadSessionMap(store: DagPiStore): Record<string, string> {
  return readJson<Record<string, string>>(store.sessionsPath, {})
}

export function saveSessionEntry(store: DagPiStore, workspaceId: string, sessionFile: string): void {
  const map = loadSessionMap(store)
  map[workspaceId] = sessionFile
  writeJson(store.sessionsPath, map)
}

export function sessionFileFor(store: DagPiStore, workspaceId: string): string | undefined {
  const file = loadSessionMap(store)[workspaceId]
  if (!file) return undefined
  return existsSync(file) ? file : undefined
}

export function freshSessionFile(store: DagPiStore, workspaceId: string): string {
  return path.join(store.agentDir, 'sessions', `${workspaceId}.jsonl`)
}
