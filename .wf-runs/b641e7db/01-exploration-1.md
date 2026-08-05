# 探索报告:McpPanel.vue 现状调研 + 「编辑已有 MCP server」功能设计

> 任务:设计「编辑已有 MCP server」功能(点击列表条目编辑 name/command/args/env,保存后覆盖更新,含 env 字段)。
> 调研时间:2026-01(基于当前工作区代码快照)

---

## 1. 仓库概览

- 技术栈:pnpm workspace monorepo(turbo),`apps/web`(Vue 3 + Vite + `<script setup>` + TS)、`apps/api`(Hono)、`packages/shared`(共享类型)。
- 测试:Vitest + @vue/test-utils(web)、Vitest + Hono `app.request`(api)。
- 相关目录:`apps/web/src/components/McpPanel.vue`、`apps/web/src/composables/useAgent.ts`、`apps/api/src/agent/routes.ts`、`apps/api/src/mcpConfig.ts`、`packages/shared/src/index.ts`。
- McpPanel 内嵌于 `ApiKeyModal.vue` 的第三个 tab(v-show="activeTab === 'mcp'"),仅接收 `agent: AgentStore` 一个 prop。

---

## 2. 需求相关模块清单

| 文件 | 说明 |
|---|---|
| `apps/web/src/components/McpPanel.vue` | MCP server 管理面板:列表 + 新增表单 + 测试/启用/删除;本次改动主战场 |
| `apps/web/src/components/McpPanel.test.ts` | 面板单测(vitest + vue-test-utils,mock AgentStore) |
| `apps/web/src/composables/useAgent.ts` | `refreshMcp / saveMcpServer / deleteMcpServer / testMcpServer`,全部走 `/api/agent/mcp*` |
| `apps/api/src/agent/routes.ts` | `PUT /api/agent/mcp/:name`(upsert + dispose 旧连接)、DELETE、POST /test、GET |
| `apps/api/src/mcpConfig.ts` | `upsertMcpServer`(同 name 覆盖)、`removeMcpServer`、校验规则(name 正则 /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/ 且 ≤40 字符) |
| `packages/shared/src/index.ts` | `McpServerConfig` / `McpServerStatus` / `McpToolInfo` 类型定义 |
| `apps/web/src/components/ApiKeyModal.vue` | McpPanel 宿主(仅传 agent prop) |

---

## 3. McpPanel.vue 完整结构

### 3.1 script setup 状态声明

```ts
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
const refreshing = ref(false)          // 手动刷新中(防重复点击)
const testResults = ref<Record<string, { testing: boolean; ok: boolean; tools?: McpToolInfo[]; error?: string }>>({})

const servers = computed<McpServerConfig[]>(() => props.agent.mcp.value?.servers ?? [])
const statusByName = computed(() => { /* name → {state, error, toolCount} Map */ })
```

### 3.2 工具函数(env 解析,编辑回填的逆操作基准)

```ts
/**
 * 解析 env 文本(每行 KEY=VALUE):
 * - 空行忽略;行首尾空白忽略(trim);
 * - 按【第一个】= 切分:key 取左侧并 trim,value 取右侧【原样保留】
 *   (值允许含空格与 = 符号,如 `GREETING=hello world`、`URL=https://x?a=1`);
 * - 无 = 或 = 开头(空 key)的行 → 返回错误(含行号与原文),零容忍整体拦截。
 */
