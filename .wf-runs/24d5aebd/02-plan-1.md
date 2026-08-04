# 实施计划:pi SDK 添加 AnySearch 网络搜索自定义工具

> 依据:`.wf-runs/24d5aebd/01-exploration-1.md`(机制/注册点/测试范式已核实)+ 已实测确认的 AnySearch API 信息(本计划直接采用,不再核实)。
> 结论先行:新建 `apps/api/src/pi/anySearchTools.ts`(仿 fffTools.ts 工厂模式,实现 3 个工具)+ 在 `piService.openSession` 注册进 `customTools` 与 `tools` 白名单 + 补单测与真实调用验证脚本。

---

## 1. 目标与范围

### 做什么
1. 新建 `apps/api/src/pi/anySearchTools.ts`:实现 **3 个**网络工具(共享一个 JSON-RPC 调用 helper):
   - `anysearch-search`(search,核心工具)
   - `anysearch-batch-search`(batch_search,1-5 个 query 并行)
   - `anysearch-extract`(extract,抓取网页转 Markdown)
2. 在 `apps/api/src/pi/piService.ts` 的 `openSession` 中注册:加入 `customTools` 数组 + `tools` 白名单(只读/非只读两个分支都加)。
3. 扩展 `apps/api/src/config.ts` 的 `StoredConfig` 增加可选 `anySearchApiKey` 字段(env 优先,config 回退;不新增 HTTP 路由)。
4. 新建 `apps/api/src/pi/anySearchTools.test.ts`(vitest,mock fetch)与 `apps/api/scripts/verify-anysearch.mjs`(真实匿名调用验证)。

### 不做什么(v1 明确排除)
- ❌ 不实现 `get_sub_domains`(垂直域发现):双参数 `domain`/`domains` 形态带来 schema 歧义,且该能力可用 search 近似;v2 可一行扩展进工厂。
- ❌ 不加 HTTP 路由/前端 UI 配置入口(key 靠环境变量或手工编辑 `.workflows/config.json`)。
- ❌ 不把搜索工具加入子代理工具集 `subAgent.ts:buildSubAgentTools`(见 §6 决策点;留一行扩展位)。
- ❌ 不引入新 npm 依赖(Node ≥20.19 原生 `fetch`/`AbortSignal.any` 已满足);不改 `workspaceGuard.ts`(工具无 path 参数,无需路径守卫)。
- ❌ 不改动任何既有工具行为与白名单既有条目。

---

## 2. 文件清单

| 操作 | 文件 | 要点 |
| --- | --- | --- |
| 新建 | `apps/api/src/pi/anySearchTools.ts` | 工厂 `createAnySearchTools(options?)` + 共享 JSON-RPC helper + 3 个工具定义 |
| 新建 | `apps/api/src/pi/anySearchTools.test.ts` | vitest 单测(注入 mock fetch) |
| 新建 | `apps/api/scripts/verify-anysearch.mjs` | 无依赖 Node 脚本,真实匿名调 `tools/list` + `search` |
| 修改 | `apps/api/src/pi/piService.ts` | import 工厂;`guardedTools`/`activeTools` 追加(2 处) |
| 修改 | `apps/api/src/config.ts` | `StoredConfig` 加 `anySearchApiKey?: string` + `setAnySearchApiKey()` helper |

---

## 3. 实施步骤

### Step 1:新建 `apps/api/src/pi/anySearchTools.ts`

**结构**(整体仿 `fffTools.ts`:TypeBox schema + `ToolDefinition<typeof schema>` 泛型 + 截断/错误文本风格):

```ts
import { Type, type Static } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'

const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/mcp'
const ANYSEARCH_CLIENT = 'workflows/1.0.0'          // X-Anysearch-Client 头
const MAX_OUTPUT_BYTES = 50 * 1024                   // 与 fff 工具对齐
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESULTS_DEFAULT = 10

export interface AnySearchToolOptions {
  /** 返回 API key(可选)。优先级:env ANYSEARCH_API_KEY > 此函数 > 匿名 */
  getApiKey?: () => string | undefined
  /** 测试注入用,默认全局 fetch */
  fetchImpl?: typeof fetch
  /** 默认 ANYSEARCH_ENDPOINT */
  endpoint?: string
  /** 默认 30s */
  timeoutMs?: number
}
```

**共享 helper**(本文件核心,三个工具复用):

