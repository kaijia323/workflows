# 审查报告:MCP client 功能(run 09f3129e)

> 审查对象:`02-plan-2.md`(9 步骤 + 验收清单)vs `03-execution-1.md` 声称的改动。
> 方法:逐文件阅读实现(mcpConfig.ts / mcpTools.ts / piService.ts / subAgent.ts / routes.ts / index.ts / app.ts / useAgent.ts / McpPanel.vue / ApiKeyModal.vue / 三个新单测 + 子代理/前端单测追加 / README / docs/mcp.md / AGENTS.md)+ 交叉核对计划。无 shell 环境,typecheck/lint/test 结果以报告为准,基线失败用代码证据佐证。

## 结论:pass

9 个步骤全部落实;4 处核心偏差(富类型、全符号名跳过、集成测试底层 API、删除 config 字段断言测试)均合理且已如实申报;配置独立性与安全模型基本成立;测试覆盖真实核心逻辑。6 个非阻塞问题见问题清单。

---

## 一、逐条核对结果

| # | 计划项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 共享类型(`McpServerConfig`/`McpToolInfo`/`McpServerStatus`) | 通过 | `packages/shared/src/index.ts:80-104`,与计划一致(注释同步为 mcp.json 表述);`@modelcontextprotocol/sdk@^1.30.0` 入 `apps/api/package.json` + lockfile(锁 v1 线,1.30.0 真实安装) |
| 2 | 配置存储(独立 mcp.json) | 通过 | `mcpConfig.ts` 完整实现 load/save/upsert/remove + 校验 + tmp/rename 原子写(finally 清 tmp);`config.ts` 仅 `readJson/writeJson` 加 export(L73-81),`StoredConfig`/`WorkflowsStore` 零改动(`grep mcpServers` 零命中);`config.test.ts` 零改动(无任何 mcp 痕迹);27 个单测覆盖容错/往返/零写入/upsert/remove/原子写 |
| 3 | 工具工厂 + 连接管理 | 通过 | `mcpTools.ts`:McpConnection 抽象 + StdioMcpConnection(10s/10s/60s、stderr pipe + 环形缓冲 50 行)+ McpManager(缓存/断线重连一次/status/dispose)+ createMcpTools(`mcp__` 前缀、清洗、跳过、Type.Unsafe 透传、50KB 字节安全截断、中文脱敏、abort 唯一透传)+ testMcpServer;39 个单测 + 真实 stdio 集成(echo server 往返/未知工具 JSON-RPC 错误/连接超时注入) |
| 4 | 主代理注册 | 通过 | `piService.ts`:import `loadMcpServers`(../mcpConfig.js)、`private readonly mcp = new McpManager()`、openSession 中 webTools 后构建(只读 `[]`)、guardedTools 与 activeTools 只读/读写两分支均并入;`dispose()`(mcp.disposeAll + fff.disposeAll)、`getMcpStatus()`/`disposeMcpServer()`;runSubAgent 传 `mcp: this.mcp` |
| 5 | 子代理注册 | 通过 | `subAgent.ts`:`RunSubAgentOptions.mcp`、runSubAgent 内 loadMcpServers + 只读跳过 + createMcpTools(options.mcp) 后传入 buildSubAgentTools;`buildSubAgentTools` 新增 `mcpTools?: ToolDefinition[]`(缺省 [])且 tools 与 activeNames 同步列入;调用点仅 subAgent.ts:360 + 测试,无遗漏 |
| 6 | API 路由 | 通过 | `routes.ts` 独立区段 4 端点 `GET/PUT/DELETE /api/agent/mcp[/:name]` + `POST /:name/test`;统一 `{code,message,data}`;PUT 校验失败 400 中文零写入、DELETE 404、PUT/DELETE 后 disposeMcpServer 断旧连接;test 端点一次性连接(独立 StdioMcpConnection,不经 manager 缓存)+ 外层 15s 上限;`GET /api/agent/config` 响应不含 mcp 字段(getConfig 无此数据源);8 个路由单测 |
| 7 | 前端 UI | 通过 | `useAgent.ts`:mcp ref + 四 action(全部 `/api/agent/mcp*`,encodeURIComponent)+ init() 拉取(失败静默);`McpPanel.vue`(警告框/列表/开关/测试展开/删除/添加表单/「重开会话生效」提示)内嵌于 `ApiKeyModal.vue` ANYSEARCH 之后(L188);5 个前端单测 |
| 8 | 文档 | 通过 | README(功能条目/mcp.json 条目与格式示例/MCP 章节/安全模型/API 表 4 行)与 docs/mcp.md(架构/生命周期/存储设计/安全模型/ADR)与 AGENTS.md(补 mcpConfig.ts/mcpTools.ts/双点注册约定)均与实现一致;API 表沿用仓库 `/agent/...` 省前缀惯例 |
| 9 | 全量验证 | 基本通过 | typecheck/lint/build 报告全绿;255 passed / 10 failed 为基线(见下);API 级手工冒烟 7 项完成;冒烟 2-6 项(会话内可见性/子代理共享连接日志/只读排除/UI 操作)因缺 dev 环境 + key 如实申报未做,等价逻辑有单测覆盖 |

