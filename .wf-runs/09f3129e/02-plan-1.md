# 实施计划:MCP 功能(v1 = MCP client,stdio 传输)

> runId:`09f3129e` | 依据:`01-exploration-1.md`(仓库探索报告)| 类型:实施规划(只读调研,未改代码)
> 目标仓库:workflows(Turborepo + pnpm + Hono + Vue 3 + pi SDK `@earendil-works/pi-coding-agent@0.83.0`)

---

## 1. 目标与范围

### 1.1 做什么(v1)

为工作台新增 **MCP client** 能力:用户通过配置页添加外部 MCP server(stdio 启动命令 + 参数),
应用在会话创建时连接该 server、拉取 `tools/list`,把每个工具包装成 pi SDK 的 `ToolDefinition`
(仿 `createAnySearchTools` 工厂模式,`apps/api/src/pi/anySearchTools.ts:189-191`)注册进**主代理**
与**子代理**会话,agent 即可调用外部工具。具体交付:

1. 新工具工厂 `apps/api/src/pi/mcpTools.ts`:`McpManager`(连接生命周期:启动/工具列表/调用/关闭,连接与工具列表按 server 缓存)+ `createMcpTools()`(ToolDefinition 转换)+ `testMcpServer()`(测试连接)。
2. 配置扩展:`StoredConfig.mcpServers`(`{name, command, args, enabled}[]`,存 `.workflows/config.json`)+ 校验 + 存取 helper。
3. API 路由:`/api/agent/config/mcp*`(CRUD + 测试连接/列出工具 + 运行时状态)。
4. 主代理 `PiAgentService.openSession()` 与子代理 `buildSubAgentTools()` **双点同步注册**(探索报告 §7-2 明确此为回归高发点)。
5. 前端:MCP 管理面板(列表/添加/启用禁用/连接测试/工具列表展示),仿 `ApiKeyModal.vue` 的「ANYSEARCH」section 扩展。
6. 文档:README 功能/API/安全说明 + `docs/mcp.md` 设计文档(含决策记录,对齐仓库文档文化)+ AGENTS.md 结构更新。

### 1.2 不做什么(v1,明确排除)

| 排除项 | 理由 |
| --- | --- |
| **MCP server 端**(把本工作台暴露为 MCP server) | 需桥接 AgentSession/tool 事件为 JSON-RPC + 鉴权,成本高,仓库无此规划(探索报告 §8) |
| HTTP/SSE/Streamable HTTP 传输 | v1 仅 stdio;`McpConnection` 抽象层预留扩展点(§3.3.1),后续加 `StreamableHTTPClientTransport` 只需新增一个实现 |
| OAuth / 远程鉴权 | 依赖 HTTP 传输,非 v1 |
| MCP prompts / resources 能力 | pi SDK v0.83.0 的 ResourceLoader 只支持 skills/prompts 注入,无 MCP 桥接点(探索报告 §3.2-3) |
| 每工具级 enable/disable、server 级 `env`、`cwd`、`timeoutMs` 配置字段 | 保持配置面最小(`name/command/args/enabled` 四字段,按需求约束);`env`/`cwd` 由 `StdioClientTransport` 继承进程默认值 |
| MCP 工具输出沙箱/审计执行、server 进程资源限制(cpu/内存/超时强杀) | 超出 v1;以文档风险声明 + 信任模型约束(§4) |
| 只读工作区暴露 MCP 工具 | 只读工作区语义 = 只读;MCP 工具可能产生外部副作用,一律不注册(§3.4.2),预留每-server `readOnly` 标志作为扩展点 |

### 1.3 关键设计决策(摘要)

| 决策点 | 结论 |
| --- | --- |
| 工具命名 | 统一前缀 `mcp__<server>__<tool>`(如 `mcp__github__create_issue`)。`mcp__` 前缀保证与内置工具(`read/bash/edit/write/grep/find/ls`)、仓库工具(`fff-find/fff-grep/anysearch-search`)、编排工具(`wait_for_approval/complete_task`、子代理名)零冲突;server 名由配置校验保证唯一 → 跨 server 无冲突 |
| 工具名校验 | 最终名必须匹配 `/^[a-zA-Z0-9_-]+$/` 且长度 ≤ 128(MCP spec 建议字符集);非法字符替换为 `_`,替换后仍非法/超长 → **跳过该工具**(console.warn);同一 server 内重名工具 → 保留首个 |
| 参数 schema 转换 | MCP `inputSchema`(JSON Schema)用 TypeBox `Type.Unsafe<T>()` 透传包装(不逐字段翻译);非 object 根 schema / 转换异常 → 跳过该工具并 warn(§3.3.3) |
| 连接生命周期 | `McpManager` 为 `PiAgentService` 单例字段;连接 + tools 列表按 server 缓存,**主/子代理共享同一连接**(子代理每次新建会话但工具 execute 闭包只引用 manager,无会话状态);调用时连接已断 → 自动重连一次并重试该次调用 |
| 生效时机 | 与 skills 语义一致(README「新增/修改 skill 后需重开会话」):**MCP 配置变更后需新建会话/重开工作区生效**;配置变更时 `disposeServer()` 断开旧连接,避免僵尸进程 |
| 安全模型 | MCP server = 用户显式配置的可信插件(与 OS 用户同权限);server 命令**只从配置文件读取**,agent 无任何工具可写 `.workflows/config.json`(bash/write/edit 被 workspaceGuard 限制在工作区内);UI + README 显著风险提示;工具输出视为不可信内容(与 anysearch 同级) |
| 错误与截断 | 沿用 `anySearchTools.ts` 纪律:连接 10s / 列表 10s / 调用 60s 超时、`AbortSignal.any` 组合、50KB 输出截断、错误文案中文脱敏、abort 唯一透传 `Operation aborted` |

