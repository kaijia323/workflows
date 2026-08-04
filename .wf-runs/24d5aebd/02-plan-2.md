# 实施计划(修订版):为 workflows 项目 pi SDK 添加 AnySearch 网络搜索工具

> 状态:**本计划替代已废弃的 `02-plan-1.md`**(该版误用 MCP 端点 `POST https://api.anysearch.com/mcp`,且无前端链路)。
> 依据:`01-exploration-2.md`(前端链路)+ 本任务附带的**已实测确认的 AnySearch REST API 契约**(直接采用,不再核实)。
> 结论先行:后端新建 1 个 REST 搜索工具 `anysearch-search` + 注册进 `customTools`/`tools` 白名单;配置存储加 `anySearchApiKey` 字段 + 新增保存路由;前端右上角加 ⚙ 设置入口,复用 `ApiKeyModal.vue` 增加 AnySearch 输入区;shared 类型加 `hasAnySearchApiKey` 回显布尔。key 不落前端、不进日志/描述/错误文本,`env ANYSEARCH_API_KEY` 优先于 config。

---

## 1. 目标与范围

### 做什么
1. 新建 `apps/api/src/pi/anySearchTools.ts`:实现 **1 个** REST 网络搜索工具 `anysearch-search`(与 fff-find/fff-grep 的 kebab-case 命名一致;batch/extract 无 REST 文档支持,v1 不做)。
2. `piService.ts` 注册:加入 `customTools` 数组 + `tools` 白名单(只读/非只读两个分支**同步**添加)。
3. `config.ts`:`StoredConfig` 加 `anySearchApiKey?: string` + `setAnySearchApiKey()` + `hasAnySearchApiKey()`。
4. `routes.ts`:新增 `PUT /api/agent/config/anysearch-key`(仿现有 `/api/agent/config/key`)。
5. shared 类型:`AgentConfig` 加 `hasAnySearchApiKey: boolean`(改后必须 `pnpm build`)。
6. 前端:PipelineHeader 右上角 ⚙ → ApiKeyModal 增加 AnySearch 输入区 → useAgent 增加 `saveAnySearchApiKey` + `hasAnySearchApiKey`。
7. 测试与验证:`anySearchTools.test.ts`(mock fetch,≥8 用例)+ `verify-anysearch.mjs`(真实匿名调用)+ typecheck/lint/test/build。

### 不做什么(v1 明确排除)
- ❌ 不实现 `anysearch-batch-search` / `anysearch-extract`(MCP 专属能力,无 REST 文档,实测契约只有 `/v1/search`);不在工具层做多 query 并行(模型可多次调用同一工具)。
- ❌ 不实现 tags 目录发现接口(`get_sub_domains` 为 MCP 方法,REST 无对应端点);改为在工具描述内嵌 17 个 domain 列表 + 引导「不确定用 general.general 或不传 tag」。
- ❌ 不把搜索工具加入子代理工具集 `subAgent.ts:buildSubAgentTools`(留扩展位,约 2 行,见 §7 风险 10)。
- ❌ 不引入新 npm 依赖(Node ≥20.19 原生 fetch/AbortSignal.any 已满足;根 package.json engines 已确认 `>=20.19.0`)。
- ❌ 不改 `workspaceGuard.ts`(工具无 path 参数)。
- ❌ 不在前端存 localStorage;不返回 key 明文(仅回显 `hasAnySearchApiKey` 布尔)。
- ❌ 不改动既有工具行为与既有白名单条目。

---

## 2. 已实测 API 契约(实现基准,直接采用)

| 项 | 值 |
| --- | --- |
| 端点 | `POST https://api.anysearch.com/v1/search`(**非 MCP**) |
| 认证 | 可选 `Authorization: Bearer <API_KEY>`;无 key 匿名调用(按 IP 限流 + 消耗每日免费额度);无需额外 client 头 |
| 请求体 | `{ query: string(必选), max_results?: int(1-20,默认10), tag?: string("{domain}.{sub_domain}",如 "code.doc";非法 tag → 400), zone?: "cn"\|"intl", language?: string(如 zh-CN/en), params?: object(透传 AnyMix 扩展), format?: "json"\|"markdown"(markdown 时 results[].content 为 Markdown 文本,结构不变) }` |
| 成功 | HTTP 200 `{"code":0,"message":"success","request_id":"...","data":{"results":[{"title","url","snippet","content"}],"metadata":{"total_results","search_time_ms"}}}`;content 可能 33-43KB,**必须截断** |
| 错误 | HTTP 非 2xx(400/401/402/403/415/429/500/502/503/504),body `{"code":-1,"message":"...","request_id":"..."}`;错误码含 invalid_request/invalid_api_key/rate_limit_exceeded/quota_exhausted |
| tags | 17 个 domain:academic/agriculture/business/code/energy/environment/film/finance/gaming/general/health/ip/legal/resource/security/social_media/travel;部分 sub_domain 需 params(如 `code.doc` 需 `{"library":"golang"}`) |

