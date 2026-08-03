/**
 * 子代理 / 主代理定义加载器。
 *
 * 每个代理 = 一个 markdown 文件:frontmatter 声明能力 + 正文定义行为。
 *
 * 加载层级(用户优先):
 * 1. 内置:本目录 agents/*.md(随代码分发,只读)
 * 2. 用户:store.agentsDir 下同名文件覆盖内置;新名字 = 新增自定义代理
 *
 * write 字段:相对工作区根的逐段 glob(picomatch 风格):
 * - 精确路径 / docs 子目录全量 / 全量 ** / 单层目录通配(如 .wf-runs/某run/01-exploration.md)
 * - 省略 = 纯只读
 * 匹配语义:绝对路径、`..` 一律拒绝(与 workspaceGuard 哲学一致);
 * glob 编译失败一律拒绝,不静默放行。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'
import type { WorkflowsStore } from '../config.js'

/** frontmatter 中的简单标量 / 字符串数组 */
export interface AgentFrontmatter {
  name: string
  description?: string
  /** 仅主代理:可用子代理白名单;省略 = 全部已注册 */
  agents?: string[]
  /** 工具集白名单;省略 = 只读默认(read / ls / fff-find / fff-grep) */
  tools?: string[]
  /** 可写目标(相对工作区根的 glob);省略 = 纯只读;** = 全量写 */
  write?: string[]
}

/** 加载完成的代理定义 */
export interface AgentDefinition {
  /** 定义来源(用于报错/调试) */
  source: string
  frontmatter: AgentFrontmatter
  /** markdown 正文(去掉 frontmatter),即 system prompt 主体 */
  body: string
}
/** 内置 agents 目录(随代码分发) */
export const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'agents')

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * 解析 frontmatter(YAML 子集:标量 / 数组;多行数组用 `- item` 缩进)。
 * 解析失败抛错(frontmatter 是能力声明,不能静默降级)。
 */
export function parseFrontmatter(raw: string): AgentFrontmatter {
  const result: AgentFrontmatter = { name: '' }
  // 先处理多行数组:收集 `- item` 行,按缩进归属最近的 key
  const lines = raw.split(/\r?\n/)
  const pendingArrays = new Map<string, string[]>()
  const cleaned: string[] = []
  let currentKey: string | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      if (!currentKey) throw new Error(`frontmatter 数组项「${trimmed}」没有所属键`)
      const arr = pendingArrays.get(currentKey) ?? []
      arr.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''))
      pendingArrays.set(currentKey, arr)
      continue
    }
    const keyMatch = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed)
    if (!keyMatch) {
      // 非键行:若不是注释,忽略(允许空行与注释)
      continue
    }
    currentKey = keyMatch[1]
    const value = keyMatch[2].trim()
    cleaned.push(trimmed) // 空值 key(多行数组的标题行)也要登记,否则数组无法归属
    if (value === '') continue
  }

  for (const line of cleaned) {
    const idx = line.indexOf(':')
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    // 去掉行尾注释
    const hash = value.indexOf(' #')
    if (hash >= 0) value = value.slice(0, hash).trim()
    switch (key) {
      case 'name':
        result.name = value.replace(/^["']|["']$/g, '')
        break
      case 'description':
        result.description = value.replace(/^["']|["']$/g, '')
        break
      case 'agents':
      case 'tools':
      case 'write': {
        const inline = parseInlineArray(value)
        result[key] = inline ?? pendingArrays.get(key) ?? []
        break
      }
      default:
        // 未知字段忽略(前向兼容)
        break
    }
  }
  if (!result.name) throw new Error('frontmatter 缺少 name 字段')
  return result
}

/** 解析行内数组 `[a, b]`;非数组形式返回 null(可能为多行数组或单值) */
function parseInlineArray(value: string): string[] | null {
  if (!value.startsWith('[')) return null
  const inner = value.slice(1, value.lastIndexOf(']') >= 0 ? value.lastIndexOf(']') : undefined)
  if (inner.trim() === '') return []
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s.length > 0)
}

/** 解析一个 md 文件为 AgentDefinition(首块 frontmatter + 正文) */
export function parseAgentFile(filePath: string): AgentDefinition {
  const content = readFileSync(filePath, 'utf-8')
  const match = FRONTMATTER_RE.exec(content)
  if (!match) {
    throw new Error(`代理文件缺少 frontmatter:${filePath}`)
  }
  const frontmatter = parseFrontmatter(match[1])
  const body = content.slice(match[0].length).trim()
  if (!body) throw new Error(`代理文件正文为空:${filePath}`)
  return { source: filePath, frontmatter, body }
}

/**
 * 加载全部代理定义:内置 + 用户覆盖(同名覆盖)。
 * 返回 Map<name, AgentDefinition>,名字以用户目录为准(同名覆盖),顺序稳定。
 */
export function loadAgentDefinitions(store: WorkflowsStore): Map<string, AgentDefinition> {
  const result = new Map<string, AgentDefinition>()
  for (const dir of [BUILTIN_AGENTS_DIR, store.agentsDir]) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.md')) continue
      try {
        const def = parseAgentFile(path.join(dir, entry))
        result.set(def.frontmatter.name, def)
      } catch (error) {
        // 用户文件出错要显式暴露;内置文件出错抛致命错误
        const msg = error instanceof Error ? error.message : String(error)
        if (dir === BUILTIN_AGENTS_DIR) {
          throw new Error(`内置代理文件损坏:${msg}`, { cause: error })
        }
        console.error(`[agents] 跳过损坏的代理文件 ${entry}:${msg}`)
      }
    }
  }
  return result
}

