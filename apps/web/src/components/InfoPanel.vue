<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Lock, Unlock } from '@lucide/vue'
import type { AgentStore } from '../composables/useAgent'
import { toolLabel } from '../composables/useAgent'

const props = defineProps<{
  agent: AgentStore
  meta: { workflowsRoot: string; environment: string } | null
  /** <1100px 时右栏收为抽屉,此值控制滑入/滑出 */
  open: boolean
}>()

/** 抽屉根(打开时收焦;关闭时 invisible 不在 a11y 树/Tab 序中) */
const root = ref<HTMLElement | null>(null)
watch(
  () => props.open,
  (open) => {
    if (open) nextTick(() => root.value?.focus())
  },
)

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
  <aside
    ref="root"
    tabindex="-1"
    class="flex w-72 shrink-0 flex-col border-l border-hairline bg-canvas max-console:fixed max-console:inset-y-0 max-console:right-0 max-console:z-40 max-console:transition-[translate,visibility]"
    :class="
      props.open
        ? 'max-console:translate-x-0 max-console:visible'
        : 'max-console:translate-x-full max-console:invisible'
    "
  >
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
      <div class="pt-3">
        <span class="font-display text-[10px] font-semibold tracking-[0.2em] text-mute">观测 · OBSERVE</span>
      </div>
      <!-- 工作区 -->
      <section>
        <p class="section-label">
          工作区
        </p>
        <template v-if="ws">
          <p class="truncate text-[13px] font-medium text-ink">
            {{ ws.name }}
          </p>
          <p class="mt-1 break-all font-mono text-[10px] leading-relaxed text-mute">
            {{ ws.path }}
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <!-- 权限徽标升级为可点击切换按钮(作用于激活工作区);样式保持 kv 胶囊,图标提示可交互 -->
            <button
              type="button"
              class="flex cursor-pointer items-center gap-1 rounded-full border px-2 py-px font-mono text-[10px] tracking-wider transition-colors duration-200"
              :class="
                ws.readOnly
                  ? 'border-primary/40 text-primary hover:border-primary hover:text-primary'
                  : 'border-hairline text-body hover:border-primary hover:text-primary'
              "
              :title="ws.readOnly ? '切换为读写' : '切换为只读'"
              @click="agent.toggleReadOnly(ws.id, !ws.readOnly)"
            >
              <Lock
                v-if="ws.readOnly"
                class="size-3"
              />
              <Unlock
                v-else
                class="size-3"
              />
              {{ ws.readOnly ? '只读' : '读写' }}
            </button>
            <span class="kv text-body">{{ ws.createdAt ? new Date(ws.createdAt).toLocaleDateString() : '—' }}</span>
          </div>
        </template>
        <p
          v-else
          class="text-[11px] leading-relaxed text-mute"
        >
          选择左侧工作区后,此处展示目录与权限信息。
        </p>
      </section>

      <!-- 会话 -->
      <section>
        <p class="section-label">
          会话
        </p>
        <dl
          v-if="ws"
          class="space-y-1.5 font-mono text-[10px]"
        >
          <div class="flex justify-between gap-2">
            <dt class="text-mute">
              模型
            </dt><dd class="truncate text-body">
              {{ status?.model ?? '—' }}
            </dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="text-mute">
              思考
            </dt><dd class="text-body">
              {{ status?.thinkingLevel ?? '—' }}
            </dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="text-mute">
              消息
            </dt><dd class="text-body">
              {{ status?.messageCount ?? 0 }}
            </dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="text-mute">
              状态
            </dt>
            <dd
              class="flex items-center gap-1.5"
              :class="status?.streaming ? 'text-primary' : 'text-body'"
            >
              <span
                class="size-1.5 rounded-full"
                :class="status?.streaming ? 'animate-pulse bg-primary' : 'bg-primary/60'"
              />
              {{ status?.streaming ? '运行中' : '空闲' }}
            </dd>
          </div>
        </dl>
        <p
          v-else
          class="text-[11px] text-mute"
        >
          —
        </p>
      </section>

      <!-- Token 用量 -->
      <section>
        <p class="section-label">
          用量
        </p>
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
          <p class="mt-1.5 text-right font-mono text-[10px] text-mute">
            成本 ≈ ${{ (status.usage.cost ?? 0).toFixed(4) }}
          </p>
        </template>
        <p
          v-else
          class="text-[11px] text-mute"
        >
          —
        </p>
      </section>

      <!-- 工具调用流 -->
      <section>
        <p class="section-label">
          工具流
        </p>
        <ul
          v-if="recentRuns.length > 0"
          class="space-y-1"
        >
          <li
            v-for="run in recentRuns"
            :key="run.callId"
            class="flex items-center gap-2 rounded-sm border border-hairline/60 bg-canvas-soft/60 px-2 py-1"
          >
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="run.isError ? 'bg-err' : 'bg-primary'"
            />
            <span class="shrink-0 font-display text-[10px] tracking-wider text-body">{{ toolLabel(run.name) }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-mute">{{ run.name }}</span>
            <span class="shrink-0 font-mono text-[11px] text-mute">{{ formatTime(run.ts) }}</span>
          </li>
        </ul>
        <p
          v-else
          class="text-[11px] text-mute"
        >
          agent 调用工具时,此处实时呈现。
        </p>
      </section>

      <!-- 系统 -->
      <section>
        <p class="section-label">
          系统
        </p>
        <dl
          v-if="meta"
          class="space-y-1.5 font-mono text-[10px]"
        >
          <div class="flex justify-between gap-2">
            <dt class="text-mute">
              环境
            </dt><dd class="text-body">
              {{ meta.environment }}
            </dd>
          </div>
          <div class="flex justify-between gap-2">
            <dt class="shrink-0 text-mute">
              配置目录
            </dt>
            <dd
              class="truncate text-body"
              :title="meta.workflowsRoot"
            >
              {{ meta.workflowsRoot }}
            </dd>
          </div>
        </dl>
        <p
          v-else
          class="text-[11px] text-mute"
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
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  color: var(--color-mute);
}

.kv {
  border: 1px solid var(--color-hairline);
  border-radius: 9999px;
  padding: 1px 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.05em;
}

.metric {
  border: 1px solid var(--color-hairline);
  background: var(--color-canvas-soft);
  border-radius: 8px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.metric-label {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-mute);
  letter-spacing: 0.1em;
}
.metric-value {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 600;
  color: var(--color-ink);
  font-variant-numeric: tabular-nums;
}
</style>
