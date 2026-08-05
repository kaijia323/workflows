# 调研报告:workflows 仓库 MCP 配置与热更新可行性

> 调研范围:仓库 `/home/kaijia/codes/github/workflows`(只读调研,未修改任何代码)
> 调研目标:① 仓库概览与 MCP 功能 ② MCP 配置加载链路 ③ 热更新机制现状 ④ 服务启动方式 ⑤ "配置变更需重启"的根因 ⑥ 可参考的测试/示例

---

## 1. 项目概览

**workflows** — Turborepo + pnpm workspace 的 monorepo,基于 **pi SDK**(`@earendil-works/pi-coding-agent` / `pi-ai`)的 Web Agent 工作台:DAG 可视化的工作流编排(主代理 orchestrator 调度 explorer/planner/executor/reviewer 四个子代理,计划需人工闸门批准)。

| 包 | 技术栈 | 职责 |
| --- | --- | --- |
| `apps/web` | Vue 3 + TS + Vite + Tailwind v4 | 聊天 UI(SSE 流式)、工作区管理、设置面板(含 MCP 管理面板) |
| `apps/api` | Hono + `@hono/node-server` + pi SDK + `@modelcontextprotocol/sdk` v1 | API 服务、会话管理、工具集构建(含 MCP client) |
| `packages/shared` | 纯 TS 类型 | 跨端共享类型 |

**MCP 功能:有。** 本工作台是 **MCP client(stdio 传输)**:用户在设置面板配置外部 MCP server,会话创建时连接 server、拉取 `tools/list`,把每个工具包装为 pi SDK 工具(`mcp__<server>__<tool>` 命名)注册进主代理与子代理会话。详见 `docs/mcp.md` 设计文档。

**数据存储**(`config.ts` 的 `workflowsRoot()`):
- dev:`<repo>/.workflows`(已 gitignore);prod:`~/.workflows`
- 内含 `config.json`(API key/模型)、`workspaces.json`、`workspace-sessions.json`、`mcp.json`(MCP 配置)、`agent/`(pi auth/models/sessions)、`skills/`

---

## 2. 关键文件清单

### MCP 相关(核心)
| 路径 | 说明 |
| --- | --- |
| `apps/api/src/mcpConfig.ts` | mcp.json 存储层:`loadMcpServers` / `saveMcpServers` / `upsertMcpServer` / `removeMcpServer`;校验失败零写入;tmp+rename 原子写 |
| `apps/api/src/pi/mcpTools.ts` | MCP client 工厂:`StdioMcpConnection`(SDK Client+Stdio 传输,connect 10s/list 10s/call 60s 超时)、`McpManager`(按 server 缓存连接+工具,主/子代理共享)、`createMcpTools`(工具集构建,`mcp__<server>__<tool>` 命名,execute 闭包捕获 server 配置)、`testMcpServer`(一次性测试) |
| `apps/api/src/pi/piService.ts` | 服务层:`openSession()` 主代理会话创建(内含 `loadMcpServers` + `createMcpTools`);`disposeMcpServer()`;`reopenIfOpen()`(只读切换时重建会话的现成模式) |
| `apps/api/src/pi/subAgent.ts` | 子代理运行器:`runSubAgent()` 每次调用**新建**子代理会话并重新 `loadMcpServers` + `createMcpTools`(与主代理共享 McpManager 连接缓存) |
| `apps/api/src/agent/routes.ts` | 路由层:`GET/PUT/DELETE /api/agent/mcp*`(PUT/DELETE 写盘后调 `pi.disposeMcpServer(name)` 断旧连接清缓存)、`POST /api/agent/mcp/:name/test` |
| `apps/api/src/config.ts` | `.workflows` 存储根:`workflowsRoot()` / `createStore()` / `readJson`(readFileSync 同步读) |
| `apps/api/src/index.ts` | 进程入口 |
| `apps/api/src/app.ts` | Hono app:`initAgentRoutes()`(createStore + PiAgentService.create + 注册路由) |

### 前端
| 路径 | 说明 |
| --- | --- |
| `apps/web/src/components/McpPanel.vue` | MCP 管理面板(添加/启停/测试/删除;保存后提示"需新建会话或重开工作区生效",第 454 行) |
| `apps/web/src/composables/useAgent.ts` | agent store:`refreshMcp` / `saveMcpServer` / `deleteMcpServer` / `testMcpServer` 封装 |

### 配置与构建
| 路径 | 说明 |
| --- | --- |
| `.workflows/mcp.json` | dev 实际配置(当前含 `context7` server:`npx -y @upstash/context7-mcp@latest`,enabled) |
| `package.json` / `turbo.json` / `apps/*/package.json` / `apps/web/vite.config.ts` | 脚本与端口 |

---

## 3. MCP 配置加载链路(完整)