1. `resolveApiKey(opts)`:返回 `process.env.ANYSEARCH_API_KEY ?? opts.getApiKey?.() ?? undefined`(env 优先,config 回退,再无则匿名)。
2. `callAnySearch<T>(opts, name, args, signal)`:
   - 组合信号:`AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])`(Node ≥20.19 支持;用户中止透传)。
   - 请求:`POST <endpoint>`,头:`Content-Type: application/json` + 可选 `Authorization: Bearer <key>` + `X-Anysearch-Client: workflows/1.0.0`;体:`{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }`。
   - 响应防御性解析(逐层兜底,任何异常落到可读错误文本,不让 execute 抛未捕获异常,abort 除外):
     - `res.ok === false` → 按状态码映射:401/403 → `AnySearch 错误:API key 无效或未授权(可匿名调用或检查 ANYSEARCH_API_KEY)`;429 → `AnySearch 错误:请求过于频繁(限流),请稍后重试`;5xx → `AnySearch 错误:服务端错误(HTTP xxx)`;其他 → `AnySearch 错误:HTTP xxx`。
     - `res.json()` 失败(非 JSON)→ `AnySearch 错误:响应不是合法 JSON`。
     - `raw.error` 存在 → `AnySearch 错误(<code>): <message>`。
     - `raw.result.isError === true` → 用 content 文本作为错误信息。
     - 正常 → 返回 `raw.result`。
3. `extractContentText(content)`:content 为数组时取 `type === 'text'` 的 `text` 拼接,非 text 项 `JSON.stringify` 兜底;content 为字符串直接用;其他类型序列化。
4. `truncateOutput(text)`:`Buffer.byteLength > 50KB` 时 `slice(0, 50KB)` 并追加 `\n\n[50KB limit reached]`(与 fff 工具一致;UTF-8 截断按现有 slice 惯例)。
5. `abortIfSignaled(signal)`:aborted 时 throw `'Operation aborted'`(与 fff 一致)。
6. 错误返回风格与 fff 一致:预期错误(HTTP/API/限流)返回 `{ content: [{ type: 'text', text: 'AnySearch 错误:...' }], details: undefined }` 而非抛错;仅 abort 抛错。

**三个工具定义**(参数名与 API 一致,直接透传,避免映射层):

```ts
// anysearch-search
const searchSchema = Type.Object({
  query: Type.String({ description: '搜索查询关键词(必填)。支持自然语言或关键词组合' }),
  max_results: Type.Optional(Type.Number({ description: '最多返回结果数,1-10,默认 10', minimum: 1, maximum: 10 })),
  domain: Type.Optional(Type.String({ description: '限定搜索的垂直领域(可选)' })),
  sub_domain: Type.Optional(Type.String({ description: '领域下的子域(可选,需与 domain 搭配)' })),
  sub_domain_params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: '子域参数(可选)' })),
})
// anysearch-batch-search
const batchSearchSchema = Type.Object({
  queries: Type.Array(
    Type.Object({
      query: Type.String({ description: '搜索查询关键词' }),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
      domain: Type.Optional(Type.String()),
      sub_domain: Type.Optional(Type.String()),
      sub_domain_params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    { minItems: 1, maxItems: 5, description: '1-5 个搜索请求,并行执行,适合多角度调研' },
  ),
})
// anysearch-extract
const extractSchema = Type.Object({
  url: Type.String({ description: '要抓取并转换为 Markdown 的网页 URL(必填,仅 http/https)' }),
})
```

**description 草稿**(写清何时用/参数/匿名支持):

- `anysearch-search`:`网络搜索(AnySearch Search API)。当需要工作区之外的外部信息——最新动态、公开文档、第三方库用法、时事新闻、API 变更等——时使用;工作区内信息请用 fff-find/fff-grep 或 read。参数:query 必填;max_results 1-10 默认 10;可选 domain/sub_domain/sub_domain_params 限定垂直领域。支持匿名调用(限流更低),设置环境变量 ANYSEARCH_API_KEY(或 .workflows/config.json 的 anySearchApiKey)可提升额度。返回 Markdown 格式搜索结果(标题/URL/摘要)。结果来自外部网络,可信度请自行判断,引用前建议用 anysearch-extract 核实原文。`
  - `promptSnippet`: `Search the web (AnySearch, anonymous OK)`
- `anysearch-batch-search`:`批量网络搜索(AnySearch batch_search):一次提交 1-5 个 query 并行搜索,适合多角度/多关键词调研。每个 query 的参数与 anysearch-search 相同。返回按查询分组的 Markdown 结果。支持匿名调用。`
  - `promptSnippet`: `Batch web search, 1-5 queries in parallel`
