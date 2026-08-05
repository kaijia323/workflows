# 实施计划:MCP 功能(v1 = MCP client,stdio 传输)— 修订版 2

> runId:`09f3129e` | 依据:`01-exploration-1.md`(仓库探索报告)+ `02-plan-1.md`(上一版计划,已被用户驳回)
> 目标仓库:workflows(Turborepo + pnpm + Hono + Vue 3 + pi SDK `@earendil-works/pi-coding-agent@0.83.0`)
>
> **修订说明(相对 02-plan-1.md)**:用户驳回原因——MCP server 配置要求使用**独立的 `mcp.json` 文件**,而非放进现有 `config.json`,划分更清晰。
> 本版唯一结构性变更是**「配置存储」**:新增独立配置文件 `mcp.json`(与 config.json 同目录、沿用 `workflowsRoot` 定位逻辑),
> 原 `config.ts` 的 `StoredConfig` **不再增加 mcpServers 字段**(零改动,仅导出两个既有 util);存储 helper 独立为 `apps/api/src/mcpConfig.ts`(McpConfigStore 语义)。
> 路由从前缀 `/api/agent/config/mcp*` 改为独立路径 `/api/agent/mcp*`;Step 4/5/9 的配置读取点与冒烟文件同步修正;其余步骤(类型、工厂、子代理、前端主体、文档)逻辑不变。

## 0. 变更对照表(相对 02-plan-1.md)

| 步骤 | 变更内容 | 状态 |
| --- | --- | --- |
| Step 1 共享类型 | 类型定义不变(`McpServerConfig` 与存储位置无关) | **不变** |
| Step 2 配置存储 | **整体重写**:独立 `mcp.json` + 新文件 `apps/api/src/mcpConfig.ts`;`config.ts` 仅导出 `readJson/writeJson`(最小改动);单测移到 `mcpConfig.test.ts` | **重写** |
| Step 3 工具工厂 | `createMcpTools(manager, servers)` / `testMcpServer(config)` 只消费 servers 参数,不接触存储 | **不变** |
| Step 4 主代理注册 | 唯一修正:MCP 配置读取点 `loadConfig(this.store).mcpServers ?? []` → `loadMcpServers(this.store)`(import 自 `../mcpConfig.js`);其余不变 | **同步修正** |
| Step 5 子代理注册 | 同上(读取点一行替换) | **同步修正** |
| Step 6 API 路由 | 路径 `config/mcp*` → 独立路径 `/api/agent/mcp*`(与 config 区段解耦,独立区段) | **更新** |
| Step 7 前端 UI | 主体不变;四个 action 的 URL 同步改为 `/api/agent/mcp*` | **同步修正** |
| Step 8 文档 | README 数据存储/新章节/API 表、docs/mcp.md、AGENTS.md 中所有 `config.json` 表述改为 `mcp.json`(含格式示例与安全约束) | **更新** |
| Step 9 全量验证 | 冒烟第 1 条手工写入文件由 `.workflows/config.json` 改为 `.workflows/mcp.json` | **同步修正** |
| §4 安全约束 | 「命令只从 config.json 读取」→「只从 mcp.json 读取」;补充「mcp.json 与 config.json 同为 agent 不可写配置文件,由 workspaceGuard 保证」 | **更新** |
| §6 风险与回滚 | 回滚操作改为「删除 mcp.json」(config.json 全程未动) | **更新** |

---

## 1. 目标与范围

### 1.1 做什么(v1)

为工作台新增 **MCP client** 能力:用户通过配置页添加外部 MCP server(stdio 启动命令 + 参数),
应用在会话创建时连接该 server、拉取 `tools/list`,把每个工具包装成 pi SDK 的 `ToolDefinition`
(仿 `createAnySearchTools` 工厂模式,`apps/api/src/pi/anySearchTools.ts:189-191`)注册进**主代理**
与**子代理**会话,agent 即可调用外部工具。具体交付:

1. 新工具工厂 `apps/api/src/pi/mcpTools.ts`:`McpManager`(连接生命周期:启动/工具列表/调用/关闭,连接与工具列表按 server 缓存)+ `createMcpTools()`(ToolDefinition 转换)+ `testMcpServer()`(测试连接)。
2. **配置扩展(本版核心变更)**:独立配置文件 `mcp.json`(`{ "mcpServers": [...] }`,与 config.json 同目录,dev=`<repo>/.workflows/mcp.json`,prod=`~/.workflows/mcp.json`)+ 独立存储模块 `apps/api/src/mcpConfig.ts`(load/save/upsert/remove)+ 校验。**`config.ts` 的 `StoredConfig` 不增加 mcpServers 字段**。
3. API 路由:**独立路径** `/api/agent/mcp*`(CRUD + 测试连接/列出工具 + 运行时状态),不再挂 `config/` 子路径。
4. 主代理 `PiAgentService.openSession()` 与子代理 `buildSubAgentTools()` **双点同步注册**(探索报告 §7-2 明确此为回归高发点)。
5. 前端:MCP 管理面板(列表/添加/启用禁用/连接测试/工具列表展示),仿 `ApiKeyModal.vue` 的「ANYSEARCH」section 扩展。
6. 文档:README 功能/API/安全说明 + `docs/mcp.md` 设计文档(含决策记录,对齐仓库文档文化)+ AGENTS.md 结构更新;**明确说明 mcp.json 的作用与格式示例**。

