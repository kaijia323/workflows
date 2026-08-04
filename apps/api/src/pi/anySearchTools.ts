/**
 * AnySearch 网络搜索工具(anysearch-search)
 *
 * 通过 AnySearch Search API(REST,POST https://api.anysearch.com/v1/search)执行网络搜索。
 * 与 fff-find/fff-grep(工作区内索引搜索)互补:本工具检索工作区之外的外部网络信息。
 *
 * 设计:
 * - 工厂 createAnySearchTools(options?) 与 fffTools.ts 一致,便于后续追加 batch/extract
 * - key 解析优先级:env ANYSEARCH_API_KEY > options.getApiKey()(piService 注入
 *   loadConfig(store).anySearchApiKey,动态读取 config.json,保存后下次调用立即生效)> 匿名
 * - key 只进 Authorization 头,绝不写入返回文本/日志/错误文案
 * - 错误防御分层:HTTP 状态 → JSON 解析 → 业务 code → data.results 结构,任何异常
 *   落到可读错误文本(abort 除外,唯一透传 Operation aborted)
 * - 输出 50KB 字节截断(与 fff 工具对齐),避免污染 LLM 上下文
 */

import { Type, type Static } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'

const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/v1/search'
const MAX_OUTPUT_BYTES = 50 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESULTS = 10
const MAX_RESULTS_LIMIT = 20

/** 17 个内置 domain(AnySearch tags 目录;sub_domain 目录未经完整实测,不做执行期硬校验) */
export const ANYSEARCH_DOMAINS = [
  'academic',
  'agriculture',
  'business',
  'code',
  'energy',
  'environment',
  'film',
  'finance',
  'gaming',
  'general',
  'health',
  'ip',
  'legal',
  'resource',
  'security',
  'social_media',
  'travel',
] as const

export interface AnySearchToolOptions {
  /** 返回 API key(可选)。优先级:env ANYSEARCH_API_KEY > 此函数 > 匿名 */
  getApiKey?: () => string | undefined
  /** 测试注入用,默认全局 fetch */
  fetchImpl?: typeof fetch
  /** 测试注入用,默认 ANYSEARCH_ENDPOINT */
  endpoint?: string
  /** 测试注入用,默认 30s */
  timeoutMs?: number
}

const searchSchema = Type.Object({
  query: Type.String({ description: '搜索查询关键词(必填)。支持自然语言或关键词组合' }),
  max_results: Type.Optional(
    Type.Number({
      description: `最多返回结果数,1-${MAX_RESULTS_LIMIT},默认 ${DEFAULT_MAX_RESULTS}`,
      minimum: 1,
      maximum: MAX_RESULTS_LIMIT,
    }),
  ),
  tag: Type.Optional(
    Type.String({
      description:
        '垂直领域标签,格式 {domain}.{sub_domain}(如 "code.doc")。可用 domain:' +
        ANYSEARCH_DOMAINS.join('/') +
        ';不确定具体 sub_domain 时用 general.general 或不传。部分 sub_domain 需配合 params(如 code.doc 需 {"library":"golang"})',
    }),
  ),
  zone: Type.Optional(
    Type.Union([Type.Literal('cn'), Type.Literal('intl')], {
      description: '搜索区域:cn 或 intl(可选)',
    }),
  ),
  language: Type.Optional(Type.String({ description: '结果语言(可选,如 zh-CN / en)' })),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'AnyMix 扩展参数,透传给 API(可选;如 tag=code.doc 时 {"library":"golang"})',
    }),
  ),
  format: Type.Optional(
    Type.Union([Type.Literal('json'), Type.Literal('markdown')], {
      description: '响应格式:json 或 markdown(默认 markdown,content 为 Markdown 文本)',
    }),
  ),
})
type SearchParams = Static<typeof searchSchema>

interface AnySearchResult {
  title?: string
  url?: string
  snippet?: string
  content?: string
}

interface AnySearchData {
  results?: AnySearchResult[]
  metadata?: { total_results?: number; search_time_ms?: number }
}

