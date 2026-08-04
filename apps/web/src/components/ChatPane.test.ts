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
  const wrapper = mount(ChatPane, { props: { agent, onOpenSettings: () => {} } })
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
