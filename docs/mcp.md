# MCP 外部工具设计文档(MCP client,stdio 传输)

> 状态:已实现(v1 = MCP client,stdio 传输;MCP server 端不在 v1 范围)
> 关联:README「MCP(外部工具)」、`apps/api/src/pi/mcpTools.ts`、`apps/api/src/mcpConfig.ts`

## 1. 背景与目标

为工作台新增 **MCP client** 能力:用户通过配置页添加外部 MCP server(stdio 启动命令 + 参数),
应用在会话创建时连接该 server、拉取 `tools/list`,把每个工具包装成 pi SDK 的 `ToolDefinition`
(仿 `createAnySearchTools` 工厂模式),注册进**主代理**与**子代理**会话,agent 即可调用外部工具。

v1 范围:

- 传输:仅 **stdio**(`StdioClientTransport`);HTTP/SSE/Streamable HTTP 不在 v1
- 能力:仅 `tools/list` + `tools/call`;prompts / resources 不在 v1(pi SDK ResourceLoader 无 MCP 桥接点)
- 配置面:最小四字段 `name / command / args / enabled`;无每工具级 enable、无 `env`/`cwd`/`timeoutMs` 字段
- **不把 mcpServers 并入 config.json**:配置划分更清晰(见 §5 决策记录)

## 2. 架构

```
mcp.json ──loadMcpServers──▶ routes.ts(/api/agent/mcp*) ──PUT/DELETE──▶ disposeMcpServer
   │                                                                       │
   │ loadMcpServers                                                        │
   ▼                                                                       ▼
piService.openSession / subAgent.runSubAgent ──▶ createMcpTools(manager, servers)
                                                        │
                                                        ▼
                                                 McpManager(单例,主/子代理共享)
                                                        │
                                                        ▼
                                          StdioMcpConnection ──spawn(不经 shell)──▶ MCP server 子进程
                                                        │
                                                        └── 10s connect / 10s list / 60s call
```

- **配置**:独立 `mcp.json`(`{ "mcpServers": [...] }`),与 config.json 同目录,`workflowsRoot()`/`store.root` 定位
- **存储**:`apps/api/src/mcpConfig.ts`(load/save/upsert/remove + 校验 + 原子写),复用 config.ts 的 `readJson`/`writeJson`
- **连接**:`McpManager` 为 `PiAgentService` 单例字段;连接 + tools 列表按 server 缓存,**主/子代理共享同一连接**
  (子代理每次调用新建会话,但工具 execute 闭包只引用 manager,无会话状态,零额外连接成本)
- **注册**:主代理 `openSession()` 与子代理 `buildSubAgentTools()` **双点同步注册**(回归高发点,见 AGENTS.md 约定)

## 3. 工具命名与冲突策略

- 统一前缀 `mcp__<server>__<tool>`,如 `mcp__github__create_issue`
- `mcp__` 前缀与内置工具(`read/bash/edit/write/grep/find/ls`)、仓库工具(`fff-find/fff-grep/anysearch-search`)、
  编排工具(`wait_for_approval/complete_task`、子代理名)零冲突
- server 名由配置校验保证唯一 → 跨 server 无冲突
- 清洗:`[^a-zA-Z0-9_-]` → `_`、压缩连续 `_`、去首尾 `_`(全符号名清洗后为空 → 跳过);
  最终名必须匹配 `/^[a-zA-Z0-9_-]+$/` 且 ≤ 128 字符,否则**跳过该工具**(console.warn)
- 同一 server 内清洗后重名 → **保留首个**
- 参数 schema:MCP `inputSchema`(JSON Schema)用 TypeBox `Type.Unsafe<T>()` **透传包装**(不逐字段翻译);
  非 object 根 schema / 转换异常 → 跳过该工具(warn),避免带病工具污染会话创建

## 4. 生命周期与缓存

- `McpManager` 每 server 一个 entry:`{ conn, tools, state: connected|error, error?, lastCheckedAt }`
- `listTools(name, config)`:幂等(缓存命中直接返回);连接已断 → 重连;失败记录 error 状态并抛错(单 server 隔离)
- `callTool(...)`:ensure 连接 → callTool;**连接断开错误时 close + 重连一次 + 重试该次调用**
- 超时:connect 10s(Promise.race)/ list 10s / call 60s(SDK RequestOptions.timeout);abort 唯一透传 `Operation aborted`
- stderr:`'pipe'` 挂 drain 监听,环形缓冲最近 50 行(状态面板诊断;不 drain 会背压阻塞子进程)
- `disposeServer(name)`:配置变更(PUT/DELETE)时断开旧连接 + 清缓存 —— **旧会话工具集不变,新会话生效**
- `disposeAll()`:进程退出(SIGINT/SIGTERM)时关闭全部 MCP 子进程,防僵尸进程
- **生效时机**:与 skills 语义一致 —— MCP 配置变更后需**新建会话/重开工作区**生效

## 5. 配置存储设计(独立 mcp.json)

**决策:独立 `mcp.json`,不并入 config.json**(用户明确要求,划分更清晰)。

