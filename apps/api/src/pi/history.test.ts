/**
 * renderHistory 单测。
 *
 * 回归:消息顺序恒为 assistant(含 toolCall) → toolResult,单遍扫描渲染
 * assistant 消息时 tool 输出 Map 尚未写入,导致工具块 output 缺失、前端
 * 展开面板空白;改为两遍扫描后 tool 输出应正确关联。
 */
import { describe, expect, it } from 'vitest'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { renderHistory } from './history.js'

function toolCallMessage(partial: Record<string, unknown>): Record<string, unknown> {
  return { role: 'assistant', timestamp: 2, content: [], usage: undefined, ...partial }
}

function toolResultMessage(partial: Record<string, unknown>): Record<string, unknown> {
  return { role: 'toolResult', timestamp: 3, isError: false, content: [], ...partial }
}

function asSession(messages: unknown[]): AgentSession {
  return { messages } as unknown as AgentSession
}

describe('renderHistory 工具输出关联', () => {
  it('assistant toolCall 在前、toolResult 在后时,tool 块 output 非空', () => {
    const session = asSession([
      { role: 'user', timestamp: 1, content: [{ type: 'text', text: '读取文件' }] },
      toolCallMessage({
        content: [
          { type: 'thinking', thinking: '需要读取文件' },
          { type: 'toolCall', id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } },
        ],
      }),
      toolResultMessage({ toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容' }] }),
    ])

    const items = renderHistory(session)

    expect(items).toHaveLength(2) // user + assistant;toolResult 不单独成条
    const toolBlock = items[1].blocks.find((b) => b.type === 'tool')
    expect(toolBlock).toBeDefined()
    expect(toolBlock).toMatchObject({
      type: 'tool',
      callId: 'call_1',
      name: 'read_file',
      args: { path: 'a.txt' },
      output: '文件内容',
      isError: false,
    })
    // 其余块与字段保持原格式
    expect(items[1].blocks.map((b) => b.type)).toEqual(['thinking', 'tool'])
  })

  it('toolResult 在 assistant 之前时同样能关联(顺序无关)', () => {
    const session = asSession([
      toolResultMessage({ toolCallId: 'call_2', content: [{ type: 'text', text: '结果2' }] }),
      toolCallMessage({
        content: [{ type: 'toolCall', id: 'call_2', name: 'bash', arguments: { cmd: 'ls' } }],
      }),
    ])

    const items = renderHistory(session)
    const toolBlock = items[0].blocks.find((b) => b.type === 'tool')
    expect(toolBlock?.output).toBe('结果2')
  })

  it('同 toolCallId 多条 toolResult 时取最后一条', () => {
    const session = asSession([
      toolResultMessage({ toolCallId: 'call_3', content: [{ type: 'text', text: '第一次' }] }),
      toolResultMessage({ toolCallId: 'call_3', content: [{ type: 'text', text: '最后一次' }] }),
      toolCallMessage({
        content: [{ type: 'toolCall', id: 'call_3', name: 'read_file', arguments: {} }],
      }),
    ])

    const items = renderHistory(session)
    const toolBlock = items[0].blocks.find((b) => b.type === 'tool')
    expect(toolBlock?.output).toBe('最后一次')
  })
})
