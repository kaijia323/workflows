# 探索报告:workflows 仓库调研(MCP 接入可行性)

> runId:`09f3129e` | 类型:仓库探索 | 只读调研,未修改任何代码

## 1. 仓库概览

### 1.1 项目定位

**workflows** 是一个 **Turborepo + pnpm monorepo 的「Web Agent 工作台」**:基于 pi SDK(`@earendil-works/pi-coding-agent` / `pi-ai`)构建的 Web 聊天式 Agent 应用,支持多工作区隔离会话、SSE 流式对话、工具调用(read/bash/edit/write/fff 搜索/anysearch 联网)、Skills 加载、以及**主代理编排子代理的 DAG 工作流**(explorer 探索 → planner 计划 → ⏸ 人工闸门 → executor 执行 ⇄ reviewer 审查,产物落盘 `.wf-runs/<runId>/`)。见 `README.md`(功能清单)与 `docs/dag-workflow.md`(编排设计定稿文档)。

### 1.2 技术栈

| 包 | 技术 | 入口 |
| --- | --- | --- |
| `apps/api` | **Hono** + `@hono/node-server` + pi SDK(`@earendil-works/pi-coding-agent@0.83.0`、`@earendil-works/pi-ai@0.83.0`)、TypeBox 参数 schema、TypeScript 6 | `apps/api/src/index.ts` → `app.ts` → `initAgentRoutes()` |
| `apps/web` | **Vue 3.5** + Vite 8 + Tailwind v4 + marked + lucide-vue | `apps/web/src/main.ts` → `App.vue` |
| `packages/shared` | 纯类型包(构建产物被 api/web 消费) | `packages/shared/src/index.ts` |

- 包管理:pnpm 10.33(`packageManager: pnpm@10.33.0`),Node >= 20.19.0
- 统一响应结构:`{ code, message, data }`(code 0 = 成功),错误经 `app.onError` 统一格式化(`apps/api/src/app.ts:32-47`)
- 端口:开发 web 15200(`/api` 代理到 3000),生产 api 5200 单端口托管前端+API(`apps/api/src/index.ts:8-15`)
- 数据隔离:所有运行数据(API key/工作区/会话/代理覆盖)存 `.workflows/`(开发=仓库根,生产=`~/.workflows`),**不读写** pi 全局配置 `~/.pi/agent`(仅只读其 skills);见 `apps/api/src/config.ts:14-28`(`workflowsRoot()`)

### 1.3 目录结构

```
apps/api/src/
├── index.ts            # 进程入口:initAgentRoutes() → serve(5200/3000)
├── app.ts              # Hono app:initAgentRoutes / onError / notFound / 静态托管 SPA fallback
├── config.ts           # .workflows 存储:createStore / loadConfig / workspaces / sessions 元数据
├── agent/routes.ts     # 全部 /api/agent/* 路由(配置/工作区/会话/skills/run)
└── pi/                 # pi SDK 服务层
    ├── piService.ts    # 核心:ModelRuntime + 每工作区 AgentSession + 工具组装 + SSE 事件映射
    ├── subAgent.ts     # 子代理运行器(buildSubAgentTools / runSubAgent / 产物检测)
    ├── workspaceGuard.ts # 工作区边界守卫(unbash 静态审计 bash + 工具 path 校验)
    ├── fffTools.ts     # fff-find / fff-grep 工具(每工作区 Rust 索引)
    ├── anySearchTools.ts # anysearch-search 网络搜索工具(外部 REST 集成范本)
    ├── promptLoader.ts # 极简 ResourceLoader + skills 四来源加载 + skillReadRoots
    ├── agentDefs.ts    # 代理文件化:md frontmatter 解析 + write 白名单 glob
    ├── runManager.ts   # run 生命周期(run.json / 归并 / 快照 / 回合决策)
    ├── history.ts      # 会话历史渲染(主/子代理共用)
    └── agents/*.md     # 内置代理定义(orchestrator/explorer/planner/executor/reviewer)
apps/web/src/
├── App.vue             # 布局:PipelineHeader + WorkspaceRail + ChatPane + InfoPanel + 模态窗
├── composables/useAgent.ts # 前端状态中心:SSE 接入、消息聚合、sub_* 事件、run 快照
└── components/         # ChatPane / DagPanel / SubAgentModal / ApiKeyModal / WorkspaceRail / InfoPanel / SessionSwitcher / MessageBubble / PipelineHeader / WorkspacePickerModal
packages/shared/src/index.ts # DagNode/DagGraph、SessionEvent(含 sub_*/gate_required)、RunSnapshot、SkillInfo 等
```

