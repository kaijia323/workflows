/**
 * 内置 design 工具(design):读取/下载 awesome-design-md 设计库文件。
 *
 * 两个 action:
 * - read:读仓库 README.md(默认;全部设计的「站点名 + 一句话风格描述」,相当于目录)
 *   或指定站点的 DESIGN.md,内容进 LLM 上下文供 agent 判断;
 * - download:把选中的仓库文件流式落盘到当前工作区(内容不进上下文),
 *   受工作区边界 + 只读检查 + overwrite 保护,单文件 5MB 硬上限;
 *
 * 抓取策略:完全不走 GitHub API(无 60 次/小时限流、无需 GITHUB_TOKEN);
 * jsDelivr CDN 优先 → raw.githubusercontent.com 兜底 → master 分支兜底,首次 2xx 即停。
 * GITHUB_TOKEN 仅作可选 env 配置项保留(当前实现不读取,仅将来接 GitHub API 时启用)。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Type, type Static } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Workspace } from '@workflows/shared'
import { isPathWithinWorkspace } from './workspaceGuard.js'

const DESIGN_OWNER = 'VoltAgent'
const DESIGN_REPO = 'awesome-design-md'
const DESIGN_BRANCH = 'main'
const FALLBACK_BRANCH = 'master'
/** read 输出上限:内容进上下文,50KB 字节安全截断 */
const MAX_OUTPUT_BYTES = 50 * 1024
/** download 硬上限:单文件 5MB,超限拒绝不静默截断 */
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
/** 单源尝试超时(三源合计最坏 60s;正常首源即成功) */
const ATTEMPT_TIMEOUT_MS = 20_000
const DEFAULT_CDN_BASE = 'https://cdn.jsdelivr.net/gh'
const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com'
const USER_AGENT = 'workflows-agent'

export interface DesignToolOptions {
  /** 下载目标工作区(下载受其 readOnly 与目录边界约束) */
  workspace: Workspace
  /** 测试注入:仓库 owner,默认 VoltAgent */
  repoOwner?: string
  /** 测试注入:仓库名,默认 awesome-design-md */
  repo?: string
  /** 测试注入:主分支,默认 main */
  branch?: string
  /** 测试注入:回退分支,默认 master */
  fallbackBranch?: string
  /** 测试注入用,默认全局 fetch */
  fetchImpl?: typeof fetch
  /** 测试注入用,默认 20s */
  timeoutMs?: number
  /** 测试注入:jsDelivr 基址;env DESIGN_CDN_BASE 可覆盖(默认 https://cdn.jsdelivr.net/gh) */
  cdnBase?: string
}

const designSchema = Type.Object({
  action: Type.Union(
    [Type.Literal('read'), Type.Literal('download')],
    {
      description:
        'read:读取仓库文件内容(默认 README.md,或指定设计站点的 DESIGN.md),内容进入对话供判断;' +
        'download:把仓库文件直接下载到当前工作区(内容不进入对话),应在用户确认后调用',
    },
  ),
  path: Type.Optional(
    Type.String({
      description:
        '仓库内文件路径。read 默认 "README.md"(介绍全部设计:每行 站点名+一句话风格描述,相当于目录);' +
        '指定设计时用 README 中列出的路径模式,如 "design-md/<站点>/DESIGN.md"',
    }),
  ),
  dir: Type.Optional(
    Type.String({
      description:
        'download 目标目录(相对工作区根),默认 "designs/<站点>"(站点 = path 的父目录名,如 design-md/claude/DESIGN.md → designs/claude)',
    }),
  ),
  overwrite: Type.Optional(
    Type.Boolean({
      description: 'download 目标已存在时是否覆盖,默认 false',
    }),
  ),
})
type DesignParams = Static<typeof designSchema>

/* ---------------- 私有 helper ---------------- */

function abortIfSignaled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted')
}

/** 提取错误对象的 name(DOMException 在 Node 中也是 Error 子类,统一防御) */
function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) return String((error as { name: unknown }).name)
  return ''
}

/** HTTP 非 2xx 状态映射(404/403/429 给出可读指引) */
function mapHttpError(status: number): string {
  switch (status) {
    case 404:
      return 'HTTP 404(路径不存在,检查路径/站点名是否与 README 一致)'
    case 403:
      return 'HTTP 403(拒绝访问;jsDelivr/raw 一般不限流,若持续出现请检查网络/代理)'
    case 429:
      return 'HTTP 429(限流;jsDelivr/raw 一般不限流,若持续出现请检查网络/代理)'
    default:
      if (status >= 500) return `HTTP ${status}(服务端错误,请稍后重试)`
      return `HTTP ${status}`
  }
}

