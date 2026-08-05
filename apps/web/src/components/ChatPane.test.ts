import { flushPromises, mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillInfo } from '@workflows/shared'
import type { AgentStore } from '../composables/useAgent'
import { preparePastedImage } from '../utils/image'
import ChatPane from './ChatPane.vue'

// ---- 粘贴图片:mock 压缩工具模块(jsdom 无 canvas,双层 mock 第二层;真实压缩由浏览器冒烟覆盖) ----
vi.mock('../utils/image', () => ({
  preparePastedImage: vi.fn(async () => ({
    uploadBlob: new Blob(),
    uploadDataUrl: 'data:image/jpeg;base64,AAAA',
    thumbUrl: 'blob:mock-thumb',
  })),
}))

// jsdom 未实现 URL.createObjectURL / revokeObjectURL:stub 为确定性值
URL.createObjectURL = vi.fn(() => 'blob:mock-thumb')
URL.revokeObjectURL = vi.fn()

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
  /** 挂载到 document.body(jsdom 仅在元素已连接时 focus() 才生效,用于焦点断言) */
  attachTo?: boolean
  /** 只读工作区(粘贴图片拒绝场景) */
  readOnly?: boolean
  config?: { model: string; models: Array<{ id: string }>; thinkingLevel: string; thinkingLevels: string[] }
}

function mountPane(options: PaneOptions = {}) {
  const messages = ref<never[]>([])
  const streaming = ref(options.streaming ?? false)
  const activeWorkspaceId = ref<string | null>(options.workspaceId === undefined ? 'ws-1' : options.workspaceId)
  const activeWorkspace = computed(() =>
    activeWorkspaceId.value
      ? { id: activeWorkspaceId.value, path: 'C:\\ws', name: 'ws', readOnly: options.readOnly ?? false, createdAt: 0 }
      : null,
  )
  const skills = ref<SkillInfo[]>(options.skills ?? [])
  const sendMessage = vi.fn(async () => {})
  const uploadImage = vi.fn(async () => 'up-1.png')
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
    config: ref(options.config ?? { model: 'm', models: [], thinkingLevel: 'off', thinkingLevels: [] }),
    subSessions: new Map(),
    run: ref(null),
    sendMessage,
    uploadImage,
    abort: vi.fn(async () => {}),
    dismissGate: vi.fn(),
  } as unknown as AgentStore
  const wrapper = mount(ChatPane, {
    props: { agent, onOpenSettings: () => {} },
    attachTo: options.attachTo ? document.body : undefined,
  })
  return { wrapper, agent, sendMessage, uploadImage, skills, activeWorkspaceId }
}

describe('ChatPane / 模型与思考级别按压状态', () => {
  it('MODEL/THINK 按钮 aria-pressed 标记当前激活项;容器带 role=group', async () => {
    const { wrapper } = mountPane({
      config: {
        model: 'deepseek-v4-pro',
        models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
        thinkingLevel: 'high',
        thinkingLevels: ['off', 'high', 'max'],
      },
    })

    const modelGroup = wrapper.find('[aria-label="模型选择"]')
    const thinkGroup = wrapper.find('[aria-label="思考级别"]')
    expect(modelGroup.attributes('role')).toBe('group')
    expect(thinkGroup.attributes('role')).toBe('group')

    const modelBtns = modelGroup.findAll('button')
    const thinkBtns = thinkGroup.findAll('button')
    expect(modelBtns).toHaveLength(2)
    expect(thinkBtns).toHaveLength(3)

    // 激活项 aria-pressed=true,其余 false
    expect(modelBtns[0].attributes('aria-pressed')).toBe('false')
    expect(modelBtns[1].attributes('aria-pressed')).toBe('true')
    expect(thinkBtns[0].attributes('aria-pressed')).toBe('false')
    expect(thinkBtns[1].attributes('aria-pressed')).toBe('true')
    expect(thinkBtns[2].attributes('aria-pressed')).toBe('false')
  })
})

