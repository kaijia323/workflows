<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ArrowUpDown, Pause } from '@lucide/vue'
import type { SkillInfo, SkillSource } from '@workflows/shared'
import type { AgentStore, PlanBlock, UiMessage } from '../composables/useAgent'
import { findToolSegment, hasThinking, isThinkingBlockOpen, messageText, planBlocks } from '../composables/useAgent'
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
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const stickToBottom = ref(true)
const sendError = ref<string | null>(null)
const rejectDraft = ref('')

/* ---------------- / skill 搜索下拉 ---------------- */

const skillMenuOpen = ref(false)
const skillIndex = ref(0)
/** 查询词:draft 以 / 开头时取 / 之后的部分,否则空串 */
const skillQuery = computed(() => (draft.value.startsWith('/') ? draft.value.slice(1) : ''))
const allSkills = computed(() => props.agent.skills.value)

const SOURCE_LABEL: Record<SkillSource, string> = {
  'pi-agent': '全局(pi)',
  'pi-project': '项目',
  workspace: '工作台',
  'global-agents': '全局(agents)',
  path: '其他',
}

/** 过滤:名称前缀 > 名称包含 > 描述包含,取前 8 条;空查询 = 全量 */
const filteredSkills = computed(() => {
  const q = skillQuery.value.trim().toLowerCase()
  const all = allSkills.value
  if (!q) return all.slice(0, 8)
  const prefix: SkillInfo[] = []
  const contains: SkillInfo[] = []
  const desc: SkillInfo[] = []
  for (const s of all) {
    const name = s.name.toLowerCase()
    if (name.startsWith(q)) prefix.push(s)
    else if (name.includes(q)) contains.push(s)
    else if (s.description.toLowerCase().includes(q)) desc.push(s)
  }
  return [...prefix, ...contains, ...desc].slice(0, 8)
})

watch(
  () => [draft.value, props.agent.streaming.value, props.agent.activeWorkspaceId.value] as const,
  (current, previous: readonly [string, boolean, string | null]) => {
    const [text, streaming, workspaceId] = current
    const prevWorkspace = previous[2]
    // 切工作区:直接关闭(下拉属于旧工作区)
    if (workspaceId !== prevWorkspace) {
      skillMenuOpen.value = false
      return
    }
    // 打开条件:draft 以 / 开头、非流式、有匹配(空查询 = 全量展示)
    const query = text.startsWith('/') ? text.slice(1) : ''
    const shouldOpen =
      text.startsWith('/') && !streaming && (query.trim() === '' || filteredSkills.value.length > 0)
    skillMenuOpen.value = shouldOpen
    if (shouldOpen) skillIndex.value = 0
  },
)

function selectSkill(skill: SkillInfo) {
  draft.value = `/skill:${skill.name} `
  skillMenuOpen.value = false
  nextTick(() => textareaRef.value?.focus())
}

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
  // 菜单打开且有匹配项:方向键循环高亮、Enter/Tab 选中填入(不发送)、Esc 关闭。
  // IME 组合输入(中文输入法)期间不拦截,避免误选;菜单未打开时 Tab 走浏览器默认(焦点移动)。
  if (skillMenuOpen.value && filteredSkills.value.length > 0 && !event.isComposing) {
    const count = filteredSkills.value.length
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      skillIndex.value = (skillIndex.value + 1) % count
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      skillIndex.value = (skillIndex.value - 1 + count) % count
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      const skill = filteredSkills.value[skillIndex.value]
      if (skill) selectSkill(skill)
      return
    }
    if (event.key === 'Tab') {
      // 与 Enter 同行为:选中当前高亮 skill 填入 /skill:<name>(不发送);preventDefault 避免焦点移出输入框
      event.preventDefault()
      const skill = filteredSkills.value[skillIndex.value]
      if (skill) selectSkill(skill)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      skillMenuOpen.value = false
      return
    }
  }
  // 菜单打开但无匹配(或 IME 组合中):Enter/Esc 走原逻辑(不拦截)
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void handleSend()
  }
}

/** 单条思考块:用户手动操作,标记后以用户状态为准(不再自动收起/展开) */
function toggleThinking(message: UiMessage, key: string) {
  message.thinkingTouched.add(key)
  const open = message.thinkingOpen
  if (open.has(key)) open.delete(key)
  else open.add(key)
}