---

## 3. 文件清单

| # | 操作 | 文件 | 要点 |
| --- | --- | --- | --- |
| 1 | 修改 | `packages/shared/src/index.ts` | `AgentConfig` 加 `hasAnySearchApiKey: boolean`(**改后必须 `pnpm build`**) |
| 2 | 修改 | `apps/api/src/config.ts` | `StoredConfig.anySearchApiKey?` + `setAnySearchApiKey()` + `hasAnySearchApiKey()` |
| 3 | 新建 | `apps/api/src/pi/anySearchTools.ts` | 工厂 `createAnySearchTools(options?)` + `ANYSEARCH_DOMAINS` 常量 + 1 个工具 |
| 4 | 修改 | `apps/api/src/pi/piService.ts` | `setAnySearchApiKey()`、`getConfig()` 回显、openSession 注册(4 处小改) |
| 5 | 修改 | `apps/api/src/agent/routes.ts` | 新增 `PUT /api/agent/config/anysearch-key` |
| 6 | 修改 | `apps/web/src/composables/useAgent.ts` | `saveAnySearchApiKey()` + `hasAnySearchApiKey` computed |
| 7 | 修改 | `apps/web/src/components/ApiKeyModal.vue` | 增加 AnySearch 输入 section(与 DeepSeek 分段,独立保存) |
| 8 | 修改 | `apps/web/src/components/PipelineHeader.vue` | 右上角 ⚙ 按钮 + `emit('open-settings')` |
| 9 | 修改 | `apps/web/src/App.vue` | 绑定 `@open-settings="showSettings = true"` |
| 10 | 新建 | `apps/api/src/pi/anySearchTools.test.ts` | vitest,mock fetch,≥8 用例 |
| 11 | 新建 | `apps/api/scripts/verify-anysearch.mjs` | 真实匿名调用 `/v1/search` |
| 12 | 修改(可选) | `apps/api/src/config.test.ts` | 补 `setAnySearchApiKey`/`hasAnySearchApiKey` 用例 |
| 13 | 修改(可选) | `apps/web/src/composables/useAgent.test.ts` | 补 `saveAnySearchApiKey` 用例 |

**改动面**:5 新建/修改核心后端 + 3 前端 + 1 shared(可选测试 2 个)。无新依赖、无 DB、无迁移。

---

## 4. 实施步骤

### Step 0:前置约定(顺序敏感)
- 改 `packages/shared` 后,**必须先** `pnpm --filter @workflows/shared build`(或根 `pnpm build`,turbo 自动按依赖序),否则 api/web 消费的是旧 dist 类型,typecheck 失败。
- 本次所有命令按 `apps/api/package.json` scripts(`typecheck`=tsc --noEmit、`lint`=eslint、`test`=vitest run)与 `apps/web/package.json`(`build`=vue-tsc -b && vite build)执行。

### Step 1:shared 类型(`packages/shared/src/index.ts`)
`AgentConfig`(约 L64)加一行:
```ts
export interface AgentConfig {
  /** 是否已配置 DeepSeek API key */
  hasApiKey: boolean
  /** 是否已配置 AnySearch API key(env ANYSEARCH_API_KEY 优先于配置文件) */
  hasAnySearchApiKey: boolean
  // ...其余不变
}
```
**预期结果**:`pnpm --filter @workflows/shared build` 通过,dist 类型含新字段。

### Step 2:配置存储(`apps/api/src/config.ts`)
1. `StoredConfig` 加字段(可选,不破坏旧 config.json——`loadConfig` 为 `readJson` 宽松读取,缺字段回退空对象):
```ts
interface StoredConfig {
  apiKey?: string
  anySearchApiKey?: string   // AnySearch 搜索 API key(可选;env ANYSEARCH_API_KEY 优先)
  model?: string
  thinkingLevel?: string
}
```
2. 新增两个 helper(仿 `setApiKey`/`hasApiKey`,置于其下):
```ts
/** 保存用户手动输入的 AnySearch API key 到 .workflows/config.json(空串=删除,由 saveConfig 处理) */
export function setAnySearchApiKey(store: WorkflowsStore, key: string): void {
  saveConfig(store, { anySearchApiKey: key.trim() })
}

/** 是否已配置 AnySearch key(不把 key 本身返回给前端) */
export function hasAnySearchApiKey(store: WorkflowsStore): boolean {
  return Boolean(loadConfig(store).anySearchApiKey)
}
```
**预期结果**:`config.test.ts` 既有用例不受影响;可选新增用例覆盖新 helper(见 Step 8)。

### Step 3:新建 `apps/api/src/pi/anySearchTools.ts`(核心)