interface AnySearchResponse {
  code?: number
  message?: string
  data?: AnySearchData
}

interface SearchCallResult {
  results: AnySearchResult[]
  metadata?: AnySearchData['metadata']
}

/* ---------------- 私有 helper ---------------- */

function abortIfSignaled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted')
}

/** 提取错误对象的 name(DOMException 在 Node 中也是 Error 子类,统一防御) */
function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) return String((error as { name: unknown }).name)
  return ''
}

function resolveApiKey(opts: AnySearchToolOptions): string | undefined {
  const env = process.env.ANYSEARCH_API_KEY?.trim()
  if (env) return env
  return opts.getApiKey?.()?.trim() || undefined
}

/** HTTP 非 2xx 状态映射(文案脱敏,不回显 key) */
function mapHttpError(status: number, message?: string): string {
  switch (status) {
    case 400:
      return `请求参数错误(HTTP 400):${message ?? '请检查 query/tag/max_results 等参数'}`
    case 401:
    case 403:
      return 'API key 无效或未授权(可匿名调用或检查配置的 key)'
    case 402:
      return '账户额度已用完(quota exhausted),请检查配额'
    case 415:
      return '请求格式不支持(HTTP 415)'
    case 429:
      return '请求过于频繁(限流),请稍后重试或配置 API key 提升额度'
    default:
      if (status >= 500) return `服务端错误(HTTP ${status}),请稍后重试`
      return `请求失败(HTTP ${status})`
  }
}

/** 业务错误(HTTP 200 但 code !== 0)映射 */
function mapBusinessError(message: string | undefined): string {
  const msg = message ?? ''
  if (msg.includes('invalid_api_key')) {
    return 'API key 无效或未授权(可匿名调用或检查配置的 key)'
  }
  if (msg.includes('rate_limit_exceeded')) {
    return '请求过于频繁(限流),请稍后重试或配置 API key 提升额度'
  }
  if (msg.includes('quota_exhausted')) {
    return '账户额度已用完(quota exhausted),请检查配额'
  }
  return msg || '未知业务错误'
}

async function callSearch(
  opts: AnySearchToolOptions,
  params: SearchParams,
  signal: AbortSignal | undefined,
): Promise<SearchCallResult> {
  const endpoint = opts.endpoint ?? ANYSEARCH_ENDPOINT
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // 组合信号:30s 超时 + 用户中止信号(Node >= 20.19 原生支持 AbortSignal.any;
  // engines 已确认,若未来降级 Node 需改手动 AbortController 合并)
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)
  const combined = AbortSignal.any(signals)

  const key = resolveApiKey(opts)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`

  // undefined 字段剔除,不发送;format 恒发送(默认 markdown,与工具描述/渲染一致)
  const body: Record<string, unknown> = { query: params.query, format: params.format ?? 'markdown' }
  if (params.max_results !== undefined) body.max_results = params.max_results
  if (params.tag !== undefined) body.tag = params.tag
  if (params.zone !== undefined) body.zone = params.zone
  if (params.language !== undefined) body.language = params.language
  if (params.params !== undefined) body.params = params.params

  let res: Response
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    // 中止/超时:区分用户中止(透传 Operation aborted)与超时
    const name = errorName(error)
    if (name === 'AbortError') {
      if (signal?.aborted) throw new Error('Operation aborted', { cause: error })
      throw new Error(`请求超时(${timeoutMs}ms),请稍后重试`, { cause: error })
    }
    if (name === 'TimeoutError') {
      throw new Error(`请求超时(${timeoutMs}ms),请稍后重试`, { cause: error })
    }
    throw new Error(`网络请求失败:${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  if (!res.ok) {
    // 尝试读取 body message(错误响应一般为 JSON;非 JSON 也不影响映射)
    let message: string | undefined
    try {
      const raw = (await res.json()) as { message?: unknown }
      message = typeof raw?.message === 'string' ? raw.message : undefined
    } catch {
      // 非 JSON body:忽略
    }
    throw new Error(mapHttpError(res.status, message))
  }

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    throw new Error('响应不是合法 JSON')
  }

  const resp = parsed as AnySearchResponse
  if (typeof resp?.code !== 'number' || resp.code !== 0) {
    throw new Error(mapBusinessError(resp?.message))
  }
  if (!resp?.data || !Array.isArray(resp.data.results)) {
    throw new Error('响应结构异常(缺少 results)')
  }
  return { results: resp.data.results, metadata: resp.data.metadata }
}

