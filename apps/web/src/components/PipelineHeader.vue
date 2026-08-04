<script setup lang="ts">
import { computed } from 'vue'
import { Settings } from '@lucide/vue'
import type { Workspace } from '@workflows/shared'

/**
 * 管线签名:顶部贯穿三栏的「源 → 处理 → 观测」流水线。
 * agent 工作时,绿色光点沿连线从工作区流向观测端。
 */
const props = defineProps<{
  workspace: Workspace | null
  model: string
  streaming: boolean
  connected: boolean
}>()
const emit = defineEmits<{ 'open-settings': [] }>()

const sourceDetail = computed(() => props.workspace?.name ?? '未选择')
const sourceActive = computed(() => Boolean(props.workspace))
const processingDetail = computed(() => (props.streaming ? '运行中' : props.model || '—'))
</script>

<template>
  <header class="relative z-10 flex h-12 shrink-0 items-center gap-4 border-b border-hairline bg-canvas/80 px-4 backdrop-blur">
    <!-- 品牌 -->
    <div class="flex w-60 shrink-0 items-center gap-2.5">
      <span class="grid size-6 place-items-center rounded-sm border border-primary/60 bg-primary/10">
        <span class="size-1.5 bg-primary" />
      </span>
      <span class="font-display text-sm font-semibold tracking-[0.18em] text-ink">
        WORKFLOWS
      </span>
      <span class="mt-0.5 hidden font-mono text-[10px] tracking-wider text-mute xl:inline">AGENT CONSOLE</span>
    </div>

    <!-- 管线:工作区 → 代理 → 观测 -->
    <div class="flex min-w-0 flex-1 items-center justify-center">
      <!-- 源节点:工作区 -->
      <div class="flex flex-col items-center gap-1">
        <span
          class="grid size-5 place-items-center border transition-colors duration-300"
          :class="sourceActive ? 'border-primary/70 bg-primary/10' : 'border-hairline bg-canvas-soft'"
        >
          <span
            class="size-1.5"
            :class="sourceActive ? 'bg-primary' : 'bg-mute'"
          />
        </span>
        <span
          class="max-w-32 truncate font-display text-[10px] tracking-wider"
          :class="sourceActive ? 'text-ink' : 'text-mute'"
        >
          {{ sourceDetail }}
        </span>
      </div>

      <!-- 连线 1:工作区 → 代理 -->
      <div class="relative mx-2 h-px w-16 bg-hairline sm:w-24">
        <span
          v-if="streaming"
          class="flow-dot bg-primary"
        />
      </div>

      <!-- 处理节点:代理 -->
      <div class="flex flex-col items-center gap-1">
        <span
          class="grid size-5 place-items-center border transition-colors duration-300"
          :class="streaming ? 'border-primary bg-primary/20' : 'border-hairline bg-canvas-soft'"
        >
          <span
            class="size-1.5"
            :class="streaming ? 'animate-pulse bg-primary' : 'bg-mute'"
          />
        </span>
        <span
          class="max-w-36 truncate font-display text-[10px] tracking-wider"
          :class="streaming ? 'text-primary' : 'text-body'"
        >
          {{ processingDetail }}
        </span>
      </div>

      <!-- 连线 2:代理 → 观测 -->
      <div class="relative mx-2 h-px w-16 bg-hairline sm:w-24">
        <span
          v-if="streaming"
          class="flow-dot bg-primary"
        />
      </div>

      <!-- 输出节点:观测 -->
      <div class="flex flex-col items-center gap-1">
        <span class="grid size-5 place-items-center border border-hairline bg-canvas-soft">
          <span class="size-1.5 bg-mute" />
        </span>
        <span class="font-display text-[10px] tracking-wider text-mute">观测</span>
      </div>
    </div>

    <!-- 状态灯 -->
    <div class="flex w-60 shrink-0 items-center justify-end gap-2">
      <button
        type="button"
        title="设置"
        class="grid size-6 place-items-center rounded-sm border border-hairline font-mono text-[11px] text-body transition hover:border-primary/50 hover:text-primary"
        @click="emit('open-settings')"
      >
        <Settings class="size-4" />
      </button>
      <span class="font-mono text-[10px] tracking-wider text-mute">LINK</span>
      <span
        class="flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px]"
        :class="connected ? 'border-primary/40 text-primary' : 'border-err/40 text-err'"
      >
        <span
          class="size-1.5 rounded-full"
          :class="connected ? 'bg-primary' : 'bg-err'"
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
  box-shadow: 0 0 8px 1px color-mix(in srgb, var(--color-primary) 60%, transparent);
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