/** 仓库内路径校验:非空、不以 / 开头、不含反斜杠、不含 .. 段(防路径技巧) */
function validateRepoPath(repoPath: string): string {
  if (!repoPath) throw new Error('path 不能为空')
  if (repoPath.startsWith('/')) throw new Error('path 不能以 / 开头')
  if (repoPath.includes('\\')) throw new Error('path 不能包含反斜杠')
  if (repoPath.split('/').some((seg) => seg === '..')) throw new Error('path 不能包含 .. 段')
  return repoPath
}

/** 下载目标目录校验:resolve 后必须落在工作区内(相对路径基于工作区解析) */
function validateTargetDir(workspace: Workspace, dir: string): string {
  const target = path.resolve(workspace.path, dir)
  if (!isPathWithinWorkspace(workspace.path, target)) {
    throw new Error(`工作区边界拦截:design 下载目标超出工作区「${dir}」`)
  }
  return target
}

/** 三源候选 URL(顺序即优先级,首次 2xx 即停):jsDelivr@main → raw@main → raw@master */
function sourceUrls(opts: DesignToolOptions, repoPath: string): Array<{ name: string; url: string }> {
  const owner = opts.repoOwner ?? DESIGN_OWNER
  const repo = opts.repo ?? DESIGN_REPO
  const branch = opts.branch ?? DESIGN_BRANCH
  const fallbackBranch = opts.fallbackBranch ?? FALLBACK_BRANCH
  const cdnBase = opts.cdnBase ?? process.env.DESIGN_CDN_BASE ?? DEFAULT_CDN_BASE
  // path 逐段编码(仓库路径不含 ?/#,jsDelivr 要求 path 不含这两字符,天然满足)
  const encoded = repoPath.split('/').map((seg) => encodeURIComponent(seg)).join('/')
  return [
    { name: 'jsDelivr', url: `${cdnBase}/${owner}/${repo}@${branch}/${encoded}` },
    { name: 'raw', url: `${DEFAULT_RAW_BASE}/${owner}/${repo}/${branch}/${encoded}` },
    { name: 'raw(master)', url: `${DEFAULT_RAW_BASE}/${owner}/${repo}/${fallbackBranch}/${encoded}` },
  ]
}

interface FetchSuccess {
  url: string
  bytes: number
  text?: string
  buffer?: Buffer
}

/**
 * 顺序抓取文件:非 2xx / 网络异常 / 超时都视为该源失败,继续下一个;全失败抛聚合错误。
 * 单次尝试 AbortSignal.any([timeout, signal]);用户中止唯一透传 Operation aborted。
 * 不发送 Authorization(design 工具不读取 GITHUB_TOKEN)。
 */