```
用户(设置面板 McpPanel.vue 或手工编辑)
  └─ PUT/DELETE /api/agent/mcp/:name  (routes.ts)
       ├─ upsertMcpServer / removeMcpServer  (mcpConfig.ts → writeFileSync tmp + renameSync 原子写 .workflows/mcp.json)
       └─ pi.disposeMcpServer(name)  (piService.ts → mcp.disposeServer(name) 断开旧连接 + 清缓存)
              └─ 注意:不重建任何已打开会话的工具集

会话创建时(工具集构建点,唯一入口):
  ┌─ 主代理:PiAgentService.openSession()  (piService.ts)
  │     ├─ loadMcpServers(store)        ← 同步 readFileSync 读盘
  │     ├─ createMcpTools(this.mcp, mcpServers)  ← 连接 server、tools/list、包装成 ToolDefinition[]
  │     └─ createAgentSession({ customTools: [...guardedTools, ...mcpTools, ...subAgentTools], tools: [...activeTools] })
  │
  └─ 子代理:runSubAgent()  (subAgent.ts,每次子代理调用都走)
        ├─ loadMcpServers(store)
        ├─ createMcpTools(mcp, mcpServers)   ← 共享 McpManager,缓存命中则不重复连接
        └─ createAgentSession({ customTools: tools, ... })

读取函数:loadMcpServers → readJson(mcpConfigPath(store)) → readFileSync(同步,每次调用都读盘,无缓存)
```

**关键机制(`McpManager`,mcpTools.ts):**
- 每 server 一个 entry `{ conn, tools, state }`;`listTools()` 幂等(缓存命中直接返回);断线自动重连一次并重试该次调用。
- 工具 execute 闭包捕获 `server` 配置对象(创建时的快照)与 manager;调用时 `manager.callTool(name, server, ...)`。

**SDK 侧固化证据**(`node_modules/.pnpm/@earendil-works+pi-coding-agent@0.83.0.../dist/core/agent-session.js`):
- 构造时 `this._customTools = config.customTools ?? []` → `_buildRuntime()` → `_refreshToolRegistry()` 构建 `_toolDefinitions` / `_toolRegistry`(工具注册表)。
- 公开 API 只有:`setActiveToolsByName()`(仅启停**已注册**工具,未知名称忽略)、`getAllTools()`、`reload()`(重载 extensions/settings,`_customTools` 数组不变)、extension runner 的 `refreshTools()`(仅 extension 注册的工具)。**没有公开的"运行时增删 customTools"API。**

---

## 4. 服务启动方式(dev 15200 端口的来龙去脉)

```
pnpm dev → turbo run dev(并行)
  ├─ apps/web:  cross-env NODE_ENV=development vite          → Vite dev server 端口 15200
  │                                                             (vite.config.ts: server.port = 15200,
  │                                                              proxy /api → http://localhost:3000)
  └─ apps/api:  cross-env NODE_ENV=development node --watch --import tsx/esm src/index.ts
                                                              → Hono 监听内部端口 3000(不对外)
                                                                (index.ts: PORT ?? (production ? 5200 : 3000))

生产:pnpm start → NODE_ENV=production node dist/index.js → 单端口 5200(Hono 托管 web/dist + API)
```

注意:
- **15200 是 Vite(前端)端口,不是 API 端口**;API 在 3000,经 Vite 代理。
- dev 脚本的 `node --watch` 是 Node 内置**源码文件**监听(改 src 代码自动重启 API 进程),与 `.workflows/mcp.json` 无关——mcp.json 是运行时 readFileSync 读取的,不在 import 图里,修改它**不会**触发进程重启。

---

## 5. 当前为何需要重启(根因分析)

**现状行为**(README / docs/mcp.md / McpPanel.vue 均明确):MCP 配置变更后需**新建会话或重开工作区**生效;删除/禁用会立即断开旧连接(disposeServer)。

### 根因:三层固化/快照

1. **工具注册表固化(主因)**:`openSession()` 只在会话创建时执行一次 `loadMcpServers` + `createMcpTools`,`ToolDefinition[]` 数组经 `createAgentSession({ customTools })` 在 AgentSession 构造时固化为 `_toolDefinitions` 注册表。**已打开会话的生命周期内,工具集不可变**(SDK 无增删 customTools 的公开 API)。

2. **配置快照绑定在闭包**:每个 MCP 工具的 `execute` 闭包捕获创建时的 `server` 配置对象。因此:
   - 修改 command/args → 旧会话工具仍用**旧配置**;调用时 manager 按旧 config 重新 spawn(disposeServer 已清缓存)。
   - 删除 server → 旧会话工具**仍然存在且可调用**(manager.ensureEntry 用旧 config 重连),删除语义对已打开会话失效。
   - 新增 server/工具、修改参数 schema → 旧会话**看不到**(注册表里没有,模型无从调用)。

3. **allowedToolNames 同步固化**:`tools` 白名单(activeTools)同样在会话创建时传入;即便注册表能变,白名单也需同步更新。

