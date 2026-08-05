/**
 * MCP 工具工厂单测:注入式 mock(仿 anySearchTools.test.ts 的 fetchImpl 模式)
 * + 真实 stdio 集成测试(最小 MCP server 往返)。
 *
 * 覆盖:过滤 / 命名清洗与跳过 / schema 透传 / callTool 往返与渲染 / 错误映射 /
 * 缓存与断线重连 / 状态与 dispose / 部分失败隔离 / 真实 stdio 链路。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@workflows/shared'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import {
  MCP_TOOL_PREFIX,
  McpManager,
  StdioMcpConnection,
  createMcpTools,
  testMcpServer,
  type McpCallResult,
  type McpConnection,
  type McpToolDescriptor,
} from './mcpTools.js'

/* ---------------- 测试基建 ---------------- */

function serverConfig(name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name, command: 'node', args: ['-e', 'x'], enabled: true, ...extra }
}

const echoDescriptor: McpToolDescriptor = {
  name: 'foo',
  description: 'foo tool',
  inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
}

interface FakeConnection {
  conn: McpConnection
  connect: ReturnType<typeof vi.fn>
  listTools: ReturnType<typeof vi.fn>
  callTool: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

/** 注入式 fake 连接:默认正常往返;可覆盖单个方法(抛错/计数) */
function makeFakeConnection(overrides: Partial<FakeConnection> = {}): FakeConnection {
  const connect = overrides.connect ?? vi.fn(async () => {})
  const listTools =
    overrides.listTools ?? vi.fn(async (): Promise<McpToolDescriptor[]> => [echoDescriptor])
  const callTool =
    overrides.callTool ?? vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'ok' }] }))
  const close = overrides.close ?? vi.fn(async () => {})
  const conn: McpConnection = {
    connect: connect as unknown as () => Promise<void>,
    listTools: listTools as unknown as McpConnection['listTools'],
    callTool: callTool as unknown as McpConnection['callTool'],
    close: close as unknown as () => Promise<void>,
  }
  return { conn, connect, listTools, callTool, close }
}

function makeManager(fake: FakeConnection): McpManager {
  const create = vi.fn(() => fake.conn)
  return new McpManager({ create })
}

/** 执行工具,返回输出文本(与 anySearchTools.test.ts 同构) */
async function exec(tool: ToolDefinition, params: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string }> {
  const result = (await tool.execute('id', params as never, signal, undefined, undefined as never)) as {
    content: { type: string; text: string }[]
  }
  return { text: result.content[0]?.text ?? '' }
}

function singleTool(manager: McpManager, server: McpServerConfig, toolName = 'foo'): Promise<ToolDefinition | undefined> {
  return createMcpTools(manager, [server]).then((tools) => tools.find((t) => t.name.endsWith(`__${toolName}`)))
}

afterEach(() => {
  vi.restoreAllMocks()
})

/* ---------------- 1. 过滤(opt-in) ---------------- */

describe('createMcpTools 过滤(opt-in)', () => {
  it('enabled: false 的 server 不注册任何工具,也不建立连接', async () => {
    const fake = makeFakeConnection()
    const manager = makeManager(fake)
    const tools = await createMcpTools(manager, [serverConfig('srv', { enabled: false })])
    expect(tools).toEqual([])
    expect(fake.connect).not.toHaveBeenCalled()
    expect(fake.listTools).not.toHaveBeenCalled()
  })

  it('enabled 缺省的 server 不注册(opt-in 语义)', async () => {
    const fake = makeFakeConnection()
    const manager = makeManager(fake)
    const tools = await createMcpTools(manager, [{ name: 'srv', command: 'node' }])
    expect(tools).toEqual([])
    expect(fake.connect).not.toHaveBeenCalled()
  })

  it('空 servers → []', async () => {
    const manager = new McpManager()
    expect(await createMcpTools(manager, [])).toEqual([])
  })
})

/* ---------------- 2. 命名与清洗 ---------------- */

