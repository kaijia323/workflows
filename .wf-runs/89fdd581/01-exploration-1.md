# 探索报告:workflows 仓库结构调研(为 Node.js bin 模式 CLI 打包做准备)

> 任务:调研 `C:/Users/kaijia/codes/github/workflows`,为把 workflows 打包成 Node.js bin 模式 CLI 做准备。
> 约束:只读调研,未修改任何代码。

---

## 1. 仓库整体结构

**形态**:pnpm + Turborepo monorepo(3 个包),根目录 `private: true`。

```
workflows/
├── package.json           # 根包(name=workflows,private,无 bin)
├── pnpm-workspace.yaml    # packages: apps/*, packages/*
├── pnpm-lock.yaml
├── turbo.json             # build/dev/typecheck/lint/test 任务管线
├── README.md              # 详尽文档(功能/存储/端口/命令/API 一览/目录结构)
├── AGENTS.md              # 给 AI 编码 agent 的上下文速览
├── .gitignore             # node_modules/dist/.turbo/.workflows/ 等
├── .husky/                # git hooks(prepare 脚本 = husky)
├── apps/
│   ├── api/               # Hono + pi SDK 后端(@workflows/api)
│   │   ├── package.json
│   │   ├── src/           # 入口 index.ts,app.ts,config.ts,mcpConfig.ts,agent/,pi/,测试
│   │   ├── scripts/       # copy-agents.mjs / verify-vision.mjs / verify-anysearch.mjs / mock-xiaomi-server.mjs
│   │   ├── tsconfig.json / tsconfig.build.json(排除 *.test.ts)
│   │   └── dist/          # tsc 构建产物
│   └── web/               # Vue 3 + Vite 前端(@workflows/web)
│       ├── package.json / vite.config.ts / index.html
│       └── src/           # components/composables/utils
├── packages/
│   └── shared/            # 纯类型包(@workflows/shared,exports dist 构建产物)
├── docs/                  # mcp.md、dag-workflow.md
├── .workflows/            # 开发运行数据(config.json/workspaces.json/agent/…,已 gitignore)
├── .wf-runs/              # 工作流运行产物(报告 + run.json,提交入库)
└── node_modules/ .turbo/
```

**构建/测试方式**:
- 构建:`pnpm build`(turbo 依赖序 shared → api/web);api 用 `tsc -p tsconfig.build.json && node scripts/copy-agents.mjs`(**agent 的 .md 定义靠脚本复制进 dist**,tsc 不处理);web 用 `vue-tsc -b && vite build`
- 测试:Vitest(api:`app.test.ts` 等;web:`App.test.ts`、`useAgent.test.ts`)
- 类型检查 `pnpm typecheck`(api: tsc --noEmit;web: vue-tsc -b);lint: ESLint 10

## 2. package.json 内容

**根 `package.json`**:

```json
{
  "name": "workflows",
  "private": true,
  "version": "0.0.0",
  "packageManager": "pnpm@10.33.0",
  "engines": { "node": ">=20.19.0" },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "start": "pnpm --filter @workflows/api start",
    "preview": "pnpm build && pnpm start",
    "prepare": "husky"
  },
  "devDependencies": { "turbo": "^2.10.8", "eslint": "^10.8.0", "vitest": "^4.1.10", "husky": "^9.1.7", "lint-staged": "^17.3.0", "typescript-eslint": "^8.65.0", "vue-eslint-parser": "^10.3.0", "@eslint/js": "^10.0.1", "globals": "^17.9.0" }
}
```

**`apps/api/package.json`**(CLI 打包最相关的包):

```json
{
  "name": "@workflows/api",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "cross-env NODE_ENV=development node --watch --import tsx/esm src/index.ts",
    "build": "tsc -p tsconfig.build.json && node scripts/copy-agents.mjs",
    "start": "cross-env NODE_ENV=production node dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "dependencies": {
    "@earendil-works/pi-ai": "^0.83.0",
    "@earendil-works/pi-coding-agent": "^0.83.0",
    "@ff-labs/fff-node": "0.10.1",
    "@hono/node-server": "^2.0.12",
    "@modelcontextprotocol/sdk": "^1.30.0",
    "@workflows/shared": "workspace:*",
    "hono": "^4.12.34",
    "picomatch": "^4.0.5",
    "typebox": "1.3.7",
    "unbash": "^4.0.5"
  }
}
```

**`apps/web/package.json`**:Vue 3.5 + marked + @lucide/vue + compressorjs;devDeps vite 8 / tailwindcss 4 / vue-tsc / jsdom。
**`packages/shared/package.json`**:纯类型包,`main/types: ./dist/*`,`files: ["dist"]`。

**关键点:四个 package.json 均无 `bin` 字段,均 `private: true`。**

## 3. 项目入口与启动方式

