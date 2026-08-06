# 探索报告:工作区(workspace/pwd)相关实现逻辑

> 任务:调研 workflows 仓库,定位「pwd / cwd / 工作目录」的确定与传递逻辑,为排查
> 「在新增工作区 A 对话时,主/子代理有概率读取 workflows 仓库目录与内容」的 bug 做准备。
> 纯只读调研,未修改任何代码。

---

## 1. 仓库概览

- **形态**:pnpm + turborepo monorepo(`apps/api` + `apps/web` + `packages/shared`)。
- **入口**:根 `package.json` —— `preview` = `pnpm build && pnpm start`;
  `start` = `cross-env NODE_ENV=production node apps/api/dist/index.js`(**api 进程 cwd = workflows 仓库根**,进程 cwd 即仓库根,这一点对后文 SDK 回退链很重要)。
- **服务端**:`apps/api`(Hono + @hono/node-server + pi SDK `@earendil-works/pi-coding-agent` v0.83 + `@ff-labs/fff-node`)。
  - 入口 `apps/api/src/index.ts`(端口:prod 5200 / dev 3000);
  - `apps/api/src/app.ts`(静态托管 web/dist + SPA fallback);
  - `apps/api/src/config.ts`(`.workflows` 存储:workspaces.json / config.json / workspace-sessions.json);
  - `apps/api/src/agent/routes.ts`(全部 `/api/agent/...` 路由);
  - `apps/api/src/pi/piService.ts`(**主代理服务层**,会话/工具/编排);
  - `apps/api/src/pi/subAgent.ts`(子代理运行器);
  - `apps/api/src/pi/workspaceGuard.ts`(工作区边界守卫,拦截越界路径);
  - `apps/api/src/pi/fffTools.ts`(fff 索引搜索工具);
  - `apps/api/src/pi/promptLoader.ts`(system prompt + skills 四来源加载);
  - `apps/api/src/pi/runManager.ts`(run/产物黑板);
  - `apps/api/src/pi/agents/*.md`(orchestrator/explorer/planner/executor/reviewer 代理定义)。
- **前端**:`apps/web`(Vue 3 + Vite),状态中心 `apps/web/src/composables/useAgent.ts`,
  工作区列表 `WorkspaceRail.vue`、添加选择器 `WorkspacePickerModal.vue`、聊天 `ChatPane.vue`。
