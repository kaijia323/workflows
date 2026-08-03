/**
 * 会话历史渲染(主会话 / 子代理会话共用)。
 *
 * 与实时 SSE 一致:按 assistant 消息 content 数组的原始顺序输出 blocks,
 * 思考 / 正文 / 工具调用交错排列,不按类型归纳。
 */
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { HistoryBlock, HistoryItem } from '@workflows/shared'

export function renderHistory(session: AgentSession): HistoryItem[] {
  const items: HistoryItem[] = []
  // toolResult 消息单独成条,按 toolCallId 挂到对应工具块上
  const lastToolOutput = new Map<string, { output?: string; isError?: boolean }>()

  for (const message of session.messages) {
    if (message.role === 'user') {
      const text = extractText(message.content)
      if (!text) continue
      items.push({
        id: `u${message.timestamp}`,
        role: 'user',
        blocks: [{ type: 'text', text }],
      })
    } else if (message.role === 'assistant') {
      const blocks = renderBlocks(message, lastToolOutput)
      if (blocks.length === 0) continue
      items.push({
        id: `a${message.timestamp}`,
        role: 'assistant',
        blocks,
        usage: {
          input: message.usage?.input ?? 0,
          output: message.usage?.output ?? 0,
          cacheRead: message.usage?.cacheRead ?? 0,
          cacheWrite: message.usage?.cacheWrite ?? 0,
          totalTokens: message.usage?.totalTokens ?? 0,
          cost: message.usage?.cost.total ?? 0,
        },
        model: message.model,
      })
    } else if (message.role === 'toolResult') {
      lastToolOutput.set(message.toolCallId, {
        output: extractText(message.content),
        isError: message.isError,
      })
    }
  }
  return items
}

/** 按 content 数组顺序将消息渲染为块序列 */
function renderBlocks(
  message: { content: unknown },
  lastToolOutput: Map<string, { output?: string; isError?: boolean }>,
): HistoryBlock[] {
  if (!Array.isArray(message.content)) return []
  const blocks: HistoryBlock[] = []
  for (const part of message.content) {
    const type = (part as { type?: string }).type
    if (type === 'thinking') {
      const text = (part as { thinking: string }).thinking
      if (text) blocks.push({ type: 'thinking', text })
    } else if (type === 'text') {
      const text = (part as { text: string }).text
      if (text) blocks.push({ type: 'text', text })
    } else if (type === 'toolCall') {
      const call = part as { id: string; name: string; arguments: Record<string, unknown> }
      const result = lastToolOutput.get(call.id)
      blocks.push({
        type: 'tool',
        callId: call.id,
        name: call.name,
        args: call.arguments ?? {},
        output: result?.output,
        isError: result?.isError,
      })
    }
  }
  return blocks
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('')
}