**常量与选项**:
```ts
import { Type, type Static } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'

const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/v1/search'   // 实测 REST 端点(非 MCP!)
const MAX_OUTPUT_BYTES = 50 * 1024           // 与 fff 工具对齐
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESULTS = 10
const MAX_RESULTS_LIMIT = 20                 // 实测 1-20

/** 17 个内置 domain(实测 tags 目录;sub_domain 目录未经完整实测,不做执行期硬校验) */
export const ANYSEARCH_DOMAINS = [
  'academic','agriculture','business','code','energy','environment','film',
  'finance','gaming','general','health','ip','legal','resource','security',
  'social_media','travel',
] as const

export interface AnySearchToolOptions {
  /** 返回 API key(可选)。优先级:env ANYSEARCH_API_KEY > 此函数 > 匿名 */
  getApiKey?: () => string | undefined
  /** 测试注入用,默认全局 fetch */
  fetchImpl?: typeof fetch
  /** 测试注入用,默认 ANYSEARCH_ENDPOINT */
  endpoint?: string
  /** 测试注入用,默认 30s */
  timeoutMs?: number
}
```
**关于 AnySearchTags 常量文件的决策**:**不单独建文件**,`ANYSEARCH_DOMAINS`(17 个 domain)内联在 `anySearchTools.ts` 并导出。理由:① 描述引用只需 17 个 domain 名,信息量小;② sub_domain 目录未完整实测,无法内嵌可信映射表,单独文件收益低;③ 避免多一个模块。执行期**不做 tag 前置校验**(sub_domain 目录不可信,误拒比 API 400 更糟),非法 tag 由 API 400 映射为可读错误。

**schema(全参数透传,与 API 字段一一对应)**:
```ts
const searchSchema = Type.Object({
  query: Type.String({ description: '搜索查询关键词(必填)。支持自然语言或关键词组合' }),
  max_results: Type.Optional(Type.Number({
    description: '最多返回结果数,1-20,默认 10', minimum: 1, maximum: MAX_RESULTS_LIMIT,
  })),
  tag: Type.Optional(Type.String({
    description: '垂直领域标签,格式 {domain}.{sub_domain}(如 "code.doc")。可用 domain:' +
      ANYSEARCH_DOMAINS.join('/') + ';不确定具体 sub_domain 时用 general.general 或不传。部分 sub_domain 需配合 params(如 code.doc 需 {"library":"golang"})',
  })),
  zone: Type.Optional(Type.Union([Type.Literal('cn'), Type.Literal('intl')], {
    description: '搜索区域:cn 或 intl(可选)',
  })),
  language: Type.Optional(Type.String({ description: '结果语言(可选,如 zh-CN / en)' })),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'AnyMix 扩展参数,透传给 API(可选;如 tag=code.doc 时 {"library":"golang"})',
  })),
  format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('markdown')], {
    description: '响应格式:json 或 markdown(默认 markdown,content 为 Markdown 文本)',
  })),
})
type SearchParams = Static<typeof searchSchema>
```

**私有 helper**(本文件核心):
1. `resolveApiKey(opts)`:`process.env.ANYSEARCH_API_KEY?.trim() || opts.getApiKey?.()?.trim() || undefined`(env 优先 → config 回退 → 匿名)。
2. `abortIfSignaled(signal)`:aborted 时 `throw new Error('Operation aborted')`(与 fff 一致)。
3. `callSearch(opts, params, signal)`:
   - 组合信号:`AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), ...(signal ? [signal] : [])])`(Node ≥20.19,engines 已确认;用户中止透传)。
   - 请求:`POST <endpoint>`,头 `Content-Type: application/json` + **可选** `Authorization: Bearer <key>`(无 key 不带该头);body 为 `{ query, max_results, tag, zone, language, params, format }`(undefined 字段剔除,不发送)。
   - **防御性分层解析**(任何异常落到可读错误文本,不让 execute 抛未捕获异常,abort 除外):
     a. `res.ok === false` → `mapHttpError(status, bodyMessage)`(见下);
     b. `res.json()` 失败 → `AnySearch 错误:响应不是合法 JSON`;
     c. body 存在且 `code !== 0`(含业务错误 `code:-1`)→ `mapBusinessError(message)`;
     d. `data` 缺失或 `data.results` 非数组 → `AnySearch 错误:响应结构异常(缺少 results)`;
     e. 正常 → 返回 `{ results, metadata }`。
4. `mapHttpError(status, message?)`:
   - `400` → `AnySearch 请求参数错误(HTTP 400):${message ?? '请检查 query/tag/max_results 等参数'}`(非法 tag 的 API message 原样透出,帮助用户修正);
   - `401/403` → `AnySearch 错误:API key 无效或未授权(可匿名调用或检查配置的 key)`;
   - `402` → `AnySearch 错误:账户额度已用完(quota exhausted),请检查配额`;
   - `415` → `AnySearch 请求格式不支持(HTTP 415)`;
   - `429` → `AnySearch 错误:请求过于频繁(限流),请稍后重试或配置 API key 提升额度`;
   - `>=500` → `AnySearch 服务端错误(HTTP ${status}),请稍后重试`;
   - 其他 → `AnySearch 请求失败(HTTP ${status})`。
