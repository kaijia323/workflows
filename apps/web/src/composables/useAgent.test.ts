import { afterEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import { messageText, useAgent } from './useAgent'

const encoder = new TextEncoder()

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => ({ code: 0, message: 'ok', data }),
  } as unknown as Response
}

/** 逐块推送 SSE 数据,每块之间让出事件循环,模拟真实网络分片到达 */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      controller.close()
    },
  })
}

function stubApi(promptStream: ReadableStream<Uint8Array>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/agent/config') {
        return jsonResponse({
          hasApiKey: true,
          model: 'deepseek-v4-flash',
          thinkingLevel: 'off',
          models: [],
          thinkingLevels: ['off'],
        })
      }
      if (url === '/api/agent/workspaces') {
        return jsonResponse([{ id: 'ws-1', path: '/x', name: 'x', readOnly: false, createdAt: 0 }])
      }
      if (url.endsWith('/ws-1/open')) {
        return jsonResponse({
          history: [],
          status: { workspaceId: 'ws-1', model: 'deepseek-v4-flash', thinkingLevel: 'off', messageCount: 0, streaming: false, lastActivityAt: null },
        })
      }
      if (url.endsWith('/ws-1/prompt')) {
        return { ok: true, body: promptStream, json: async () => ({}) } as unknown as Response
      }
      if (url.endsWith('/ws-1/status')) {
        return jsonResponse({ workspaceId: 'ws-1', model: 'deepseek-v4-flash', thinkingLevel: 'off', messageCount: 0, streaming: false, lastActivityAt: null })
      }
      return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
    }),
  )
}

