import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStore } from '../composables/useAgent'
import WorkspacePickerModal from './WorkspacePickerModal.vue'

const HOME = 'C:\\Users\\dev'
const HOME_ENTRIES = [{ name: '.git' }, { name: 'apps' }, { name: 'node_modules' }, { name: 'pkg-2' }, { name: 'pkg-10' }]
const MODULES_ENTRIES = [{ name: 'frontend' }, { name: 'backend' }]

/** 目录浏览 API 桩:主目录 5 项,node_modules 内 2 项 */
function stubFs() {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith('/api/agent/fs/list')) {
        const q = new URL(url, 'http://test.local').searchParams.get('path')
        const dir = q ?? HOME
        const entries = dir === HOME ? HOME_ENTRIES : dir.endsWith('node_modules') ? MODULES_ENTRIES : []
        const parent = dir === 'C:\\Users' ? null : dir.replace(/[\\/][^\\/]+$/, '')
        return {
          ok: true,
          json: async () => ({ code: 0, message: 'ok', data: { path: dir, parent, entries } }),
        }
      }
      return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
    }),
  )
  return calls
}

function mountModal(agent?: Partial<AgentStore>) {
  const addWorkspace = vi.fn(async () => {})
  const store = {
    workspaces: ref([]),
    addWorkspace,
    ...agent,
  } as unknown as AgentStore
  const wrapper = mount(WorkspacePickerModal, { props: { agent: store } })
  return { wrapper, addWorkspace, store }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkspacePickerModal', () => {
  it('打开后加载主目录,渲染面包屑与目录列表', async () => {
    stubFs()
    const { wrapper } = mountModal()
    await flushPromises()

    expect(wrapper.text()).toContain('添加工作区 · SOURCE')
    // 面包屑:C: / Users / dev
    expect(wrapper.text()).toContain('C:')
    expect(wrapper.text()).toContain('dev')
    // 列表含 ../ 行与目录(尾斜杠)
    expect(wrapper.text()).toContain('../')
    expect(wrapper.text()).toContain('node_modules/')
    expect(wrapper.text()).toContain('.git/')
    // 底部路径与按键提示
    expect(wrapper.text()).toContain(HOME)
    expect(wrapper.text()).toContain('确认添加')
  })

  it('输入过滤目录,匹配段高亮', async () => {
    stubFs()
    const { wrapper } = mountModal()
    await flushPromises()

    const input = wrapper.find('input')
    await input.setValue('pkg')
    await flushPromises()

    expect(wrapper.text()).toContain('pkg-2/')
    expect(wrapper.text()).toContain('pkg-10/')
    expect(wrapper.text()).not.toContain('node_modules/')
    // 无匹配时给出提示
    await input.setValue('zzz')
    await flushPromises()
    expect(wrapper.text()).toContain('无匹配目录')
  })

  it('Tab 把查询补全为前缀匹配的目录名', async () => {
    stubFs()
    const { wrapper } = mountModal()
    await flushPromises()

    const input = wrapper.find('input')
    await input.setValue('node_mod')
    await input.trigger('keydown', { key: 'Tab' })
    await flushPromises()

    expect((input.element as HTMLInputElement).value).toBe('node_modules')
  })

  it('Enter 进入选中目录', async () => {
    const calls = stubFs()
    const { wrapper } = mountModal()
    await flushPromises()

    const input = wrapper.find('input')
    await input.setValue('node_mod')
    await input.trigger('keydown', { key: 'Tab' })
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(calls.some((c) => c.includes(encodeURIComponent('C:\\Users\\dev\\node_modules')))).toBe(true)
    expect(wrapper.text()).toContain('frontend/')
    expect(wrapper.text()).toContain('backend/')
  })

  it('无选中时 Enter 确认添加当前目录并关闭', async () => {
    stubFs()
    const { wrapper, addWorkspace } = mountModal()
    await flushPromises()

    await wrapper.find('input').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(addWorkspace).toHaveBeenCalledWith(HOME)
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('当前目录已在工作区列表时禁用确认', async () => {
    stubFs()
    const { wrapper } = mountModal({
      workspaces: ref([{ id: 'ws-1', path: HOME, name: 'dev', readOnly: false, createdAt: 0 }]),
    })
    await flushPromises()

    expect(wrapper.text()).toContain('已在列表中')
    const btn = wrapper.findAll('button').find((b) => b.text().includes('已在列表中'))
    expect(btn?.attributes('disabled')).toBeDefined()
  })
})
