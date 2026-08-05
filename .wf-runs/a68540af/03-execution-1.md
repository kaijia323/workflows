# 执行报告:修复审查报告 6 项非阻塞问题(run a68540af)

> 依据:`.wf-runs/09f3129e/04-review-1.md` 问题清单 1-6 + 任务指令(产物目录无独立计划文件,以任务指令为计划,参照 `09f3129e/02-plan-2.md` 上下文)。
> 目标仓库:workflows(Turborepo + pnpm + Hono + Vue 3 + pi SDK)。

## 改动文件清单

### 问题 1(🟡)路由层校验绕过 — 已修复

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/src/agent/routes.ts`(PUT `/api/agent/mcp/:name`,L96-101) | `args` 由「非数组 → undefined」改为**透传原始值** `raw?.args as string[] \| undefined`;`enabled` 由「非布尔 → undefined」改为透传 `raw?.enabled as boolean \| undefined`;补注释说明校验下沉 | 不再屏蔽存储层 `validateMcpServers`,非数组 args / 非布尔 enabled 由校验层统一 400 中文报错 + 零写入 |
| `apps/api/src/agent/mcpRoutes.test.ts`(追加 2 用例) | 「PUT args 非数组(字符串)→ 400 且 mcp.json 未创建」「PUT enabled 非布尔(字符串)→ 400 且 mcp.json 未创建」,对照既有「args 含非字符串」用例风格 | 补上审查指出的测试缺口 |

### 问题 2(🟡)文档声明过度 — 已修复(两处文档)

| 文件 | 改动 |
| --- | --- |
| `README.md`(数据存储 mcp.json 条目 L43 + 「MCP(外部工具)」安全模型 L123) | 两处「agent 无任何工具可写」均加限定「**仅当工作区不包含 `.workflows` 目录时成立**(若把仓库根本身添加为工作区,`.workflows/mcp.json` 即在工作区内,bash/write/edit 均可写)」,并各补一句信任模型说明:「agent 与 OS 用户同权限,护栏防误操作而非防恶意,与 config.json 同一既有局限」 |
| `docs/mcp.md` §6.1(L84-91) | 同样限定「该保证仅在『工作区不包含 `.workflows` 目录』时成立」(说明 dev 下 `.workflows` 位于仓库根,仓库即工作区时的穿透场景,标注与 config.json 同一既有局限、非本次引入)+ 信任模型一句 |

### 问题 3(🟢)openSession 串行连接 — 已修复

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/mcpTools.ts`(`createMcpTools`,L480-495) | 串行 `for...of await` 改为 `Promise.allSettled` 并行构建各 enabled server;单 server 构建逻辑抽为 `buildServerTools`(内部 try/catch + warn 跳过,返回空列表) | 多个宕机 server 从最坏叠加 N×10s 降为并行 10s;allSettled + 每 server 独立捕获保持「该 server 失败不影响其他」隔离语义。调用点 `piService.openSession`(L275)与 `subAgent.runSubAgent`(L359)共用此函数,双点同时受益,无需各自改 |

### 问题 4(🟢)ensureEntry 初始 state 误报 — 已修复(新增 connecting 态)

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/index.ts`(`McpServerStatus.state`) | 联合类型 `'disabled' \| 'connected' \| 'error'` → 加入 `'connecting'`(注释说明语义) |
| `apps/api/src/pi/mcpTools.ts`(`McpEntry.state` 类型 + `ensureEntry` L452) | 初始 `state: 'connected'` → `'connecting'`(连接建立前 status() 不再谎报 connected) |
| `apps/web/src/components/McpPanel.vue`(`statusLabel`/`statusClass`) | 新增 `case 'connecting'` → 「连接中…」/ `text-mute`(default 分支「未启用」对 connecting 是错误展示,必须显式处理) |
| `apps/api/src/pi/mcpTools.test.ts`(追加 1 用例) | 「连接建立前 status 为 connecting(不误报 connected);成功后为 connected」——connect 挂起(pending promise)期间断言 state='connecting',释放后断言 'connected' |

选型说明:评估「初始 error」与「新增 connecting」两方案——初始 error 在连接中同样短暂误报(语义相反),而 connecting 为真实语义;成本 = 共享类型联合 + 前端一个 switch 分支 + 一个测试,可控,故选 connecting。既有测试全部保持通过(无测试断言初始 connected)。

### 问题 5(🟢)SIGINT/SIGTERM 无兜底超时 — 已修复

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/index.ts`(L19-30) | `pi.dispose().finally(...)` 改为:dispose 挂 5s 兜底计时器(`setTimeout` 5s → warn + `process.exit(0)`,`timer.unref()` 防空转),dispose 完成/失败后 `clearTimeout` + `process.exit(0)` | 等价 Promise.race(5s)语义:dispose 正常收尾走优雅路径;MCP 子进程不响应 close 时 5s 强制退出,进程不挂死 |