---

## 2. 依赖

```bash
pnpm --filter @workflows/api add @modelcontextprotocol/sdk@^1.30.0
```

版本注意点:

- **锁 v1 线(`^1.30.0`)**:官方 SDK 已发布 v2 线(`@modelcontextprotocol/client` / `@modelcontextprotocol/server` 分拆包,对应 2026-07-28 spec),v1(`@modelcontextprotocol/sdk`)仍是稳定线且持续维护。v1 API(`Client` / `StdioClientTransport` / `callTool`)生态最广、文档最多,本计划所有代码骨架基于 v1 API。**不要**安装 v2 分拆包。
- 当前仓库 `pnpm-lock.yaml` 中该包仅作为 openai/genai 的 optional peer 出现(未安装,探索报告 §2-3),本次 `add` 是首次真实安装;安装后 `pnpm-lock.yaml` 与 `apps/api/package.json` 均变更,需提交。
- SDK v1 为 ESM 包,与 `apps/api/package.json` 的 `"type": "module"` 兼容;Node >= 18(仓库要求 20.19,满足)。
- 安装后验证:`node -e "import('@modelcontextprotocol/sdk/client/index.js').then(m => console.log(typeof m.Client))"` 输出 `function`。

---

## 3. 文件级改动清单(分步实施)

> 每步含:改动文件、具体内容、预期结果、验收标准。步骤间有依赖,按序执行。
> 所有新增文件遵循仓库约定:中文注释头(设计说明)、TypeBox schema、`AgentToolResult<undefined>`、50KB 截断、错误文案中文。

### Step 1:共享类型(`packages/shared`)

**文件**:`packages/shared/src/index.ts`(追加,不破坏既有导出)

在 `AgentConfig` 附近新增:

```ts
/** MCP server 配置(存 .workflows/config.json;agent 无途径修改,仅用户经 API/UI 配置) */
export interface McpServerConfig {
  /** 唯一名,匹配 /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,≤ 40 字符 */
  name: string
  /** 启动可执行文件(如 npx / node / python),由配置直供,不经 shell */
  command: string
  /** 启动参数(如 ["-y", "@modelcontextprotocol/server-filesystem", "/path"]) */
  args?: string[]
  /** 是否启用(新增默认 false,opt-in) */
  enabled?: boolean
}

/** MCP server 单个工具的展示信息(测试连接/状态面板用) */
export interface McpToolInfo {
  name: string
  description?: string
}

/** MCP server 运行时状态(前端面板展示) */
export interface McpServerStatus {
  name: string
  state: 'disabled' | 'connected' | 'error'
  /** state=error 时的错误文案 */
  error?: string
  /** 已缓存工具数 */
  toolCount: number
  lastCheckedAt: number | null
}
```

**验收**:`pnpm --filter @workflows/shared build` 通过;`packages/shared/dist` 产出新类型(api/web 后续步骤消费)。

---

### Step 2:配置存储(`apps/api/src/config.ts`)

**文件**:`apps/api/src/config.ts`

1. `StoredConfig`(现 L31-40)追加字段:
   ```ts
   /** MCP server 列表(外部工具;命令只从配置读取,agent 不可注入) */
   mcpServers?: McpServerConfig[]
   ```
   顶部 `import type { McpServerConfig } from '@workflows/shared'`。
2. 新增 helper(放在 config.json 区段,`saveConfig` 之后):
   ```ts
   const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
   const MCP_SERVER_NAME_MAX = 40

   export function loadMcpServers(store: WorkflowsStore): McpServerConfig[]
   /** 全量校验后落盘:name 必填且匹配正则且 ≤40;重名报错;command 非空;args 为字符串数组;enabled 布尔。
    *  校验失败抛 Error(中文文案),不做部分写入。 */
   export function saveMcpServers(store: WorkflowsStore, servers: McpServerConfig[]): McpServerConfig[]
   /** 按 name 增删改(upsert 语义);不存在时抛错/返回 null 由调用方决定(建议返回 boolean) */
   export function upsertMcpServer(store: WorkflowsStore, server: McpServerConfig): McpServerConfig[]
   export function removeMcpServer(store: WorkflowsStore, name: string): boolean
   ```
   实现要点:`saveMcpServers` 内部先校验后 `writeJson`(复用 `writeJson`,绕过 `saveConfig` 的 `''/null` 删除语义以免误删);`upsert/remove` 内部调 `loadMcpServers` + `saveMcpServers`。