5. `mapBusinessError(message)`:`message` 含 `invalid_api_key` → 同 401 文案;含 `rate_limit_exceeded` → 同 429 文案;含 `quota_exhausted` → 同 402 文案;否则 → `AnySearch 错误:${message}`。
6. `renderResults(data, format)`:
   - `format === 'markdown'`(默认):`results.map(r => r.content ?? \`### ${r.title}\n\n${r.url}\n\n${r.snippet ?? ''}\`).join('\n\n---\n\n')`;
   - `json`:逐条 `[i] title\nurl\nsnippet`;
   - 头部加 `搜索完成:共 ${metadata?.total_results ?? results.length} 条,耗时 ${metadata?.search_time_ms ?? '?'} ms`。
7. `truncateOutput(text)`:`Buffer.byteLength(text) > MAX_OUTPUT_BYTES` 时 `text.slice(0, MAX_OUTPUT_BYTES) + '\n\n[50KB limit reached]'`(与 fff 工具一致)。

**工具定义**:
```ts
export function createAnySearchSearchTool(opts: AnySearchToolOptions = {}): ToolDefinition<typeof searchSchema> {
  return {
    name: 'anysearch-search',
    label: 'anysearch-search',
    description:
      '网络搜索工具(AnySearch Search API)。当需要工作区之外的外部信息——最新动态、公开文档、' +
      '第三方库用法、时事新闻、API 变更等——时使用;工作区内信息请用 fff-find/fff-grep 或 read。' +
      '参数:query 必填;max_results 1-20 默认 10;可选 tag(格式 {domain}.{sub_domain},如 "code.doc")' +
      '限定垂直领域,可用 domain:' + ANYSEARCH_DOMAINS.join('/') +
      ';不确定具体 sub_domain 时直接用 general.general 或不传 tag;部分 sub_domain 需配合 params' +
      '(如 code.doc 需 {"library":"golang"});zone 可选 cn|intl;language 可选(如 zh-CN/en);' +
      'format 可选 json|markdown(默认 markdown,content 为 Markdown 文本)。' +
      '支持匿名调用(按 IP 限流、消耗每日免费额度),设置环境变量 ANYSEARCH_API_KEY 或在设置面板配置 key 可提升额度。' +
      '返回 Markdown 格式搜索结果(标题/URL/摘要/正文)。结果来自外部网络,可信度请自行判断,引用前建议核实原文。',
    promptSnippet: 'Search the web (AnySearch, anonymous OK)',
    parameters: searchSchema,
    async execute(_toolCallId, params: SearchParams, signal, _onUpdate): Promise<AgentToolResult<undefined>> {
      abortIfSignaled(signal)
      try {
        if (!params.query.trim()) return toolError('query 不能为空')
        const data = await callSearch(opts, params, signal)
        if (!data) return toolError('空响应')
        const text = truncateOutput(renderResults(data, params.format ?? 'markdown'))
        return { content: [{ type: 'text', text }], details: undefined }
      } catch (error) {
        if (error instanceof Error && error.message === 'Operation aborted') throw error
        return toolError(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

function toolError(error: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text: `AnySearch 错误:${error}` }], details: undefined }
}

/** 工厂:返回工具数组(与 fffTools 模式一致,便于后续追加 batch/extract) */
export function createAnySearchTools(options?: AnySearchToolOptions): ToolDefinition[] {
  return [createAnySearchSearchTool(options ?? {})]
}
```
**预期结果**:`tsc` 独立可编译;无新依赖;工具名与既有(`read/write/edit/bash/ls/grep/find`、`fff-find/fff-grep`、`wait_for_approval/complete_task`、子代理名)无冲突。