**API 入口 `apps/api/src/index.ts`**(生产/开发共用):

```ts
import { serve } from '@hono/node-server'
import { app, initAgentRoutes } from './app.js'

const pi = await initAgentRoutes()   // 创建 .workflows 存储 + PiAgentService + 注册路由

const isProduction = process.env.NODE_ENV === 'production'
// 对外暴露端口:生产 5200,开发 3000(可通过 PORT 覆盖)
const port = Number(process.env.PORT ?? (isProduction ? 5200 : 3000))

const server = serve({ fetch: app.fetch, port })
// SIGINT/SIGTERM → pi.dispose()(关 MCP 子进程与 fff 索引),5s 兜底强制退出
```

**启动链路**:
- 开发:`pnpm dev` = turbo 并行:web `vite`(15200,`/api` 代理 → 3000)+ api `node --watch --import tsx/esm src/index.ts`(3000)
- 生产:`pnpm start` = `cross-env NODE_ENV=production node dist/index.js`(5200,由 `app.ts` 托管 `apps/web/dist` 静态文件 + SPA fallback);`pnpm preview` = build + start

**app.ts 要点**:`initAgentRoutes()` 在启动时初始化 `PiAgentService.create()`(校验 orchestrator 代理定义存在,缺失抛错);统一 `{code,message,data}` 错误/404;生产托管前端产物。

**CLI 现状:无任何 CLI 代码。** 全仓库无 `bin` 字段、无 shebang 入口、无命令行框架;唯一的 `process.argv` 用法在辅助脚本里(见 §7)。

## 4. 端口配置

| 位置 | 内容 |
| --- | --- |
| `apps/api/src/index.ts:7` | `const port = Number(process.env.PORT ?? (isProduction ? 5200 : 3000))` — **PORT 环境变量可覆盖**,生产 5200 / 开发 3000 |
| `apps/web/vite.config.ts` | `server.port: 15200`(开发对外唯一入口),`proxy: { '/api': { target: 'http://localhost:3000' } }` |
| README「端口策略」 | 开发 15200(web)+ 3000(api 内部);生产 5200 单端口同源,可 `PORT` 覆盖 |

注意:`NODE_ENV` 同时决定**存储根**(`config.ts` 的 `workflowsRoot()`:dev → `<repo>/.workflows`,prod → `~/.workflows`),CLI 打包时需沿用/重定义该语义。

## 5. 已有的 wf 命令 / bin 脚本

**没有。** 全仓库(根 + 3 子包)package.json 无 `bin` 字段;无 `wf` 命令;无 `#!/usr/bin/env node` 的可执行入口(唯一例外:`apps/api/scripts/verify-vision.mjs` 有 shebang 但未注册为 bin,靠 `node script` 运行)。现有命令入口全部是 npm scripts(turbo 编排)。

## 6. 文档情况

- **`README.md`**(最详尽):功能列表、技术栈表、`.workflows` 数据存储、Skills/MCP 机制、端口策略表、命令表(`pnpm install/dev/build/start/preview/typecheck/lint/test`)、完整 API 一览(前缀 `/api`,统一响应结构)、目录结构
- **`AGENTS.md`**:精简上下文,含关键约定(统一响应、会话模型、workspaceGuard、SSE、`.wf-runs/` 提交入库等)
- **`docs/mcp.md`**、**`docs/dag-workflow.md`**:专项文档
- 启动方式在 README「命令」与 AGENTS.md「命令」均有说明

## 7. CLI 框架依赖与可复用 CLI 代码

- **CLI 框架:零。** 全仓库依赖中无 commander / yargs / meow / clipanion / citty / sade / oclif 等。
- **可复用的手写参数解析模式**(两个辅助脚本,Node 内置风格,无依赖):
  - `apps/api/scripts/verify-vision.mjs`:`parseArgs(argv)` 手写循环解析 `--base-url/--model/--images`(Node >= 20 也有内置 `util.parseArgs` 可用)
  - `apps/api/scripts/mock-xiaomi-server.mjs`:`parsePort(argv)` 解析 `--port`,默认 3999
- **可直接复用的服务层**:`apps/api/src/pi/piService.ts` 的 `PiAgentService` 类(`static create()`、`openSession`/`prompt`(流式回调)/`abort`/`getHistory`/`listRuns`/`dispose` 等公开方法),CLI 可绕过 HTTP 直接调用;`config.ts` 的 `createStore/loadConfig/loadWorkspaces` 等存储函数同理。api 的测试(`app.test.ts`)不启动 server 直接调 Hono app,说明核心逻辑与 HTTP 层解耦良好,适合 CLI 复用。

## 8. 核心功能模块分布

### apps/api(后端,CLI 打包主战场)