**文件**:`apps/api/src/config.test.ts`(追加 describe)

- 空配置读取 → `[]`;存取往返;`enabled` 缺省处理。
- 校验用例:非法 name(空、含空格/点/中文、超 40 字符)、空 command、args 含非字符串、重名 → 抛错且 **config.json 未被写入**(校验失败零写入)。

**验收**:`pnpm --filter @workflows/api test config.test.ts` 全绿;既有用例不回归。

---

### Step 3:工具工厂与连接管理器(新文件 `apps/api/src/pi/mcpTools.ts` + 单测)

**文件**:`apps/api/src/pi/mcpTools.ts`(新建,仿 `anySearchTools.ts` 结构)

#### 3.3.1 连接抽象(HTTP/SSE 扩展点)

```ts
export interface McpCallResult { content: Array<{ type: string; text?: string; [k: string]: unknown }>; isError?: boolean }

/** MCP 连接抽象:v1 仅 stdio 实现;后续 HTTP/SSE 传输新增实现即可,上层无感 */
export interface McpConnection {
  connect(): Promise<void>
  listTools(): Promise<McpToolInfo[]>
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>
  close(): Promise<void>
}

/** stdio 实现:包装官方 SDK Client + StdioClientTransport */
export class StdioMcpConnection implements McpConnection {
  constructor(config: McpServerConfig, opts?: { connectTimeoutMs?: number; listTimeoutMs?: number; callTimeoutMs?: number })
  // connect():new StdioClientTransport({ command, args, stderr: 'pipe' }),new Client({ name:'workflows-mcp-client', version:'0.1.0' }),
  //   await client.connect(transport);connect 整体用 Promise.race 包 10s 超时,超时 close() 并抛「连接超时」
  //   stderr 用 'pipe' 并挂 drain 监听(环形缓冲最近 50 行,供状态面板诊断;不 drain 会背压阻塞子进程)
  // listTools():client.listTools({}, undefined, { timeout: listTimeoutMs });返回 { name, description }[]
  // callTool():client.callTool({ name, arguments: args }, undefined, { timeout: callTimeoutMs, signal });返回 content/isError
  // close():await client.close()(transport 由 client.close 一并结束,子进程退出)
}
```

#### 3.3.2 管理器(跨主/子代理共享连接)

```ts
export interface McpConnectionFactory { create(config: McpServerConfig): McpConnection }

export class McpManager {
  constructor(factory?: McpConnectionFactory) // 缺省 StdioMcpConnection;测试注入 fake
  /** 确保连接并返回缓存工具列表(幂等;连接已断则重连);失败记录 error 状态并抛错 */
  async listTools(name: string, config: McpServerConfig): Promise<McpToolInfo[]>
  /** 调用工具:ensure 连接 → callTool;连接断开错误时 close + 重连一次 + 重试该次调用 */
  async callTool(name: string, config: McpServerConfig, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>
  getConnection(name: string): McpConnection | undefined
  /** 配置变更时调用:断开连接 + 清缓存(旧会话工具集不变,新会话生效) */
  async disposeServer(name: string): Promise<void>
  async disposeAll(): Promise<void>
  status(): McpServerStatus[]
}
```

状态机:每个 server 一个 entry `{ conn, tools: McpToolInfo[] | null, state: 'disabled'|'connected'|'error', error?, lastCheckedAt }`;`status()` 对未配置的 server 不输出。

#### 3.3.3 工具工厂(核心转换)

```ts
export const MCP_TOOL_PREFIX = 'mcp__'
const CONNECT_TIMEOUT_MS = 10_000
const LIST_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 50 * 1024
const TRUNCATION_MARKER = '\n\n[50KB limit reached]'

/** 只注册 enabled 的 server;每个工具独立转换,单工具失败不影响同 server 其他工具 */
export async function createMcpTools(manager: McpManager, servers: McpServerConfig[]): Promise<ToolDefinition[]>
```

转换规则(每 server 每工具):