### 问题 6(🟢)冒烟 2-6 项补验 — 尽力补验,如实申报

**环境判定**:无 DeepSeek API key(`~/.workflows/agent/auth.json` 为 `{}`,env 无 key,config.json 不存在)、无浏览器/UI 自动化,dev 会话级冒烟(聊天可见性、子代理调用)无法执行。已做可做的部分:

**API 级实机冒烟(已执行,真实进程)**:
1. API 服务真实启动(`node --import tsx/esm src/index.ts`,PORT=3999)→ `GET /api/agent/meta`、`GET /api/agent/mcp` 正常(空配置返回空列表);
2. `PUT` args 非数组 → **400**「MCP server「echo」的 args 必须是字符串数组」;enabled 非布尔 → **400**「MCP server「echo」的 enabled 必须是布尔值」(问题 1 端到端复验);
3. 配置真实 stdio MCP server(node -e 最小 echo server)→ `POST /api/agent/mcp/echo/test` 返回 `{ok:true, tools:[{name:'echo'}]}`(真实 spawn + SDK connect + listTools + close 全链路);
4. SIGINT → 进程优雅退出,无残留 MCP 子进程/API 进程(ps 确认 0);
5. 冒烟过程中被 workspaceGuard 实测拦截一次越界 rm(护栏生效的活体演示);冒烟产生的 `~/.workflows/mcp.json` 已删除,环境复原。

**各项单测覆盖情况(如实)**:
| 冒烟项 | 单测覆盖 | 状态 |
| --- | --- | --- |
| 会话内 mcp__ 工具可见性 | 注册命名/清洗/跳过:mcpTools.test.ts;子代理 tools/activeNames 恰一次:subAgent.test.ts | 部分覆盖(注册点逻辑);「聊天中可见 + tool_start/tool_end 渲染」需 LLM,**待人工补验** |
| 子代理共享连接 | 连接缓存「连续两次 createMcpTools 只 connect 一次」mcpTools.test.ts;子代理注册 subAgent.test.ts | 缓存语义已覆盖;跨会话共享为构造保证(execute 闭包引用共享 manager),行为日志级验证**待人工补验** |
| 只读工作区排除 | **无单测**(piService 无 openSession 单测基建,getConfig 亦需真实 ModelRuntime) | 双点代码审查确认(piService.ts L274-275 `workspace.readOnly ? [] : ...`、subAgent.ts L358-359 同),端到端**待人工补验** |
| UI 面板操作 | useAgent.test.ts MCP actions(fetch mock,4 用例:refreshMcp/saveMcpServer/testMcpServer/deleteMcpServer/init 静默) | composable 层已覆盖;McpPanel.vue 无组件测试,面板手工操作**待人工补验** |

未强行造假:冒烟 2-6 的 LLM 会话级/UI 浏览器级验证在本环境确实无法执行。

## 自检结果

- `pnpm typecheck`:3/3 通过(shared 重建后;api 消费 dist 联合类型含 'connecting')
- `pnpm lint`:3/3 通过
- `pnpm build`:3/3 通过
- `pnpm --filter @workflows/api test`:**258 passed / 10 failed**——10 个失败与基线完全一致(workspaceGuard.test.ts ×8 + runManager.test.ts ×1 + agentDefs.test.ts ×1,均为 Linux 下 Windows 路径断言基线问题,本次零改动文件),**无新增失败**;新增 3 个测试(路由 2 + connecting 1)全绿
- `pnpm --filter @workflows/web test`:34 passed(4 文件全绿)

## 未完成项与原因

- 问题 6 的 4 项冒烟(会话内可见性 / 子代理共享连接行为 / 只读排除端到端 / UI 面板手工操作):缺 DeepSeek API key 与浏览器环境,无法执行;已如实列出各项的单测覆盖与待人工补验清单(见上表)。
- 问题 5 的 5s 兜底超时路径为代码级验证(SIGINT 优雅路径已实测);构造「MCP 子进程不响应 close」的挂死场景需专门注入,未做进程级复现——超时逻辑为简单 setTimeout 强制 exit,风险极低。
