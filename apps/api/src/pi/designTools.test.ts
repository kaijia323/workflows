/**
 * design 工具单测(read / download + jsDelivr → raw 回退)。
 *
 * 覆盖:URL 构造与三源回退顺序、聚合错误、read 内容与 50KB 截断、路径校验、
 * download 落盘与护栏(只读/边界/overwrite/5MB 硬上限/404)、超时与用户中止、工厂形态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createDesignTool, createDesignTools } from './designTools.js'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Workspace } from '@workflows/shared'

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

/** mock fetch:记录所有尝试(含抛出/悬挂的调用),由 handler 决定响应;支持 signal 监听(abort 时 reject) */
function makeFetchMock(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const initObj = (init ?? {}) as RequestInit
    calls.push({ url: String(url), init: initObj })
    return handler(String(url), initObj)
  })
  return { fetchImpl, calls }
}

function textResponse(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })
}

/** 临时目录工作区(默认读写) */
function makeWorkspace(readOnly = false): { dir: string; workspace: Workspace } {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-design-'))
  const workspace = { id: 'w1', path: dir, readOnly } as unknown as Workspace
  return { dir, workspace }
}

const README_MD = '# awesome-design-md\n\n- claude: 极简暖色,适合对话类产品\n- shadcn: 冷色组件感,适合开发者工具\n'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('URL 构造与三源回退', () => {
  it('read 默认 path → 首个请求为 jsDelivr@main README.md;成功即停(仅一次请求)', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock(() => textResponse(README_MD))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read' })

    expect(result.text).toContain('# awesome-design-md')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://cdn.jsdelivr.net/gh/VoltAgent/awesome-design-md@main/README.md')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBeNull()
    expect(new Headers(calls[0].init.headers).get('user-agent')).toBe('workflows-agent')
  })

  it('jsDelivr 500 → 回退 raw@main(第二次请求命中)', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock((url) => {
      if (url.includes('cdn.jsdelivr.net')) return textResponse('oops', 500)
      return textResponse(README_MD)
    })
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read' })

    expect(result.text).toContain('# awesome-design-md')
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toBe('https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/README.md')
  })

  it('jsDelivr 网络异常 → raw 兜底成功', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock((url) => {
      if (url.includes('cdn.jsdelivr.net')) throw new Error('ECONNREFUSED')
      return textResponse(README_MD)
    })
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read' })

    expect(result.text).toContain('来源: https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/README.md')
    expect(calls).toHaveLength(2)
  })

  it('指定站点 path → jsDelivr URL 带仓库内路径', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock(() => textResponse('DESIGN'))
    const tool = createDesignTool({ workspace, fetchImpl })
    await exec(tool, { action: 'read', path: 'design-md/claude/DESIGN.md' })

    expect(calls[0].url).toBe(
      'https://cdn.jsdelivr.net/gh/VoltAgent/awesome-design-md@main/design-md/claude/DESIGN.md',
    )
  })

  it('三源全失败 → 聚合错误含尝试 URL 列表与可读指引', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock(() => textResponse('nf', 404))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read', path: 'design-md/nope/DESIGN.md' })

    expect(calls).toHaveLength(3)
    expect(result.text).toContain('design 工具错误:文件获取失败:已尝试')
    expect(result.text).toContain('https://cdn.jsdelivr.net/gh/VoltAgent/awesome-design-md@main/design-md/nope/DESIGN.md')
    expect(result.text).toContain('https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/nope/DESIGN.md')
    expect(result.text).toContain('https://raw.githubusercontent.com/VoltAgent/awesome-design-md/master/design-md/nope/DESIGN.md')
    expect(result.text).toContain('检查路径/站点名是否与 README 一致')
  })

  it('jsDelivr 403/429 → 聚合错误附限流指引', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl } = makeFetchMock(() => textResponse('denied', 403))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read' })

    expect(result.text).toContain('jsDelivr/raw 一般不限流,若持续出现请检查网络/代理')
  })

  it('env DESIGN_CDN_BASE 覆盖 jsDelivr 基址', async () => {
    vi.stubEnv('DESIGN_CDN_BASE', 'https://cdn.invalid')
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock((url) => {
      if (url.includes('cdn.invalid')) return textResponse('nf', 404)
      return textResponse(README_MD)
    })
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read' })

    expect(result.text).toContain('# awesome-design-md')
    expect(calls[0].url).toBe('https://cdn.invalid/VoltAgent/awesome-design-md@main/README.md')
    // jsDelivr 基址失效 → raw 兜底成功
    expect(calls[1].url).toBe('https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/README.md')
  })

  it('options.cdnBase 优先于 env 钩子(单测确定性)', async () => {
    vi.stubEnv('DESIGN_CDN_BASE', 'https://cdn.invalid')
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock(() => textResponse(README_MD))
    const tool = createDesignTool({ workspace, fetchImpl, cdnBase: 'https://cdn.example.com/gh' })
    await exec(tool, { action: 'read' })

    expect(calls[0].url).toBe('https://cdn.example.com/gh/VoltAgent/awesome-design-md@main/README.md')
  })
})

