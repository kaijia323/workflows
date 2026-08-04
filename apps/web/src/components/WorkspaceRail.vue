<script setup lang="ts">
import { Plus } from '@lucide/vue'
import type { AgentStore } from '../composables/useAgent'

/**
 * 左栏:工作区(源节点)。选择工作区后,agent 上下文限定在该目录。
 * 添加工作区:点击按钮弹出目录选择器(WorkspacePickerModal,由 App.vue 挂载)。
 */
const props = defineProps<{ agent: AgentStore }>()
const emit = defineEmits<{ openPicker: [] }>()

async function handleRemove(id: string) {
  await props.agent.removeWorkspace(id)
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
</script>

<template>
  <aside class="flex w-60 shrink-0 flex-col border-r border-hairline bg-canvas">
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

      <button
        v-for="ws in agent.workspaces.value"
        :key="ws.id"
        type="button"
        class="group relative block w-full rounded-sm border-l-2 px-3 py-2.5 text-left transition-colors duration-200"
        :class="
          ws.id === agent.activeWorkspaceId.value
            ? 'border-l-primary bg-canvas-soft'
            : 'border-l-transparent hover:bg-canvas-soft/60'
        "
        @click="agent.openWorkspace(ws.id)"
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
        <p class="mt-0.5 font-mono text-[10px] text-mute/70">
          添加于 {{ formatDate(ws.createdAt) }}
        </p>

        <!-- hover 操作 -->
        <div class="absolute right-2 top-2 hidden gap-1 group-hover:flex">
          <button
            type="button"
            class="border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary"
            :title="ws.readOnly ? '切换为读写' : '切换为只读'"
            @click.stop="agent.toggleReadOnly(ws.id, !ws.readOnly)"
          >
            {{ ws.readOnly ? '读写' : '只读' }}
          </button>
          <button
            type="button"
            class="border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-body hover:border-err/50 hover:text-err"
            title="移除"
            @click.stop="handleRemove(ws.id)"
          >
            移除
          </button>
        </div>
      </button>
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
