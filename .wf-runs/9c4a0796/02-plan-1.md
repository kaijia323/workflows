# 实施计划:MCP 配置保存后热更新(保存即生效,无需重启/新建会话)

> 前置:调研报告 `.wf-runs/9c4a0796/01-exploration-1.md`(结论:配置每次会话创建时读盘,根因是已打开会话的工具注册表固化;子代理每次调用重建,天然半热;主代理会话是唯一冷点)
> 本文档为只读调研与规划产物,不含任何代码改动。实施顺序:阶段 1 → 2 → 4;阶段 3 本期不做(仅评估留档)。

---

## 1. 目标与范围

### 做什么

用户在设置面板(PUT/DELETE `/api/agent/mcp/:name`)新增/修改/删除 MCP server 配置并保存后:

1. **已打开的主代理会话保存即生效**(方案 A,必须):配置变更后对已打开的会话执行「同 sessionId 重建」(dispose + 重开,JSONL 恢复上下文),工具注册表与白名单按最新配置重建;忙碌会话不打断,挂起重建,下一回合开始前生效。
2. **旧配置闭包不再生效**(方案 B,必须,与 A 同批):McpManager 按配置指纹校验连接缓存,工具 execute 改为调用时解析最新配置——修改 command/args 后未重建的会话立即用新配置;删除/禁用 server 后旧会话工具失效(不再用旧配置复活)。
3. **前端文案与文档同步**(阶段 4,必须,轻量):McpPanel 提示由「需新建会话/重开工作区」改为「保存即生效」;docs/mcp.md 生效时机小节更新。
4. 子代理:**仅验证,不处理**。`runSubAgent` 每次调用都新建会话并重新 `loadMcpServers` + `createMcpTools`,天然生效;阶段 2 接入 live resolver 后其行为与主代理一致。

### 不做什么(明确排除)

- 不改 SDK(`@earendil-works/pi-coding-agent`):`_customTools` 为私有字段、无公开增删 API,直接改 SDK 成本高且不可维护。
- **不做 fs.watch(mcp.json 手工编辑场景,方案 C)**:评估结论见 §5,本期不纳入。
- 不做 skills 热更新(skills 在会话创建时读入 system prompt,语义与 MCP 不同,维持「新会话生效」现状)。
- 不做任何配置存储结构变更(mcp.json 格式、校验、原子写全部不动)。
- 不改 PUT/DELETE 路由的响应结构(前端 useAgent 零改动)。

---

## 2. 现状关键事实(已逐一验证,计划可行性依据)

| # | 事实 | 影响 |
| --- | --- | --- |
| 1 | `reopenIfOpen()`(piService.ts)已是「dispose + delete handle + 同 active sessionId 重开,JSONL 恢复」的现成模式,生产在用(readOnly 切换) | 方案 A 直接复用该模式,风险低 |
| 2 | `openSession(workspace, sessionId)` 中 `existing.sessionId === targetId` 时直接复用 → 重建必须**先 dispose + 从 handles 删除**,再调用 openSession | rebuildHandle 需显式做这两步 |
| 3 | `sessionFileFor()` 在会话文件缺失时返回 undefined → openSession 自动降级为 `SessionManager.create`(新建会话);`SessionManager.open` 对缺失文件不抛错 | 「JSONL 恢复失败降级」有现成路径,不丢旧文件 |
| 4 | `openSession` 创建新 handle 时 `usage` 归零、`run` 由 `resolveCurrentRun` 从磁盘恢复 | rebuildHandle 必须迁移 usage/lastActivityAt;run 无需处理 |
| 5 | `prompt()` 入口:`openSession` → `busy` 检查 → 置 busy → 回合;finally 中置 busy=false | 「忙碌会话挂起重建」的消费点 = prompt() 入口(先查 busy 再重建,避免打断运行中回合) |
| 6 | `McpEntry = { conn, tools, state, error?, lastCheckedAt }`,无 config 记录;`ensureConn(entry, config)` 只在 conn 为空时创建 | 方案 B 需给 entry 加 fingerprint,校验放 `ensureConn` + `listTools` 缓存判断 |
| 7 | 工具 execute 闭包捕获 `server` 快照(创建时),调用时 `manager.callTool(server.name, server, ...)` | 方案 B 需改为捕获 `resolveServer` 函数(调用时解析),`createMcpTools` 签名向后兼容扩展 |
| 8 | 测试基建:`PiAgentService` 私有构造 hack(mcpRoutes.test.ts / piService.test.ts 同款);`McpManager` 注入式 fake connection factory(mcpTools.test.ts 同款);`getAgentDefinitions` 走 BUILTIN_AGENTS_DIR(src/pi/agents 随代码存在) | 阶段 1 测试用 spy 方案(Tier 1);阶段 2 测试用 fake factory 方案 |
| 9 | `fff.get()` 懒创建原生 FileFinder(spawn 进程) | 单测不跑完整 openSession(避免 spawn),用 spy;完整链路走手动 E2E |
| 10 | `loadMcpServers` 每次 readFileSync 读盘、无缓存;mcp.json 原子写(tmp+rename) | B 的「每次调用解析一次配置」成本可忽略;与既有读取语义一致 |

