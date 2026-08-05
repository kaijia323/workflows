<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftRight, Pause } from '@lucide/vue'
import type { AgentStore } from '../composables/useAgent'

/**
 * 右侧 DAG 图:explorer → planner → ⏸闸门 → executor ⇄ reviewer
 * 节点状态来自 run 快照 + 实时子代理事件;点击节点打开子代理模态窗。
 */
const props = defineProps<{
  agent: AgentStore
}>()

const emit = defineEmits<{
  open: [callId: string, agentName: string]
}>()

interface DagNodeState {
  id: string
  label: string
  status: 'idle' | 'running' | 'done' | 'error'
  rounds: number
  callId: string | null
}

const ROLE_LABELS: Array<{ id: string; label: string }> = [
  { id: 'explorer', label: '探索' },
  { id: 'planner', label: '计划' },
  { id: 'executor', label: '执行' },
  { id: 'reviewer', label: '审查' },
]

const nodes = computed<DagNodeState[]>(() => {
  const run = props.agent.run.value
  const running = [...props.agent.subSessions.values()].filter((s) => s.status === 'running')
  return ROLE_LABELS.map((role) => {
    const calls = run?.agents.filter((a) => a.agent === role.id) ?? []
    const last = calls.at(-1) ?? null
    const isRunning = running.some((s) => s.agentName === role.id) || running.some((s) => s.callId === last?.callId)
    const hasError = calls.some((c) => c.summary.startsWith('子代理') || c.summary.includes('失败'))
    return {
      id: role.id,
      label: role.label,
      status: isRunning ? 'running' : calls.length > 0 ? (hasError ? 'error' : 'done') : 'idle',
      rounds: calls.length,
      callId: last?.callId ?? null,
    }
  })
})

const gatePending = computed(() => Boolean(props.agent.run.value?.gate.pending))
const planFile = computed(() => props.agent.run.value?.gate.planFile ?? null)
const runStatus = computed(() => props.agent.run.value?.status ?? null)

function openNode(node: DagNodeState): void {
  if (!node.callId) return
  emit('open', node.callId, node.id)
}

function statusClass(status: DagNodeState['status']): string {
  switch (status) {
    case 'running':
      return 'border-primary bg-primary/10'
    case 'done':
      return 'border-primary/40 bg-primary/5'
    case 'error':
      return 'border-err/60 bg-err/5'
    default:
      return 'border-hairline bg-canvas-soft'
  }
}

function statusDot(status: DagNodeState['status']): string {
  switch (status) {
    case 'running':
      return 'bg-primary animate-pulse'
    case 'done':
      return 'bg-primary/80'
    case 'error':
      return 'bg-err'
    default:
      return 'bg-mute'
  }
}

function connectorClass(status: DagNodeState['status']): string {
  return status === 'done' || status === 'error' ? 'bg-primary/50' : 'bg-hairline'
}
</script>

<template>
  <div class="border-b border-hairline bg-canvas px-4 py-3">
    <div class="flex items-center justify-between">
      <span class="font-display text-[10px] font-semibold tracking-[0.2em] text-mute">流程 · PIPELINE</span>
      <span
        v-if="runStatus"
        class="font-mono text-[10px] tracking-wider"
        :class="gatePending ? 'text-primary' : 'text-mute'"
      >
        {{ gatePending ? '待批准' : runStatus }}
      </span>
    </div>

    <!-- 节点连线:w-12×4 + w-3×3 = 252px ≤ 面板内宽,不再被 flex 压缩 -->
    <div class="mt-3 flex items-center justify-center">
      <!-- 探索 -->
      <button
        type="button"
        class="flex w-12 flex-col items-center gap-1 transition hover:opacity-80"
        :disabled="!nodes[0].callId"
        @click="openNode(nodes[0])"
      >
        <span
          class="grid size-7 place-items-center border"
          :class="statusClass(nodes[0].status)"
        >
          <span
            class="size-1.5"
            :class="statusDot(nodes[0].status)"
          />
        </span>
        <span class="font-display text-[10px] tracking-wider text-body">探索</span>
      </button>

      <span
        class="mx-1 h-px w-3"
        :class="connectorClass(nodes[0].status)"
      />

      <!-- 计划 -->
      <button
        type="button"
        class="flex w-12 flex-col items-center gap-1 transition hover:opacity-80"
        :disabled="!nodes[1].callId"
        @click="openNode(nodes[1])"
      >
        <span
          class="grid size-7 place-items-center border"
          :class="statusClass(nodes[1].status)"
        >
          <span
            class="size-1.5"
            :class="statusDot(nodes[1].status)"
          />
        </span>
        <span class="font-display text-[10px] tracking-wider text-body">计划</span>
      </button>

      <!-- 闸门 -->
      <span
        class="mx-1 flex h-px w-3 items-center"
        :class="connectorClass(nodes[1].status)"
      >
        <span
          class="mx-auto grid size-3.5 place-items-center border"
          :class="gatePending ? 'border-primary bg-primary/15 text-primary' : 'border-hairline text-mute'"
          title="人工闸门:计划需用户批准"
        >
          <Pause class="size-2.5" />
        </span>
      </span>

      <!-- 执行 -->
      <button
        type="button"
        class="flex w-12 flex-col items-center gap-1 transition hover:opacity-80"
        :disabled="!nodes[2].callId"
        @click="openNode(nodes[2])"
      >
        <span
          class="grid size-7 place-items-center border"
          :class="statusClass(nodes[2].status)"
        >
          <span
            class="size-1.5"
            :class="statusDot(nodes[2].status)"
          />
        </span>
        <span class="font-display text-[10px] tracking-wider text-body">执行</span>
      </button>

      <!-- 执行 ⇄ 审查回边 -->
      <span
        class="mx-1 flex h-px w-3 items-center"
        :class="connectorClass(nodes[2].status)"
      >
        <span class="mx-auto text-mute"><ArrowLeftRight class="size-3" /></span>
      </span>

      <!-- 审查 -->
      <button
        type="button"
        class="flex w-12 flex-col items-center gap-1 transition hover:opacity-80"
        :disabled="!nodes[3].callId"
        @click="openNode(nodes[3])"
      >
        <span
          class="relative grid size-7 place-items-center border"
          :class="statusClass(nodes[3].status)"
        >
          <span
            class="size-1.5"
            :class="statusDot(nodes[3].status)"
          />
          <span
            v-if="nodes[3].rounds > 1"
            class="absolute -right-1.5 -top-1.5 grid size-3.5 place-items-center rounded-sm border border-hairline bg-canvas font-mono text-[10px] leading-none text-body"
          >{{ nodes[3].rounds }}</span>
        </span>
        <span class="font-display text-[10px] tracking-wider text-body">审查</span>
      </button>
    </div>

    <!-- 闸门提示 -->
    <p
      v-if="gatePending"
      class="mt-2.5 rounded-sm border border-primary/40 bg-primary/5 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed text-primary"
    >
      <Pause class="mr-1 inline-block size-3 align-[-2px]" /> 计划待批准<template v-if="planFile">
        :{{ planFile }}
      </template>
    </p>
    <p
      v-else-if="!agent.run.value"
      class="mt-2.5 font-mono text-[10px] leading-relaxed text-mute"
    >
      下发需求后,流程节点在此实时流转。点击节点查看子代理详情。
    </p>
  </div>
</template>
