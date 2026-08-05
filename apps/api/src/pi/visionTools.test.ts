/**
 * vision-understand 视觉理解工具单测(fetchImpl 注入 mock + tmpdir 图片 fixture + env 注入)。
 *
 * 范式对齐 anySearchTools.test.ts:makeFetchMock 记录调用与响应;execute 返回文本断言。
 * 覆盖:请求构造(端点/model/image_url data URL 序列化/question)/ key 解析(env > getApiKey)/
 * 成功返回 / HTTP 错误分层 / 结构缺失 / 文件不存在 / 超限 / 不支持格式 / 越界路径 /
 * 无 key / 超时 / abort 透传 / 50KB 截断。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createVisionTools, VISION_TOOL_NAME } from './visionTools.js'

/** 1×1 PNG(70 字节,合法 PNG 签名 + IHDR) */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

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
  choices: [{ message: { content: '这是一张示意图,包含数据流与节点。' } }],
  reasoning_content: '忽略此字段',
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>
}

/** 隔离的临时工作区(含一张 1×1 PNG fixture) */
function makeWorkspace(): { dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-vision-'))
  const pngPath = path.join(dir, 'docs', 'diagram.png')
  mkdirSync(path.dirname(pngPath), { recursive: true })
  writeFileSync(pngPath, Buffer.from(PNG_1X1_BASE64, 'base64'))
  return { dir }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('vision-understand 请求构造与 key 解析', () => {
  it('请求构造:POST 端点 + Bearer key + body(model/stream/image_url data URL/text)', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl, calls } = makeFetchMock(() => jsonResponse(okBody))
      const tool = createVisionTools({
        workspacePath: dir,
        fetchImpl,
        getApiKey: () => 'sk-cfg',
      })[0]
      const result = await exec(tool, { image_path: 'docs/diagram.png' })
      expect(result.text).toContain('这是一张示意图')

      expect(calls).toHaveLength(1)
      const call = calls[0]
      expect(call.url).toBe('https://api.xiaomimimo.com/v1/chat/completions')
      expect(call.init.method).toBe('POST')
      const headers = new Headers(call.init.headers)
      expect(headers.get('content-type')).toBe('application/json')
      expect(headers.get('authorization')).toBe('Bearer sk-cfg')
      const body = bodyOf(call)
      expect(body.model).toBe('mimo-v2.5')
      expect(body.stream).toBe(false)
      const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content
      expect(content[0].type).toBe('image_url')
      expect((content[0].image_url as { url: string }).url).toBe(`data:image/png;base64,${PNG_1X1_BASE64}`)
      expect(content[1]).toEqual({ type: 'text', text: '请详细描述这张图片的内容' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('question 透传;jpeg 扩展名映射 image/jpeg', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-vision-'))
    try {
      const jpgPath = path.join(dir, 'shot.jpeg')
      writeFileSync(jpgPath, Buffer.from(PNG_1X1_BASE64, 'base64'))
      const { fetchImpl, calls } = makeFetchMock(() => jsonResponse(okBody))
      const tool = createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0]
      await exec(tool, { image_path: 'shot.jpeg', question: '这个按钮是什么颜色?' })
      const content = (bodyOf(calls[0]).messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content
      expect((content[0].image_url as { url: string }).url).toBe(`data:image/jpeg;base64,${PNG_1X1_BASE64}`)
      expect(content[1]).toEqual({ type: 'text', text: '这个按钮是什么颜色?' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('key 解析:env XIAOMI_API_KEY 优先于 getApiKey;两者皆无 → 明确错误(不发请求)', async () => {
    const { dir } = makeWorkspace()
    try {
      // getApiKey 提供 key
      const a = makeFetchMock(() => jsonResponse(okBody))
      await exec(createVisionTools({ workspacePath: dir, fetchImpl: a.fetchImpl, getApiKey: () => 'cfg-key' })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(new Headers(a.calls[0].init.headers).get('authorization')).toBe('Bearer cfg-key')

      // env 优先于 getApiKey
      vi.stubEnv('XIAOMI_API_KEY', 'env-key')
      const b = makeFetchMock(() => jsonResponse(okBody))
      await exec(createVisionTools({ workspacePath: dir, fetchImpl: b.fetchImpl, getApiKey: () => 'cfg-key' })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(new Headers(b.calls[0].init.headers).get('authorization')).toBe('Bearer env-key')

      // 两者皆无 → 未配置 key 错误文本,零请求
      vi.unstubAllEnvs()
      const c = makeFetchMock(() => jsonResponse(okBody))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl: c.fetchImpl })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(result.text).toBe('Vision 错误:未配置小米视觉 API key(请先在设置 → 视觉模型中开启并填写)')
      expect(c.calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('vision-understand 成功与截断', () => {
  it('成功:返回图片内容文字描述', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => jsonResponse(okBody))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(result.text).toBe('这是一张示意图,包含数据流与节点。')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('50KB 截断:超限输出被截断并附 [50KB limit reached] 提示', async () => {
    const { dir } = makeWorkspace()
    try {
      const big = '详'.repeat(60 * 1024)
      const { fetchImpl } = makeFetchMock(() => jsonResponse({ choices: [{ message: { content: big } }] }))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(result.text).toContain('[50KB limit reached]')
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024)
      expect(result.text).not.toContain(big)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('vision-understand 错误分层(HTTP / 结构)', () => {
  it.each([
    [400, '请求参数错误(HTTP 400)'],
    [401, 'API key 无效或未授权'],
    [403, 'API key 无效或未授权'],
    [402, '额度已用完'],
    [429, '限流'],
    [500, '服务端错误(HTTP 500)'],
    [503, '服务端错误(HTTP 503)'],
  ])('HTTP %i 映射为可读错误', async (status, expected) => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => jsonResponse({ message: 'some message' }, status))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(result.text).toContain(expected)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('400 透出 API message 帮助修正', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => jsonResponse({ message: 'invalid image format' }, 400))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(result.text).toBe('Vision 错误:请求参数错误(HTTP 400):invalid image format')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 JSON 响应 → 响应不是合法 JSON', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => new Response('<html>oops</html>', { status: 200 }))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(result.text).toBe('Vision 错误:响应不是合法 JSON')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('choices[0].message 缺失 → 响应结构异常', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => jsonResponse({ choices: [] }))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(result.text).toBe('Vision 错误:响应结构异常(缺少 choices[0].message)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('content 为空字符串 → 响应缺少文本内容', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => jsonResponse({ choices: [{ message: { content: '' } }] }))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(result.text).toBe('Vision 错误:响应缺少文本内容')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('网络异常 → 可读错误文本(不抛未捕获异常)', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => {
        throw new Error('ECONNREFUSED')
      })
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: 'docs/diagram.png',
      })
      expect(result.text).toBe('Vision 错误:网络请求失败:ECONNREFUSED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('vision-understand 文件/守卫/参数校验', () => {
  it('image_path 空字符串 → 明确错误(不发请求)', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl, calls } = makeFetchMock(() => jsonResponse(okBody))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: '   ',
      })
      expect(result.text).toBe('Vision 错误:image_path 不能为空')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('越界路径 → 工作区边界拦截(不发请求)', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl, calls } = makeFetchMock(() => jsonResponse(okBody))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: '../../outside.png',
      })
      expect(result.text).toContain('Vision 错误:工作区边界拦截:vision-understand 尝试访问工作区之外的路径')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skills 放行根内路径放行(extraAllowedRoots 与 read 工具同语义)', async () => {
    const { dir } = makeWorkspace()
    try {
      // 放行根:真实 HOME 下的 skills 路径(不在临时目录白名单内,纯词法校验,不创建真实文件)
      const home = process.env.HOME ?? process.env.USERPROFILE
      expect(home).toBeTruthy()
      const extraRoot = path.join(home!, '.agents', 'skills')
      const { fetchImpl } = makeFetchMock(() => jsonResponse(okBody))
      const tool = createVisionTools({
        workspacePath: dir,
        extraAllowedRoots: [extraRoot],
        fetchImpl,
        getApiKey: () => 'sk',
      })[0]
      const result = await exec(tool, { image_path: path.join('.agents', 'skills', 'some-skill', 'pic.png') })
      // 放行根内路径不抛边界拦截:守卫词法校验放行,继续走到 stat(文件不存在 → 文件错误而非边界拦截)
      expect(result.text).not.toContain('工作区边界拦截')
      expect(result.text).toContain('图片文件不存在或不可读')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件不存在 → 明确错误(不发请求)', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl, calls } = makeFetchMock(() => jsonResponse(okBody))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: 'docs/missing.png',
      })
      expect(result.text).toBe('Vision 错误:图片文件不存在或不可读:docs/missing.png')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('超限(> maxImageBytes)→ 明确错误(不发请求)', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl, calls } = makeFetchMock(() => jsonResponse(okBody))
      const tool = createVisionTools({
        workspacePath: dir,
        fetchImpl,
        getApiKey: () => 'sk',
        maxImageBytes: 10,
      })[0]
      const result = await exec(tool, { image_path: 'docs/diagram.png' })
      expect(result.text).toBe('Vision 错误:图片文件超过大小上限(10 字节,实际 70 字节)')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不支持格式(.svg)→ 明确错误(不发请求)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-vision-'))
    try {
      writeFileSync(path.join(dir, 'vector.svg'), '<svg/>')
      const { fetchImpl, calls } = makeFetchMock(() => jsonResponse(okBody))
      const result = await exec(createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0], {
        image_path: 'vector.svg',
      })
      expect(result.text).toBe('Vision 错误:不支持的图片格式:.svg(支持的格式:JPEG/PNG/GIF/WebP)')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('vision-understand 中止/超时', () => {
  it('预置 aborted signal → 抛 Operation aborted(唯一透传异常)', async () => {
    const { dir } = makeWorkspace()
    try {
      const tool = createVisionTools({ workspacePath: dir, fetchImpl: vi.fn(), getApiKey: () => 'sk' })[0]
      await expect(exec(tool, { image_path: 'docs/diagram.png' }, AbortSignal.abort())).rejects.toThrow(
        'Operation aborted',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('执行中用户中止 → 抛 Operation aborted', async () => {
    const { dir } = makeWorkspace()
    try {
      const controller = new AbortController()
      const { fetchImpl } = makeFetchMock(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            // 信号可能已在 fetch 前中止(工具先读文件再 fetch):立即 reject
            if (init.signal?.aborted) {
              reject(new DOMException('aborted', 'AbortError'))
              return
            }
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }),
      )
      const tool = createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk' })[0]
      const promise = exec(tool, { image_path: 'docs/diagram.png' }, controller.signal)
      controller.abort()
      await expect(promise).rejects.toThrow('Operation aborted')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('超时(AbortSignal.timeout 生效)→ 超时错误提示', async () => {
    const { dir } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          }),
      )
      const tool = createVisionTools({ workspacePath: dir, fetchImpl, getApiKey: () => 'sk', timeoutMs: 50 })[0]
      const result = await exec(tool, { image_path: 'docs/diagram.png' })
      expect(result.text).toContain('超时')
      expect(result.text).toContain('稍后重试')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('常量与工厂', () => {
  it('工厂返回 1 个工具,名为 vision-understand', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-vision-'))
    try {
      const tools = createVisionTools({ workspacePath: dir })
      expect(tools.map((t) => t.name)).toEqual(['vision-understand'])
      expect(VISION_TOOL_NAME).toBe('vision-understand')
      expect(tools[0].label).toBe('vision-understand')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
