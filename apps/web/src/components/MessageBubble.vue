<script setup lang="ts">
import { computed } from 'vue'
import type { UiMessage } from '../composables/useAgent'
import { toolLabel } from '../composables/useAgent'

const props = defineProps<{ message: UiMessage }>()
const emit = defineEmits<{
  'toggle-thinking': [message: UiMessage]
  'toggle-tool': [message: UiMessage, callId: string]
}>()

const hasContent = computed(() => {
  const m = props.message
  return m.text.length > 0 || m.thinking.length > 0 || m.tools.length > 0
})

function formatTokens(n: number | undefined): string {
  if (n === undefined) return ''
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
</script>

<template>
  <!-- 用户消息:右对齐 -->
  <div
    v-if="message.role === 'user'"
    class="flex justify-end pl-12"
  >
    <div class="max-w-[85%] border border-signal/30 bg-signal/[0.05] px-3.5 py-2.5">
      <p class="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
        {{ message.text }}
      </p>
    </div>
  </div>

  <!-- 助手消息:节点卡 + 入边(端口) -->
  <div
    v-else
    class="relative flex pl-7"
  >
    <!-- 入边:从上方端口下来的竖线 -->
    <div class="absolute left-2.5 top-0 h-full w-px bg-edge">
      <span class="absolute -left-[3px] top-1.5 size-[7px] border border-signal/60 bg-ink" />
    </div>

    <div
      class="min-w-0 max-w-full flex-1 border bg-raised/60 transition-colors"
      :class="message.status === 'error' ? 'border-err/40' : 'border-edge'"
    >
      <!-- 思考区 -->
      <div
        v-if="message.thinking"
        class="border-b border-edge/70"
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3.5 py-1.5 text-left font-mono text-[10px] tracking-wider text-wire transition hover:bg-wire/[0.06]"
          @click="emit('toggle-thinking', message)"
        >
          <span
            class="inline-block w-3 text-center transition-transform duration-200"
            :class="message.thinkingOpen ? 'rotate-90' : ''"
          >▸</span>
          <span class="text-wire/80">THINKING</span>
          <span class="ml-auto font-mono text-[9px] text-faint">{{ message.thinking.length }} chars</span>
        </button>
        <pre
          v-if="message.thinkingOpen"
          class="max-h-64 overflow-y-auto whitespace-pre-wrap break-words px-3.5 pb-3 pl-8 font-mono text-[11px] leading-relaxed text-wire/70"
        >{{ message.thinking }}</pre>
      </div>

      <!-- 正文 -->
      <div
        v-if="hasContent"
        class="px-3.5 py-3"
      >
        <p class="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
          {{ message.text }}<span
            v-if="message.status === 'streaming'"
            class="caret"
          />
        </p>
        <p
          v-if="message.status === 'error' && message.errorText"
          class="mt-2 font-mono text-[11px] text-err"
        >
          ⚠ {{ message.errorText }}
        </p>
      </div>
      <div
        v-else-if="message.status === 'streaming'"
        class="px-3.5 py-3"
      >
        <span class="caret" />
      </div>

      <!-- 工具调用(边):每行一个工具 + 输出 -->
      <div
        v-if="message.tools.length > 0"
        class="border-t border-edge/70"
      >
        <div
          v-for="tool in message.tools"
          :key="tool.callId"
          class="border-b border-edge/40 last:border-b-0"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3.5 py-1.5 text-left transition hover:bg-ink/40"
            @click="emit('toggle-tool', message, tool.callId)"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="tool.isError ? 'bg-err' : 'bg-ok'"
            />
            <span class="font-display text-[10px] tracking-widest text-dim">{{ toolLabel(tool.name) }}</span>
            <span class="truncate font-mono text-[10px] text-faint">{{ tool.name }}</span>
            <span
              class="ml-auto inline-block w-3 text-center font-mono text-[10px] text-faint transition-transform duration-200"
              :class="tool.collapsed ? '' : 'rotate-90'"
            >▸</span>
          </button>
          <pre
            v-if="!tool.collapsed && tool.output"
            class="max-h-56 overflow-y-auto whitespace-pre-wrap break-words border-t border-edge/40 bg-ink/60 px-3.5 py-2.5 pl-7 font-mono text-[10.5px] leading-relaxed"
            :class="tool.isError ? 'text-err/90' : 'text-dim'"
          >{{ tool.output }}</pre>
        </div>
      </div>

      <!-- 页脚:模型 + token -->
      <div
        v-if="message.model || message.usage?.totalTokens"
        class="flex items-center gap-3 px-3.5 py-1.5 font-mono text-[9px] text-faint"
      >
        <span
          v-if="message.model"
          class="tracking-wider"
        >{{ message.model }}</span>
        <span v-if="message.usage?.totalTokens">
          {{ formatTokens(message.usage.input) }} in / {{ formatTokens(message.usage.output) }} out · {{ formatTokens(message.usage.totalTokens) }} tok
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.caret {
  display: inline-block;
  width: 6px;
  height: 13px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--color-signal);
  animation: caret-blink 0.9s steps(2) infinite;
}
</style>