describe('工具命名(mcp__ 前缀 + 清洗)', () => {
  it('foo.bar / foo bar → mcp__srv__foo_bar(清洗为下划线)', async () => {
    const fake = makeFakeConnection({
      listTools: vi.fn(async (): Promise<McpToolDescriptor[]> => [
        { ...echoDescriptor, name: 'foo.bar' },
        { ...echoDescriptor, name: 'foo bar' },
      ]),
    })
    const manager = makeManager(fake)
    const tools = await createMcpTools(manager, [serverConfig('srv')])
    expect(tools).toHaveLength(1) // 清洗后重名 → 保留首个
    expect(tools[0].name).toBe(`${MCP_TOOL_PREFIX}srv__foo_bar`)
    expect(tools[0].label).toBe(`${MCP_TOOL_PREFIX}srv__foo_bar`)
  })

  it('全符号工具名清洗后为空 → 跳过(console.warn)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = makeFakeConnection({
      listTools: vi.fn(async (): Promise<McpToolDescriptor[]> => [
        { ...echoDescriptor, name: '!!!' },
        { ...echoDescriptor, name: 'ok' },
      ]),
    })
    const manager = makeManager(fake)
    const tools = await createMcpTools(manager, [serverConfig('srv')])
    expect(tools.map((t) => t.name)).toEqual([`${MCP_TOOL_PREFIX}srv__ok`])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('清洗后最终名超过 128 字符 → 跳过', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const long = 'x'.repeat(200)
    const fake = makeFakeConnection({
      listTools: vi.fn(async (): Promise<McpToolDescriptor[]> => [{ ...echoDescriptor, name: long }]),
    })
    const manager = makeManager(fake)
    const tools = await createMcpTools(manager, [serverConfig('srv')])
    expect(tools).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('同一 server 内清洗后重名 → 保留首个', async () => {
    const fake = makeFakeConnection({
      listTools: vi.fn(async (): Promise<McpToolDescriptor[]> => [
        { ...echoDescriptor, name: 'dup.name', description: 'dup.name desc' },
        { ...echoDescriptor, name: 'dup_name' },
      ]),
    })
    const manager = makeManager(fake)
    const tools = await createMcpTools(manager, [serverConfig('srv')])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe(`${MCP_TOOL_PREFIX}srv__dup_name`)
    // 描述保留首个
    expect(tools[0].description).toContain('dup.name desc')
  })
})

/* ---------------- 3. schema 透传 ---------------- */

describe('参数 schema 透传(Type.Unsafe)', () => {
  it('object inputSchema → parameters 原样透传(type/properties 保留)', async () => {
    const fake = makeFakeConnection()
    const manager = makeManager(fake)
    const tool = await singleTool(manager, serverConfig('srv'))
    expect(tool).toBeDefined()
    expect(JSON.stringify(tool!.parameters)).toContain('"type":"object"')
    expect(JSON.stringify(tool!.parameters)).toContain('"properties"')
  })

  it('非 object 根 schema → 跳过该工具(warn)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = makeFakeConnection({
      listTools: vi.fn(async (): Promise<McpToolDescriptor[]> => [
        { ...echoDescriptor, inputSchema: { type: 'string' } },
        { ...echoDescriptor, name: 'good' },
      ]),
    })
    const manager = makeManager(fake)
    const tools = await createMcpTools(manager, [serverConfig('srv')])
    expect(tools.map((t) => t.name)).toEqual([`${MCP_TOOL_PREFIX}srv__good`])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('inputSchema 为 null/非对象 → 跳过该工具', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = makeFakeConnection({
      listTools: vi.fn(async (): Promise<McpToolDescriptor[]> => [{ ...echoDescriptor, inputSchema: null as unknown as object }]),
    })
    const manager = makeManager(fake)
    expect(await createMcpTools(manager, [serverConfig('srv')])).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

/* ---------------- 4. callTool 往返与渲染 ---------------- */

describe('callTool 往返与结果渲染', () => {
  it('params 原样透传;文本结果返回', async () => {
    const fake = makeFakeConnection()
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, { a: 'x' })
    expect(result.text).toBe('ok')
    expect(fake.callTool).toHaveBeenCalledWith('foo', { a: 'x' }, undefined)
  })

  it('多 text 项以换行拼接;image 占位 [image, mime, bytes]', async () => {
    const fake = makeFakeConnection({
      callTool: vi.fn(async (): Promise<McpCallResult> => ({
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        ],
      })),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, {})
    expect(result.text).toBe('第一段\n第二段\n[image, image/png, 8 bytes]')
  })

  it('无 text 但有 structuredContent → JSON.stringify 输出', async () => {
    const fake = makeFakeConnection({
      callTool: vi.fn(
        async (): Promise<McpCallResult & { structuredContent: Record<string, unknown> }> => ({
          content: [],
          structuredContent: { ok: true, n: 1 },
        }),
      ),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, {})
    expect(result.text).toContain('"ok": true')
  })

  it('isError: true 透传不抛错(工具结果语义,返回渲染文本)', async () => {
    const fake = makeFakeConnection({
      callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'tool reported error' }], isError: true })),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, {})
    expect(result.text).toBe('tool reported error')
  })

  it('50KB 截断:超限输出被截断并附 [50KB limit reached] 提示', async () => {
    const big = 'x'.repeat(60 * 1024)
    const fake = makeFakeConnection({
      callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: big }] })),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, {})
    expect(result.text).toContain('[50KB limit reached]')
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024)
    expect(result.text).not.toContain(big)
  })

  it('50KB 截断(中文/多字节):字符边界完整,无乱码', async () => {
    const chinese = '中'.repeat(60 * 1024)
    const fake = makeFakeConnection({
      callTool: vi.fn(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: chinese }] })),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, {})
    expect(result.text).toContain('[50KB limit reached]')
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024)
    expect(result.text).not.toContain('\ufffd')
  })
})

