import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import type { UiMessage, UiSegment } from '../composables/useAgent'
import MessageBubble from './MessageBubble.vue'

/** 构造含思考段 + 工具段 + 正文的助手消息 */
function makeMessage(overrides: Partial<UiMessage> = {}): UiMessage {
  return reactive<UiMessage>({
    id: 'm1',
    role: 'assistant',
    segments: [
      { kind: 'thinking', text: '先分析需求' },
      { kind: 'tool', callId: 'c1', name: 'read', output: '文件内容', isError: false, collapsed: false },
      { kind: 'text', text: '完成' },
    ],
    thinkingTouched: new Set(),
    thinkingOpen: new Set(),
    status: 'done',
    ...overrides,
  })
}

function mountBubble(message: UiMessage) {
  const wrapper = mount(MessageBubble, {
    props: { message },
    attachTo: document.body,
  })
  return wrapper
}

describe('MessageBubble 折叠语义', () => {
  /** 模拟父级(ChatPane)的 toggle-thinking 处理:标记手动 + 翻转展开状态 */
  function handleToggleThinking(message: UiMessage, key: string): void {
    message.thinkingTouched.add(key)
    if (message.thinkingOpen.has(key)) message.thinkingOpen.delete(key)
    else message.thinkingOpen.add(key)
  }

  it('THINKING 按钮 aria-expanded 随点击在 true/false 间切换', async () => {
    const message = makeMessage()
    const wrapper = mountBubble(message)

    const thinkingBtn = wrapper.findAll('button').find((b) => b.text().includes('THINKING'))!
    // 初始:thinking 块默认收起(非流式) → aria-expanded=false
    expect(thinkingBtn.attributes('aria-expanded')).toBe('false')

    // 点击展开(组件发 toggle-thinking;此处模拟父级处理后重渲染)
    await thinkingBtn.trigger('click')
    const [msg, key] = wrapper.emitted('toggle-thinking')!.at(-1)!
    handleToggleThinking(msg as UiMessage, key as string)
    await flushPromises()
    expect(thinkingBtn.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('pre').exists()).toBe(true)

    // 再点收起
    await thinkingBtn.trigger('click')
    const [msg2, key2] = wrapper.emitted('toggle-thinking')!.at(-1)!
    handleToggleThinking(msg2 as UiMessage, key2 as string)
    await flushPromises()
    expect(thinkingBtn.attributes('aria-expanded')).toBe('false')

    wrapper.unmount()
  })

  it('工具行按钮 aria-expanded 默认 true,随 toggle-tool 切换', async () => {
    const message = makeMessage()
    const wrapper = mountBubble(message)

    const toolBtn = wrapper.findAll('button').find((b) => b.text().includes('read'))!
    expect(toolBtn.attributes('aria-expanded')).toBe('true')

    // 组件内部点击工具行发 tool-click;App 层用 toggle-tool 改 collapsed。
    // 这里直接改 collapsed 模拟父级处理,aria-expanded 应跟随
    ;(message.segments[1] as Extract<UiSegment, { kind: 'tool' }>).collapsed = true
    await flushPromises()
    expect(toolBtn.attributes('aria-expanded')).toBe('false')

    ;(message.segments[1] as Extract<UiSegment, { kind: 'tool' }>).collapsed = false
    await flushPromises()
    expect(toolBtn.attributes('aria-expanded')).toBe('true')

    wrapper.unmount()
  })
})
