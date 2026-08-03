<script setup lang="ts">
import { computed } from 'vue'
import type { AgentStore } from '../composables/useAgent'
import { toolLabel } from '../composables/useAgent'
import DagPanel from './DagPanel.vue'

const props = defineProps<{
  agent: AgentStore
  meta: { workflowsRoot: string; environment: string } | null
}>()

const emit = defineEmits<{
  openSub: [callId: string, agentName: string]
}>()

const ws = computed(() => props.agent.activeWorkspace.value)
const status = computed(() => props.agent.status.value)
const recentRuns = computed(() => props.agent.toolRuns.value.slice(-8).reverse())

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function fmt(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
</script>

<template>
  <aside class="flex w-72 shrink-0 flex-col border-l border-edge bg-panel/40">
    <!-- 上方:工作流 DAG 图 -->
    <DagPanel
      :agent="agent"
      @open="emit('openSub', $event[0], $event[1])"
    />

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
      <div class="pt-3">
        <span class="font-display text-[10px] font-semibold tracking-[0.2em] text-faint">观测 · OBSERVE</span>
      </div>
      <!-- 工作区 -->
      <section>
        <h3 class="section-label">
          工作区
        </h3>
        <template v-if="ws">
          <p class="truncate text-[13px] font-medium text-fg">
            {{ ws.name }}
          </p>
          <p class="mt-1 break-all font-mono text-[10px] leading-relaxed text-faint">
            {{ ws.path }}
          </p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <span
              class="kv"
              :class="ws.readOnly ? 'text-ok' : 'text-dim'"
            >{{ ws.readOnly ? '只读' : '读写' }}</span>
            <span class="kv text-dim">{{ ws.createdAt ? new Date(ws.createdAt).toLocaleDateString() : '—' }}</span>
          </div>
        </template>
        <p
          v-else
          class="text-[11px] leading-relaxed text-faint"
        >
          选择左侧工作区后,此处展示目录与权限信息。
        </p>
      </section>

      <!-- 会话 -->
      <section>
        <h3 class="section-label">
          会话
        </h3>
        <dl
          v-if="ws"
          class="space-y-1.5 font-mono text-[10.5px]"
        >
          <div class="flex justify-between gap-2">
            <dt class="text-faint">
              模型
            </dt><dd class="truncate text-dim">
              {{ status?.model ?? '—' }}
            </dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="text-faint">
              思考
            </dt><dd class="text-dim">
              {{ status?.thinkingLevel ?? '—' }}
            </dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="text-faint">
              消息
            </dt><dd class="text-dim">
              {{ status?.messageCount ?? 0 }}
            </dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="text-faint">
              状态
            </dt>
            <dd
              class="flex items-center gap-1.5"
              :class="status?.streaming ? 'text-signal' : 'text-dim'"
            >
              <span
                class="size-1.5 rounded-full"
                :class="status?.streaming ? 'animate-pulse bg-signal' : 'bg-ok'"
              />
              {{ status?.streaming ? '运行中' : '空闲' }}
            </dd>
          </div>
        </dl>
        <p
          v-else
          class="text-[11px] text-faint"
        >
          —
        </p>
      </section>

      <!-- Token 用量 -->
      <section>
        <h3 class="section-label">
          用量
        </h3>
        <template v-if="ws && status?.usage">
          <div class="grid grid-cols-2 gap-1.5">
            <div class="metric">
              <span class="metric-label">输入</span>
              <span class="metric-value">{{ fmt(status.usage.input) }}</span>
            </div>
            <div class="metric">
              <span class="metric-label">输出</span>
              <span class="metric-value">{{ fmt(status.usage.output) }}</span>
            </div>
            <div class="metric">
              <span class="metric-label">缓存读</span>
              <span class="metric-value">{{ fmt(status.usage.cacheRead) }}</span>
            </div>
            <div class="metric">
              <span class="metric-label">合计</span>
              <span class="metric-value">{{ fmt(status.usage.totalTokens) }}</span>
            </div>
          </div>
          <p class="mt-1.5 text-right font-mono text-[10px] text-faint">
            成本 ≈ ${{ (status.usage.cost ?? 0).toFixed(4) }}
          </p>
        </template>
        <p
          v-else
          class="text-[11px] text-faint"
        >
          —
        </p>
      </section>

      <!-- 工具调用流 -->
      <section>
        <h3 class="section-label">
          工具流
        </h3>
        <ul
          v-if="recentRuns.length > 0"
          class="space-y-1"
        >
          <li
            v-for="run in recentRuns"
            :key="run.callId"
            class="flex items-center gap-2 border border-edge/60 bg-raised/40 px-2 py-1"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="run.isError ? 'bg-err' : 'bg-ok'"
            />
            <span class="shrink-0 font-display text-[10px] tracking-wider text-dim">{{ toolLabel(run.name) }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[9.5px] text-faint">{{ run.name }}</span>
            <span class="shrink-0 font-mono text-[9px] text-faint/70">{{ formatTime(run.ts) }}</span>
          </li>
        </ul>
        <p
          v-else
          class="text-[11px] text-faint"
        >
          agent 调用工具时,此处实时呈现。
        </p>
      </section>

      <!-- 系统 -->
      <section>
        <h3 class="section-label">
          系统
        </h3>
        <dl
          v-if="meta"
          class="space-y-1.5 font-mono text-[10px]"
        >
          <div class="flex justify-between gap-2">
            <dt class="text-faint">
              环境
            </dt><dd class="text-dim">
              {{ meta.environment }}
            </dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-faint">
              配置目录
            </dt>
            <dd
              class="truncate text-dim"
              :title="meta.workflowsRoot"
            >
              {{ meta.workflowsRoot }}
            </dd>
          </div>
        </dl>
        <p
          v-else
          class="text-[11px] text-faint"
        >
          —
        </p>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.section-label {
  margin-bottom: 0.5rem;
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.2em;
  color: var(--color-faint);
}

.kv {
  border: 1px solid var(--color-edge);
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.05em;
}

.metric {
  border: 1px solid var(--color-edge);
  background: var(--color-raised);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.metric-label {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--color-faint);
  letter-spacing: 0.1em;
}
.metric-value {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 600;
  color: var(--color-fg);
  font-variant-numeric: tabular-nums;
}
</style>
