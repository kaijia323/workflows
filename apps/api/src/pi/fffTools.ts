/**
 * fff 驱动的搜索工具(fff-find / fff-grep)
 *
 * 背景:pi SDK 内置 grep/find 每次调用 spawn ripgrep/fd 子进程,冷启动成本高;
 * fff(@ff-labs/fff-node)为每个工作区维护一个原生 Rust 索引,搜索毫秒级完成,
 * 且索引随文件变化自动更新(watch,约 100ms 延迟)。
 *
 * 设计:
 * - FffIndexManager:每工作区一个 FileFinder(键 workspace.id),创建失败返回 null,
 *   由调用方回退内置 grep/find;销毁随工作区清理
 * - 工具命名 fff-find / fff-grep(不沿用 grep/find,避免模型带入 shell 语义)
 * - 参数契约与输出格式对齐内置工具(截断/提示措辞一致),模型无感切换
 * - 工作区边界由构造保证:finder 绑定工作区根,结果全为相对路径;
 *   path 参数仍由 workspaceGuard.guardPathTool 校验
 *
 * 与内置工具的已知语义差异(写入工具描述):
 * - glob 通配符 * 不匹配以 . 开头的隐藏文件(标准 glob 惯例);隐藏文件可被
 *   grep / 精确路径 / fuzzy 搜索命中
 * - 大小写:默认大小写敏感(与内置一致);ignoreCase=true 时经 (?i) 内联标志实现
 */

import { FileFinder, type GrepMatch } from '@ff-labs/fff-node'
import path from 'node:path'
import { Type, type Static } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'

/** 与内置工具对齐:输出 50KB 截断、匹配行 500 字符截断 */
const MAX_OUTPUT_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 500
const DEFAULT_FIND_LIMIT = 1000
const DEFAULT_GREP_LIMIT = 100
/** 有 path/glob 约束时放大抓取,后置过滤后仍能凑够 limit */
const CONSTRAINT_FETCH_MULTIPLIER = 8
/** 等待初始索引扫描的超时 */
const SCAN_TIMEOUT_MS = 30_000

/* ---------------- 索引实例管理 ---------------- */

export class FffIndexManager {
  private readonly finders = new Map<string, FileFinder>()

  /**
   * 获取(或懒创建)工作区 finder。
   * 创建失败(平台二进制缺失等)返回 null,调用方回退内置搜索工具。
   */
  get(workspaceId: string, workspacePath: string): FileFinder | null {
    const existing = this.finders.get(workspaceId)
    if (existing && !existing.isDestroyed) return existing
    const created = FileFinder.create({ basePath: workspacePath, aiMode: true })
    if (!created.ok) return null
    const finder = created.value
    this.finders.set(workspaceId, finder)
    // 后台扫描,不阻塞会话创建;工具调用侧再等待就绪
    void finder.waitForScan(SCAN_TIMEOUT_MS)
    return finder
  }

  /** 工作区清理时释放原生资源 */
  dispose(workspaceId: string): void {
    const finder = this.finders.get(workspaceId)
    if (finder) {
      finder.destroy()
      this.finders.delete(workspaceId)
    }
  }

  disposeAll(): void {
    for (const finder of this.finders.values()) finder.destroy()
    this.finders.clear()
  }
}

/* ---------------- 工具定义 ---------------- */

const findSchema = Type.Object({
  pattern: Type.String({
    description:
      "搜索模式:mode='glob' 时是 glob 通配符(如 '*.ts'、'src/**/*.spec.ts',通配符 * 不匹配以 . 开头的隐藏文件);mode='fuzzy' 时是文件名片段(允许拼写错误)",
  }),
  mode: Type.Optional(
    Type.Union([Type.Literal('glob'), Type.Literal('fuzzy')], {
      description: "'glob' 精确通配匹配(默认);'fuzzy' 模糊匹配,容忍拼写错误",
    }),
  ),
  path: Type.Optional(
    Type.String({ description: '限定搜索的子目录(相对工作区根,默认整个工作区)' }),
  ),
  limit: Type.Optional(Type.Number({ description: `最多返回条数(默认 ${DEFAULT_FIND_LIMIT})` })),
})
type FindParams = Static<typeof findSchema>

