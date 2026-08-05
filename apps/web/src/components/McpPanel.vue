<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { McpServerConfig, McpToolInfo } from '@workflows/shared'
import type { AgentStore } from '../composables/useAgent'

/**
 * 解析 env 文本(每行 KEY=VALUE):
 * - 空行忽略;行首尾空白忽略(trim);
 * - 按【第一个】= 切分:key 取左侧并 trim,value 取右侧【原样保留】
 *   (值允许含空格与 = 符号,如 `GREETING=hello world`、`URL=https://x?a=1`);
 * - 无 = 或 = 开头(空 key)的行 → 返回错误(含行号与原文),零容忍整体拦截。
 */
function parseEnvText(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue
    const eq = line.indexOf('=')
    if (eq <= 0) {
      return {
        env: {},
        error: `env 第 ${i + 1} 行缺少「=」,每行需为 KEY=VALUE(如 API_KEY=sk-xxx):${line}`,
      }
    }
    env[line.slice(0, eq).trim()] = line.slice(eq + 1)
  }
  return { env, error: null }
}

/** 列表摘要:KEY=VAL 以空格拼接(悬浮 title 展示完整原文) */
function envSummary(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')
}

/**
 * MCP server 管理面板(内嵌于 ApiKeyModal 的第三个 section)。
 * 数据来自 agent.mcp(GET /api/agent/mcp);增删改/测试全部走 /api/agent/mcp*。
 */
const props = defineProps<{ agent: AgentStore }>()

const nameInput = ref('')
const commandInput = ref('')
const argsInput = ref('')
const envInput = ref('')
/** env 表单级校验错误(非法行);独立于 error(API 错误),展示在 textarea 下方 */
const envError = ref<string | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)

/** 手动刷新中(防重复点击) */
const refreshing = ref(false)

/** 打开面板(模态窗)即拉最新状态;失败静默,与 init() 行为一致 */
onMounted(() => {
  void props.agent.refreshMcp().catch(() => {})
})

/** 手动刷新:失败在面板底部展示错误 */
async function handleRefresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  error.value = null
  try {
    await props.agent.refreshMcp()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    refreshing.value = false
  }
}

/** 测试结果:name → 状态(仅内存,不持久化) */
const testResults = ref<Record<string, { testing: boolean; ok: boolean; tools?: McpToolInfo[]; error?: string }>>({})

const servers = computed<McpServerConfig[]>(() => props.agent.mcp.value?.servers ?? [])
const statusByName = computed(() => {
  const map = new Map<string, { state: string; error?: string; toolCount: number }>()
  for (const s of props.agent.mcp.value?.status ?? []) map.set(s.name, s)
  return map
})

function statusOf(name: string): { state: string; error?: string; toolCount: number } {
  return statusByName.value.get(name) ?? { state: 'disabled', toolCount: 0 }
}

function statusLabel(status: { state: string; error?: string; toolCount: number }): string {
  switch (status.state) {
    case 'connected':
      return `已连接 · ${status.toolCount} 工具`
    case 'connecting':
      return '连接中…'
    case 'not_connected':
      return '未连接 · 新建会话后自动连接'
    case 'error':
      return `异常${status.error ? `:${status.error}` : ''}`
    default:
      return '未启用'
  }
}

function statusClass(state: string): string {
  if (state === 'connected') return 'text-primary'
  if (state === 'connecting') return 'text-mute'
  if (state === 'not_connected') return 'text-mute'
  if (state === 'error') return 'text-err'
  return 'text-mute'
}

async function toggleEnabled(server: McpServerConfig): Promise<void> {
  await props.agent.saveMcpServer({ ...server, enabled: !(server.enabled ?? false) })
}