### 偏差核对(执行报告三节,含任务指定的 4 处)

1. **McpToolDescriptor 富类型**(`mcpTools.ts` `McpToolDescriptor extends McpToolInfo { inputSchema }`):合理。createMcpTools 需要 inputSchema 做 Type.Unsafe 转换,`McpConnection.listTools` 返回超集是必要设计;共享类型 McpToolInfo 保持计划原样,前端/状态面板不受影响。**接受**。
2. **全符号名跳过**(cleanName 去首尾 `_` → 空名跳过):合理。按计划字面 regex 全符号名清洗后确实非空,测试清单却要求跳过——实现选择了测试语义(跳过),`mcp__srv__foo_bar` 命名不变,语义更安全。**接受**。
3. **集成测试改用官方底层 `Server` + `ListToolsRequestSchema`/`CallToolRequestSchema`**:合理。zod 是 SDK peerDependency,`node -e` 子进程无法解析 `import 'zod'`,McpServer helper 依赖 zod schema;改用底层 API 仍是官方 SDK,已实测往返。**接受**。
4. **删除「GET /api/agent/config 无 mcp 字段」单测**:可接受。getConfig 需真实 ModelRuntime,fake 无法构造;改由 `grep -c mcpServers config.ts` = 0 + typecheck 双重保证(我已核实 config.ts 确无 mcpServers)。**接受**。
5. 其余 5 条(测试构造名、Type.Unsafe 抛错分支不可达、callTool 返回联合类型兼容、PUT 返回完整 overview、冒烟 PID 方法学)均为如实的技术适配说明,不影响目标语义。**接受**。

### 安全模型核对(计划 §4)

- **mcp.json 独立性**:`StoredConfig`/`WorkflowsStore` 零改动已核实;校验失败零写入与原子写有测试证明。✅
- **agent 不可写声明**:部分成立(见问题 2——工作区即仓库根时 `.workflows/` 位于工作区内,声明过度,与 config.json 相同的既有局限,非本次引入)。⚠️
- **spawn 不经 shell**:`StdioClientTransport({ command, args })` 直传 argv,无 shell 拼接。✅
- **只读工作区不注册**:主/子代理双点 `workspace.readOnly ? []` 一致。✅
- **tools 白名单同步**:主代理 activeTools 两分支、子代理 activeNames 均显式列入 mcp 工具名。✅
- **超时/资源/输出卫生**:10s/10s/60s、单 server 失败隔离、disposeAll、50KB 截断、错误脱敏(不回显 args)、abort 唯一透传。✅

### 验证可信度

- **10 个基线失败**:有代码证据佐证。`workspaceGuard.test.ts:24` 模块级 `const WS = path.resolve('C:\\Users\\kaijia\\...')`,Linux 下相对解析后落在 `<cwd>/C:\Users\...`,多条「应拦截」断言(如 L144 `cat C:\\Users\\kaijia\\secret.txt` 期望越界)必然失败——与报告 8 个 workspaceGuard 失败吻合;runManager/agentDefs 各 1 个无法定位具体断言,但两文件本次零改动、无 mcp 痕迹,「基线」声明不矛盾。无法运行 `git stash` 独立复验(无 shell),此项保留 5% 不确定性。
- **测试质量**:非空壳。注入式 fake + 真实 stdio 子进程往返 + 字节安全截断(中文无乱码断言)+ 断线重连计数(connect/callTool/close 恰一次)+ 单 server 隔离(status 断言)——均直接命中核心逻辑。
- **已知未覆盖**:冒烟 2-6 项(前端面板手工操作、子代理共享连接的行为日志、只读工作区端到端)未执行,建议具备 dev 环境后补一轮。

