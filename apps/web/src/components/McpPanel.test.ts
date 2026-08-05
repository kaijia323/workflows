import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@workflows/shared'
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

/** 构造 server 配置(测试工厂):name 必填,command 默认 'node' */
function makeServer(overrides: Partial<McpServerConfig> & { name: string }): McpServerConfig {
  return { command: 'node', args: [], enabled: false, ...overrides }
}

/** 点击指定 server 的「编辑」按钮(data-testid 精确定位) */
async function clickEdit(wrapper: ReturnType<typeof mountPanel>['wrapper'], name: string) {
  await wrapper.find(`[data-testid="edit-${name}"]`).trigger('click')
}

/**
 * 填表单内输入(避开列表里的 checkbox):
 * form 内 input 依次为 name[0]/command[1]/args[2];env 用唯一 textarea。
 * 编辑态 name 只读,不提供 name 参数。
 */
async function setForm(
  wrapper: ReturnType<typeof mountPanel>['wrapper'],
  values: { command?: string; args?: string; env?: string } = {},
) {
  const inputs = wrapper.find('form').findAll('input')
  if (values.command !== undefined) await inputs[1].setValue(values.command)
  if (values.args !== undefined) await inputs[2].setValue(values.args)
  if (values.env !== undefined) await wrapper.find('textarea').setValue(values.env)
}