describe('useAgent 流式渲染', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('SSE 文本增量在流结束前就触发响应式更新(回归:实时渲染 bug)', async () => {
    // 分三次推送:agent_start + "你" → "好" → agent_end + done
    const stream = sseStream([
      'data: {"type":"agent_start"}\n\n',
      'data: {"type":"text_delta","delta":"你"}\n\n',
      'data: {"type":"text_delta","delta":"好"}\n\n',
      'data: {"type":"agent_end"}\n\n',
      'data: {"type":"done"}\n\n',
    ])
    stubApi(stream)

    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')

    // 记录每个触发时刻 assistant 文本的可见值
    const snapshots: string[] = []
    const stop = watch(
      () => {
        const last = agent.messages.value.at(-1)
        return last ? messageText(last) : ''
      },
      (text) => snapshots.push(text),
      { flush: 'sync' },
    )

    await agent.sendMessage('hi')
    stop()

    // 每次 text_delta 都应触发一次更新:用户消息 → 空消息 → "你" → "你好"
    // (而非只在流结束后一次性出现)
    expect(snapshots).toEqual(['hi', '', '你', '你好'])
    const last = agent.messages.value.at(-1)
    expect(messageText(last!)).toBe('你好')
    expect(last?.status).toBe('done')
  })

  it('SSE 回传的 message_start(user) 不重复推送用户消息(回归:输出顺序错乱)', async () => {
    // 模拟真实后端:session.prompt 会先触发 user 角色的 message_start,再进入 agent 事件
    const stream = sseStream([
      'data: {"type":"message_start","role":"user","id":"u-1"}\n\n',
      'data: {"type":"agent_start"}\n\n',
      'data: {"type":"text_delta","delta":"好的"}\n\n',
      'data: {"type":"agent_end"}\n\n',
      'data: {"type":"done"}\n\n',
    ])
    stubApi(stream)

    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')
    await agent.sendMessage('帮我看看')

    const messages = agent.messages.value
    // 顺序:用户消息(真实文本)→ assistant 回复,中间不得出现 "[已发送]" 占位消息
    expect(messages.map((m) => [m.role, messageText(m)])).toEqual([
      ['user', '帮我看看'],
      ['assistant', '好的'],
    ])
  })

  it('片段按大模型输出顺序保存:思考 → 正文 → 工具 → 正文(回归:类型归纳导致顺序错乱)', async () => {
    // 交错事件流:思考一段 → 输出开头正文 → 调用工具 → 工具结果 → 继续输出正文
    const events: Array<Record<string, unknown>> = [
      { type: 'agent_start' },
      { type: 'thinking_delta', delta: '先分析' },
      { type: 'thinking_delta', delta: '一下' },
      { type: 'text_delta', delta: '我来看看' },
      { type: 'tool_start', toolName: 'read', callId: 'c1' },
      { type: 'tool_update', callId: 'c1', delta: '{}' },
      { type: 'tool_end', callId: 'c1', toolName: 'read', isError: false, output: '{"ok":true}' },
      { type: 'text_delta', delta: ',文件正常' },
      { type: 'agent_end' },
      { type: 'done' },
    ]
    // 用 JSON.stringify 生成 SSE 数据,避免手写转义出非法 JSON
    const stream = sseStream(events.map((e) => `data: ${JSON.stringify(e)}\n\n`))
    stubApi(stream)

    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')
    await agent.sendMessage('读一下文件')

    const last = agent.messages.value.at(-1)
    expect(last?.segments.map((s) => s.kind)).toEqual(['thinking', 'text', 'tool', 'text'])
    // 连续 thinking 增量合并,正文被工具调用隔开成两段
    expect(last?.segments[0]).toMatchObject({ kind: 'thinking', text: '先分析一下' })
    expect(last?.segments[1]).toMatchObject({ kind: 'text', text: '我来看看' })
    expect(last?.segments[2]).toMatchObject({ kind: 'tool', callId: 'c1', name: 'read', output: '{"ok":true}', isError: false })
    expect(last?.segments[3]).toMatchObject({ kind: 'text', text: ',文件正常' })
  })

  it('历史恢复时按 blocks 原始顺序还原片段', async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.close()
      },
    })
    stubApi(stream)
    // open 接口返回带顺序的历史块:思考 → 工具 → 正文(工具调用夹在中间)
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/agent/config') {
        return jsonResponse({ hasApiKey: true, model: 'deepseek-v4-flash', thinkingLevel: 'off', models: [], thinkingLevels: ['off'] })
      }
      if (url === '/api/agent/workspaces') {
        return jsonResponse([{ id: 'ws-1', path: '/x', name: 'x', readOnly: false, createdAt: 0 }])
      }
      if (url.endsWith('/ws-1/open')) {
        return jsonResponse({
          history: [
            { id: 'u1', role: 'user', blocks: [{ type: 'text', text: '改一下' }] },
            {
              id: 'a1',
              role: 'assistant',
              blocks: [
                { type: 'thinking', text: '先看代码' },
                { type: 'tool', callId: 'c1', name: 'grep', args: {}, output: 'found', isError: false },
                { type: 'text', text: '完成了' },
              ],
            },
          ],
          status: { workspaceId: 'ws-1', model: 'deepseek-v4-flash', thinkingLevel: 'off', messageCount: 2, streaming: false, lastActivityAt: null },
        })
      }
      return jsonResponse({ workspaceId: 'ws-1', model: 'deepseek-v4-flash', thinkingLevel: 'off', messageCount: 0, streaming: false, lastActivityAt: null })
    })

    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')

    const assistant = agent.messages.value[1]
    expect(assistant.segments.map((s) => s.kind)).toEqual(['thinking', 'tool', 'text'])
    expect(assistant.segments[1]).toMatchObject({ kind: 'tool', callId: 'c1', name: 'grep', output: 'found', collapsed: true })
  })

  it('流中途断开(无 done 事件)时收尾所有流式状态,光标不再永久闪烁(回归)', async () => {
    // 模拟连接死亡:只有 tool 事件,没有任何收尾事件,流直接关闭
    const events: Array<Record<string, unknown>> = [
      { type: 'agent_start' },
      { type: 'tool_start', toolName: 'bash', callId: 'c1' },
      { type: 'tool_update', callId: 'c1', delta: 'running…' },
    ]
    const stream = sseStream(events.map((e) => `data: ${JSON.stringify(e)}\n\n`))
    stubApi(stream)

    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')
    await agent.sendMessage('跑个脚本')

    // 消息只有工具块、无正文,流式期间由 showCaretRow 显示闪烁光标;
    // 流异常断开后必须收尾,否则光标永久闪烁
    const last = agent.messages.value.at(-1)
    expect(last?.status).toBe('done')
    expect(last?.segments.map((s) => s.kind)).toEqual(['tool'])
  })

  it('sub_end 带 isError 时子代理会话置为 error,模态窗不再显示「● 运行中」(回归)', async () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'agent_start' },
      { type: 'tool_start', toolName: 'planner', callId: 'p1' },
      { type: 'sub_message_start', callId: 'p1', role: 'user', id: 'u1', text: '做计划' },
      { type: 'sub_message_start', callId: 'p1', role: 'assistant', id: 'a1' },
      { type: 'sub_tool_start', callId: 'p1', toolCallId: 't1', toolName: 'bash' },
      { type: 'sub_tool_end', callId: 'p1', toolCallId: 't1', toolName: 'bash', isError: true, output: 'boom' },
      // 子代理失败:后端补发 sub_end(isError=true) 收尾
      { type: 'sub_end', callId: 'p1', agentName: 'planner', summary: '子代理 planner 执行失败:boom', artifact: null, isError: true },
      { type: 'tool_end', callId: 'p1', toolName: 'planner', isError: true, output: '子代理 planner 执行失败:boom' },
      { type: 'agent_end' },
      { type: 'done' },
    ]
    const stream = sseStream(events.map((e) => `data: ${JSON.stringify(e)}\n\n`))
    stubApi(stream)

    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')
    await agent.sendMessage('做个计划')

    const sub = agent.subSessions.get('p1')
    expect(sub?.status).toBe('error')
    expect(sub?.summary).toBe('子代理 planner 执行失败:boom')
    // 子代理内所有消息收尾,不残留流式光标
    expect(sub?.messages.every((m) => m.status === 'done')).toBe(true)
  })

  it('error 事件(回合中断)时收尾所有运行中的子代理会话(回归)', async () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'agent_start' },
      { type: 'tool_start', toolName: 'executor', callId: 'e1' },
      { type: 'sub_message_start', callId: 'e1', role: 'user', id: 'u1', text: '改代码' },
      { type: 'sub_message_start', callId: 'e1', role: 'assistant', id: 'a1' },
      { type: 'sub_text_delta', callId: 'e1', delta: '正在处理' },
      // 后端报错,且 sub_end 缺失(子代理中断)
      { type: 'error', message: 'agent 执行出错' },
    ]
    const stream = sseStream(events.map((e) => `data: ${JSON.stringify(e)}\n\n`))
    stubApi(stream)

    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')
    await agent.sendMessage('执行一下')

    const sub = agent.subSessions.get('e1')
    expect(sub?.status).toBe('error')
    expect(sub?.messages.every((m) => m.status === 'done')).toBe(true)
    // 主消息同样收尾为 error,不残留流式光标
    const last = agent.messages.value.at(-1)
    expect(last?.status).toBe('error')
  })
})

