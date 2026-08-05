# 探索报告:MCP 配置模态窗新增 env 字段编辑能力

> 任务:调研 MCP server 配置模态窗实现,确定在配置模态窗中新增 env 字段编辑能力的改动范围。
> 结论先行:**后端与前端数据链路(类型、API、composable)已全部支持 env,唯一缺口是 McpPanel.vue 的 UI 表单没有 env 输入,且没有编辑已有 server 的入口。**

---

## 1. 仓库概览

- **Monorepo**:pnpm workspace + turbo(`pnpm-workspace.yaml`、`turbo.json`)
- **apps/web**:Vue 3.5 `<script setup lang="ts">` + Vite 8 + Tailwind CSS v4(`@tailwindcss/vite`),图标 @lucide/vue,字体 Inter + JetBrains Mono
- **apps/api**:Hono(TS,`apps/api/src/agent/routes.ts` 注册路由),MCP 走独立 `mcp.json` 存储
- **packages/shared**:共享 TS 类型(`packages/shared/src/index.ts`)
- **构建/测试**:web `vue-tsc -b && vite build`;测试 `vitest run`(`apps/web/vitest.config.ts`,environment=jsdom,强制 `NODE_ENV=test`)
- 前端无 UI 组件库,全部手写 Tailwind 原子类

## 2. 需求相关模块清单

| 文件 | 说明 |
|---|---|
| `apps/web/src/components/ApiKeyModal.vue` | 设置模态窗壳:遮罩 + 左 tab 导航("API Keys" / "MCP Servers")+ 右内容区 + footer。`App.vue` 中 `v-if="showSettings"` 挂载 |
| `apps/web/src/components/McpPanel.vue` | **MCP 配置面板(核心改动点)**:server 列表 + 新增表单 + 测试/删除/启用开关,内嵌于 ApiKeyModal 的 "MCP Servers" tab(`v-show`) |
| `apps/web/src/composables/useAgent.ts` | 前端 API 封装:`refreshMcp` / `saveMcpServer` / `deleteMcpServer` / `testMcpServer`(L223 起) |
| `apps/api/src/agent/routes.ts` | API 路由:GET/PUT/DELETE `/api/agent/mcp*` + POST `:name/test`(L66–L130) |
| `apps/api/src/mcpConfig.ts` | mcp.json 存储层:`loadMcpServers` / `saveMcpServers` / `upsertMcpServer` / `removeMcpServer` + `validateMcpServers` 全量校验 |
| `apps/api/src/pi/mcpTools.ts` | spawn 消费端:`env: this.config.env` 传给 SDK(与白名单 HOME/PATH/SHELL 合并,同键覆盖) |
| `packages/shared/src/index.ts` | `McpServerConfig` / `McpServerStatus` / `McpToolInfo` / `ApiResponse<T>` 类型 |
| `apps/web/src/composables/useAgent.test.ts` | composable 测试(fetch stub 模式) |
| `apps/web/src/components/ChatPane.test.ts` / `WorkspacePickerModal.test.ts` / `App.test.ts` | 组件测试(mount + stub agent store + flushPromises) |

## 3. 模态窗表单现状(McpPanel.vue)

**当前支持编辑的字段**:name、command、args、enabled(仅 toggle,无编辑已有 server 的表单——只能删除重加)。

**新增表单结构**(`handleAdd` + template `<form @submit.prevent="handleAdd">`):

```vue
const nameInput = ref(''); const commandInput = ref(''); const argsInput = ref('')
const saving = ref(false); const error = ref<string | null>(null); const saved = ref(false)

async function handleAdd(): Promise<void> {
  const name = nameInput.value.trim(); const command = commandInput.value.trim()
  if (!name || !command || saving.value) return
  ...
  const args = argsInput.value.trim() === '' ? [] : argsInput.value.trim().split(/\s+/)
  await props.agent.saveMcpServer({ name, command, args, enabled: false })
  ...清空三个 input → saved=true → void handleTest(name)
}
```