const grepSchema = Type.Object({
  pattern: Type.String({
    description:
      '搜索内容。默认按正则(Rust regex 语法,与 ripgrep 一致;正则无效时自动退化为字面匹配)。' +
      '隐藏文件可命中。大小写:默认敏感;ignoreCase=true 时忽略大小写',
  }),
  path: Type.Optional(
    Type.String({ description: '限定搜索的目录或文件(相对工作区根,默认整个工作区)' }),
  ),
  glob: Type.Optional(
    Type.String({ description: "只搜索匹配该 glob 的文件(如 '*.ts' 或 'src/**/*.ts')" }),
  ),
  ignoreCase: Type.Optional(Type.Boolean({ description: '忽略大小写(默认 false)' })),
  literal: Type.Optional(Type.Boolean({ description: '把 pattern 当纯文本而非正则(默认 false)' })),
  context: Type.Optional(Type.Number({ description: '匹配行前后各显示的上下文行数(默认 0)' })),
  limit: Type.Optional(Type.Number({ description: `最多返回匹配数(默认 ${DEFAULT_GREP_LIMIT})` })),
})
type GrepParams = Static<typeof grepSchema>

const NOT_READY = 'fff 索引仍在扫描中,请稍后重试'

/** 等待初始扫描完成;超时抛错(工具结果视为错误,模型可重试) */
async function ensureReady(finder: FileFinder): Promise<void> {
  if (!finder.isScanning()) return
  const result = await finder.waitForScan(SCAN_TIMEOUT_MS)
  if (!result.ok || result.value === false) throw new Error(NOT_READY)
}

function abortIfSignaled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted')
}

function toolError(error: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text: `fff 错误:${error}` }], details: undefined }
}

/* ---------------- fff-find ---------------- */

/**
 * 把 fd 语义的 glob 归一化为 npm glob 语义(fff):
 * 内置 find(fd)的 '*.ts' 匹配任意深度的 basename,而 npm glob 只匹配根层,
 * 统一加 '**' 加 '/' 前缀保持模型习惯的行为。
 */
function normalizeGlobPattern(pattern: string): string {
  const p = pattern.replace(/\\/g, '/')
  if (p === '') return '**/*'
  if (p === '*' || p === '**') return '**'
  if (p.startsWith('/') || p.startsWith('**/')) return p
  return `**/${p}`
}

/**
 * path 参数归一化为相对工作区的路径(斜杠统一正斜杠)。
 * - '.' / './' → ''(等价于不传,整仓检索)
 * - './work_dirs' → 'work_dirs'
 * - 绝对路径(Windows 盘符正/反斜杠)→ 解析为相对工作区;指向工作区根 → ''
 *   (越界路径已被 guardPathTool 拦截,不会走到这里)
 */
function normalizeSubPath(p: string | undefined, workspacePath: string): string {
  if (!p) return ''
  const raw = p.replace(/\\/g, '/')
  if (path.isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw)) {
    const rel = path.relative(workspacePath, raw).replace(/\\/g, '/')
    if (rel === '' || rel.startsWith('..')) return ''
    return rel
  }
  return raw
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
    .replace(/^\.$/, '')
}

/** 相对路径是否位于子路径内(win32 上大小写不敏感,与文件系统一致) */
function isWithinSubPath(relativePath: string, sub: string): boolean {
  if (!sub) return true
  if (process.platform === 'win32') {
    const p = relativePath.toLowerCase()
    const s = sub.toLowerCase()
    return p === s || p.startsWith(`${s}/`)
  }
  return relativePath === sub || relativePath.startsWith(`${sub}/`)
}

