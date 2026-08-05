/**
 * MCP server 配置存储(mcp.json)
 *
 * 独立配置文件 `mcp.json`(与 config.json 同目录,dev=`<repo>/.workflows/mcp.json`,
 * prod=`~/.workflows/mcp.json`),内容 `{ "mcpServers": [...] }`。
 * 与 config.json 划分清晰:config.json 语义为「运行/密钥类配置」,mcp.json 语义为
 * 「外部工具插件配置」。
 *
 * 设计:
 * - `StoredConfig`(config.ts)零改动,不增加 mcpServers 字段;`WorkflowsStore` 接口零改动,
 *   mcp.json 路径经 `mcpConfigPath(store) = path.join(store.root, 'mcp.json')` 计算
 * - 复用 config.ts 的 readJson/writeJson(不仿写);写入为 tmp + renameSync 原子替换,
 *   写入中断不留半截文件
 * - 校验失败零写入:saveMcpServers 先全量校验,任一失败抛 Error(中文)不落盘
 * - 读取容错与 loadConfig 一致:文件缺失 / JSON 损坏 / mcpServers 缺失或非数组 → []
 * - 并发写保护与 config.json 同模式:无 mutex/lock,同步 I/O 天然串行
 * - mcp.json 与 config.json 同为 agent 不可写的配置文件(由 workspaceGuard 保证)
 */
import { rmSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { McpServerConfig } from '@workflows/shared'
import { readJson, type WorkflowsStore } from './config.js'

/** mcp.json 内容结构:独立于 config.json 的单一键文件 */
interface StoredMcpConfig {
  mcpServers?: McpServerConfig[]
}

const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const MCP_SERVER_NAME_MAX = 40

/** mcp.json 路径:与 config.json 同目录,沿用 workflowsRoot/createStore.root 定位逻辑 */
export function mcpConfigPath(store: WorkflowsStore): string {
  return path.join(store.root, 'mcp.json')
}

/**
 * 读取 MCP server 列表。
 * 容错语义与 loadConfig 一致:文件不存在 / JSON 损坏 / mcpServers 缺失或非数组 → 返回 []。
 * 读取不做逐项校验(坏条目在注册/测试时自然失败或跳过,不阻塞会话打开)。
 */
export function loadMcpServers(store: WorkflowsStore): McpServerConfig[] {
  const raw = readJson<StoredMcpConfig>(mcpConfigPath(store), {})
  return Array.isArray(raw?.mcpServers) ? raw.mcpServers : []
}

/** 全量校验(任一失败抛 Error,中文文案,不写盘) */
function validateMcpServers(servers: McpServerConfig[]): void {
  const seen = new Set<string>()
  for (const s of servers) {
    if (typeof s?.name !== 'string' || !MCP_SERVER_NAME_RE.test(s.name) || s.name.length > MCP_SERVER_NAME_MAX) {
      throw new Error(`MCP server 名称非法:必须匹配 /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/ 且不超过 ${MCP_SERVER_NAME_MAX} 字符`)
    }
    if (seen.has(s.name)) throw new Error(`MCP server 名称重复:${s.name}`)
    seen.add(s.name)
    if (typeof s.command !== 'string' || s.command.trim() === '') throw new Error(`MCP server「${s.name}」缺少启动命令(command)`)
    if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== 'string'))) {
      throw new Error(`MCP server「${s.name}」的 args 必须是字符串数组`)
    }
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') throw new Error(`MCP server「${s.name}」的 enabled 必须是布尔值`)
  }
}

/** 原子写:先写 <file>.tmp 再 renameSync 替换(同目录 rename 原子,写入中断不留半截文件);失败时清理 tmp */
function writeMcpConfig(store: WorkflowsStore, servers: McpServerConfig[]): void {
  const file = mcpConfigPath(store)
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + '\n', 'utf-8')
    renameSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** 全量校验后落盘;校验失败抛 Error(中文文案),零写入。返回传入的 servers(调用方可直接使用)。 */
export function saveMcpServers(store: WorkflowsStore, servers: McpServerConfig[]): McpServerConfig[] {
  validateMcpServers(servers)
  writeMcpConfig(store, servers)
  return servers
}

/** upsert 语义:同 name 覆盖、不同 name 追加;校验失败抛错零写入;返回更新后全量列表 */
export function upsertMcpServer(store: WorkflowsStore, server: McpServerConfig): McpServerConfig[] {
  const servers = loadMcpServers(store)
  const idx = servers.findIndex((s) => s.name === server.name)
  const next = idx === -1 ? [...servers, server] : servers.map((s, i) => (i === idx ? server : s))
  return saveMcpServers(store, next)
}

/** 删除指定 server;不存在返回 false;成功返回 true(内部 saveMcpServers 保证校验与原子写) */
export function removeMcpServer(store: WorkflowsStore, name: string): boolean {
  const servers = loadMcpServers(store)
  const next = servers.filter((s) => s.name !== name)
  if (next.length === servers.length) return false
  saveMcpServers(store, next)
  return true
}