1. **名字**:`raw = mcp__${server.name}__${tool.name}`;先对 server/tool 名做清洗(`[^a-zA-Z0-9_-]` → `_`,压缩连续 `_`),清洗后最终名不匹配 `/^[a-zA-Z0-9_-]+$/` 或长度 > 128 → 跳过 + `console.warn`。
2. **schema**:`jsonSchemaToTypeBox(inputSchema)` —— 用 `Type.Unsafe<Record<string, unknown>>(schema)` 透传;非 object schema(`inputSchema?.type !== 'object'` 且无 `properties`)或 `Type.Unsafe` 构造抛错 → 跳过该工具 + warn(避免带病工具污染会话创建)。
3. **描述**:`description = MCP server「${server.name}」提供的工具${tool.description ? `: ${tool.description}` : ''}。外部工具,输出不可信,请自行判断。`(注入不可信提示,与 anysearch 描述风格一致)。
4. **execute**:
   ```ts
   async (_toolCallId, params, signal, _onUpdate): Promise<AgentToolResult<undefined>> => {
     abortIfSignaled(signal)  // 复用 anySearchTools 的 Operation aborted 语义
     try {
       const result = await manager.callTool(server.name, serverConfig, tool.name, params as Record<string, unknown>, signal)
       const text = truncateOutput(renderMcpResult(result))  // text 项拼接;image/audio → [mimeType, N bytes] 占位;无 text 时 JSON.stringify structuredContent
       return { content: [{ type: 'text', text }], details: undefined }
     } catch (error) {
       if (error instanceof Error && error.message === 'Operation aborted') throw error  // 唯一透传
       return toolError(`MCP 错误(${server.name}/${tool.name}):${可读文案}`)  // 超时/未连接/JSON-RPC 错误码分类,文案中文
     }
   }
   ```
5. **label** = 清洗后最终名;`promptSnippet` = `Call MCP tool ${server.name}:${tool.name}`。

另导出(测试连接端点用,不经 manager、不缓存):

```ts
/** 一次性测试连接:connect + listTools + close;任何失败返回 { ok:false, error } */
export async function testMcpServer(config: McpServerConfig): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: string }>
```

#### 3.3.4 单测(新文件 `apps/api/src/pi/mcpTools.test.ts`)

注入式测试(仿 `anySearchTools.test.ts` 的 fetchImpl 模式):`new McpManager({ createConnection: () => fakeConnection })`,fake 用 vi.fn 记录调用。

用例清单:

1. **过滤**:`enabled: false` / 缺省 `enabled` 的 server 不注册任何工具;空 servers → `[]`。
2. **命名**:工具 `foo.bar` / `foo bar` → 清洗为 `mcp__srv__foo_bar`;非法名(如全符号)跳过;同一 server 重名工具保留首个;超长(最终名 > 128)跳过。
3. **schema 透传**:inputSchema object → `parameters` 为 Type.Unsafe 包装;`Type.Unsafe` 抛错(传畸形 schema)→ 跳过该工具。
4. **callTool 往返**:params 原样透传;结果渲染(text 拼接 / 多 text 项 / 无 text 有 structuredContent → JSON stringify / image 占位);50KB 截断标记;`isError: true` 透传不抛错(工具结果语义,与 anysearch 一致)。
5. **错误映射**:JSON-RPC 错误码(-32602 unknown tool 等)→ 中文可读文案;调用超时 → 「调用超时(60000ms)」;连接失败 → 「连接失败…」;abort(signal.aborted)→ 唯一透传 `Operation aborted`(execute 层 rethrow)。
6. **缓存与重连**:连续两次 `createMcpTools` 只 connect 一次;fake 的 callTool 首次抛「连接已关闭」→ 自动 close+重连+重试一次,第二次成功;两次都失败 → 错误返回。
7. **状态**:`status()` 反映 connected/error、toolCount、lastCheckedAt;`disposeServer` 后 status 清除、fake.close 被调用。
8. **部分失败隔离**:server A 连接失败抛错,server B 正常 → B 的工具正常注册,A 在 status 中 error(createMcpTools 对单 server 失败 try/catch 记录后继续)。

**集成测试**(同一文件,单独 describe,验证真实 stdio 链路):用 `node -e '<内联脚本>'` 起一个最小 MCP server(基于 `@modelcontextprotocol/sdk/server` + `StdioServerTransport`,暴露一个 `echo` 工具),经真实 `StdioMcpConnection` connect → listTools → callTool → close,断言往返正确。用 `mkdtempSync` 隔离、`afterEach` 清理子进程。

**验收**:`pnpm --filter @workflows/api test mcpTools.test.ts` 全绿;覆盖率达到仓库工具模块同级(参考 anySearchTools.test.ts 的断言密度)。

---

### Step 4:主代理注册(`apps/api/src/pi/piService.ts`)

**文件**:`apps/api/src/pi/piService.ts`

1. import:`createMcpTools, McpManager` from `./mcpTools.js`。
2. 类字段(`fff` 附近):
   ```ts
   /** MCP server 连接管理器(跨主/子代理共享连接;配置变更时 disposeServer) */
   private readonly mcp = new McpManager()
   ```
3. `openSession()` 工具组装区(`webTools` 之后、`guardedTools` 之前,现 L210-230):
   ```ts
   // MCP 外部工具:只读工作区不注册(MCP 工具可能产生工作区外副作用);
   // 配置变更需新建会话/重开工作区生效(与 skills 语义一致,README 已有说明)
   const mcpServers = loadConfig(this.store).mcpServers ?? []
   const mcpTools = workspace.readOnly ? [] : await createMcpTools(this.mcp, mcpServers)
   const mcpToolNames = mcpTools.map((tool) => tool.name)
   ```
