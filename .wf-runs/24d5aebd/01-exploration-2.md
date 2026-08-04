# 探索报告:网页右上角设置入口 + AnySearch API key 保存链路(前端与配置链路)

> 任务:调研 `workflows` 项目的前端与配置链路,规划「网页右上角加设置 icon → 点击弹模态窗输入 AnySearch API key → key 保存后供后端 pi SDK 搜索工具使用」的实现方案。
> 结论先行:**方案完全可行,且项目已有 90% 的现成机制可复用**——右上角加 icon、模态窗复用现有 `ApiKeyModal.vue` 模式、key 存储复用 `config.ts:saveConfig` 通用补丁机制、工具读取复用上一轮计划(02-plan-1.md)的 `getApiKey` 动态读取回调。前端 key **不应存 localStorage**,应走后端接口落 `.workflows/config.json`(与 DeepSeek key 完全同模式)。

---

## 0. 仓库概览(前端与配置链路视角)

- **形态**:Turborepo + pnpm 10 monorepo(`apps/api` Hono + pi SDK、`apps/web` Vue 3、`packages/shared` 共享类型)。
- **apps/web**:Vue 3.5 + TypeScript + Vite 8 + Tailwind CSS v4(`@tailwindcss/vite`)+ marked;**无任何组件库、无 pinia、无 axios**(详见 §1)。
- **apps/api**:Hono + `@hono/node-server` + `@earendil-works/pi-coding-agent@^0.83.0` + `typebox@1.3.7` + `@ff-labs/fff-node`;`config.ts` 是 `.workflows` JSON 存储层。
- **数据隔离约定**:一切运行数据存项目自身 `.workflows/`(开发在仓库根,生产在 `~/.workflows`),绝不读写 pi 全局 `~/.pi/agent`;`.workflows/` 已 gitignore。
- **构建/测试**:`pnpm dev`(web 15200,`/api` 代理到 3000)/ `pnpm build`(shared→api/web)/ `pnpm test`(Vitest;web 有 `App.test.ts`、`useAgent.test.ts`,api 有 `config.test.ts`、`app.test.ts` 等)。**改动 `packages/shared` 后必须先 `pnpm build`**。
- **相关前序产物**:`.wf-runs/24d5aebd/01-exploration-1.md`(AnySearch 工具后端可行性)、`02-plan-1.md`(实施计划:新建 `anySearchTools.ts` + 注册 + `StoredConfig.anySearchApiKey`;其中已规划 `getApiKey` 回调 = `loadConfig(this.store).anySearchApiKey`)。本报告补上前端与 key 传递链路,与 02-plan-1.md 无缝衔接。

## 1. 前端技术栈与结构(apps/web)

### 1.1 依赖清单要点(`apps/web/package.json`)

- **dependencies**:`vue@^3.5.40`、`marked@^18.0.7`(markdown 渲染)、`@fontsource/chakra-petch|instrument-sans|jetbrains-mono`(字体)、`@workflows/shared`(workspace 类型)。
- **devDependencies**:`vite@^8.2.0`、`@vitejs/plugin-vue`、`tailwindcss@^4.3.3` + `@tailwindcss/vite`、`vue-tsc`、`vitest`、`jsdom`、`@vue/test-utils`。
- **明确没有**:element-plus / naive-ui / antd 等组件库;**没有 pinia**;**没有 axios**。

### 1.2 目录结构(`apps/web/src`)

| 路径 | 说明 |
| --- | --- |
| `App.vue` | 根组件:组装三栏布局 + 三个模态窗(showSettings / showPicker / subModal 均为局部 `ref` 控制显隐) |
| `main.ts` / `style.css` | 入口;`style.css` 定义 Tailwind v4 `@theme` 设计 token(ink/panel/edge/signal 等) |
| `components/` | `PipelineHeader.vue`(顶栏)、`WorkspaceRail.vue`(左栏)、`ChatPane.vue`(中栏聊天)、`InfoPanel.vue`(右栏观测)、`MessageBubble.vue`、`DagPanel.vue`、`SessionSwitcher.vue`、`ApiKeyModal.vue`、`WorkspacePickerModal.vue`、`SubAgentModal.vue` |
| `composables/useAgent.ts` | **状态中心(非 pinia,单例实例 prop 下钻)**:config/workspaces/会话/SSE 消息;内含 `request<T>()` fetch 封装与 `saveApiKey()` |
| `utils/markdown.ts` | markdown 渲染 |