describe('useAgent MCP actions(/api/agent/mcp*)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** mcp 专用 fetch stub:GET 列表 / PUT 保存(回写内存列表)/ POST 测试 */
  function stubMcpApi(initialServers: unknown[], initialStatus: unknown[]) {
    let servers = initialServers
    let testCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/api/agent/mcp' && method === 'GET') {
          return jsonResponse({ servers, status: initialStatus })
        }
        if (url === '/api/agent/mcp/echo' && method === 'PUT') {
          const body = JSON.parse(String(init?.body)) as { command?: string; enabled?: boolean; env?: Record<string, string> }
          servers = [{ name: 'echo', command: body.command, args: [], enabled: body.enabled, env: body.env }]
          return jsonResponse({ servers, status: initialStatus })
        }
        if (url === '/api/agent/mcp/echo/test' && method === 'POST') {
          testCalls++
          return jsonResponse({ ok: true, tools: [{ name: 'echo', description: 'echo back' }] })
        }
        return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
      }),
    )
    return { getTestCalls: () => testCalls }
  }

  it('refreshMcp:拉取配置 + 状态列表', async () => {
    stubMcpApi(
      [{ name: 'echo', command: 'node', args: [], enabled: true }],
      [{ name: 'echo', state: 'connected', toolCount: 1, lastCheckedAt: 1 }],
    )
    const agent = useAgent()
    await agent.refreshMcp()
    expect(agent.mcp.value?.servers).toHaveLength(1)
    expect(agent.mcp.value?.servers[0]).toMatchObject({ name: 'echo', enabled: true })
    expect(agent.mcp.value?.status[0]).toMatchObject({ state: 'connected', toolCount: 1 })
  })

  it('saveMcpServer:PUT /api/agent/mcp/:name 后刷新列表', async () => {
    stubMcpApi([], [])
    const agent = useAgent()
    await agent.saveMcpServer({ name: 'echo', command: 'node', enabled: true })
    expect(agent.mcp.value?.servers).toHaveLength(1)
    expect(agent.mcp.value?.servers[0]).toMatchObject({ name: 'echo', command: 'node', enabled: true })
  })

  it('saveMcpServer:PUT 透传 env(含空格与 = 的值)', async () => {
    stubMcpApi([], [])
    const agent = useAgent()
    await agent.saveMcpServer({ name: 'echo', command: 'node', env: { FOO: 'bar', URL: 'https://x?a=1' } })
    expect(agent.mcp.value?.servers[0].env).toEqual({ FOO: 'bar', URL: 'https://x?a=1' })
  })

  it('saveMcpServer:无 env 时请求体省略该键', async () => {
    stubMcpApi([], [])
    const agent = useAgent()
    await agent.saveMcpServer({ name: 'echo', command: 'node' })
    expect(agent.mcp.value?.servers[0].env).toBeUndefined()
  })

  it('testMcpServer:POST /api/agent/mcp/:name/test 透传返回', async () => {
    const stub = stubMcpApi([], [])
    const agent = useAgent()
    const result = await agent.testMcpServer('echo')
    expect(result.ok).toBe(true)
    expect(result.tools?.map((t) => t.name)).toEqual(['echo'])
    expect(stub.getTestCalls()).toBe(1)
  })

  it('deleteMcpServer:DELETE 后刷新列表', async () => {
    // 简化:DELETE 返回空列表
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/agent/mcp' && (init?.method ?? 'GET') === 'GET') {
          return jsonResponse({ servers: [], status: [] })
        }
        if (url === '/api/agent/mcp/echo' && init?.method === 'DELETE') {
          return jsonResponse({ servers: [], status: [] })
        }
        return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
      }),
    )
    const agent = useAgent()
    await agent.deleteMcpServer('echo')
    expect(agent.mcp.value?.servers).toEqual([])
  })

  it('init() 拉取 mcp 配置(失败静默,不阻塞聊天)', async () => {
    stubMcpApi([{ name: 'echo', command: 'node', enabled: true }], [])
    const agent = useAgent()
    await agent.init()
    expect(agent.mcp.value?.servers).toHaveLength(1)
  })
})