describe('ChatPane / skill 搜索下拉', () => {
  it('combobox 语义:listbox/option 存在,aria-activedescendant 随方向键移动', async () => {
    const { wrapper } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    // 输入框带 combobox 契约;未打开时无展开态
    expect(textarea.attributes('role')).toBe('combobox')
    expect(textarea.attributes('aria-autocomplete')).toBe('list')
    expect(textarea.attributes('aria-controls')).toBe('skill-listbox')
    expect(textarea.attributes('aria-expanded')).toBe('false')

    await textarea.setValue('/')
    await flushPromises()

    const listbox = wrapper.find('[role="listbox"]')
    expect(listbox.exists()).toBe(true)
    expect(listbox.attributes('id')).toBe('skill-listbox')
    expect(textarea.attributes('aria-expanded')).toBe('true')

    const options = wrapper.findAll('[role="option"]')
    expect(options).toHaveLength(4)
    // 初始高亮第 0 项:aria-selected + activedescendant 一致
    expect(options[0].attributes('id')).toBe('skill-opt-0')
    expect(options[0].attributes('aria-selected')).toBe('true')
    expect(options[1].attributes('aria-selected')).toBe('false')
    expect(textarea.attributes('aria-activedescendant')).toBe('skill-opt-0')

    // ArrowDown → 高亮随动
    await textarea.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(textarea.attributes('aria-activedescendant')).toBe('skill-opt-1')
    expect(options[1].attributes('aria-selected')).toBe('true')
    expect(options[0].attributes('aria-selected')).toBe('false')

    // Esc 关闭:展开态清除,activedescendant 移除
    await textarea.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(textarea.attributes('aria-expanded')).toBe('false')
    expect(textarea.attributes('aria-activedescendant')).toBeUndefined()
  })

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

  it('Tab 选中当前高亮 skill 填入 /skill:<name>,preventDefault 且焦点不丢失', async () => {
    const { wrapper, sendMessage } = mountPane({ skills: SKILLS, attachTo: true })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()
    await textarea.trigger('keydown', { key: 'ArrowDown' }) // 高亮 → summarize(索引 1)
    await textarea.trigger('keydown', { key: 'Tab' })
    await flushPromises()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('/skill:summarize ')
    expect(sendMessage).not.toHaveBeenCalled()
    // 菜单关闭
    expect(wrapper.text()).not.toContain('/skill:greet')
    // 焦点仍在输入框(未因 Tab 移出)
    expect(document.activeElement).toBe(textarea.element)

    // 下拉打开时 Tab 触发 preventDefault
    await textarea.setValue('/')
    await flushPromises()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true })
    textarea.element.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)

    wrapper.unmount()
  })

  it('下拉未打开时 Tab 不拦截(保持浏览器默认焦点移动)', async () => {
    const { wrapper, sendMessage } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('hello')
    await flushPromises()

    const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true })
    textarea.element.dispatchEvent(ev)

    expect(ev.defaultPrevented).toBe(false)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('hello')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('IME 组合输入中 Tab 不触发选择', async () => {
    const { wrapper } = mountPane({ skills: SKILLS })
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/')
    await flushPromises()
    expect(wrapper.text()).toContain('/skill:greet')

    const ev = new KeyboardEvent('keydown', { key: 'Tab', isComposing: true, cancelable: true, bubbles: true })
    textarea.element.dispatchEvent(ev)
    await flushPromises()

    expect(ev.defaultPrevented).toBe(false)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('/')
    expect(wrapper.text()).toContain('/skill:greet') // 菜单保持打开
  })

  it('占位符提示 / 可搜索 skills;无工作区时保持原提示', async () => {
    const { wrapper } = mountPane({ workspaceId: 'ws-1' })
    expect(wrapper.find('textarea').attributes('placeholder')).toContain('/ 可搜索 skills')

    const noWs = mountPane({ workspaceId: null })
    expect(noWs.wrapper.find('textarea').attributes('placeholder')).toBe('先在左侧选择一个工作区')
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
    // 无图时第二参数为 undefined(sendMessage(text, images?) 新增可选参数,决策 6)
    expect(sendMessage).toHaveBeenCalledWith('/skill:nope', undefined)
  })
})