### 1.3 状态管理 / HTTP 客户端

- **状态管理**:无 pinia。`useAgent()` 在 `App.vue` 顶部调用一次得到 `AgentStore`,通过 props 下钻到各组件(`:agent="agent"`)。模态窗也以 `v-if` + `ref` 在 App.vue 统一控制。
- **HTTP 客户端**:原生 `fetch`,`useAgent.ts` 内私有 `request<T>()` 封装(解包 `{code,message,data}`,非 0 code 或 !ok 抛 `Error(message)`);`WorkspacePickerModal.vue` 另有自己的内联 fetch。**没有独立的 api 封装文件**,惯例是「相对路径 `/api/...` + 解包 body」。
- **baseURL**:无 baseURL 配置——开发由 Vite proxy(`vite.config.ts`:`'/api' → http://localhost:3000`),生产由 Hono 同源托管(`app.ts` SPA fallback + serveStatic),前端一律写相对路径 `/api/...`。

## 2. 右上角现状(改造点 1)

- **顶栏组件**:`apps/web/src/components/PipelineHeader.vue`(`<header class="relative z-10 flex h-12 shrink-0 items-center gap-4 border-b border-edge bg-panel/70 px-4 backdrop-blur">`)。
- **布局**:左 `w-60` 品牌区 → 中 flex-1 管线图(工作区→代理→观测)→ **右 `w-60 shrink-0 items-center justify-end gap-2` 状态区**。
- **右上角目前只有**:「LINK」标签 + 连接状态胶囊(API/离线),**没有设置 icon、没有用户信息/头像、没有菜单**。关键片段:

```html
<!-- 状态灯(PipelineHeader.vue 末尾) -->
<div class="flex w-60 shrink-0 items-center justify-end gap-2">
  <span class="font-mono text-[10px] tracking-wider text-faint">LINK</span>
  <span class="flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px]"
        :class="connected ? 'border-ok/40 bg-ok/5 text-ok' : 'border-err/40 bg-err/5 text-err'">
    <span class="size-1.5 rounded-full" :class="connected ? 'bg-ok' : 'bg-err'" />
    {{ connected ? 'API' : '离线' }}
  </span>
</div>
```

- **设置入口现状**:不在顶栏,而在 `ChatPane.vue` 两处——空状态按钮「配置 DeepSeek API KEY」(L191)与输入框上方「立即配置」链接(L277),均调 `onOpenSettings` prop → `App.vue` 置 `showSettings = true` → 渲染 `ApiKeyModal`。
- **图标现状**:全项目**无任何 SVG 图标**,UI 用 Unicode 字符(⏸ / ⇅ / ⚠ / ❯)+ 边框方块风格。设置 icon 建议沿用此风格(如 `⚙` 字符或「设置」文本按钮 + `border border-edge` 方块),与 `LINK` 胶囊同排。
- **改造点**:在 PipelineHeader 状态区加设置按钮,组件需新增 emit(如 `emit('open-settings')`)或新增 prop;App.vue 绑定 `showSettings`(与现有 `ChatPane` 入口共用同一 ref,天然合并)。

## 3. 模态窗现状(改造点 2)

- **无组件库 Modal/Dialog**,全部手写,统一模式(三个模态窗一致):
  - 遮罩:`fixed inset-0 z-50 grid place-items-center bg-ink/80 backdrop-blur-sm`,`@click.self` 关闭;
  - 面板:`w-full max-w-md border border-edge bg-panel p-6 shadow-2xl shadow-black/50`,右上「关闭」按钮;
  - 子组件 `defineEmits<{ close: [] }>()`,父组件 `v-if` 控制。
- **最佳参考 = 现成的 `ApiKeyModal.vue`**(本身就是 API key 模态窗,标题「连接 · CONNECT」):DeepSeek key 输入(`type="password"`)+ 保存按钮 + 已配置/未配置状态点 + 保存中/错误/成功提示 + 环境信息区。**新增 AnySearch key 输入区可直接在此组件内加第二个 section,或把组件泛化为「设置」模态窗**。
- 其余示例:`WorkspacePickerModal.vue`(目录选择器,含服务端 `fs/list` 拉取)、`SubAgentModal.vue`(子代理回看)。
- `App.vue` 模态窗挂载示例:

```vue
<ApiKeyModal v-if="showSettings" :agent="agent" :meta="meta" @close="showSettings = false" />
```

## 4. 前端→后端 API 调用方式(改造点 3)