---

## 3. 分阶段实施计划

### 阶段 1(必须):方案 A — 配置变更后重建已打开会话

**目标**:PUT/DELETE 保存配置后,空闲会话立即重建;忙碌会话挂起,下一回合生效。上下文(JSONL)不丢、usage 不清零。

#### 改动 1.1 `apps/api/src/pi/piService.ts`

1. `SessionHandle` 接口新增字段(带注释):
   ```ts
   /** MCP 配置变更时忙碌会话的挂起重建标记(下回合 prompt 入口消费) */
   mcpRebuildPending?: boolean
   ```
2. 新增私有方法 `rebuildHandle(handle: SessionHandle): Promise<SessionHandle>`(放在 `reopenIfOpen` 附近):
   ```ts
   /**
    * MCP 配置变更后重建已打开会话:dispose + 同 sessionId 重开(JSONL 恢复上下文)。
    * usage/lastActivityAt 从旧 handle 迁移;run 由 openSession 内部 resolveCurrentRun 从磁盘恢复。
    * 失败降级:回退 openSession(workspace) 新建会话(旧 JSONL 原样保留,会话列表可切回)。
    */
   private async rebuildHandle(handle: SessionHandle): Promise<SessionHandle> {
     const { workspace, sessionId, usage, lastActivityAt } = handle
     handle.session.dispose()
     this.handles.delete(workspace.id)
     try {
       const fresh = await this.openSession(workspace, sessionId)
       fresh.usage = usage
       fresh.lastActivityAt = lastActivityAt
       return fresh
     } catch (error) {
       console.error(`[mcp] 会话重建失败(workspace=${workspace.id}),已回退新建会话:`, error)
       return this.openSession(workspace)  // 最终降级:全新会话;旧 JSONL 未删
     }
   }
   ```
3. 新增公开方法 `refreshMcpForOpenSessions(): Promise<void>`(供路由调用):
   ```ts
   /** MCP 配置变更后刷新所有已打开会话:空闲立即重建,忙碌挂起(下回合生效)。单工作区失败隔离。 */
   async refreshMcpForOpenSessions(): Promise<void> {
     await Promise.all(
       [...this.handles.values()].map(async (h) => {
         if (h.workspace.readOnly) return          // 只读工作区不注册 MCP 工具,无需重建
         if (h.busy) { h.mcpRebuildPending = true; return }  // 不打断运行中回合
         await this.rebuildHandle(h).catch((e) =>
           console.error(`[mcp] 会话重建失败(workspace=${h.workspace.id}):`, e))
       }),
     )
   }
   ```
   - 注意:先 `[...this.handles.values()]` 快照再遍历(rebuildHandle 会改 map);每个 handle 独立 catch,单工作区失败不影响其他与 PUT 响应。
4. `prompt()` 入口改造(现有代码 `const handle = await this.openSession(workspace)` 之后、`if (handle.busy)` 之前):
   ```ts
   let handle = await this.openSession(workspace)
   // MCP 配置变更挂起重建:本回合开始前消费(先查 busy 已保证不在运行中)
   if (handle.mcpRebuildPending) handle = await this.rebuildHandle(handle)
   if (handle.busy) throw new Error('agent 正在处理中,请稍候')
   ```
   - 顺序关键:**busy 检查在重建之前**——若用户在上一个回合仍在运行时发消息,先抛「正在处理中」,绝不 dispose 运行中的会话。
   - rebuildHandle 内部已兜底(失败回退新建),prompt 不会被重建异常打断。
5. (可选,低优先)将 `reopenIfOpen` 内部改为复用 `rebuildHandle`(行为等价:`handle.sessionId` 即 active;避免两套重建逻辑漂移)。若改动引入风险可跳过,仅保留注释互指。

#### 改动 1.2 `apps/api/src/agent/routes.ts`

