# 实施计划:MCP 配置模态窗新增 env 字段编辑

> 依据:`.wf-runs/daca693f/01-exploration-1.md`(后端链路 env 已全通,唯一缺口是 McpPanel.vue UI 表单无 env 输入)。
> 已复核:`McpPanel.vue`(表单/列表现状)、`ApiKeyModal.vue`(壳)、`useAgent.ts` L223 起(saveMcpServer 已透传 env)、`useAgent.test.ts`(stubMcpApi PUT 未覆盖 env)、`WorkspacePickerModal.test.ts`(组件测试模式)、`packages/shared` 类型(env?: Record<string,string>)、`mcpConfig.ts`(后端 400 中文文案风格:如 `MCP server「${name}」的 env 必须是字符串键值对对象(值必须为字符串)`)、`apps/web/package.json`(test = `vitest run`)。

---

## 1. 目标与范围

### 做什么

1. **McpPanel.vue**(唯一生产代码改动):新增表单加入 env 编辑区(每行 `KEY=VALUE` 的 textarea),提交时解析为 `Record<string,string>` 透传给 `saveMcpServer`;非法行前端拦截并给出中文提示;server 列表条目展示已配置的 env 摘要。
2. **测试补强**(2 个测试文件):
   - 新增 `apps/web/src/components/McpPanel.test.ts`(vitest + @vue/test-utils,mock agent store)。
   - `apps/web/src/composables/useAgent.test.ts`:PUT stub 回写 env,补 saveMcpServer 透传 env 断言。
3. 运行 `apps/web` 测试确认全绿。

### 不做什么(明确排除)

- **不改动**:`packages/shared/src/index.ts`、`apps/api/src/agent/routes.ts`、`apps/api/src/mcpConfig.ts`、`apps/api/src/pi/mcpTools.ts`、`apps/web/src/composables/useAgent.ts`(探索已确认链路完整无缺口)。
- **不做「编辑已有 server」入口**(探索报告标为可选的次要缺口):本期范围仅「新增表单支持 env」+「列表展示 env」;修改已有 server 的 env 仍走删除重加(后端 PUT 本就是 upsert,未来要加编辑入口只需复用同一表单回填,无需后端改动)。
- **不改 args 交互**(保持空格分隔文本框现状);不做 env 逐行增删行控件(行文本 textarea 已满足,与现有极简风格一致)。
- 不做后端校验增强(env key 格式不校验,与后端现状对齐)。

---

## 2. 实施步骤

### 步骤 1:修改 `apps/web/src/components/McpPanel.vue`(唯一生产改动)

#### 1a. `<script setup>` 新增状态与解析函数

在 `argsInput` 声明附近新增:

```ts
const envInput = ref('')
/** env 表单级校验错误(非法行);独立于 error(API 错误),展示在 textarea 下方 */
const envError = ref<string | null>(null)
```

模块作用域新增纯函数(便于单测,位于 `defineProps` 之前):

```ts
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
```

错误文案参照后端 400 中文风格(`MCP server「x」的 env 必须是字符串键值对对象(值必须为字符串)`):明确、含行号定位、给出格式示例。

#### 1b. 修改 `handleAdd`(解析 → 拦截 → 透传)

```ts
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
    void handleTest(name)   // 保存后自动测试,天然验证新 env 生效
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
```

**不破坏现有逻辑的要点**:`toggleEnabled` 用 `{ ...server, enabled }` spread 保存,useAgent 已透传 `env: server.env`,toggle 不会抹掉手写 env —— 无需改动;enabled 开关逻辑零改动。

#### 1c. `<template>` 改动(两处)

**① 新增表单:env textarea**(位置:args 输入框之后、`mt-3 flex items-center justify-between` 提示/提交行之前,全宽,`mt-2` 与 args 对齐):

```html
<textarea
  v-model="envInput"
  rows="3"
  spellcheck="false"
  placeholder="env(每行一个 KEY=VALUE,如 API_KEY=sk-xxx;值可含空格与 =,按第一个 = 切分;空行忽略)"
  class="mt-2 w-full resize-y rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary"
  @input="envError = null"
></textarea>
<p
  v-if="envError"
  class="mt-1 font-mono text-[10px] text-err"
>{{ envError }}</p>
```

交互设计决定:
- **校验时机 = 提交时**(handleAdd 内 parse):避免用户输入 `FOO` 尚未打 `=` 时即时报错干扰;错误显示在 textarea 正下方,`@input` 时清除(一改即消)。
- **submit 按钮 disabled 状态不变**(仍只看 `saving || !nameInput.trim() || !commandInput.trim()`):保证非法 env 时按钮可点,点击后看到明确报错;与 args「不校验、后端兜底」模式一致,但 env 是结构化数据故前端主动拦截。
- 样式完全复用现有输入框范式(Tailwind v4 语义色 `border-hairline bg-canvas-soft font-mono text-xs` 等),placeholder 中文说明格式(与 args 长 placeholder 风格一致)。