4. `guardedTools` 数组加入 `...mcpTools`(只读分支不加,因 mcpTools 已为空);`activeTools` 两个分支(只读/读写)均追加 `...mcpToolNames`(注意注释区 L221-224「tools 白名单必须显式列入」)。
5. 新增 `dispose()` 方法(与 `cleanupWorkspaceSessions` 同级):
   ```ts
   /** 服务退出时释放 MCP 子进程与 fff 原生索引 */
   async dispose(): Promise<void> { await this.mcp.disposeAll(); this.fff.disposeAll() }
   ```
6. `createSubAgentTool` 的 `runSubAgent({...})` 调用处(现 L330-345)传入 `mcp: this.mcp`(Step 5 新增字段)。

**文件**:`apps/api/src/index.ts`(进程退出清理,防 MCP 子进程泄漏)

```ts
// 优雅退出:关闭 MCP server 子进程与 fff 索引
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => { void pi?.dispose().finally(() => process.exit(0)) })
}
```
(`initAgentRoutes` 需把 `pi` 暴露出来:`app.ts` 的 `initAgentRoutes()` 返回 `PiAgentService`。)

**验收**:typecheck 通过;只读工作区与读写工作区各开一次会话,日志确认 MCP 工具注册/不注册行为正确(配合 Step 9 手工验证)。

---

### Step 5:子代理注册(`apps/api/src/pi/subAgent.ts`)

**文件**:`apps/api/src/pi/subAgent.ts`

1. `RunSubAgentOptions` 追加字段:
   ```ts
   /** MCP 连接管理器(与主代理共享连接与工具缓存) */
   mcp: McpManager
   ```
2. `runSubAgent()` 内、`buildSubAgentTools` 调用前(现 L340-352):
   ```ts
   const mcpServers = loadConfig(store).mcpServers ?? []
   const mcpTools = workspace.readOnly ? [] : await createMcpTools(options.mcp, mcpServers)
   ```
   并传入 `buildSubAgentTools({ ..., mcpTools })`。
   > 设计说明:子代理每次调用新建 AgentSession,但工具 execute 闭包只引用共享 `McpManager`(无会话状态),连接与工具列表缓存复用主代理已建立的连接,子代理零额外连接成本;readOnly 工作区子代理同样不注册。
3. `buildSubAgentTools` options 追加:
   ```ts
   /** MCP 外部工具(调用方已构建;缺省 [] 保持现有行为) */
   mcpTools?: ToolDefinition[]
   ```
   函数体:`tools.push(...(options.mcpTools ?? []))`,`activeNames` 追加对应名称(**必须**与 customTools 同步,现有注释 L143-146 的教训)。
   > 保持 `buildSubAgentTools` 同步签名:现有单测(subAgent.test.ts L59-150)不改仍通过(缺省 `[]`)。

**文件**:`apps/api/src/pi/subAgent.test.ts`(追加 describe)

- 传入 `mcpTools: [fakeMcpTool]` 时,`tools` 与 `activeNames` 均含该工具名(四个角色 each 断言);缺省时不包含。

**验收**:子代理测试全绿;typecheck 通过。

---

### Step 6:API 路由(`apps/api/src/agent/routes.ts`)

**文件**:`apps/api/src/agent/routes.ts`(配置区段后新增「MCP server 管理」区段)

| 方法/路径 | 行为 |
| --- | --- |
| `GET /api/agent/config/mcp` | `{ servers: McpServerConfig[], status: McpServerStatus[] }`(配置 + 运行时状态;`pi.mcp.status()` 与 `loadMcpServers(store)` 按 name 合并) |
| `PUT /api/agent/config/mcp/:name` | upsert:body `{ name, command, args?, enabled? }`;经 `upsertMcpServer` 校验(400 中文文案);保存后 `await pi.mcp.disposeServer(name)`(断旧连接,新会话生效);返回更新后 `{ servers, status }` |
| `DELETE /api/agent/config/mcp/:name` | `removeMcpServer`(404 若不存在)+ `disposeServer`;返回更新后列表 |
| `POST /api/agent/config/mcp/:name/test` | 用配置里的该 server 调 `testMcpServer()`(一次性连接,不污染 manager 缓存、不注册进会话);返回 `{ ok, tools?, error? }`;测试整体有 15s 上限(testMcpServer 内部已含 10s connect + 10s list) |

实现细节:

- body 解析复用 `readJson`;name 以 URL 参数为准与 body 校验一致(不一致以 URL 为准)。
- 统一响应结构 `{ code, message, data }`;错误走 `HTTPException`(app.onError 统一格式化)。
- `pi` 侧新增薄方法:在 `PiAgentService` 加 `getMcpStatus()`(透传 `this.mcp.status()`)或 routes 直接访问 `pi.mcp`(字段为 readonly public,仓库已有 `pi.fff` 类似私有字段;建议 `mcp` 字段保持 `private`,加公开方法 `getMcpStatus(): McpServerStatus[]`)。