/* ---------------- write 白名单 glob 匹配 ---------------- */

interface WriteMatcher {
  patterns: picomatch.Matcher[]
  /** 原始模式(报错用) */
  raw: string[]
}

export type { WriteMatcher }

/** 预检:括号配对(未闭合的 [ ( { 视为非法模式,解析失败一律拒绝) */
function assertBalanced(pattern: string): void {
  const pairs: Array<[string, string]> = [
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
  ]
  for (const [open, close] of pairs) {
    let depth = 0
    for (const ch of pattern) {
      if (ch === open) depth++
      else if (ch === close) depth--
      if (depth < 0) throw new Error(`模式「${pattern}」括号不配对`)
    }
    if (depth !== 0) throw new Error(`模式「${pattern}」括号不配对`)
  }
}

/**
 * 编译 write 白名单。
 * - `**` → 全量写
 * - 空 / 省略 → 纯只读
 * - 模式编译失败抛错(不静默放行)
 */
export function compileWriteMatcher(write: string[] | undefined): WriteMatcher {
  const raw = write ?? []
  const matchers: picomatch.Matcher[] = []
  for (const pattern of raw) {
    if (pattern === '**') {
      matchers.push((() => true) as unknown as picomatch.Matcher)
      continue
    }
    assertBalanced(pattern)
    let matcher: picomatch.Matcher
    try {
      matcher = picomatch(pattern, { dot: true, windows: false })
    } catch (error) {
      throw new Error(`write 模式编译失败「${pattern}」:${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      })
    }
    matchers.push(matcher)
  }
  return { patterns: matchers, raw }
}

/**
 * 判断相对工作区根的路径是否命中 write 白名单。
 * - 绝对路径 / `..` 逃逸:一律拒绝(守卫语义)
 * - 路径规范化(win32 大小写归一、斜杠统一)后逐条匹配
 */
export function isWriteAllowed(relPath: string, matcher: WriteMatcher | undefined): boolean {
  if (!matcher || matcher.patterns.length === 0) return false
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) return false
  const lower = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  return matcher.patterns.some((m) => m(lower))
}

/** 单例缓存:进程内定义不变(内置 + 用户目录),重复加载开销小 */
let cachedDefinitions: Map<string, AgentDefinition> | null = null

/** 缓存版加载;store 变化后调用 invalidateAgentDefinitions() 失效 */
export function getAgentDefinitions(store: WorkflowsStore): Map<string, AgentDefinition> {
  if (!cachedDefinitions) cachedDefinitions = loadAgentDefinitions(store)
  return cachedDefinitions
}

export function invalidateAgentDefinitions(): void {
  cachedDefinitions = null
}