### 1.2 不做什么(v1,明确排除)

| 排除项 | 理由 |
| --- | --- |
| **MCP server 端**(把本工作台暴露为 MCP server) | 需桥接 AgentSession/tool 事件为 JSON-RPC + 鉴权,成本高,仓库无此规划(探索报告 §8) |
| HTTP/SSE/Streamable HTTP 传输 | v1 仅 stdio;`McpConnection` 抽象层预留扩展点(§3.3.1),后续加 `StreamableHTTPClientTransport` 只需新增一个实现 |
| OAuth / 远程鉴权 | 依赖 HTTP 传输,非 v1 |
| MCP prompts / resources 能力 | pi SDK v0.83.0 的 ResourceLoader 只支持 skills/prompts 注入,无 MCP 桥接点(探索报告 §3.2-3) |
| 每工具级 enable/disable、server 级 `env`、`cwd`、`timeoutMs` 配置字段 | 保持配置面最小(`name/command/args/enabled` 四字段,按需求约束);`env`/`cwd` 由 `StdioClientTransport` 继承进程默认值 |
| **把 mcpServers 并入 config.json** | 用户驳回决定:配置划分更清晰,独立 `mcp.json`;config.json 语义保持「运行/密钥类配置」,mcp.json 语义为「外部工具插件配置」 |
| MCP 工具输出沙箱/审计执行、server 进程资源限制(cpu/内存/超时强杀) | 超出 v1;以文档风险声明 + 信任模型约束(§4) |
| 只读工作区暴露 MCP 工具 | 只读工作区语义 = 只读;MCP 工具可能产生外部副作用,一律不注册(§3.4.2),预留每-server `readOnly` 标志作为扩展点 |

### 1.3 关键设计决策(摘要)

| 决策点 | 结论 |
| --- | --- |
| **配置文件方案(本版核心)** | **独立 `mcp.json`**,与 config.json 同目录(均位于 `.workflows/` 根,由 `workflowsRoot()` 统一定位)。内容 `{ "mcpServers": [{ name, command, args?, enabled? }] }`。`StoredConfig` 零改动;`WorkflowsStore` 接口零改动(mcp.json 路径经 `path.join(store.root, 'mcp.json')` 计算,`store.root` 为既有定位事实源) |
| 存储模块形态 | **独立 `McpConfigStore` 模块**(`apps/api/src/mcpConfig.ts`,纯函数风格对齐 config.ts),**复用** config.ts 的 `readJson`/`writeJson`(该两函数需加 `export`,这是 config.ts 的唯一改动);不仿写、不复制 util |
| 并发写保护 | **与 config.json 同模式:无 mutex/lock**。已核实 config.ts 现状为同步 `writeFileSync`(Node 单线程事件循环下同步 I/O 天然串行,无进程内并发写问题);mcp.json 保持同步读写,不引入锁 |
| 原子性 / 校验失败零写入 | **校验失败零写入**:`saveMcpServers` 先全量校验、任一失败抛 Error(中文)不落盘(与 config.json 一致);**原子性增强**:写入采用 `tmp 文件 + renameSync`(同目录 rename 原子替换,`renameSync` 已在 config.ts import 中,无新依赖),避免写入中断留下半截 mcp.json;config.json 既有行为不动 |
| 工具命名 | 统一前缀 `mcp__<server>__<tool>`(如 `mcp__github__create_issue`)。`mcp__` 前缀保证与内置工具(`read/bash/edit/write/grep/find/ls`)、仓库工具(`fff-find/fff-grep/anysearch-search`)、编排工具(`wait_for_approval/complete_task`、子代理名)零冲突;server 名由配置校验保证唯一 → 跨 server 无冲突 |
| 工具名校验 | 最终名必须匹配 `/^[a-zA-Z0-9_-]+$/` 且长度 ≤ 128(MCP spec 建议字符集);非法字符替换为 `_`,替换后仍非法/超长 → **跳过该工具**(console.warn);同一 server 内重名工具 → 保留首个 |
| 参数 schema 转换 | MCP `inputSchema`(JSON Schema)用 TypeBox `Type.Unsafe<T>()` 透传包装(不逐字段翻译);非 object 根 schema / 转换异常 → 跳过该工具并 warn(§3.3.3) |
| 连接生命周期 | `McpManager` 为 `PiAgentService` 单例字段;连接 + tools 列表按 server 缓存,**主/子代理共享同一连接**(子代理每次新建会话但工具 execute 闭包只引用 manager,无会话状态);调用时连接已断 → 自动重连一次并重试该次调用 |
| 生效时机 | 与 skills 语义一致(README「新增/修改 skill 后需重开会话」):**MCP 配置变更后需新建会话/重开工作区生效**;配置变更时 `disposeServer()` 断开旧连接,避免僵尸进程 |
| 安全模型 | MCP server = 用户显式配置的可信插件(与 OS 用户同权限);server 命令**只从 `mcp.json` 读取**,agent 无任何工具可写 `.workflows/mcp.json`(与 config.json 同级同保护:bash/write/edit 被 workspaceGuard 限制在工作区内;skills 只读放行根为子树语义,兄弟路径 mcp.json 仍拦截);UI + README 显著风险提示;工具输出视为不可信内容(与 anysearch 同级) |
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

