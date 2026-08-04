import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANYSEARCH_DOMAINS, createAnySearchSearchTool, createAnySearchTools } from './anySearchTools.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

/** 执行工具,返回输出文本 */
async function exec(
  tool: ToolDefinition,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ text: string }> {
  const result = (await tool.execute('id', params as never, signal, undefined, undefined as never)) as {
    content: { type: string; text: string }[]
  }
  return { text: result.content[0]?.text ?? '' }
}

interface FetchCall {
  url: string
  init: RequestInit
}

/** mock fetch:记录调用,由 handler 决定响应;支持 signal 监听(abort 时 reject) */
function makeFetchMock(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const response = await handler(String(url), (init ?? {}) as RequestInit)
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit })
    return response
  })
  return { fetchImpl, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const okBody = {
  code: 0,
  message: 'success',
  request_id: 'req-1',
  data: {
    results: [
      { title: 'Pi Coding Agent', url: 'https://example.com/pi', snippet: 'A snippet', content: '# Pi\n\nfull content' },
      { title: 'Second', url: 'https://example.com/2', snippet: 's2', content: 'second content' },
    ],
    metadata: { total_results: 42, search_time_ms: 120 },
  },
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('anysearch-search 请求构造与 key 解析', () => {
  it('请求构造:POST 端点 + 全参数透传;无 key 不带 Authorization 头', async () => {
    const { fetchImpl, calls } = makeFetchMock(() => jsonResponse(okBody))
    const tool = createAnySearchSearchTool({ fetchImpl })
    const params = {
      query: 'go http router',
      max_results: 5,
      tag: 'code.doc',
      zone: 'intl',
      language: 'zh-CN',
      params: { library: 'golang' },
      format: 'json',
    }
    const result = await exec(tool, params)
    expect(result.text).toContain('Pi Coding Agent')

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.url).toBe('https://api.anysearch.com/v1/search')
    expect(call.init.method).toBe('POST')
    const headers = new Headers(call.init.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('authorization')).toBeNull()
    expect(bodyOf(call)).toEqual(params)
  })

  it('未传可选参数时 body 仅含 query 与默认 format(undefined 字段剔除;format 默认 markdown)', async () => {
    const { fetchImpl, calls } = makeFetchMock(() => jsonResponse(okBody))
    const tool = createAnySearchSearchTool({ fetchImpl })
    await exec(tool, { query: 'only query' })
    expect(bodyOf(calls[0])).toEqual({ query: 'only query', format: 'markdown' })
  })

  it('key 解析:getApiKey → Bearer;env 优先于 getApiKey;皆无 → 匿名', async () => {
    // getApiKey 提供 key
    const a = makeFetchMock(() => jsonResponse(okBody))
    await exec(createAnySearchSearchTool({ fetchImpl: a.fetchImpl, getApiKey: () => 'cfg-key' }), { query: 'x' })
    expect(new Headers(a.calls[0].init.headers).get('authorization')).toBe('Bearer cfg-key')

    // env 优先于 getApiKey
    vi.stubEnv('ANYSEARCH_API_KEY', 'env-key')
    const b = makeFetchMock(() => jsonResponse(okBody))
    await exec(createAnySearchSearchTool({ fetchImpl: b.fetchImpl, getApiKey: () => 'cfg-key' }), { query: 'x' })
    expect(new Headers(b.calls[0].init.headers).get('authorization')).toBe('Bearer env-key')

    // 两者皆无 → 匿名(不带 Authorization)
    vi.unstubAllEnvs()
    const c = makeFetchMock(() => jsonResponse(okBody))
    await exec(createAnySearchSearchTool({ fetchImpl: c.fetchImpl }), { query: 'x' })
    expect(new Headers(c.calls[0].init.headers).get('authorization')).toBeNull()
  })
})

describe('anysearch-search 成功响应', () => {
  it('markdown(默认)渲染 content 原文;json 渲染 title/url/snippet;头部含 metadata', async () => {
    const md = makeFetchMock(() => jsonResponse(okBody))
    const mdResult = await exec(createAnySearchSearchTool({ fetchImpl: md.fetchImpl }), { query: 'x' })
    expect(mdResult.text).toContain('# Pi\n\nfull content')
    expect(mdResult.text).toContain('second content')
    expect(mdResult.text).toContain('共 42 条')
    expect(mdResult.text).toContain('120 ms')

    const js = makeFetchMock(() => jsonResponse(okBody))
    const jsResult = await exec(createAnySearchSearchTool({ fetchImpl: js.fetchImpl }), {
      query: 'x',
      format: 'json',
    })
    expect(jsResult.text).toContain('[1] Pi Coding Agent')
    expect(jsResult.text).toContain('https://example.com/pi')
    expect(jsResult.text).toContain('A snippet')
  })

  it('content 缺失时降级拼接标题/URL/摘要', async () => {
    const { fetchImpl } = makeFetchMock(() =>
      jsonResponse({
        code: 0,
        message: 'success',
        data: {
          results: [{ title: 'NoBody', url: 'https://e.com/n', snippet: 'snip' }],
          metadata: {},
        },
      }),
    )
    const result = await exec(createAnySearchSearchTool({ fetchImpl }), { query: 'x' })
    expect(result.text).toContain('### NoBody')
    expect(result.text).toContain('https://e.com/n')
    expect(result.text).toContain('snip')
  })

  it('50KB 截断:超限输出被截断并附 [50KB limit reached] 提示', async () => {
    const big = 'x'.repeat(60 * 1024)
    const { fetchImpl } = makeFetchMock(() =>
      jsonResponse({
        code: 0,
        message: 'success',
        data: { results: [{ title: 'Big', url: 'https://e.com/big', snippet: '', content: big }], metadata: {} },
      }),
    )
    const result = await exec(createAnySearchSearchTool({ fetchImpl }), { query: 'x' })
    expect(result.text).toContain('[50KB limit reached]')
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024)
    expect(result.text).not.toContain(big)
  })

  it('50KB 截断(中文/多字节):按字节截断,字符边界完整,无乱码/替换字符', async () => {
    // 60K 个中文字符 ≈ 180KB 字节,远超 50KB(旧实现按 code unit 截断会输出 ~3 倍体积)
    const chinese = '中'.repeat(60 * 1024)
    const { fetchImpl } = makeFetchMock(() =>
      jsonResponse({
        code: 0,
        message: 'success',
        data: {
          results: [{ title: '中文大文档', url: 'https://e.com/cn', snippet: '', content: chinese }],
          metadata: {},
        },
      }),
    )
    const result = await exec(createAnySearchSearchTool({ fetchImpl }), { query: 'x' })
    expect(result.text).toContain('[50KB limit reached]')
    // 输出总字节(含截断提示标记)不超过 50KB
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024)
    // 无替换字符/孤立代理(无乱码)
    expect(result.text).not.toContain('\ufffd')
    // 截断点落在字符边界:头部与标记之间的内容应全是完整的中文字符(没有被切半的字节)
    const body = result.text.slice(result.text.indexOf('\n\n') + 2, result.text.indexOf('\n\n[50KB'))
    expect(body).toMatch(/^中+$/)
  })
})