### Step 4:注册(`apps/api/src/pi/piService.ts`)
改动点(仅 `openSession` 与配置方法,约 6 处小改):
1. import 区追加:`import { createAnySearchTools } from './anySearchTools.js'`;config import 追加 `hasAnySearchApiKey, setAnySearchApiKey`。
2. 配置方法区(仿 `setApiKey`):
```ts
/** 保存 AnySearch API key(仅存 .workflows/config.json;工具执行时动态读取,无需运行时注入) */
setAnySearchApiKey(key: string): void {
  setAnySearchApiKey(this.store, key)
}
```
3. `getConfig()` 返回对象加一行:`hasAnySearchApiKey: hasAnySearchApiKey(this.store)`。
4. `openSession` 中,在 `searchTools` 构建之后、`guardedTools` 之前:
```ts
// 网络搜索工具:无 path 参数,不需 guardPathTool;key 可匿名,env 优先,config 回退(动态读取,保存后立即生效)
const webTools = createAnySearchTools({
  getApiKey: () => loadConfig(this.store).anySearchApiKey ?? undefined,
})
const webToolNames = webTools.map((tool) => tool.name)
```
5. `guardedTools` 两个分支(只读/非只读)追加 `...webTools`。
6. `activeTools` 两个分支追加 `...webToolNames`(关键注释已核实:「SDK 的 allowedToolNames(tools 参数)会过滤 customTools 注册表」——**customTools 与 tools 必须同步**,只加其一工具不可见):
```ts
const activeTools = workspace.readOnly
  ? ['read', 'ls', ...searchNames, ...webToolNames]
  : ['read', 'bash', 'edit', 'write', ...searchNames, ...webToolNames]
```
**预期结果**:会话创建时 `customTools` 含 `anysearch-search`,白名单两个分支均含其名;`piService.test.ts` 既有用例不受影响(直测 execute,不依赖会话工具集)。

### Step 5:路由(`apps/api/src/agent/routes.ts`)
在 `PUT /api/agent/config/key` 之后新增(仿其实现):
```ts
// 用户手动输入 AnySearch API key,保存到 .workflows/config.json(工具执行时动态读取)
app.put('/api/agent/config/anysearch-key', async (c) => {
  const body = await readJson<{ apiKey?: string }>(c)
  const key = body?.apiKey?.trim()
  if (!key) throw new HTTPException(400, { message: 'API key 不能为空' })
  pi.setAnySearchApiKey(key)
  return c.json({ code: 0, message: '已保存', data: pi.getConfig() })
})
```
- 响应 `data: pi.getConfig()` 只含 `hasAnySearchApiKey` 布尔,**key 明文不出后端**。
- 不做删除/清空接口(v1 与 DeepSeek key 路由一致,仅覆盖写;`saveConfig` 的空串删除语义保留给未来)。
**预期结果**:`pnpm --filter @workflows/api dev` 下 `curl -X PUT localhost:3000/api/agent/config/anysearch-key -d '{"apiKey":"test"}'` 返回 `{code:0, data:{hasAnySearchApiKey:true,...}}`;空 key 返回 400。

### Step 6:前端链路
**6a. `apps/web/src/composables/useAgent.ts`**:
- 加 computed(仿 `hasApiKey`):`const hasAnySearchApiKey = computed(() => config.value?.hasAnySearchApiKey ?? false)`。
- 加方法(仿 `saveApiKey`):
```ts
/** 用户手动输入 AnySearch API key,保存到 .workflows/config.json */
async function saveAnySearchApiKey(key: string): Promise<void> {
  await request('/api/agent/config/anysearch-key', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  })
  await refreshConfig()
}
```
- return 中追加 `hasAnySearchApiKey` 与 `saveAnySearchApiKey`。
**预期结果**:`pnpm --filter @workflows/web typecheck` 通过(需先 Step 1 build shared)。

**6b. `apps/web/src/components/ApiKeyModal.vue`**:
- 标题「连接 · CONNECT」保留;面板内改为**两个 section**,中间 `border-t border-edge` 分隔。
- Section 1(现有 DeepSeek 段,原样保留,文案加前缀「DEEPSEEK」小标题)。
- Section 2(新增 AnySearch 段,状态独立):
  - 小标题 `ANYSEARCH · 网络搜索`(font-mono text-[10px] tracking-wider text-faint);
  - 说明文案:`AnySearch 搜索 API key(可选)。不配置时工具以匿名方式调用(按 IP 限流并消耗每日免费额度)。key 仅保存在后端配置文件中,不会返回给前端;环境变量 ANYSEARCH_API_KEY 优先于此处配置。`;
  - 独立 `anyKeyInput` / `anySaving` / `anyError` / `anySaved` 状态;独立表单(仿 DeepSeek 段:`type="password"` + `autocomplete="off"` + placeholder `anysearch-…`);
  - 保存按钮独立(`保存`),状态点:`agent.hasAnySearchApiKey.value` → `已配置(可覆盖)`(绿点)/ `未配置(匿名可用)`(faint);
  - 保存流程:`await props.agent.saveAnySearchApiKey(key)` → 清空输入 → 显示 `已保存到后端配置`。
- **交互决策**:两段**独立保存按钮**(避免「当前保存的是哪个 key」歧义);共用右上「关闭」与遮罩点击关闭;错误/成功提示各自独立显示。
**预期结果**:模态窗打开后可见两个输入区,任一保存互不干扰,状态点正确反映 `hasAnySearchApiKey`。

