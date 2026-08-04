<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown, ChevronRight, TriangleAlert } from '@lucide/vue'
import type { PlanBlock, UiMessage } from '../composables/useAgent'
import { isThinkingBlockOpen, messageText, planBlocks, toolLabel } from '../composables/useAgent'
import { renderMarkdown } from '../utils/markdown'

const props = defineProps<{ message: UiMessage }>()
const emit = defineEmits<{
  'toggle-thinking': [message: UiMessage, key: string]
  'toggle-tool': [message: UiMessage, callId: string]
  'tool-click': [message: UiMessage, callId: string, toolName: string]
}>()

/** 流式光标 HTML(模板内不便内联引号,提取为常量) */
const CARET_HTML = '<span class="caret"></span>'

/**
 * 渲染计划:segments → 可视块(相邻 text/thinking 合并,key 稳定)。
 * 思考块展开状态按 key 逐个独立记录;流式时光标精确跟随最后一个 text 块。
 */
type RenderBlock = PlanBlock & { caret?: boolean }

const plan = computed<RenderBlock[]>(() => {
  const out: RenderBlock[] = planBlocks(props.message)
  // 流式光标:跟随最后一个 text 块(与最后一次渲染的字符对齐)
  if (props.message.status === 'streaming') {
    for (let i = out.length - 1; i >= 0; i--) {
      const block = out[i]
      if (block.kind === 'text') {
        block.caret = true
        break
      }
    }
  }
  return out
})

/** 只有思考/工具、没有正文时,流式期间在底部显示光标 */
const showCaretRow = computed(
  () => props.message.status === 'streaming' && !plan.value.some((b) => b.kind === 'text'),
)

function formatTokens(n: number | undefined): string {
  if (n === undefined) return ''
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
</script>

<template>
  <!-- 用户消息:右对齐 -->
  <div
    v-if="message.role === 'user'"
    class="flex justify-end pl-12"
  >
    <div class="max-w-[85%] border border-signal/30 bg-signal/[0.05] px-3.5 py-2.5">
      <div
        class="md break-words text-[13px] leading-relaxed text-fg"
        v-html="renderMarkdown(messageText(message))"
      />
    </div>
  </div>

  <!-- 助手消息:节点卡 + 入边(端口)。内容严格按大模型输出顺序渲染:思考 / 正文 / 工具交错 -->
  <div
    v-else
    class="relative flex pl-7"
  >
    <!-- 入边:从上方端口下来的竖线 -->
    <div class="absolute left-2.5 top-0 h-full w-px bg-edge">
      <span class="absolute -left-[3px] top-1.5 size-[7px] border border-signal/60 bg-ink" />
    </div>

    <div
      class="min-w-0 max-w-full flex-1 border bg-raised/60 transition-colors"
      :class="message.status === 'error' ? 'border-err/40' : 'border-edge'"
    >
      <template v-if="plan.length > 0">
        <template
          v-for="(block, i) in plan"
          :key="block.key"
        >
          <!-- 思考片段 -->
          <div
            v-if="block.kind === 'thinking'"
            class="border-t border-edge/70"
            :class="i === 0 ? 'border-t-0' : ''"
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3.5 py-1.5 text-left font-mono text-[10px] tracking-wider text-wire transition hover:bg-wire/[0.06]"
              @click="emit('toggle-thinking', message, block.key)"
            >
              <span
                class="inline-block w-3 text-center transition-transform duration-200"
                :class="isThinkingBlockOpen(message, plan, block.key) ? 'rotate-90' : ''"
              ><ChevronRight class="size-3" /></span>
              <span class="text-wire/80">THINKING</span>
              <span class="ml-auto font-mono text-[9px] text-faint">{{ block.text.length }} chars</span>
            </button>
            <pre
              v-if="isThinkingBlockOpen(message, plan, block.key)"
              class="max-h-64 overflow-y-auto whitespace-pre-wrap break-words px-3.5 pb-3 pl-8 font-mono text-[11px] leading-relaxed text-wire/70"
            >{{ block.text }}</pre>
          </div>

          <!-- 正文片段 -->
          <div
            v-else-if="block.kind === 'text'"
            class="px-3.5 py-3"
            :class="i > 0 ? 'border-t border-edge/70' : ''"
          >
            <div
              class="md break-words text-[13px] leading-relaxed text-fg"
              v-html="renderMarkdown(block.text) + (block.caret ? CARET_HTML : '')"
            />
          </div>

          <!-- 工具调用片段:按输出顺序穿插在思考 / 正文之间 -->
          <div
            v-else-if="block.kind === 'tool'"
            class="border-t border-edge/70"
          >
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3.5 py-1.5 text-left transition hover:bg-ink/40"
              @click="emit('tool-click', message, block.tool.callId, block.tool.name)"
            >
              <span
                class="size-1.5 shrink-0 rounded-full"
                :class="block.tool.isError ? 'bg-err' : 'bg-ok'"
              />
              <span class="font-display text-[10px] tracking-widest text-dim">{{ toolLabel(block.tool.name) }}</span>
              <span class="truncate font-mono text-[10px] text-faint">{{ block.tool.name }}</span>
              <span
                class="ml-auto flex shrink-0 items-center gap-1 font-mono text-[9px] tracking-wider"
                :class="block.tool.isError ? 'text-err/80' : 'text-faint'"
              >
                <ChevronRight
                  v-if="block.tool.collapsed"
                  class="size-3"
                />
                <ChevronDown
                  v-else
                  class="size-3"
                />
                {{ block.tool.collapsed ? '详情' : '收起' }}
              </span>
            </button>
            <pre
              v-if="!block.tool.collapsed && block.tool.output"
              class="max-h-56 overflow-y-auto whitespace-pre-wrap break-words border-t border-edge/40 bg-ink/60 px-3.5 py-2.5 pl-7 font-mono text-[10.5px] leading-relaxed"
              :class="block.tool.isError ? 'text-err/90' : 'text-dim'"
            >{{ block.tool.output }}</pre>
          </div>
        </template>
      </template>

      <!-- 只有思考 / 工具、尚无正文时,流式期间显示光标 -->
      <div
        v-else-if="showCaretRow"
        class="px-3.5 py-3"
      >
        <span class="caret" />
      </div>

      <!-- 错误 -->
      <div
        v-if="message.status === 'error' && message.errorText"
        class="border-t border-err/30 px-3.5 py-2"
      >
        <p class="font-mono text-[11px] text-err">
          <TriangleAlert class="mr-1 inline-block size-3.5 align-[-2px]" />
          {{ message.errorText }}
        </p>
      </div>

      <!-- 页脚:模型 + token -->
      <div
        v-if="message.model || message.usage?.totalTokens"
        class="flex items-center gap-3 px-3.5 py-1.5 font-mono text-[9px] text-faint"
      >
        <span
          v-if="message.model"
          class="tracking-wider"
        >{{ message.model }}</span>
        <span v-if="message.usage?.totalTokens">
          {{ formatTokens(message.usage.input) }} in / {{ formatTokens(message.usage.output) }} out · {{ formatTokens(message.usage.totalTokens) }} tok
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.caret,
:deep(.caret) {
  display: inline-block;
  width: 6px;
  height: 13px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--color-signal);
  animation: caret-blink 0.9s steps(2) infinite;
}