describe('useAgent 视觉模型配置(/api/agent/config/vision)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('saveVisionConfig:PUT 请求体 = patch,成功后刷新 config(含 visionEnabled/hasVisionApiKey)', async () => {
    let sentBody: unknown = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/agent/config/vision' && init?.method === 'PUT') {
          sentBody = JSON.parse(String(init?.body))
          return jsonResponse({
            hasApiKey: true,
            model: 'deepseek-v4-flash',
            thinkingLevel: 'off',
            models: [],
            thinkingLevels: ['off'],
            visionEnabled: true,
            hasVisionApiKey: true,
          })
        }
        if (url === '/api/agent/config') {
          return jsonResponse({
            hasApiKey: true,
            model: 'deepseek-v4-flash',
            thinkingLevel: 'off',
            models: [],
            thinkingLevels: ['off'],
            visionEnabled: true,
            hasVisionApiKey: true,
          })
        }
        return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
      }),
    )
    const agent = useAgent()
    await agent.saveVisionConfig({ enabled: true, apiKey: 'sk-xiaomi-1' })

    expect(sentBody).toEqual({ enabled: true, apiKey: 'sk-xiaomi-1' })
    expect(agent.config.value?.visionEnabled).toBe(true)
    expect(agent.config.value?.hasVisionApiKey).toBe(true)
    expect(agent.visionEnabled.value).toBe(true)
    expect(agent.hasVisionApiKey.value).toBe(true)
  })

  it('saveVisionConfig:关闭时仅提交 enabled(不携带 apiKey);computed 默认 false', async () => {
    let sentBody: unknown = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/agent/config/vision' && init?.method === 'PUT') {
          sentBody = JSON.parse(String(init?.body))
          return jsonResponse({
            hasApiKey: true,
            model: 'deepseek-v4-flash',
            thinkingLevel: 'off',
            models: [],
            thinkingLevels: ['off'],
            visionEnabled: false,
            hasVisionApiKey: true,
          })
        }
        if (url === '/api/agent/config') {
          return jsonResponse({
            hasApiKey: true,
            model: 'deepseek-v4-flash',
            thinkingLevel: 'off',
            models: [],
            thinkingLevels: ['off'],
            visionEnabled: false,
            hasVisionApiKey: true,
          })
        }
        return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
      }),
    )
    const agent = useAgent()
    // 未加载 config 时默认 false
    expect(agent.visionEnabled.value).toBe(false)
    await agent.saveVisionConfig({ enabled: false })

    expect(sentBody).toEqual({ enabled: false })
    expect(agent.visionEnabled.value).toBe(false)
    expect(agent.hasVisionApiKey.value).toBe(true)
  })
})