- **存储分环境**:`config.ts:15 workflowsRoot()` —— dev = `<repo>/.workflows`,prod = `~/.workflows`。
  5200 生产环境全部运行数据在 `C:\Users\<user>\.workflows\` 下(含 workspaces.json)。

## 2. 需求相关模块清单(文件 → 作用)

| 文件 | 作用(与 pwd/工作区相关) |
| --- | --- |
| `apps/api/src/config.ts` | `Workspace` 数据结构落盘(workspaces.json)、`addWorkspace`(path.resolve)、按 workspaceId 隔离会话目录 |
| `apps/api/src/agent/routes.ts` | 路由层每请求 `requireWorkspace(store,id)` 从磁盘**现读**工作区对象;`/open` `/prompt` `/status` 等 |
| `apps/api/src/pi/piService.ts` | **主代理**:openSession 以 `workspace.path` 绑定全部工具 + session cwd;handle 按 workspace.id 缓存;`prompt()` SSE 流 |
| `apps/api/src/pi/subAgent.ts` | **子代理**:runSubAgent 以传入的 `workspace.path` 建会话/绑工具 |
| `apps/api/src/pi/workspaceGuard.ts` | bash 静态审计 + read/ls 等 path 校验,`baseEnv` 把 PWD 预置为 workspacePath(仅静态分析用) |
| `apps/api/src/pi/fffTools.ts` | `FffIndexManager.get(workspace.id, workspace.path)` —— 索引按 workspace.id 缓存 |
| `apps/api/src/pi/promptLoader.ts` | skills 四来源(cwd=workspace.path)、`skillReadRoots`(工作区外只读放行根) |
| `apps/api/src/pi/runManager.ts` | run 产物目录 `<workspace>/.wf-runs/<runId>/` |
| `apps/web/src/composables/useAgent.ts` | 前端唯一工作区状态 `activeWorkspaceId`;`openWorkspace`/`sendMessage`/SSE 事件处理 |
| `apps/web/src/components/WorkspaceRail.vue` | 点击行 → `agent.openWorkspace(ws.id)` |
| SDK(见 §4) | cwd 消费点与回退链 |

## 3. pwd / cwd / 工作目录的确定与传递链

### 3.1 数据源头:Workspace 结构

`packages/shared/src/index.ts` 定义 `Workspace { id(uuid), path(绝对路径), name, readOnly, createdAt }`。
- 写入:`config.ts:167 addWorkspace()` —— `path.resolve(dir)` 后去重(同路径不重复)写 workspaces.json;
- 读取:路由层每请求 `routes.ts:requireWorkspace()` 现读磁盘;前端只传 **workspace id**,服务端以 id 查 path。

### 3.2 主代理会话如何绑定工作目录(piService.ts openSession)

```
requireWorkspace(id) ──► workspace.path
        │
        ├─ SessionManager: sessionFile ? SessionManager.open(file)            [cwd = JSONL header cwd]
        │                                   : SessionManager.create(path, dir) [cwd = workspace.path]
        ├─ 工具全部以 workspace.path 创建/包装:
        │    createReadOnlyTools / createCodingTools / createBashTool(workspace.path, {spawnHook})
        │    createFffFindTool/GrepTool(finder(workspace.path), workspace.path)
        │    guardPathTool / guardToolSet(…, workspace.path, extraReadRoots)
        ├─ skillCtx = { cwd: workspace.path, skillsDir: store.skillsDir }
        └─ createAgentSession({ cwd: workspace.path, agentDir: store.agentDir, … })