describe('anysearch-search 错误映射', () => {
  it.each([
    [400, '请求参数错误(HTTP 400)'],
    [401, 'API key 无效或未授权'],
    [403, 'API key 无效或未授权'],
    [402, '额度已用完'],
    [415, '请求格式不支持'],
    [429, '限流'],
    [500, '服务端错误(HTTP 500)'],
    [503, '服务端错误(HTTP 503)'],
    [504, '服务端错误(HTTP 504)'],
  ])('HTTP %i 映射为可读错误', async (status, expected) => {
    const { fetchImpl } = makeFetchMock(() => jsonResponse({ code: -1, message: 'some message' }, status))
    const result = await exec(createAnySearchSearchTool({ fetchImpl }), { query: 'x' })
    expect(result.text).toContain(expected)
  })

  it('400 透出 API message 帮助修正(如非法 tag)', async () => {
    const { fetchImpl } = makeFetchMock(() =>
      jsonResponse({ code: -1, message: 'invalid tag: foo.bar', request_id: 'r' }, 400),
    )
    const result = await exec(createAnySearchSearchTool({ fetchImpl }), { query: 'x', tag: 'foo.bar' })
    expect(result.text).toBe('AnySearch 错误:请求参数错误(HTTP 400):invalid tag: foo.bar')
  })

  it.each([
    ['rate_limit_exceeded', '限流'],
    ['invalid_api_key', 'API key 无效或未授权'],
    ['quota_exhausted', '额度已用完'],
  ])('业务错误(HTTP 200 code=-1 message=%s)映射', async (message, expected) => {
    const { fetchImpl } = makeFetchMock(() => jsonResponse({ code: -1, message, request_id: 'r1' }))
    const result = await exec(createAnySearchSearchTool({ fetchImpl }), { query: 'x' })
    expect(result.text).toContain(expected)
  })

  it('非 JSON 响应 → 响应不是合法 JSON', async () => {
    const { fetchImpl } = makeFetchMock(() => new Response('<html>oops</html>', { status: 200 }))
    const result = await exec(createAnySearchSearchTool({ fetchImpl }), { query: 'x' })
    expect(result.text).toBe('AnySearch 错误:响应不是合法 JSON')
  })

  it('data.results 缺失 → 响应结构异常', async () => {
    const { fetchImpl } = makeFetchMock(() => jsonResponse({ code: 0, message: 'success', data: {} }))
    const result = await exec(createAnySearchSearchTool({ fetchImpl }), { query: 'x' })
    expect(result.text).toBe('AnySearch 错误:响应结构异常(缺少 results)')
  })

  it('网络异常 → 可读错误文本(不抛未捕获异常)', async () => {
    const { fetchImpl } = makeFetchMock(() => {
      throw new Error('ECONNREFUSED')
    })
    const result = await exec(createAnySearchSearchTool({ fetchImpl }), { query: 'x' })
    expect(result.text).toBe('AnySearch 错误:网络请求失败:ECONNREFUSED')
  })
})