## 2. MCP 现状(问题 2 的直接回答)

**结论:仓库内没有任何 MCP 代码、配置、依赖或文档;MCP 相关唯一痕迹是历史 run 产物中「否决 MCP 方案」的决策记录。**

逐项证据:

1. **代码/配置**:对 `apps/`、`docs/`、`README.md`、`AGENTS.md` 全文检索 `mcp`(大小写不敏感)→ **零命中**。
2. **历史决策记录**(非代码):`.wf-runs/24d5aebd/` 下旧 run 产物(anysearch 工具开发记录)中多次出现 "MCP"——
   - `01-exploration-2.md:193`:提及 `POST https://api.anysearch.com/mcp`(JSON-RPC)端点;
   - `02-plan-1.md:50/167/222`:曾计划用 MCP 端点,后被废弃;
   - `02-plan-2.md:3/21-22/35/116/364/427`:**明确废弃 MCP 方案**,改用实测 REST 端点 `POST https://api.anysearch.com/v1/search`(当前代码 `anySearchTools.ts:20` 即此端点)。
   - 即:MCP 在本仓库中只作为「被评估后否决的协议选项」出现过,与当前 anysearch 工具无关联。
3. **依赖**:`pnpm-lock.yaml` 中 `@modelcontextprotocol/sdk` 仅出现在两处且**均未安装**:
   - `pnpm-lock.yaml:620-624`:`@google/genai@1.52.0` 的 **optional peerDependency**(`peerDependenciesMeta.optional: true`);
   - `pnpm-lock.yaml:2781/2802/2832`:`@earendil-works/pi-ai` / `pi-agent-core` / `pi-coding-agent` 的 `transitivePeerDependencies` 排除列表(来自其依赖链中 openai/@google/genai 的 optional peer)。
   - 验证:`node_modules/.pnpm/` 下无任何 `modelcontextprotocol` 目录 → **SDK 未安装**。
4. **pi SDK 本身(v0.83.0)**:直接读取其 `dist/index.d.ts`(完整导出面)、`dist/core/sdk.d.ts`(`CreateAgentSessionOptions`)、`dist/main.d.ts`、`docs/` 目录清单、`CHANGELOG.md`(0.81~0.83 版) → **无任何 MCP 符号/文档/特性**(MCP SDK 的 peer 声明来自其依赖 openai/genai 的可选能力,SDK 未暴露 MCP API)。仓库也无任何 `server/client`、stdio/HTTP/SSE 传输、tools/resources/prompts 的 MCP 实现。

## 3. 架构与 MCP 接入点(问题 3)