/* ---------------- 5. 错误映射 ---------------- */

describe('错误映射(中文可读,脱敏)', () => {
  it.each([
    [ErrorCode.InvalidParams, '参数错误(JSON-RPC -32602)'],
    [ErrorCode.MethodNotFound, '工具不存在(JSON-RPC -32601)'],
    [ErrorCode.ParseError, '消息解析错误(JSON-RPC -32700)'],
    [ErrorCode.InvalidRequest, '无效请求(JSON-RPC -32600)'],
    [ErrorCode.InternalError, '服务器内部错误(JSON-RPC -32603)'],
    [ErrorCode.ConnectionClosed, '连接已断开'],
  ])('McpError code %i → %s', async (code, expected) => {
    const fake = makeFakeConnection({
      callTool: vi.fn(async () => {
        throw new McpError(code, 'server message')
      }),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, {})
    expect(result.text).toContain(expected)
    expect(result.text).toContain('MCP 错误')
  })

  it('调用超时 → 「调用超时(60000ms)」', async () => {
    const fake = makeFakeConnection({
      callTool: vi.fn(async () => {
        throw new Error('调用超时(60000ms)')
      }),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, {})
    expect(result.text).toContain('调用超时(60000ms)')
    expect(result.text).not.toContain('调用失败')
  })

  it('连接失败(connect 抛错)→ 「连接失败…」', async () => {
    const fake = makeFakeConnection({
      connect: vi.fn(async () => {
        throw new Error('连接失败:spawn ENOENT')
      }),
    })
    const manager = makeManager(fake)
    // 连接失败发生在 createMcpTools 阶段:该 server 被跳过,会话不阻塞
    const tools = await createMcpTools(manager, [serverConfig('srv')])
    expect(tools).toEqual([])
    const status = manager.status()
    expect(status).toHaveLength(1)
    expect(status[0].state).toBe('error')
    expect(status[0].error).toContain('连接失败')
  })

  it('execute 时连接失败(缓存后连接断开)→ 可读错误文本,不抛未捕获异常', async () => {
    const fake = makeFakeConnection({
      callTool: vi.fn(async () => {
        throw new Error('连接已断开:client has been closed')
      }),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, {})
    expect(result.text).toContain('连接已断开')
    expect(result.text).toContain('MCP 错误')
    // 重连一次后仍失败
    expect(fake.connect).toHaveBeenCalledTimes(2)
  })

  it('预置 aborted signal → 抛 Operation aborted(唯一透传异常)', async () => {
    const fake = makeFakeConnection()
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    await expect(exec(tool, {}, AbortSignal.abort())).rejects.toThrow('Operation aborted')
    expect(fake.callTool).not.toHaveBeenCalled()
  })

  it('调用中 abort(Operation aborted)→ 唯一透传', async () => {
    const fake = makeFakeConnection({
      callTool: vi.fn(async () => {
        throw new Error('Operation aborted')
      }),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    await expect(exec(tool, {})).rejects.toThrow('Operation aborted')
  })
})

/* ---------------- 6. 缓存与断线重连 ---------------- */

describe('连接缓存与断线重连', () => {
  it('连续两次 createMcpTools 只 connect 一次(工具列表缓存)', async () => {
    const fake = makeFakeConnection()
    const manager = makeManager(fake)
    await createMcpTools(manager, [serverConfig('srv')])
    await createMcpTools(manager, [serverConfig('srv')])
    expect(fake.connect).toHaveBeenCalledTimes(1)
    expect(fake.listTools).toHaveBeenCalledTimes(1)
  })

  it('调用时连接断开 → close + 重连一次 + 重试该次调用,第二次成功', async () => {
    const fake = makeFakeConnection({
      callTool: vi
        .fn()
        .mockImplementationOnce(async () => {
          throw new Error('Connection closed')
        })
        .mockImplementationOnce(async (): Promise<McpCallResult> => ({ content: [{ type: 'text', text: 'retried ok' }] })),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, { a: 1 })
    expect(result.text).toBe('retried ok')
    expect(fake.callTool).toHaveBeenCalledTimes(2)
    expect(fake.connect).toHaveBeenCalledTimes(2) // 首次 + 重连
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it('断线重连后仍失败 → 返回错误文本(不抛未捕获异常)', async () => {
    const fake = makeFakeConnection({
      callTool: vi.fn(async () => {
        throw new Error('Connection closed')
      }),
    })
    const manager = makeManager(fake)
    const tool = (await singleTool(manager, serverConfig('srv')))!
    const result = await exec(tool, {})
    expect(result.text).toContain('MCP 错误')
    expect(fake.connect).toHaveBeenCalledTimes(2)
  })
})

/* ---------------- 7. 状态与 dispose ---------------- */

describe('status 与 dispose', () => {
  it('status 反映 connected/toolCount/lastCheckedAt', async () => {
    const fake = makeFakeConnection()
    const manager = makeManager(fake)
    await createMcpTools(manager, [serverConfig('srv')])
    const status = manager.status()
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({ name: 'srv', state: 'connected', toolCount: 1 })
    expect(status[0].lastCheckedAt).toBeTypeOf('number')
    expect(status[0].error).toBeUndefined()
  })

  it('连接建立前 status 为 connecting(不误报 connected);成功后为 connected', async () => {
    let releaseConnect: (() => void) | null = null
    const fake = makeFakeConnection({
      connect: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseConnect = resolve
          }),
      ),
    })
    const manager = makeManager(fake)
    const pending = manager.listTools('srv', serverConfig('srv'))
    // connect 挂起期间:初始态 connecting,而非 connected
    expect(manager.status()[0]).toMatchObject({ name: 'srv', state: 'connecting', toolCount: 0 })
    expect(manager.status()[0].error).toBeUndefined()
    releaseConnect!()
    await pending
    expect(manager.status()[0]).toMatchObject({ name: 'srv', state: 'connected', toolCount: 1 })
  })

  it('disposeServer:close 被调用,status 清除缓存', async () => {
    const fake = makeFakeConnection()
    const manager = makeManager(fake)
    await createMcpTools(manager, [serverConfig('srv')])
    await manager.disposeServer('srv')
    expect(fake.close).toHaveBeenCalledTimes(1)
    expect(manager.status()).toEqual([])
    expect(manager.getConnection('srv')).toBeUndefined()
  })

  it('disposeAll:全部连接关闭', async () => {
    const fakeA = makeFakeConnection()
    const managerA = makeManager(fakeA)
    await createMcpTools(managerA, [serverConfig('a')])
    const fakeB = makeFakeConnection()
    const managerB = makeManager(fakeB)
    await createMcpTools(managerB, [serverConfig('b')])
    // 两个独立 manager 各关各的
    await managerA.disposeAll()
    expect(fakeA.close).toHaveBeenCalledTimes(1)
    await managerB.disposeAll()
    expect(fakeB.close).toHaveBeenCalledTimes(1)
  })
})

/* ---------------- 8. 部分失败隔离 ---------------- */

describe('单 server 失败隔离', () => {
  it('server A 连接失败抛错,server B 正常 → B 的工具正常注册,A 在 status 中 error(同一 manager)', async () => {
    const fakeA = makeFakeConnection({
      connect: vi.fn(async () => {
        throw new Error('连接失败:spawn ENOENT')
      }),
    })
    const fakeB = makeFakeConnection()
    const create = vi.fn((config: McpServerConfig) => (config.name === 'a' ? fakeA.conn : fakeB.conn))
    const manager = new McpManager({ create })

    const tools = await createMcpTools(manager, [serverConfig('a'), serverConfig('b')])

    // B 的工具正常注册;A 不阻塞会话创建
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe(`${MCP_TOOL_PREFIX}b__foo`)
    const status = manager.status()
    expect(status).toHaveLength(2)
    expect(status.find((s) => s.name === 'a')).toMatchObject({ state: 'error' })
    expect(status.find((s) => s.name === 'b')).toMatchObject({ state: 'connected', toolCount: 1 })
  })
})

/* ---------------- 9. 真实 stdio 集成 ---------------- */

/** 最小 stdio MCP server(基于官方 SDK Server + StdioServerTransport,暴露 echo 工具) */
const ECHO_SERVER_SCRIPT = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'echo-server', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }]
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'echo') throw new McpError(ErrorCode.MethodNotFound, 'Unknown tool: ' + req.params.name);
  return { content: [{ type: 'text', text: 'echo:' + req.params.arguments.text }] };
});
await server.connect(new StdioServerTransport());
`

describe('真实 stdio 集成(最小 MCP server 往返)', () => {
  it('connect → listTools → callTool → close 全链路往返正确', async () => {
    const conn = new StdioMcpConnection(serverConfig('echo', { args: ['-e', ECHO_SERVER_SCRIPT] }))
    try {
      await conn.connect()
      const tools = await conn.listTools()
      expect(tools.map((t) => t.name)).toEqual(['echo'])
      expect(tools[0].inputSchema).toMatchObject({ type: 'object' })
      const result = await conn.callTool('echo', { text: '你好' })
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'echo:你好' })
      expect(result.isError).toBeUndefined()
    } finally {
      await conn.close()
    }
  })

  it('调用不存在的工具 → JSON-RPC 错误码映射为可读文案', async () => {
    const conn = new StdioMcpConnection(serverConfig('echo', { args: ['-e', ECHO_SERVER_SCRIPT] }))
    try {
      await conn.connect()
      await expect(conn.callTool('nope', {})).rejects.toThrow(/Unknown tool|Method not found|-32601|not found/i)
    } finally {
      await conn.close()
    }
  })

  it('testMcpServer:一次性测试连接返回工具列表;close 后子进程退出', async () => {
    const result = await testMcpServer(serverConfig('echo', { args: ['-e', ECHO_SERVER_SCRIPT] }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.tools.map((t) => t.name)).toEqual(['echo'])
    }
  })

  it('testMcpServer:启动命令不存在 → { ok: false, error }', async () => {
    const result = await testMcpServer(serverConfig('ghost', { command: 'no-such-binary-xyz' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('连接失败')
    }
  })

  it('连接超时:server 不响应握手 → 连接超时文案(短超时注入)', async () => {
    // 起一个不响应 initialize 的进程(node 空转),用短 connect 超时验证
    const conn = new StdioMcpConnection(
      serverConfig('hang', { args: ['-e', 'setInterval(() => {}, 1000)'] }),
      { connectTimeoutMs: 500, listTimeoutMs: 500, callTimeoutMs: 500 },
    )
    await expect(conn.connect()).rejects.toThrow(/连接超时/)
    await conn.close().catch(() => {})
  })
})
