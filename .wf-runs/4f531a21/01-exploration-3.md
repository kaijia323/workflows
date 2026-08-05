# 01 探索报告(3):MCP 工具注册机制调研

> 目标:调研 workflows 仓库的「MCP 工具注册机制」,为规划「注册一个内置 MCP 视觉理解工具(调用小米 mimo-v2.5 视觉模型)」提供事实依据。
> 调研对象:仓库根 `C:/Users/kaijia/codes/github/workflows`(Turborepo monorepo);pi SDK 版本 `@earendil-works/pi-ai@0.83.0` / `@earendil-works/pi-coding-agent@0.83.0`。
> 关联产物:本 run 已有 `01-exploration-1.md`(LLM 接入/provider 泛化路线)与 `02-plan-1.md`(provider 泛化实施计划);本报告聚焦**工具注册机制**,与前述路线互补。
> 说明:`.workflows/config.json` 存在真实 API key,本报告一律脱敏,不复制原文。

---

## 0. 结论先行(摘要)

1. **本仓库没有"内置 MCP 视觉工具"现成物**,但有两条清晰的注册通道可复用:
   - **通道 A(内置工具通道,推荐)**:仿 `anySearchTools.ts` 写一个内置工具工厂(如 `vision-understand`),在 `piService.ts openSession()` 与 `subAgent.ts runSubAgent()/buildSubAgentTools()` **双点注册** + 工具名白名单,execute 内用 `fetch` 调 `https://api.xiaomimimo.com/v1/chat/completions`(mimo-v2.5)。此路径无子进程、无 stdio、保存即生效需重开会话(与 anysearch 一致)。
   - **通道 B(MCP 通道)**:`mcp.json` 配置外部 MCP server(stdio),`createMcpTools()` 拉 `tools/list` 包装为 `mcp__<server>__<tool>` 注册。**但 v1 明确不做 MCP server 端**(docs/mcp.md §7 ADR),内置工具走此通道需要自建 stdio server 进程,成本高、不推荐。
2. **pi SDK 无任何内置 MCP API**(无 registerMcp/McpServer/内置 MCP client);MCP 客户端是仓库自建(官方 `@modelcontextprotocol/sdk@^1.30.0`,仅 stdio 传输,`McpConnection` 抽象预留了 HTTP/SSE 扩展点)。
3. **工具返回图片有 SDK 类型支持但全链路不通**:`AgentToolResult.content` 可含 `ImageContent { type:'image', data(base64), mimeType }`;但仓库的 SSE 事件(`SessionEvent`)、历史(`HistoryBlock`)、前端渲染(`MessageBubble.vue`)全是纯文本管道,`mcpTools.ts` 把 MCP 图片降级为 `[image, mime, bytes]` 占位文本;若视觉工具要"看图",喂图入口(`session.prompt(text, {images})`)与回显图片都需扩展(见 §7 与 02-plan-1.md 已规划的 image block)。
4. 视觉工具调用 mimo-v2.5 的 **API key 建议复用 `XIAOMI_API_KEY` env 优先 + config.json 存储**模式(仿 anysearch 的 `getApiKey` 注入),API 协议为 OpenAI 兼容 `chat/completions`(内置 xiaomi provider 目录已确认 baseUrl 与模型参数,见探索-1 §4.2)。

---

## 1. 仓库概览(与本任务相关部分)

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 工具工厂 | `apps/api/src/pi/anySearchTools.ts` / `fffTools.ts` / `mcpTools.ts` | 三类内置/外部工具的注册工厂 |
| 会话注入 | `apps/api/src/pi/piService.ts`(主代理 `openSession`)、`apps/api/src/pi/subAgent.ts`(子代理 `runSubAgent`/`buildSubAgentTools`) | 工具列表注入点(**双点注册**) |
| MCP 配置存储 | `apps/api/src/mcpConfig.ts` | `mcp.json` 独立存储(load/save/upsert/remove/校验/原子写) |
| API 路由 | `apps/api/src/agent/routes.ts` | `/api/agent/mcp*` CRUD + 测试 + SSE prompt |
| 共享类型 | `packages/shared/src/index.ts` | `McpServerConfig` / `SessionEvent` / `HistoryBlock`(改后需 `pnpm build`) |
| 前端 | `apps/web/src/composables/useAgent.ts`(SSE 接入)、`components/MessageBubble.vue`(工具卡片)、`components/McpPanel.vue`(MCP 管理 UI) | 工具调用渲染 |
| MCP SDK | `apps/api/node_modules/@modelcontextprotocol/sdk`(^1.30.0) | 官方 MCP client 库(stdio/sse/streamableHttp/websocket 传输类齐全,仓库仅用 stdio) |