- **前端调用**:`useAgent.ts` 内 `request<T>(url, init)`(fetch 封装,统一解包 `{code,message,data}`);业务方法如 `saveApiKey`:

```ts
async function saveApiKey(key: string): Promise<void> {
  await request('/api/agent/config/key', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  await refreshConfig()
}
```

- **后端路由注册**:`apps/api/src/agent/routes.ts` 的 `registerAgentRoutes(app, store, pi)`(由 `app.ts:initAgentRoutes()` 在启动时调用;`app.test.ts` 中也可独立注册测试)。现有 key 路由样例:

```ts
// 用户手动输入 DeepSeek API key,保存到 .workflows/config.json
app.put('/api/agent/config/key', async (c) => {
  const body = await readJson<{ apiKey?: string }>(c)
  const key = body?.apiKey?.trim()
  if (!key) throw new HTTPException(400, { message: 'API key 不能为空' })
  pi.setApiKey(key)
  return c.json({ code: 0, message: '已保存', data: pi.getConfig() })
})
```

- **统一响应**:`{ code, message, data }`(code 0 成功);错误经 `app.onError`(HTTPException → `{code: httpStatus, message, data:null}`),前端 `request` 抛 `Error(body.message)`。
- **AnySearch key 保存路由建议**:新增 `PUT /api/agent/config/anysearch-key`(body `{ apiKey }` → `pi.setAnySearchApiKey(key)`),或把现有路由泛化为带 `type` 字段(`{ type: 'deepseek'|'anysearch', apiKey }`)。推荐前者(改动最小、语义清晰,与 02-plan-1.md 的「不新增 HTTP 路由」计划不同——该计划只考虑了 env/config 手工写入,**前端输入必须有 HTTP 入口**,这是本次任务相对前序计划的新增点)。

## 5. 后端配置持久化(apps/api/src/config.ts)

- **StoredConfig 结构**(当前):

```ts
interface StoredConfig {
  apiKey?: string
  model?: string
  thinkingLevel?: string
}
```

- **读写机制**:纯 JSON 文件 `config.json`(开发 `<repo>/.workflows/`、生产 `~/.workflows/`,路径由 `workflowsRoot()` 按 `NODE_ENV` 决定;`createStore()` 返回各路径)。`readJson/writeJson` 宽松读写(文件缺失/损坏回退空对象)。**无 SQLite/KV**,存储面 = `config.json` + `workspaces.json` + `workspace-sessions.json` + `agent/`(auth/models/会话 JSONL)。
- **通用补丁机制已存在**(新增任意 key 字段零成本):

```ts
export function saveConfig(store: WorkflowsStore, patch: Partial<StoredConfig>): StoredConfig {
  const next = { ...loadConfig(store), ...patch }
  for (const [key, value] of Object.entries(patch)) {
    if (value === '' || value === null) delete (next as Record<string, unknown>)[key]  // 空串=删除
  }
  writeJson(store.configPath, next)
  return next
}
export function setApiKey(store: WorkflowsStore, key: string): void { saveConfig(store, { apiKey: key.trim() }) }
export function hasApiKey(store: WorkflowsStore): boolean { return Boolean(loadConfig(store).apiKey) }
```

- **结论**:扩展路径 = `StoredConfig` 加 `anySearchApiKey?: string` + 新增 `setAnySearchApiKey()`(与 02-plan-1.md Step 4 完全一致);`loadConfig` 宽松读取,旧配置无此字段不受影响。另有 `piService.storeConfig()`(私有,直接写文件,用于 model/thinkingLevel),新 key 走 `config.ts:saveConfig` 即可。

## 6. pi 工具如何读取配置(关键:key 流入工具执行)

- **DeepSeek key 现状(启动注入模式)**:`PiAgentService.create()` 启动时 `loadConfig` → `runtime.setRuntimeApiKey('deepseek', key)`;用户改 key 经 `pi.setApiKey` → `setApiKey(store, key)` + `runtime.setRuntimeApiKey(...)` 立即生效。
- **AnySearch 工具(动态读取模式,按 02-plan-1.md)**:`anySearchTools.ts` 的工厂接收 `getApiKey?: () => string | undefined` 回调,key 解析优先级 = `process.env.ANYSEARCH_API_KEY` → `getApiKey()` → 匿名;piService 注入:

```ts
const webTools = createAnySearchTools({
  getApiKey: () => loadConfig(this.store).anySearchApiKey ?? undefined,
})
```

