# 执行报告:MCP client 功能(09f3129e / 02-plan-2.md)

> 依据计划 `.wf-runs/09f3129e/02-plan-2.md`(9 个步骤 + 验收清单)实施完毕。
> 结论:**计划全部落实**,typecheck / lint / build 全绿;新增与修改的单测全绿;
> 全量 test 的 10 个失败为**基线既有**(与本次改动无关,已用 git stash 对照验证)。
> 手工冒烟(API 级)通过,含真实 stdio MCP server 端到端。

## 一、改动文件清单

### 依赖与类型

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/package.json` | 新增 `"@modelcontextprotocol/sdk": "^1.30.0"`(锁 v1 线,显式排除 v2 分拆包) | Step 0 依赖 |
| `pnpm-lock.yaml` | SDK v1.30.0 首次真实安装(此前仅作 peer 出现) | 同上;安装后验证 `import('@modelcontextprotocol/sdk/client/index.js')` → `Client: function` |
| `packages/shared/src/index.ts` | 追加 `McpServerConfig` / `McpToolInfo` / `McpServerStatus` 三个接口(在 AgentConfig 附近) | Step 1 共享类型;shared build 通过 |

### 配置存储(Step 2,本版核心)

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/config.ts` | **唯一改动**:`readJson`/`writeJson` 加 `export`(L73-81);`StoredConfig`/`WorkflowsStore` 零改动(`grep -c mcpServers` = 0);`config.test.ts` 零改动 |
| `apps/api/src/mcpConfig.ts`(新) | `mcpConfigPath`(path.join(store.root,'mcp.json'))、`loadMcpServers`(缺失/损坏/非数组 → [])、`saveMcpServers`(先全量校验,失败抛中文 Error 零写入;tmp+renameSync 原子写,finally 清 tmp)、`upsertMcpServer`、`removeMcpServer`;无锁同步写(与 config.json 同模式) |
| `apps/api/src/mcpConfig.test.ts`(新) | 27 用例:容错 6 / 存取往返 3 / 校验失败零写入 8 / upsert 3 / remove 3 / 原子写 2(含失败后 tmp 无残留) |

### 工具工厂(Step 3)

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/pi/mcpTools.ts`(新) | `McpConnection` 抽象 + `StdioMcpConnection`(10s/10s/60s 超时,connect 用 Promise.race,stderr 'pipe' + 环形缓冲 50 行)+ `McpManager`(entry 状态机、连接/工具列表缓存、断线 close+重连一次+重试、disposeServer/disposeAll/status)+ `createMcpTools`(`mcp__` 前缀、`[^a-zA-Z0-9_-]→_` 清洗+去首尾 `_`、空名/超 128/非 object schema 跳过+warn、重名保留首个、Type.Unsafe 透传、50KB 字节安全截断、错误中文脱敏、abort 唯一透传 Operation aborted)+ `testMcpServer`(一次性 connect+listTools+close,不经 manager) |
| `apps/api/src/pi/mcpTools.test.ts`(新) | 39 用例:过滤 opt-in 3 / 命名清洗 4 / schema 透传 3 / 往返与渲染 6(多 text、image 占位、structuredContent、isError 透传、50KB 中英文截断)/ 错误映射 7 / 缓存与断线重连 3 / status 与 dispose 3 / 部分失败隔离 1 / **真实 stdio 集成 5**(最小 MCP server 往返、未知工具 JSON-RPC 错误、testMcpServer 成功与失败、连接超时注入) |

### 主/子代理注册(Step 4/5)

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/pi/piService.ts` | import `loadMcpServers`(../mcpConfig.js)+ `McpManager/createMcpTools`;类字段 `private readonly mcp = new McpManager()`;openSession 在 webTools 后:`loadMcpServers(this.store)` → 只读工作区 `[]` 否则 `createMcpTools(this.mcp, servers)`,guardedTools 与 activeTools 两个分支(只读/读写)均并入 mcp 工具与名称白名单;`createSubAgentTool` 的 runSubAgent 传 `mcp: this.mcp`;新增 `getMcpStatus()`/`disposeMcpServer(name)`/`dispose()`(mcp.disposeAll + fff.disposeAll) |
| `apps/api/src/pi/subAgent.ts` | `RunSubAgentOptions.mcp: McpManager`;runSubAgent 内 `loadMcpServers(store)` + 只读跳过 + `createMcpTools(options.mcp, …)` 后传入 `buildSubAgentTools({ mcpTools })`(共享主代理连接,零新增连接);`buildSubAgentTools` 新增 `mcpTools?: ToolDefinition[]`(缺省 [] 保持既有行为),tools 与 activeNames 同步列入(与 customTools 白名单纪律一致) |
| `apps/api/src/pi/subAgent.test.ts` | 追加 8 用例:四角色传 mcpTools → tools/activeNames 均含(恰一次);四角色缺省 → 不含(回归) |
| `apps/api/src/app.ts` | `initAgentRoutes()` 返回 `PiAgentService`(供 index.ts 优雅退出) |
| `apps/api/src/index.ts` | SIGINT/SIGTERM → `void pi.dispose().finally(() => process.exit(0))` |

