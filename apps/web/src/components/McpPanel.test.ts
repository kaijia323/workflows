import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStore } from '../composables/useAgent'
import McpPanel from './McpPanel.vue'

/** mock agent store:onMounted 会调 refreshMcp,保存成功后 handleTest 会调 testMcpServer,均须 stub */
function mountPanel(agent?: Partial<AgentStore>) {
  const refreshMcp = vi.fn(async () => {})
  const saveMcpServer = vi.fn(async () => {})
  const testMcpServer = vi.fn(async () => ({ ok: true, tools: [] }))
  const deleteMcpServer = vi.fn(async () => {})
  const store = {
    mcp: ref({ servers: [], status: [] }),
    refreshMcp,
    saveMcpServer,
    testMcpServer,
    deleteMcpServer,
    ...agent,
  } as unknown as AgentStore
  const wrapper = mount(McpPanel, { props: { agent: store } })
  return { wrapper, saveMcpServer, testMcpServer }
}

/** 表单中唯一 textarea 即 env;name/command 为前两个 input */
async function fillBasic(wrapper: ReturnType<typeof mountPanel>['wrapper']) {
  const inputs = wrapper.findAll('input')
  await inputs[0].setValue('demo')
  await inputs[1].setValue('node')
}

describe('McpPanel env 编辑', () => {
  it('列表展示 env 摘要;无 env 的 server 不显示 env 行', async () => {
    const { wrapper } = mountPanel({
      mcp: ref({
        servers: [
          { name: 's1', command: 'node', env: { A: '1', B: 'x y' } },
          { name: 's2', command: 'python' },
        ],
        status: [],
      }),
    })
    await flushPromises()

    expect(wrapper.text()).toContain('env: A=1 B=x y')
    const envLines = wrapper.findAll('p').filter((p) => p.text().startsWith('env: '))
    expect(envLines).toHaveLength(1)
  })

  it('env textarea 解析并透传(值含空格与 =,空行忽略)', async () => {
    const { wrapper, saveMcpServer } = mountPanel()
    await flushPromises()

    await fillBasic(wrapper)
    await wrapper.find('textarea').setValue('A=1\nGREETING=hello world\nURL=https://x?a=1\n\n')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'demo',
        command: 'node',
        env: { A: '1', GREETING: 'hello world', URL: 'https://x?a=1' },
      }),
    )
  })

  it('env 为空时透传 undefined', async () => {
    const { wrapper, saveMcpServer } = mountPanel()
    await flushPromises()

    await fillBasic(wrapper)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(saveMcpServer).toHaveBeenCalledWith(expect.objectContaining({ env: undefined }))
  })

  it('非法行拦截:不发起保存并提示行号', async () => {
    const { wrapper, saveMcpServer } = mountPanel()
    await flushPromises()

    await fillBasic(wrapper)
    await wrapper.find('textarea').setValue('A=1\nBADLINE')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(saveMcpServer).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('env 第 2 行缺少「=」')
  })

  it('@input 编辑后清除 env 错误,修正后可正常提交', async () => {
    const { wrapper, saveMcpServer } = mountPanel()
    await flushPromises()

    await fillBasic(wrapper)
    const textarea = wrapper.find('textarea')
    await textarea.setValue('A=1\nBADLINE')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('env 第 2 行缺少「=」')

    await textarea.setValue('A=1\nB=2')
    await flushPromises()
    expect(wrapper.text()).not.toContain('缺少')

    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(saveMcpServer).toHaveBeenCalledWith(expect.objectContaining({ env: { A: '1', B: '2' } }))
  })

  it('保存成功后清空 env textarea', async () => {
    const { wrapper } = mountPanel()
    await flushPromises()

    await fillBasic(wrapper)
    const textarea = wrapper.find('textarea')
    await textarea.setValue('A=1\nB=2')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })
})