describe('anysearch-search 中止/超时/参数校验', () => {
  it('预置 aborted signal → 抛 Operation aborted(唯一透传异常)', async () => {
    const tool = createAnySearchSearchTool({ fetchImpl: vi.fn() })
    await expect(exec(tool, { query: 'x' }, AbortSignal.abort())).rejects.toThrow('Operation aborted')
  })

  it('执行中用户中止 → 抛 Operation aborted', async () => {
    const controller = new AbortController()
    const { fetchImpl } = makeFetchMock(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const tool = createAnySearchSearchTool({ fetchImpl })
    const promise = exec(tool, { query: 'x' }, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow('Operation aborted')
  })

  it('超时(AbortSignal.timeout 生效)→ 超时错误提示', async () => {
    const { fetchImpl } = makeFetchMock(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const tool = createAnySearchSearchTool({ fetchImpl, timeoutMs: 50 })
    const result = await exec(tool, { query: 'x' })
    expect(result.text).toContain('超时')
    expect(result.text).toContain('稍后重试')
  })

  it('query 空字符串 → query 不能为空(不发请求)', async () => {
    const { fetchImpl, calls } = makeFetchMock(() => jsonResponse(okBody))
    const tool = createAnySearchSearchTool({ fetchImpl })
    const result = await exec(tool, { query: '   ' })
    expect(result.text).toBe('AnySearch 错误:query 不能为空')
    expect(calls).toHaveLength(0)
  })
})

describe('常量与工厂', () => {
  it('ANYSEARCH_DOMAINS 恰为 17 个 domain 且含 general', () => {
    expect(ANYSEARCH_DOMAINS).toHaveLength(17)
    expect(ANYSEARCH_DOMAINS).toContain('general')
    expect(ANYSEARCH_DOMAINS).toContain('code')
    expect(ANYSEARCH_DOMAINS).toContain('social_media')
  })

  it('工厂返回 1 个工具,名为 anysearch-search(kebab-case)', () => {
    const tools = createAnySearchTools()
    expect(tools.map((t) => t.name)).toEqual(['anysearch-search'])
    expect(createAnySearchSearchTool().name).toBe('anysearch-search')
    expect(createAnySearchSearchTool().label).toBe('anysearch-search')
  })
})