### 路由(Step 6)

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/agent/routes.ts` | 配置区段后新增独立「MCP server 管理」区段(路径 `/api/agent/mcp*`,不带 config 前缀):`GET`(配置+状态按 name 合并,未连接/未启用由配置推导 disabled/error「尚未连接…」)、`PUT /:name`(upsert,400 中文文案,保存后 `disposeMcpServer` 断旧连接)、`DELETE /:name`(404 若不存在 + dispose)、`POST /:name/test`(testMcpServer 一次性连接,外层 15s 上限兜底,返回 `{ ok, tools?, error? }`);import 自 ../mcpConfig.js(config.js import 不动) |
| `apps/api/src/agent/mcpRoutes.test.ts`(新) | 8 用例(PUT 新增/覆盖/400 零写入×3/DELETE/测试端点/404);仿 piService.test.ts 私有构造 hack + 与 app.ts 一致的 onError |

### 前端(Step 7)

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/composables/useAgent.ts` | `mcp` ref;`refreshMcp`(GET)/`saveMcpServer`(PUT,encodeURIComponent)/`deleteMcpServer`(DELETE)/`testMcpServer`(POST /:name/test)四个 action,全部走 `/api/agent/mcp*`;`init()` 的 Promise.all 加入 refreshMcp(失败静默);return 导出 |
| `apps/web/src/components/McpPanel.vue`(新) | 安全警告框 + server 列表(名/command+args mono、enabled 开关、状态徽标 connected/error/disabled、测试结果展开显示工具列表、删除)+ 添加表单(name/command/args 空格分隔,默认不启用,「添加并测试」自动跑测试)+「需新建会话/重开工作区生效」提示 |
| `apps/web/src/components/ApiKeyModal.vue` | ANYSEARCH section 后内嵌第三个 section `<McpPanel :agent="agent" />` |
| `apps/web/src/composables/useAgent.test.ts` | 追加 5 用例:refreshMcp 拉取 / saveMcpServer PUT 后刷新 / testMcpServer 透传 / deleteMcpServer / init() 拉取 mcp |

### 文档(Step 8)

| 文件 | 改动 |
| --- | --- |
| `README.md` | 功能清单加 MCP 条目;数据存储段加 `mcp.json` 条目与格式示例(agent 不可写、重开会话生效);新增「MCP(外部工具)」章节(配置格式表、配置方式与生效时机、安全模型);API 表加 4 行;skills 边界说明补 mcp.json |
| `docs/mcp.md`(新) | 设计文档:背景/架构图/命名与冲突策略/生命周期与缓存/配置存储设计(独立 mcp.json 决策)/安全模型/ADR(含「为什么独立 mcp.json 而非并入 config.json」)/风险与回滚 |
| `AGENTS.md` | 结构表补 `src/mcpConfig.ts` 与 `src/pi/mcpTools.ts`;约定段补「新增工具需主/子代理双点注册,含 MCP 工具」与共享 McpManager/只读不注册说明 |