**6c. `apps/web/src/components/PipelineHeader.vue`**:
- `script setup` 加:`const emit = defineEmits<{ 'open-settings': [] }>()`。
- 右上 `w-60` 状态区,LINK 胶囊之前加按钮(与现有边框方块风格一致,Unicode 字符当图标):
```html
<button
  type="button"
  title="设置"
  class="grid size-6 place-items-center border border-edge font-mono text-[11px] text-dim transition hover:border-signal/60 hover:text-signal"
  @click="emit('open-settings')"
>⚙</button>
```
**预期结果**:顶栏右侧出现 ⚙ 按钮,点击触发 open-settings。

**6d. `apps/web/src/App.vue`**:
- `<PipelineHeader ... @open-settings="showSettings = true" />`(与 ChatPane 现有入口共用 `showSettings`,天然合并)。
**预期结果**:点击 ⚙ 打开 ApiKeyModal;ChatPane 的「配置 DeepSeek API KEY」入口仍可用。

### Step 7:单测(`apps/api/src/pi/anySearchTools.test.ts`)
注入 `fetchImpl` mock(仿 `fffTools.test.ts` 的 `exec()` 助手直接调 `tool.execute('id', params, signal, undefined, undefined as never)`)。fetch mock 需支持 signal 监听(abort 时 reject `AbortError`)。用例清单(**≥8 个**):
1. **请求构造**:method=POST、endpoint=`https://api.anysearch.com/v1/search`、`Content-Type: application/json`、body 含 `query` 及透传的 `max_results/tag/zone/language/params/format`(全参数透传);无 key 时**不带** `Authorization` 头。
2. **key 解析**:`getApiKey` 提供 key → 带 `Authorization: Bearer <key>`;`vi.stubEnv('ANYSEARCH_API_KEY', ...)` 时 **env 优先于 getApiKey**;两者皆无 → 匿名无头。
3. **成功解析**:标准响应(results 含 title/url/snippet/content)→ 输出文本含标题/URL;`format:'markdown'` 时 content 原文透出,`format:'json'` 时走 title/url/snippet 渲染。
4. **截断**:content 构造 >50KB → 输出 ≤50KB 且含 `[50KB limit reached]`。
5. **HTTP 错误映射**:400(含 API message,如非法 tag)/401/403/402/415/429/500 → 对应中文文案(429 含「限流」提示,401 含「匿名」提示)。
6. **业务错误**:HTTP 200 但 `code:-1` + message 含 `rate_limit_exceeded`/`invalid_api_key` → 映射为限流/鉴权文案。
7. **非 JSON 响应**:`res.json()` 失败 → `响应不是合法 JSON`;`data.results` 缺失 → `响应结构异常`。
8. **网络异常**:fetch reject → 错误文本(不抛未捕获异常)。
9. **abort**:预置 aborted signal → throw `Operation aborted`(唯一透传的异常)。
10. **超时**:fetchImpl 挂起 + `timeoutMs: 50` → 超时错误(AbortSignal.timeout 生效)。
11. **query 校验**:`query: ''` → `query 不能为空`。
（可选)12. **metadata 渲染**:total_results/search_time_ms 出现在输出头部。

### Step 8:可选补测
- `apps/api/src/config.test.ts`:复用 `createTestStore()` 模式,补 `setAnySearchApiKey` 落盘 + `hasAnySearchApiKey` 真假 + 旧配置无字段时 `loadConfig` 正常。
- `apps/web/src/composables/useAgent.test.ts`:补 `saveAnySearchApiKey` 调 `PUT /api/agent/config/anysearch-key` 并刷新 config(mock fetch)。

### Step 9:验证脚本(`apps/api/scripts/verify-anysearch.mjs`)
无依赖 Node 脚本(全局 fetch),**真实匿名调用**:
1. `POST https://api.anysearch.com/v1/search`,body `{ query: 'pi coding agent SDK', max_results: 3, format: 'markdown' }`,无 Authorization 头 → 断言 HTTP 200、`body.code === 0`、`Array.isArray(body.data.results)`、`results.length >= 1` 且首条含 `title`/`url`;打印首条 title/url 与前 500 字符 content。
2. 若 `process.env.ANYSEARCH_API_KEY` 存在,再带 `Authorization: Bearer <key>` 调一次,断言成功(同时验证 key 路径;不打印 key 本身)。
3. 任何断言失败 → 打印错误详情、`process.exit(1)`。
4. 保留在仓库作开发工具(与 `copy-agents.mjs` 同目录)。
运行:`node apps/api/scripts/verify-anysearch.mjs`(需联网;实测匿名 2 秒内返回)。

### Step 10:全量验证
按 §6 验证方式执行,最后 `git status`/diff 审查(见 §7 回滚)。

---

## 5. 工具定义细节汇总(Step 3 的验收性摘要)

