<script setup lang="ts">
import { ref } from 'vue'
import type { AgentStore } from '../composables/useAgent'

const props = defineProps<{
  agent: AgentStore
  meta: { workflowsRoot: string; environment: string } | null
}>()
const emit = defineEmits<{ close: [] }>()

const keyInput = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)

async function handleSave() {
  const key = keyInput.value.trim()
  if (!key || saving.value) return
  saving.value = true
  error.value = null
  saved.value = false
  try {
    await props.agent.saveApiKey(key)
    keyInput.value = ''
    saved.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-ink/80 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-md border border-edge bg-panel p-6 shadow-2xl shadow-black/50">
      <div class="flex items-center justify-between">
        <span class="font-display text-xs font-semibold tracking-[0.2em] text-fg">连接 · CONNECT</span>
        <button
          type="button"
          class="border border-edge px-2 py-0.5 font-mono text-[10px] text-dim hover:border-err/50 hover:text-err"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>

      <!-- API key -->
      <p class="mt-5 text-[11px] leading-relaxed text-dim">
        输入 DeepSeek API key。key 仅保存在后端
        <code class="font-mono text-signal/90">{{ meta?.environment === 'production' ? '~/.workflows' : '.workflows' }}</code>
        配置文件中,不会写入任何 pi 全局配置,也不会返回给前端。
      </p>

      <form
        class="mt-4"
        @submit.prevent="handleSave"
      >
        <input
          v-model="keyInput"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="sk-…"
          class="w-full border border-edge bg-ink px-3 py-2 font-mono text-xs text-fg placeholder:text-faint focus:border-signal/60"
        >
        <div class="mt-3 flex items-center justify-between">
          <span
            v-if="agent.hasApiKey.value"
            class="flex items-center gap-1.5 font-mono text-[10px] text-ok"
          >
            <span class="size-1.5 rounded-full bg-ok" /> 已配置(可覆盖)
          </span>
          <span
            v-else
            class="font-mono text-[10px] text-faint"
          >未配置</span>
          <button
            type="submit"
            class="border border-signal/50 bg-signal/10 px-4 py-1.5 font-display text-[11px] tracking-widest text-signal transition hover:bg-signal/20 disabled:opacity-40"
            :disabled="saving || !keyInput.trim()"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </form>

      <p
        v-if="error"
        class="mt-3 font-mono text-[10px] text-err"
      >
        {{ error }}
      </p>
      <p
        v-else-if="saved"
        class="mt-3 font-mono text-[10px] text-ok"
      >
        已保存到后端配置
      </p>

      <!-- 环境信息 -->
      <div
        v-if="meta"
        class="mt-6 border-t border-edge pt-3 font-mono text-[10px] leading-relaxed text-faint"
      >
        <p class="flex justify-between">
          <span>环境</span><span class="text-dim">{{ meta.environment }}</span>
        </p>
        <p class="mt-1 flex justify-between gap-3">
          <span>配置目录</span><span
            class="truncate text-dim"
            :title="meta.workflowsRoot"
          >{{ meta.workflowsRoot }}</span>
        </p>
      </div>
    </div>
  </div>
</template>