function renderResults(data: SearchCallResult, format: string): string {
  const results = data.results ?? []
  const total = data.metadata?.total_results ?? results.length
  const ms = data.metadata?.search_time_ms ?? '?'
  const head = `搜索完成:共 ${total} 条,耗时 ${ms} ms`
  if (results.length === 0) return `${head}\n\n未找到相关结果`
  const parts = results.map((r, i) => {
    if (format === 'json') {
      return `[${i + 1}] ${r.title ?? '(无标题)'}\n${r.url ?? ''}\n${r.snippet ?? ''}`
    }
    // markdown(默认):content 为 Markdown 正文;缺失时降级拼接标题/URL/摘要
    return r.content ?? `### ${r.title ?? '(无标题)'}\n\n${r.url ?? ''}\n\n${r.snippet ?? ''}`
  })
  return `${head}\n\n${parts.join('\n\n---\n\n')}`
}

const TRUNCATION_MARKER = '\n\n[50KB limit reached]'

/**
 * 50KB 字节截断(与 fff 工具一致,超限追加提示)。
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
  return { content: [{ type: 'text', text: `AnySearch 错误:${error}` }], details: undefined }
}

/* ---------------- anysearch-search ---------------- */

export function createAnySearchSearchTool(opts: AnySearchToolOptions = {}): ToolDefinition<typeof searchSchema> {
  return {
    name: 'anysearch-search',
    label: 'anysearch-search',
    description:
      '网络搜索工具(AnySearch Search API)。当需要工作区之外的外部信息——最新动态、公开文档、' +
      '第三方库用法、时事新闻、API 变更等——时使用;工作区内信息请用 fff-find/fff-grep 或 read。' +
      '参数:query 必填;max_results 1-20 默认 10;可选 tag(格式 {domain}.{sub_domain},如 "code.doc")' +
      '限定垂直领域,可用 domain:' +
      ANYSEARCH_DOMAINS.join('/') +
      ';不确定具体 sub_domain 时直接用 general.general 或不传 tag;部分 sub_domain 需配合 params' +
      '(如 code.doc 需 {"library":"golang"});zone 可选 cn|intl;language 可选(如 zh-CN/en);' +
      'format 可选 json|markdown(默认 markdown,content 为 Markdown 文本)。' +
      '支持匿名调用(按 IP 限流、消耗每日免费额度),设置环境变量 ANYSEARCH_API_KEY 或在设置面板配置 key 可提升额度。' +
      '返回 Markdown 格式搜索结果(标题/URL/摘要/正文)。结果来自外部网络,可信度请自行判断,引用前建议核实原文。',
    promptSnippet: 'Search the web (AnySearch, anonymous OK)',
    parameters: searchSchema,
    async execute(_toolCallId, params: SearchParams, signal, _onUpdate): Promise<AgentToolResult<undefined>> {
      abortIfSignaled(signal)
      try {
        if (!params.query.trim()) return toolError('query 不能为空')
        const data = await callSearch(opts, params, signal)
        const text = truncateOutput(renderResults(data, params.format ?? 'markdown'))
        return { content: [{ type: 'text', text }], details: undefined }
      } catch (error) {
        if (error instanceof Error && error.message === 'Operation aborted') throw error
        return toolError(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/** 工厂:返回工具数组(与 fffTools 模式一致,便于后续追加 batch/extract) */
export function createAnySearchTools(options?: AnySearchToolOptions): ToolDefinition[] {
  return [createAnySearchSearchTool(options ?? {})]
}