(本步与 02-plan-1.md 一致,不变。)

---

## 3. 文件级改动清单(分步实施)

> 每步含:改动文件、具体内容、预期结果、验收标准。步骤间有依赖,按序执行。
> 所有新增文件遵循仓库约定:中文注释头(设计说明)、TypeBox schema、`AgentToolResult<undefined>`、50KB 截断、错误文案中文。
> 标注「不变」的步骤与 02-plan-1.md 完全一致,此处保留完整内容供 executor 直接执行。

### Step 1:共享类型(`packages/shared`)— **不变**

**文件**:`packages/shared/src/index.ts`(追加,不破坏既有导出)

在 `AgentConfig` 附近新增:

```ts
/** MCP server 配置(存 .workflows/mcp.json 独立文件,与 config.json 平级;agent 无途径修改,仅用户经 API/UI 配置) */
export interface McpServerConfig {
  /** 唯一名,匹配 /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,≤ 40 字符 */
  name: string
  /** 启动可执行文件(如 npx / node / python),由配置直供,不经 shell */
  command: string
  /** 启动参数(如 ["-y", "@modelcontextprotocol/server-filesystem", "/path"]) */
  args?: string[]
  /** 是否启用(新增默认 false,opt-in;缺省视为未启用,opt-in 语义在消费端 createMcpTools 实现) */
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

> 注释措辞更新为「存 .workflows/mcp.json 独立文件」;类型定义本身与 02-plan-1.md 一致。

**验收**:`pnpm --filter @workflows/shared build` 通过;`packages/shared/dist` 产出新类型(api/web 后续步骤消费)。

---

### Step 2:配置存储(独立 `mcp.json` + 新模块 `apps/api/src/mcpConfig.ts`)— **重写(本版核心)**

#### 2.1 配置文件方案

**新增独立配置文件 `mcp.json`**(与 config.json **同目录**,dev=`<repo>/.workflows/mcp.json`,prod=`~/.workflows/mcp.json`),
定位逻辑沿用现有 `workflowsRoot()`/`createStore().root`(`apps/api/src/config.ts:14-28、37-54`)——`mcp.json` 路径不新增字段,
在 helper 内以 `path.join(store.root, 'mcp.json')` 计算(与 `configPath: path.join(root, 'config.json')` 完全同构)。

文件内容格式(单一键,便于扩展):

```json
{
  "mcpServers": [
    { "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "enabled": true }
  ]
}
```

**边界声明**:

- `StoredConfig`(config.ts L31-40)**零改动**:不增加 `mcpServers` 字段,config.json 语义保持「运行/密钥类配置」;
- `WorkflowsStore` 接口**零改动**(不新增 `mcpConfigPath` 字段,路径由 `mcpConfigPath(store)` 函数集中定义);
- `config.ts` 的唯一改动:把模块级 util `readJson`/`writeJson`(L73-81)加 `export`(供 mcpConfig.ts 复用),不改任何既有函数行为;
- 两个文件各自独立读写、互不依赖;`loadMcpServers` 对 mcp.json 缺失/损坏容错(→ 空列表),不影响 config.json 既有流程。

#### 2.2 配置读写(McpConfigStore,独立模块)

**文件**:`apps/api/src/mcpConfig.ts`(新建;纯函数风格对齐 config.ts 区段式组织)

```ts
import { existsSync, rmSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { McpServerConfig } from '@workflows/shared'
import { readJson, writeJson, type WorkflowsStore } from './config.js'

/** mcp.json 内容结构:独立于 config.json 的单一键文件 */
interface StoredMcpConfig { mcpServers?: McpServerConfig[] }

const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const MCP_SERVER_NAME_MAX = 40

/** mcp.json 路径:与 config.json 同目录,沿用 workflowsRoot/createStore.root 定位逻辑 */
export function mcpConfigPath(store: WorkflowsStore): string {
  return path.join(store.root, 'mcp.json')
}

/**
 * 读取 MCP server 列表。
 * 容错语义与 loadConfig 一致:文件不存在 / JSON 损坏 / mcpServers 缺失或非数组 → 返回 []。
 * 读取不做逐项校验(坏条目在注册/测试时自然失败或跳过,不阻塞会话打开)。
 */
export function loadMcpServers(store: WorkflowsStore): McpServerConfig[] {
  const raw = readJson<StoredMcpConfig>(mcpConfigPath(store), {})
  return Array.isArray(raw?.mcpServers) ? raw.mcpServers : []
}

/** 全量校验(任一失败抛 Error,中文文案,不写盘) */
function validateMcpServers(servers: McpServerConfig[]): void {
  const seen = new Set<string>()
  for (const s of servers) {
    if (typeof s?.name !== 'string' || !MCP_SERVER_NAME_RE.test(s.name) || s.name.length > MCP_SERVER_NAME_MAX) {
      throw new Error(`MCP server 名称非法:必须匹配 /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/ 且不超过 ${MCP_SERVER_NAME_MAX} 字符`)
    }
    if (seen.has(s.name)) throw new Error(`MCP server 名称重复:${s.name}`)
    seen.add(s.name)
    if (typeof s.command !== 'string' || s.command.trim() === '') throw new Error(`MCP server「${s.name}」缺少启动命令(command)`)
    if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== 'string'))) {
      throw new Error(`MCP server「${s.name}」的 args 必须是字符串数组`)
    }
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') throw new Error(`MCP server「${s.name}」的 enabled 必须是布尔值`)
  }
}

