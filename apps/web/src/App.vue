<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ApiResponse, DagGraph } from '@dag-pi/shared'

type ApiStatus = 'checking' | 'ok' | 'error'

const apiStatus = ref<ApiStatus>('checking')
const graph = ref<DagGraph | null>(null)

onMounted(async () => {
  try {
    const res = await fetch('/api/dag')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as ApiResponse<DagGraph>
    graph.value = body.data
    apiStatus.value = 'ok'
  } catch (err) {
    console.error('API 请求失败:', err)
    apiStatus.value = 'error'
  }
})
</script>

<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100">
    <header class="border-b border-zinc-800">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <div class="flex items-center gap-2">
          <span class="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 font-mono text-sm font-bold">D</span>
          <span class="text-lg font-semibold tracking-tight">dag-pi</span>
        </div>
        <span
          class="flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
          :class="{
            'border-emerald-500/30 bg-emerald-500/10 text-emerald-400': apiStatus === 'ok',
            'border-red-500/30 bg-red-500/10 text-red-400': apiStatus === 'error',
            'border-zinc-700 bg-zinc-800/60 text-zinc-400': apiStatus === 'checking',
          }"
        >
          <span
            class="size-1.5 rounded-full"
            :class="{
              'bg-emerald-400': apiStatus === 'ok',
              'bg-red-400': apiStatus === 'error',
              'animate-pulse bg-zinc-400': apiStatus === 'checking',
            }"
          />
          API {{ apiStatus === 'ok' ? '已连接' : apiStatus === 'error' ? '连接失败' : '检测中…' }}
        </span>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-6 py-16">
      <h1 class="text-4xl font-bold tracking-tight">
        DAG 流水线<span class="bg-gradient-to-r from-sky-400 to-indigo-400 bg-clip-text text-transparent">工作台</span>
      </h1>
      <p class="mt-3 max-w-2xl text-zinc-400">
        Turborepo 骨架已就绪:Vue 3 + TypeScript + Vite + Tailwind CSS v4 前端,
        Express 5 后端,共享类型来自 <code class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-sm text-sky-300">@dag-pi/shared</code>。
      </p>

      <section
        v-if="graph"
        class="mt-12"
      >
        <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">
          示例 DAG 数据(/api/dag)
        </h2>
        <div class="grid gap-4 sm:grid-cols-3">
          <div
            v-for="node in graph.nodes"
            :key="node.id"
            class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 transition hover:border-sky-500/50 hover:bg-zinc-900"
          >
            <div class="flex items-center gap-3">
              <span class="flex size-8 items-center justify-center rounded-lg bg-sky-500/15 font-mono text-xs text-sky-400">
                {{ node.id.slice(-1).toUpperCase() }}
              </span>
              <div>
                <p class="font-medium">
                  {{ node.label }}
                </p>
                <p class="font-mono text-xs text-zinc-500">
                  {{ node.id }}
                </p>
              </div>
            </div>
            <p
              v-if="node.description"
              class="mt-3 text-sm text-zinc-400"
            >
              {{ node.description }}
            </p>
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          <span
            v-for="edge in graph.edges"
            :key="`${edge.source}->${edge.target}`"
            class="rounded-full border border-zinc-800 px-3 py-1 font-mono text-xs text-zinc-400"
          >
            {{ edge.source }} → {{ edge.target }}
          </span>
        </div>
      </section>

      <section
        v-else
        class="mt-12 rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500"
      >
        {{ apiStatus === 'error' ? '无法连接 API,请确认 apps/api 已启动(pnpm dev)' : '正在加载…' }}
      </section>
    </main>
  </div>
</template>
