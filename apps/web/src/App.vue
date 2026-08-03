<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAgent } from './composables/useAgent'
import PipelineHeader from './components/PipelineHeader.vue'
import WorkspaceRail from './components/WorkspaceRail.vue'
import ChatPane from './components/ChatPane.vue'
import InfoPanel from './components/InfoPanel.vue'
import ApiKeyModal from './components/ApiKeyModal.vue'
import WorkspacePickerModal from './components/WorkspacePickerModal.vue'

const agent = useAgent()
const showSettings = ref(false)
const showPicker = ref(false)
const meta = ref<{ workflowsRoot: string; environment: string } | null>(null)

onMounted(async () => {
  await agent.init()
  await fetch('/api/agent/meta')
    .then((res) => res.json())
    .then((body) => (meta.value = body.data))
    .catch(() => (meta.value = null))
})
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-ink font-body text-fg">
    <PipelineHeader
      :workspace="agent.activeWorkspace.value"
      :model="agent.config.value?.model ?? '—'"
      :streaming="agent.streaming.value"
      :connected="!agent.connectionError.value"
    />

    <div class="flex min-h-0 flex-1">
      <WorkspaceRail
        :agent="agent"
        @open-picker="showPicker = true"
      />
      <ChatPane
        :agent="agent"
        :on-open-settings="() => (showSettings = true)"
      />
      <InfoPanel
        :agent="agent"
        :meta="meta"
      />
    </div>

    <!-- 连接失败提示条 -->
    <div
      v-if="agent.connectionError.value"
      class="shrink-0 border-t border-err/40 bg-err/10 px-5 py-1.5 font-mono text-[10px] text-err"
    >
      ⚠ {{ agent.connectionError.value }}
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
  </div>
</template>