function parseEnvText(text: string): { env: Record<string, string>; error: string | null }
function envSummary(env: Record<string, string>): string  // KEY=VAL 空格拼接(列表悬浮 title)
```

### 3.3 handleAdd 完整逻辑

```ts
async function handleAdd(): Promise<void> {
  const name = nameInput.value.trim()
  const command = commandInput.value.trim()
  if (!name || !command || saving.value) return
  const parsed = parseEnvText(envInput.value)
  if (parsed.error) { envError.value = parsed.error; return }   // 前端拦截,不发请求
  saving.value = true
  error.value = null
  envError.value = null
  saved.value = false
  try {
    const args = argsInput.value.trim() === '' ? [] : argsInput.value.trim().split(/\s+/)
    // 空 env 传 undefined:JSON.stringify 自动省略该键,磁盘不写出 "env": {}
    const env = Object.keys(parsed.env).length > 0 ? parsed.env : undefined
    await props.agent.saveMcpServer({ name, command, args, enabled: false, env })  // ← 注意:新增强制 enabled: false
    nameInput.value = ''; commandInput.value = ''; argsInput.value = ''; envInput.value = ''  // 清空
    saved.value = true
    void handleTest(name)    // 保存后自动测试
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
```

### 3.4 列表渲染(v-for 条目结构)

模板布局顺序:**标题+刷新按钮 → 说明 → 安全警告 → server 列表(v-for)→ 添加表单 → error/saved 提示 → 底部注释**。

每条目结构(`v-for="server in servers" :key="server.name"`):

```html
<div class="rounded-sm border border-hairline bg-canvas-soft p-3">
  <div class="flex items-center justify-between gap-3">
    <div class="min-w-0">
      <p class="truncate font-mono ...">{{ server.name }}</p>
      <p :title="`${server.command} ${(server.args ?? []).join(' ')}`">{{ server.command }} {{ (server.args ?? []).join(' ') }}</p>
      <p v-if="server.env && Object.keys(server.env).length > 0" :title="envSummary(server.env)">env: {{ envSummary(server.env) }}</p>
    </div>
    <span :class="statusClass(...)" :title="statusOf(server.name).error">{{ statusLabel(...) }}</span>
  </div>
  <div class="mt-2 flex items-center justify-between">
    <label><input type="checkbox" :checked="server.enabled ?? false" @change="toggleEnabled(server)"> 启用</label>
    <div class="flex items-center gap-2">
      <button @click="handleTest(server.name)">测试</button>
      <button @click="handleDelete(server.name)">删除</button>   <!-- ← 编辑按钮加在这里 -->
    </div>
  </div>
  <!-- 测试结果展开区(v-if testResults[server.name]) -->
</div>
```

表单:

```html
<form class="mt-4" @submit.prevent="handleAdd">
  <div class="grid grid-cols-2 gap-2">
    <input v-model="nameInput" placeholder="name(如 github)" ...>
    <input v-model="commandInput" placeholder="command(如 npx)" ...>
  </div>
  <input v-model="argsInput" placeholder="args(空格分隔,...)" ...>
  <textarea v-model="envInput" rows="3" placeholder="env(每行一个 KEY=VALUE,...)" @input="envError = null" />
  <p v-if="envError">{{ envError }}</p>
  <button type="submit" :disabled="saving || !nameInput.trim() || !commandInput.trim()">
    {{ saving ? '添加中…' : '添加并测试' }}
  </button>
</form>
<p v-if="error">{{ error }}</p>
<p v-else-if="saved">已保存到 mcp.json</p>
```

---

## 4. 数据来源与保存链路

### 4.1 数据来源

- `servers` computed ← `props.agent.mcp.value?.servers`;`mcp` 由 `refreshMcp()` 填充(`GET /api/agent/mcp`,返回 `{ servers, status }`)。
- 条目类型 `McpServerConfig`(packages/shared):

```ts
interface McpServerConfig {
  name: string                 // /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,≤40 字符
  command: string
  args?: string[]
  enabled?: boolean            // 缺省视为未启用(opt-in)
  env?: Record<string, string> // 值必须为字符串
}
```

### 4.2 保存链路(useAgent.ts)

```ts
async function saveMcpServer(server: McpServerConfig): Promise<void> {
  await request(`/api/agent/mcp/${encodeURIComponent(server.name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: server.name, command: server.command,
      args: server.args ?? [], enabled: server.enabled ?? false,
      env: server.env,   // 透传:undefined 时 JSON.stringify 省略该键,磁盘不写出 "env": {}
    }),
  })
  await refreshMcp()   // ★ 保存后自动刷新列表
}
```

- **PUT 语义(后端 routes.ts)**:`name` 以 URL 参数为准;`upsertMcpServer` 同 name 覆盖、不同 name 追加;校验失败 400 零写入;成功后 `disposeMcpServer(name)` 断旧连接(新会话生效),返回 `mcpOverview()`(即 `{ servers, status }`,但前端 `request<T>` 只取 `data` 且 saveMcpServer 丢弃返回值,靠内部 `refreshMcp()` 刷新)。
- **删除**:`deleteMcpServer(name)` → DELETE `/api/agent/mcp/:name` → 404 若不存在 → dispose → refreshMcp。
- **启用 toggle**:`toggleEnabled(server)` → `saveMcpServer({ ...server, enabled: !(server.enabled ?? false) })` —— **spread 保留 env/args,是编辑保存时 enabled 语义的参照**。
- **测试**:`testMcpServer(name)` → POST `/test`,返回 `{ ok, tools?, error? }`,仅内存展示(`testResults` 按 name 为 key)。

---

## 5. 现有交互约束(新增态)

1. **清空**:handleAdd 成功后四个输入框全部置空(`nameInput/commandInput/argsInput/envInput = ''`),`saved = true` 并自动 `void handleTest(name)`。
2. **saved 提示**:模板 `v-if="error"` 优先,`v-else-if="saved"` 显示「已保存到 mcp.json」;`saved` 只在每次 handleAdd 开头重置为 false——**编辑态需注意:进入编辑时应重置 saved,否则残留上次的「已保存」提示**。
3. **envError**:textarea `@input` 时清除;非法行零容忍拦截(带行号)。
4. **enabled 透传细节**(useAgent.ts 注释):`env: server.env` 原样透传,有值保留(防 toggleEnabled 的 spread 把手写 env 抹掉);undefined 时 JSON.stringify 省略键,磁盘不写出 `"env": {}`。
5. **提交按钮禁用条件**:`saving || !nameInput.trim() || !commandInput.trim()`。
6. **新增强制 `enabled: false`**(opt-in)——编辑保存时若直接复用此逻辑会把已启用 server 静默禁用,**必须改为透传原 enabled**。
7. **args 解析**:`trim().split(/\s+/)`,编辑回填 `args.join(' ')`;含空格的单参数无法往返(已知限制,新增/编辑共用同一语义,可接受)。

---

## 6. 编辑功能设计建议

### 6.1 编辑入口:列表条目加「编辑」按钮(推荐)

- 在每条目的按钮区(测试 左侧)加「编辑」按钮:`@click="startEdit(server)"`。
- 不采用「点击整条条目进入编辑」:条目内已有 checkbox(启用)、测试、删除、状态悬浮 title 等交互,整条可点击会与这些元素冲突且缺少可发现性。
- 视觉:与「测试」同级(mono 小按钮),hover 主色。

### 6.2 编辑态状态切换

新增状态:

```ts
/** 当前编辑中的 server name;null = 新增态 */
const editingName = ref<string | null>(null)
```

- **进入编辑** `startEdit(server)`:设置 `editingName.value = server.name`;回填四个输入框;重置 `saved.value = false; error.value = null; envError.value = null`;可选清掉该 server 的测试结果残留。
- **表单标题**:表单区上方加一行(编辑态显示「编辑 {{ editingName }}」,新增态显示「添加 MCP server」或维持现状)。
- **保存按钮文案**:`editingName ? '保存修改' : '添加并测试'`;saving 时 `保存中… / 添加中…`。
- **提交函数**:抽出共用 `handleSave()`,根据 `editingName` 分支:
  - 新增:现 handleAdd 逻辑(校验 → `enabled: false` → 保存 → 清空 → saved → 自动测试)。
  - 编辑:`enabled` 透传原值(取 `servers.value.find(s => s.name === editingName.value)?.enabled ?? false`),**绝不复用 `enabled: false`**;保存成功后清空表单、`editingName.value = null`、`saved = true`、可选自动测试(名称未变时可 `void handleTest(name)`)。

### 6.3 name 是否允许编辑:编辑态只读(推荐)

- 后端 upsert 以 **URL path 的 name** 为准(`PUT /api/agent/mcp/:name`),body 里的 name 被忽略;若允许改名 = 旧名删除 + 新名新增两条副作用,且要处理「新名已存在」的冲突,复杂且易错。
- **建议:编辑态 name input 置 `readonly`(样式加 muted 提示「name 不可修改,如需改名请删除后重新添加」)**。这样保存走同一 PUT 同 name 覆盖,零风险。
- 若产品坚持可改名:保存时应「新名不存在才允许,且 PUT 新名 + DELETE 旧名」两步,并提示需要新建会话生效——本轮不建议。

### 6.4 env 回填序列化(往返一致)

新增逆函数(与 parseEnvText 完全对称):

```ts
/** env 对象 → 每行 KEY=VALUE(parseEnvText 的逆;值含空格/= 均原样保留,往返一致) */
function envToText(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
}
```

- 往返一致性分析:`parseEnvText` 按**第一个 `=`** 切分、value 原样保留(含空格与 `=`),故 `envToText` 每行 `k=v` 可直接被 parse 还原。
- 已知边界(可接受,写注释即可):① value 行首尾空白会被 parse 的 `line.trim()` 吃掉(如 `A= x` 回填后变 `A=x`);② 存储键含行尾空格同理。均为罕见脏数据。
- **编辑保存时 env 传参**:与新增一致——`Object.keys(parsed.env).length > 0 ? parsed.env : undefined`(保持「空 env 不写盘」约定,同时注意这会把原 server 的 env 清空——这正是「保存后覆盖更新」的预期语义)。

### 6.5 编辑保存后刷新列表

- **无需额外刷新**:`useAgent.saveMcpServer` 内部已 `await refreshMcp()`,`servers` computed 自动更新,列表即时反映覆盖结果。
- `saveMcpServer` 返回 `void`(返回 `Promise<void>`),不能拿返回值做 UI 依赖;`testResults` 等本地态自行处理。

### 6.6 取消编辑态

- 编辑态在表单按钮行显示「取消」按钮(新增态隐藏):
  - `cancelEdit()`:`editingName.value = null`;清空四个输入框;`envError.value = null; error.value = null; saved.value = false`。
- 提交按钮行布局:编辑态 `[取消] [保存修改]`,新增态保持 `[新增默认不启用(opt-in)文案] [添加并测试]`。
- 若担心表单输入被误触,可在编辑态把底部文案「新增默认不启用」换成「编辑覆盖保存到 mcp.json」。

### 6.7 测试用例清单(新增编辑用例)

基于现有 `mountPanel` helper(见 §7),建议用例:

1. **编辑按钮渲染**:每条目出现「编辑」按钮;无 server 时不显示。
2. **startEdit 回填**:点击编辑后 name/command/args/env textarea 值正确回填(name input readonly);表单标题/保存按钮文案变为编辑态。
3. **env 回填往返**:env `{A:'1', GREETING:'hello world', URL:'https://x?a=1'}` → textarea 内容为三行 KEY=VALUE,提交后 `saveMcpServer` 收到相同 env 对象。
4. **编辑保存覆盖**:`saveMcpServer` 以同 name 调用,body 含 `enabled: true`(原 server enabled,验证不透传 false)、新 command/args/env;成功后表单清空、editingName 复位、列表(mock mcp ref)已更新。
5. **编辑态 enabled 保留**:原 server `enabled: true`,编辑保存后 `saveMcpServer` 收到 `enabled: true`(回归保护:防止复用 handleAdd 的 `enabled: false`)。
6. **取消**:编辑回填后点取消 → 表单清空、editingName 复位、按钮文案回「添加并测试」、saved 提示不残留。
7. **编辑态 env 非法行**:回填后改坏 env → 拦截不保存、显示行号错误(复用现有断言模式)。
8. **name 只读**:编辑态 name input 有 readonly 属性。
9. **空 env 编辑保存**:原 server 无 env → 编辑保存传 `env: undefined`(不写盘约定保持)。

### 6.8 改动范围(文件列表)

| 文件 | 改动 |
|---|---|
| `apps/web/src/components/McpPanel.vue` | 新增 `editingName` 状态、`envToText`、`startEdit/cancelEdit/handleSave`(或改造 handleAdd);模板:条目加「编辑」按钮、表单标题、取消按钮、按钮文案/只读联动 |
| `apps/web/src/components/McpPanel.test.ts` | 新增 §6.7 用例(建议新增 `describe('McpPanel 编辑')` 分组) |
| (不改)`useAgent.ts` | saveMcpServer 已支持编辑场景(upsert + env 透传 + refreshMcp) |
| (不改)后端 | PUT 已是覆盖语义,无需改动 |

---

## 7. 现有测试结构(McpPanel.test.ts)

- 框架:vitest + @vue/test-utils(`mount` + `flushPromises`)。
- **helper `mountPanel(agent?: Partial<AgentStore>)`**:构造 mock store——`mcp: ref({ servers: [], status: [] })` + 四个 vi.fn stub(`refreshMcp/saveMcpServer/testMcpServer/deleteMcpServer`),再 `...agent` 覆盖;`mount(McpPanel, { props: { agent: store } })`;返回 `{ wrapper, saveMcpServer, testMcpServer }`。
- **helper `fillBasic(wrapper)`**:`wrapper.findAll('input')` 取前两个 input 分别 setValue('demo') / ('node')。
- 断言模式:表单提交 `wrapper.find('form').trigger('submit')` + `flushPromises()`;env 用 `wrapper.find('textarea')`;对 `saveMcpServer` 用 `toHaveBeenCalledWith(expect.objectContaining({...}))`。
- 现有 6 个用例:env 摘要展示 / env 解析透传 / 空 env 传 undefined / 非法行拦截(行号)/ @input 清除错误后可重提 / 保存后清空 textarea。
- **为编辑用例准备**:`mountPanel` 已支持传入带 servers 的 mcp ref;新增编辑用例可直接复用;按钮查找建议加 `findAll('button')` 按文本过滤(现有测试未用文本选择器,可新增 `wrapper.findAll('button').find(b => b.text() === '编辑')` 之类,或给按钮加 data-testid 更稳)。

---

## 8. 结论

- **可行性:高**。前端唯一入口 `saveMcpServer` 已是 upsert 语义(PUT 同 name 覆盖),后端零改动;编辑功能本质是把「新增表单」复用到「回填 + 覆盖」,核心风险点只有三个:
  1. 编辑保存时 `enabled` 必须透传原值(不能复用 handleAdd 的 `enabled: false`);
  2. env 回填需新增 `envToText` 且与 `parseEnvText` 严格互逆(按第一个 `=` 切分天然支持值含空格/`=`);
  3. name 建议编辑态只读(后端按 URL name upsert,改名 = 新增+删除,复杂度不值得)。
- 其余(保存后刷新列表、取消、测试)均有现成机制可复用,改动面收敛在 McpPanel.vue 一个组件 + 其测试文件。
