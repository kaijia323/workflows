import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStore } from '../composables/useAgent'
import WorkspaceRail from './WorkspaceRail.vue'

function mountRail(agent?: Partial<AgentStore>, options: { attachTo?: boolean; open?: boolean } = {}) {
  const removeWorkspace = vi.fn(async () => {})
  const toggleReadOnly = vi.fn(async () => {})
  const openWorkspace = vi.fn(async () => {})
  const workspaces = ref([
    { id: 'ws-1', path: 'C:\\ws\\alpha', name: 'alpha', readOnly: false, createdAt: 1785739800000 },
    { id: 'ws-2', path: 'C:\\ws\\beta', name: 'beta', readOnly: true, createdAt: 1785739800000 },
  ])
  const store = {
    workspaces,
    activeWorkspaceId: ref('ws-1'),
    removeWorkspace,
    toggleReadOnly,
    openWorkspace,
    ...agent,
  } as unknown as AgentStore
  const wrapper = mount(WorkspaceRail, {
    props: { agent: store, open: options.open ?? false },
    attachTo: options.attachTo ? document.body : undefined,
  })
  return { wrapper, removeWorkspace, toggleReadOnly, openWorkspace }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkspaceRail 动作行', () => {
  it('「只读/读写」「移除」按钮常显(不依赖 hover,无 hidden 类),每行各一对', () => {
    const { wrapper } = mountRail()
    const toggleButtons = wrapper.findAll('button').filter((b) => b.text() === '只读' || b.text() === '读写')
    const removeButtons = wrapper.findAll('button').filter((b) => b.text() === '移除')

    expect(toggleButtons).toHaveLength(2)
    expect(removeButtons).toHaveLength(2)
    for (const btn of [...toggleButtons, ...removeButtons]) {
      expect(btn.classes()).not.toContain('hidden')
      expect(btn.classes()).not.toContain('group-hover:flex')
    }
  })

  it('读写/只读按钮文案与 readOnly 状态对应,点击调用 toggleReadOnly', async () => {
    const { wrapper, toggleReadOnly } = mountRail()
    const buttons = wrapper.findAll('button')

    // ws-1 readOnly=false → 按钮文案「只读」(点击后切换为只读)
    const toReadOnly = buttons.find((b) => b.text() === '只读')
    expect(toReadOnly?.attributes('title')).toBe('切换为只读')
    await toReadOnly?.trigger('click')
    expect(toggleReadOnly).toHaveBeenCalledWith('ws-1', true)

    // ws-2 readOnly=true → 按钮文案「读写」(点击后切换为读写)
    const toReadWrite = buttons.find((b) => b.text() === '读写')
    expect(toReadWrite?.attributes('title')).toBe('切换为读写')
    await toReadWrite?.trigger('click')
    expect(toggleReadOnly).toHaveBeenCalledWith('ws-2', false)
  })

  it('点击「移除」先弹确认:确认后调用 removeWorkspace', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { wrapper, removeWorkspace } = mountRail()

    await wrapper.findAll('button').find((b) => b.text() === '移除')?.trigger('click')
    await vi.waitFor(() => expect(removeWorkspace).toHaveBeenCalledWith('ws-1'))
  })

  it('确认框取消时不调用 removeWorkspace', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { wrapper, removeWorkspace } = mountRail()

    await wrapper.findAll('button').find((b) => b.text() === '移除')?.trigger('click')
    await Promise.resolve()
    expect(removeWorkspace).not.toHaveBeenCalled()
  })

  it('动作按钮可聚焦(键盘可达)', () => {
    const { wrapper } = mountRail(undefined, { attachTo: true })
    const removeBtn = wrapper.findAll('button').find((b) => b.text() === '移除')!
    ;(removeBtn.element as HTMLElement).focus()
    expect(document.activeElement).toBe(removeBtn.element)
    wrapper.unmount()
  })
})
