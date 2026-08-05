import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStore } from '../composables/useAgent'
import VisionPanel from './VisionPanel.vue'

/** mock agent store:visionEnabled/hasVisionApiKey 为 computed ref,saveVisionConfig stub */
function mountPanel(overrides?: { visionEnabled?: boolean; hasVisionApiKey?: boolean }) {
  const saveVisionConfig = vi.fn(async () => {})
  const visionEnabled = ref(overrides?.visionEnabled ?? false)
  const hasVisionApiKey = ref(overrides?.hasVisionApiKey ?? false)
  const store = {
    visionEnabled,
    hasVisionApiKey,
    saveVisionConfig,
  } as unknown as AgentStore
  const wrapper = mount(VisionPanel, {
    props: {
      agent: store,
      meta: { workflowsRoot: '/tmp/.workflows', environment: 'development' },
    },
  })
  return { wrapper, saveVisionConfig, visionEnabled, hasVisionApiKey }
}

function switchButton(wrapper: ReturnType<typeof mountPanel>['wrapper']) {
  return wrapper.find('[role="switch"]')
}

function keyInput(wrapper: ReturnType<typeof mountPanel>['wrapper']) {
  return wrapper.find('input[type="password"]')
}

function submitButton(wrapper: ReturnType<typeof mountPanel>['wrapper']) {
  return wrapper.find('button[type="submit"]')
}

describe('VisionPanel 视觉模型面板', () => {
  it('开关默认取 agent.visionEnabled(关闭);状态行三态之一「已关闭」', async () => {
    const { wrapper } = mountPanel()
    await flushPromises()

    expect(switchButton(wrapper).attributes('aria-checked')).toBe('false')
    expect(wrapper.text()).toContain('已关闭(工具不可用)')
    expect(keyInput(wrapper).attributes('disabled')).toBeDefined() // 关闭时 key 输入禁用
    expect(wrapper.text()).not.toContain('清除 key') // 未配置 key 时不显示显式清空按钮
  })

  it('开启 + 保存:请求体 { enabled: true, apiKey }(key 输入清空、config 刷新由 useAgent 层负责)', async () => {
    const { wrapper, saveVisionConfig } = mountPanel()
    await flushPromises()

    await switchButton(wrapper).trigger('click') // 开启
    expect(switchButton(wrapper).attributes('aria-checked')).toBe('true')
    await keyInput(wrapper).setValue('sk-xiaomi-1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(saveVisionConfig).toHaveBeenCalledWith({ enabled: true, apiKey: 'sk-xiaomi-1' })
    expect(keyInput(wrapper).element instanceof HTMLInputElement ? (keyInput(wrapper).element as HTMLInputElement).value : '').toBe('')
    expect(wrapper.text()).toContain('已保存到后端配置')
  })

  it('关闭时保存:仅提交 { enabled: false }(不携带 apiKey,key 保留)', async () => {
    const { wrapper, saveVisionConfig } = mountPanel()
    await flushPromises()

    await wrapper.find('form').trigger('submit')

    expect(saveVisionConfig).toHaveBeenCalledWith({ enabled: false })
  })

  it('开启态空 key 输入保存:仅提交 { enabled: true }(不携带 apiKey,后端保留已配置 key)', async () => {
    const { wrapper, saveVisionConfig } = mountPanel({ visionEnabled: true, hasVisionApiKey: true })
    await flushPromises()

    // 已配置 key → 关闭开关(key 保留)→ 重新开启:key 输入框为空,保存不应清空后端 key
    await wrapper.find('form').trigger('submit')

    expect(saveVisionConfig).toHaveBeenCalledWith({ enabled: true })
  })

  it('显式清除 key:两步确认(首次点击不提交,再次点击才提交 { enabled: true, apiKey: "" })', async () => {
    const { wrapper, saveVisionConfig } = mountPanel({ visionEnabled: true, hasVisionApiKey: true })
    await flushPromises()

    const clearBtn = wrapper
      .find('form')
      .findAll('button')
      .find((b) => b.text().includes('清除'))
    expect(clearBtn?.exists()).toBe(true)
    expect(clearBtn?.text()).toBe('清除 key')

    // 首次点击:进入确认态,不发起请求(防误触)
    await clearBtn?.trigger('click')
    await flushPromises()
    expect(saveVisionConfig).not.toHaveBeenCalled()
    expect(clearBtn?.text()).toBe('确认清除?')

    // 再次点击:执行清空
    await clearBtn?.trigger('click')
    await flushPromises()
    expect(saveVisionConfig).toHaveBeenCalledWith({ enabled: true, apiKey: '' })
    expect(wrapper.text()).toContain('已保存到后端配置')
  })

  it('状态行三态:已开启·已配置 key / 已开启·未配置 key / 已关闭', async () => {
    const on = mountPanel({ visionEnabled: true, hasVisionApiKey: true })
    await flushPromises()
    expect(on.wrapper.text()).toContain('已开启 · 已配置 key(工具可用)')
    on.wrapper.unmount()

    const noKey = mountPanel({ visionEnabled: true, hasVisionApiKey: false })
    await flushPromises()
    expect(noKey.wrapper.text()).toContain('已开启 · 未配置 key(工具不可用)')
    noKey.wrapper.unmount()

    const off = mountPanel({ visionEnabled: false, hasVisionApiKey: true })
    await flushPromises()
    expect(off.wrapper.text()).toContain('已关闭(工具不可用)')
  })

  it('保存失败:错误展示 + 开关本地态回滚到后端配置值 + 输入保留', async () => {
    const saveVisionConfig = vi.fn(async () => {
      throw new Error('请求失败 (HTTP 500)')
    })
    const store = {
      visionEnabled: ref(false),
      hasVisionApiKey: ref(false),
      saveVisionConfig,
    } as unknown as AgentStore
    const wrapper = mount(VisionPanel, {
      props: { agent: store, meta: null },
    })
    await flushPromises()

    await switchButton(wrapper).trigger('click') // 本地乐观开启
    expect(switchButton(wrapper).attributes('aria-checked')).toBe('true')
    await keyInput(wrapper).setValue('sk-bad')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('请求失败 (HTTP 500)')
    // 保存失败:开关回滚到后端配置值(未保存成功不显示已开启,与状态行文案一致)
    expect(switchButton(wrapper).attributes('aria-checked')).toBe('false')
    expect((keyInput(wrapper).element as HTMLInputElement).value).toBe('sk-bad')
    expect(submitButton(wrapper).text()).toBe('保存')
  })
})