/** 原子写:先写 <file>.tmp 再 renameSync 替换(同目录 rename 原子,写入中断不留半截文件);失败时清理 tmp */
function writeMcpConfig(store: WorkflowsStore, servers: McpServerConfig[]): void {
  const file = mcpConfigPath(store)
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ mcpServers: servers }, null, 2) + '\n', 'utf-8')
    renameSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** 全量校验后落盘;校验失败抛 Error(中文文案),零写入。返回传入的 servers(调用方可直接使用)。 */
export function saveMcpServers(store: WorkflowsStore, servers: McpServerConfig[]): McpServerConfig[] {
  validateMcpServers(servers)
  writeMcpConfig(store, servers)
  return servers
}

/** upsert 语义:同 name 覆盖、不同 name 追加;校验失败抛错零写入;返回更新后全量列表 */
export function upsertMcpServer(store: WorkflowsStore, server: McpServerConfig): McpServerConfig[] {
  const servers = loadMcpServers(store)
  const idx = servers.findIndex((s) => s.name === server.name)
  const next = idx === -1 ? [...servers, server] : servers.map((s, i) => (i === idx ? server : s))
  return saveMcpServers(store, next)
}

/** 删除指定 server;不存在返回 false;成功返回 true(内部 saveMcpServers 保证校验与原子写) */
export function removeMcpServer(store: WorkflowsStore, name: string): boolean {
  const servers = loadMcpServers(store)
  const next = servers.filter((s) => s.name !== name)
  if (next.length === servers.length) return false
  saveMcpServers(store, next)
  return true
}
```

实现要点(对照用户要求的四项):

1. **复用 vs 仿写**:复用 config.ts 的 `readJson`(文件缺失/损坏 fallback)与 `writeJson`(格式化落盘);仅新写 `writeMcpConfig` 的 tmp+rename 原子写包装。config.ts 改动 = 2 个 `export` 关键字。
2. **文件不存在 → 空列表**:`readJson` fallback `{}` + `Array.isArray(raw?.mcpServers)` 守卫,双层容错。
3. **原子性 / 校验失败零写入**:校验先行(validateMcpServers 抛错即 return,不触碰文件);写入为 tmp+rename 原子替换。
4. **并发写保护**:与 config.json 完全同模式——**无 mutex/lock**,同步 `writeFileSync`/`renameSync`(已核实 config.json 现状即此模式;Node 单线程事件循环下同步 I/O 天然串行,进程内无并发写交错;生产为单进程 serve,跨进程写不在仓库既有保障范围内,保持一致不引入锁)。
5. `enabled` 缺省:**存储层保留原值不补写**(文件最小 diff);opt-in 语义(`enabled !== true` 不注册)在消费端 `createMcpTools` 实现(Step 3)。
6. 与 config.json 的 `saveConfig` `''/null` 删除语义**互不影响**(两个文件独立,无字段互删风险)。

**文件**:`apps/api/src/config.ts`(最小改动,仅此一处)

```ts
// L73-81:两个既有 util 加 export,其余一律不动
export function readJson<T>(file: string, fallback: T): T { ... }
export function writeJson(file: string, value: unknown): void { ... }
```

**文件**:`apps/api/src/mcpConfig.test.ts`(新建;替代原计划在 config.test.ts 追加的 describe,config.test.ts 零改动)

用例清单:

1. **容错**:文件不存在 → `[]`;文件为空对象/缺 `mcpServers`/`mcpServers` 非数组 → `[]`;JSON 损坏 → `[]`。
2. **存取往返**:`saveMcpServers` 后重新 `loadMcpServers` 一致;磁盘文件内容为 `{ "mcpServers": [...] }`(断言不含 config.json 的其他字段);`enabled` 缺省时文件中原样缺省(不补写)。
3. **校验失败零写入**:非法 name(空串、含空格/点/中文、超 40 字符)、重名、空 command、args 含非字符串、enabled 非布尔 → 各自抛 Error(中文文案),且断言 mcp.json **不存在或内容未变**(先写一份合法数据,校验失败后比对内容字节一致)。
4. **upsert**:新增追加;同 name 覆盖(字段级替换,列表长度不变)。
5. **remove**:存在 → true 且列表减少;不存在 → false 且文件不变。
6. **原子写**:写入后文件内容完整可解析(tmp 无残留,可用 `existsSync(file + '.tmp')` 断言)。

**验收**:`pnpm --filter @workflows/api test mcpConfig.test.ts` 全绿;`config.test.ts` 既有用例不回归(零改动);`grep -r mcpServers apps/api/src/config.ts` 零命中(StoredConfig 未动)。

---

### Step 3:工具工厂与连接管理器(新文件 `apps/api/src/pi/mcpTools.ts` + 单测)— **不变**

> 本步骤只消费 `McpServerConfig[]` 参数与 `testMcpServer(config)`,不接触任何存储文件;与 02-plan-1.md 完全一致。

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

### Step 4:主代理注册(`apps/api/src/pi/piService.ts`)— **同步修正(仅配置读取点)**

> 相对 02-plan-1.md 的唯一变化:第 3 点的 MCP 配置读取由 `loadConfig(this.store).mcpServers ?? []` 改为 `loadMcpServers(this.store)`(独立 mcp.json 读取)。

**文件**:`apps/api/src/pi/piService.ts`

1. import:`createMcpTools, McpManager` from `./mcpTools.js`;**`loadMcpServers` from `../mcpConfig.js`**(不再经 `loadConfig` 读 mcp 配置)。
2. 类字段(`fff` 附近):
   ```ts
   /** MCP server 连接管理器(跨主/子代理共享连接;配置变更时 disposeServer) */
   private readonly mcp = new McpManager()
   ```
3. `openSession()` 工具组装区(`webTools` 之后、`guardedTools` 之前,现 L263-278):
   ```ts
   // MCP 外部工具:只读工作区不注册(MCP 工具可能产生工作区外副作用);
   // 配置变更需新建会话/重开工作区生效(与 skills 语义一致,README 已有说明)
   const mcpServers = loadMcpServers(this.store)
   const mcpTools = workspace.readOnly ? [] : await createMcpTools(this.mcp, mcpServers)
   const mcpToolNames = mcpTools.map((tool) => tool.name)
   ```
4. `guardedTools` 数组(L266-272)加入 `...mcpTools`(只读分支不加,因 mcpTools 已为空);`activeTools` 两个分支(L278,只读/读写)均追加 `...mcpToolNames`(注意注释区「tools 白名单必须显式列入」)。
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

### Step 5:子代理注册(`apps/api/src/pi/subAgent.ts`)— **同步修正(仅配置读取点)**

> 相对 02-plan-1.md 的唯一变化:第 2 点的 MCP 配置读取由 `loadConfig(store).mcpServers ?? []` 改为 `loadMcpServers(store)`。

**文件**:`apps/api/src/pi/subAgent.ts`

1. `RunSubAgentOptions` 追加字段:
   ```ts
   /** MCP 连接管理器(与主代理共享连接与工具缓存) */
   mcp: McpManager
   ```
2. `runSubAgent()` 内、`buildSubAgentTools` 调用前(现 L340-352):
   ```ts
   const mcpServers = loadMcpServers(store)   // import from '../mcpConfig.js'
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