- 表单组织:`grid grid-cols-2 gap-2`(name/command 并排)+ 全宽 args 输入框 + 底部 "新增默认不启用(opt-in)" 提示与提交按钮
- 前端校验:仅 `nameInput.trim()` / `commandInput.trim()` 非空(按钮 `:disabled="saving || !nameInput.trim() || !commandInput.trim()"`);args 不校验,空格分隔拆分;深层校验由后端 400 兜底(error 文本展示在表单下方)
- 提交保存:直接调 `agent.saveMcpServer(...)`(PUT),成功后自动跑一次连接测试
- 列表项操作:`toggleEnabled(server)` = `saveMcpServer({ ...server, enabled: !enabled })`(spread 保留其他字段)、`handleTest`(POST test)、`handleDelete`
- 列表项展示:`server.command + (server.args ?? []).join(' ')` 拼接,**env 完全不展示**

## 4. API 契约(env 已透传 ✓)

**PUT `/api/agent/mcp/:name`**(upsert;`apps/api/src/agent/routes.ts` L91–L112):

```ts
const raw = await readJson<{ command?: unknown; args?: unknown; enabled?: unknown; env?: unknown }>(c)
const server: McpServerConfig = {
  name,
  command: typeof raw?.command === 'string' ? raw.command : '',
  // 透传原始值:args/enabled/env 不做类型收窄,由存储层 validateMcpServers 统一校验
  args: raw?.args as string[] | undefined,
  enabled: raw?.enabled as boolean | undefined,
  env: raw?.env as Record<string, string> | undefined,
}
try { upsertMcpServer(store, server) } catch (error) {
  throw new HTTPException(400, { message: ... })   // 校验失败 400 零写入
}
await pi.disposeMcpServer(name)                     // 断旧连接,新会话生效
return c.json({ code: 0, message: '已保存 MCP server', data: mcpOverview() })
```

**GET `/api/agent/mcp`** → `{ code, message, data: { servers: McpServerConfig[], status: McpServerStatus[] } }`(`mcpOverview()` 合并运行时状态)
**DELETE `/api/agent/mcp/:name`**; **POST `/api/agent/mcp/:name/test`** → `{ ok, tools?, error? }`

**前端调用层**(`useAgent.ts` L223 起,**已透传 env ✓**):