/** 添加并测试:保存(默认不启用)→ 自动跑一次连接测试 */
async function handleAdd(): Promise<void> {
  const name = nameInput.value.trim()
  const command = commandInput.value.trim()
  if (!name || !command || saving.value) return
  // env 前端校验:非法行整体拦截,不发起请求(后端 400 兜底,但结构化数据在前端先给明确提示)
  const parsed = parseEnvText(envInput.value)
  if (parsed.error) {
    envError.value = parsed.error
    return
  }
  saving.value = true
  error.value = null
  envError.value = null
  saved.value = false
  try {
    const args = argsInput.value.trim() === '' ? [] : argsInput.value.trim().split(/\s+/)
    // 空 env 传 undefined:useAgent 的 JSON.stringify 自动省略该键,磁盘不写出 "env": {} (与 useAgent.ts 注释一致)
    const env = Object.keys(parsed.env).length > 0 ? parsed.env : undefined
    await props.agent.saveMcpServer({ name, command, args, enabled: false, env })
    nameInput.value = ''
    commandInput.value = ''
    argsInput.value = ''
    envInput.value = ''
    saved.value = true
    void handleTest(name)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function handleTest(name: string): Promise<void> {
  testResults.value = { ...testResults.value, [name]: { testing: true, ok: false } }
  try {
    const result = await props.agent.testMcpServer(name)
    testResults.value = {
      ...testResults.value,
      [name]: { testing: false, ok: result.ok, tools: result.tools, error: result.error },
    }
  } catch (e) {
    testResults.value = {
      ...testResults.value,
      [name]: { testing: false, ok: false, error: e instanceof Error ? e.message : String(e) },
    }
  }
}

async function handleDelete(name: string): Promise<void> {
  try {
    error.value = null
    await props.agent.deleteMcpServer(name)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <div class="mt-6 border-t border-hairline pt-4">
    <div class="flex items-center justify-between">
      <p class="font-mono text-[10px] tracking-wider text-mute">
        MCP · 外部工具
      </p>
      <button
        type="button"
        class="rounded-sm border border-hairline px-2 py-0.5 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary disabled:opacity-40"
        :disabled="refreshing"
        @click="handleRefresh"
      >
        {{ refreshing ? '刷新中…' : '刷新' }}
      </button>
    </div>
    <p class="mt-2 text-xs leading-relaxed text-body">
      添加外部 MCP server(stdio 启动命令 + 参数),其工具以
      <code class="font-mono text-primary/90">mcp__&lt;server&gt;__&lt;tool&gt;</code>
      命名注册进主代理与子代理。配置存于独立
      <code class="font-mono text-primary/90">mcp.json</code>,agent 无任何工具可写。
    </p>

    <!-- 安全警告 -->
    <div class="mt-3 rounded-sm border border-err/30 bg-err/5 p-3">
      <p class="font-mono text-[10px] tracking-wider text-err">
        安全警告
      </p>
      <p class="mt-1 text-xs leading-relaxed text-body">
        MCP server 是外部程序,以当前用户权限运行,可访问本地文件与网络;仅添加你信任的 server。工具输出视为不可信内容。
      </p>
    </div>

    <!-- server 列表 -->
    <div
      v-if="servers.length > 0"
      class="mt-4 space-y-2"
    >
      <div
        v-for="server in servers"
        :key="server.name"
        class="rounded-sm border border-hairline bg-canvas-soft p-3"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate font-mono text-[11px] text-ink">
              {{ server.name }}
            </p>
            <p
              class="mt-0.5 truncate font-mono text-[10px] text-mute"
              :title="`${server.command} ${(server.args ?? []).join(' ')}`"
            >
              {{ server.command }} {{ (server.args ?? []).join(' ') }}
            </p>
            <p
              v-if="server.env && Object.keys(server.env).length > 0"
              class="mt-0.5 truncate font-mono text-[10px] text-mute"
              :title="envSummary(server.env)"
            >
              env: {{ envSummary(server.env) }}
            </p>
          </div>
          <span
            class="shrink-0 font-mono text-[10px]"
            :class="statusClass(statusOf(server.name).state)"
            :title="statusOf(server.name).error"
          >{{ statusLabel(statusOf(server.name)) }}</span>
        </div>
        <div class="mt-2 flex items-center justify-between">
          <label class="flex cursor-pointer items-center gap-1.5 font-mono text-[10px] text-mute">
            <input
              type="checkbox"
              class="accent-primary"
              :checked="server.enabled ?? false"
              @change="toggleEnabled(server)"
            >
            启用
          </label>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-sm border border-hairline px-2 py-0.5 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary"
              @click="handleTest(server.name)"
            >
              测试
            </button>
            <button
              type="button"
              class="rounded-sm border border-hairline px-2 py-0.5 font-mono text-[10px] text-body hover:border-err/50 hover:text-err"
              @click="handleDelete(server.name)"
            >
              删除
            </button>
          </div>
        </div>
        <!-- 测试结果展开 -->
        <div
          v-if="testResults[server.name]"
          class="mt-2 border-t border-hairline pt-2"
        >
          <p
            v-if="testResults[server.name].testing"
            class="font-mono text-[10px] text-mute"
          >
            测试中…
          </p>
          <template v-else>
            <p
              v-if="testResults[server.name].ok"
              class="font-mono text-[10px] text-primary"
            >
              连接成功,共 {{ (testResults[server.name].tools ?? []).length }} 个工具
            </p>
            <p
              v-else
              class="font-mono text-[10px] text-err"
            >
              连接失败:{{ testResults[server.name].error }}
            </p>
            <ul
              v-if="(testResults[server.name].tools ?? []).length > 0"
              class="mt-1 max-h-24 overflow-y-auto"
            >
              <li
                v-for="t in testResults[server.name].tools"
                :key="t.name"
                class="font-mono text-[10px] leading-relaxed text-body"
              >
                {{ t.name }}{{ t.description ? ` — ${t.description}` : '' }}
              </li>
            </ul>
          </template>
        </div>
      </div>
    </div>
    <p
      v-else
      class="mt-3 font-mono text-[10px] text-mute"
    >
      尚未配置 MCP server
    </p>

    <!-- 添加表单 -->
    <form
      class="mt-4"
      @submit.prevent="handleAdd"
    >
      <div class="grid grid-cols-2 gap-2">
        <input
          v-model="nameInput"
          spellcheck="false"
          placeholder="name(如 github)"
          class="w-full rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary"
        >
        <input
          v-model="commandInput"
          spellcheck="false"
          placeholder="command(如 npx)"
          class="w-full rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary"
        >
      </div>
      <input
        v-model="argsInput"
        spellcheck="false"
        placeholder="args(空格分隔,如 -y @modelcontextprotocol/server-github;不含 shell 语法)"
        class="mt-2 w-full rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary"
      >
      <textarea
        v-model="envInput"
        rows="3"
        spellcheck="false"
        placeholder="env(每行一个 KEY=VALUE,如 API_KEY=sk-xxx;值可含空格与 =,按第一个 = 切分;空行忽略)"
        class="mt-2 w-full resize-y rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary"
        @input="envError = null"
      />
      <p
        v-if="envError"
        class="mt-1 font-mono text-[10px] text-err"
      >
        {{ envError }}
      </p>
      <div class="mt-3 flex items-center justify-between">
        <span class="font-mono text-[10px] text-mute">新增默认不启用(opt-in)</span>
        <button
          type="submit"
          class="rounded-sm bg-primary px-4 py-1.5 font-display text-[11px] tracking-widest text-on-primary transition hover:bg-primary-soft disabled:opacity-40"
          :disabled="saving || !nameInput.trim() || !commandInput.trim()"
        >
          {{ saving ? '添加中…' : '添加并测试' }}
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
      已保存到 mcp.json
    </p>

    <p class="mt-3 font-mono text-[10px] leading-relaxed text-mute">
      新增/修改 MCP server 后需<span class="text-body">新建会话或重开工作区</span>生效(与 skills 一致);删除/禁用会立即断开连接。
    </p>
  </div>
</template>
