import { Lock, Unlock } from '@lucide/vue'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStore } from '../composables/useAgent'
import InfoPanel from './InfoPanel.vue'

function mountPanel(agent?: Partial<AgentStore>) {
  const toggleReadOnly = vi.fn(async () => {})
  const workspaces = ref([
    { id: 'ws-1', path: 'C:\\ws\\alpha', name: 'alpha', readOnly: false, createdAt: 1785739800000 },
    { id: 'ws-2', path: 'C:\\ws\\beta', name: 'beta', readOnly: true, createdAt: 1785739800000 },
  ])
  const activeWorkspace = ref(workspaces.value[0])
  const store = {
    workspaces,
    activeWorkspace,
    activeWorkspaceId: ref('ws-1'),
    status: ref(null),
    toolRuns: ref([]),
    toggleReadOnly,
    ...agent,
  } as unknown as AgentStore
  const wrapper = mount(InfoPanel, {
    props: { agent: store, meta: null, open: false },
  })
  return { wrapper, toggleReadOnly, workspaces, activeWorkspace }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InfoPanel 工作区权限徽标', () => {
  it('读写工作区:徽标为按钮,文案「读写」+ Unlock 图标,title 提示可切换为只读', () => {
    const { wrapper } = mountPanel()
    const toggle = wrapper.find('button')

    expect(toggle.exists()).toBe(true)
    expect(toggle.text()).toContain('读写')
    expect(toggle.attributes('title')).toBe('切换为只读')
    expect(toggle.findComponent(Unlock).exists()).toBe(true)
  })

  it('只读工作区:文案「只读」+ Lock 图标 + primary 呼应,title 提示可切换为读写', async () => {
    const { wrapper, workspaces, activeWorkspace } = mountPanel()
    activeWorkspace.value = workspaces.value[1]
    await nextTick()
    const toggle = wrapper.find('button')

    expect(toggle.text()).toContain('只读')
    expect(toggle.attributes('title')).toBe('切换为读写')
    expect(toggle.findComponent(Lock).exists()).toBe(true)
    expect(toggle.classes()).toContain('text-primary')
    expect(toggle.classes()).toContain('border-primary/40')
  })

  it('点击徽标调用 toggleReadOnly(激活工作区 id, 取反)', async () => {
    const { wrapper, toggleReadOnly } = mountPanel()

    await wrapper.find('button').trigger('click')
    expect(toggleReadOnly).toHaveBeenCalledWith('ws-1', true)
  })
})
