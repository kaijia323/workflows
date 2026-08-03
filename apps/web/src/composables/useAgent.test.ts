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
