<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronDown, Plus, X } from '@lucide/vue'
import type { AgentStore } from '../composables/useAgent'

/**
 * 会话切换器:一个工作区可含多个持久化会话,这里负责
 * 切换 / 新建 / 删除。新建会话保留旧会话(JSONL 不动)。
 */
const props = defineProps<{ agent: AgentStore }>()

const open = ref(false)
const error = ref<string | null>(null)
const root = ref<HTMLElement | null>(null)

const sessions = computed(() => props.agent.sessionList.value?.sessions ?? [])
const activeId = computed(() => props.agent.sessionList.value?.activeSessionId ?? null)
const active = computed(() => sessions.value.find((s) => s.id === activeId.value))

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function handleSwitch(id: string) {
  if (id === activeId.value) {
    open.value = false
    return
  }
  error.value = null
  try {
    await props.agent.switchSession(id)
    open.value = false
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function handleNew() {
  error.value = null
  try {
    await props.agent.newSession()
    open.value = false
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function handleDelete(id: string) {
  if (!window.confirm('删除后该会话的历史文件将被移除,不可恢复。确定?')) return
  error.value = null
  try {
    await props.agent.deleteSession(id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function onDocClick(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    ref="root"
    class="relative"
  >
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-sm border border-hairline px-2 py-1 font-mono text-[10px] text-body transition hover:border-primary/50 hover:text-primary"
      title="会话管理(切换 / 新建 / 删除)"
      @click="open = !open"
    >
      <span class="size-1.5 border border-mute/60 bg-mute/30" />
      {{ active ? formatTime(active.createdAt) : '新建会话' }}
      <ChevronDown class="size-3 text-mute" />
    </button>

    <div
      v-if="open"
      class="absolute right-0 top-full z-20 mt-1.5 w-60 rounded-md border border-hairline bg-canvas shadow-modal"
    >
      <div class="flex items-center justify-between border-b border-hairline px-3 py-1.5">
        <span class="font-display text-[10px] tracking-[0.2em] text-mute">会话 · SESSIONS</span>
        <span class="font-mono text-[10px] text-mute">{{ sessions.length }}</span>
      </div>

      <div class="max-h-60 overflow-y-auto">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="flex items-center border-b border-hairline/60 transition-colors last:border-b-0"
          :class="s.id === activeId ? 'bg-primary/[0.06]' : 'hover:bg-canvas-soft'"
        >
          <button
            type="button"
            class="min-w-0 flex-1 px-3 py-2 text-left"
            @click="handleSwitch(s.id)"
          >
            <span
              class="block font-mono text-[10px]"
              :class="s.id === activeId ? 'text-primary' : 'text-ink'"
            >
              {{ formatTime(s.createdAt) }}
            </span>
            <span class="mt-0.5 block font-mono text-[10px] text-mute">{{ s.messageCount }} msgs</span>
          </button>
          <span
            v-if="s.id === activeId"
            class="size-1 shrink-0 bg-primary"
          />
          <button
            type="button"
            class="shrink-0 px-2.5 py-2 font-mono text-[12px] leading-none text-mute transition hover:text-err"
            title="删除会话(历史文件一并移除)"
            @click="handleDelete(s.id)"
          >
            <X class="size-3.5" />
          </button>
        </div>
        <p
          v-if="sessions.length === 0"
          class="px-3 py-3 font-mono text-[10px] text-mute"
        >
          暂无会话,新建后开始
        </p>
      </div>

      <button
        type="button"
        class="flex w-full items-center gap-1.5 border-t border-hairline px-3 py-2 text-left font-display text-[10px] tracking-widest text-primary transition hover:bg-primary/10"
        @click="handleNew"
      >
        <Plus class="size-3" />
        新建会话
      </button>

      <p
        v-if="error"
        class="border-t border-hairline px-3 py-1.5 font-mono text-[10px] text-err"
      >
        {{ error }}
      </p>
    </div>
  </div>
</template>