---

## 二、问题清单(均非阻塞;按严重度排序)

1. **🟡 `apps/api/src/agent/routes.ts:99-101` — 路由层类型收窄绕过存储层校验**
   PUT 处理器把非数组 `args`(如 `"foo"`)静默归一为 `undefined`、非布尔 `enabled`(如 `"yes"`)静默归一为 `undefined`,而不是 400。存储层 `validateMcpServers`(`mcpConfig.ts`)明明有这两项检查,却被路由的前置归一化屏蔽(测试只覆盖了「数组内含非字符串」→ 400,未覆盖「args 非数组」)。修复建议:路由透传原始值(`args: raw?.args`、`enabled: raw?.enabled`),让校验层统一拒绝;或在路由层显式校验后 400。单用户 UI 场景影响低,但「校验失败零写入」的承诺因此不完整。

2. **🟡 README「安全模型」/ docs/mcp.md §6.1 / 计划 §4 —「agent 无任何工具可写 mcp.json」声明过度**
   该声明仅在「工作区不包含 `.workflows/`」时成立。dev 模式下 `.workflows` 位于仓库根,若用户把 workflows 仓库本身添加为工作区,`.workflows/mcp.json` 就在工作区内,bash/write/edit 均可写(workspaceGuard 只拦工作区外)。这与 config.json 是同一既有局限(workspaceGuard.ts 头注自述「护栏定位,非安全边界」+ 单用户信任模型),非本次引入,但新文档把此条件声明写成了绝对命题。建议:README/docs/mcp.md 措辞限定为「当工作区不含 .workflows 时」,或补一句信任模型说明(agent 与 OS 用户同权限,该护栏防误操作而非防恶意)。

3. **🟢 `apps/api/src/pi/piService.ts` openSession — enabled server 串行连接**
   多个宕机 server 最坏叠加 N×10s 拖慢会话打开(计划风险表已承认,但未缓解)。建议 `Promise.allSettled` 并行构建各 server 工具,保持单 server 失败隔离语义。

4. **🟢 `apps/api/src/pi/mcpTools.ts` `ensureEntry` — 初始 state='connected'**
   连接建立前 status() 会短暂把未连接 server 报为 connected(窗口极小,实际仅 listTools/callTool 中途可观察)。建议初始 `state: 'error'` 或新增 `connecting` 态(共享类型 `McpServerStatus.state` 需同步)。

5. **🟢 `apps/api/src/index.ts:19-23` — SIGINT/SIGTERM 无兜底超时**
   `pi.dispose()` 若因某 MCP 子进程不响应关闭而挂起,进程将不退出。建议 `Promise.race` 加 5s 超时后强制 `process.exit(0)`。

6. **🟢 冒烟 2-6 项未执行(已如实申报)**
   「会话内工具可见性、子代理共享连接、只读工作区排除、UI 面板操作」建议在具备 dev 环境 + API key 后补一轮,重点验证 `mcp__` 工具在聊天中的 tool_start/tool_end 渲染与子代理 sub_tool_* 事件。

---

## 三、亮点(供保留)

- 字节安全截断(二分 + 代理对回退)、abort 唯一透传、错误文案中文脱敏——纪律与 anySearchTools 完全对齐;
- 断线重连「恰一次」+ 失败后状态落 error,测试用 vi.fn 精确断言调用次数;
- `config.ts` 只动两个 export 关键字,`StoredConfig`/`WorkflowsStore`/`config.test.ts` 零改动,独立性可验证;
- `buildSubAgentTools` 缺省 `mcpTools: []` 保持既有调用方与测试零破坏,双点注册纪律写入 AGENTS.md;
- 文档(README/docs/mcp.md/AGENTS.md)与实现逐项一致,含回滚路径(删除 mcp.json 即恢复)。

## 四、最终建议

**通过(Pass)**。核心功能、安全模型、生命周期管理与测试均达到计划验收标准;6 个问题均为非阻塞改进项,建议下一轮(或后续迭代)按问题清单 1-2 优先处理(路由校验收严 + 文档措辞限定),3-6 可选。

> 备注:本审查无 shell 环境,未能独立重跑 typecheck/lint/test 与 git stash 对照;若需绝对确认,可在有 shell 的环境执行 `pnpm typecheck && pnpm lint && pnpm test` 复核(预期:全绿 + 10 个基线失败)。