| 文件/目录 | 职责 |
| --- | --- |
| `src/index.ts` | 启动入口:端口解析(PORT env)、serve、优雅退出 |
| `src/app.ts` | Hono app:统一错误/404、`/health`、`/dag`、生产托管前端 + SPA fallback |
| `src/config.ts` | `.workflows` 存储(JSON 读写):config/workspaces/sessions、`workflowsRoot()`(dev/prod 分根)、路径工具 |
| `src/mcpConfig.ts` | `mcp.json` 独立存储(load/save/upsert/remove + 校验 + 原子写) |
| `src/agent/routes.ts` | agent 全部路由:config/workspaces/prompt(SSE)/run/mcp/skills/vision/uploads |
| `src/pi/piService.ts` | **核心服务层**(约 1000 行):`PiAgentService` = ModelRuntime + 每工作区 AgentSession 管理、工具注册(主/子代理双点)、SSE 事件映射、run 管理 |
| `src/pi/runManager.ts` | run 生命周期:create/save/snapshot/闸门(planner 人工批准)/DAG 状态 |
| `src/pi/subAgent.ts` | 子代理执行(explorer → planner → executor ⇄ reviewer)与工具集构建 |
| `src/pi/agentDefs.ts` + `agents/*.md` | 代理定义文件化(orchestrator/explorer/planner/executor/reviewer,frontmatter) |
| `src/pi/workspaceGuard.ts` | 工作区边界守卫:unbash 静态审计 bash 命令、工具 path 参数校验 |
| `src/pi/fffTools.ts` | fff-find/fff-grep 工具 + FffIndexManager(实时索引) |
| `src/pi/anySearchTools.ts` | anysearch 网络搜索工具 |
| `src/pi/visionTools.ts` | vision-understand 内置视觉工具(小米 OpenAI 兼容接口) |
| `src/pi/mcpTools.ts` | MCP client 工厂(stdio 连接生命周期 + ToolDefinition 转换) |
| `src/pi/skillsLoader.ts` / `promptLoader.ts` | 四来源 skills 加载、prompt 构建、`skillReadRoots` 放行根 |
| `src/pi/history.ts` | 会话历史渲染 |
| `scripts/copy-agents.mjs` | **build 时复制 `src/pi/agents/*.md` 到 dist**(tsc 不复制,CLI 打包必须覆盖此步) |

### apps/web(前端)
`src/components/`(ChatPane/WorkspaceRail/InfoPanel 等)、`src/composables/useAgent.ts`(SSE 接入)、`src/utils/`(markdown 渲染)。

### packages/shared
`src/index.ts`:DagNode/DagGraph/ApiResponse/Workspace/SessionEvent 等共享类型(改动需先 build 再被 api/web 消费)。

---

## 关键发现与风险点(面向 CLI 打包)

1. **从零起步**:无 bin、无 CLI 框架、无 wf 命令——需要新增 CLI 入口(如 `apps/api/src/cli.ts` + `bin` 字段 + shebang),依赖可选手写 parseArgs / Node 内置 `util.parseArgs`,不必引入 commander。
2. **ESM + NodeNext**:全部 `"type": "module"`,tsc 输出 `dist/`,CLI 入口需沿用 `.js` 相对导入与 ESM 约束;`engines: node >=20.19.0`。
3. **agent .md 不被 tsc 复制**:`copy-agents.mjs` 必须在打包流程中保留,否则 `PiAgentService.create()` 会因 orchestrator 定义缺失直接抛错。
4. **NODE_ENV 双重语义**:dev → 存储根 `<repo>/.workflows`、端口 3000;prod → `~/.workflows`、端口 5200。CLI bin 模式下需明确存储根与端口语义(可考虑 CLI 专属 env 或默认值,避免意外写入用户 home)。
5. **workspace 依赖**:api 依赖 `@workflows/shared`(workspace:*),打包发布需随包携带或抽离共享类型。
6. **服务层可复用性好**:`PiAgentService` 与 `config.ts` 存储函数不依赖 HTTP,CLI 可直接调用(`prompt` 已支持流式回调);`app.test.ts` 不启动 server 的先例也验证了这一点。
7. **守护进程/子进程资源**:MCP server 子进程与 fff 索引需 `pi.dispose()` 清理,CLI 的退出路径需复用现有 SIGINT/SIGTERM + 5s 兜底逻辑。
8. **端口覆盖已存在**:`PORT` 环境变量机制可直接沿用。

## 结论

**可行性:高。** 仓库是标准的 ESM + tsc 构建的 monorepo,核心业务逻辑(piService/config/runManager/workspaceGuard)与 HTTP 层解耦,可被 CLI 直接复用。打包成 bin 模式 CLI 的主要工作是:新增 CLI 入口文件与 bin 字段、处理 agents .md 复制与 shared 包依赖、明确 CLI 下 NODE_ENV/存储根/端口语义、复用 dispose 清理逻辑。无现成 CLI 代码可删改,也无历史包袱。