**为什么"重启/新建会话"能生效**:重启 = 重新 `openSession` = 重新读盘 + 重建注册表 + 重建白名单。
**子代理为何"半热"**:`runSubAgent` 每次调用都新建会话并重新 `loadMcpServers` + `createMcpTools`,所以子代理工具集每次调用都是最新的(共享 McpManager 连接缓存);**主代理会话是唯一冷点**。

**配置读取时机总结**:mcp.json 没有启动时一次性读取——它是**每次会话创建时**读取(openSession / runSubAgent 双点,同步 readFileSync,无进程级缓存)。"重启"只是间接的(重启会丢所有会话,重开时自然重建);实际上**新建会话/重开工作区即可生效,无需重启进程**。

---

## 6. 热更新机制现状

**全仓库无任何配置文件监听/热更新机制**:`fs.watch` / `chokidar` / `watchman` / `debounce` / `hot-reload` / `hmr` 在源码中零匹配。
仅有的"watch":① api dev 的 `node --watch`(源码变更重启进程);② Vite HMR(前端 UI 热更新)。两者都与 mcp.json 无关。
也没有轮询(re-read)机制——mcp.json 只在会话创建时读,会话存活期间不重读。

---

## 7. 测试/示例参考

| 文件 | 覆盖内容 |
| --- | --- |
| `apps/api/src/mcpConfig.test.ts` | 存储层:容错读取(缺失/损坏/非数组)、存取往返、校验零写入、原子写、upsert/remove |
| `apps/api/src/agent/mcpRoutes.test.ts` | 路由层:GET/PUT/DELETE/test、400 零写入、env 透传、404 |
| `apps/api/src/pi/mcpTools.test.ts` | 连接层:缓存与断线重连、status 与 dispose(disposeServer/disposeAll)、失败隔离、真实 stdio 链路 |
| `apps/web/src/components/McpPanel.test.ts` | 面板 UI:env 编辑、保存、校验 |
| `apps/web/src/composables/useAgent.test.ts` | agent store:refreshMcp / saveMcpServer 等 |
| `docs/mcp.md` | 完整设计文档(架构图、生命周期、ADR、风险) |
| 现成示例 | `.workflows/mcp.json` 已配置 context7 server(enabled=true),可作端到端验证 |

测试方式:根目录 `pnpm test`(turbo 并行 Vitest,依赖 build)。

---

## 8. 热更新切入点(可行性结论)

**结论:可行,且不需要"重启进程"。** 配置本身每次会话创建都重读,问题只在"已打开会话的工具注册表固化"。三个层次的切入点(由轻到重):

### 切入点 A(推荐,最小改动):配置变更后重建已打开会话的工具集
- 位置:`PiAgentService`(`piService.ts`)+ `agent/routes.ts` 的 PUT/DELETE 路由。
- 做法:PUT/DELETE 已调 `disposeMcpServer`;再新增 `refreshMcpForOpenSessions()`:遍历 `this.handles`,对**空闲**(`busy === false`)的 handle 执行现有 `reopenIfOpen()` 同款模式(dispose → 用同 sessionId 重新 `openSession`;消息从 JSONL 恢复,上下文不丢;handle 的 usage/run 内存字段需迁移或由 `resolveCurrentRun` 从磁盘恢复)。忙碌的会话等回合结束再刷。
- 效果:保存配置后已打开会话立即获得新工具集,前端 McpPanel 提示文案同步更新。
- 风险:重建期间工具注册表短暂为空;需处理 busy/流式中会话(排队);`activeEmitter` 等瞬时状态注意。

### 切入点 B(补充,解决"旧配置闭包"):McpManager 配置指纹化
- `callTool/listTools` 前比较传入 config 与最新 `loadMcpServers` 结果,指纹不一致(或 entry 已被 disposeServer 清除)时按新配置重连。
- 效果:修改 command/args 与删除 server 对旧会话立即生效(调用时用新配置/新工具名查不到则报"工具不存在")。
- 局限:新增工具、schema 变化仍依赖切入点 A(注册表/白名单固化)。

### 切入点 C(可选增强):mcp.json 文件监听兜底
- 仓库现无任何 watcher;可加 `fs.watch`(或 chokidar)`<root>/mcp.json` + debounce(~300ms)+ 内容指纹比对,覆盖"用户手工编辑 mcp.json"场景,触发与切入点 A 相同的刷新流程。PUT/DELETE 场景无需 watcher(路由内直接触发)。

### 不建议的路径
- 直接改 SDK(`pi-coding-agent`)——需 fork 或提 PR,`_customTools` 为私有字段,无公开 setCustomTools API;成本高。
- 用 `session.reload()`——它重载 extensions/settings,`_customTools` 数组不变,新增工具不会出现。
- 前端自动"新建会话"——会丢当前对话上下文,体验差。

### 实现注意(仓库既有约束)
- 只读工作区不注册 MCP 工具(重建时保持)。
- mcp.json 并发写由同步 I/O 天然串行;读取容错(损坏→[]),刷新时需容忍。
- 与 skills 语义一致(README):skills 也在会话创建时读入 system prompt——若一并做热更新,可复用同一刷新链路。
