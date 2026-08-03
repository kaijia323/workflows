<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import type { AgentStore, UiMessage } from '../composables/useAgent'
import { findToolSegment, hasThinking, messageText } from '../composables/useAgent'
import MessageBubble from './MessageBubble.vue'
import SessionSwitcher from './SessionSwitcher.vue'

/**
 * 中栏:聊天区(处理节点)。
 * 输入框下方为模型 / 思考级别快速切换器。
 */
const props = defineProps<{
  agent: AgentStore
  onOpenSettings: () => void
}>()

const emit = defineEmits<{
  openSub: [callId: string, agentName: string]
}>()

const draft = ref('')
const scroller = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)
const sendError = ref<string | null>(null)
const rejectDraft = ref('')

function onScroll() {
  const el = scroller.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

async function scrollToBottom(smooth = false) {
  const el = scroller.value
  if (!el) return
  el.scrollTo?.({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

watch(
  () => [props.agent.messages.value.length, props.agent.messages.value.at(-1) ? messageText(props.agent.messages.value.at(-1)!) : 0],
  async () => {
    if (stickToBottom.value) {
      await nextTick()
      scrollToBottom()
    }
  },
)

onMounted(() => scrollToBottom())

async function handleSend() {
  const text = draft.value.trim()
  if (!text || props.agent.streaming.value || !props.agent.activeWorkspaceId.value) return
  sendError.value = null
  draft.value = ''
  stickToBottom.value = true
  try {
    await props.agent.sendMessage(text)
  } catch (error) {
    sendError.value = error instanceof Error ? error.message : String(error)
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void handleSend()
  }
}

function toggleThinking(message: { thinkingOpen: boolean }) {
  message.thinkingOpen = !message.thinkingOpen
}

function toggleTool(message: UiMessage, callId: string) {
  const tool = findToolSegment(message, callId)
  if (tool) tool.collapsed = !tool.collapsed
}

/** 工具块点击:子代理调用(有 sub 会话或 run 记录)打开模态窗 */
function onToolClick(message: UiMessage, callId: string, toolName: string) {
  const hasSub = props.agent.subSessions.has(callId)
  const hasRun = props.agent.run.value?.agents.some((a) => a.callId === callId)
  if (hasSub || hasRun) {
    emit('openSub', callId, toolName)
    return
  }
  toggleTool(message, callId)
}

/** 闸门:批准计划 */
async function approvePlan(): Promise<void> {
  sendError.value = null
  props.agent.dismissGate()
  try {
    await props.agent.sendMessage('用户已批准计划,继续执行')
  } catch (error) {
    sendError.value = error instanceof Error ? error.message : String(error)
  }
}

/** 闸门:驳回计划(带意见回 planner) */
async function rejectPlan(): Promise<void> {
  const reason = rejectDraft.value.trim()
  if (!reason) return
  sendError.value = null
  props.agent.dismissGate()
  rejectDraft.value = ''
  try {
    await props.agent.sendMessage(`用户驳回:${reason},请修改计划`)
  } catch (error) {
    sendError.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col bg-ink">
    <!-- 工作区头部:处理节点标签 -->
    <div class="flex h-12 shrink-0 items-center gap-3 border-b border-edge px-5">
      <template v-if="agent.activeWorkspace.value">
        <span class="size-2 border border-signal/70 bg-signal/30" />
        <span class="font-display text-xs tracking-widest text-fg">{{ agent.activeWorkspace.value.name }}</span>
        <span class="max-w-72 truncate font-mono text-[10px] text-faint">{{ agent.activeWorkspace.value.path }}</span>
        <span
          class="border px-1.5 py-px font-mono text-[9px] tracking-wider"
          :class="agent.activeWorkspace.value.readOnly ? 'border-ok/40 text-ok/80' : 'border-faint/40 text-faint'"
        >
          {{ agent.activeWorkspace.value.readOnly ? '只读' : '读写' }}
        </span>
        <span class="ml-auto font-mono text-[10px] text-faint">
          {{ agent.status.value?.messageCount ?? 0 }} msgs
        </span>
        <SessionSwitcher :agent="agent" />
      </template>
      <span
        v-else
        class="font-display text-xs tracking-widest text-faint"
      >等待接入工作区</span>
    </div>

    <!-- 消息流 -->
    <div
      ref="scroller"
      class="min-h-0 flex-1 overflow-y-auto px-5 py-4"
      @scroll="onScroll"
    >
      <!-- 空状态 -->
      <div
        v-if="agent.messages.value.length === 0"
        class="grid h-full place-items-center"
      >
        <div class="max-w-sm text-center">
          <div class="mx-auto grid size-14 place-items-center border border-edge bg-raised">
            <span class="grid size-6 place-items-center border border-wire/50 bg-wire/10">
              <span class="size-1.5 bg-wire" />
            </span>
          </div>
          <h2 class="mt-5 font-display text-sm tracking-[0.25em] text-fg">
            AGENT 控制台
          </h2>
          <p class="mt-3 text-xs leading-relaxed text-dim">
            在左侧选择工作区,<br>agent 将在该目录内读取、分析并修改代码。
          </p>
          <button
            v-if="!agent.hasApiKey.value"
            type="button"
            class="mt-6 border border-signal/50 bg-signal/10 px-5 py-2 font-display text-[11px] tracking-widest text-signal transition hover:bg-signal/20"
            @click="onOpenSettings"
          >
            配置 DeepSeek API KEY
          </button>
        </div>
      </div>

      <!-- 消息列表 -->
      <div
        v-else
        class="mx-auto flex max-w-3xl flex-col gap-4"
      >
        <MessageBubble
          v-for="msg in agent.messages.value"
          :key="msg.id"
          :message="msg"
          @toggle-thinking="toggleThinking"
          @toggle-tool="toggleTool"
          @tool-click="onToolClick"
        />
      </div>
    </div>

    <!-- 输入区 -->
    <div class="shrink-0 border-t border-edge bg-panel/60 px-5 pb-3.5 pt-3">
      <!-- 闸门:计划待批准 -->
      <div
        v-if="agent.gateRequest.value"
        class="mb-2.5 border border-signal/50 bg-signal/5 px-3.5 py-3"
      >
        <div class="flex items-center gap-2">
          <span class="grid size-4 place-items-center border border-signal/70 bg-signal/10 text-[9px] leading-none text-signal">⏸</span>
          <span class="font-display text-[10px] tracking-[0.2em] text-signal">计划待批准</span>
          <span
            v-if="agent.gateRequest.value.planFile"
            class="truncate font-mono text-[9px] text-faint"
          >{{ agent.gateRequest.value.planFile }}</span>
        </div>
        <p
          v-if="agent.gateRequest.value.summary"
          class="mt-2 text-[12px] leading-relaxed text-dim"
        >
          {{ agent.gateRequest.value.summary }}
        </p>
        <div class="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            class="border border-ok/60 bg-ok/10 px-4 py-1.5 font-display text-[10px] tracking-widest text-ok transition hover:bg-ok/20 disabled:opacity-40"
            :disabled="agent.streaming.value"
            @click="approvePlan"
          >
            批准执行
          </button>
          <input
            v-model="rejectDraft"
            type="text"
            :disabled="agent.streaming.value"
            placeholder="驳回意见(回 planner 修改)…"
            class="min-w-0 flex-1 border border-edge bg-ink px-2.5 py-1.5 text-[11px] text-fg placeholder:text-faint focus:border-signal/60"
          >
          <button
            type="button"
            class="shrink-0 border border-err/50 bg-err/5 px-3 py-1.5 font-display text-[10px] tracking-widest text-err transition hover:bg-err/15 disabled:opacity-40"
            :disabled="!rejectDraft.trim() || agent.streaming.value"
            @click="rejectPlan"
          >
            驳回
          </button>
        </div>
      </div>

      <p
        v-if="sendError"
        class="mb-2 font-mono text-[10px] text-err"
      >
        {{ sendError }}
      </p>
      <p
        v-if="!agent.hasApiKey.value"
        class="mb-2 flex items-center gap-2 font-mono text-[10px] text-signal/90"
      >
        <span class="size-1.5 animate-pulse rounded-full bg-signal" />
        尚未配置 API key ——
        <button
          type="button"
          class="underline decoration-dotted underline-offset-2 hover:text-signal"
          @click="onOpenSettings"
        >
          立即配置
        </button>
      </p>

      <div class="flex items-end gap-2">
        <textarea
          v-model="draft"
          :disabled="!agent.activeWorkspaceId.value"
          rows="1"
          spellcheck="false"
          :placeholder="agent.activeWorkspaceId.value ? '输入指令,Enter 发送,Shift+Enter 换行…' : '先在左侧选择一个工作区'"
          class="max-h-40 min-h-[40px] flex-1 resize-none border border-edge bg-ink px-3.5 py-2.5 text-[13px] leading-relaxed text-fg placeholder:text-faint focus:border-signal/60 disabled:opacity-50"
          @keydown="onKeydown"
        />
        <button
          v-if="agent.streaming.value"
          type="button"
          class="shrink-0 border border-err/50 bg-err/10 px-4 py-2.5 font-display text-[11px] tracking-widest text-err transition hover:bg-err/20"
          @click="agent.abort()"
        >
          停止
        </button>
        <button
          v-else
          type="button"
          class="shrink-0 border border-signal/60 bg-signal px-4 py-2.5 font-display text-[11px] font-semibold tracking-widest text-ink transition hover:bg-signal/90 disabled:opacity-40"
          :disabled="!draft.trim() || !agent.activeWorkspaceId.value"
          @click="handleSend"
        >
          发送
        </button>
      </div>

      <!-- 模型 / 思考级别快速切换(聊天框下方) -->
      <div class="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div class="flex items-center gap-1.5">
          <span class="font-display text-[9px] tracking-[0.2em] text-faint">MODEL</span>
          <div class="flex gap-px border border-edge bg-ink p-px">
            <button
              v-for="m in agent.config.value?.models ?? []"
              :key="m.id"
              type="button"
              class="px-2 py-1 font-mono text-[10px] transition disabled:opacity-40"
              :class="agent.config.value?.model === m.id ? 'bg-signal/15 text-signal' : 'text-dim hover:text-fg'"
              :disabled="agent.streaming.value"
              @click="agent.switchModel(m.id)"
            >
              {{ m.id.replace('deepseek-', '') }}
            </button>
          </div>
        </div>

        <div class="flex items-center gap-1.5">
          <span class="font-display text-[9px] tracking-[0.2em] text-faint">THINK</span>
          <div class="flex gap-px border border-edge bg-ink p-px">
            <button
              v-for="level in agent.config.value?.thinkingLevels ?? ['off']"
              :key="level"
              type="button"
              class="px-2 py-1 font-mono text-[10px] transition disabled:opacity-40"
              :class="agent.config.value?.thinkingLevel === level ? 'bg-wire/15 text-wire' : 'text-dim hover:text-fg'"
              :disabled="agent.streaming.value"
              @click="agent.switchThinking(level)"
            >
              {{ level }}
            </button>
          </div>
        </div>

        <!-- 折叠/展开全部 thinking 的快捷操作 -->
        <div
          v-if="agent.messages.value.some(hasThinking)"
          class="ml-auto flex gap-1"
        >
          <button
            type="button"
            class="border border-edge px-2 py-1 font-mono text-[9px] text-faint transition hover:text-fg"
            @click="agent.messages.value.filter(hasThinking).forEach(toggleThinking)"
          >
            THINKING ⇅
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
