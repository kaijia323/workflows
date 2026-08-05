<script setup lang="ts">
import { ref } from 'vue'
import type { AgentStore } from '../composables/useAgent'
import McpPanel from './McpPanel.vue'

const props = defineProps<{
  agent: AgentStore
  meta: { workflowsRoot: string; environment: string } | null
}>()
const emit = defineEmits<{ close: [] }>()

const keyInput = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)

const anyKeyInput = ref('')
const anySaving = ref(false)
const anyError = ref<string | null>(null)
const anySaved = ref(false)

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

async function handleAnySave() {
  if (anySaving.value) return
  anySaving.value = true
  anyError.value = null
  anySaved.value = false
  try {
    await props.agent.saveAnySearchApiKey(anyKeyInput.value)
    anyKeyInput.value = ''
    anySaved.value = true
  } catch (e) {
    anyError.value = e instanceof Error ? e.message : String(e)
  } finally {
    anySaving.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 grid place-items-center bg-canvas/80 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-md rounded-md border border-hairline bg-canvas p-6 shadow-modal">
      <div class="flex items-center justify-between">
        <span class="font-display text-[14px] font-semibold tracking-[0.15em] text-ink">连接 · CONNECT</span>
        <button
          type="button"
          class="rounded-sm border border-hairline px-2 py-0.5 font-mono text-[10px] text-body hover:border-err/50 hover:text-err"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>

      <!-- API key:DeepSeek -->
      <p class="mt-5 font-mono text-[10px] tracking-wider text-mute">
        DEEPSEEK · 对话模型
      </p>
      <p class="mt-2 text-xs leading-relaxed text-body">
        输入 DeepSeek API key。key 仅保存在后端
        <code class="font-mono text-primary/90">{{ meta?.environment === 'production' ? '~/.workflows' : '.workflows' }}</code>
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
          class="w-full rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary"
        >
        <div class="mt-3 flex items-center justify-between">
          <span
            v-if="agent.hasApiKey.value"
            class="flex items-center gap-1.5 font-mono text-[10px] text-primary"
          >
            <span class="size-1.5 rounded-full bg-primary" /> 已配置(可覆盖)
          </span>
          <span
            v-else
            class="font-mono text-[10px] text-mute"
          >未配置</span>
          <button
            type="submit"
            class="rounded-sm bg-primary px-4 py-1.5 font-display text-[11px] tracking-widest text-on-primary transition hover:bg-primary-soft disabled:opacity-40"
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
        class="mt-3 font-mono text-[10px] text-primary"
      >
        已保存到后端配置
      </p>

      <!-- AnySearch API key:独立 section -->
      <div class="mt-6 border-t border-hairline pt-4">
        <p class="font-mono text-[10px] tracking-wider text-mute">
          ANYSEARCH · 网络搜索
        </p>
        <p class="mt-2 text-xs leading-relaxed text-body">
          AnySearch 搜索 API key(可选)。不配置时工具以匿名方式调用(按 IP 限流并消耗每日免费额度)。
          key 仅保存在后端配置文件中,不会返回给前端;环境变量
          <code class="font-mono text-primary/90">ANYSEARCH_API_KEY</code>
          优先于此处配置。输入为空保存将清空已配置的 key。
        </p>

        <form
          class="mt-4"
          @submit.prevent="handleAnySave"
        >
          <input
            v-model="anyKeyInput"
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder="anysearch-…"
            class="w-full rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary"
          >
          <div class="mt-3 flex items-center justify-between">
            <span
              v-if="agent.hasAnySearchApiKey.value"
              class="flex items-center gap-1.5 font-mono text-[10px] text-primary"
            >
              <span class="size-1.5 rounded-full bg-primary" /> 已配置(可覆盖)
            </span>
            <span
              v-else
              class="font-mono text-[10px] text-mute"
            >未配置(匿名可用)</span>
            <button
              type="submit"
              class="rounded-sm bg-primary px-4 py-1.5 font-display text-[11px] tracking-widest text-on-primary transition hover:bg-primary-soft disabled:opacity-40"
              :disabled="anySaving"
            >
              {{ anySaving ? '保存中…' : '保存' }}
            </button>
          </div>
        </form>

        <p
          v-if="anyError"
          class="mt-3 font-mono text-[10px] text-err"
        >
          {{ anyError }}
        </p>
        <p
          v-else-if="anySaved"
          class="mt-3 font-mono text-[10px] text-primary"
        >
          已保存到后端配置
        </p>
      </div>

      <!-- MCP 外部工具:独立 section -->
      <McpPanel :agent="agent" />

      <!-- 环境信息 -->
      <div
        v-if="meta"
        class="mt-6 border-t border-hairline pt-3 font-mono text-[10px] leading-relaxed text-mute"
      >
        <p class="flex justify-between">
          <span>环境</span><span class="text-body">{{ meta.environment }}</span>
        </p>
        <p class="mt-1 flex justify-between gap-3">
          <span>配置目录</span><span
            class="truncate text-body"
            :title="meta.workflowsRoot"
          >{{ meta.workflowsRoot }}</span>
        </p>
      </div>
    </div>
  </div>
</template>
