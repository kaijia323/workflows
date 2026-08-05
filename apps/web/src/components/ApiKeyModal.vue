<script setup lang="ts">
import { ref } from 'vue'
import type { AgentStore } from '../composables/useAgent'
import { useModalDialog } from '../composables/useModalDialog'
import ApiKeysPanel from './ApiKeysPanel.vue'
import McpPanel from './McpPanel.vue'

defineProps<{
  agent: AgentStore
  meta: { workflowsRoot: string; environment: string } | null
}>()
const emit = defineEmits<{ close: [] }>()

type TabId = 'api' | 'mcp'
const activeTab = ref<TabId>('api')

/** 对话框契约:焦点 trap / 背景 inert / Esc 关闭 / 卸载还原焦点 */
const root = ref<HTMLElement | null>(null)
useModalDialog({
  root,
  onClose: () => emit('close'),
  ariaLabel: '设置:API Keys 与 MCP 配置',
})
</script>

<template>
  <!-- 遮罩 -->
  <div
    ref="root"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    aria-label="设置:API Keys 与 MCP 配置"
    class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-canvas/80 p-6 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <!-- 壳:标题条 + 左 tab 导航 + 右内容区 + 底部环境信息 -->
    <div class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-md border border-hairline bg-canvas shadow-modal">
      <!-- 标题条 -->
      <div class="flex shrink-0 items-center justify-between border-b border-hairline px-5 py-3">
        <span class="font-display text-[14px] font-semibold tracking-[0.15em] text-ink">连接 · CONNECT</span>
        <button
          type="button"
          class="rounded-sm border border-hairline px-2 py-0.5 font-mono text-[10px] text-body hover:border-err/50 hover:text-err"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>

      <!-- 主体:左导航 + 右内容 -->
      <div class="flex min-h-0 flex-1">
        <!-- 左导航:WorkspaceRail 激活态范式 -->
        <nav class="flex w-44 shrink-0 flex-col border-r border-hairline">
          <div class="px-4 pb-2 pt-3.5">
            <span class="font-display text-[10px] font-semibold tracking-[0.2em] text-mute">配置 · CONFIG</span>
          </div>
          <div class="min-h-0 flex-1 space-y-1.5 px-2.5 py-1">
            <!-- Tab 1:API Keys(默认激活) -->
            <button
              type="button"
              class="block w-full rounded-sm border-l-2 px-3 py-2.5 text-left transition-colors duration-200"
              :class="activeTab === 'api' ? 'border-l-primary bg-canvas-soft' : 'border-l-transparent hover:bg-canvas-soft/60'"
              @click="activeTab = 'api'"
            >
              <span
                class="block truncate text-[13px] font-medium"
                :class="activeTab === 'api' ? 'text-ink' : 'text-body'"
              >API Keys</span>
              <span class="mt-0.5 block truncate font-mono text-[10px] text-mute">对话模型 · 网络搜索</span>
            </button>
            <!-- Tab 2:MCP Servers -->
            <button
              type="button"
              class="block w-full rounded-sm border-l-2 px-3 py-2.5 text-left transition-colors duration-200"
              :class="activeTab === 'mcp' ? 'border-l-primary bg-canvas-soft' : 'border-l-transparent hover:bg-canvas-soft/60'"
              @click="activeTab = 'mcp'"
            >
              <span
                class="block truncate text-[13px] font-medium"
                :class="activeTab === 'mcp' ? 'text-ink' : 'text-body'"
              >MCP Servers</span>
              <span class="mt-0.5 block truncate font-mono text-[10px] text-mute">外部工具</span>
            </button>
          </div>
        </nav>

        <!-- 右内容区:独立滚动 -->
        <main class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <ApiKeysPanel
            v-show="activeTab === 'api'"
            :agent="agent"
            :meta="meta"
          />
          <McpPanel
            v-show="activeTab === 'mcp'"
            :agent="agent"
          />
        </main>
      </div>

      <!-- 底部环境信息:常驻 footer -->
      <div
        v-if="meta"
        class="flex shrink-0 items-center justify-between gap-4 border-t border-hairline px-5 py-2.5 font-mono text-[10px] leading-relaxed text-mute"
      >
        <p class="flex items-center gap-2">
          <span>环境</span><span class="text-body">{{ meta.environment }}</span>
        </p>
        <p class="flex min-w-0 items-center gap-2">
          <span class="shrink-0">配置目录</span>
          <span
            class="truncate text-body"
            :title="meta.workflowsRoot"
          >{{ meta.workflowsRoot }}</span>
        </p>
      </div>
    </div>
  </div>
</template>