/** 全部思考块统一操作:按生效状态(含自动展开的流式块)判断,任一展开则全部收起,否则全部展开;并全部标记为手动 */
function toggleAllThinking() {
  const entries: Array<{ message: UiMessage; blocks: PlanBlock[]; key: string }> = []
  for (const message of props.agent.messages.value) {
    const blocks = planBlocks(message)
    for (const block of blocks) {
      if (block.kind === 'thinking') entries.push({ message, blocks, key: block.key })
    }
  }
  if (entries.length === 0) return
  const allOpen = entries.every(({ message, blocks, key }) => isThinkingBlockOpen(message, blocks, key))
  for (const { message, key } of entries) {
    message.thinkingTouched.add(key)
    if (allOpen) message.thinkingOpen.delete(key)
    else message.thinkingOpen.add(key)
  }
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
  <section class="flex min-w-0 flex-1 flex-col bg-canvas">
    <!-- 工作区头部:处理节点标签 -->
    <div class="flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-5">
      <template v-if="agent.activeWorkspace.value">
        <span class="size-2 border border-primary/70 bg-primary/30" />
        <span class="font-display text-xs tracking-widest text-ink">{{ agent.activeWorkspace.value.name }}</span>
        <span class="max-w-72 truncate font-mono text-[10px] text-mute">{{ agent.activeWorkspace.value.path }}</span>
        <span
          class="rounded-full border px-2 py-px font-mono text-[10px]"
          :class="agent.activeWorkspace.value.readOnly ? 'border-primary/40 text-primary' : 'border-hairline text-mute'"
        >
          {{ agent.activeWorkspace.value.readOnly ? '只读' : '读写' }}
        </span>
        <span class="ml-auto font-mono text-[10px] text-mute">
          {{ agent.status.value?.messageCount ?? 0 }} msgs
        </span>
        <SessionSwitcher :agent="agent" />
      </template>
      <span
        v-else
        class="font-display text-xs tracking-widest text-mute"
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
          <div class="mx-auto grid size-14 place-items-center rounded-md border border-hairline bg-canvas-soft">
            <span class="grid size-6 place-items-center rounded-sm border border-primary/50 bg-primary/10">
              <span class="size-1.5 bg-primary" />
            </span>
          </div>
          <h2 class="mt-5 font-display text-sm tracking-[0.25em] text-ink">
            AGENT 控制台
          </h2>
          <p class="mt-3 text-xs leading-relaxed text-body">
            在左侧选择工作区,<br>agent 将在该目录内读取、分析并修改代码。
          </p>
          <button
            v-if="!agent.hasApiKey.value"
            type="button"
            class="mt-6 rounded-sm bg-primary px-5 py-2 font-display text-[11px] tracking-widest text-on-primary transition hover:bg-primary-soft"
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
    <div class="shrink-0 border-t border-hairline bg-canvas px-5 pb-3.5 pt-3">
      <!-- 闸门:计划待批准 -->
      <div
        v-if="agent.gateRequest.value"
        class="mb-2.5 rounded-md border border-primary/50 bg-primary/5 px-4 py-3"
      >
        <div class="flex items-center gap-2">
          <span class="grid size-4 place-items-center rounded-sm border border-primary/70 bg-primary/10 text-primary"><Pause class="size-3" /></span>
          <span class="font-display text-[10px] tracking-[0.2em] text-primary">计划待批准</span>
          <span
            v-if="agent.gateRequest.value.planFile"
            class="truncate font-mono text-[10px] text-mute"
          >{{ agent.gateRequest.value.planFile }}</span>
        </div>
        <p
          v-if="agent.gateRequest.value.summary"
          class="mt-2 text-xs leading-relaxed text-body"
        >
          {{ agent.gateRequest.value.summary }}
        </p>
        <div class="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            class="rounded-sm bg-primary px-4 py-1.5 font-display text-[10px] tracking-widest text-on-primary transition hover:bg-primary-soft disabled:opacity-40"
            :disabled="agent.streaming.value"
            @click="approvePlan"
          >
            批准执行
          </button>
          <input
            id="reject-reason"
            v-model="rejectDraft"
            type="text"
            :disabled="agent.streaming.value"
            placeholder="驳回意见(回 planner 修改)…"
            class="min-w-0 flex-1 rounded-sm border border-hairline bg-canvas-soft px-3 py-1.5 text-[13px] text-ink placeholder:text-mute focus:border-primary"
          >
          <button
            type="button"
            class="shrink-0 rounded-sm border border-err/60 px-3 py-1.5 font-display text-[10px] tracking-widest text-err transition hover:bg-err/10 disabled:opacity-40"
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
        class="mb-2 flex items-center gap-2 font-mono text-[10px] text-primary/90"
      >
        <span class="size-1.5 animate-pulse rounded-full bg-primary" />
        尚未配置 API key ——
        <button
          type="button"
          class="underline decoration-dotted underline-offset-2 hover:text-primary"
          @click="onOpenSettings"
        >
          立即配置
        </button>
      </p>

      <div class="flex items-center gap-2">
        <div class="relative flex-1">
          <!-- 可访问名称:主聊天输入框(placeholder 仅作格式示例) -->
          <label
            for="chat-input"
            class="sr-only"
          >消息输入</label>
          <!-- / skill 搜索下拉(选中后填入 /skill:<name>,由用户回车发送) -->
          <div
            v-if="skillMenuOpen"
            class="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-64 overflow-y-auto rounded-md border border-hairline bg-canvas shadow-lg"
          >
            <button
              v-for="(skill, i) in filteredSkills"
              :key="skill.name"
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left transition"
              :class="i === skillIndex ? 'bg-primary/10' : 'hover:bg-canvas-soft'"
              @mousedown.prevent
              @click="selectSkill(skill)"
            >
              <span class="shrink-0 font-mono text-[12px] text-ink">/skill:{{ skill.name }}</span>
              <span class="min-w-0 flex-1 truncate text-[11px] text-mute">{{ skill.description }}</span>
              <span class="shrink-0 rounded-sm border border-hairline px-1.5 py-px font-mono text-[9px] text-mute">
                {{ SOURCE_LABEL[skill.source] }}
              </span>
            </button>
            <p
              v-if="filteredSkills.length === 0"
              class="px-3 py-2 font-mono text-[11px] text-mute"
            >
              无可用 skill
            </p>
          </div>
          <textarea
            id="chat-input"
            ref="textareaRef"
            v-model="draft"
            :disabled="!agent.activeWorkspaceId.value"
            rows="1"
            spellcheck="false"
            :placeholder="agent.activeWorkspaceId.value ? '输入消息,输入 / 可搜索 skills,Enter 发送,Shift+Enter 换行…' : '先在左侧选择一个工作区'"
            class="block max-h-40 min-h-[40px] w-full resize-none rounded-sm border border-hairline bg-canvas-soft px-4 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-mute focus:border-primary disabled:opacity-50"
            @keydown="onKeydown"
            @blur="skillMenuOpen = false"
          />
        </div>
        <button
          v-if="agent.streaming.value"
          type="button"
          class="shrink-0 rounded-sm border border-err/60 bg-err/10 px-4 py-2.5 font-display text-[11px] tracking-widest text-err transition hover:bg-err/20"
          @click="agent.abort()"
        >
          停止
        </button>
        <button
          v-else
          type="button"
          class="shrink-0 rounded-sm bg-primary px-4 py-2.5 font-display text-[11px] font-semibold tracking-widest text-on-primary transition hover:bg-primary-soft disabled:opacity-40"
          :disabled="!draft.trim() || !agent.activeWorkspaceId.value"
          @click="handleSend"
        >
          发送
        </button>
      </div>

      <!-- 模型 / 思考级别快速切换(聊天框下方) -->
      <div class="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div class="flex items-center gap-1.5">
          <span class="font-display text-[10px] tracking-[0.2em] text-mute">MODEL</span>
          <div class="flex gap-px rounded-sm border border-hairline bg-canvas-soft p-px">
            <button
              v-for="m in agent.config.value?.models ?? []"
              :key="m.id"
              type="button"
              class="rounded-[3px] px-2 py-1 font-mono text-[10px] transition disabled:opacity-40"
              :class="agent.config.value?.model === m.id ? 'bg-primary/15 text-primary' : 'text-body hover:text-ink'"
              :disabled="agent.streaming.value"
              @click="agent.switchModel(m.id)"
            >
              {{ m.id.replace('deepseek-', '') }}
            </button>
          </div>
        </div>

        <div class="flex items-center gap-1.5">
          <span class="font-display text-[10px] tracking-[0.2em] text-mute">THINK</span>
          <div class="flex gap-px rounded-sm border border-hairline bg-canvas-soft p-px">
            <button
              v-for="level in agent.config.value?.thinkingLevels ?? ['off']"
              :key="level"
              type="button"
              class="rounded-[3px] px-2 py-1 font-mono text-[10px] transition disabled:opacity-40"
              :class="agent.config.value?.thinkingLevel === level ? 'bg-primary/15 text-primary' : 'text-body hover:text-ink'"
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
            class="flex items-center gap-1 rounded-sm border border-hairline px-2 py-1 font-mono text-[10px] text-mute transition hover:text-ink"
            @click="toggleAllThinking"
          >
            THINKING
            <ArrowUpDown class="size-3" />
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
