<script setup lang="ts">
import { computed } from 'vue'
import type { Workspace } from '@workflows/shared'

/**
 * 管线签名:顶部贯穿三栏的「源 → 处理 → 观测」流水线。
 * agent 工作时,琥珀光点沿连线从工作区流向观测端。
 */
const props = defineProps<{
  workspace: Workspace | null
  model: string
  streaming: boolean
  connected: boolean
}>()

const sourceDetail = computed(() => props.workspace?.name ?? '未选择')
const sourceActive = computed(() => Boolean(props.workspace))
const processingDetail = computed(() => (props.streaming ? '运行中' : props.model || '—'))
</script>

<template>
  <header class="relative z-10 flex h-12 shrink-0 items-center gap-4 border-b border-edge bg-panel/70 px-4 backdrop-blur">
    <!-- 品牌 -->
    <div class="flex w-60 shrink-0 items-center gap-2.5">
      <span class="grid size-6 place-items-center border border-signal/60 bg-signal/10">
        <span class="size-1.5 bg-signal" />
      </span>
      <span class="font-display text-sm font-semibold tracking-[0.18em] text-fg">
        WORKFLOWS
      </span>
      <span class="mt-0.5 hidden font-mono text-[10px] tracking-wider text-faint xl:inline">AGENT CONSOLE</span>
    </div>

    <!-- 管线:工作区 → 代理 → 观测 -->
    <div class="flex min-w-0 flex-1 items-center justify-center">
      <!-- 源节点:工作区 -->
      <div class="flex flex-col items-center gap-1">
        <span
          class="grid size-5 place-items-center border transition-colors duration-300"
          :class="sourceActive ? 'border-signal/70 bg-signal/10' : 'border-edge bg-raised'"
        >
          <span
            class="size-1.5"
            :class="sourceActive ? 'bg-signal' : 'bg-faint'"
          />
        </span>
        <span
          class="max-w-32 truncate font-display text-[10px] tracking-wider"
          :class="sourceActive ? 'text-fg' : 'text-faint'"
        >
          {{ sourceDetail }}
        </span>
      </div>

      <!-- 连线 1:工作区 → 代理 -->
      <div class="relative mx-2 h-px w-16 bg-edge sm:w-24">
        <span
          v-if="streaming"
          class="flow-dot"
          :class="workspace ? 'bg-signal' : 'bg-wire'"
        />
      </div>

      <!-- 处理节点:代理 -->
      <div class="flex flex-col items-center gap-1">
        <span
          class="grid size-5 place-items-center border transition-colors duration-300"
          :class="streaming ? 'border-signal bg-signal/20' : 'border-wire/60 bg-raised'"
        >
          <span
            class="size-1.5"
            :class="streaming ? 'animate-pulse bg-signal' : 'bg-wire'"
          />
        </span>
        <span
          class="max-w-36 truncate font-display text-[10px] tracking-wider"
          :class="streaming ? 'text-signal' : 'text-dim'"
        >
          {{ processingDetail }}
        </span>
      </div>

      <!-- 连线 2:代理 → 观测 -->
      <div class="relative mx-2 h-px w-16 bg-edge sm:w-24">
        <span
          v-if="streaming"
          class="flow-dot bg-signal"
        />
      </div>

      <!-- 输出节点:观测 -->
      <div class="flex flex-col items-center gap-1">
        <span class="grid size-5 place-items-center border border-edge bg-raised">
          <span class="size-1.5 bg-wire" />
        </span>
        <span class="font-display text-[10px] tracking-wider text-faint">观测</span>
      </div>
    </div>

    <!-- 状态灯 -->
    <div class="flex w-60 shrink-0 items-center justify-end gap-2">
      <span class="font-mono text-[10px] tracking-wider text-faint">LINK</span>
      <span
        class="flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px]"
        :class="connected ? 'border-ok/40 bg-ok/5 text-ok' : 'border-err/40 bg-err/5 text-err'"
      >
        <span
          class="size-1.5 rounded-full"
          :class="connected ? 'bg-ok' : 'bg-err'"
        />
        {{ connected ? 'API' : '离线' }}
      </span>
    </div>
  </header>
</template>

<style scoped>
/* 流动光点:沿连线平移,offset-path 保持曲线感 */
.flow-dot {
  position: absolute;
  top: 50%;
  left: 0;
  width: 5px;
  height: 5px;
  border-radius: 9999px;
  translate: -50% -50%;
  animation: dot-flow 1.6s var(--ease-flow) infinite;
  box-shadow: 0 0 8px 1px color-mix(in srgb, currentColor 60%, transparent);
}

@keyframes dot-flow {
  0% {
    left: 0%;
    opacity: 0;
  }
  12% {
    opacity: 1;
  }
  88% {
    opacity: 1;
  }
  100% {
    left: 100%;
    opacity: 0;
  }
}
</style>
