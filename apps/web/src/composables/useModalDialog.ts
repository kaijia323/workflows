import { onBeforeUnmount, onMounted } from 'vue'
import type { Ref } from 'vue'

/** root 内可聚焦元素(与浏览器默认 Tab 顺序一致,排除 disabled 与 tabindex=-1) */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface UseModalDialogOptions {
  /** 模态窗根元素(遮罩 div,模板上带 role="dialog" tabindex="-1") */
  root: Ref<HTMLElement | null>
  /** 关闭回调(Escape 触发) */
  onClose: () => void
  /** 对话框可访问名称(同时写入 root 的 aria-label,与模板属性幂等) */
  ariaLabel: string
  /** 打开后优先聚焦的元素;缺省聚焦 root 自身 */
  initialFocus?: () => HTMLElement | null
}

/**
 * 模态窗对话框契约:打开时保存焦点目标 + 背景兄弟节点 inert + 移焦入内,
 * Tab/Shift+Tab 在 root 内循环(trap),Escape 关闭,卸载后焦点还原。
 *
 * 三个模态窗(ApiKeyModal / WorkspacePickerModal / SubAgentModal)均为
 * App.vue 根 div 的直接子节点,故「对 root.parentElement 的兄弟子节点设
 * inert」方案天然成立,无需 Teleport。
 */
export function useModalDialog({ root, onClose, ariaLabel, initialFocus }: UseModalDialogOptions): void {
  /** 打开前的焦点目标(关闭后还原) */
  let restoreTarget: Element | null = null
  /** 打开期间被置 inert 的背景兄弟节点(卸载时还原) */
  let inertSiblings: Element[] = []

  function focusableElements(): HTMLElement[] {
    const el = root.value
    if (!el) return []
    return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
  }

  function onKeydown(event: KeyboardEvent): void {
    // bubble 阶段监听 + defaultPrevented 短路:WorkspacePicker 输入框的 Tab
    // 补全在元素自身阶段已 preventDefault,此处直接放行,避免与焦点 trap 冲突。
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusables = focusableElements()
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    // 焦点在对话框外(不应发生,背景已 inert)或处于首/末位 → 循环 trap
    if (event.shiftKey) {
      if (active === first || !root.value?.contains(active)) {
        event.preventDefault()
        last.focus()
      }
    } else if (active === last || !root.value?.contains(active)) {
      event.preventDefault()
      first.focus()
    }
  }

  onMounted(() => {
    restoreTarget = document.activeElement
    const parent = root.value?.parentElement
    if (parent) {
      inertSiblings = Array.from(parent.children).filter((el) => el !== root.value)
      for (const el of inertSiblings) {
        // 特性守卫:2023 年前的浏览器不支持 inert,仅降级(焦点 trap 仍生效),不报错
        if ('inert' in el) (el as HTMLElement).inert = true
      }
    }
    root.value?.setAttribute('aria-label', ariaLabel)
    root.value?.focus()
    initialFocus?.()?.focus()
    document.addEventListener('keydown', onKeydown)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown)
    for (const el of inertSiblings) {
      if ('inert' in el) (el as HTMLElement).inert = false
    }
    inertSiblings = []
    // 焦点还原:触发按钮可能已随 v-if 卸载,仅当目标仍连接时还原
    if (restoreTarget instanceof HTMLElement && restoreTarget.isConnected) {
      restoreTarget.focus()
    }
    restoreTarget = null
  })
}