/** 对齐内置输出:逐行路径 + 截断提示 */
function formatFindResult(paths: string[], limit: number): AgentToolResult<undefined> {
  if (paths.length === 0) {
    return { content: [{ type: 'text', text: 'No files found matching pattern' }], details: undefined }
  }
  let output = paths.join('\n')
  const notices: string[] = []
  if (paths.length >= limit) notices.push(`${limit} results limit reached`)
  const bytes = Buffer.byteLength(output)
  if (bytes > MAX_OUTPUT_BYTES) {
    output = output.slice(0, MAX_OUTPUT_BYTES)
    notices.push('50KB limit reached')
  }
  if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`
  return { content: [{ type: 'text', text: output }], details: undefined }
}

export function createFffFindTool(finder: FileFinder, workspacePath: string): ToolDefinition<typeof findSchema> {
  return {
    name: 'fff-find',
    label: 'fff-find',
    description:
      '基于实时索引的文件名搜索(毫秒级,索引随文件变化自动更新)。' +
      "支持两种模式:glob 精确通配(默认,通配符 * 不匹配以 . 开头的隐藏文件,跨目录需 '**/' 前缀)与 fuzzy 模糊匹配(容忍拼写错误)。" +
      '索引遵循 .gitignore:被忽略的文件(如 node_modules、训练产物 *.pth、日志 *.log)搜不到,如需访问用 read 或 bash ls 直接操作。' +
      '返回相对工作区根的路径列表。',
    promptSnippet: 'Search filenames by glob or fuzzy pattern (fast indexed search)',
    parameters: findSchema,
    async execute(_toolCallId, params: FindParams, signal, _onUpdate): Promise<AgentToolResult<undefined>> {
      abortIfSignaled(signal)
      try {
        await ensureReady(finder)
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error))
      }
      abortIfSignaled(signal)

      const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_FIND_LIMIT))
      const sub = normalizeSubPath(params.path, workspacePath)
      // 多取一些,过滤 path 后仍能凑够 limit
      const fetchSize = sub ? Math.max(limit, DEFAULT_FIND_LIMIT) : limit
      const mode = params.mode ?? 'glob'

      const result =
        mode === 'fuzzy'
          ? finder.fileSearch(params.pattern, { pageSize: fetchSize })
          : finder.glob(normalizeGlobPattern(params.pattern), { pageSize: fetchSize })
      if (!result.ok) return toolError(result.error)

      const paths = result.value.items
        .map((item) => item.relativePath.replace(/\\/g, '/'))
        .filter((p) => isWithinSubPath(p, sub))
        .slice(0, limit)
      return formatFindResult(paths, limit)
    },
  }
}

/* ---------------- fff-grep ---------------- */

/** 把 glob 约束转成正则,用于结果过滤(与 fff 的 npm glob 语义一致;win32 上大小写不敏感) */
function globToRegExp(glob: string): RegExp {
  // 先把跨目录的 ** 标记出来(.*),单个 * 不跨目录([^/]*)
  let src = ''
  const parts = glob.replace(/\\/g, '/').split('**')
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) src += '.*'
    for (const ch of parts[i]) {
      if (ch === '*') src += '[^/]*'
      else if (ch === '?') src += '[^/]'
      else if ('\\^$.|+()[]{}'.includes(ch)) src += `\\${ch}`
      else src += ch
    }
  }
  return new RegExp(`^${src}$`, process.platform === 'win32' ? 'i' : undefined)
}

/** 转义正则元字符(用于 ignoreCase + literal 组合场景) */
function escapeRegex(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 对齐内置输出:path:line: text(上下文行 path-line- text)+ 截断提示 */
function formatGrepResult(matches: GrepMatch[], limit: number): AgentToolResult<undefined> {
  if (matches.length === 0) {
    return { content: [{ type: 'text', text: 'No matches found' }], details: undefined }
  }
  const lines: string[] = []
  let linesTruncated = false
  for (const m of matches) {
    const p = m.relativePath.replace(/\\/g, '/')
    const text = m.lineContent.replace(/\r?\n$/, '')
    const truncated = text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text
    if (truncated !== text) linesTruncated = true
    lines.push(`${p}:${m.lineNumber}: ${truncated}`)
    for (const ctx of m.contextBefore ?? []) lines.push(`${p}-${m.lineNumber}- ${ctx.replace(/\r?\n$/, '')}`)
    for (const ctx of m.contextAfter ?? []) lines.push(`${p}-${m.lineNumber}- ${ctx.replace(/\r?\n$/, '')}`)
  }
  let output = lines.join('\n')
  const notices: string[] = []
  if (matches.length >= limit) {
    notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`)
  }
  const bytes = Buffer.byteLength(output)
  if (bytes > MAX_OUTPUT_BYTES) {
    output = output.slice(0, MAX_OUTPUT_BYTES)
    notices.push('50KB limit reached')
  }
  if (linesTruncated) notices.push(`Some lines truncated to ${MAX_LINE_LENGTH} chars. Use read tool to see full lines`)
  if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`
  return { content: [{ type: 'text', text: output }], details: undefined }
}

export function createFffGrepTool(finder: FileFinder, workspacePath: string): ToolDefinition<typeof grepSchema> {
  return {
    name: 'fff-grep',
    label: 'fff-grep',
    description:
      '基于实时索引的全文搜索(毫秒级,索引随文件变化自动更新,约 100ms 延迟)。' +
      'pattern 默认按正则处理(Rust regex 语法,与 ripgrep 一致;正则无效时自动退化为字面匹配)。' +
      '大小写规则:默认大小写敏感;ignoreCase=true 时忽略大小写。' +
      '隐藏文件可命中;glob 通配符 * 不匹配以 . 开头的隐藏文件。' +
      '索引遵循 .gitignore:被忽略的文件(如 node_modules、训练产物 *.pth、日志 *.log)搜不到,如需访问用 read 或 bash ls 直接操作。' +
      '输出格式 path:line: content,可用 path 限定目录、glob 限定文件。',
    promptSnippet: 'Search file contents with regex or literal patterns (fast indexed search)',
    parameters: grepSchema,
    async execute(_toolCallId, params: GrepParams, signal, _onUpdate): Promise<AgentToolResult<undefined>> {
      abortIfSignaled(signal)
      try {
        await ensureReady(finder)
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error))
      }
      abortIfSignaled(signal)

      const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_GREP_LIMIT))
      const context = Math.max(0, Math.floor(params.context ?? 0))
      const sub = normalizeSubPath(params.path, workspacePath)
      const hasConstraint = sub !== '' || Boolean(params.glob)

      // 大小写:默认敏感(smartCase=false);ignoreCase 经 (?i) 内联标志实现
      let pattern = params.pattern
      let literal = params.literal ?? false
      if (params.ignoreCase) {
        if (literal) {
          pattern = `(?i)${escapeRegex(pattern)}`
          literal = false
        } else {
          pattern = `(?i)${pattern}`
        }
      }



      const result = finder.grep(pattern, {
        mode: literal ? 'plain' : 'regex',
        smartCase: false,
        pageSize: hasConstraint ? Math.max(limit * CONSTRAINT_FETCH_MULTIPLIER, 200) : limit,
        beforeContext: context,
        afterContext: context,
      })
      if (!result.ok) return toolError(result.error)

      let matches = result.value.items
      if (hasConstraint) {
        const globRe = params.glob ? globToRegExp(normalizeGlobPattern(params.glob)) : null
        matches = matches.filter((m) => {
          const p = m.relativePath.replace(/\\/g, '/')
          if (!isWithinSubPath(p, sub)) return false
          return globRe ? globRe.test(p) : true
        })
        matches = matches.slice(0, limit)
      }
      const formatted = formatGrepResult(matches, limit)
      // 正则编译失败时 fff 自动退化为字面匹配,把信息透传给模型
      if (result.value.regexFallbackError) {
        const head = formatted.content[0]
        if (head.type === 'text') {
          formatted.content = [
            {
              type: 'text',
              text: `${head.text}\n\n[正则编译失败,已退化为字面匹配:${result.value.regexFallbackError}]`,
            },
          ]
        }
      }
      return formatted
    },
  }
}
