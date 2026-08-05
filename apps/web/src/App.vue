<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { TriangleAlert } from '@lucide/vue'
import { useAgent } from './composables/useAgent'
import PipelineHeader from './components/PipelineHeader.vue'
import WorkspaceRail from './components/WorkspaceRail.vue'
import ChatPane from './components/ChatPane.vue'
import InfoPanel from './components/InfoPanel.vue'
import ApiKeyModal from './components/ApiKeyModal.vue'
import WorkspacePickerModal from './components/WorkspacePickerModal.vue'
import SubAgentModal from './components/SubAgentModal.vue'

const agent = useAgent()
const showSettings = ref(false)
const showPicker = ref(false)
const meta = ref<{ workflowsRoot: string; environment: string } | null>(null)
/** 子代理模态窗(点击 DAG 节点 / 聊天中子代理块打开) */
const subModal = ref<{ callId: string; agentName: string } | null>(null)

/* ---- 窄视口(<1100px)抽屉:两侧栏收为可开合抽屉,聊天列永不为 0 ---- */
const railOpen = ref(false)
const infoOpen = ref(false)
const railTrigger = ref<HTMLButtonElement | null>(null)
const infoTrigger = ref<HTMLButtonElement | null>(null)

function toggleRail(): void {
  railOpen.value = !railOpen.value
}

function toggleInfo(): void {
  infoOpen.value = !infoOpen.value
}

function closeDrawers(): void {
  railOpen.value = false
  infoOpen.value = false
}

/** Escape 关闭任一打开的抽屉,并把焦点还原到对应开关按钮 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (railOpen.value) {
    railOpen.value = false
    if (railTrigger.value?.isConnected) railTrigger.value.focus()
  } else if (infoOpen.value) {
    infoOpen.value = false
    if (infoTrigger.value?.isConnected) infoTrigger.value.focus()
  }
}

onMounted(async () => {
  await agent.init()
  await fetch('/api/agent/meta')
    .then((res) => res.json())
    .then((body) => (meta.value = body.data))
    .catch(() => (meta.value = null))
  window.addEventListener('keydown', onWindowKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-canvas font-body text-ink">
    <PipelineHeader
      :workspace="agent.activeWorkspace.value"
      :model="agent.config.value?.model ?? '—'"
      :streaming="agent.streaming.value"
      :connected="!agent.connectionError.value"
      @open-settings="showSettings = true"
    />

    <div class="flex min-h-0 flex-1">
      <WorkspaceRail
        :agent="agent"
        :open="railOpen"
        @open-picker="showPicker = true"
      />

      <!-- 中栏:窄视口开关条 + 聊天列(外包层保证 min-w-0,聊天列永不为 0) -->
      <div class="flex min-w-0 flex-1 flex-col">
        <!-- 窄视口开关条(<1100px 显示):打开两侧抽屉 -->
        <div class="hidden shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5 max-console:flex">
          <button
            ref="railTrigger"
            type="button"
            class="flex items-center gap-1.5 rounded-sm border border-hairline px-2 py-1 font-mono text-[10px] text-body transition hover:border-primary/50 hover:text-primary"
            :class="railOpen ? 'border-primary/50 text-primary' : ''"
            :aria-expanded="railOpen"
            @click="toggleRail"
          >
            工作区
          </button>
          <button
            ref="infoTrigger"
            type="button"
            class="flex items-center gap-1.5 rounded-sm border border-hairline px-2 py-1 font-mono text-[10px] text-body transition hover:border-primary/50 hover:text-primary"
            :class="infoOpen ? 'border-primary/50 text-primary' : ''"
            :aria-expanded="infoOpen"
            @click="toggleInfo"
          >
            观测
          </button>
        </div>

        <ChatPane
          :agent="agent"
          :on-open-settings="() => (showSettings = true)"
          @open-sub="(callId, agentName) => (subModal = { callId, agentName })"
        />
      </div>

      <InfoPanel
        :agent="agent"
        :meta="meta"
        :open="infoOpen"
        @open-sub="(callId, agentName) => (subModal = { callId, agentName })"
      />
    </div>

    <!-- 抽屉遮罩(仅窄视口、有抽屉打开时存在) -->
    <div
      v-if="railOpen || infoOpen"
      class="fixed inset-0 z-30 hidden bg-canvas/60 backdrop-blur-sm max-console:block"
      @click="closeDrawers"
    />

    <!-- 连接失败提示条 -->
    <div
      v-if="agent.connectionError.value"
      class="shrink-0 border-t border-err/40 bg-err/10 px-5 py-1.5 font-mono text-[10px] text-err"
    >
      <TriangleAlert class="mr-1 inline-block size-3.5 align-[-2px]" />
      {{ agent.connectionError.value }}
    </div>

    <ApiKeyModal
      v-if="showSettings"
      :agent="agent"
      :meta="meta"
      @close="showSettings = false"
    />

    <WorkspacePickerModal
      v-if="showPicker"
      :agent="agent"
      @close="showPicker = false"
    />

    <SubAgentModal
      v-if="subModal"
      :agent="agent"
      :call-id="subModal.callId"
      :agent-name="subModal.agentName"
      @close="subModal = null"
    />
  </div>
</template>
