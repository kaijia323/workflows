import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStore } from '../composables/useAgent'
import WorkspaceRail from './WorkspaceRail.vue'

function mountRail(agent?: Partial<AgentStore>, options: { attachTo?: boolean; open?: boolean } = {}) {
  const removeWorkspace = vi.fn(async () => {})
  const openWorkspace = vi.fn(async () => {})
  const workspaces = ref([
    { id: 'ws-1', path: 'C:\\ws\\alpha', name: 'alpha', readOnly: false, createdAt: 1785739800000 },
    { id: 'ws-2', path: 'C:\\ws\\beta', name: 'beta', readOnly: true, createdAt: 1785739800000 },
  ])
  const store = {
    workspaces,
    activeWorkspaceId: ref('ws-1'),
    removeWorkspace,
    openWorkspace,
    ...agent,
  } as unknown as AgentStore
  const wrapper = mount(WorkspaceRail, {
    props: { agent: store, open: options.open ?? false },
    attachTo: options.attachTo ? document.body : undefined,
  })
  return { wrapper, removeWorkspace, openWorkspace }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkspaceRail 工作区卡片', () => {
  it('每张卡片右上角各有一个「移除」图标按钮,常显(不依赖 hover),带 title/aria-label', () => {
    const { wrapper } = mountRail()
    const removeButtons = wrapper
      .findAll('button')
      .filter((b) => b.attributes('aria-label')?.startsWith('移除工作区 '))

    expect(removeButtons).toHaveLength(2)
    for (const btn of removeButtons) {
      expect(btn.attributes('title')).toBe('移除')
      expect(btn.classes()).not.toContain('hidden')
      expect(btn.classes()).not.toContain('group-hover:flex')
      expect(btn.text()).toBe('') // icon-only(Trash2)
    }
  })

  it('点击「移除」先弹确认:确认后调用 removeWorkspace', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { wrapper, removeWorkspace } = mountRail()

    const removeBtn = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '移除工作区 alpha')!
    await removeBtn.trigger('click')
    await vi.waitFor(() => expect(removeWorkspace).toHaveBeenCalledWith('ws-1'))
  })

  it('确认框取消时不调用 removeWorkspace', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { wrapper, removeWorkspace } = mountRail()

    await wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '移除工作区 alpha')
      ?.trigger('click')
    await Promise.resolve()
    expect(removeWorkspace).not.toHaveBeenCalled()
  })

  it('点击工作区行:先 emit select-workspace,再调用 openWorkspace', async () => {
    const { wrapper, openWorkspace } = mountRail()

    const rowBtn = wrapper.findAll('button').find((b) => b.text().includes('alpha'))!
    await rowBtn.trigger('click')

    expect(wrapper.emitted('selectWorkspace')).toHaveLength(1)
    expect(openWorkspace).toHaveBeenCalledWith('ws-1')
  })

  it('移除按钮可聚焦(键盘可达)', () => {
    const { wrapper } = mountRail(undefined, { attachTo: true })
    const removeBtn = wrapper
      .findAll('button')
      .find((b) => b.attributes('aria-label') === '移除工作区 alpha')!
    ;(removeBtn.element as HTMLElement).focus()
    expect(document.activeElement).toBe(removeBtn.element)
    wrapper.unmount()
  })
})