- **协议**:REST,`POST https://api.anysearch.com/v1/search`(非 MCP);body `{ query, max_results?, tag?, zone?, language?, params?, format? }`,undefined 字段剔除。
- **认证**:`Authorization: Bearer <key>`(可选);解析优先级 = `process.env.ANYSEARCH_API_KEY` → `opts.getApiKey()`(piService 注入 `loadConfig(store).anySearchApiKey`)→ 匿名。无额外 client 头。
- **execute**:`abortIfSignaled` → query 空校验 → `callSearch`(`AbortSignal.any([timeout(30s), userSignal?])` 透传)→ 分层错误映射(HTTP 状态 / 业务 code / 非 JSON / 结构异常 / 网络异常)→ `renderResults` → 50KB 截断 → `{ content:[{type:'text',text}], details:undefined }`。预期错误返回错误文本(不抛),仅 abort 抛 `Operation aborted`。
- **schema**:参数名与 API 字段一一对应透传;`max_results` 1-20 默认 10;`tag` 描述内嵌 17 domain + general.general 引导;`zone` 枚举 cn|intl;`format` 枚举 json|markdown 默认 markdown。
- **描述**:「何时用 / 全参数说明 / tag 用法与 17 domain / 匿名支持与 key 配置 / 外部内容可信度提示」+ 一行英文 `promptSnippet`。

---

## 6. 验证方式(可执行)

```bash
# 0. shared 改动后必须先构建(turbo 自动按依赖序,或单独构建)
pnpm --filter @workflows/shared build

# 1. 类型检查(api + web)
pnpm --filter @workflows/api typecheck
pnpm --filter @workflows/web typecheck

# 2. Lint
pnpm --filter @workflows/api lint
pnpm --filter @workflows/web lint

# 3. 全量单测(vitest;api 含新 anySearchTools.test.ts 与既有 6+ 文件,web 含 useAgent.test.ts)
pnpm --filter @workflows/api test
pnpm --filter @workflows/web test

# 4. 真实匿名调用验证(需联网;预期 code=0、results 非空、2 秒内返回)
node apps/api/scripts/verify-anysearch.mjs

# 5. 前端构建
pnpm --filter @workflows/web build

# 6. 端到端手动(可选):pnpm dev → 右上 ⚙ → AnySearch 区输入 key 保存
#    → 向 agent 下达「搜索 xxx(如 go 语言 http 库推荐)」→ 观察 anysearch-search 工具调用与结果展示
```

---

## 7. 风险与规避

| # | 风险 | 规避 |
| --- | --- | --- |
| 1 | **shared 类型改动未重建导致 typecheck 失败** | 改 `AgentConfig` 后必须 `pnpm --filter @workflows/shared build`(turbo 根 build 自动按依赖序);Step 0 已前置 |
| 2 | **白名单遗漏导致工具不可见** | SDK 的 `allowedToolNames(tools)` 会过滤 `customTools` 注册表——`customTools` 与 `tools` **必须同步**添加;验收清单含两个分支的显式断言 |
| 3 | **key 泄露** | key 只进 `Authorization` 头;错误文案脱敏(401 只给通用提示,不回显 key);`getConfig()` 只回 `hasAnySearchApiKey` 布尔;`.workflows/` 已 gitignore;verify 脚本不打印 key;输入框 `type="password"` + `autocomplete="off"` |
| 4 | **content 过大污染上下文** | 50KB 字节截断 + `[50KB limit reached]`(与 fff 同模式);实测 content 33-43KB,截断后安全 |
| 5 | **响应结构变化** | 分层防御:HTTP 状态 → JSON 解析 → code!==0 → data.results 数组校验 → 单条字段容错(`content ?? title/url/snippet` 拼接);任何未知结构落到可读错误文本,不抛未捕获异常(abort 除外) |
| 6 | **匿名限流 / 429 / 配额** | 429/402 映射为可读提示并引导配置 key;描述写明匿名可用但受限;UI 标注「环境变量优先」 |
| 7 | **env 与 config 优先级歧义** | env `ANYSEARCH_API_KEY` 恒优先;若仅配置 env,UI 状态点显示「未配置」但工具实际可用——模态窗文案明示「环境变量优先于此处配置」 |
| 8 | **非法 tag 400** | 400 错误映射透出 API message 帮助用户修正;描述内嵌 17 domain + 引导 general.general;不做不可信的前置 sub_domain 校验 |
| 9 | **AbortSignal.any 兼容性** | 根 engines `>=20.19.0` 已确认;若未来降级 Node,预留手动 AbortController 合并分支(注释标注) |
| 10 | **子代理不可用搜索(决策点)** | v1 仅主代理可用;如需 explorer 联网,在 `subAgent.ts:buildSubAgentTools` 追加 `tools.push(...createAnySearchTools())` + `activeNames` 加名(约 2 行,工厂可复用);本计划**不默认启用** |
| 11 | **超时** | 默认 30s `AbortSignal.timeout` + 用户 signal 经 `AbortSignal.any` 合并;超时/中止返回明确信息,模型可重试 |
| 12 | **回滚** | 无数据迁移/无 DB/无构建产物变更:git 还原列出的 12-13 个文件(删 3 新建、还原修改)即完整回滚;`.workflows/config.json` 中已写入的 `anySearchApiKey` 为纯增量字段,不影响任何既有读取 |
| 13 | **回归** | 改动为纯追加(数组追加 + 可选字段 + 新 section),不触碰既有工具/白名单/模态窗 DeepSeek 段;全量 vitest 防回归 |