| 维度 | 方案 |
| --- | --- |
| 文件 | `mcp.json`,`{ "mcpServers": [...] }`;与 config.json 同目录(dev `<repo>/.workflows`,prod `~/.workflows`) |
| 定位 | `mcpConfigPath(store) = path.join(store.root, 'mcp.json')`;`WorkflowsStore` 接口零改动 |
| 复用 | config.ts 的 `readJson`/`writeJson`(该两函数加 `export`,config.ts 唯一改动);`StoredConfig` 零改动 |
| 读取容错 | 文件缺失 / JSON 损坏 / mcpServers 缺失或非数组 → `[]`(不阻塞会话打开);读取不做逐项校验 |
| 写校验 | `saveMcpServers` 先全量校验(名 / 重名 / command / args / enabled),**任一失败抛错(中文)零写入** |
| 原子写 | 先写 `<file>.tmp` 再 `renameSync` 原子替换(同目录 rename 原子,写入中断不留半截文件) |
| 并发写 | 与 config.json 同模式:**无 mutex/lock** —— 同步 `writeFileSync`/`renameSync`,Node 单线程事件循环下天然串行 |
| enabled 缺省 | 存储层保留原值不补写(文件最小 diff);opt-in(`enabled !== true` 不注册)在消费端 `createMcpTools` 实现 |

## 6. 安全模型

1. **命令只从 mcp.json 读取**:agent 无任何工具可写 `.workflows/mcp.json` —— 与 config.json 同为
   **agent 不可写配置文件,由 workspaceGuard 保证**:bash 静态审计限工作区内、write/edit 路径校验拦截工作区外路径、
   skills 只读放行根为子树语义(仅 skills 根之下,兄弟路径 mcp.json/config.json 仍拦截)。
   **该保证仅在「工作区不包含 `.workflows` 目录」时成立**:dev 下 `.workflows` 位于仓库根,
   若把仓库本身添加为工作区,`.workflows/mcp.json` 即在工作区内,bash/write/edit 均可写
   (与 config.json 同一既有局限,非本次引入)。
   **信任模型**:agent 与 OS 用户同权限,workspaceGuard 是防误操作护栏而非安全边界(防误操作,不防恶意)
2. **spawn 不经 shell**:`StdioClientTransport({ command, args })` 直接 spawn,args 作为 argv 传递,无 shell 注入面
3. **只读工作区不注册 MCP 工具**:只读语义 = 只读;MCP 工具可能产生工作区外副作用,一律不注册
   (主代理 `openSession` 与子代理 `runSubAgent` 双点一致)
4. **信任模型**:MCP server = 用户显式配置的可信插件,与 OS 用户同权限;UI + README 显著风险提示;
   工具输出视为**不可信内容**(提示注入面,与 anysearch 结果同级对待);50KB 截断;错误文案脱敏(不回显 args)
5. **超时与资源**:connect 10s / list 10s / call 60s,调用级 abort 透传;单 server 故障隔离(不阻塞会话);
   进程退出 `disposeAll()` 关闭子进程

## 7. 决策记录(ADR)

| 决策 | 理由 |
| --- | --- |
| 为什么 v1 不做 MCP server 端 | 需桥接 AgentSession/tool 事件为 JSON-RPC + 鉴权,成本高,仓库无此规划 |
| 为什么 v1 只做 stdio 传输 | 本地工具场景 stdio 足够;`McpConnection` 抽象层预留扩展点,后续加 HTTP 传输只需新增一个实现 |
| 为什么不用 v2 分拆包 | 官方 v2(`@modelcontextprotocol/client`/`@modelcontextprotocol/server`)为新线;v1(`@modelcontextprotocol/sdk`)稳定、生态最广,锁 `^1.30.0` |
| 为什么 readOnly 不注册 | 只读工作区语义 = 只读;MCP 工具可能产生工作区外副作用;预留每-server `readOnly` 标志作为扩展点 |
| **为什么独立 mcp.json 而非并入 config.json** | 用户明确要求:配置划分更清晰。config.json 语义 = 运行/密钥类配置,mcp.json 语义 = 外部工具插件配置;两文件独立读写互不影响;回滚只需删除 mcp.json(config.json 全程未动) |
| 为什么 Type.Unsafe 透传而非逐字段翻译 | MCP inputSchema 是 JSON Schema,与 TypeBox 结构同构但方言差异大;逐字段翻译脆弱易漏,透传 + 单工具跳过兜底更稳 |
| 为什么连接失败不阻塞会话打开 | 单 server 故障不应拖垮聊天;connect 10s 超时 + 状态面板可见异常 |

## 8. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| JSON Schema → TypeBox 转换不兼容 | Type.Unsafe 透传 + 单工具 try/catch 跳过 + warn |
| 连接泄漏/僵尸子进程 | 配置变更即 disposeServer;进程退出 dispose();集成测试覆盖 close |
| server 宕机拖慢会话打开 | connect 10s 超时 + 单 server 失败隔离 |
| 并发调用同一 server | MCP JSON-RPC 支持并发 request,SDK Client 线程安全;若实测异常可用 `executionMode: 'sequential'` 兜底(一行改动) |
| mcp.json 写入中断 | tmp + rename 原子写;读取容错(损坏 → 空列表) |
| 回滚 | 删除 `.workflows/mcp.json` 即恢复原状(读取容错:不存在 → 空列表);config.json 全程未改 |