构建/测试:pnpm + turbo;`pnpm build`(shared → api/web)、`pnpm typecheck`、`pnpm test`(Vitest,api 有 `mcpTools.test.ts`/`mcpRefresh.test.ts`/`anySearchTools.test.ts` 可仿)。**约定:改动 shared 类型必须重建**;`apps/api/scripts/copy-agents.mjs` 负责复制 agents/*.md。

---

## 2. 需求相关模块清单

| 文件 | 一句话说明 |
| --- | --- |
| `apps/api/src/pi/mcpTools.ts` | ★ MCP client 工厂:`McpConnection` 抽象、`StdioMcpConnection`、`McpManager`(单例缓存)、`createMcpTools`、`toMcpToolDefinition`、`testMcpServer` |
| `apps/api/src/mcpConfig.ts` | ★ `mcp.json` 独立存储:`loadMcpServers`/`saveMcpServers`/`upsertMcpServer`/`removeMcpServer`/`mcpConfigPath`,校验失败零写入 + tmp/rename 原子写 |
| `apps/api/src/pi/piService.ts` | ★ 主代理会话:`openSession()` 组装工具集(内置 + fff + anysearch + mcp + 编排)、`createAgentSession({ customTools, tools })`;`mapSessionEvent` 做 SSE 事件映射;`refreshMcpForOpenSessions` 配置变更重建会话 |
| `apps/api/src/pi/subAgent.ts` | ★ 子代理:`buildSubAgentTools()`(工具集 + 白名单)、`runSubAgent()`(同样 `createMcpTools` + 注册)、`toSubEvents`(sub_* 事件镜像) |
| `apps/api/src/pi/anySearchTools.ts` | ★ 内置 HTTP 工具范本:`createAnySearchTools` 工厂 + `callSearch`(fetch/超时/错误映射/50KB 截断)——视觉工具直接照抄此模式 |
| `apps/api/src/pi/workspaceGuard.ts` | 工具路径守卫(`guardPathTool`/`guardToolSet`/`toToolDefinition`);无 path 参数的工具(anysearch)不守卫 |
| `apps/api/src/agent/routes.ts` | `/api/agent/mcp` GET/PUT/DELETE、`/api/agent/mcp/:name/test`、`POST .../prompt`(SSE,`streamSSE` + `stream.writeSSE`) |
| `packages/shared/src/index.ts` | `McpServerConfig{name,command,args?,enabled?,env?}`、`SessionEvent`(SSE 事件联合)、`HistoryBlock`(thinking/text/tool)、`McpServerStatus`/`McpToolInfo` |
| `apps/web/src/composables/useAgent.ts` | SSE 接收 + `handleEvent` 累积 segments + MCP 面板 API 封装(`refreshMcp/saveMcpServer/deleteMcpServer/testMcpServer`) |
| `apps/web/src/components/MessageBubble.vue` | 工具调用卡片渲染(`pre` 纯文本 output,无图片) |
| `apps/web/src/components/McpPanel.vue` | MCP server 管理表单(名称/命令/args/env/启用/测试/删除) |
| `docs/mcp.md` | MCP 设计文档(v1 = client,stdio 传输;server 端不在 v1 范围) |
| `apps/api/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts` 等 | pi SDK 类型:`createAgentSession` 选项、`ToolDefinition`、`AgentToolResult`(图片类型源头) |
| `apps/api/node_modules/@earendil-works/pi-ai/dist/types.d.ts` | `ImageContent{type:'image',data,mimeType}`、`Model.input: ("text"|"image")[]`、xiaomi provider 类型 |

---

## 3. Q1:MCP 服务器/工具如何配置与注册

### 3.1 配置面(用户配置的外部 MCP server)

- **配置文件**:`.workflows/mcp.json`(dev 在仓库根,prod 在 `~/.workflows`),内容 `{ "mcpServers": [...] }`;与 `config.json` 平级、独立读写(AGENTS.md / docs/mcp.md §5)。
- **配置项**(`packages/shared/src/index.ts` `McpServerConfig`):`name`(唯一,`/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/` ≤40 字符)、`command`、`args?: string[]`、`enabled?: boolean`(opt-in,`!== true` 不注册)、`env?: Record<string,string>`。
- **读写实现**(`apps/api/src/mcpConfig.ts`):`mcpConfigPath(store)`、`loadMcpServers(store)`(缺文件/损坏 → `[]`,不阻塞会话)、`saveMcpServers`(全量校验,任一失败抛中文 Error 零写入)、`upsertMcpServer`(同 name 覆盖)、`removeMcpServer`;原子写 = 先写 `.tmp` 再 `renameSync`。
- **API 路由**(`apps/api/src/agent/routes.ts`):`GET /api/agent/mcp`(配置 + 运行时状态合并)、`PUT /api/agent/mcp/:name`(upsert + `disposeMcpServer` + `refreshMcpForOpenSessions`)、`DELETE /api/agent/mcp/:name`、`POST /api/agent/mcp/:name/test`(`testMcpServer` 一次性连接,15s 外层兜底)。

### 3.2 注册面(工具如何进入 agent 会话)

`apps/api/src/pi/mcpTools.ts` 全链路:

1. `createMcpTools(manager, servers, resolveServer?)`:`Promise.allSettled` 并行连接所有 `enabled===true` 的 server,单 server 失败隔离(warn + 跳过);返回 `ToolDefinition[]`。
2. `buildServerTools` → `toMcpToolDefinition`:每个 MCP 工具包装为 pi 的 `ToolDefinition`,**命名 `mcp__<server>__<tool>`**(清洗规则 `cleanName`,`/^[a-zA-Z0-9_-]+$/` ≤128 字符,非法跳过);参数 schema 用 TypeBox `Type.Unsafe<T>()` 透传 MCP `inputSchema`(JSON Schema,不逐字段翻译,转换失败跳过该工具)。
3. `execute` 内:`resolve(server.name)` 实时解析最新配置(方案 B:删除/禁用立即失效)→ `manager.callTool(...)` → 结果 `renderMcpResult`(text 拼接;image/audio 降级为 `[image, mime, bytes]` 占位)→ `truncateOutput` 50KB → `{ content: [{ type:'text', text }] }`。
4. `McpManager`(PiAgentService 单例字段):连接 + 工具列表按 server 缓存,主/子代理共享;断线重连一次重试;`disposeServer(name)` 配置变更断开;`disposeAll()` 进程退出关闭子进程;`status()` 供前端面板。
5. `StdioMcpConnection`:官方 `Client` + `StdioClientTransport({ command, args, stderr:'pipe', env })`,**spawn 不经 shell,env 仅显式声明值**;超时 connect 10s / list 10s / call 60s(`RequestOptions.timeout`);stderr 环形缓冲 50 行。

### 3.3 传输方式

- **v1 仅 stdio**(docs/mcp.md §1):`McpConnection` 抽象接口(`connect/listTools/callTool/close`)是**预留扩展点**——SDK `@modelcontextprotocol/sdk` 已带 `client/sse.js`、`client/streamableHttp.js`、`client/websocket.js`(dist/esm/client 下),后续接远端 HTTP/SSE MCP server 只需新增一个 `McpConnection` 实现,上层无感。
- **内置工具(anysearch/fff)不走 MCP 机制**:直接是普通 `ToolDefinition` 工厂(`createAnySearchTools`/`createFffFindTool`),与 MCP 工具并列注册(见 §5)。

---

## 4. Q2:pi SDK 如何注册自定义工具 / 是否有内置 MCP API

### 4.1 pi SDK **没有** MCP API(重要事实)

- `@earendil-works/pi-coding-agent@0.83.0` 的 `docs/`(extensions.md、sdk.md 等 30+ 篇)**全文无 MCP 字样**;`dist/**/*.d.ts` 无 mcp/Mcp 导出。
- `@earendil-works/pi-ai@0.83.0` 同理(导出面 = models/auth/api/types/utils,见 `dist/index.d.ts`)。
- **结论:pi SDK 无内置 MCP client/server、无 registerMcp;本仓库的 MCP 能力完全是自建**(依赖官方 `@modelcontextprotocol/sdk@^1.30.0`)。「pi 内置 MCP 客户端可连远端 MCP server」不成立;要连远端 server 需自己按 §3.3 扩展 `McpConnection`。

### 4.2 pi SDK 自定义工具 API(本仓库实际使用的)

注册入口是 `createAgentSession`(非 CLI 扩展机制):

- `apps/api/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts`:
  ```ts
  interface CreateAgentSessionOptions {
    customTools?: ToolDefinition[]   // 自定义工具注册表(与扩展注册工具合并)
    tools?: string[]                 // ★ 白名单:只有列出的工具名会被开放给 LLM
    excludeTools?: string[]
    noTools?: "all" | "builtin"
    resourceLoader?: ResourceLoader
    sessionManager?: SessionManager
    modelRuntime?: ModelRuntime
    ...
  }
  ```
- `ToolDefinition`(`dist/core/extensions/types.d.ts`):
  ```ts
  interface ToolDefinition<TParams extends TSchema, TDetails, TState> {
    name: string; label: string; description: string
    promptSnippet?: string; promptGuidelines?: string[]
    parameters: TParams                                  // TypeBox schema
    constrainedSampling?: false | ConstrainedSamplingConfig
    executionMode?: "sequential" | "parallel"
    prepareArguments?: (args: unknown) => Static<TParams>
    execute(toolCallId: string, params: Static<TParams>,
            signal: AbortSignal | undefined,
            onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
            ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>
    renderCall? / renderResult?                          // TUI 渲染(工作台不用)
  }
  export declare function defineTool(...)  // 类型推断辅助
  ```
- `AgentToolResult<T>`(pi-agent-core `dist/types.d.ts`):
  ```ts
  interface AgentToolResult<T> {
    content: (TextContent | ImageContent)[]   // ★ 可含图片!
    details: T
    usage?: Usage
    addedToolNames?: string[]
    terminate?: boolean
  }
  ```
- 扩展机制(pi CLI 侧 `pi.registerTool()`,docs/extensions.md §Custom Tools):本仓库**不使用**(`createPromptOnlyLoader` 只注入 prompt,不加载扩展)。
- 工具工厂示例(仓库内):`createAnySearchTools(options)`(anySearchTools.ts)、`createFffFindTool/createFffGrepTool`(fffTools.ts)、`createMcpTools(manager, servers, resolveServer)`(mcpTools.ts)——三者都是返回 `ToolDefinition[]` 的工厂,视觉工具照此模式。

### 4.3 pi SDK 的图片相关 API(喂图给模型)

- `AgentSession.prompt(text, options?: PromptOptions)`(`dist/core/agent-session.d.ts`):`PromptOptions.images?: ImageContent[]`;另有 `steer(text, images?)`、`followUp(text, images?)`、`sendUserMessage(content: string | (TextContent|ImageContent)[])`。
- `ImageContent = { type: "image"; data: string; mimeType: string }`(base64,pi-ai `dist/types.d.ts`);openai-completions 序列化为 `data:<mime>;base64,<data>` 的 `image_url`;tool result 图片在 `model.input.includes("image")` 时也会附加发送(探索-1 §5.1 已验证)。
- **仓库当前未用任何 images 参数**(`piService.ts prompt()` 只传 text)。

---

## 5. Q3:现有工具如何注入 agent 会话(按 agent 分类)

### 5.1 主代理(每工作区一个持久化会话)

`apps/api/src/pi/piService.ts` `openSession()`(L~160-260)组装顺序:

```
builtinTools = createCodingTools(workspace.path)（去掉 bash/grep/find）
  → guardToolSet(只读工具包 path 守卫,extraReadRoots = skills 放行根)
searchTools = createFffFindTool / createFffGrepTool(每工作区 fff 索引;失败回退内置 grep/find)
webTools    = createAnySearchTools({ getApiKey: () => loadConfig(store).anySearchApiKey })   // ★ 内置 HTTP 工具
mcpTools    = workspace.readOnly ? [] : await createMcpTools(this.mcp, mcpServers, liveResolver)  // ★ 只读工作区不注册
bash        = toToolDefinition(createBashTool(workspace.path, { spawnHook: createWorkspaceBashHook(...) }))
subAgentTools = 每个子代理一个工具 + wait_for_approval + complete_task
```

关键调用:

```ts
const { session } = await createAgentSession({
  cwd: workspace.path, agentDir: this.store.agentDir, modelRuntime: this.runtime,
  model, thinkingLevel, sessionManager, resourceLoader: mainResourceLoader,
  customTools: [...guardedTools, ...subAgentTools],
  tools: [...activeTools, ...subAgentTools.map((t) => t.name)],   // ★ 白名单
})
```

`activeTools` = `readOnly ? ['read','ls', ...searchNames, ...webToolNames, ...mcpToolNames] : ['read','bash','edit','write', ...searchNames, ...webToolNames, ...mcpToolNames]`。

**重要**:SDK 的 `tools` 白名单会过滤 customTools 注册表——fff/anysearch/mcp 工具必须显式列入,否则不开放给 LLM(piService 注释原文)。**新增工具必须同时改 `customTools` 数组与 `tools` 白名单**。

### 5.2 子代理

`apps/api/src/pi/subAgent.ts`:
- `buildSubAgentTools({ workspace, definition, fff, matcher, getAnySearchApiKey, extraAllowedRoots, mcpTools })`:只读基础(read/ls/fff)+ **anysearch 恒注册** + **mcpTools 由调用方传入后 push**;`activeNames` = `['read','ls', ...fff 名, 'anysearch-search', ...mcpTools.map(t=>t.name)]`;executor 追加 bash/edit/write,白名单写工具按 frontmatter 约束。
- `runSubAgent()` 内:`mcpTools = workspace.readOnly ? [] : await createMcpTools(mcp, mcpServers, liveResolver)`(共享主代理 `McpManager`,零额外连接),然后 `createAgentSession({ customTools: tools, tools: activeNames })`。
- **双点注册纪律**(AGENTS.md 明确):新增工具需主代理 `openSession` + 子代理 `runSubAgent`/`buildSubAgentTools` 同步维护(回归高发点,有 `subAgent.test.ts`/`mcpTools.test.ts` 覆盖)。

### 5.3 工具配置是否按 agent 不同而不同

| 维度 | 主代理 | 子代理 |
| --- | --- | --- |
| 内置工具 | read/bash/edit/write + fff + anysearch | read/ls + fff + anysearch(executor 追加 bash/edit/write) |
| MCP 工具 | 注册(只读工作区除外) | 注册(只读工作区除外;共享连接) |
| 编排工具 | wait_for_approval / complete_task / 子代理名 | 无 |
| 守卫 | bash spawnHook + guardToolSet | 同左(executor 写白名单另套 guardWriteTool) |

**视觉工具归属判断**:anysearch 是"无 path 参数的只读 HTTP 工具",**在只读工作区也注册**(`webTools` 在 readOnly 分支的 guardedTools 中);若视觉工具定义为"调用外部 API、无工作区副作用",可对齐 anysearch 在只读工作区也注册;若按 MCP 纪律(可能产生副作用)则只读不注册——规划时需拍板。

---

## 6. Q4:工具调用结果如何流回前端(SSE 事件链)

### 6.1 后端事件映射

`POST /api/agent/workspaces/:id/prompt`(`routes.ts`)→ `streamSSE(c, async (stream) => { await pi.prompt(workspace, text, (evt) => stream.writeSSE({ data: JSON.stringify(evt) })) })`。

`piService.ts prompt()`:`handle.session.subscribe(event => mapSessionEvent(event).forEach(onEvent))`,映射(`mapSessionEvent`,piService.ts L~570):

| pi SDK 事件 | SSE 事件(shared `SessionEvent`) | 载荷 |
| --- | --- | --- |
| `tool_execution_start` | `tool_start` | `{ callId, toolName }` |
| `tool_execution_update` | `tool_update` | `{ callId, delta }`(`partialResult` 为 string 时) |
| `tool_execution_end` | `tool_end` | `{ callId, toolName, isError, output: stringifyResult(event.result) }` |
| `message_update`(text/thinking) | `text_delta` / `thinking_delta` | |
| `message_start/end` | `message_start` / `message_end`(含 usage) | |
| agent 生命周期 | `agent_start` / `agent_end` / `done` / `error` | |

子代理事件经 `subAgent.ts toSubEvents()` 镜像为 `sub_*`(sub_tool_start/update/end、sub_text/thinking_delta…),挂主代理工具调用 callId;另有 `sub_end`、`gate_required`。

**注意**:`stringifyResult` 是 `JSON.stringify(result, null, 2)`——`event.result` 是 `AgentToolResult`,若 content 含 `ImageContent`,**整个 base64 会被序列化进 `tool_end.output` 字符串**(数 MB 级),无专门 image 事件类型。

### 6.2 前端渲染

- `useAgent.ts handleEvent()`:`tool_start` 在 pending 消息 push `{ kind:'tool' }` segment;`tool_update` 追加 delta;`tool_end` 整体替换 output。
- `MessageBubble.vue`:工具块 = 可折叠卡片(圆点状态色 + `toolLabel` 名 + 「详情/收起」),展开后 `<pre>` 渲染 `tool.output`(**纯文本**,font-mono,`max-h-56` 滚动);无图片、无 Markdown。
- 历史恢复:`applySessionData` 把 `HistoryBlock` 映射为同构 segments(`output` 缺省空)。

### 6.3 历史渲染(后端)

`apps/api/src/pi/history.ts renderHistory()`:只识别 `thinking/text/toolCall` 三种 content 类型;tool 输出 = `extractText(message.content)`(**只取 text 项,图片丢弃**);`HistoryBlock` 类型也只有 thinking/text/tool。

---

## 7. Q5:工具内如何发起外部 HTTP 请求(anysearch 范本)

`apps/api/src/pi/anySearchTools.ts` 是仓库内唯一"工具内调外部 REST API"的实现,视觉工具直接照抄:

```ts
const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/v1/search'
const DEFAULT_TIMEOUT_MS = 30_000

async function callSearch(opts, params, signal): Promise<SearchCallResult> {
  const fetchImpl = opts.fetchImpl ?? fetch              // 测试注入点
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)
  const combined = AbortSignal.any(signals)              // Node>=20.19 原生
  const key = resolveApiKey(opts)                        // env ANYSEARCH_API_KEY > opts.getApiKey() > 匿名
  const headers: Record<string,string> = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  const res = await fetchImpl(endpoint, { method:'POST', headers, body: JSON.stringify(body), signal: combined })
  // 错误分层:HTTP 状态 mapHttpError → JSON 解析 → 业务 code mapBusinessError → data.results 结构校验
  // abort:name==='AbortError' 且用户 signal.aborted → 透传 'Operation aborted';否则「请求超时」
}
```

要点:
- 工厂签名:`createAnySearchTools(options?: { getApiKey?, fetchImpl?, endpoint?, timeoutMs? })` → `ToolDefinition[]`(测试友好)。
- `execute` 内:`abortIfSignaled(signal)` → 校验参数 → `callSearch` → `truncateOutput(renderResults(...))` → `{ content:[{type:'text', text}], details: undefined }`;错误返回 `{ content:[{type:'text', text: 'AnySearch 错误:...'}] }`(**不 throw**,除非 Operation aborted)。
- 50KB 字节安全截断(`truncateOutput`,utf-8 边界二分,中文/代理对不切半)。
- key 只进 Authorization 头,绝不回写文本/日志。

**视觉工具映射**:endpoint → `https://api.xiaomimimo.com/v1/chat/completions`;body 仿 OpenAI 协议:`{ model:'mimo-v2.5', messages:[{ role:'user', content:[{type:'text',...},{type:'image_url', image_url:{url:'data:<mime>;base64,<data>'}}] }] }`(可加 `stream:false`);key 优先 `env XIAOMI_API_KEY`(pi-ai xiaomi provider 的 env 名,探索-1 已确认),回退 config.json(仿 `anySearchApiKey` 新增字段,02-plan-1.md 已规划 `apiKeys` record);超时建议 >30s(视觉推理较慢,可参考 MCP call 60s)。