- PUT `/api/agent/mcp/:name`:在 `await pi.disposeMcpServer(name)` 之后新增:
  ```ts
  // 保存即生效:已打开会话按新配置重建(忙碌会话挂起,下回合前生效)
  await pi.refreshMcpForOpenSessions()
  ```
- DELETE `/api/agent/mcp/:name`:同样在 `await pi.disposeMcpServer(name)` 之后加 `await pi.refreshMcpForOpenSessions()`。
- 顺序保持:先写盘(upsertMcpServer/removeMcpServer 已原子写)→ disposeMcpServer(断旧连接清缓存)→ 重建会话(重建时 createMcpTools 按新配置重连)。
- 响应 message 与结构不变(前端 useAgent 零改动)。

#### 改动 1.3 测试(阶段 1)

新文件 `apps/api/src/pi/mcpRefresh.test.ts`(沿用 piService.test.ts 的私有构造 + TestApi hack;Tier 1 spy 方案,不跑完整 openSession,避免 fff 原生进程):

- 基建:makeStore / makeService / makeWorkspace(复制 piService.test.ts 同款);TestApi 暴露 `handles`、`rebuildHandle`、`refreshMcpForOpenSessions`、`rebuildIfPending`(若抽方法);fake handle:`session: { dispose: vi.fn() }`、`busy`、`usage`、`lastActivityAt`、`workspace`、`sessionId`。
- 用例:
  1. `refreshMcpForOpenSessions` 空闲 handle → 旧 handle.session.dispose 被调;spy `openSession` 断言以 `(workspace, sessionId)` 调用;返回 handle 的 usage 与旧值相同(迁移)。
  2. 忙碌 handle → dispose 不被调、`mcpRebuildPending === true`。
  3. 只读工作区 handle → 跳过(不 dispose、不置位)。
  4. 重建失败降级:spy `openSession` 第一次 reject、第二次 resolve → rebuildHandle 不抛、返回新 handle。
  5. 多 handle 单失败隔离:一个 reject 不影响另一个重建。
  6. `prompt` 前置重建逻辑(若抽成 `rebuildIfPending` 私有方法则直接测;否则用 spy prompt 验证 busy 优先):忙碌且置位时 prompt 抛「正在处理中」且不 dispose;空闲且置位时 prompt 走重建。
- 扩展 `apps/api/src/agent/mcpRoutes.test.ts`(轻量路由接入断言):`vi.spyOn(pi, 'refreshMcpForOpenSessions')`,PUT 与 DELETE 后各断言被调用一次(现有 makeService 模式可直接用)。

#### 阶段 1 验收标准

- [ ] PUT/DELETE 返回后,已打开空闲会话:新 server 的工具立即可见、删除 server 的工具从注册表消失、历史消息不丢(同 sessionId)、usage 累计不清零。
- [ ] 忙碌会话:保存期间回合不中断;下一回合自动用新工具集(重建发生在回合开始前)。
- [ ] 单 server 连接失败/配置损坏不阻塞其他会话重建与 PUT 响应(createMcpTools 既有 allSettled 隔离)。
- [ ] 重建异常(极端)降级为新建会话且不抛到路由;旧 JSONL 保留。
- [ ] 现有测试全绿:`pnpm test`(mcpConfig / mcpRoutes / mcpTools / piService / McpPanel / useAgent 等)。

---

### 阶段 2(必须,与 A 同批):方案 B — McpManager 配置指纹化 + 调用时解析

**目标**:补 A 的两个洞——① 忙碌会话当回合内(尚未重建)调用工具仍用旧配置;② 删除/禁用 server 后,未重建旧会话的工具用旧配置「复活」重新 spawn;③ 任意未重建窗口期的旧闭包。

**原理**:连接缓存按「config 指纹」校验;工具 execute 不再捕获配置快照,改为调用时经 `resolveServer` 解析最新配置。改动全部在 `mcpTools.ts` + 两个调用点,`McpManager` 对外接口不变。

#### 改动 2.1 `apps/api/src/pi/mcpTools.ts`

1. 新增导出函数(放 `McpManager` 定义前):
   ```ts
   /** 连接相关配置指纹(稳定键序 JSON;仅 command/args/env 影响连接) */
   export function configFingerprint(config: McpServerConfig): string {
     return JSON.stringify({
       command: config.command,
       args: config.args ?? [],
       env: config.env ?? {},
     })
   }
   ```