---

## 8. 验收标准(逐条核对)

**后端工具**
- [ ] 1. `apps/api/src/pi/anySearchTools.ts` 存在,导出 `createAnySearchTools(options?)`、`createAnySearchSearchTool`、`ANYSEARCH_DOMAINS`(恰为 17 个 domain);无新 npm 依赖。
- [ ] 2. 工具恰为 1 个:`anysearch-search`;schema 含 `query`(必填)/`max_results`(1-20 默认 10)/`tag`/`zone`(cn|intl)/`language`/`params`/`format`(json|markdown,默认 markdown),参数名与 API 一致直接透传。
- [ ] 3. execute 调 `POST https://api.anysearch.com/v1/search`(非 MCP 端点);AbortSignal 透传(30s timeout + 用户 signal 经 AbortSignal.any);错误映射覆盖 HTTP 400/401/402/403/415/429/5xx、业务 code!==0(rate_limit_exceeded/invalid_api_key/quota_exhausted)、非 JSON、结构异常、网络异常;50KB 截断带提示;query 空校验。
- [ ] 4. key 解析:env `ANYSEARCH_API_KEY` 优先 → `getApiKey()` → 匿名;无 key 时不带 Authorization 头;key 不出现在描述/日志/错误文本。
- [ ] 5. 描述含:何时用、全参数说明、17 domain 列表、general.general 引导、匿名支持与 key 配置说明、外部内容可信度提示;`promptSnippet` 一行英文。

**注册与配置**
- [ ] 6. `piService.ts`:`customTools` 含 `anysearch-search`;`tools` 白名单**只读与非只读两个分支**均含 `anysearch-search`;`getApiKey` 注入 `loadConfig(this.store).anySearchApiKey`。
- [ ] 7. `piService.setAnySearchApiKey(key)` 存在(写 config,无运行时注入);`getConfig()` 返回 `hasAnySearchApiKey: boolean`,不含 key 明文。
- [ ] 8. `config.ts`:`StoredConfig.anySearchApiKey?: string` + `setAnySearchApiKey()` + `hasAnySearchApiKey()`;旧 config.json 无该字段时 `loadConfig` 正常。
- [ ] 9. `routes.ts`:`PUT /api/agent/config/anysearch-key` 存在,空 key 返回 400,成功返回 `{code:0, data: pi.getConfig()}`。

**前端**
- [ ] 10. `PipelineHeader.vue` 右上状态区有 ⚙ 按钮(Unicode 字符、边框方块风格、hover 高亮),点击 emit `open-settings`;`App.vue` 绑定 `showSettings = true`。
- [ ] 11. `ApiKeyModal.vue` 含 DeepSeek / AnySearch 两个独立 section,独立输入框(password + autocomplete off)、独立保存按钮、独立状态点(`agent.hasAnySearchApiKey` → 已配置(可覆盖)/未配置(匿名可用))、独立错误/成功提示;文案含「环境变量 ANYSEARCH_API_KEY 优先」与「key 不返回前端」声明。
- [ ] 12. `useAgent.ts` 导出 `saveAnySearchApiKey`(PUT `/api/agent/config/anysearch-key` + refreshConfig)与 `hasAnySearchApiKey` computed。

**测试与验证**
- [ ] 13. `anySearchTools.test.ts` 覆盖 §4 Step 7 的 ≥8 个用例(mock fetch),`pnpm --filter @workflows/api test` 全绿(含既有测试)。
- [ ] 14. `pnpm --filter @workflows/api typecheck`、`pnpm --filter @workflows/api lint`、`pnpm --filter @workflows/web typecheck`、`pnpm --filter @workflows/web lint`、`pnpm --filter @workflows/web test` 全绿。
- [ ] 15. `node apps/api/scripts/verify-anysearch.mjs` 真实匿名调用成功:HTTP 200、code=0、results 非空、打印首条 title/url;设置 `ANYSEARCH_API_KEY` 时 key 路径同样成功(不打印 key)。
- [ ] 16. `pnpm --filter @workflows/web build` 成功。
- [ ] 17. `git status` 确认改动面仅计划内文件(3 新建 + 6-7 修改 + 可选 2 测试);无 key 落库、无意外文件变更。