---

## 8. Q6:MCP 工具返回图片(ImageContent)的格式与现状

### 8.1 MCP 侧格式

MCP spec 的 `CallToolResult.content` 元素:`{ type:'image', data:<base64>, mimeType:<string> }`(还有 text/audio/resource 等)。本仓库 `mcpTools.ts` 已定义 `McpCallResult.content: Array<{ type, text?, [k]:unknown }>`,`renderMcpResult` 对 `image/audio` 项输出占位文本 `[image, <mime>, <bytes> bytes]`(L151-157)——**MCP 图片当前不展示、不进模型上下文**。

### 8.2 pi SDK 侧格式

- 工具返回:`AgentToolResult.content: (TextContent | ImageContent)[]`,`ImageContent = { type:'image', data: base64, mimeType: string }`(pi-ai types.d.ts)。
- 模型侧消费:openai-completions `convertMessages` 会把 toolResult 中的 image 在模型 `input.includes('image')` 时序列化为 `image_url` 附加发送(探索-1 §5.1)——即**如果主模型是视觉模型,工具返回 ImageContent 可直接把图喂回模型**;deepseek-v4-flash 非视觉,会被丢弃或降级。
- 用户侧喂图:`session.prompt(text, { images: ImageContent[] })`(与工具返回同构)。