describe('useAgent 图片上传与发送(uploadImage / sendMessage images)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 完整路由 stub(基础路由 + uploads 分支;uploadImpl 仅处理 POST /uploads) */
  function stubApiWithUpload(uploadImpl: (url: string, init: RequestInit) => Response | Promise<Response>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const requestInit = init ?? {}
        if (url.endsWith('/ws-1/uploads') && requestInit.method === 'POST') return uploadImpl(url, requestInit)
        if (url === '/api/agent/config') {
          return jsonResponse({ hasApiKey: true, model: 'deepseek-v4-flash', thinkingLevel: 'off', models: [], thinkingLevels: ['off'] })
        }
        if (url === '/api/agent/workspaces') {
          return jsonResponse([{ id: 'ws-1', path: '/x', name: 'x', readOnly: false, createdAt: 0 }])
        }
        if (url.endsWith('/ws-1/open')) {
          return jsonResponse({
            history: [],
            status: { workspaceId: 'ws-1', model: 'deepseek-v4-flash', thinkingLevel: 'off', messageCount: 0, streaming: false, lastActivityAt: null },
          })
        }
        if (url.endsWith('/ws-1/status')) {
          return jsonResponse({ workspaceId: 'ws-1', model: 'deepseek-v4-flash', thinkingLevel: 'off', messageCount: 0, streaming: false, lastActivityAt: null })
        }
        return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
      }),
    )
  }

  it('uploadImage:POST /uploads,body 为纯 base64(无 data: 前缀),返回 path', async () => {
    let sentBody: unknown = null
    let sentUrl = ''
    stubApiWithUpload((url, init) => {
      sentUrl = url
      sentBody = JSON.parse(String(init?.body))
      return jsonResponse({ path: '.workflows/uploads/abc.png' })
    })
    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')

    const path = await agent.uploadImage('data:image/jpeg;base64,AAAA')
    expect(path).toBe('.workflows/uploads/abc.png')
    expect(sentUrl).toBe('/api/agent/workspaces/ws-1/uploads')
    // 纯 base64 payload(去 data: 前缀,后端魔数嗅探定 mime,不信客户端)
    expect(sentBody).toEqual({ data: 'AAAA' })
  })

  it('uploadImage:无工作区 → 抛错', async () => {
    const agent = useAgent()
    await expect(agent.uploadImage('data:image/png;base64,x')).rejects.toThrow('请先选择工作区')
  })

  it('uploadImage:400 错误文案透出', async () => {
    stubApiWithUpload(
      () =>
        ({
          ok: false,
          json: async () => ({ code: 400, message: '不支持的图片格式(支持 JPEG/PNG/GIF/WebP)', data: null }),
        }) as unknown as Response,
    )
    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')

    await expect(agent.uploadImage('data:image/png;base64,x')).rejects.toThrow('不支持的图片格式(支持 JPEG/PNG/GIF/WebP)')
  })

  it('sendMessage(text, images):pushUserMessage 产生的 UiMessage 含 images 字段', async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.close()
      },
    })
    stubApi(stream)
    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')

    const images = [{ path: '.workflows/uploads/abc.png', thumb: 'blob:mock-thumb' }]
    await agent.sendMessage('[图片: .workflows/uploads/abc.png] 请分析', images)

    const first = agent.messages.value[0]
    expect(first.role).toBe('user')
    expect(messageText(first)).toBe('[图片: .workflows/uploads/abc.png] 请分析')
    expect(first.images).toEqual(images)
  })

  it('sendMessage 无 images 时 UiMessage.images 为 undefined(既有行为不变)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.close()
      },
    })
    stubApi(stream)
    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')

    await agent.sendMessage('hi')
    expect(agent.messages.value[0].images).toBeUndefined()
  })
})