### Step 6:API 路由(`apps/api/src/agent/routes.ts`)— **更新(独立路径 `/api/agent/mcp*`)**

> 相对 02-plan-1.md 的变化:路由前缀由 `config/mcp*` 改为**独立路径** `/api/agent/mcp*`(与 `/api/agent/config/*` 区段完全解耦;仍挂 `registerAgentRoutes` 内,保持现有 `/api/agent/*` 组织方式,不引入新的顶层前缀)。
> 选 `/api/agent/mcp*` 而非 `/api/mcp/*`:仓库所有业务路由均在 `/api/agent/*` 下,沿用既有前缀零新增组织成本。

**文件**:`apps/api/src/agent/routes.ts`(在「配置」区段之后新增独立「MCP server 管理」区段;路由路径不带 `config` 前缀)

| 方法/路径 | 行为 |
| --- | --- |
| `GET /api/agent/mcp` | `{ servers: McpServerConfig[], status: McpServerStatus[] }`(配置 + 运行时状态;`pi.mcp.status()` 与 `loadMcpServers(store)` 按 name 合并) |
| `PUT /api/agent/mcp/:name` | upsert:body `{ name, command, args?, enabled? }`;经 `upsertMcpServer` 校验(400 中文文案);保存后 `await pi.mcp.disposeServer(name)`(断旧连接,新会话生效);返回更新后 `{ servers, status }` |
| `DELETE /api/agent/mcp/:name` | `removeMcpServer`(404 若不存在)+ `disposeServer`;返回更新后列表 |
| `POST /api/agent/mcp/:name/test` | 用配置里的该 server 调 `testMcpServer()`(一次性连接,不污染 manager 缓存、不注册进会话);返回 `{ ok, tools?, error? }`;测试整体有 15s 上限(testMcpServer 内部已含 10s connect + 10s list) |

实现细节:

- body 解析复用 `readJson`;name 以 URL 参数为准与 body 校验一致(不一致以 URL 为准)。
- 统一响应结构 `{ code, message, data }`;错误走 `HTTPException`(app.onError 统一格式化)。
- `pi` 侧新增薄方法:在 `PiAgentService` 加 `getMcpStatus()`(透传 `this.mcp.status()`)或 routes 直接访问 `pi.mcp`(建议 `mcp` 字段保持 `private`,加公开方法 `getMcpStatus(): McpServerStatus[]`)。
- import 更新:routes.ts 顶部从 `../config.js` 改为从 `../mcpConfig.js` 引入 `loadMcpServers/upsertMcpServer/removeMcpServer`(config.js 的既有 import 不动)。

**文件**:`apps/api/src/agent/mcpRoutes.test.ts`(新建;仿 piService.test.ts 的私有构造 hack 模式;路径用 `/api/agent/mcp*`)

- 用 `mkdtempSync` 构造 fake store + `new PiAgentService(store, {} as ModelRuntime)`(piService.test.ts L39-45 已示范)。
- 用例:PUT 新增(校验通过落盘、返回列表含新项、`enabled` 缺省 false 语义透传);PUT 非法 name/空 command → 400 且 mcp.json 未变(校验失败零写入);PUT 重名 → 覆盖更新(upsert 语义);DELETE 存在/不存在(200/404);GET 返回 servers+status;PUT 后 manager 缓存被 dispose(用注入 factory 的 fake manager 断言 close 调用——若直接访问 pi.mcp 不便,可先只测 config 层,dispose 行为由 mcpTools.test.ts 覆盖,本文件标注该用例可选)。
- test 端点不做进程级测试(集成已覆盖真实连接)。

**验收**:`pnpm --filter @workflows/api test` 全绿;`curl` 手工冒烟(见 Step 9);`GET /api/agent/config` 响应中**不出现**任何 mcp 字段(config.json 未扩展)。

---

### Step 7:前端 UI— **同步修正(仅 URL)**

> 相对 02-plan-1.md 的变化:四个 action 的 URL 由 `/api/agent/config/mcp*` 改为 `/api/agent/mcp*`;组件结构、交互、样式全部不变。

**文件**:`apps/web/src/composables/useAgent.ts`