### 8.3 前端接收展示现状(缺口清单)

| 链路 | 现状 | 缺口 |
| --- | --- | --- |
| SSE 事件 | `tool_end.output: string`,`stringifyResult` JSON 序列化整个 result(含 base64) | 无 image 事件类型;base64 膨胀 payload |
| 历史 | `extractText` 只取 text | `HistoryBlock` 无 image 类型,图片丢失 |
| 前端渲染 | `MessageBubble.vue` `<pre>` 纯文本 | 无 `<img>` / data URL 渲染 |
| 子代理镜像 | 同主链路(sub_* 事件同构) | 同上 |

→ 若视觉工具「返回图片给前端/模型」,需扩展 shared 类型 + mapSessionEvent/toSubEvents + history + 前端(02-plan-1.md Phase 3 已规划 image block,可复用其设计);若只「返回文本描述」,**当前管道零改动**。

---

## 9. 关键发现与风险点

1. **两条注册通道并存,语义不同**:内置 HTTP 工具(anysearch 模式)= 代码内置、无进程、无配置面,只读工作区也注册;MCP 外部工具(mcpTools 模式)= 用户 mcp.json 配置、stdio 子进程、只读工作区不注册、"保存即生效"有整套刷新机制。**「内置 MCP 视觉理解工具」建议走 anysearch 模式**(若走 MCP 通道,仓库明确不做 server 端,需自建 stdio server 进程,违背"内置"且成本高)。
2. **双点注册 + 白名单是硬约束**:主代理 `openSession`(customTools + tools 白名单)与子代理 `runSubAgent`/`buildSubAgentTools`(tools + activeNames)必须同步;漏白名单 = 工具注册但模型不可见;漏子代理 = 子代理无视觉能力。回归保护:`mcpTools.test.ts`/`subAgent.test.ts`/`anySearchTools.test.ts`。
3. **SDK 工具签名注意**:`ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)` 5 参;仓库现有实现大多用 4 参(`_toolCallId, params, signal, _onUpdate`),`ctx` 可忽略。
4. **图片链路不通**:返回 ImageContent 需要扩展 SSE/历史/前端(§8.3),且 50KB 截断(anysearch/mcp 对齐)对图片语义不适用;`tool_end.output` string 字段放 base64 会爆 payload(建议:图片走独立事件/data URL,文本描述走 output)。
5. **key 管理**:复用 `XIAOMI_API_KEY` env 优先 + config.json 回退模式;注意 pi-ai 的 `setRuntimeApiKey('xiaomi', key)` 会触发 pi.dev 目录网络刷新(离线需 catch,探索-1 风险 6);config.json 明文存储是既有设计。
6. **超时与 abort**:视觉推理慢,`AbortSignal.any([AbortSignal.timeout(N), signal])` 组合;N 建议 60s 级(MCP call 超时即 60s);abort 唯一透传 `Operation aborted` 的纪律要保持。
7. **mimo-v2.5 无 thinkingLevelMap**(探索-1 §4.2/风险 3):仅影响把 xiaomi 当聊天 provider 的场景;纯工具调用(chat/completions 直连)不受影响。
8. **与 02-plan-1.md 的关系**:既有计划走「provider 泛化(deepseek+xiaomi 双 provider)+ 用户传图」路线;本探索的「内置视觉工具」是另一条互补路线(agent 自主调工具识图,不需要用户传图,可配合 read 工具读工作区内图片)。两者共用小米 key、共用 image block 扩展设计,规划时可统一考虑。
9. **测试范式**:`anySearchTools.test.ts` 用 `fetchImpl` 注入 mock;视觉工具照抄可离线单测;另有 `verify-anysearch` 类脚本范式(02-plan-1.md 已规划 `verify-xiaomi.mjs` + mock server)。