- `anysearch-extract`:`抓取指定网页并转换为 Markdown(AnySearch extract)。用于阅读 anysearch-search 结果中的链接原文或任意公开网页;API 侧约 50K 字符截断,本地再按 50KB 截断。仅支持公开可访问的 http/https URL。支持匿名调用。`
  - `promptSnippet`: `Extract a web page to Markdown`

**execute 统一实现模式**(每个工具):

```ts
async execute(_toolCallId, params, signal, _onUpdate): Promise<AgentToolResult<undefined>> {
  abortIfSignaled(signal)
  try {
    const result = await callAnySearch<T>(opts, 'search', params, signal)  // 透传 signal
    if (!result) return toolError('空响应')
    const text = truncateOutput(extractContentText(result?.content))
    return { content: [{ type: 'text', text }], details: undefined }
  } catch (error) {
    if (error instanceof Error && error.message === 'Operation aborted') throw error
    return toolError(error instanceof Error ? error.message : String(error))
  }
}
```

**导出**:`createAnySearchTools(options?: AnySearchToolOptions): ToolDefinition[]`(返回 3 个工具,供注册);内部工厂 `createSearchTool/createBatchSearchTool/createExtractTool` 导出供单测。

**预期结果**:`tsc` 独立可编译;无新依赖;工具名与 SDK 内置(`read/write/edit/bash/ls/grep/find`)及现有自定义(`fff-find/fff-grep/wait_for_approval/complete_task`)无冲突。

### Step 2:新建 `apps/api/src/pi/anySearchTools.test.ts`(vitest)

注入 `fetchImpl` mock(仿 `fffTools.test.ts` 的 `exec()` 助手直接调 `tool.execute(...)`,第 5 参传 `undefined as never`)。用例清单:

1. search 请求构造:method=POST、endpoint 正确、`Content-Type` 正确、body 为 JSON-RPC 2.0(`tools/call` + name + arguments 透传);无 key 时**不带** `Authorization` 头。
2. 有 key(经 `getApiKey`)→ 带 `Authorization: Bearer <key>`;env `ANYSEARCH_API_KEY` 存在时**优先于** `getApiKey`(vi.stubEnv / 临时写 process.env)。
3. 成功响应(标准 `result.content[].text`)→ 文本透传。
4. >50KB 输出 → 截断且含 `[50KB limit reached]`。
5. JSON-RPC `error` 字段 → 错误文本含 code/message。
6. `result.isError === true` → 错误文本。
7. HTTP 429 / 401 / 500 → 对应中文错误映射。
8. content 含非 text 项(如 `{type:'image'}`)→ JSON 序列化兜底不抛。
9. fetch reject(网络异常)→ 错误文本。
10. 预置 aborted 的 signal → throw `Operation aborted`。
11. batch-search:queries 数组原样进 body;extract:url 原样进 body。
12. 超时:fetchImpl 挂起 + timeoutMs 设小(如 50ms)→ 返回超时错误(AbortSignal.timeout 生效)。

**预期结果**:`pnpm --filter @workflows/api test` 全绿(既有 6 个测试文件 + 新文件)。

### Step 3:新建 `apps/api/scripts/verify-anysearch.mjs`(真实调用验证)

无依赖 Node 脚本(全局 fetch):
1. 匿名 `POST https://api.anysearch.com/mcp` `tools/list` → 断言返回 4 个工具(search/batch_search/get_sub_domains/extract),打印名称。
2. 匿名 `tools/call` `search`,`{ query: 'pi coding agent SDK custom tools', max_results: 3 }` → 断言 `result.content[0].text` 为 Markdown 文本(含标题/URL 特征),打印前 500 字符。
3. 失败(非 2xx / JSON-RPC error / 无 content)→ 打印错误、`process.exit(1)`。
4. 若设置了 `ANYSEARCH_API_KEY`,自动带上 `Authorization` 头(脚本同时验证 key 路径,不打印 key 本身)。

运行:`node apps/api/scripts/verify-anysearch.mjs`(需联网;实测匿名 2 秒内返回)。脚本保留在仓库作开发工具。

### Step 4:修改 `apps/api/src/config.ts`

- `StoredConfig` 增加:`anySearchApiKey?: string`(可选,不破坏旧配置——`loadConfig` 为 `readJson` 宽松读取)。
- 新增 helper(仿 `setApiKey`):
  ```ts
  /** 保存 AnySearch API key(可选;env ANYSEARCH_API_KEY 优先于 config) */
  export function setAnySearchApiKey(store: WorkflowsStore, key: string): void {
    saveConfig(store, { anySearchApiKey: key.trim() })
  }
  ```
