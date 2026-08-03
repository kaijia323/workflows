import { afterEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import { useAgent } from './useAgent'

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
      () => agent.messages.value.at(-1)?.text ?? '',
      (text) => snapshots.push(text),
      { flush: 'sync' },
    )

    await agent.sendMessage('hi')
    stop()

    // 每次 text_delta 都应触发一次更新:用户消息 → 空消息 → "你" → "你好"
    // (而非只在流结束后一次性出现)
    expect(snapshots).toEqual(['hi', '', '你', '你好'])
    const last = agent.messages.value.at(-1)
    expect(last?.text).toBe('你好')
    expect(last?.status).toBe('done')
  })
})