- **为什么动态读取可行**:pi agent session 是服务端进程内的;AnySearch 工具是纯 HTTP 调用工具,`execute` 每次执行时同步 `loadConfig()`(同步读 JSON 文件,毫秒级),**前端保存的 key 写入 config.json 后,下一次工具调用即读到最新值,无需重启、无需重启会话**。这点与 DeepSeek 的运行时注入模式不同(那是 SDK 的 ModelRuntime 认证,需 `setRuntimeApiKey` 主动注入),AnySearch 工具自己发 HTTP 请求,动态读文件即可。
- **注册点**:`piService.openSession` 中 `customTools: [...guardedTools, ...webTools, ...subAgentTools]` 且 `tools` 白名单追加 `anysearch-search` / `anysearch-batch-search` / `anysearch-extract`(只读/读写两分支都要;SDK 的 allowedToolNames 会过滤 customTools,两步必须同步)。子代理默认不启用(02-plan-1.md 决策点 10,如需 explorer 联网再在 `subAgent.ts:buildSubAgentTools` 追加)。
- **状态回显**:`piService.getConfig()` 返回 `AgentConfig`(shared 类型),当前只有 `hasApiKey: boolean`(key 本身绝不返回)。建议 `AgentConfig` 增加 `hasAnySearchApiKey: boolean`,前端模态窗显示「已配置(可覆盖)」状态(仿 ApiKeyModal 的 `agent.hasApiKey` 绿点)。

## 7. 安全考量

- **现有防线**(DeepSeek key 已如此):
  - `.workflows/` 在 `.gitignore`(`# local workflows config (dev) .workflows/`),key 不进 git;
  - key 不返回前端:`getConfig()` 只回 `hasApiKey` 布尔;PUT 路由响应 `data: pi.getConfig()` 也不含 key;
  - `ApiKeyModal.vue` 文案明示「key 仅保存在后端配置文件中,不会写入任何 pi 全局配置,也不会返回给前端」;
  - 日志:app.onError 只打错误 message,不打印请求体;02-plan-1.md 要求 key 只进 Authorization 头、不进描述/日志/错误文本、错误提示用「API key 无效或未授权」等脱敏文案;
  - 输入框 `type="password"` + `autocomplete="off"`。
- **前端保存路径建议**:**走后端接口**(`PUT /api/agent/config/anysearch-key` → config.json),**不要存 localStorage**——理由:① 与 DeepSeek key 模式一致,单点存储便于服务端工具读取;② localStorage 明文暴露于浏览器 devtools/XSS,且与「key 不落前端」的既有安全声明矛盾;③ 后端存储天然 gitignore 保护。
- **注意点**:
  - `.workflows/config.json` 当前含一个真实 DeepSeek key(dev 环境,gitignored,无泄露风险,但印证存储路径真实可用);
  - API 无鉴权(本地开发工具,README 明示「本地开发工具,agent 本就可读全盘,故无额外鉴权」)——AnySearch key 路由沿用同策略即可;
  - 生产环境 key 落 `~/.workflows/config.json`,同样需确保权限(默认用户私有目录)。

## 8. 结论:可行性判断、改造点与 key 传递链路

### 8.1 可行性判断

**高**。前端无组件库但手写模态窗模式成熟(`ApiKeyModal.vue` 直接可扩展);顶栏右侧有明确空位(状态区);后端 `saveConfig` 通用补丁机制 + `loadConfig` 宽松读取,新增字段零成本;工具侧 02-plan-1.md 已规划 `getApiKey` 动态读取回调。唯一相对前序计划的新增点:**需要新增一个保存 AnySearch key 的 HTTP 路由**(02-plan-1.md 当时只考虑 env/手工写 config)。

### 8.2 改造点清单(按实现顺序)