```ts
async function saveMcpServer(server: McpServerConfig): Promise<void> {
  await request(`/api/agent/mcp/${encodeURIComponent(server.name)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: server.name, command: server.command,
      args: server.args ?? [], enabled: server.enabled ?? false,
      // 透传 env:有值保留(防 toggleEnabled 等 spread 保存把手写 env 抹掉);
      // undefined 时 JSON.stringify 自动省略该键,磁盘不写出 "env": {}
      env: server.env,
    }),
  })
  await refreshMcp()
}
```

## 5. 类型定义现状(packages/shared/src/index.ts)— 已含 env ✓

```ts
export interface McpServerConfig {
  name: string                       // /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, ≤40
  command: string
  args?: string[]
  enabled?: boolean                  // 新增默认 false,opt-in
  /** 传给 MCP server 子进程的环境变量(键值均为字符串);SDK 与白名单合并后传入,同键覆盖白名单 */
  env?: Record<string, string>
}
```

## 6. 后端 env 链路(用户已确认,mcpConfig.ts 复核 ✓)

- `mcpConfig.ts validateMcpServers`:env 非 undefined 时必须为「非数组、非 null 的对象且所有值为字符串」,否则抛中文 Error(零写入)
- `upsertMcpServer` → `saveMcpServers` → 校验 + 原子写(tmp+rename)
- `mcpTools.ts` L229:`env: this.config.env` 传入 SDK(保守语义:只传 config.env,不展开 process.env,undefined 时行为与现状一致)

## 7. 前端测试现状

- **框架**:vitest + @vue/test-utils 2 + jsdom;`apps/web/vitest.config.ts`(`environment: 'jsdom'`,并强制 `process.env.NODE_ENV = 'test'`)
- **模式**:
  - composable 测试(`useAgent.test.ts`):`vi.stubGlobal('fetch', ...)` 手写 stub,断言请求/响应;MCP 部分有 `stubMcpApi` 辅助(GET/PUT/POST test 全 stub)
  - 组件测试(`ChatPane.test.ts` / `WorkspacePickerModal.test.ts`):`mount(Component, { props: { agent: mockStore } })` + `flushPromises()` + `wrapper.text()` 断言;App.test.ts 用全量 fetch stub
- **现状缺口**:`McpPanel.vue` 与 `ApiKeyModal.vue` **均无专属测试**;`useAgent.test.ts` 的 PUT stub 只回写 `command/enabled`,未覆盖 env(新功能应补断言)

## 8. 模态窗 UI 风格(env 交互设计参考)

- 无组件库;Tailwind v4 原子类 + 语义色 token:`bg-canvas` / `bg-canvas-soft` / `border-hairline` / `text-ink` / `text-body` / `text-mute` / `text-primary` / `text-err`
- 输入框范式:`rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary`
- 小按钮范式:`rounded-sm border border-hairline px-2 py-0.5 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary`
- 主要按钮:`rounded-sm bg-primary px-4 py-1.5 font-display text-[11px] tracking-widest text-on-primary`
- **args 现有交互**:单个文本输入框,`split(/\s+/)` 空格分隔(无逐行编辑、无删除按钮)。env 键值对(可能含空格/特殊字符)不适合空格分隔,建议:每行 `KEY=VALUE` 的 textarea(或键值行列表 + 添加/删除行),`trim()` 后按行拆分、`=` 切分,空行忽略;后端校验已能兜底非法值(400)
- 交互范式:测试结果内联展开(testResults 按 name 记录)、错误/成功均以底部小字提示(error/saved ref)

## 9. env 现状缺口清单

| 层 | 文件 | 状态 | 缺口 |
|---|---|---|---|
| 共享类型 | `packages/shared/src/index.ts` | ✅ 已含 `env?: Record<string, string>` | 无 |
| 后端存储/校验 | `apps/api/src/mcpConfig.ts` | ✅ validate 已支持 env | 无 |
| 后端路由 | `apps/api/src/agent/routes.ts` PUT | ✅ 已透传 env | 无 |
| 后端 spawn | `apps/api/src/pi/mcpTools.ts` | ✅ 已传 `env: config.env` | 无 |
| 前端 API 封装 | `apps/web/src/composables/useAgent.ts` | ✅ 已透传 env(含 toggle 保留注释) | 无 |
| **前端 UI 新增表单** | `apps/web/src/components/McpPanel.vue` | ❌ **无 env 输入框** | **核心缺口** |
| **前端 UI 已有 server 编辑** | `apps/web/src/components/McpPanel.vue` | ❌ 只能删除重加,无法改 env | 次要缺口(可顺带补) |
| 前端测试 | `apps/web/src/composables/useAgent.test.ts` | ⚠️ PUT stub 未覆盖 env 断言 | 建议补 |
| 前端测试 | `McpPanel.test.ts`(不存在) | ⚠️ 面板无组件测试 | 建议新增(可参考 WorkspacePickerModal.test.ts 模式) |

## 10. 结论与建议改动范围

**可行性:高**。数据链路(类型 → API → 存储 → spawn)已全部打通 env,前端仅需补 UI。

**必须改动(1 个文件)**:
- `apps/web/src/components/McpPanel.vue`:
  1. 新增 `envInput` ref(建议 `KEY=VALUE` 每行一行的 textarea)+ 解析函数(行拆分、`=` 切分、空行/无 `=` 行策略)
  2. `handleAdd` 中构造 `env` 对象传入 `saveMcpServer`(空对象建议传 `undefined` 以保持磁盘不写出 `"env": {}`,与 useAgent 注释一致)
  3. 列表项展示 env(仿 command 行样式小字展示 `KEY=VAL` 列表,title 提示)
  4. (可选)新增「编辑」入口:点击后回填 name/command/args/env 到表单,提交走 upsert 语义(后端天然支持)

**建议改动(测试,2 个文件)**:
- `apps/web/src/composables/useAgent.test.ts`:stubMcpApi 的 PUT 分支回写 env 并断言透传
- 新增 `apps/web/src/components/McpPanel.test.ts`:mock agent store(mcp ref + saveMcpServer/testMcpServer vi.fn),断言表单提交携带 env、非法输入提示,参考 `WorkspacePickerModal.test.ts` 模式

**无需改动**:`packages/shared/src/index.ts`、`apps/api/src/agent/routes.ts`、`apps/api/src/mcpConfig.ts`、`apps/api/src/pi/mcpTools.ts`、`apps/web/src/composables/useAgent.ts`。

**注意点**:
- toggleEnabled 用 `{ ...server, enabled }` spread 保存,已天然保留 env,无需改动
- 后端对 env 校验严格(值必须 string),UI 解析时注意数字/布尔值需 `String()` 化
- 新增表单保存后自动 `handleTest` 会用新 env 测试连接,天然可验证 env 生效