---

## 10. 结论:可行性判断与建议

**可行性:高。** 机制成熟、范式清晰:

- 推荐方案 = **内置工具通道(anysearch 模式)**:新增 `apps/api/src/pi/visionTools.ts`(或 `xiaomiVisionTools.ts`),`createVisionTools(options)` 工厂,工具名如 `vision-understand`(避开 `mcp__` 前缀与内置名),TypeBox 参数 schema(`image_path` 或 `image_data` + `prompt`),execute 内 fetch `https://api.xiaomimimo.com/v1/chat/completions`(mimo-v2.5),返回文本描述。
- **双点注册**:piService.openSession(guardedTools + activeTools 白名单)与 subAgent.buildSubAgentTools/runSubAgent(activeNames)同步;只读工作区是否注册按"无副作用只读 HTTP 工具"对齐 anysearch(建议注册)。
- **key**:`XIAOMI_API_KEY` env 优先 + config.json 新增字段(经 `getApiKey` 回调注入,动态读取)。
- **图片输入**:工具参数收 `image_path`(工作区内路径,经 guardPathTool 校验或工具内 read 文件转 base64)最贴合现有守卫语义;若做用户传图,需扩展 SSE/历史/前端(§8.3,与 02-plan-1.md Phase 3 合并实施)。
- **测试**:仿 anySearchTools.test.ts(fetchImpl mock)+ 状态面板/设置 UI 按需(内置工具无需 mcp.json 配置面)。

**备选/补充**:若最终产品形态是"用户把图发给 agent 聊天",02-plan-1.md 的 provider 泛化路线更合适;两条路线共享 key 存储与图片链路扩展,建议二选一或分层(工具 = agent 自主看图;provider = 用户交互看图)。
