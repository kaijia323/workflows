import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useModalDialog } from './useModalDialog'

/* eslint-disable vue/one-component-per-file -- 测试 harness:宿主 + 对话框两个最小组件 */

/** 使用 useModalDialog 的最小对话框(render 函数便于构造任意结构) */
const Dialog = defineComponent({
  props: { onClose: { type: Function, required: true } },
  setup(props) {
    const root = ref<HTMLElement | null>(null)
    useModalDialog({
      root,
      onClose: () => props.onClose(),
      ariaLabel: '测试对话框',
      initialFocus: () => root.value?.querySelector<HTMLElement>('#first') ?? null,
    })
    return () =>
      h('div', { ref: root, role: 'dialog', tabindex: '-1' }, [
        h('button', { id: 'first' }, '第一个'),
        h('button', { id: 'second' }, '第二个'),
        h('input', { id: 'third' }),
      ])
  },
})

/** 宿主:触发按钮(焦点还原目标)+ 条件渲染对话框(与触发按钮为兄弟节点) */
const Harness = defineComponent({
  setup() {
    const show = ref(false)
    return () =>
      h('div', null, [
        h('button', { id: 'trigger', onClick: () => (show.value = true) }, '打开'),
        show.value ? h(Dialog, { onClose: () => (show.value = false) }) : null,
      ])
  },
})

async function openDialog(wrapper: ReturnType<typeof mount>) {
  const trigger = wrapper.find('#trigger')
  ;(trigger.element as HTMLElement).focus()
  await trigger.trigger('click')
  await nextTick()
  return trigger
}

function pressTab(shiftKey = false): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
  document.dispatchEvent(ev)
  return ev
}

describe('useModalDialog', () => {
  it('打开后焦点移入对话框(initialFocus 优先聚焦 #first)', async () => {
    const wrapper = mount(Harness, { attachTo: document.body })
    await openDialog(wrapper)
    expect(document.activeElement?.id).toBe('first')
    wrapper.unmount()
  })

  it('打开后背景兄弟节点置 inert(特性守卫:不支持 inert 的环境跳过)', async () => {
    const wrapper = mount(Harness, { attachTo: document.body })
    const trigger = await openDialog(wrapper)
    const triggerEl = trigger.element
    if ('inert' in triggerEl) {
      expect((triggerEl as HTMLElement).inert).toBe(true)
    }
    wrapper.unmount()
  })

  it('Tab 到最后一个控件后循环回首;对话框内 Tab 不拦截', async () => {
    const wrapper = mount(Harness, { attachTo: document.body })
    await openDialog(wrapper)

    // 焦点在末位 input → Tab 应 preventDefault 并回到第一个按钮
    const input = wrapper.find('#third').element as HTMLInputElement
    input.focus()
    const ev = pressTab()
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('first')

    // 焦点在中间按钮 → Tab 不拦截(默认焦点移动交给浏览器)
    const second = wrapper.find('#second').element as HTMLButtonElement
    second.focus()
    const ev2 = pressTab()
    expect(ev2.defaultPrevented).toBe(false)

    wrapper.unmount()
  })

  it('Shift+Tab 从第一个控件反向循环到末位', async () => {
    const wrapper = mount(Harness, { attachTo: document.body })
    await openDialog(wrapper)

    const first = wrapper.find('#first').element as HTMLButtonElement
    first.focus()
    const ev = pressTab(true)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('third')

    wrapper.unmount()
  })

  it('Escape 触发 onClose;卸载后焦点还原到触发元素', async () => {
    const wrapper = mount(Harness, { attachTo: document.body })
    const trigger = await openDialog(wrapper)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()

    // onClose → show=false → Dialog 卸载,焦点还原到触发按钮
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)

    wrapper.unmount()
  })
})
