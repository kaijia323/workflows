<script setup lang="ts">
import { ref } from 'vue'
import type { AgentStore } from '../composables/useAgent'

/**
 * 视觉模型面板(设置模态窗「视觉模型」tab):开关 + 小米 API key + 保存 + 状态行。
 * 视觉能力以工具 vision-understand 形式提供给主代理与各子代理(开关关闭或未填 key 时工具不注册)。
 */
const props = defineProps<{
  agent: AgentStore
  meta: { workflowsRoot: string; environment: string } | null
}>()

/** 开关本地态(默认取自后端配置;保存成功后由 refreshConfig 同步,失败时回滚到后端值) */
const visionOn = ref(props.agent.visionEnabled.value)
const keyInput = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)
/** 显式清除 key 的两步确认态(防误触:首次点击进入确认,再次点击才执行) */
const clearArmed = ref(false)

/** 状态行:由开关 + 是否已配置 key 组合(三态) */
function statusText(): { text: string; cls: string; dot: string } {
  if (props.agent.visionEnabled.value) {
    if (props.agent.hasVisionApiKey.value) {
      return { text: '已开启 · 已配置 key(工具可用)', cls: 'text-primary', dot: 'bg-primary' }
    }
    return { text: '已开启 · 未配置 key(工具不可用)', cls: 'text-err', dot: 'bg-err' }
  }
  return { text: '已关闭(工具不可用)', cls: 'text-mute', dot: 'bg-mute' }
}

function toggleSwitch(): void {
  visionOn.value = !visionOn.value
  clearArmed.value = false
}

async function handleSave(): Promise<void> {
  if (saving.value) return
  saving.value = true
  error.value = null
  saved.value = false
  clearArmed.value = false
  try {
    if (visionOn.value) {
      // 开启时:key 输入为空 = 保留后端已配置 key(不提交 apiKey 字段,避免误清空);
      // 仅在用户显式输入新 key 时才更新(清空 key 走下方显式「清除 key」按钮)
      const patch: { enabled: boolean; apiKey?: string } = { enabled: true }
      const key = keyInput.value.trim()
      if (key) patch.apiKey = key
      await props.agent.saveVisionConfig(patch)
    } else {
      // 关闭时仅提交开关,key 保留(重新开启即恢复可用)
      await props.agent.saveVisionConfig({ enabled: false })
    }
    keyInput.value = ''
    saved.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e) // 失败保留输入
    // 保存失败:开关本地态回滚到后端配置值,避免开关位置与状态行文案矛盾
    visionOn.value = props.agent.visionEnabled.value
  } finally {
    saving.value = false
  }
}

/** 显式清除后端已配置 key(两步确认防误触;env XIAOMI_API_KEY 优先的语义由后端负责) */
async function handleClear(): Promise<void> {
  if (!clearArmed.value) {
    clearArmed.value = true
    return
  }
  clearArmed.value = false
  if (saving.value) return
  saving.value = true
  error.value = null
  saved.value = false
  try {
    await props.agent.saveVisionConfig({ enabled: true, apiKey: '' })
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
  <div>
    <p class="mt-5 font-mono text-[10px] tracking-wider text-mute">
      视觉模型 · VISION
    </p>
    <p class="mt-2 text-xs leading-relaxed text-body">
      小米视觉理解(按量付费,不计入订阅/Token Plan)。开启并配置 key 后,主代理与各子代理以工具
      <code class="font-mono text-primary/90">vision-understand</code>
      方式识图(传入工作区内图片路径 + 问题,返回文字描述)。key 仅保存在后端
      <code class="font-mono text-primary/90">{{ meta?.environment === 'production' ? '~/.workflows' : '.workflows' }}</code>
      配置文件中,不会返回给前端;环境变量
      <code class="font-mono text-primary/90">XIAOMI_API_KEY</code>
      优先于此处配置。开关关闭或未填 key 时工具不可用,默认关闭。
    </p>

    <div class="mt-4 space-y-3">
      <!-- 开关 -->
      <div class="flex items-center justify-between">
        <span class="font-mono text-[10px] text-body">启用视觉模型</span>
        <button
          type="button"
          role="switch"
          :aria-checked="visionOn"
          :aria-label="visionOn ? '关闭视觉模型' : '开启视觉模型'"
          class="flex h-5 w-9 items-center rounded-full border border-hairline px-0.5 transition-colors duration-200"
          :class="visionOn ? 'bg-primary' : 'bg-canvas-soft'"
          @click="toggleSwitch"
        >
          <span
            class="size-4 rounded-full transition-transform duration-200"
            :class="visionOn ? 'translate-x-4 bg-on-primary' : 'translate-x-0 bg-mute'"
          />
        </button>
      </div>

      <!-- key 输入(关闭时禁用) -->
      <form
        @submit.prevent="handleSave"
      >
        <label
          for="vision-key"
          class="sr-only"
        >小米视觉 API Key</label>
        <input
          id="vision-key"
          v-model="keyInput"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="sk-…"
          :disabled="!visionOn"
          :title="visionOn ? undefined : '开启后可用'"
          class="w-full rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
        <div class="mt-3 flex items-center justify-between">
          <span
            class="flex items-center gap-1.5 font-mono text-[10px]"
            :class="statusText().cls"
          >
            <span
              class="size-1.5 rounded-full"
              :class="statusText().dot"
            />
            {{ statusText().text }}
          </span>
          <div class="flex items-center gap-2">
            <button
              v-if="visionOn && agent.hasVisionApiKey.value"
              type="button"
              class="rounded-sm border border-hairline px-4 py-1.5 font-display text-[11px] tracking-widest transition disabled:opacity-40"
              :class="clearArmed ? 'text-err' : 'text-mute hover:text-body'"
              :disabled="saving"
              @click="handleClear"
            >
              {{ clearArmed ? '确认清除?' : '清除 key' }}
            </button>
            <button
              type="submit"
              class="rounded-sm bg-primary px-4 py-1.5 font-display text-[11px] tracking-widest text-on-primary transition hover:bg-primary-soft disabled:opacity-40"
              :disabled="saving"
            >
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </form>
    </div>

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
  </div>
</template>