### 3.1 核心模块

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 入口/CLI | `apps/api/src/index.ts` | 启动:await `initAgentRoutes()` 后 serve |
| HTTP 框架 | `apps/api/src/app.ts` | Hono app、统一错误/404、生产静态托管 |
| 路由层 | `apps/api/src/agent/routes.ts` | 全部 `/api/agent/*`(见 README API 一览) |
| 存储层 | `apps/api/src/config.ts` | `.workflows/` JSON 读写;`StoredConfig`(apiKey/anySearchApiKey/model/thinkingLevel/plannerMaxRetries) |
| Agent 服务层 | `apps/api/src/pi/piService.ts` | `PiAgentService`:`openSession()` 组装工具集并 `createAgentSession`;`prompt()` SSE;`mapSessionEvent`;子代理/闸门/完成任务工具工厂 |
| 子代理引擎 | `apps/api/src/pi/subAgent.ts` | 子代理 = 独立 AgentSession(md 正文为 system prompt),事件镜像 `sub_*` |
| 工具扩展 | `apps/api/src/pi/fffTools.ts`、`anySearchTools.ts` | 自研工具工厂:TypeBox schema + ToolDefinition,经 `customTools` 注册 |
| 权限守卫 | `apps/api/src/pi/workspaceGuard.ts` | bash 静态审计 + 工具 path 校验(工作区边界) |
| 代理定义 | `apps/api/src/pi/agentDefs.ts` + `agents/*.md` | 代理 = md(frontmatter 能力声明 + 正文行为),内置+用户覆盖 |
| Skills | `apps/api/src/pi/promptLoader.ts` | 四来源 skills 加载;`createPromptOnlyLoader` 实现 `ResourceLoader`(getPrompts 当前返回空) |
| run 生命周期 | `apps/api/src/pi/runManager.ts` | run.json、状态机、闸门、快照 |
| 共享类型 | `packages/shared/src/index.ts` | SessionEvent(SSE 事件联合类型)、RunSnapshot、SkillInfo |

### 3.2 MCP 最自然的接入点(按优先级)

1. **工具层(首选)**:MCP client 工具 = 把 MCP server 的 `tools/list` 结果包装为 pi SDK 的 `ToolDefinition`,经 `customTools` 注册进会话。**仿照 `createAnySearchTools` 工厂模式**(`anySearchTools.ts:189-191`),做一个 `createMcpTools()` 工厂。注册点在两处,需同步:
   - 主代理:`PiAgentService.openSession()`(`piService.ts`,工具组装在 ~L175-260,`createAgentSession` 的 `customTools`/`tools` 参数 ~L230-255;注意 `tools` 白名单必须显式列入新工具名,注释在 L221-224);
   - 子代理:`buildSubAgentTools()`(`subAgent.ts:110-190`,`customTools`/`activeNames` 两处)。
2. **SSE/HTTP 服务端(可选)**:Hono 已有 `streamSSE`(`routes.ts` prompt 路由 ~L180-200);MCP server 端点可挂在 `app.ts`/`routes.ts` 新增路由,复用统一响应结构或按 MCP 协议(JSON-RPC)返回。
3. **Prompts/Resources**:`promptLoader.ts` 的 `createPromptOnlyLoader`(`promptLoader.ts:159-190`)实现 `ResourceLoader` 接口,`getPrompts` 目前返回空数组——若 pi SDK 未来支持 prompts 注入,此处是挂 MCP prompts 的钩子;但 v0.83.0 无此能力。
4. **配置**:MCP server 列表(名称/命令/参数/传输方式)存 `.workflows/config.json`,扩展 `StoredConfig`(`config.ts:31-40`)+ 新增路由(仿 `config/anysearch-key`,`routes.ts:53-62`)+ 前端 `ApiKeyModal.vue`。
5. **事件流**:新增 MCP 工具调用无需新事件类型(`tool_start/tool_end` 已覆盖);若需要 MCP server 连接状态展示,扩展 `SessionEvent`(`packages/shared/src/index.ts:~L120-160`)+ `useAgent.ts` 事件处理。

### 3.3 已存在的「外部工具集成范本」

`anySearchTools.ts` 就是最佳参照:**工厂函数 + TypeBox 参数 schema + execute 内做 HTTP 调用 + 超时/中止(AbortSignal.any)+ 50KB 输出截断 + 错误文案脱敏 + key 动态读取**。MCP client 工具(stdio/HTTP/SSE 传输)可完全复用这套模式,差异只是「调用 MCP server」替代「调用 REST API」。