describe('read:内容进上下文', () => {
  it('成功 → 来源头(最终 URL + 字节数)+ 正文', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl } = makeFetchMock(() => textResponse(README_MD))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read' })

    expect(result.text).toContain('来源: https://cdn.jsdelivr.net/gh/VoltAgent/awesome-design-md@main/README.md')
    expect(result.text).toContain(`${Buffer.byteLength(README_MD)} 字节`)
    expect(result.text).toContain('- claude: 极简暖色,适合对话类产品')
  })

  it('50KB 截断:超限内容被截断并附 [50KB limit reached] 提示', async () => {
    const { workspace } = makeWorkspace()
    const big = 'x'.repeat(60 * 1024)
    const { fetchImpl } = makeFetchMock(() => textResponse(big))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read' })

    expect(result.text).toContain('[50KB limit reached]')
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024)
    expect(result.text).not.toContain(big)
  })

  it('50KB 截断(中文多字节):按字节截断,字符边界完整,无乱码/替换字符', async () => {
    const { workspace } = makeWorkspace()
    const chinese = '中'.repeat(60 * 1024)
    const { fetchImpl } = makeFetchMock(() => textResponse(chinese))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read' })

    expect(result.text).toContain('[50KB limit reached]')
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024)
    expect(result.text).not.toContain('\ufffd')
    // 来源头与标记之间的正文全是完整中文字符
    const body = result.text.slice(result.text.indexOf('\n\n') + 2, result.text.indexOf('\n\n[50KB'))
    expect(body).toMatch(/^中+$/)
  })

  it.each([
    ['../etc/passwd', '.. 段'],
    ['/etc/passwd', '以 / 开头'],
    ['a\\b', '反斜杠'],
  ])('非法 path(%s)→ 拒绝且不发请求', async (badPath, expected) => {
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock(() => textResponse(README_MD))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read', path: badPath })

    expect(result.text).toContain('design 工具错误:path')
    expect(result.text).toContain(expected)
    expect(calls).toHaveLength(0)
  })

  it('404 → 提示检查路径/站点名', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl } = makeFetchMock(() => textResponse('nf', 404))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'read', path: 'design-md/nope/DESIGN.md' })

    expect(result.text).toContain('检查路径/站点名是否与 README 一致')
  })

  it('执行中用户中止 → 抛 Operation aborted(唯一透传异常)', async () => {
    const { workspace } = makeWorkspace()
    const controller = new AbortController()
    const { fetchImpl } = makeFetchMock(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const tool = createDesignTool({ workspace, fetchImpl })
    const promise = exec(tool, { action: 'read' }, controller.signal)
    controller.abort()
    await expect(promise).rejects.toThrow('Operation aborted')
  })

  it('预置 aborted signal → 抛 Operation aborted', async () => {
    const { workspace } = makeWorkspace()
    const tool = createDesignTool({ workspace, fetchImpl: vi.fn() })
    await expect(exec(tool, { action: 'read' }, AbortSignal.abort())).rejects.toThrow('Operation aborted')
  })

  it('超时(AbortSignal.timeout 生效)→ 回退下一源而非抛异常', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock(
      (url, init) =>
        new Promise((resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
          // 仅 jsDelivr 悬挂超时;raw 正常响应
          if (url.includes('cdn.jsdelivr.net')) return
          resolve(textResponse(README_MD))
        }),
    )
    const tool = createDesignTool({ workspace, fetchImpl, timeoutMs: 50 })
    const result = await exec(tool, { action: 'read' })

    expect(result.text).toContain('# awesome-design-md')
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toContain('raw.githubusercontent.com')
  })
})