- 状态:`const mcp = ref<{ servers: McpServerConfig[]; status: McpServerStatus[] } | null>(null)`。
- actions(全部走既有 `request<T>()`):
  ```ts
  async function refreshMcp(): Promise<void>            // GET /api/agent/mcp
  async function saveMcpServer(server: McpServerConfig): Promise<void>  // PUT /api/agent/mcp/:name + refreshMcp
  async function deleteMcpServer(name: string): Promise<void>           // DELETE /api/agent/mcp/:name + refreshMcp
  async function testMcpServer(name: string): Promise<{ ok: boolean; tools?: McpToolInfo[]; error?: string }>  // POST /api/agent/mcp/:name/test
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

### Step 8:文档与安全说明— **更新(mcp.json 表述)**

> 相对 02-plan-1.md 的变化:所有涉及配置文件的表述由 config.json 改为 mcp.json,并**新增 mcp.json 的作用说明与格式示例**;安全约束补充「mcp.json 与 config.json 同为 agent 不可写配置文件,由 workspaceGuard 保证」。

**文件**:`README.md`

- 「功能」清单加一条:MCP 外部工具(MCP client,stdio;主/子代理可用)。
- 「数据存储」段:新增 `mcp.json` 条目(与 config.json 平级独立文件):
  ```
  mcp.json —— MCP server 插件配置(独立于 config.json,划分清晰):
  { "mcpServers": [{ "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "enabled": true }] }
  · 由设置面板维护,亦可手工编辑;agent 无任何工具可写(与 config.json 同为 agent 不可写配置文件,由 workspaceGuard 保证)
  · 变更后需新建会话/重开工作区生效(与 skills 一致)
  ```
  (config.json 字段说明**不**加 mcpServers。)
- 新增「MCP(外部工具)」章节:配置文件 mcp.json 的作用与格式示例、配置方式(UI 或手工编辑 mcp.json)、生效时机(重开会话)、**安全模型**(server 以当前用户权限运行;命令仅来自 mcp.json,agent 无法注入;输出不可信;只读工作区不注册;建议仅添加信任的 server)。
- 「API 一览」表加 4 行(`GET/PUT/DELETE /api/agent/mcp[/:name]` + `POST /api/agent/mcp/:name/test`,§3 Step 6 的路由)。

**文件**:`docs/mcp.md`(新建,设计文档,对齐 `docs/dag-workflow.md` 结构)

- 背景与目标 / 架构图(文字版:mcp.json → routes → McpManager → StdioMcpConnection → MCP server;注册到主/子代理双点)/ 工具命名与冲突策略 / 生命周期与缓存 / **配置存储设计(独立 mcp.json 的决策:与 config.json 划分、读写容错、原子写、无锁同步写理由)** / 安全模型 / 决策记录(为什么 v1 不做 server、不做 HTTP 传输、为什么 readOnly 不注册、为什么 v1 SDK 而非 v2、**为什么独立 mcp.json 而非并入 config.json**)。

**文件**:`AGENTS.md`

- 目录结构段补 `src/mcpConfig.ts`(mcp.json 独立存储:load/save/upsert/remove + 校验 + 原子写)与 `src/pi/mcpTools.ts`(MCP client 工厂:连接生命周期 + ToolDefinition 转换);约定段补「新增工具需主/子代理双点注册,含 MCP 工具」提示。

**验收**:文档与实现一致(关键对照:路由表 `/api/agent/mcp*`、mcp.json 格式示例、生效时机、安全约束)。

---

### Step 9:全量验证— **同步修正(冒烟文件改为 mcp.json)**

> 相对 02-plan-1.md 的变化:冒烟第 1 条手工写入的文件由 `.workflows/config.json` 改为 `.workflows/mcp.json`(内容结构 `{ "mcpServers": [...] }` 不变);其余 6 项不变。

```bash
pnpm --filter @workflows/shared build   # 或直接 pnpm build(turbo 依赖顺序自动处理)
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

手工冒烟(dev):

1. `pnpm dev`;在 `.workflows/mcp.json` 手工写入一个 server 配置(或经 UI 添加),如:
   ```json
   { "mcpServers": [{ "name": "echo", "command": "node", "args": ["-e", "<最小 stdio MCP server 脚本>"], "enabled": true }] }
   ```
   同时确认 `.workflows/config.json` **不含** mcpServers 字段(独立文件验证)。
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
   - MCP server 命令**只从 `.workflows/mcp.json` 读取**:**mcp.json 与 config.json 同为 agent 不可写的配置文件,由 workspaceGuard 保证**——bash 被 workspaceGuard 静态审计限制在工作区;write/edit 的工具 path 校验拦截工作区外路径;skills 只读放行根为子树语义(仅 skills 目录之下),兄弟路径 `.workflows/mcp.json`、`.workflows/config.json` 均被拦截(workspaceGuard.ts:14 注释已明确此语义);`.workflows` 位于仓库根(dev)/用户目录(prod),均在工作区外 → 命令注入面关闭;
   - 启动不经过 shell:`StdioClientTransport({ command, args })` 直接 spawn,args 作为 argv 传递(无 shell 拼接,天然无 shell 注入);
   - 工具命名纪律:全部以 `mcp__` 前缀注册,工具白名单(`tools` 参数)显式列出,模型只能调用已注册的 MCP 工具;
   - 风险文档化(README + UI 警告 + `docs/mcp.md`):MCP server 与 OS 同权限,视为可信插件;输出不可信(提示注入),与 anysearch 结果同级对待。
2. **不允许 agent 动态注入 server 命令**:配置仅经 `PUT /api/agent/mcp/:name`(用户 UI 操作)修改;无任何工具/提示词路径可触发该端点;mcp.json 与 config.json 同为 agent 不可写(workspaceGuard 拦截),手工编辑仅限用户本人。
3. **超时与资源**:connect 10s / list 10s / call 60s 超时,调用级 abort 透传;连接失败单 server 隔离(不阻塞会话);进程退出 `disposeAll()` 关闭子进程。
4. **输出卫生**:50KB 截断、错误文案脱敏(不回显 args)、abort 唯一透传——复用 `anySearchTools.ts` 既定纪律。

---

## 5. 测试与验证策略(汇总)

| 层 | 文件 | 策略 |
| --- | --- | --- |
| 单元(工厂) | `apps/api/src/pi/mcpTools.test.ts`(新) | 注入 fake `McpConnection`(vi.fn),覆盖过滤/命名/schema/往返/错误/缓存/重连/状态/隔离(§3.3.4) |
| 集成(真实 stdio) | 同上 | `node -e` 起最小 MCP server,真实 `StdioMcpConnection` 往返 |
| **配置(mcp.json)** | **`apps/api/src/mcpConfig.test.ts`(新;config.test.ts 零改动)** | 容错/存取往返/校验失败零写入/upsert/remove/原子写 |
| 子代理 | `apps/api/src/pi/subAgent.test.ts` | mcpTools 注册进 tools/activeNames;缺省 `[]` 回归 |
| 路由 | `apps/api/src/agent/mcpRoutes.test.ts`(新) | `/api/agent/mcp*` CRUD + 校验 + 404(私有构造 hack 模式,仿 piService.test.ts) |
| 前端 | `apps/web/src/composables/useAgent.test.ts` | mcp actions(fetch mock,URL 为 `/api/agent/mcp*`) |
| 静态 | `pnpm typecheck` / `pnpm lint` | turbo 全量 |
| 构建 | `pnpm build` | shared → api/web(copy-agents.mjs 无涉) |
| 手工 | Step 9 冒烟清单 | 端到端 7 项(含 config.json 无 mcpServers 字段断言) |

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
| **mcp.json 写入中断(进程被杀)** | 半截文件导致配置丢失 | tmp + renameSync 原子写(Step 2.2);读取侧容错(损坏 → 空列表,不崩) |
| **用户手工编辑 mcp.json 语法错误** | 配置读不到 | 读取容错(损坏 → 空列表 + 后续保存整体覆盖);文档说明格式 |
| 回滚 | — | 按步骤 revert 各提交;`pnpm --filter @workflows/api remove @modelcontextprotocol/sdk`;**删除 `.workflows/mcp.json` 即恢复原状**(读取容错:文件不存在 → 空列表,无 MCP 工具注册);config.json 全程未改,无字段需清理 |

---

## 7. 验收清单(逐条核对)

- [ ] `apps/api/package.json` 含 `@modelcontextprotocol/sdk@^1.30.0`,lockfile 已更新并提交
- [ ] `packages/shared` 导出 `McpServerConfig` / `McpToolInfo` / `McpServerStatus`,shared build 通过
- [ ] **`config.ts`:`StoredConfig` 零改动(`grep -r mcpServers apps/api/src/config.ts` 零命中);唯一改动是 `readJson`/`writeJson` 加 `export`;`config.test.ts` 未改动且全绿**
- [ ] **`mcpConfig.ts`:`mcpConfigPath`(path.join(store.root, 'mcp.json'))+ `loadMcpServers`(缺失/损坏 → [])+ `saveMcpServers`(校验失败零写入 + tmp/rename 原子写)+ `upsertMcpServer` + `removeMcpServer`;单测覆盖校验失败零写入与原子写**
- [ ] `mcpTools.ts`:McpConnection 抽象 + StdioMcpConnection(10s/10s/60s 超时、stderr 环形缓冲)+ McpManager(缓存/重连一次/状态/dispose)+ createMcpTools(`mcp__` 前缀、清洗、跳过、Type.Unsafe、50KB 截断、错误映射)+ testMcpServer
- [ ] `piService.ts`:`this.mcp` 字段;openSession 用 `loadMcpServers(this.store)` 注册 MCP 工具(只读工作区跳过);`tools` 白名单含 mcp 工具名;`dispose()`;runSubAgent 传 `mcp`
- [ ] `subAgent.ts`:`RunSubAgentOptions.mcp`;`buildSubAgentTools` 接受 `mcpTools`(缺省 [])并同步进 tools/activeNames;readOnly 子代理不注册
- [ ] `index.ts`:SIGINT/SIGTERM 优雅退出调用 `pi.dispose()`
- [ ] **`routes.ts`:`GET/PUT/DELETE /api/agent/mcp[/:name]` + `POST /api/agent/mcp/:name/test` 四端点(独立路径,不带 `config` 前缀),统一响应结构,校验 400/404 中文文案;`GET /api/agent/config` 响应无 mcp 字段**
- [ ] 前端:McpPanel.vue + ApiKeyModal 内嵌 + useAgent 四个 action(URL 为 `/api/agent/mcp*`);init() 拉取
- [ ] 文档:README(功能/数据存储 **mcp.json 条目与格式示例**/API 表/安全章节)+ docs/mcp.md(含独立 mcp.json 决策记录)+ AGENTS.md(补 mcpConfig.ts)
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` 全绿
- [ ] 手工冒烟 7 项(§3 Step 9)全部通过:含 `.workflows/mcp.json` 手工写入生效、config.json 无 mcpServers 字段、无残留 MCP 子进程

## 8. 附录:关键代码位置索引

| 位置 | 文件:行(近似) | 用途 |
| --- | --- | --- |
| 工具工厂范式 | `apps/api/src/pi/anySearchTools.ts:189-191`(createAnySearchTools) | createMcpTools 的模板 |
| 错误/截断纪律 | `apps/api/src/pi/anySearchTools.ts:120-180`(truncateOutput / mapHttpError) | 复用模式 |
| 主代理工具组装 | `apps/api/src/pi/piService.ts:263-278`(openSession:webTools → guardedTools → activeTools)与 `:317-319`(customTools/tools 白名单) | MCP 注册插入点 |
| 子代理工具组装 | `apps/api/src/pi/subAgent.ts:93-190`(buildSubAgentTools)与 `:340-352`(runSubAgent 调用) | MCP 注册插入点 |
| **存储定位逻辑(本版)** | `apps/api/src/config.ts:14-28`(workflowsRoot)与 `:37-54`(createStore,`store.root` 为定位事实源) | mcp.json 路径 = `path.join(store.root, 'mcp.json')` |
| **复用 util(本版)** | `apps/api/src/config.ts:73-81`(readJson/writeJson,加 export) | mcpConfig.ts 复用,不仿写 |
| **存储模块(本版)** | `apps/api/src/mcpConfig.ts`(新建) | load/save/upsert/remove + 校验 + 原子写 |
| 路由区 | `apps/api/src/agent/routes.ts:53-77`(配置区段;MCP 独立区段插在其后,路径 `/api/agent/mcp*`) | MCP 路由仿照点 |
| 前端设置面板 | `apps/web/src/components/ApiKeyModal.vue`(ANYSEARCH section) | McpPanel 嵌入点 |
| 前端状态中心 | `apps/web/src/composables/useAgent.ts`(saveAnySearchApiKey 等) | mcp actions 仿照点 |
| 共享类型 | `packages/shared/src/index.ts`(AgentConfig 附近) | 新类型插入点 |
| 测试注入范式 | `apps/api/src/pi/anySearchTools.test.ts`(fetchImpl mock)与 `piService.test.ts:39-45`(私有构造 hack) | 单测模板 |