## 4. 依赖管理(问题 4)

- pnpm workspace(`pnpm-workspace.yaml`:`apps/*`、`packages/*`),锁文件 `pnpm-lock.yaml`,包管理器 pnpm@10.33.0。
- 根 `package.json`:turbo 编排(dev/build/typecheck/lint/test)+ husky + lint-staged。
- `apps/api/package.json` 依赖:`@earendil-works/pi-ai` / `pi-coding-agent`(^0.83.0)、`@ff-labs/fff-node@0.10.1`、`hono@^4.12.34`、`@hono/node-server`、`typebox@1.3.7`、`unbash@^4.0.5`、`picomatch`、`@workflows/shared`(workspace:*)、dev:`tsx`、`typescript@^6.0.3`。
- `apps/web/package.json`:vue 3.5、vite 8、tailwindcss 4、marked、@lucide/vue、@fontsource/*;dev:vue-tsc、@vue/test-utils、jsdom。
- **无任何 MCP SDK 依赖**(`@modelcontextprotocol/sdk` 未安装,见 §2-3)。新增依赖方式:`pnpm --filter @workflows/api add @modelcontextprotocol/sdk`。

## 5. 测试与构建(问题 5)

| 命令 | 行为 |
| --- | --- |
| `pnpm dev` | turbo dev:web(15200)+ api(3000,`node --watch --import tsx/esm`) |
| `pnpm build` | turbo(shared → api/web):api = `tsc -p tsconfig.build.json` + `node scripts/copy-agents.mjs`(复制 `agents/*.md` 到 dist,`tsc` 不复制 md,漏掉会启动失败);web = `vue-tsc -b && vite build` |
| `pnpm start` | 生产仅启动 api(5200,托管前端 dist) |
| `pnpm typecheck` | turbo 并行 `tsc --noEmit`(api)/ `vue-tsc -b`(web);**注意 shared 改动后必须先 build** |
| `pnpm lint` | ESLint flat config(`apps/api/eslint.config.mjs` + web 侧),typescript-eslint recommended;`_` 前缀参数豁免 no-unused-vars;husky + lint-staged 提交前自动 `eslint --fix` |
| `pnpm test` | Vitest(`turbo test` dependsOn build):api:`app.test.ts`、`config.test.ts`、`src/pi/*.test.ts`(workspaceGuard/fffTools/anySearchTools/skillsLoader/subAgent/agentDefs/history/runManager/piService);web:`App.test.ts`、`ChatPane.test.ts`、`useAgent.test.ts`、`WorkspacePickerModal.test.ts`。测试用注入(env `PI_CODING_AGENT_DIR` + 临时 homeDir)隔离,不触碰真实用户目录 |

## 6. 文档与 roadmap(问题 6)

- `README.md`:功能/技术栈/数据存储/Skills 机制/端口策略/API 一览/目录结构——**无 MCP 提及**。
- `AGENTS.md`:给 AI 编码 agent 的上下文速览(结构/约定/命令/注意点)——**无 MCP 提及**。
- `docs/dag-workflow.md`:唯一的正式设计文档(DAG 工作流定稿,含决策记录 §12)——**无 MCP 提及**。
- 无 roadmap 类文档;git 提交历史(`.git/logs/HEAD`:初始化 → Hono 化 → pi SDK 对接 → 多会话 → DAG 工作流)也未出现 MCP 相关 commit。**没有任何既有的 MCP 规划**。
- 附带观察:`.wf-runs/24d5aebd` 决策记录显示本项目对 MCP 协议持「能不用就不用」的务实态度(anysearch 最终选 REST 而非 MCP 端点)——新增 MCP 功能时应考虑与之一致的取舍表述。

## 7. 关键发现与风险点

1. **无 MCP 存量,绿地接入**:仓库零 MCP 代码/依赖,接入无兼容负担;但也没有任何现成脚手架,需自建 client(stdio/HTTP/SSE)封装。
2. **工具注册是双点同步**:主代理(`piService.ts openSession`)与子代理(`subAgent.ts buildSubAgentTools`)各维护一份工具集 + `tools` 白名单,新增 MCP 工具两处都要注册,漏一处则主/子代理行为不一致(仓库已有此类回归教训,`subAgent.ts` 注释 L143-146)。
3. **工作区边界守卫不可绕过**:`workspaceGuard.ts` 只审计文件类工具路径参数;**MCP 工具若执行任意命令/读写文件,绕过了现有 bash 审计与 path 校验,形成新的逃逸面**——MCP server 命令是外部配置(如 `npx` 启动),需新增针对 MCP server 命令/参数的安全审查(与 `auditBashCommand` 同级对待),这是最大的安全风险点。
4. **会话生命周期**:skills 在会话创建时读入 system prompt;MCP server 连接若按会话创建,新增/变更 server 需重开会话(对齐 README「Skills 注意事项」的既有语义)。
5. **错误与截断纪律**:`anySearchTools.ts` 已确立 30s 超时 + AbortSignal 组合 + 50KB 截断 + 错误脱敏范式,MCP 工具应沿用,否则工具输出污染上下文。
6. **pi SDK 无原生 MCP 能力**:v0.83.0 的 `CreateAgentSessionOptions`(`node_modules/.../pi-coding-agent/dist/core/sdk.d.ts:15-58`)只有 `customTools`/`tools`/`excludeTools`/`resourceLoader`,无 mcpServers 配置——MCP client 必须自研实现(用 `@modelcontextprotocol/sdk` 官方库,其本身就是 client/server 全栈 SDK,stdio/HTTP/SSE 传输齐全)。
7. **测试基建完备**:每个工具模块都有配套 vitest(注入式隔离),新增 MCP 工具应仿 `anySearchTools.test.ts` 的 fetchImpl 注入模式,用测试桩模拟 MCP server。
8. **shared 类型改动成本**:改 `SessionEvent`/新增类型需重建 `packages/shared`,否则 api/web TS 检查失败(AGENTS.md 明确约定)。

## 8. 结论(可行性判断与建议)

**可行性:高。** 仓库是一个结构清晰、约定完备(统一响应/数据隔离/工具工厂模式/守卫/测试注入)的 Agent 工作台,MCP 接入有明确的范式可循:

- **推荐形态 v1**:MCP **client**(消费外部 MCP server 的工具),以 `ToolDefinition` 形式注册进主/子代理会话——完全复用 `createAnySearchTools` 工厂模式 + `customTools` 注册点(`piService.ts openSession`、`subAgent.ts buildSubAgentTools`);传输先支持 stdio(最简单、生态最广),HTTP/SSE 按需追加;用官方 `@modelcontextprotocol/sdk`。
- **配置**:MCP servers 列表入 `.workflows/config.json`(`StoredConfig` 扩展)+ 新增 `/api/agent/config/mcp*` 路由 + 前端设置面板。
- **必须解决的安全项**:MCP server 启动命令与工具执行的沙箱/白名单审查(不能绕过 `workspaceGuard` 的既有边界语义);server 来源不可信时按 skills 同等「只读/提示注入」风险对待。
- **不建议 v1 做**:暴露本工作台为 MCP server(需把 AgentSession/tool_* 事件桥接为 JSON-RPC + 鉴权,成本高;且仓库无任何此规划)。
- **实施顺序建议**:① 依赖接入(`pnpm --filter @workflows/api add @modelcontextprotocol/sdk`)→ ② `createMcpTools()` 工厂 + 单测(仿 anySearchTools.test.ts)→ ③ 主/子代理注册 + 配置存储与路由 → ④ 前端配置 UI → ⑤ 安全审查与文档。
