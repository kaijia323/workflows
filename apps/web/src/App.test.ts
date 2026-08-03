import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.vue'

function stubApi() {
  const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/agent/config') {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          message: 'ok',
          data: {
            hasApiKey: false,
            model: 'deepseek-v4-flash',
            thinkingLevel: 'off',
            models: [
              { provider: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, maxTokens: 384000, reasoning: true },
              { provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000, maxTokens: 384000, reasoning: true },
            ],
            thinkingLevels: ['off', 'high', 'max'],
          },
        }),
      }
    }
    if (url === '/api/agent/workspaces') {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          message: 'ok',
          data: [
            { id: 'ws-1', path: '/home/dev/alpha', name: 'alpha', readOnly: false, createdAt: 1785739800000 },
            { id: 'ws-2', path: '/home/dev/beta', name: 'beta', readOnly: true, createdAt: 1785739800000 },
          ],
        }),
      }
    }
    if (url === '/api/agent/meta') {
      return {
        ok: true,
        json: async () => ({ code: 0, message: 'ok', data: { workflowsRoot: '/repo/.workflows', environment: 'development' } }),
      }
    }
    return { ok: false, json: async () => ({ code: 404, message: 'Not Found', data: null }) }
  })
  vi.stubGlobal('fetch', mockFetch)
  return mockFetch
}

describe('App.vue', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('挂载后加载配置与工作区,渲染三栏界面', async () => {
    stubApi()
    const wrapper = mount(App)
    await flushPromises()

    // 左栏:工作区列表
    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.text()).toContain('beta')
    expect(wrapper.text()).toContain('工作区 · SOURCE')

    // 中栏:聊天空状态与模型切换
    expect(wrapper.text()).toContain('AGENT 控制台')
    expect(wrapper.text()).toContain('deepseek-v4-flash'.replace('deepseek-', ''))

    // 右栏:观测面板
    expect(wrapper.text()).toContain('观测 · OBSERVE')
    expect(wrapper.text()).toContain('/repo/.workflows')

    // 未配置 key 时提示配置入口
    expect(wrapper.text()).toContain('配置 DeepSeek API KEY')
  })

  it('API 连接失败时显示错误状态条', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.text()).toContain('离线')
    expect(wrapper.text()).toContain('network down')
  })
})