1. **顶栏加设置 icon**:`PipelineHeader.vue` 状态区(`w-60` 内、LINK 胶囊前/后)加 `⚙` 或「设置」按钮 → 新增 `emit('open-settings')`;`App.vue` 绑 `@open-settings="showSettings = true"`(与 ChatPane 现有入口共用 `showSettings`)。
2. **模态窗**:`ApiKeyModal.vue` 增加「AnySearch API key」输入 section(仿 DeepSeek 段:password 输入 + 保存 + 已配置状态点),或泛化为 SettingsModal 两个 section;`useAgent.ts` 新增 `saveAnySearchApiKey(key)`(PUT `/api/agent/config/anysearch-key` → `refreshConfig()`)。
3. **shared 类型**:`AgentConfig` 增加 `hasAnySearchApiKey: boolean`(改后必须 `pnpm build`)。
4. **后端存储**:`config.ts` `StoredConfig` 加 `anySearchApiKey?: string` + `setAnySearchApiKey()` + `hasAnySearchApiKey()`;`piService.getConfig()` 回显新布尔;新增 `pi.setAnySearchApiKey(key)`。
5. **后端路由**:`routes.ts` 新增 `PUT /api/agent/config/anysearch-key`(校验非空 → `pi.setAnySearchApiKey` → 返回 `pi.getConfig()`)。
6. **工具读取**:按 02-plan-1.md 落地 `anySearchTools.ts` + `piService.openSession` 注册 + `getApiKey: () => loadConfig(this.store).anySearchApiKey`。

### 8.3 key 传递链路(前端 → 后端存储 → pi 工具)

```
用户点右上角 ⚙(PipelineHeader emit)
  → ApiKeyModal 输入 AnySearch key
  → useAgent.saveAnySearchApiKey(key)
  → PUT /api/agent/config/anysearch-key          (routes.ts)
  → pi.setAnySearchApiKey → config.setAnySearchApiKey → saveConfig(store, { anySearchApiKey })
  → .workflows/config.json 落盘(gitignore 保护)
  → pi 工具执行时:anySearchTools execute → getApiKey 回调 → loadConfig(store).anySearchApiKey
    (服务端进程内同步读文件,每次 execute 读最新值,无需重启)
  → Authorization: Bearer <key> → POST https://api.anysearch.com/mcp(JSON-RPC)
  → 结果 Markdown 50KB 截断回给 LLM/前端 SSE
```

### 8.4 涉及文件清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `apps/web/src/components/PipelineHeader.vue` | 修改 | 右上加设置按钮 + `emit('open-settings')` |
| `apps/web/src/App.vue` | 修改 | 绑定 header 的 open-settings → showSettings(已有 ApiKeyModal 挂载) |
| `apps/web/src/components/ApiKeyModal.vue` | 修改 | 增加 AnySearch key 输入 section(仿 DeepSeek 段) |
| `apps/web/src/composables/useAgent.ts` | 修改 | `saveAnySearchApiKey()` + `hasAnySearchApiKey` computed |
| `packages/shared/src/index.ts` | 修改 | `AgentConfig` 加 `hasAnySearchApiKey`(**需 pnpm build**) |
| `apps/api/src/config.ts` | 修改 | `StoredConfig.anySearchApiKey` + `setAnySearchApiKey()` + `hasAnySearchApiKey()` |
| `apps/api/src/pi/piService.ts` | 修改 | `setAnySearchApiKey()`、`getConfig()` 回显、`createAnySearchTools` 注册(02-plan-1.md) |
| `apps/api/src/agent/routes.ts` | 修改 | 新增 `PUT /api/agent/config/anysearch-key` |
| `apps/api/src/pi/anySearchTools.ts` | 新建 | 3 个搜索工具(按 02-plan-1.md) |
| `apps/api/src/pi/anySearchTools.test.ts`、`apps/api/scripts/verify-anysearch.mjs` | 新建 | 测试与验证(按 02-plan-1.md) |
| `apps/web/src/composables/useAgent.test.ts`、`apps/api/src/config.test.ts` 等 | 修改(可选) | 补新链路测试 |

### 8.5 风险点

1. **shared 类型改动需重建**:改 `AgentConfig` 后 api/web 的 workspace 依赖消费构建产物,未 `pnpm build` 会 TS 检查失败(AGENTS.md 明示)。
2. **模态窗语义**:现有 ApiKeyModal 标题为「连接 · CONNECT」、专指 DeepSeek;加 AnySearch 段后注意文案区分(如 section 标题「ANYSEARCH」),并保持「key 不返回前端」的声明。
3. **白名单遗漏**:工具注册必须 customTools 与 tools 白名单同步(02-plan-1.md 验收清单已含显式断言)。
4. **key 泄露面**:沿用「只进 Authorization 头、不进日志/描述/错误文本、不返回前端」三原则;输入框 password + autocomplete off。
5. **环境变量优先级**:`ANYSEARCH_API_KEY` 优先于 config——若用户同时配置两者,UI 状态可能显示「已配置」而实际走 env;可在模态窗标注「环境变量优先」。