**文件**:`apps/api/src/agent/mcpRoutes.test.ts`(新建;仿 piService.test.ts 的私有构造 hack 模式)

- 用 `mkdtempSync` 构造 fake store + `new PiAgentService(store, {} as ModelRuntime)`(piService.test.ts L39-45 已示范)。
- 用例:PUT 新增(校验通过落盘、返回列表含新项、`enabled` 缺省 false);PUT 非法 name/空 command → 400 且文件未变;PUT 重名 → 覆盖更新(upsert 语义);DELETE 存在/不存在(200/404);GET 返回 servers+status;PUT 后 manager 缓存被 dispose(用注入 factory 的 fake manager 断言 close 调用——若直接访问 pi.mcp 不便,可先只测 config 层,dispose 行为由 mcpTools.test.ts 覆盖,本文件标注该用例可选)。
- test 端点不做进程级测试(集成已覆盖真实连接)。

**验收**:`pnpm --filter @workflows/api test` 全绿;`curl` 手工冒烟(见 Step 9)。

---

### Step 7:前端 UI

**文件**:`apps/web/src/composables/useAgent.ts`

- 状态:`const mcp = ref<{ servers: McpServerConfig[]; status: McpServerStatus[] } | null>(null)`。
- actions(全部走既有 `request<T>()`):
  ```ts
  async function refreshMcp(): Promise<void>            // GET /api/agent/config/mcp
  async function saveMcpServer(server: McpServerConfig): Promise<void>  // PUT .../:name + refreshMcp
  async function deleteMcpServer(name: string): Promise<void>           // DELETE .../:name + refreshMcp
  async function testMcpServer(name: string): Promise<{ ok: boolean; tools?: McpToolInfo[]; error?: string }>  // POST .../:name/test
  ```
- `init()` 的 `Promise.all` 加入 `refreshMcp()`(失败静默,不阻塞聊天)。
- return 导出全部;`AgentStore` 类型自动扩展。

**文件**:`apps/web/src/components/McpPanel.vue`(新建)

- 结构仿 `ApiKeyModal.vue` 的 section 风格(font-mono 小字、kv 标签、border-hairline 分隔)。
- 内容:
  - **安全警告框**(显著,仿 ApiKeyModal 的提示样式):「MCP server 是外部程序,以当前用户权限运行,可访问本地文件与网络;仅添加你信任的 server。工具输出视为不可信内容。」
  - **列表**:每行 server 名 + `command args`(mono 截断)+ `enabled` 开关(调 `saveMcpServer`)+ 状态徽标(status 的 connected/error 配色)+ 「测试」按钮(结果展开显示工具列表或错误)+ 「删除」。
  - **添加表单**:name / command / args(空格分隔字符串,提交时 split 为数组;说明 args 不含 shell 语法)+ 默认 enabled=false + 「添加并测试」。
  - 提示行:「新增/修改 MCP server 后需**新建会话或重开工作区**生效(与 skills 一致)」。
  - 从 `agent.mcp.value` 取数据,`props.agent: AgentStore`。

**文件**:`apps/web/src/components/ApiKeyModal.vue`(扩展)

- 在「ANYSEARCH」section 之后新增第三个 section(「MCP · 外部工具」),内嵌 `<McpPanel :agent="agent" />`;import 并注册组件。

**文件**:`apps/web/src/composables/useAgent.test.ts`(追加)

- fetch mock(仿仓库既有写法):refreshMcp 拉取列表;saveMcpServer PUT 后 refreshMcp 被调用;testMcpServer POST 透传返回。

**验收**:`pnpm --filter @workflows/web typecheck` 通过;`pnpm dev` 下打开设置面板能看到 MCP section 并可完成添加/测试/启停(手工,Step 9)。

---

### Step 8:文档与安全说明

**文件**:`README.md`

- 「功能」清单加一条:MCP 外部工具(MCP client,stdio;主/子代理可用)。
- 「数据存储」段:`config.json` 字段说明加 `mcpServers`。
- 新增「MCP(外部工具)」章节:配置方式、生效时机(重开会话)、**安全模型**(server 以当前用户权限运行;命令仅来自配置文件,agent 无法注入;输出不可信;只读工作区不注册;建议仅添加信任的 server)。
- 「API 一览」表加 4 行(§3 Step 6 的路由)。

**文件**:`docs/mcp.md`(新建,设计文档,对齐 `docs/dag-workflow.md` 结构)

- 背景与目标 / 架构图(文字版:config → routes → McpManager → StdioMcpConnection → MCP server;注册到主/子代理双点)/ 工具命名与冲突策略 / 生命周期与缓存 / 安全模型 / 决策记录(为什么 v1 不做 server、不做 HTTP 传输、为什么 readOnly 不注册、为什么 v1 SDK 而非 v2)。

