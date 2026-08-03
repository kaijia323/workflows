<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AgentStore, UiMessage } from '../composables/useAgent'
import MessageBubble from './MessageBubble.vue'

/**
 * 子代理模态窗:完整对话(与主会话同一渲染组件)+ 产物链接。
 * 数据源:实时(sub_* 事件容器)→ 缺失时拉历史(sub JSONL)。
 */
const props = defineProps<{
  agent: AgentStore
  callId: string
  agentName: string
}>()

const emit = defineEmits<{ close: [] }>()

/** 历史回看数据(实时容器缺失时加载) */
const history = ref<UiMessage[] | null>(null)
const historyLoading = ref(false)
const historyError = ref<string | null>(null)

const live = computed(() => props.agent.subSessions.get(props.callId) ?? null)

const messages = computed<UiMessage[]>(() => {
  if (live.value && live.value.messages.length > 0) return live.value.messages
  return history.value ?? []
})

const summary = computed(() => live.value?.summary ?? '')
const artifact = computed(() => live.value?.artifact ?? null)

onMounted(async () => {
  // 有实时容器(哪怕暂无消息)就等流式事件,不拉历史
  if (live.value) return
  historyLoading.value = true
  historyError.value = null
  try {
    history.value = await props.agent.fetchSubHistory(props.callId)
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : String(error)
  } finally {
    historyLoading.value = false
  }
})

function toggleThinking(msg: UiMessage): void {
  msg.thinkingOpen = !msg.thinkingOpen
}

function toggleTool(msg: UiMessage, callId: string): void {
  const tool = msg.segments.find((s) => s.kind === 'tool' && s.callId === callId)
  if (tool && tool.kind === 'tool') tool.collapsed = !tool.collapsed
}
</script>

<template>
  <!-- 遮罩 -->
  <div
    class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/70 p-6 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div class="flex max-h-[85vh] w-full max-w-3xl flex-col border border-edge bg-panel shadow-2xl shadow-black/40">
      <!-- 标题 -->
      <div class="flex shrink-0 items-center gap-3 border-b border-edge px-5 py-3">
        <span class="grid size-4 place-items-center border border-signal/60 bg-signal/10">
          <span class="size-1 bg-signal" />
        </span>
        <span class="font-display text-xs tracking-[0.2em] text-fg">{{ agentName }}</span>
        <span class="truncate font-mono text-[9.5px] text-faint">{{ callId }}</span>
        <span
          class="ml-auto font-mono text-[9px] tracking-wider"
          :class="live?.status === 'running' ? 'text-signal' : live?.status === 'error' ? 'text-err' : 'text-faint'"
        >
          {{ live?.status === 'running' ? '● 运行中' : live?.status === 'error' ? '失败' : '完成' }}
        </span>
        <button
          type="button"
          class="grid size-6 place-items-center border border-edge text-faint transition hover:border-err/60 hover:text-err"
          aria-label="关闭"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <!-- 内容:与主会话同一 MessageBubble 渲染 -->
      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div
          v-if="historyLoading"
          class="py-10 text-center font-mono text-[10px] text-faint"
        >
          加载历史…
        </div>
        <p
          v-else-if="historyError"
          class="py-10 text-center font-mono text-[10px] text-err"
        >
          {{ historyError }}
        </p>
        <div
          v-else-if="messages.length > 0"
          class="mx-auto flex max-w-3xl flex-col gap-4"
        >
          <MessageBubble
            v-for="msg in messages"
            :key="msg.id"
            :message="msg"
            @toggle-thinking="toggleThinking"
            @toggle-tool="toggleTool"
          />
        </div>
        <p
          v-else
          class="py-10 text-center font-mono text-[10px]"
          :class="live?.status === 'running' ? 'text-signal' : live?.status === 'error' ? 'text-err' : 'text-faint'"
        >
          {{ live?.status === 'running' ? '● 运行中,消息即将到达…' : live?.status === 'error' ? '执行失败,未收到任何消息' : '(无消息)' }}
        </p>
      </div>

      <!-- 底部:摘要 + 产物 -->
      <div class="shrink-0 border-t border-edge px-5 py-3">
        <p
          v-if="summary"
          class="text-[11px] leading-relaxed text-dim"
        >
          <span class="font-display text-[9px] tracking-[0.2em] text-faint">摘要 </span>
          {{ summary }}
        </p>
        <p
          v-if="artifact"
          class="mt-1.5 font-mono text-[9.5px] text-faint"
        >
          <span class="tracking-[0.2em]">产物 </span>
          {{ artifact }}
        </p>
      </div>
    </div>
  </div>
</template>