- 安全确认:`.workflows/` 已在 .gitignore(探索报告已核实),config.json 中的 key 不进 git。**不做**新 HTTP 路由(v1 手工编辑或环境变量即可)。

### Step 5:修改 `apps/api/src/pi/piService.ts`(注册)

改动点(仅 `openSession`,约 4 处小改):

1. import 区(第 18 行附近)追加:`import { createAnySearchTools } from './anySearchTools.js'`。
2. 在 `searchTools` 构建之后、`guardedTools` 之前:
   ```ts
   // 网络搜索工具:无 path 参数,不需 guardPathTool;key 可匿名,env 优先,config 回退
   const webTools = createAnySearchTools({
     getApiKey: () => loadConfig(this.store).anySearchApiKey ?? undefined,
   })
   const webToolNames = webTools.map((t) => t.name)
   ```
3. `guardedTools` 两个分支(只读/非只读)追加 `...webTools`:
   - 只读:`[...nonSearchTools, ...searchTools, ...webTools]`
   - 非只读:`[...nonSearchTools, ...searchTools, ...webTools, toToolDefinition(createBashTool(...))]`
4. `activeTools` 两个分支追加 `...webToolNames`:
   - 只读:`['read', 'ls', ...searchNames, ...webToolNames]`
   - 非只读:`['read', 'bash', 'edit', 'write', ...searchNames, ...webToolNames]`
   - 关键注释已核实:「SDK 的 allowedToolNames(tools 参数)会过滤 customTools 注册表」——**只加 customTools 不加 tools 白名单 = 工具不可见**,两步必须同时做。

**预期结果**:会话创建时 `customTools` 含 3 个网络工具,白名单含其名字;既有工具不受影响;`piService.test.ts` 既有用例不受影响(它们直测 execute,不依赖会话工具集)。

### Step 6:全量验证

按 §5 验证方式执行。

### Step 7:收尾审查

- `git status` / diff 审查:确认改动面仅 5 个文件;确认无 key 出现在代码/日志/描述中。
- 若本机 `.workflows/config.json` 曾手工加过 `anySearchApiKey`,确认仍在 gitignore 覆盖下。

---

## 4. 工具定义细节汇总(§3 Step 1 的验收性摘要)

- **协议**:JSON-RPC 2.0,`POST https://api.anysearch.com/mcp`,`{ jsonrpc:'2.0', id:1, method:'tools/call', params:{ name, arguments } }`。
- **认证**:`Authorization: Bearer <key>`(可选);解析优先级 = `process.env.ANYSEARCH_API_KEY` → `opts.getApiKey()`(piService 注入 config 回退)→ 匿名。`X-Anysearch-Client: workflows/1.0.0` 恒发。
- **execute**:`abortIfSignaled` → `AbortSignal.any([timeout(30s), userSignal?])` 透传 fetch → 错误映射(HTTP 状态 / JSON-RPC error / isError / 非 JSON / 空响应)→ `extractContentText` → 50KB 截断 → `{ content:[{type:'text',text}], details:undefined }`。预期错误返回错误文本(不抛),仅 abort 抛 `Operation aborted`。
- **schema**:参数名与 API 字段一一对应(snake_case 透传);`max_results` 1-10 默认 10;`queries` 1-5(minItems/maxItems);`url` 必填。
- **描述**:每个工具写明「何时用 / 参数 / 匿名支持 / 外部内容可信度提示」,附一行英文 `promptSnippet`。

---

## 5. 验证方式(可执行)

```bash
# 1. 类型检查
pnpm --filter @workflows/api typecheck

# 2. Lint
pnpm --filter @workflows/api lint

# 3. 全量单测(vitest,含新 anySearchTools.test.ts 与既有 6 个文件)
pnpm --filter @workflows/api test

# 4. 真实匿名调用验证(需联网;预期 tools/list 返回 4 个工具、search 2 秒内返回 Markdown 文本)
node apps/api/scripts/verify-anysearch.mjs

# 5. 可选端到端(手动):pnpm dev 起服务,在工作台向 agent 下达含「搜索 xxx」的任务,观察工具调用
```

仓库无 bun 测试;测试框架为 **vitest**(`apps/api/package.json` scripts.test = `vitest run`),已确认。

---

## 6. 风险与规避

