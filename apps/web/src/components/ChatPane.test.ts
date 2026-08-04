import { flushPromises, mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { SkillInfo } from '@workflows/shared'
import type { AgentStore } from '../composables/useAgent'
import ChatPane from './ChatPane.vue'

function skill(name: string, source: SkillInfo['source'], description = `描述 ${name}`): SkillInfo {
  return {
    name,
    description,
    filePath: `C:\\ws\\${name}\\SKILL.md`,
    baseDir: `C:\\ws\\${name}`,
    source,
    sourcePath: `C:\\ws\\${name}`,
    disableModelInvocation: false,
  }
}

const SKILLS: SkillInfo[] = [
  skill('greet', 'pi-agent', '用中文打招呼'),
  skill('summarize', 'workspace', '总结内容'),
  skill('planning', 'global-agents'),
  skill('plan-check', 'pi-project'),
]

interface PaneOptions {
  skills?: SkillInfo[]
  streaming?: boolean
  workspaceId?: string | null
  /** 挂载到 document.body(jsdom 仅在元素已连接时 focus() 才生效,用于焦点断言) */
  attachTo?: boolean
}

function mountPane(options: PaneOptions = {}) {
  const messages = ref<never[]>([])
  const streaming = ref(options.streaming ?? false)
  const activeWorkspaceId = ref<string | null>(options.workspaceId === undefined ? 'ws-1' : options.workspaceId)
  const activeWorkspace = computed(() =>
    activeWorkspaceId.value
      ? { id: activeWorkspaceId.value, path: 'C:\\ws', name: 'ws', readOnly: false, createdAt: 0 }
      : null,
  )
  const skills = ref<SkillInfo[]>(options.skills ?? [])
  const sendMessage = vi.fn(async () => {})
  const agent = {
    messages,
    streaming,
    activeWorkspaceId,
    activeWorkspace,
    skills,
    status: ref({ messageCount: 0 }),
    sessionList: ref(null),
    gateRequest: ref(null),
    hasApiKey: ref(true),
    config: ref({ model: 'm', models: [], thinkingLevel: 'off', thinkingLevels: [] }),
    subSessions: new Map(),
    run: ref(null),
    sendMessage,
    abort: vi.fn(async () => {}),
    dismissGate: vi.fn(),
  } as unknown as AgentStore
  const wrapper = mount(ChatPane, {
    props: { agent, onOpenSettings: () => {} },
    attachTo: options.attachTo ? document.body : undefined,
  })
  return { wrapper, agent, sendMessage, skills, activeWorkspaceId }
}

describe('ChatPane / skill 搜索下拉', () => {
  it('输入 / 弹出下拉,展示全部 skills 与来源标签', async () => {
    const { wrapper } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()

    expect(wrapper.text()).toContain('/skill:greet')
    expect(wrapper.text()).toContain('/skill:summarize')
    expect(wrapper.text()).toContain('/skill:planning')
    expect(wrapper.text()).toContain('/skill:plan-check')
    // 来源标签:pi-agent → 全局(pi);workspace → 工作台;global-agents → 全局(agents);pi-project → 项目
    expect(wrapper.text()).toContain('全局(pi)')
    expect(wrapper.text()).toContain('工作台')
    expect(wrapper.text()).toContain('全局(agents)')
    expect(wrapper.text()).toContain('项目')
  })

  it('输入查询词按名称过滤(前缀优先)', async () => {
    const { wrapper } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/plan')
    await flushPromises()

    expect(wrapper.text()).toContain('/skill:planning')
    expect(wrapper.text()).toContain('/skill:plan-check')
    expect(wrapper.text()).not.toContain('/skill:greet')
    expect(wrapper.text()).not.toContain('/skill:summarize')
  })

  it('描述匹配也能命中', async () => {
    const { wrapper } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/打招呼')
    await flushPromises()

    expect(wrapper.text()).toContain('/skill:greet')
    expect(wrapper.text()).not.toContain('/skill:planning')
  })

  it('ArrowDown 循环高亮 + Enter 填入 /skill:<name> 不发送', async () => {
    const { wrapper, sendMessage } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()
    await textarea.trigger('keydown', { key: 'ArrowDown' })
    await textarea.trigger('keydown', { key: 'ArrowDown' })
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/skill:planning ')
    expect(sendMessage).not.toHaveBeenCalled()
    // 选中后菜单关闭
    expect(wrapper.text()).not.toContain('/skill:greet')
  })

  it('Tab 选中当前高亮 skill 填入 /skill:<name>,preventDefault 且焦点不丢失', async () => {
    const { wrapper, sendMessage } = mountPane({ skills: SKILLS, attachTo: true })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()
    await textarea.trigger('keydown', { key: 'ArrowDown' }) // 高亮 → summarize(索引 1)
    await textarea.trigger('keydown', { key: 'Tab' })
    await flushPromises()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/skill:summarize ')
    expect(sendMessage).not.toHaveBeenCalled()
    // 菜单关闭
    expect(wrapper.text()).not.toContain('/skill:greet')
    // 焦点仍在输入框(未因 Tab 移出)
    expect(document.activeElement).toBe(textarea.element)

    // 下拉打开时 Tab 触发 preventDefault
    await textarea.setValue('/')
    await flushPromises()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true })
    textarea.element.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)

    wrapper.unmount()
  })

  it('下拉未打开时 Tab 不拦截(保持浏览器默认焦点移动)', async () => {
    const { wrapper, sendMessage } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('hello')
    await flushPromises()

    const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true })
    textarea.element.dispatchEvent(ev)

    expect(ev.defaultPrevented).toBe(false)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('hello')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('IME 组合输入中 Tab 不触发选择', async () => {
    const { wrapper } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()
    expect(wrapper.text()).toContain('/skill:greet')

    const ev = new KeyboardEvent('keydown', { key: 'Tab', isComposing: true, cancelable: true, bubbles: true })
    textarea.element.dispatchEvent(ev)
    await flushPromises()

    expect(ev.defaultPrevented).toBe(false)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('/')
    expect(wrapper.text()).toContain('/skill:greet') // 菜单保持打开
  })

  it('占位符提示 / 可搜索 skills;无工作区时保持原提示', async () => {
    const { wrapper } = mountPane({ workspaceId: 'ws-1' })
    expect(wrapper.find('textarea').attributes('placeholder')).toContain('/ 可搜索 skills')

    const noWs = mountPane({ workspaceId: null })
    expect(noWs.wrapper.find('textarea').attributes('placeholder')).toBe('先在左侧选择一个工作区')
  })

  it('Esc 关闭下拉,不改变输入', async () => {
    const { wrapper } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()
    expect(wrapper.text()).toContain('/skill:greet')

    await textarea.trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(wrapper.text()).not.toContain('/skill:greet')
    expect((textarea.element as HTMLTextAreaElement).value).toBe('/')
  })

  it('点击下拉项选中填入;blur 关闭菜单', async () => {
    const { wrapper } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()
    const item = wrapper.findAll('button').find((b) => b.text().includes('/skill:greet'))
    await item?.trigger('click')
    await flushPromises()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/skill:greet ')
    expect(wrapper.text()).not.toContain('/skill:summarize')

    // blur 关闭
    await textarea.setValue('/')
    await flushPromises()
    expect(wrapper.text()).toContain('/skill:greet')
    await textarea.trigger('blur')
    await flushPromises()
    expect(wrapper.text()).not.toContain('/skill:greet')
  })

  it('无 skills 时输入 / 显示空态一行', async () => {
    const { wrapper } = mountPane({ skills: [] })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()

    expect(wrapper.text()).toContain('无可用 skill')
  })

  it('切工作区关闭下拉', async () => {
    const { wrapper, activeWorkspaceId } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()
    expect(wrapper.text()).toContain('/skill:greet')

    activeWorkspaceId.value = 'ws-2'
    await flushPromises()

    expect(wrapper.text()).not.toContain('/skill:greet')
  })

  it('流式中不弹出下拉', async () => {
    const { wrapper } = mountPane({ skills: SKILLS, streaming: true })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()

    expect(wrapper.text()).not.toContain('/skill:greet')
  })

  it('无匹配查询时菜单关闭(不误伤手动输入 /skill:xxx)', async () => {
    const { wrapper, sendMessage } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/skill:nope')
    await flushPromises()

    expect(wrapper.text()).not.toContain('/skill:greet')
    // 直接回车走原逻辑:发送
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(sendMessage).toHaveBeenCalledWith('/skill:nope')
  })
})
