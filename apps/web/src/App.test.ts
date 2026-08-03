import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'

const sampleGraph = {
  nodes: [
    { id: 'node-1', label: '数据采集' },
    { id: 'node-2', label: '数据清洗' },
    { id: 'node-3', label: '模型训练' },
  ],
  edges: [
    { source: 'node-1', target: 'node-2' },
    { source: 'node-2', target: 'node-3' },
  ],
}

describe('App.vue', () => {
  beforeEach(() => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 0, message: 'ok', data: sampleGraph }),
    }))
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('挂载后请求 /api/dag 并渲染节点', async () => {
    const wrapper = mount(App)
    await flushPromises()

    const fetchMock = vi.mocked(globalThis.fetch)
    expect(fetchMock).toHaveBeenCalledWith('/api/dag')
    expect(wrapper.text()).toContain('数据采集')
    expect(wrapper.text()).toContain('模型训练')
    expect(wrapper.text()).toContain('已连接')
  })

  it('API 失败时显示错误状态', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )

    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.text()).toContain('连接失败')
  })
})