**文件**:`AGENTS.md`

- 目录结构段补 `src/pi/mcpTools.ts`(MCP client 工厂:连接生命周期 + ToolDefinition 转换);约定段补「新增工具需主/子代理双点注册,含 MCP 工具」提示。

**验收**:文档与实现一致(关键对照:路由表、生效时机、安全约束)。

---

### Step 9:全量验证

```bash
pnpm --filter @workflows/shared build   # 或直接 pnpm build(turbo 依赖顺序自动处理)
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

手工冒烟(dev):

1. `pnpm dev`;在 `.workflows/config.json` 手工写入一个 server 配置(或经 UI 添加),如:
   ```json
   { "mcpServers": [{ "name": "echo", "command": "node", "args": ["-e", "<最小 stdio MCP server 脚本>"], "enabled": true }] }
   ```
2. 打开工作区(新建会话)→ 聊天询问「你能看到哪些工具」,确认 `mcp__echo__*` 在列;调用一次,确认 tool_start/tool_end 事件正常渲染(无需新事件类型)。
3. 设置面板:添加/禁用/测试/删除 server,观察状态徽标与工具列表;禁用后重开工作区,确认工具消失。
4. 子代理:让 explorer 子代理调用 MCP 工具,确认 sub_tool_* 事件正常(共享连接、无重复连接日志)。
5. 只读工作区:确认无 MCP 工具注册。
6. 把 server 命令改成不存在的可执行文件 → 会话仍能打开,status 显示 error,聊天可正常进行(单 server 故障不阻塞)。
7. Ctrl+C 退出 api,确认 MCP 子进程随 `dispose()` 退出(`ps` 无残留)。

---

## 4. 安全约束与防护(逐条落实)

1. **MCP 工具调用不绕过 workspaceGuard**:workspaceGuard(`apps/api/src/pi/workspaceGuard.ts`)守卫的是文件类工具的工作区边界(read/write/edit/bash 等);MCP 工具是外部能力(与 anysearch 同级),不存在工作区 path 参数。防护组合:
   - **只读工作区不注册 MCP 工具**(Step 4/5),避免「只读工作区 + 可写 MCP server」的语义穿透;
   - MCP server 命令**只从 `.workflows/config.json` 读取**:agent 无任何工具可写该文件(bash 被 workspaceGuard 静态审计限制在工作区;write/edit 同样限工作区;`.workflows` 在仓库根/用户目录,均在工作区外)→ 命令注入面关闭;
   - 启动不经过 shell:`StdioClientTransport({ command, args })` 直接 spawn,args 作为 argv 传递(无 shell 拼接,天然无 shell 注入);
   - 工具命名纪律:全部以 `mcp__` 前缀注册,工具白名单(`tools` 参数)显式列出,模型只能调用已注册的 MCP 工具;
   - 风险文档化(README + UI 警告 + `docs/mcp.md`):MCP server 与 OS 同权限,视为可信插件;输出不可信(提示注入),与 anysearch 结果同级对待。
2. **不允许 agent 动态注入 server 命令**:配置仅经 `PUT /api/agent/config/mcp/:name`(用户 UI 操作)修改;无任何工具/提示词路径可触发该端点。
3. **超时与资源**:connect 10s / list 10s / call 60s 超时,调用级 abort 透传;连接失败单 server 隔离(不阻塞会话);进程退出 `disposeAll()` 关闭子进程。
4. **输出卫生**:50KB 截断、错误文案脱敏(不回显 args)、abort 唯一透传——复用 `anySearchTools.ts` 既定纪律。

---

## 5. 测试与验证策略(汇总)

| 层 | 文件 | 策略 |
| --- | --- | --- |
| 单元(工厂) | `apps/api/src/pi/mcpTools.test.ts`(新) | 注入 fake `McpConnection`(vi.fn),覆盖过滤/命名/schema/往返/错误/缓存/重连/状态/隔离(§3.3.4) |
| 集成(真实 stdio) | 同上 | `node -e` 起最小 MCP server,真实 `StdioMcpConnection` 往返 |
| 配置 | `apps/api/src/config.test.ts` | mcpServers 存取 + 校验失败零写入 |
| 子代理 | `apps/api/src/pi/subAgent.test.ts` | mcpTools 注册进 tools/activeNames;缺省 `[]` 回归 |
| 路由 | `apps/api/src/agent/mcpRoutes.test.ts`(新) | CRUD + 校验 + 404(私有构造 hack 模式,仿 piService.test.ts) |
| 前端 | `apps/web/src/composables/useAgent.test.ts` | mcp actions(fetch mock) |
| 静态 | `pnpm typecheck` / `pnpm lint` | turbo 全量 |
| 构建 | `pnpm build` | shared → api/web(copy-agents.mjs 无涉) |
| 手工 | Step 9 冒烟清单 | 端到端 7 项 |

---

## 6. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 误装 SDK v2(`@modelcontextprotocol/client`) | API 不兼容,编译失败 | 锁 `^1.30.0`;安装命令显式带版本;验证 import |
| JSON Schema → TypeBox 转换不兼容(奇异 schema) | 会话创建抛错 | `Type.Unsafe` 透传 + 单工具 try/catch 跳过 + warn;会话创建不被单 server/单工具阻塞 |
| 连接泄漏/僵尸子进程(配置频繁变更) | 进程堆积 | 变更即 `disposeServer`;进程退出 `dispose()` + 信号处理;集成测试覆盖 close |
| server 宕机拖慢会话打开 | 打开工作区卡顿 | connect 10s 超时 + 单 server 失败隔离(status 可见) |
| 并发调用同一 server(并行工具执行/主子代理同时) | 协议层冲突 | MCP JSON-RPC 支持并发 request,SDK Client 线程安全;每调用独立 signal;若实测异常,`ToolDefinition.executionMode: 'sequential'` 兜底(类型已支持,一行改动) |
| 工具名冲突/非法名 | 注册失败或模型困惑 | `mcp__` 前缀 + 清洗 + 跳过 + 描述注明原名 |
| 回滚 | — | 按步骤 revert 各提交;`pnpm --filter @workflows/api remove @modelcontextprotocol/sdk`;删除 config.json 中 `mcpServers` 字段即恢复原状(读取容错:缺省 `[]`) |

---

## 7. 验收清单(逐条核对)

- [ ] `apps/api/package.json` 含 `@modelcontextprotocol/sdk@^1.30.0`,lockfile 已更新并提交
- [ ] `packages/shared` 导出 `McpServerConfig` / `McpToolInfo` / `McpServerStatus`,shared build 通过
- [ ] `config.ts`:`StoredConfig.mcpServers` + 4 个 helper;校验失败零写入(单测覆盖)
- [ ] `mcpTools.ts`:McpConnection 抽象 + StdioMcpConnection(10s/10s/60s 超时、stderr 环形缓冲)+ McpManager(缓存/重连一次/状态/dispose)+ createMcpTools(`mcp__` 前缀、清洗、跳过、Type.Unsafe、50KB 截断、错误映射)+ testMcpServer
- [ ] `piService.ts`:`this.mcp` 字段;openSession 注册 MCP 工具(只读工作区跳过);`tools` 白名单含 mcp 工具名;`dispose()`;runSubAgent 传 `mcp`
- [ ] `subAgent.ts`:`RunSubAgentOptions.mcp`;`buildSubAgentTools` 接受 `mcpTools`(缺省 [])并同步进 tools/activeNames;readOnly 子代理不注册
- [ ] `index.ts`:SIGINT/SIGTERM 优雅退出调用 `pi.dispose()`
- [ ] `routes.ts`:GET/PUT/DELETE/test 四端点,统一响应结构,校验 400/404 中文文案
- [ ] 前端:McpPanel.vue + ApiKeyModal 内嵌 + useAgent 四个 action;init() 拉取
- [ ] 文档:README(功能/存储/API 表/安全章节)+ docs/mcp.md + AGENTS.md
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` 全绿
- [ ] 手工冒烟 7 项(§3 Step 9)全部通过,无残留 MCP 子进程