2. `McpEntry` 增加字段:`fingerprint: string | null`(创建连接时所用 config 的指纹;null = 从未连接)。
3. `ensureConn(entry, config)` 增加指纹校验(统一入口,listTools/callTool 都经它):
   ```ts
   private async ensureConn(entry: McpEntry, config: McpServerConfig): Promise<McpConnection> {
     const fp = configFingerprint(config)
     if (entry.conn && entry.fingerprint !== fp) {
       // 配置已变更:断开旧连接,按新配置重建(closeEntry 同时清 tools 缓存)
       await this.closeEntry(entry)
     }
     if (!entry.conn) {
       entry.conn = this.factory.create(config)
       entry.fingerprint = fp
       await entry.conn.connect()
     }
     return entry.conn
   }
   ```
4. `listTools(name, config)` 缓存判断加指纹条件(否则指纹变化后仍返回旧 tools):
   ```ts
   const fp = configFingerprint(config)
   if (entry.fingerprint === fp && entry.tools) return entry.tools
   ```
   (指纹不同 → 走下方 ensureConn,closeEntry 已清 tools,重新 list。)
5. `callTool(...)` 无需改逻辑(ensureConn 已覆盖指纹重连);保留断线重连逻辑不变。
6. 工具工厂签名向后兼容扩展:
   ```ts
   export async function createMcpTools(
     manager: McpManager,
     servers: McpServerConfig[],
     resolveServer?: (name: string) => McpServerConfig | undefined,
   ): Promise<ToolDefinition[]> {
     const resolve = resolveServer ?? ((name: string) => servers.find((s) => s.name === name))
     ... // buildServerTools / toMcpToolDefinition 透传 resolve
   }
   ```
7. `toMcpToolDefinition(manager, resolve, server, descriptor)` 的 execute 改为:
   ```ts
   async execute(_toolCallId, params, signal, _onUpdate) {
     abortIfSignaled(signal)
     const current = resolve(server.name)          // 调用时解析最新配置
     if (!current || current.enabled !== true) {   // 已删除/未启用 → 工具失效
       return toolError(`${server.name} 已删除或未启用,工具不可用`)
     }
     try {
       const result = await manager.callTool(current.name, current, descriptor.name, params as ..., signal)
       ...
     }
   }
   ```
   - 工具名(`mcp__server__tool`)与参数 schema 仍来自注册时快照(注册表只能由 A 重建更新);B 只保证「调用时用最新连接配置」与「删除/禁用即失效」。

#### 改动 2.2 两个消费点接入 live resolver

- `apps/api/src/pi/piService.ts`(openSession 内):
  ```ts
  const mcpTools = workspace.readOnly
    ? []
    : await createMcpTools(this.mcp, mcpServers,
        (name) => loadMcpServers(this.store).find((s) => s.name === name))
  ```
- `apps/api/src/pi/subAgent.ts`(runSubAgent 内):同样传入 `(name) => loadMcpServers(store).find((s) => s.name === name)`。
- 说明:每次工具调用多一次小文件 readFileSync(与 loadMcpServers 既有无缓存语义一致,成本可忽略)。

#### 改动 2.3 测试(阶段 2)

扩展 `apps/api/src/pi/mcpTools.test.ts`(沿用 makeFakeConnection / makeManager 注入式工厂):

1. 指纹变化重连:listTools(cfgA) 后 listTools(cfgB 仅 command 不同)→ 旧 conn.close 被调、factory.create 第二次被调、listTools 用新 conn;返回工具按新连接。
2. 指纹相同 → 不重连(既有缓存用例已覆盖,保持全绿即证明)。
3. live resolver 生效:createMcpTools(manager, [server], resolve) 后,resolve 先返回 cfgA、后返回 cfgB → 同一工具 execute 两次,factory 创建 2 个连接,第二次用 cfgB(断言 create 的入参 config)。
4. 删除/禁用:resolve 返回 undefined(或 enabled:false)→ execute 返回「已删除或未启用」文本,且 factory 未被再次调用(不 spawn)。
5. 兼容性:不传 resolveServer → 现有测试全绿(行为与现状一致)。

#### 阶段 2 验收标准

- [ ] 修改 command/args 后,未重建的旧会话调用该 server 工具 → 按新配置重连(不 spawn 旧命令)。
- [ ] 删除 server 后,旧会话调用其工具 → 报「已删除或未启用」,不复活。
- [ ] enabled 切 false 同样失效(与 A 重建后的注册表移除语义一致)。
- [ ] 指纹相同 → 零额外开销(缓存命中、不重连)。
- [ ] 现有 mcpTools.test.ts 全绿;`pnpm test` 全绿。