describe('useAgent 工作区切换防护(switchingWorkspaceId / openSeq / SSE 归属)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 可手动控制推送时机的 SSE 流(归属校验用例需要精确的切换时机) */
  function manualStream(): { stream: ReadableStream<Uint8Array>; push: (chunk: string) => void; close: () => void } {
    let controller: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    return {
      stream,
      push: (chunk) => controller.enqueue(encoder.encode(chunk)),
      close: () => controller.close(),
    }
  }

  const configBody = { hasApiKey: true, model: 'deepseek-v4-flash', thinkingLevel: 'off', models: [], thinkingLevels: ['off'] }
  const statusBody = (id: string) => ({
    workspaceId: id,
    model: 'deepseek-v4-flash',
    thinkingLevel: 'off',
    messageCount: 0,
    streaming: false,
    lastActivityAt: null,
  })
  const openBody = (id: string, history: unknown[] = []) => ({ history, status: statusBody(id) })
  const emptyStream = () =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.close()
      },
    })

  it('openWorkspace 在途时 sendMessage 拒绝发送:无幻影用户消息、不发 /prompt(窗口期防护)', async () => {
    let resolveOpen!: (r: Response) => void
    const openPromise = new Promise<Response>((resolve) => {
      resolveOpen = resolve
    })
    const promptCalls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/agent/config') return jsonResponse(configBody)
        if (url === '/api/agent/workspaces') {
          return jsonResponse([
            { id: 'ws-1', path: '/x', name: 'x', readOnly: false, createdAt: 0 },
            { id: 'ws-2', path: '/y', name: 'y', readOnly: false, createdAt: 0 },
          ])
        }
        if (url.endsWith('/ws-1/open')) return jsonResponse(openBody('ws-1'))
        if (url.endsWith('/ws-2/open')) return openPromise
        if (url.endsWith('/prompt')) {
          promptCalls.push(url)
          return { ok: true, body: emptyStream(), json: async () => ({}) } as unknown as Response
        }
        return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
      }),
    )
    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')
    expect(agent.activeWorkspaceId.value).toBe('ws-1')

    // 点击 ws-2:/open 挂起,切换窗口期从点击这一刻开始
    const opening = agent.openWorkspace('ws-2')
    expect(agent.switchingWorkspaceId.value).toBe('ws-2')

    // 窗口期内发送 → 拒绝;且拒绝发生在 pushUserMessage 之前(无幻影用户消息、无 /prompt 请求)
    await expect(agent.sendMessage('hi')).rejects.toThrow('正在切换工作区')
    expect(agent.messages.value).toHaveLength(0)
    expect(promptCalls).toHaveLength(0)

    resolveOpen(jsonResponse(openBody('ws-2')))
    await opening
    expect(agent.activeWorkspaceId.value).toBe('ws-2')
    expect(agent.switchingWorkspaceId.value).toBeNull()
  })

  it('流式期间切走工作区:旧流后续 SSE 事件不再渲染进新视图(归属校验 + 断开)', async () => {
    const { stream, push, close } = manualStream()
    stubApi(stream)
    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')

    const sending = agent.sendMessage('hi')
    push('data: {"type":"agent_start"}\n\n')
    push('data: {"type":"text_delta","delta":"旧"}\n\n')
    // 等第一段增量渲染完成(此时归属校验点已就位)
    await vi.waitFor(() => {
      expect(messageText(agent.messages.value.at(-1)!)).toBe('旧')
    })

    // 模拟 openWorkspace 完成:视图切到新工作区
    agent.activeWorkspaceId.value = 'ws-2'
    // 旧流后续事件(text_delta / agent_end / done)全部不得渲染
    push('data: {"type":"text_delta","delta":"世界"}\n\n')
    push('data: {"type":"agent_end"}\n\n')
    push('data: {"type":"done"}\n\n')
    close()
    await sending

    const last = agent.messages.value.at(-1)
    expect(messageText(last!)).toBe('旧')
    expect(agent.messages.value.filter((m) => m.role === 'assistant')).toHaveLength(1)
    // 归属校验放行前的事件正常渲染,切走后的事件被丢弃
    expect(agent.messages.value.map((m) => messageText(m))).toEqual(['hi', '旧'])
  })

  it('快速连点工作区:晚到的 /open 响应被丢弃,最终激活最后点击者(openSeq 乱序防护)', async () => {
    let resolveA!: (r: Response) => void
    let resolveB!: (r: Response) => void
    const openA = new Promise<Response>((resolve) => {
      resolveA = resolve
    })
    const openB = new Promise<Response>((resolve) => {
      resolveB = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/agent/config') return jsonResponse(configBody)
        if (url === '/api/agent/workspaces') {
          return jsonResponse([
            { id: 'ws-1', path: '/x', name: 'x', readOnly: false, createdAt: 0 },
            { id: 'ws-2', path: '/y', name: 'y', readOnly: false, createdAt: 0 },
          ])
        }
        if (url.endsWith('/ws-1/open')) return openA
        if (url.endsWith('/ws-2/open')) return openB
        return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
      }),
    )
    const agent = useAgent()
    await agent.init()
    // 先点 ws-1(挂起),再点 ws-2(挂起);ws-2 先返回
    const p1 = agent.openWorkspace('ws-1')
    const p2 = agent.openWorkspace('ws-2')
    expect(agent.switchingWorkspaceId.value).toBe('ws-2')

    resolveB(jsonResponse(openBody('ws-2', [{ id: 'u1', role: 'user', blocks: [{ type: 'text', text: '来自B' }] }])))
    await p2
    expect(agent.activeWorkspaceId.value).toBe('ws-2')
    expect(agent.messages.value.map((m) => messageText(m))).toEqual(['来自B'])

    // ws-1 的晚到响应被丢弃:不覆盖 activeWorkspaceId、不换历史
    resolveA(jsonResponse(openBody('ws-1', [{ id: 'u1', role: 'user', blocks: [{ type: 'text', text: '来自A' }] }])))
    await p1
    expect(agent.activeWorkspaceId.value).toBe('ws-2')
    expect(agent.messages.value.map((m) => messageText(m))).toEqual(['来自B'])
    expect(agent.switchingWorkspaceId.value).toBeNull()
  })

  it('在途切换期间点回当前工作区:晚到的 /open 响应被作废,视图不跳走(早退 bump openSeq)', async () => {
    let resolveA!: (r: Response) => void
    const openA = new Promise<Response>((resolve) => {
      resolveA = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/agent/config') return jsonResponse(configBody)
        if (url === '/api/agent/workspaces') {
          return jsonResponse([
            { id: 'ws-1', path: '/x', name: 'x', readOnly: false, createdAt: 0 },
            { id: 'ws-2', path: '/y', name: 'y', readOnly: false, createdAt: 0 },
          ])
        }
        if (url.endsWith('/ws-1/open')) return jsonResponse(openBody('ws-1'))
        if (url.endsWith('/ws-2/open')) return openA
        return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
      }),
    )
    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')
    expect(agent.activeWorkspaceId.value).toBe('ws-1')

    // 在途 open(ws-2)挂起,期间点回当前工作区 ws-1:早退立即作废在途切换
    const opening = agent.openWorkspace('ws-2')
    expect(agent.switchingWorkspaceId.value).toBe('ws-2')
    await agent.openWorkspace('ws-1')
    expect(agent.switchingWorkspaceId.value).toBeNull()
    expect(agent.activeWorkspaceId.value).toBe('ws-1')

    // ws-2 晚到响应被丢弃:视图不跳走、历史不被覆盖
    resolveA(jsonResponse(openBody('ws-2', [{ id: 'u1', role: 'user', blocks: [{ type: 'text', text: '来自A' }] }])))
    await opening
    expect(agent.activeWorkspaceId.value).toBe('ws-1')
    expect(agent.messages.value).toHaveLength(0)
    expect(agent.switchingWorkspaceId.value).toBeNull()
  })

  it('abort 按流归属中止:切走后停止中止流所属工作区回合,不误伤当前工作区', async () => {
    const calls: string[] = []
    // 归属流连接:abort 信号触发时以 AbortError 拒绝 read,模拟真实 fetch 断开
    let attachSignal: (signal: AbortSignal) => void = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        attachSignal = (signal) => {
          signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
        }
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/agent/config') return jsonResponse(configBody)
        if (url === '/api/agent/workspaces') {
          return jsonResponse([
            { id: 'ws-1', path: '/x', name: 'x', readOnly: false, createdAt: 0 },
            { id: 'ws-2', path: '/y', name: 'y', readOnly: false, createdAt: 0 },
          ])
        }
        if (url.endsWith('/ws-1/open')) return jsonResponse(openBody('ws-1'))
        if (url.endsWith('/ws-1/prompt')) {
          attachSignal(init?.signal ?? new AbortController().signal)
          return { ok: true, body: stream, json: async () => ({}) } as unknown as Response
        }
        if (url.includes('/abort')) {
          calls.push(url)
          return jsonResponse(null)
        }
        return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
      }),
    )
    const agent = useAgent()
    await agent.init()
    await agent.openWorkspace('ws-1')

    const sending = agent.sendMessage('hi')
    // 流启动即绑定归属:streamingWorkspaceId = ws-1
    await vi.waitFor(() => {
      expect(agent.streaming.value).toBe(true)
    })

    // 回合运行中视图切到 ws-2,再点停止:中止目标是流所属工作区 ws-1,
    // 而非当前激活的 ws-2(不误伤其他工作区的回合/连接)
    agent.activeWorkspaceId.value = 'ws-2'
    await agent.abort()
    await sending

    expect(calls).toEqual(['/api/agent/workspaces/ws-1/abort'])
    // 归属流连接已被客户端断开(AbortError 收尾),流式状态无残留
    expect(agent.streaming.value).toBe(false)
    expect(agent.messages.value.map((m) => messageText(m))).toEqual(['hi'])
  })
})