async function fetchFile(
  opts: DesignToolOptions,
  repoPath: string,
  mode: 'text' | 'buffer',
  signal: AbortSignal | undefined,
): Promise<FetchSuccess> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS
  const urls = sourceUrls(opts, repoPath)
  const errors: string[] = []
  let sawRateLimited = false
  for (const source of urls) {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
    if (signal) signals.push(signal)
    const combined = AbortSignal.any(signals)
    let res: Response
    try {
      res = await fetchImpl(source.url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
        signal: combined,
      })
    } catch (error) {
      // 用户中止唯一透传 Operation aborted;超时/网络异常记录后尝试下一源
      const name = errorName(error)
      if (name === 'AbortError' && signal?.aborted) throw new Error('Operation aborted', { cause: error })
      errors.push(`${source.name}:${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) sawRateLimited = true
      errors.push(`${source.name}:${mapHttpError(res.status)}`)
      continue
    }
    // 首次 2xx 即停
    if (mode === 'text') {
      const text = await res.text()
      return { url: source.url, text, bytes: Buffer.byteLength(text) }
    }
    // buffer(download):content-length 头预检 + 实际字节双查,超 5MB 硬上限拒绝
    const contentLength = Number(res.headers.get('content-length') ?? '0')
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`文件超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB 硬上限(content-length ${contentLength} 字节),已拒绝下载`)
    }
    const arrayBuf = await res.arrayBuffer()
    const buffer = Buffer.from(arrayBuf)
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`文件超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB 硬上限(${buffer.length} 字节),已拒绝下载`)
    }
    return { url: source.url, buffer, bytes: buffer.length }
  }
  const rateHint = sawRateLimited ? '。jsDelivr/raw 一般不限流,若持续出现请检查网络/代理' : ''
  throw new Error(
    `文件获取失败:已尝试 ${urls.map((u) => u.url).join('、')};` +
      `各源原因:${errors.join(';')};` +
      `请检查路径/站点名是否与 README 一致,或稍后重试${rateHint}`,
  )
}

const TRUNCATION_MARKER = '\n\n[50KB limit reached]'

/**
 * 50KB 字节截断(与 fff / anysearch 工具一致,超限追加提示)。
 * 按字节安全截断:截断位置落在字符边界,不把多字节字符(如中文)或代理对切半,
 * 避免输出乱码/替换字符;截断内容 + 提示标记总字节 ≤ MAX_OUTPUT_BYTES。
 */
function truncateOutput(text: string): string {
  const limit = MAX_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_MARKER)
  if (Buffer.byteLength(text) <= limit) return text
  // 二分查找:不超过 limit 字节的最大完整字符前缀(UTF-16 code unit 层面二分)
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (Buffer.byteLength(text.slice(0, mid)) <= limit) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  // 若切点落在代理对中间(lo 为低代理位),回退 1 个 code unit,保住完整代理对
  const code = text.charCodeAt(lo)
  if (lo > 0 && code >= 0xdc00 && code <= 0xdfff) lo -= 1
  return `${text.slice(0, lo)}${TRUNCATION_MARKER}`
}

function toolError(error: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text: `design 工具错误:${error}` }], details: undefined }
}

/** 相对工作区根的展示路径(统一正斜杠) */
function relPath(workspace: Workspace, target: string): string {
  return path.relative(workspace.path, target).replace(/\\/g, '/')
}

async function executeDesign(
  opts: DesignToolOptions,
  params: DesignParams,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<undefined>> {
  abortIfSignaled(signal)
  try {
    if (params.action === 'read') {
      const repoPath = validateRepoPath(params.path ?? 'README.md')
      const data = await fetchFile(opts, repoPath, 'text', signal)
      // 内容进上下文:来源头 + 正文,整体 50KB 字节安全截断(含头,保证输出总量不超限)
      const text = `来源: ${data.url}(${data.bytes} 字节)\n\n${data.text ?? ''}`
      return { content: [{ type: 'text', text: truncateOutput(text) }], details: undefined }
    }
    // download:不进上下文,受护栏保护
    if (opts.workspace.readOnly) {
      return toolError('工作区为只读,请切换为读写后再下载')
    }
    const repoPath = validateRepoPath(params.path ?? 'README.md')
    // 默认目录 designs/<站点>(站点 = path 的父目录名);README.md 不是可下载设计
    const site = path.basename(path.dirname(repoPath))
    if (!site || site === '.') {
      return toolError('download 需要指定设计站点路径(如 design-md/<站点>/DESIGN.md);README.md 不是可下载的设计文件')
    }
    const dir = params.dir ?? `designs/${site}`
    const targetDir = validateTargetDir(opts.workspace, dir)
    const target = path.join(targetDir, path.basename(repoPath))
    const overwrite = params.overwrite ?? false
    if (existsSync(target) && !overwrite) {
      return toolError(`目标已存在,如需覆盖请传 overwrite=true(${relPath(opts.workspace, target)})`)
    }
    const data = await fetchFile(opts, repoPath, 'buffer', signal)
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(target, data.buffer ?? Buffer.alloc(0))
    // 返回仅含路径与字节数,文件内容不进 LLM 上下文
    return {
      content: [{ type: 'text', text: `已下载 ${data.bytes} 字节到 ${relPath(opts.workspace, target)}(来源:${data.url})` }],
      details: undefined,
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Operation aborted') throw error
    return toolError(error instanceof Error ? error.message : String(error))
  }
}

/* ---------------- design 工具 ---------------- */

export function createDesignTool(opts: DesignToolOptions): ToolDefinition<typeof designSchema> {
  return {
    name: 'design',
    label: 'design',
    description:
      'design(设计库工具):从 awesome-design-md 读取/下载设计文件。先 read 默认 README.md 获取全部设计清单' +
      '(站点名 + 一句话风格描述),判断哪个设计适合当前项目,再 read 对应 DESIGN.md 精读;与用户确认后 ' +
      'download 到当前工作区(默认 designs/<站点>/)。文件经 jsDelivr CDN 获取、自动回退 raw.githubusercontent.com,' +
      '不受 GitHub API 限流。内容来自外部仓库,可信度请自行判断。',
    promptSnippet: 'Read or download design files from awesome-design-md',
    parameters: designSchema,
    async execute(_toolCallId, params: DesignParams, signal, _onUpdate): Promise<AgentToolResult<undefined>> {
      return executeDesign(opts, params, signal)
    },
  }
}

/** 工厂:返回工具数组(与 fffTools / anySearchTools 模式一致,便于后续追加动作) */
export function createDesignTools(options: DesignToolOptions): ToolDefinition[] {
  return [createDesignTool(options)]
}