---

### 阶段 3(可选,本期**不做**,仅评估留档):方案 C — fs.watch 兜底

**评估结论:不纳入本次范围。**

理由:
1. 用户主路径是设置面板(PUT/DELETE 路由内直接触发,阶段 1/2 已全覆盖);手工编辑 `mcp.json` 是低频场景,且有损坏配置的风险(面板路径有校验,手工路径没有)。
2. fs.watch 平台语义差异(编辑器原子保存 = write + rename 换 inode;watch 文件路径在 rename 后可能丢监听,须 watch 目录 + filename 过滤)、与自身 tmp+rename 原子写互触发、生产多实例部署下 watcher 归属不清,复杂度与收益不成比例。
3. 「避免过度设计」约束下,本期收敛为:配置变更→刷新**单一入口**(阶段 1 的 `refreshMcpForOpenSessions`,路由唯一调用方);未来加 watcher 只是多一个调用方。

若未来纳入(留档设计,不实现):
- 位置:`apps/api/src/app.ts` 或独立 `mcpWatcher.ts`,`fs.watch(store.root, (event, filename) => filename === 'mcp.json' && ...)`(watch 目录而非文件)。
- 去抖:300ms debounce;内容指纹比对(`configFingerprint` 全量 servers 序列化)与「上次已应用指纹」比对,相同则跳过。
- **与 A 的交互(防双重建)**:watcher 与 PUT/DELETE 共用同一刷新入口;刷新入口串行化(进行中刷新完成后合并最新指纹) + 指纹去重,天然防止「PUT 写盘触发的 watcher 事件 + 路由主动刷新」双重建。
- 手工编辑损坏 mcp.json:loadMcpServers 容错返回 [] → 重建后所有 MCP 工具消失(可接受,面板可修正);可加「跳过本次刷新 + 日志」策略,避免误伤。

---

### 阶段 4(必须,轻量):前端文案 + 文档

#### 改动 4.1 `apps/web/src/components/McpPanel.vue`

1. 底部提示(第 454 行)由:
   > 新增/修改 MCP server 后需**新建会话或重开工作区**生效(与 skills 一致);删除/禁用会立即断开连接。
   
   改为:
   > **保存后立即生效**(已打开会话自动重建工具集;忙碌会话下一回合生效);删除/禁用立即断开连接。手工编辑 mcp.json 需重启生效。
   - 去掉「与 skills 一致」(skills 语义未变,避免误导);补一句手工编辑的边界(阶段 3 未做,保持诚实)。
2. `saved` 提示(「已保存到 mcp.json」)→「已保存并生效」(可选项,增强反馈)。
3. `statusLabel` 的 `not_connected` 文案「未连接 · 新建会话后自动连接」→「未连接」(保存后会自动连接,「新建会话后」不再准确)。

#### 改动 4.2 测试

- `apps/web/src/components/McpPanel.test.ts`:检查是否断言旧提示文案(当前未发现,实施时再确认);若断言则同步更新。`useAgent.test.ts` 无需改动(请求与响应结构不变)。

#### 改动 4.3 文档

- `docs/mcp.md`:
  - §4「生效时机」改写:保存即生效(PUT/DELETE 触发会话重建,忙碌会话下回合生效;调用时按最新配置解析,B);手工编辑 mcp.json 仍需重启/新建(注明 C 未做)。
  - §2 架构图补 `refreshMcpForOpenSessions` 节点(可选)。
  - §8 风险表补:会话重建失败降级(新建会话,旧 JSONL 保留)、忙碌会话挂起语义、指纹重连并发竞态。

#### 阶段 4 验收标准

- [ ] 面板不再出现「新建会话或重开工作区生效」字样;提示与实现一致。
- [ ] 前端测试全绿;useAgent 零改动。
- [ ] docs/mcp.md 与实现一致。

---

## 4. 风险与回滚