/* ---- markdown 正文:与「管线控制台」token 统一 ---- */
:deep(.md) p {
  margin: 0.4em 0;
}
:deep(.md) p:first-child,
:deep(.md) ul:first-child,
:deep(.md) ol:first-child,
:deep(.md) pre:first-child,
:deep(.md) blockquote:first-child,
:deep(.md) table:first-child,
:deep(.md) h1:first-child,
:deep(.md) h2:first-child,
:deep(.md) h3:first-child,
:deep(.md) h4:first-child {
  margin-top: 0;
}
:deep(.md) p:last-child,
:deep(.md) ul:last-child,
:deep(.md) ol:last-child,
:deep(.md) pre:last-child,
:deep(.md) blockquote:last-child,
:deep(.md) table:last-child,
:deep(.md) h1:last-child,
:deep(.md) h2:last-child,
:deep(.md) h3:last-child,
:deep(.md) h4:last-child {
  margin-bottom: 0;
}

/* 标题:显示字体 + 信号琥珀点缀,保持仪表台气质 */
:deep(.md) h1,
:deep(.md) h2,
:deep(.md) h3,
:deep(.md) h4 {
  margin: 0.7em 0 0.3em;
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--color-fg);
}
:deep(.md) h1 {
  font-size: 1.1em;
  border-bottom: 1px solid var(--color-edge);
  padding-bottom: 0.25em;
}
:deep(.md) h2 {
  font-size: 1.05em;
}
:deep(.md) h3,
:deep(.md) h4 {
  font-size: 1em;
}

/* 代码块:墨底 + 线缆蓝左边条,与工具输出的 pre 呼应 */
:deep(.md) pre {
  margin: 0.5em 0;
  padding: 8px 10px;
  overflow-x: auto;
  background: var(--color-ink);
  border: 1px solid var(--color-edge);
  border-left: 2px solid var(--color-wire-dim);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--color-dim);
}
:deep(.md) code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 0.1em 0.35em;
  border-radius: 3px;
  background: color-mix(in srgb, var(--color-edge) 55%, transparent);
}
:deep(.md) pre code {
  padding: 0;
  background: transparent;
  font-size: inherit;
  color: inherit;
}

/* 链接:线缆蓝,新窗口打开 */
:deep(.md) a {
  color: var(--color-wire);
  text-decoration: underline;
  text-decoration-color: var(--color-wire-dim);
  text-underline-offset: 2px;
}
:deep(.md) a:hover {
  color: var(--color-signal);
  text-decoration-color: var(--color-signal-dim);
}

/* 列表 / 引用 / 分割线 */
:deep(.md) ul {
  margin: 0.4em 0;
  padding-left: 1.3em;
  list-style: disc;
}
:deep(.md) ol {
  margin: 0.4em 0;
  padding-left: 1.3em;
  list-style: decimal;
}
:deep(.md) li {
  margin: 0.15em 0;
}
:deep(.md) li > ul,
:deep(.md) li > ol {
  margin: 0.15em 0;
}
:deep(.md) blockquote {
  margin: 0.5em 0;
  padding: 0.1em 0 0.1em 0.8em;
  border-left: 2px solid var(--color-wire-dim);
  color: var(--color-dim);
}
:deep(.md) hr {
  margin: 0.7em 0;
  border: none;
  border-top: 1px solid var(--color-edge);
}

/* 表格:仪表盘式的细边框网格 */
:deep(.md) table {
  margin: 0.5em 0;
  width: 100%;
  border-collapse: collapse;
  font-size: 0.95em;
}
:deep(.md) th,
:deep(.md) td {
  border: 1px solid var(--color-edge);
  padding: 4px 8px;
  text-align: left;
}
:deep(.md) th {
  background: var(--color-raised);
  font-family: var(--font-display);
  font-size: 0.92em;
  font-weight: 600;
  letter-spacing: 0.03em;
}

:deep(.md) strong {
  color: var(--color-fg);
  font-weight: 600;
}
:deep(.md) del {
  color: var(--color-faint);
}
:deep(.md) input[type='checkbox'] {
  margin-right: 0.4em;
  accent-color: var(--color-signal);
  vertical-align: -2px;
}
</style>