**② 列表条目:env 摘要**(位置:command 行 `<p>` 之后):

```html
<p
  v-if="server.env && Object.keys(server.env).length > 0"
  class="mt-0.5 truncate font-mono text-[10px] text-mute"
  :title="envSummary(server.env)"
>env: {{ envSummary(server.env) }}</p>
```

- 仅当 env 非空时渲染;`truncate` + `title` 悬浮显示完整 `KEY=VAL`(值含空格时拼接摘要被截断,title 兜底可读性)。
- 无 env / 手写 `"env": {}` 的 server 不显示该行。

#### 1d. 预期结果

新增 server 可带 env 保存(mcp.json 写入 env 对象);非法行前端拦截提示;列表可见已有 server 的 env 摘要;enabled toggle 不丢 env。

---

### 步骤 2:新增 `apps/web/src/components/McpPanel.test.ts`

**模式**:参考 `WorkspacePickerModal.test.ts` —— `mount(McpPanel, { props: { agent: mockStore } })` + `flushPromises()`;mock store 全部 vi.fn(`refreshMcp` 必须 stub,`onMounted` 会调用;`saveMcpServer` 成功后 `handleTest` 会调用 `testMcpServer`,也须 stub)。

```ts
function mountPanel(agent?: Partial<AgentStore>) {
  const refreshMcp = vi.fn(async () => {})
  const saveMcpServer = vi.fn(async () => {})
  const testMcpServer = vi.fn(async () => ({ ok: true, tools: [] }))
  const deleteMcpServer = vi.fn(async () => {})
  const store = {
    mcp: ref({ servers: [], status: [] }),
    refreshMcp, saveMcpServer, testMcpServer, deleteMcpServer,
    ...agent,
  } as unknown as AgentStore
  const wrapper = mount(McpPanel, { props: { agent: store } })
  return { wrapper, saveMcpServer }
}
```

**元素定位**:env 用 `wrapper.find('textarea')`(表单中唯一 textarea);name/command 用 `wrapper.findAll('input')` 按序取 `[0]`/`[1]`;提交用 `wrapper.find('form').trigger('submit')`。

**测试用例清单**:

| # | 用例 | 操作与断言 |
|---|---|---|
| 1 | 列表展示 env 摘要 | mount 时 `mcp: ref({ servers: [{ name: 's1', command: 'node', env: { A: '1', B: 'x y' } }], status: [] })` → `wrapper.text()` 含 `env: A=1 B=x y`;无 env 的 server 不出现 `env:` 行 |
| 2 | env textarea 解析并透传(含空格与 = 的值) | 填 name/command;env `setValue('A=1\nGREETING=hello world\nURL=https://x?a=1\n\n')`(含空行)→ submit → `saveMcpServer` 以 `expect.objectContaining({ env: { A: '1', GREETING: 'hello world', URL: 'https://x?a=1' } })` 被调用;空行被忽略 |
| 3 | env 为空 → 传 undefined | env 留空 → submit → 断言 `saveMcpServer` 调用参数 `env` 为 `undefined`(`expect.objectContaining({ env: undefined })` 或 `toHaveBeenCalledWith(expect.objectContaining({ env: undefined }))`) |
| 4 | 非法行拦截不提交 | env `setValue('A=1\nBADLINE')` → submit → `saveMcpServer` **未被调用**;`wrapper.text()` 含 `env 第 2 行缺少「=」` |
| 5 | 编辑后错误清除 | 接用例 4,`env.setValue('A=1\nB=2')` → 错误文本消失 |
| 6 | 保存成功后清空 env textarea | 用例 2 后断言 `(textarea.element as HTMLTextAreaElement).value === ''` |

---

### 步骤 3:修改 `apps/web/src/composables/useAgent.test.ts`

1. **扩展 `stubMcpApi` 的 PUT 分支**(`describe('useAgent MCP actions')` 内):body 类型加入 `env`/`args` 并回写:

```ts
if (url === '/api/agent/mcp/echo' && method === 'PUT') {
  const body = JSON.parse(String(init?.body)) as { command?: string; enabled?: boolean; env?: Record<string, string> }
  servers = [{ name: 'echo', command: body.command, args: [], enabled: body.enabled, env: body.env }]
  return jsonResponse({ servers, status: initialStatus })
}
```

2. **新增用例**:

```ts
it('saveMcpServer:PUT 透传 env', async () => {
  stubMcpApi([], [])
  const agent = useAgent()
  await agent.saveMcpServer({ name: 'echo', command: 'node', env: { FOO: 'bar', URL: 'https://x?a=1' } })
  expect(agent.mcp.value?.servers[0].env).toEqual({ FOO: 'bar', URL: 'https://x?a=1' })
})

it('saveMcpServer:无 env 时请求体省略该键', async () => {
  stubMcpApi([], [])
  const agent = useAgent()
  await agent.saveMcpServer({ name: 'echo', command: 'node' })
  expect(agent.mcp.value?.servers[0].env).toBeUndefined()
})
```

(第二个用例依赖 stub 中 `body.env` 为 undefined,间接验证 JSON.stringify 省略行为;若想更直接,可在 stub 内把 `body` 存到闭包供断言。)

---

### 步骤 4:运行验证

```bash
cd apps/web && pnpm test        # = vitest run(jsdom;NODE_ENV 由 vitest.config.ts 强制 test)
```

- 预期:现有用例(useAgent 流式 + MCP actions、WorkspacePickerModal 等)与新增用例全绿。
- 可选补充:`pnpm typecheck`(`vue-tsc -b`)确认类型无回归(测试文件改动不影响产物,但 McpPanel.vue 的 TS 改动应过类型检查)。

---

## 3. 风险与回滚方案

| 风险 | 分析 | 对策 |
|---|---|---|
| env 值含 `\r`(Windows 换行) | jsdom/textarea 输入 `\n`;真实浏览器回车产生 `\n`,但粘贴可能带 `\r\n` | `parseEnvText` 每行 `trim()` 已吞掉行尾 `\r`,天然兼容 |
| 值前后空白被误解为有意输入 | 设计定为「key trim、值原样保留」,与「按第一个 = 切分」语义一致 | 若产品侧要求 trim 值,只需改 `parseEnvText` 一行,测试同步微调 |
| 空 env 写盘 `"env": {}` | 若直接传 `{}`,后端校验通过但磁盘多出空对象 | handleAdd 空对象转 `undefined`,useAgent `JSON.stringify` 自动省略键(已确认行为) |
| toggleEnabled 抹掉手写 env | 已确认 useAgent 透传 `env: server.env`,spread 保存保留 | 无风险;测试 #1 附带覆盖列表展示,不覆盖 toggle 的保留(useAgent 层已保证) |
| 非法 env 打到后端 400 | 前端已拦截大部分;后端 400 仍兜底(错误显示在面板底部 error 区) | 双保险,无需改后端 |
| jsdom `setValue` 多行文本 | VTU `setValue` 对 textarea 直接设 value,`\n` 原样保留 | 测试用 `'A=1\nB=2'` 字面量即可 |

**回滚方案**:生产改动集中在 `apps/web/src/components/McpPanel.vue` 单文件,测试为两个测试文件;无数据迁移、无 schema/API 变更。任意一步出问题 `git checkout -- <file>` 单文件回滚即可,不影响其他模块。

---

## 4. 验收标准(逐条核对)

- [ ] **A1** McpPanel.vue 新增 env textarea,位于 args 输入框之后、提示/提交行之前;rows=3、spellcheck=false、placeholder 含「每行一个 KEY=VALUE」「按第一个 = 切分」中文说明;样式与现有输入框一致(纯 Tailwind v4 语义色、`font-mono text-xs`、`rounded-sm border border-hairline bg-canvas-soft`、`focus:border-primary`)。
- [ ] **A2** 提交时解析:`parseEnvText` 空行忽略、行 trim、按第一个 `=` 切分、key trim、值原样保留(含空格与 `=`);`env: ` 前缀的摘要函数 `envSummary` 存在。
- [ ] **A3** 非法行(无 `=` 或 `=` 开头)前端拦截:envError 文案含行号与「缺少「=」」及格式示例,`saveMcpServer` 不被调用;`@input` 编辑后错误清除。
- [ ] **A4** `handleAdd` 将解析后 env 传入 `saveMcpServer`(enabled 仍为 false);env 为空时传 `undefined`;保存成功后 envInput 清空;`handleTest` 自动触发逻辑不变。
- [ ] **A5** enabled toggle 逻辑零改动;列表条目在 command 行下展示 `env: k=v k2=v2`(仅 env 非空时),`truncate` + `title` 完整内容。
- [ ] **A6** 新增 `apps/web/src/components/McpPanel.test.ts`,覆盖上表 6 个用例(列表 env 摘要、解析透传含空格/`=` 值、空 env→undefined、非法行拦截不提交、编辑后错误清除、成功后清空)。
- [ ] **A7** `useAgent.test.ts`:PUT stub 回写 env;新增「透传 env(含值)」与「无 env 省略键」两个用例。
- [ ] **A8** `cd apps/web && pnpm test` 全绿(含既有用例,无回归)。
- [ ] **A9** 未改动:packages/shared、routes.ts、mcpConfig.ts、mcpTools.ts、useAgent.ts(useAgent.test.ts 为测试改动除外)。
