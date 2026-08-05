<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Plus } from '@lucide/vue'
import type { AgentStore } from '../composables/useAgent'

/**
 * 左栏:工作区(源节点)。选择工作区后,agent 上下文限定在该目录。
 * 添加工作区:点击按钮弹出目录选择器(WorkspacePickerModal,由 App.vue 挂载)。
 * <1100px:侧栏脱离文档流变为左侧抽屉(open 控制滑入/滑出)。
 */
const props = defineProps<{ agent: AgentStore; open: boolean }>()
const emit = defineEmits<{ openPicker: []; selectWorkspace: [] }>()

/** 抽屉根(打开时收焦;关闭时 invisible 不在 a11y 树/Tab 序中) */
const root = ref<HTMLElement | null>(null)
watch(
  () => props.open,
  (open) => {
    if (open) nextTick(() => root.value?.focus())
  },
)

async function handleRemove(id: string) {
  // 后端 DELETE /workspaces/:id 会连同该工作区全部会话历史文件一并删除(不可恢复),
  // 与 SessionSwitcher 删除会话的确认范式一致,明示后果。
  if (!window.confirm('移除工作区后,其会话历史文件将被永久删除,不可恢复。确定移除?')) return
  await props.agent.removeWorkspace(id)
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
</script>

<template>
  <aside
    ref="root"
    tabindex="-1"
    class="flex w-60 shrink-0 flex-col border-r border-hairline bg-canvas max-console:fixed max-console:inset-y-0 max-console:left-0 max-console:z-40 max-console:transition-[translate,visibility]"
    :class="
      props.open
        ? 'max-console:translate-x-0 max-console:visible'
        : 'max-console:-translate-x-full max-console:invisible'
    "
  >
    <!-- 标题 -->
    <div class="flex items-center justify-between px-4 pb-2 pt-3.5">
      <span class="font-display text-[10px] font-semibold tracking-[0.2em] text-mute">工作区 · SOURCE</span>
      <span class="font-mono text-[10px] text-mute">{{ agent.workspaces.value.length }}</span>
    </div>

    <!-- 工作区列表 -->
    <div class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2.5 pb-3">
      <div
        v-if="agent.workspaces.value.length === 0"
        class="mt-6 px-3 text-center"
      >
        <p class="font-display text-xs tracking-wide text-body">
          尚无工作区
        </p>
        <p class="mt-1.5 text-[11px] leading-relaxed text-mute">
          点击下方「添加工作区」,浏览并选择本地目录作为 agent 上下文。
        </p>
      </div>

      <div
        v-for="ws in agent.workspaces.value"
        :key="ws.id"
        class="relative"
      >
        <!-- 选中按钮:点击切换激活工作区 -->
        <button
          type="button"
          class="group block w-full rounded-sm border-l-2 px-3 py-2.5 text-left transition-colors duration-200"
          :class="
            ws.id === agent.activeWorkspaceId.value
              ? 'border-l-primary bg-canvas-soft'
              : 'border-l-transparent hover:bg-canvas-soft/60'
          "
          @click="emit('selectWorkspace'); agent.openWorkspace(ws.id)"
        >
          <div class="flex items-center justify-between gap-2">
            <span
              class="truncate text-[13px] font-medium"
              :class="ws.id === agent.activeWorkspaceId.value ? 'text-ink' : 'text-body group-hover:text-ink'"
            >
              {{ ws.name }}
            </span>
            <span
              class="shrink-0 rounded-full border px-2 py-px font-mono text-[10px]"
              :class="ws.readOnly ? 'border-primary/40 text-primary' : 'border-hairline text-mute'"
            >
              {{ ws.readOnly ? 'RO' : 'RW' }}
            </span>
          </div>
          <p
            class="mt-1 truncate font-mono text-[10px] text-mute"
            :title="ws.path"
          >
            {{ ws.path }}
          </p>
          <p class="mt-0.5 font-mono text-[11px] text-mute">
            添加于 {{ formatDate(ws.createdAt) }}
          </p>
        </button>

        <!-- 常显动作行(不依赖 hover,键盘可达):读写/只读切换 + 移除(带确认) -->
        <div class="mt-1.5 flex gap-1 px-3 pb-1">
          <button
            type="button"
            class="border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary"
            :title="ws.readOnly ? '切换为读写' : '切换为只读'"
            @click="agent.toggleReadOnly(ws.id, !ws.readOnly)"
          >
            {{ ws.readOnly ? '读写' : '只读' }}
          </button>
          <button
            type="button"
            class="border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-body hover:border-err/50 hover:text-err"
            title="移除"
            @click="handleRemove(ws.id)"
          >
            移除
          </button>
        </div>
      </div>
    </div>

    <!-- 添加工作区 -->
    <div class="shrink-0 border-t border-hairline p-3">
      <button
        type="button"
        class="flex w-full items-center justify-center gap-1.5 rounded-sm border border-primary/50 bg-primary/5 px-2.5 py-1.5 font-display text-[11px] tracking-widest text-primary transition hover:bg-primary/10"
        @click="emit('openPicker')"
      >
        <Plus class="size-3.5" />
        添加工作区
      </button>
      <p class="mt-1.5 font-mono text-[10px] leading-relaxed text-mute">
        选择真实存在的目录;agent 上下文限定于此
      </p>
    </div>
  </aside>
</template>