| # | 风险 | 规避 |
| --- | --- | --- |
| 1 | **key 泄露** | key 只进 `Authorization` 头;不进描述/日志/错误文本(401 只给通用提示,不回显 key);`.workflows/` 已 gitignore;env 优先于 config;verify 脚本不打印 key |
| 2 | **超时** | 默认 30s `AbortSignal.timeout` + 用户 signal 经 `AbortSignal.any` 合并(Node ≥20.19 满足;若环境 <20.3,计划内保留手动 AbortController 兼容分支);超时/中止返回明确信息,模型可重试 |
| 3 | **结果过大污染上下文** | 50KB 字节截断 + `[50KB limit reached]` 提示(与 fff 工具同模式);extract 依赖 API 50K 字符截断 + 本地二次截断 |
| 4 | **JSON-RPC 响应结构变化** | 逐层防御:HTTP 状态 → JSON 解析 → `error` 字段 → `result.isError` → content 类型分支(非 text 序列化兜底)→ 空响应;任何未知结构落到可读错误文本,不抛未处理异常(abort 除外) |
| 5 | **匿名限流低 / 429** | 429 映射为可读提示并引导配置 key;描述中写明匿名可用但限流更低;若生产频繁 429,v2 再加 UI 配置入口 |
| 6 | **tools 白名单遗漏导致工具不可见** | SDK 的 `allowedToolNames` 会过滤 customTools 注册表——`customTools` 与 `tools` 必须同步添加;验收清单含两条显式断言(§7 第 6 条) |
| 7 | **外部内容可信度 / 安全** | 描述明确「结果来自外部网络,需自行判断可信度」;extract 仅接受 `http://`/`https://` 前缀 URL(拒绝 `file://` 等),纯服务端抓取不执行 JS |
| 8 | **路径越界** | 工具无 path 参数,不包 `guardPathTool`;未来若加路径类参数须重新评估(计划内标注) |
| 9 | **回归** | 改动为纯追加(数组追加 + 可选字段),不触碰既有工具与既有白名单条目;全量 vitest 防回归 |
| 10 | **子代理不可用搜索(决策点)** | v1 默认仅主代理可用;如产品上需要 explorer 子代理直接联网,在 `subAgent.ts:buildSubAgentTools` 追加 `tools.push(...createAnySearchTools())` 并在 `activeNames` 加名(工厂可复用,约 2 行,env 匿名路径无需 store);本计划**不默认启用**,避免扩大改动面 |
| 11 | **回滚** | 无数据迁移/无 DB/无构建产物变更:git 还原 5 个文件(删 3 新建、还原 2 修改)即完整回滚;已生成会话 JSONL 不受影响,零成本 |

---

## 7. 验收标准(逐条核对)

- [ ] 1. `apps/api/src/pi/anySearchTools.ts` 存在,导出 `createAnySearchTools(options?)` 与单工具工厂;无新 npm 依赖。
- [ ] 2. 工具清单恰为 3 个:`anysearch-search` / `anysearch-batch-search` / `anysearch-extract`;TypeBox schema 满足:query 必填、max_results 1-10 默认 10、queries 1-5(min/maxItems)、url 必填;参数名与 API snake_case 一致直接透传。
- [ ] 3. execute:AbortSignal 透传(含 timeout 合并);错误映射覆盖 HTTP 状态/JSON-RPC error/isError/非 JSON/空响应;50KB 截断带提示;无 key 时匿名调用且不带 Authorization 头。
- [ ] 4. key 解析:env `ANYSEARCH_API_KEY` 优先 → `getApiKey()`(config 回退)→ 匿名;key 不出现在描述/日志/错误文本。
- [ ] 5. `piService.ts`:`customTools` 含 3 个网络工具;**`tools` 白名单在只读与非只读两个分支都含 3 个名字**。
- [ ] 6. `config.ts`:`StoredConfig.anySearchApiKey` 可选字段 + `setAnySearchApiKey`;旧 config.json 无该字段时 `loadConfig` 正常。
- [ ] 7. `anySearchTools.test.ts` 覆盖 §3 Step 2 的 ≥10 个用例,`pnpm --filter @workflows/api test` 全绿(含既有测试)。
- [ ] 8. `pnpm --filter @workflows/api typecheck`、`pnpm --filter @workflows/api lint` 全绿。
- [ ] 9. `node apps/api/scripts/verify-anysearch.mjs` 真实匿名调用成功:tools/list 返回 4 个工具、search 返回 Markdown 文本(含标题/URL),2 秒内完成。
- [ ] 10. 改动面仅 5 个文件(3 新建 + 2 修改);`git status` 确认无 key 落库、无意外文件变更。
- [ ] 11. 工具描述含:何时用/参数说明/匿名支持/外部内容可信度提示;`promptSnippet` 一行英文。