/** 取表单提交按钮(按文本) */
function submitButton(wrapper: ReturnType<typeof mountPanel>['wrapper']) {
  return wrapper.findAll('button').find((b) => b.text().includes('添加') || b.text().includes('保存'))
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

describe('McpPanel 编辑已有 server', () => {
  it('每条目渲染「编辑」按钮;空列表不渲染', async () => {
    const { wrapper } = mountPanel({
      mcp: ref({
        servers: [makeServer({ name: 's1' }), makeServer({ name: 's2', command: 'python' })],
        status: [],
      }),
    })
    await flushPromises()

    const editS1 = wrapper.find('[data-testid="edit-s1"]')
    const editS2 = wrapper.find('[data-testid="edit-s2"]')
    expect(editS1.exists()).toBe(true)
    expect(editS2.exists()).toBe(true)
    expect(editS1.text()).toContain('编辑')
    expect(editS2.text()).toContain('编辑')

    const { wrapper: emptyWrapper } = mountPanel()
    await flushPromises()
    expect(emptyWrapper.findAll('[data-testid^="edit-"]')).toHaveLength(0)
  })

  it('startEdit 回填表单(name/command/args/env)+ 编辑态 UI 联动', async () => {
    const { wrapper } = mountPanel({
      mcp: ref({
        servers: [makeServer({ name: 's1', command: 'node', args: ['-y', '@x/y'], env: { A: '1' } })],
        status: [],
      }),
    })
    await flushPromises()

    await clickEdit(wrapper, 's1')

    const inputs = wrapper.find('form').findAll('input')
    expect((inputs[0].element as HTMLInputElement).value).toBe('s1')
    expect((inputs[1].element as HTMLInputElement).value).toBe('node')
    expect((inputs[2].element as HTMLInputElement).value).toBe('-y @x/y')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('A=1')
    expect(wrapper.text()).toContain('编辑 server: s1')
    expect(submitButton(wrapper)!.text()).toBe('保存修改')
    expect(wrapper.text()).toContain('编辑覆盖保存到 mcp.json')
    expect(wrapper.find('[data-testid="cancel-edit"]').exists()).toBe(true)
  })

  it('env 回填往返:含空格与 = 的值逐字还原并原样保存', async () => {
    const { wrapper, saveMcpServer } = mountPanel({
      mcp: ref({
        servers: [
          makeServer({ name: 's1', env: { A: '1', GREETING: 'hello world', URL: 'https://x?a=1' } }),
        ],
        status: [],
      }),
    })
    await flushPromises()

    await clickEdit(wrapper, 's1')
    const textarea = wrapper.find('textarea')
    expect((textarea.element as HTMLTextAreaElement).value).toBe('A=1\nGREETING=hello world\nURL=https://x?a=1')

    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { A: '1', GREETING: 'hello world', URL: 'https://x?a=1' },
      }),
    )
  })

  it('编辑保存覆盖 command/args/env,enabled 透传原值(true 不变 false)', async () => {
    const { wrapper, saveMcpServer } = mountPanel({
      mcp: ref({
        servers: [makeServer({ name: 's1', enabled: true, args: ['old'], env: { OLD: '1' } })],
        status: [],
      }),
    })
    await flushPromises()

    await clickEdit(wrapper, 's1')
    await setForm(wrapper, { command: 'python', args: 'new', env: 'NEW=2' })
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(saveMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 's1',
        command: 'python',
        args: ['new'],
        enabled: true,
        env: { NEW: '2' },
      }),
    )
  })

  it('取消编辑:表单清空、退出编辑态、无 saved 残留', async () => {
    const { wrapper } = mountPanel({
      mcp: ref({
        servers: [makeServer({ name: 's1', env: { A: '1' } })],
        status: [],
      }),
    })
    await flushPromises()

    await clickEdit(wrapper, 's1')
    await setForm(wrapper, { env: 'X=1' })
    await wrapper.find('[data-testid="cancel-edit"]').trigger('click')

    const inputs = wrapper.find('form').findAll('input')
    for (const input of inputs) {
      expect((input.element as HTMLInputElement).value).toBe('')
    }
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('')
    expect(submitButton(wrapper)!.text()).toBe('添加并测试')
    expect(wrapper.text()).toContain('新增默认不启用(opt-in)')
    expect(wrapper.find('[data-testid="cancel-edit"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('已保存到 mcp.json')
    expect(wrapper.text()).not.toContain('编辑 server:')
  })

  it('编辑态 name input 只读(值不可变)', async () => {
    const { wrapper } = mountPanel({
      mcp: ref({
        servers: [makeServer({ name: 's1' })],
        status: [],
      }),
    })
    await flushPromises()

    await clickEdit(wrapper, 's1')
    const nameInput = wrapper.find('form').findAll('input')[0]
    expect((nameInput.element as HTMLInputElement).readOnly).toBe(true)
    expect((nameInput.element as HTMLInputElement).value).toBe('s1')
    // setValue 直接写 DOM 并触发 input 事件(测试工具无法模拟 readonly 的用户输入限制);
    // 组件在编辑态忽略 name 的 input 事件,强制重渲染后 DOM 应回到 's1' 而非 'renamed'
    await nameInput.setValue('renamed')
    wrapper.vm.$forceUpdate()
    await nextTick()
    expect((nameInput.element as HTMLInputElement).value).toBe('s1')
  })

  it('编辑态 env 非法行仍零容忍拦截(不发请求、保持编辑态)', async () => {
    const { wrapper, saveMcpServer } = mountPanel({
      mcp: ref({
        servers: [makeServer({ name: 's1' })],
        status: [],
      }),
    })
    await flushPromises()

    await clickEdit(wrapper, 's1')
    await wrapper.find('textarea').setValue('A=1\nBAD')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(saveMcpServer).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('env 第 2 行缺少「=」')
    expect(submitButton(wrapper)!.text()).toBe('保存修改')
    expect(wrapper.find('[data-testid="cancel-edit"]').exists()).toBe(true)
  })

  it('编辑保存成功后:表单清空、退出编辑态、显示已保存', async () => {
    const { wrapper } = mountPanel({
      mcp: ref({
        servers: [makeServer({ name: 's1', env: { A: '1' } })],
        status: [],
      }),
    })
    await flushPromises()

    await clickEdit(wrapper, 's1')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const inputs = wrapper.find('form').findAll('input')
    for (const input of inputs) {
      expect((input.element as HTMLInputElement).value).toBe('')
    }
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('')
    expect(submitButton(wrapper)!.text()).toBe('添加并测试')
    expect(wrapper.find('[data-testid="cancel-edit"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('已保存到 mcp.json')
    expect(wrapper.text()).not.toContain('编辑 server:')
  })

  it('编辑过程不影响列表展示(env 摘要/名称/命令不变)', async () => {
    const { wrapper } = mountPanel({
      mcp: ref({
        servers: [makeServer({ name: 's1', env: { A: '1', B: 'x y' } })],
        status: [],
      }),
    })
    await flushPromises()

    expect(wrapper.text()).toContain('env: A=1 B=x y')

    await clickEdit(wrapper, 's1')
    await wrapper.find('textarea').setValue('C=3')

    expect(wrapper.text()).toContain('env: A=1 B=x y')
    expect(wrapper.text()).toContain('s1')
    expect(wrapper.text()).toContain('node')
  })

  it('编辑中切换目标:先复位再回填,无旧值残留', async () => {
    const { wrapper } = mountPanel({
      mcp: ref({
        servers: [
          makeServer({ name: 's1', env: { A: '1' } }),
          makeServer({ name: 's2', command: 'python', args: ['-y'], env: { B: '2' } }),
        ],
        status: [],
      }),
    })
    await flushPromises()

    await clickEdit(wrapper, 's1')
    await clickEdit(wrapper, 's2')

    const inputs = wrapper.find('form').findAll('input')
    expect((inputs[0].element as HTMLInputElement).value).toBe('s2')
    expect((inputs[1].element as HTMLInputElement).value).toBe('python')
    expect((inputs[2].element as HTMLInputElement).value).toBe('-y')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('B=2')
    expect(wrapper.text()).toContain('编辑 server: s2')
    expect(wrapper.text()).not.toContain('编辑 server: s1')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).not.toContain('A=1')
  })

  it('原 server 无 env:回填为空,保存传 env: undefined', async () => {
    const { wrapper, saveMcpServer } = mountPanel({
      mcp: ref({
        servers: [makeServer({ name: 's1' })],
        status: [],
      }),
    })
    await flushPromises()

    await clickEdit(wrapper, 's1')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('')

    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(saveMcpServer).toHaveBeenCalledWith(expect.objectContaining({ env: undefined }))
  })
})