describe('ChatPane / 粘贴图片缩略图(compressorjs 压缩已 mock)', () => {
  beforeEach(() => {
    vi.mocked(preparePastedImage).mockClear()
    vi.mocked(URL.createObjectURL).mockClear()
    vi.mocked(URL.revokeObjectURL).mockClear()
  })

  /** 构造带 clipboardData.items 的 paste 事件并派发到 textarea */
  function paste(wrapper: ReturnType<typeof mountPane>['wrapper'], files: File[]) {
    const items = files.map((f) => ({ type: f.type, getAsFile: () => f }))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items }, configurable: true })
    wrapper.find('textarea').element.dispatchEvent(event)
  }

  function imageFile(name = 'shot.png'): File {
    return new File(['img-bytes'], name, { type: 'image/png' })
  }

  it('paste 图片 → preparePastedImage 被调用,缩略图条出现(数量 + 体积提示)', async () => {
    const { wrapper } = mountPane()
    paste(wrapper, [imageFile()])
    await flushPromises()

    expect(preparePastedImage).toHaveBeenCalledTimes(1)
    expect(preparePastedImage).toHaveBeenCalledWith(expect.any(File))
    const bar = wrapper.find('[aria-label="删除图片"]')
    expect(bar.exists()).toBe(true)
    expect(wrapper.find('img[src="blob:mock-thumb"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('1/8 张')
    expect(wrapper.text()).toContain('KB')
  })

  it('非图片粘贴(文本)不影响输入:preparePastedImage 不被调用,无缩略图', async () => {
    const { wrapper } = mountPane()
    paste(wrapper, [new File(['text'], 'a.txt', { type: 'text/plain' })])
    await flushPromises()

    expect(preparePastedImage).not.toHaveBeenCalled()
    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(false)
  })

  it('删除按钮移除缩略图并 revoke objectURL', async () => {
    const { wrapper } = mountPane()
    paste(wrapper, [imageFile()])
    await flushPromises()
    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(true)

    await wrapper.find('[aria-label="删除图片"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-thumb')
  })

  it('>8 张拒绝并提示,不进入待发队列', async () => {
    const { wrapper } = mountPane()
    paste(wrapper, Array.from({ length: 9 }, () => imageFile()))
    await flushPromises()

    expect(wrapper.text()).toContain('最多同时发送 8 张图片')
    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(false)
    expect(preparePastedImage).not.toHaveBeenCalled()
  })

  it('纯图发送(空 draft + 1 张图):上传 → sendMessage([图片: path] + images)', async () => {
    const { wrapper, uploadImage, sendMessage } = mountPane()
    paste(wrapper, [imageFile()])
    await flushPromises()

    const sendBtn = wrapper.findAll('button').find((b) => b.text() === '发送')
    expect(sendBtn?.attributes('disabled')).toBeUndefined() // 纯图可发送(风险 7)

    await sendBtn?.trigger('click')
    await flushPromises()

    expect(uploadImage).toHaveBeenCalledWith('data:image/jpeg;base64,AAAA')
    expect(sendMessage).toHaveBeenCalledWith('[图片: up-1.png]', [{ path: 'up-1.png', thumb: 'blob:mock-thumb' }])
    // 发送成功后清空待发队列并 revoke
    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-thumb')
  })

  it('带文本发送:文本拼在 [图片: path] 之后', async () => {
    const { wrapper, sendMessage } = mountPane()
    paste(wrapper, [imageFile()])
    await flushPromises()
    await wrapper.find('textarea').setValue('请分析这张截图')
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text() === '发送')?.trigger('click')
    await flushPromises()

    expect(sendMessage).toHaveBeenCalledWith('[图片: up-1.png] 请分析这张截图', [
      { path: 'up-1.png', thumb: 'blob:mock-thumb' },
    ])
  })

  it('上传失败:sendError 提示、待发图片保留(标 error)、sendMessage 不调用', async () => {
    const { wrapper, uploadImage, sendMessage } = mountPane()
    uploadImage.mockRejectedValueOnce(new Error('boom'))
    paste(wrapper, [imageFile()])
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text() === '发送')?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('图片上传失败:boom')
    expect(sendMessage).not.toHaveBeenCalled()
    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(true) // 保留可删除重试
  })

  it('双击锁:上传进行中再次触发发送(按钮 / 回车)不重复上传与发送', async () => {
    const { wrapper, uploadImage, sendMessage } = mountPane()
    let resolveUpload!: (path: string) => void
    uploadImage.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveUpload = resolve }))
    paste(wrapper, [imageFile()])
    await flushPromises()

    const sendBtn = wrapper.findAll('button').find((b) => b.text() === '发送')
    await sendBtn?.trigger('click')
    // 上传未完成:再次点击 + 回车均被 in-flight 锁拦截
    await sendBtn?.trigger('click')
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(uploadImage).toHaveBeenCalledTimes(1)
    expect(sendMessage).not.toHaveBeenCalled()
    // 上传期间发送按钮禁用(与既有 disabled 风格一致)
    expect(wrapper.findAll('button').find((b) => b.text() === '发送')?.attributes('disabled')).toBeDefined()

    resolveUpload('up-1.png')
    await flushPromises()
    await flushPromises()
    // 锁释放后只发送一次
    expect(uploadImage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('[图片: up-1.png]', [{ path: 'up-1.png', thumb: 'blob:mock-thumb' }])
  })

  it('压缩失败项阻止发送并提示,不触发上传(避免误导性 400)', async () => {
    const { wrapper, uploadImage, sendMessage } = mountPane()
    vi.mocked(preparePastedImage).mockRejectedValueOnce(new Error('compress boom'))
    paste(wrapper, [imageFile()])
    await flushPromises()

    // 压缩失败项以 error 态入列:无缩略图 img,显示失败占位(!)
    expect(wrapper.findAll('img')).toHaveLength(0)
    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(true)

    await wrapper.findAll('button').find((b) => b.text() === '发送')?.trigger('click')
    await flushPromises()

    expect(uploadImage).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('存在压缩失败的图片,请删除后重试')
  })

  it('sendMessage 失败:恢复输入草稿与待发图片;重试复用已上传 path 不重复上传', async () => {
    const { wrapper, uploadImage, sendMessage } = mountPane()
    sendMessage.mockRejectedValueOnce(new Error('network down'))
    paste(wrapper, [imageFile()])
    await flushPromises()
    await wrapper.find('textarea').setValue('请分析这张截图')
    await flushPromises()

    await wrapper.findAll('button').find((b) => b.text() === '发送')?.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('network down')
    // 输入草稿恢复(不再丢失)
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('请分析这张截图')
    // 待发图片保留(可重试)
    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(true)
    expect(uploadImage).toHaveBeenCalledTimes(1)

    // 重试:已上传成功的项直接复用 path,不重复上传;消息发送成功
    await wrapper.findAll('button').find((b) => b.text() === '发送')?.trigger('click')
    await flushPromises()
    expect(uploadImage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenLastCalledWith('[图片: up-1.png] 请分析这张截图', [
      { path: 'up-1.png', thumb: 'blob:mock-thumb' },
    ])
  })

  it('只读工作区粘贴:拒绝并提示,无缩略图,不调用压缩', async () => {
    const { wrapper } = mountPane({ readOnly: true })
    paste(wrapper, [imageFile()])
    await flushPromises()

    expect(wrapper.text()).toContain('只读工作区不支持粘贴图片')
    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(false)
    expect(preparePastedImage).not.toHaveBeenCalled()
  })

  it('切工作区清空待发图片并 revoke', async () => {
    const { wrapper, activeWorkspaceId } = mountPane()
    paste(wrapper, [imageFile()])
    await flushPromises()
    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(true)

    activeWorkspaceId.value = 'ws-2'
    await flushPromises()

    expect(wrapper.find('[aria-label="删除图片"]').exists()).toBe(false)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-thumb')
  })
})