```

**结论:应用层所有工具/会话的 cwd 全部显式绑定 workspace.path,无「回退到仓库根」的显式兜底。**

### 3.3 子代理会话如何绑定(subAgent.ts runSubAgent)

- 工具集 `buildSubAgentTools({ workspace, … })` —— 同上,全部绑定 `workspace.path`;
- `SessionManager.create(workspace.path, sessionDir)` + `createAgentSession({ cwd: workspace.path, … })`;
- 传入的 `workspace` 来自主代理工具闭包(piService.createSubAgentTool 捕获的 workspace 对象),**与主会话同一工作区对象**;
- 会话文件隔离:`<agentDir>/sessions/<workspace.id>/sub/<runId>/` —— 按 id 隔离,无串扰。

### 3.4 关键:SDK 层的 cwd 回退链(node_modules,gitignored,需直接 read)

1. **`dist/core/sdk.js` createAgentSession**:
   `const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd())`
   → 若某调用点漏传 `cwd`,`process.cwd()` 即 **workflows 仓库根**(prod 下 pnpm preview 的启动目录)。
   当前 api 三处调用(piService.openSession / piService.getSubAgentHistory / subAgent.runSubAgent)都显式传了 cwd,未触发。
2. **`dist/core/session-manager.js` SessionManager.open(path, sessionDir, cwdOverride?)**:
   `cwd = cwdOverride ?? (header ? header.cwd : undefined) ?? process.cwd()`
   → 重开既有 JSONL 时,cwd 取 **会话文件 header 里记录的 cwd**,不再取调用方目录。
   piService 调 `SessionManager.open(sessionFile)` 时未传 cwdOverride(header 权威)。
   **风险:若某工作区的 sessionFile 指向 header cwd=workflows 仓库的 JSONL(迁移/拷贝/改文件造成),SDK 侧 cwd 即为 workflows 仓库**;
   但工具 cwd 仍以 createAgentSession 的显式 cwd 为准,故纯 header 错位不足以让工具读错目录,除非 cwd 参数也缺失。
3. **`dist/core/agent-session.js`**:
   - `_cwd = config.cwd`;system prompt 渲染 `Current working directory: <cwd>`(system-prompt.js);
   - `_buildRuntime()` → `createAllToolDefinitions(this._cwd)`(默认内置工具,被 customTools 同名覆盖);
   - `executeBash()`(扩展 API,非 bash 工具)用 `sessionManager.getCwd()`。
4. **`dist/core/tools/bash.js`**:bash 工具 cwd 在**创建时捕获**;spawn 前 `fsAccess(cwd)` 不存在即报错;
   env = `getShellEnv()` = 整个 process.env(PWD 若存在会被 bash 自身覆盖,实际 pwd 由 spawn cwd 决定)。

### 3.5 工作区边界守卫(workspaceGuard.ts)

- bash:`auditBashCommand` 静态审计参数/重定向/cd/命令替换,越界即抛错阻断;`baseEnv` 把 `PWD` 预置为 workspacePath 仅用于展开 `${PWD}` 的静态分析;
- read/ls/fff/…:`guardPathTool` 执行前校验 path,`isAllowedTargetPath` = 设备白名单 ∪ 临时目录 ∪ 工作区内 ∪ **extraAllowedRoots**;
- `extraAllowedRoots = skillReadRoots(skillCtx)`(promptLoader.ts:126)在 prod 下 = `~/.pi/agent/skills` + `~/.agents/skills` + `~/.workflows/skills`(仅当不在工作区内)。
  **注意:这三个目录对 read/ls/fff 只读放行** —— 若用户机器上这些目录恰好含 workflows 仓库相关内容(如 pi 全局 skills 里放了对 workflows 的说明),会表现为「A 会话的工具结果出现 workflows 内容」,但这是设计内放行面,非路径错位。

### 3.6 「有概率」候选的随机/竞态来源(代码层排查)

- **前端唯一状态 `activeWorkspaceId` 的切换竞态**(useAgent.ts:329 openWorkspace)——见 §6 主假设;
- **后端 `PiAgentService.activeEmitter` 是服务级单例**(piService.ts:107 声明、prompt() 内赋值/清除):
  两个工作区同时有回合在跑(双标签页或竞态)时,子代理 sub_* 事件经 activeEmitter 转发到「最后一次赋值」的 SSE 流 —— 跨工作区事件串流;
- **openSession 并发**(handles 按 id 缓存):同 id 并发 openSession 会双建会话、后者覆盖前者(泄漏),但路径一致,不产生错位;
- **fff 索引按 workspace.id 缓存**(fffTools.ts:100),主/子代理共享同一 finder,无跨区错位;索引未就绪时工具报错而非读错目录。

## 4. pwd 链路的决定性结论

| 层 | 绑定方式 | 是否可能指向 workflows 仓库 |
| --- | --- | --- |
| bash 工具 spawn cwd | 创建时捕获 workspace.path(tools/bash.js + piService/subAgent 显式传参) | 否(除非 workspace.path 本身就是仓库) |
| read/ls/edit/write 工具 | guardPathTool 闭包 workspace.path | 否(同上) |
| fff-find/fff-grep | finder 绑定 workspace.path,path 参数按 workspace.path resolve | 否(同上) |
| system prompt「Current working directory」 | createAgentSession 的 cwd | 否(三处调用均显式传 cwd) |
| session JSONL header cwd | SessionManager.open 取 header | **可能**(header 错位时;但不影响工具绑定) |
| SDK 回退 `process.cwd()` | 仅在 cwd 参数缺失时触发 | **可能**(prod 下即仓库根;当前未触发) |
| skills 只读放行根(~/.pi/agent/skills 等) | 设计内放行 | 可能(设计内,非 bug) |

**即:应用层不存在「pwd 回退到 workflows 仓库」的代码路径;唯一能让 agent 的 pwd/工具指向 workflows 仓库的,是该会话实际运行在 workflows 仓库工作区上(workspace.id = 仓库的 id),或 SSE 事件跨工作区串流。**

## 5. 相关文件与关键行号

- `apps/api/src/pi/piService.ts`:L241-250(handles 按 id)、L256-260(SessionManager create/open)、L263-297(工具绑定)、L310-312(createBashTool)、L341-345(createAgentSession cwd)、L355-358(skillCtx)、L420-430(createSubAgentTool 闭包捕获 workspace)、L107(activeEmitter 单例)、L640-700(prompt:activeEmitter 赋值、回合收尾)
- `apps/api/src/pi/subAgent.ts`:L150-190(buildSubAgentTools)、L362(子代理 skillCtx)、L395-410(SessionManager + createAgentSession cwd)
- `apps/api/src/agent/routes.ts`:L480-490(requireWorkspace 现读磁盘)、L145-160(workspaces 增删改)、L225-235(/open)
- `apps/api/src/config.ts`:L15-22(workflowsRoot 分环境)、L167-180(addWorkspace path.resolve)、L345-368(sessionDirFor 按 id 隔离)
- `apps/api/src/pi/workspaceGuard.ts`:L88-95(baseEnv PWD=workspacePath)、L120-146(isAllowedTargetPath)、L498-515(guardPathTool)
- `apps/api/src/pi/promptLoader.ts`:L38-55(loadWorkspaceSkills cwd)、L126-146(skillReadRoots)
- `apps/api/src/pi/fffTools.ts`:L100-115(FffIndexManager.get(workspace.id, path))
- `apps/web/src/composables/useAgent.ts`:L152(activeWorkspaceId)、L300-325(applySessionData 整体替换 messages)、L329-337(openWorkspace:先 await /open 再置 id)、L629-650(sendMessage 读 id + SSE handleEvent 无工作区校验)、L745-760(abort 无工作区归属)
- `apps/web/src/components/WorkspaceRail.vue`:L81(点击 → openWorkspace)
- SDK:`node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js`(createAgentSession cwd 回退链)、`dist/core/session-manager.js`(SessionManager.open header cwd)、`dist/core/tools/bash.js`(spawn cwd 捕获)、`dist/core/agent-session.js`(system prompt cwd / executeBash 用 sessionManager.getCwd())、`dist/core/system-prompt.js`(Current working directory)
- 佐证数据:`.workflows/workspace-sessions.json` 中 sessionFile 绝对路径按 workspaceId 分目录;JSONL 首行 header 含 `"cwd":"C:\\Users\\kaijia\\codes\\github\\workflows"`(仓库工作区)/ `"cwd":"...\\mmaction2"`(其他工作区)——header cwd 与工作区一一对应,可作为排查时核对「会话文件归属」的直接证据。

## 6. 根因假设(按可能性排序)

### 假设 A(主假设):前端工作区切换竞态 —— 消息发往旧工作区,响应渲染进新工作区视图

时序:
1. 用户在 workflows 仓库工作区 W(当前对话)空闲;点击工作区 A → `openWorkspace(A)` 在途
   (`useAgent.ts:329-337`:**先 await POST /open(A),成功后才把 `activeWorkspaceId` 置为 A**);
2. 窗口期内用户输入并发送消息 → `sendMessage`(L629)读取的 `activeWorkspaceId` **仍是 W**
   → `POST /api/agent/workspaces/<W>/prompt` → **该回合(含全部主/子代理工具调用)在 workflows 仓库会话上运行**;
3. `/open(A)` 返回 → `applySessionData`(L300)整体替换 messages(用户刚发的消息从界面消失),UI 显示 A 的历史与 A 的名称;
4. W 回合的 SSE 事件(`text_delta`/`tool_start`/`tool_end`/`sub_*`)继续到达 → `handleEvent` **无工作区归属校验**,直接追加进当前 messages(A 的视图)
   → 用户看到「在 A 工作区对话,主/子代理(的工具输出)读的是 workflows 仓库的目录与内容」,包括 `bash pwd` 输出仓库路径。

- **「有概率」的解释**:窗口 = 用户点击 A 到 `/open(A)` 返回之间的延迟;prod 下首次打开 A 会做 MCP 连接(超时 10s+10s)、fff 索引创建、ModelRuntime 等,延迟可达数秒,命中概率不低;且仅当用户在窗口内发了消息才复现。
- **佐证**:`ChatPane.handleSend` 无 activeWorkspaceId 快照一致性校验;`sendMessage` 内 `handleEvent` 无 workspace 参数;`abort()`(L745)中止的是「当前」abortController,不区分归属。
- **验证手段**:在 `/open` 响应前手动发一条消息(或用浏览器限速),观察消息实际落在 W 的 JSONL、响应渲染在 A 视图;对比 `~/.workflows/workspace-sessions.json` 中 W 会话 messageCount 增加。

### 假设 B(次假设):后端 activeEmitter 单例跨工作区串流

`piService.activeEmitter` 为服务级单例,prompt() 开始赋值、结束清空。若 W 与 A 两个工作区**同时**有回合(双标签页,或假设 A 的竞态又叠加),后启动的 prompt 覆盖 emitter,W 回合的子代理 sub_* 事件会转发进 A 的 SSE 流,呈现同样的「A 会话里出现 workflows 仓库工具输出」。与假设 A 可叠加放大。

### 假设 C(低概率):SDK cwd 回退链 + session header 错位

- 若未来新增 `createAgentSession` 调用点漏传 `cwd`,SDK 回退 `sessionManager.getCwd()`(JSONL header)→ `process.cwd()`(workflows 仓库);
- 若某工作区的 sessionFile 记录指向 header cwd=仓库的 JSONL(手工迁移/拷贝/workspace-sessions.json 被旧版本写过),重开会话时 SDK 侧 cwd=仓库;
- 当前代码两处都未触发(三处调用显式传 cwd,会话按 workspaceId 隔离),列为需排查项而非已确认路径。

### 假设 D(设计面,非 bug 但值得知晓)

`skillReadRoots`(promptLoader.ts:126)对 `~/.pi/agent/skills`、`~/.agents/skills`、`~/.workflows/skills` 只读放行 read/ls/fff —— 这些目录若含 workflows 仓库相关内容,会以「工作区外放行根」形式进入 A 会话的工具结果,但不会改变 pwd 本身。

## 7. 结论与建议

- **可行性判断**:仓库代码结构清晰,工作区路径传递链**单点绑定**(workspace.path),无显式回退到仓库根的兜底;「pwd 错误指向 workflows 仓库」的成因更可能是**会话归属错位**(消息发到了仓库工作区的会话)而非路径计算错误。
- **建议排查顺序**:
  1. 复现时核对 `~/.workflows/workspace-sessions.json` 中「A 会话」与「W(仓库)会话」的 messageCount 变化,确认消息实际落在哪个会话的 JSONL;
  2. 检查 JSONL header 的 cwd 与所属 workspaceId 目录是否一致;
  3. 前端:在 `openWorkspace` 置 id 前禁用发送(或 sendMessage 快照校验 id 与当前值一致,不一致则丢弃/提示);
  4. 前端:SSE `handleEvent` 增加 workspaceId 归属校验(流开始即绑定,后续事件若归属不符则丢弃);
  5. 后端:`activeEmitter` 改为按 workspaceId 的 Map,消除跨工作区串流。
- **约束确认**:本次为只读调研,未修改任何代码;SDK 位于 node_modules(gitignored),相关源码通过直接 read 读取,路径见 §5。