| # | 风险 | 缓解 |
| --- | --- | --- |
| 1 | 重建期间该工作区短暂无 handle(dispose 后、openSession 完成前),并发 prompt 可能竞争 | 窗口为毫秒级;最坏结果 = 多重建一次,JSONL append-only 无数据丢失;与 reopenIfOpen 既有模式一致(已在生产用)。记录为已知边界 |
| 2 | 重建打断正在执行的工具调用/流式回合 | A 只重建空闲会话(busy=false);忙碌挂起置位,由 prompt 入口在**下一回合开始前**消费,且 busy 检查先于重建。回合绝不被 dispose |
| 3 | JSONL 恢复失败 | 现成降级:`sessionFileFor` 文件缺失返回 undefined → openSession 新建会话;createAgentSession 异常 → rebuildHandle catch 后回退新建;旧 JSONL 原样保留(数据不丢,会话列表可切回)。console.error 记录 |
| 4 | usage 清零 | rebuildHandle 显式迁移 usage/lastActivityAt(run 由 resolveCurrentRun 磁盘恢复,无需处理) |
| 5 | 单 server 连接失败拖慢/拖垮重建 | createMcpTools 既有 Promise.allSettled 单 server 隔离 + 10s 超时;refreshMcpForOpenSessions 每 handle 独立 catch |
| 6 | B 指纹重连并发竞态:两个并发调用检测到指纹变化同时 close+重建 | 与既有「断线重连」路径同构(现状已存在);entry 级 last-write-wins,最坏一次调用短暂用旧连接;SDK client 并发请求线程安全。记录为已知边界 |
| 7 | 删除 server 后旧会话工具「复活」 | B 的 resolveServer 返回 undefined → 工具报「已删除或未启用」,不 spawn |
| 8 | 手工编辑 mcp.json 不生效(用户误以为保存即生效) | 面板文案 + docs 明确「手工编辑需重启」;C 未做属明确决策 |
| 9 | 回滚 | 各阶段独立 commit,git revert 即可;无配置存储迁移(mcp.json 结构不变);功能回退仅影响会话工具集,不落盘、不破坏既有会话文件 |

---

## 5. 验收总清单(可逐条核对)

**功能(手动 E2E,dev 环境 web 15200 / api 3000,`.workflows/mcp.json` 现含 context7):**

- [ ] 建立会话并发送至少一条消息后,面板新增 enabled server 并保存 → 不新建会话,下一条消息中模型可见并可调用 `mcp__新server__*` 工具。
- [ ] 修改已有 server 的 command/args/env 并保存 → 旧连接断开、新配置生效(可观察面板状态由 error→connected 或 stderr 变化)。
- [ ] 删除 server 并保存 → 会话注册表中该 server 工具消失;极端情况下(未重建窗口)调用也报「已删除或未启用」,不复活子进程。
- [ ] enabled 切 false → 工具失效,与删除同语义。
- [ ] agent 流式(忙碌)期间保存配置 → 当前回合不中断;下一回合自动用新工具集。
- [ ] 保存后历史消息完整、会话未变(同 sessionId)、usage 不清零;面板状态正确(connected/error)。
- [ ] 添加一个 command 不存在的 server 并保存 → 会话仍可正常对话(单 server 失败隔离),面板显示异常。
- [ ] 子代理调用正常(天然生效,回归验证)。

**自动化:**

- [ ] `pnpm test` 全绿(新增 mcpRefresh.test.ts + mcpTools.test.ts 扩展 + mcpRoutes.test.ts 扩展;既有 mcpConfig/mcpRoutes/mcpTools/piService/McpPanel/useAgent 测试无回归)。
- [ ] TypeScript 编译通过(`pnpm -C apps/api build` 或仓库既有类型检查命令)。

**范围控制:**

- [ ] 未修改 SDK、未引入新依赖(fs.watch 未做)、mcp.json 存储与校验零改动、useAgent.ts 零改动、PUT/DELETE 响应结构不变。

---

## 6. 实施顺序与依赖

| 顺序 | 内容 | 依赖 | 可独立上线? |
| --- | --- | --- | --- |
| 阶段 1 | 方案 A:会话重建(PUT/DELETE 触发)+ 忙碌挂起 + 测试 | 无 | 是(核心诉求;单上此阶段仍有 B 所述两个小洞,需文档注明) |
| 阶段 2 | 方案 B:指纹化 + live resolver + 测试 | 无(与 1 并行/先后皆可;同批交付最佳) | 是(独立补边界,但语义上服务 A) |
| 阶段 3 | 方案 C:fs.watch | — | 不做(留档) |
| 阶段 4 | 前端文案 + docs | 1、2 完成后再改文案(避免文案与行为不一致) | 否 |

建议:阶段 1 → 2 → 4 一个 PR 交付;每阶段独立 commit(1、2 可拆两个 commit,便于 revert)。总改动量估计:源码 ~6 文件、测试 ~4 文件、文档 2 文件,阶段 1 约 60 行、阶段 2 约 80 行,规模可控。