## 8. 附录:关键代码位置索引

| 位置 | 文件:行(近似) | 用途 |
| --- | --- | --- |
| 工具工厂范式 | `apps/api/src/pi/anySearchTools.ts:189-191`(createAnySearchTools) | createMcpTools 的模板 |
| 错误/截断纪律 | `apps/api/src/pi/anySearchTools.ts:120-180`(truncateOutput / mapHttpError) | 复用模式 |
| 主代理工具组装 | `apps/api/src/pi/piService.ts:210-260`(openSession:webTools → guardedTools → activeTools → customTools) | MCP 注册插入点 |
| 子代理工具组装 | `apps/api/src/pi/subAgent.ts:93-190`(buildSubAgentTools)与 `:340-352`(runSubAgent 调用) | MCP 注册插入点 |
| 配置结构 | `apps/api/src/config.ts:31-40`(StoredConfig)与 `:100-130`(saveConfig 区) | mcpServers 扩展点 |
| 路由区 | `apps/api/src/agent/routes.ts:53-62`(config/key 等) | MCP 路由仿照点 |
| 前端设置面板 | `apps/web/src/components/ApiKeyModal.vue`(ANYSEARCH section) | McpPanel 嵌入点 |
| 前端状态中心 | `apps/web/src/composables/useAgent.ts`(saveAnySearchApiKey 等) | mcp actions 仿照点 |
| 共享类型 | `packages/shared/src/index.ts`(AgentConfig 附近) | 新类型插入点 |
| 测试注入范式 | `apps/api/src/pi/anySearchTools.test.ts`(fetchImpl mock)与 `piService.test.ts:39-45`(私有构造 hack) | 单测模板 |