describe('download:落盘与护栏', () => {
  const DESIGN_BODY = '# Claude Design\n\n暖色极简设计系统\n'.repeat(20)

  it('成功:自动建父目录、返回相对路径与字节数、输出不含文件正文', async () => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => textResponse(DESIGN_BODY))
      const tool = createDesignTool({ workspace, fetchImpl })
      const result = await exec(tool, { action: 'download', path: 'design-md/claude/DESIGN.md' })

      expect(result.text).toContain(`已下载 ${Buffer.byteLength(DESIGN_BODY)} 字节到 designs/claude/DESIGN.md`)
      expect(result.text).toContain('来源:')
      // 输出不含文件正文(内容不进 LLM 上下文)
      expect(result.text).not.toContain('# Claude Design')
      const file = path.join(dir, 'designs', 'claude', 'DESIGN.md')
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf-8')).toBe(DESIGN_BODY)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('默认目录推导:design-md/claude/DESIGN.md → designs/claude/DESIGN.md', async () => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => textResponse(DESIGN_BODY))
      const tool = createDesignTool({ workspace, fetchImpl })
      await exec(tool, { action: 'download', path: 'design-md/claude/DESIGN.md' })

      expect(existsSync(path.join(dir, 'designs', 'claude', 'DESIGN.md'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('自定义 dir 生效(相对工作区根)', async () => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => textResponse(DESIGN_BODY))
      const tool = createDesignTool({ workspace, fetchImpl })
      const result = await exec(tool, {
        action: 'download',
        path: 'design-md/claude/DESIGN.md',
        dir: 'designs/custom',
      })

      expect(result.text).toContain('designs/custom/DESIGN.md')
      expect(existsSync(path.join(dir, 'designs', 'custom', 'DESIGN.md'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('README.md 不是可下载设计 → 拒绝', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock(() => textResponse(README_MD))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'download' })

    expect(result.text).toContain('README.md 不是可下载的设计文件')
    expect(calls).toHaveLength(0)
  })

  it('dir 含 .. 逃逸/绝对路径 → 工作区边界拦截', async () => {
    const { workspace } = makeWorkspace()
    const { fetchImpl, calls } = makeFetchMock(() => textResponse(DESIGN_BODY))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, {
      action: 'download',
      path: 'design-md/claude/DESIGN.md',
      dir: '../escape',
    })

    expect(result.text).toContain('工作区边界拦截:design 下载目标超出工作区「../escape」')
    expect(calls).toHaveLength(0)
  })

  it('只读工作区 → 拒绝下载(不发请求)', async () => {
    const { workspace } = makeWorkspace(true)
    const { fetchImpl, calls } = makeFetchMock(() => textResponse(DESIGN_BODY))
    const tool = createDesignTool({ workspace, fetchImpl })
    const result = await exec(tool, { action: 'download', path: 'design-md/claude/DESIGN.md' })

    expect(result.text).toBe('design 工具错误:工作区为只读,请切换为读写后再下载')
    expect(calls).toHaveLength(0)
  })

  it('目标已存在且 overwrite 默认 false → 拒绝;overwrite=true → 覆盖', async () => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => textResponse(DESIGN_BODY))
      const tool = createDesignTool({ workspace, fetchImpl })
      await exec(tool, { action: 'download', path: 'design-md/claude/DESIGN.md' })

      // 已存在 + 不覆盖 → 拒绝(不发请求)
      const { fetchImpl: f2, calls: c2 } = makeFetchMock(() => textResponse('new content'))
      const tool2 = createDesignTool({ workspace, fetchImpl: f2 })
      const result2 = await exec(tool2, { action: 'download', path: 'design-md/claude/DESIGN.md' })
      expect(result2.text).toContain('目标已存在,如需覆盖请传 overwrite=true')
      expect(c2).toHaveLength(0)

      // overwrite=true → 覆盖(DESIGN.md 1 次,首源 2xx 即停)
      const { fetchImpl: f3, calls: c3 } = makeFetchMock(() => textResponse('new content'))
      const tool3 = createDesignTool({ workspace, fetchImpl: f3 })
      const result3 = await exec(tool3, { action: 'download', path: 'design-md/claude/DESIGN.md', overwrite: true })
      expect(result3.text).toContain('已下载')
      expect(c3).toHaveLength(1)
      expect(readFileSync(path.join(dir, 'designs', 'claude', 'DESIGN.md'), 'utf-8')).toBe('new content')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('content-length 超 5MB → 拒绝落盘(不读 body)', async () => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { fetchImpl, calls } = makeFetchMock(() => {
        const size = 5 * 1024 * 1024 + 1
        return textResponse('x'.repeat(10), 200, { 'content-length': String(size) })
      })
      const tool = createDesignTool({ workspace, fetchImpl })
      const result = await exec(tool, { action: 'download', path: 'design-md/claude/DESIGN.md' })

      expect(result.text).toContain('5MB 硬上限')
      expect(existsSync(path.join(dir, 'designs'))).toBe(false)
      expect(calls).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('实际字节超 5MB(无 content-length)→ 拒绝落盘', async () => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => textResponse('x'.repeat(5 * 1024 * 1024 + 1)))
      const tool = createDesignTool({ workspace, fetchImpl })
      const result = await exec(tool, { action: 'download', path: 'design-md/claude/DESIGN.md' })

      expect(result.text).toContain('5MB 硬上限')
      expect(existsSync(path.join(dir, 'designs'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('404 → 聚合错误含检查提示,不落盘', async () => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { fetchImpl } = makeFetchMock(() => textResponse('nf', 404))
      const tool = createDesignTool({ workspace, fetchImpl })
      const result = await exec(tool, { action: 'download', path: 'design-md/nope/DESIGN.md' })

      expect(result.text).toContain('检查路径/站点名是否与 README 一致')
      expect(existsSync(path.join(dir, 'designs'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('工厂形态', () => {
  it('createDesignTools 返回 1 个工具,name/label 均为 design', () => {
    const { workspace } = makeWorkspace()
    const tools = createDesignTools({ workspace })
    expect(tools.map((t) => t.name)).toEqual(['design'])
    expect(createDesignTool({ workspace }).name).toBe('design')
    expect(createDesignTool({ workspace }).label).toBe('design')
  })
})