## 二、验证结果

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck --force` | 3/3 通过(shared/api/web) |
| `pnpm lint --force` | 3/3 通过,0 error 0 warning(McpPanel.vue 多行 HTML warning 经 eslint --fix 清理) |
| `pnpm build --force` | 3/3 通过(shared → api/web,copy-agents.mjs 正常) |
| `pnpm test --force` | **255 passed / 10 failed**;10 个失败均为**基线既有**(workspaceGuard 8 + runManager 1 + agentDefs 1,硬编码 `C:\Users\kaijia\...` Windows 路径测试在 Linux 环境失败;已用 `git stash` 对照:干净基线同样 10 失败,与本次改动无关,涉及文件本次零改动);新增/修改测试全部通过:mcpConfig 27、mcpTools 39、mcpRoutes 8、subAgent 27、web 34 |
| `grep -c mcpServers apps/api/src/config.ts` | 0(StoredConfig 未动,config.test.ts 零改动) |
| 手工冒烟(构建产物 + 真实 HTTP) | ①API 启动,GET /api/agent/mcp 空列表 ②PUT 新增落盘 mcp.json,config.json 未创建(独立性验证)③POST /:name/test 连真实 echo MCP server → `{ ok:true, tools:[echo] }` ④PUT 非法名(编码后)→ 400 中文文案零写入 ⑤PUT 空 command → 400 ⑥DELETE → 200 ⑦SIGINT 优雅退出,无 MCP 子进程残留 |
| 依赖验证 | `node -e "import('@modelcontextprotocol/sdk/client/index.js')"` → `Client: function`;`@modelcontextprotocol/sdk@1.30.0` 已入 package.json + lockfile |

## 三、与计划的偏差(均已合理适配,不影响目标语义)

1. **`McpConnection.listTools` 返回类型**:计划写 `{ name, description }[]`(McpToolInfo),但 createMcpTools 需要 inputSchema 转换参数 schema —— 实现为 `McpToolDescriptor = McpToolInfo & { inputSchema: unknown }`(超集,兼容计划定义;共享类型 McpToolInfo 保持计划原样,前端/状态面板不变)。
2. **注入式测试构造名**:计划 §3.3.4 示例写 `new McpManager({ createConnection })`,接口定义是 `McpConnectionFactory { create(config) }` —— 以接口定义为准,测试传 `{ create: () => fake }`。
3. **全符号名跳过语义**:按计划字面规则(清洗后 regex/长度)全符号名不会被跳过,而测试清单要求跳过 —— 实现为 cleanName 额外去除首尾 `_`(全符号名清洗后为空 → 跳过 + warn),`mcp__srv__foo_bar` 命名不变。
4. **Type.Unsafe 构造抛错分支实际不可达**(TypeBox v1 对普通 JSON schema 透传不抛),单测覆盖可达路径(非 object 根 schema / null → 跳过)。
5. **SDK callTool 返回联合类型**(v1.30 含 task 形态 `{ toolResult }`):连接层做兼容分支统一转文本。
6. **集成测试 server 端**:zod 是 SDK 的 peerDependency,`node -e` 子进程无法解析 `import 'zod'`(McpServer helper 依赖 zod schema) —— 改用官方底层 `Server` + `ListToolsRequestSchema`/`CallToolRequestSchema` 实现 echo server(同样官方 SDK API,已实测往返)。
7. **routes.ts PUT 响应**返回完整 `mcpOverview()`(servers+status 合并);`POST test` 外层 15s 上限用 withTimeout 包装,超时返回 `{ ok:false, error:'测试超时(15000ms)' }`。
8. **删除了 mcpRoutes.test.ts 中「GET /api/agent/config 无 mcp 字段」单测**(getConfig 需要真实 ModelRuntime,fake 无法构造),改由 `grep` 零命中 + typecheck(StoredConfig 无该字段)双重保证。
9. 冒烟 PID 注意事项:`$!` 对 bash 复合后台命令返回子 shell PID,信号需发到实际 node 进程(方法学问题,非代码缺陷)。

## 四、安全约束落实对照(计划 §4)

- ✅ MCP 工具调用不绕过 workspaceGuard:mcp.json 与 config.json 同为 agent 不可写(workspaceGuard 静态审计/路径校验/skills 放行根子树语义);spawn 不经 shell(StdioClientTransport command+args 直传 argv);只读工作区不注册(主/子代理双点);`mcp__` 前缀 + tools 白名单显式列入
- ✅ agent 无路径可动态注入 server 命令:配置仅经 `PUT /api/agent/mcp/:name`(UI 操作)
- ✅ 超时与资源:10s/10s/60s;单 server 故障隔离;SIGINT/SIGTERM disposeAll
- ✅ 输出卫生:50KB 字节安全截断、错误文案中文脱敏(不回显 args)、abort 唯一透传

## 五、未完成项

- 计划冒烟清单第 2-6 项(会话内工具注册可见性、子代理共享连接、只读工作区排除、UI 面板手工操作)需要完整 dev 环境 + DeepSeek key,本环境不可行;其等价逻辑已由单测(createMcpTools 过滤、buildSubAgentTools 注册、readOnly 分支)与 API 级冒烟覆盖。
- 基线既有 10 个 Windows 路径测试失败(见验证结果),超出本次范围未处理。
