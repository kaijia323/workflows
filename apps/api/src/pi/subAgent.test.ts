/**
 * 子代理事件镜像单测。
 *
 * 回归:SDK agent-loop 对每个工具结果发 message_start(role=toolResult),
 * 若无条件镜像,前端模态窗会出现一条条只有闪烁光标(showCaretRow)的空消息。
 */
import { describe, expect, it } from 'vitest'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { toSubEvents } from './subAgent.js'

function msgEvent(role: string, timestamp = 1): AgentSessionEvent {
  return {
    type: 'message_start',
    message: {
      role,
      content: [{ type: 'text', text: 'hello' }],
      timestamp,
    },
  } as unknown as AgentSessionEvent
}

describe('toSubEvents 事件镜像', () => {
  it('toolResult 消息不镜像为 sub_message_start(回归:模态窗空消息光标)', () => {
    const events = toSubEvents('c1', msgEvent('toolResult'))
    expect(events).toEqual([])
  })

  it('user 消息镜像为带完整任务文本的 sub_message_start', () => {
    const events = toSubEvents('c1', msgEvent('user'))
    expect(events).toEqual([
      { type: 'sub_message_start', callId: 'c1', role: 'user', id: '1-user', text: 'hello' },
    ])
  })

  it('assistant 消息镜像为 sub_message_start(无文本,增量事件随后到达)', () => {
    const events = toSubEvents('c1', msgEvent('assistant'))
    expect(events).toEqual([
      { type: 'sub_message_start', callId: 'c1', role: 'assistant', id: '1-assistant', text: undefined },
    ])
  })
})
