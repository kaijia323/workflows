# dag-pi

Turborepo monorepo — 基于 pi SDK 的 Web Agent 工作台(DAG 可视化骨架)。

## 功能

- **工作区管理**:添加/移除本地目录,支持只读模式(只读工作区仅暴露只读工具)
- **持久化会话**:每个工作区独立会话,上下文严格限定在该目录,可恢复历史
- **流式对话**:思考过程 / 正文 / 工具调用以 SSE 实时渲染,统计 token 用量与费用
- **模型配置**:切换 DeepSeek 模型与思考级别,手动填入 API key(存于 `.dag-pi/config.json`)
- **DAG 骨架**:`/api/dag` 示例接口(可视化流水线待后续迭代)

## 技术栈

| 包 | 技术 |
| --- | --- |
| `apps/web` | Vue 3 + TypeScript + Vite + Tailwind CSS v4 + marked |
| `apps/api` | Hono + `@hono/node-server` + pi SDK(`@earendil-works/pi-coding-agent`、`pi-ai`) |
| `packages/shared` | 跨端共享类型 |

## 数据存储(`.dag-pi/`)

所有数据隔离在项目自己的 `.dag-pi/` 目录,**不读取/不修改 pi 全局配置(`~/.pi/agent`)**:

| 环境 | 存储位置 |
| --- | --- |
| 开发 | `<repo>/dag-pi/.dag-pi`(已 gitignore) |
| 生产 | `~/.dag-pi` |

包含 `config.json`(API key / 模型 / 思考级别)、`workspaces.json`(工作区列表)、
`workspace-sessions.json`(会话文件索引)、`agent/`(pi ModelRuntime 的 auth/models 与会话文件)。

## 端口策略(对外只暴露一个入口)

前后端同源部署,**用户只访问一个地址**:

| 环境 | 对外端口 | 说明 |
| --- | --- | --- |
| 开发 | **15200** | Vite dev server 托管页面,`/api` 自动代理到后端 3000(内部端口,不对外) |
| 生产 | **5200** | Hono 托管前端构建产物 + API,单端口同源(可 `PORT` 覆盖) |

## 命令

要求:Node >= 20.19.0,pnpm >= 10(`packageManager: pnpm@10.33.0`)。

```bash
pnpm install     # 安装依赖
pnpm dev         # 开发:web(15200)+ api(3000),http://localhost:15200
pnpm build       # 构建所有包(shared → api/web)
pnpm start       # 生产启动:仅启动已构建的 API(5200,托管前端)
pnpm preview     # 打包前后端 → 自动执行 start(生产模式,5200)
pnpm typecheck   # 类型检查(turbo 并行)
pnpm lint        # ESLint
pnpm test        # Vitest(依赖 build)
```

## API 一览(前缀 `/api`)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/dag` | DAG 骨架示例数据 |
| GET | `/agent/meta` | 存储根目录与环境 |
| GET/PUT | `/agent/config`、`/agent/config/key` | 运行配置 / 设置 API key |
| POST | `/agent/config/model`、`/agent/config/thinking` | 切换模型 / 思考级别 |
| GET/POST | `/agent/workspaces` | 工作区列表 / 添加 |
| PATCH/DELETE | `/agent/workspaces/:id` | 修改只读属性 / 移除 |
| POST | `/agent/workspaces/:id/open` | 打开会话并恢复历史 |
| GET | `/agent/workspaces/:id/status` | 会话状态(模型/用量/是否流式中) |
| POST | `/agent/workspaces/:id/prompt` | 发送消息(**SSE 流式**返回事件) |
| POST | `/agent/workspaces/:id/abort` | 中止当前生成 |

统一响应结构:`{ code, message, data }`。

## 目录结构

```
dag-pi/
├── apps/
│   ├── api/              # Hono API 服务(生产时托管 web/dist)
│   │   └── src/
│   │       ├── agent/    # agent 相关路由(配置/工作区/会话)
│   │       ├── pi/       # pi SDK 服务层(ModelRuntime + 会话管理)
│   │       ├── config.ts # .dag-pi 存储(JSON 读写)
│   │       └── app.ts    # Hono app(静态托管 + SPA fallback)
│   └── web/              # Vue 3 前端(dev 15200 / 构建产物 dist)
│       └── src/
│           ├── components/   # ChatPane / WorkspaceRail / InfoPanel 等
│           ├── composables/  # useAgent(SSE 接入、消息聚合)
│           └── utils/        # markdown 渲染
├── packages/
│   └── shared/           # 共享类型(构建产物供 api/web 消费)
├── .dag-pi/              # 本地运行数据(开发环境,已 gitignore)
└── turbo.json
```
