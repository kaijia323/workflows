# workflows

Turborepo monorepo — 基于 pi SDK 的 Web Agent 工作台(DAG 可视化骨架)。

## 功能

- **工作区管理**:添加/移除本地目录,支持只读模式(只读工作区仅暴露只读工具)
- **持久化会话**:每个工作区独立会话,上下文严格限定在该目录,可恢复历史
- **流式对话**:思考过程 / 正文 / 工具调用以 SSE 实时渲染,统计 token 用量与费用
- **模型配置**:切换 DeepSeek 模型与思考级别,手动填入 API key(存于 `.workflows/config.json`)
- **工作流编排**:主代理(总指挥)调度 4 个内置子代理(explorer 探索 → planner 计划 → executor 执行 ⇄ reviewer 审查),计划需人工闸门批准;右侧 DAG 图实时展示节点状态,点击查看子代理完整对话(模态窗)
- **代理文件化**:代理定义 = markdown(frontmatter 声明能力 + 正文定义行为),内置随代码分发,`.workflows/agents/` 同名覆盖或新增自定义代理
- **skills 读取**:agent 可读取四个来源的 skills(`~/.pi/agent/skills` / `<工作区>/.pi/skills` / `.workflows/skills` / `~/.agents/skills`),聊天框输入 `/` 弹出搜索下拉,`/skill:<name>` 即时调用(见下文「Skills」)
- **黑板产物**:每次需求处理(run)的探索/计划/执行/审查报告落盘 `.wf-runs/<runId>/`,可 git 追踪

## 技术栈

| 包 | 技术 |
| --- | --- |
| `apps/web` | Vue 3 + TypeScript + Vite + Tailwind CSS v4 + marked |
| `apps/api` | Hono + `@hono/node-server` + pi SDK(`@earendil-works/pi-coding-agent`、`pi-ai`) |
| `packages/shared` | 跨端共享类型 |

## 数据存储(`.workflows/`)

运行数据(API key / 工作区 / 会话 / 代理覆盖)全部隔离在项目自己的 `.workflows/` 目录,**不写** pi 全局配置(`~/.pi/agent`);仅**只读**其 `skills` 子目录作为 skill 来源(见「Skills」):

| 环境 | 存储位置 |
| --- | --- |
| 开发 | `<repo>/.workflows`(已 gitignore) |
| 生产 | `~/.workflows` |

包含 `config.json`(API key / 模型 / 思考级别)、`workspaces.json`(工作区列表)、
`workspace-sessions.json`(会话文件索引)、`agent/`(pi ModelRuntime 的 auth/models 与会话文件)、`skills/`(工作台 skill 来源)。

## Skills(技能)

agent 通过 **Agent Skills** 机制(pi SDK `loadSkills`)加载四个来源的 skills,
聊天框输入 `/` 弹出搜索下拉(名称前缀 > 名称包含 > 描述匹配,最多 8 条),
`ArrowDown/Up` 循环高亮、`Enter` 选中填入 `/skill:<name> `(回车发送,可追加参数)、`Esc`/`blur`/切工作区关闭,每项标注来源标签。

### SKILL.md 格式

每个 skill = 一个目录,内含 `SKILL.md`(frontmatter + 正文指令):

```markdown
---
name: greet            # 可选,缺省回退目录名(小写字母/数字/连字符)
description: 用中文打招呼  # 必填,缺失则整个 skill 不加载
disable-model-invocation: false  # 可选;true 时不注入 system prompt,只能 /skill:name 显式调用
---
<正文指令:告诉模型该 skill 的用法/约束>
```

目录含 `SKILL.md` 即整个目录一个 skill(不递归);无 `SKILL.md` 时扫描根下散落的 `.md`。

### 四来源目录

| 来源 | 目录 | 分类标签 | 加载方式 |
| --- | --- | --- | --- |
| pi 全局 | `~/.pi/agent/skills`(Windows:`C:\Users\<user>\.pi\agent\skills`) | 全局(pi) | `includeDefaults`(SDK 默认 `getAgentDir()`;`PI_CODING_AGENT_DIR` 环境变量可重定向) |
| 项目 | `<工作区>/.pi/skills` | 项目 | `includeDefaults` 附带(`cwd` = 工作区) |
| 工作台 | `<root>/.workflows/skills`(开发 = 仓库根,生产 = `~/.workflows`) | 工作台 | `skillPaths` 显式 |
| 全局 agents | `~/.agents/skills`(Windows:`C:\Users\<user>\.agents\skills`) | 全局(agents) | `skillPaths` 显式 |

### 注意事项

- **新增/修改 skill 后需重开会话**:skills 在会话创建时读入 system prompt,下拉列表可重开工作区即时刷新(端点现扫),但模型要感知新 skill 必须新建会话或重启 api;`/skill:<name>` 展开始终即时可用。
- **安全提示**:skill 正文是任意指令,来源可能不可信,使用前请 review;`disable-model-invocation: true` 可让 skill 不进 system prompt(仅显式调用)。
- 这些目录**仅只读**,本应用运行数据仍只写 `.workflows/`。

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
| GET | `/agent/workspaces/:id/skills` | 工作区可用 skills 列表(输入框 `/` 下拉数据源) |
| POST | `/agent/workspaces/:id/prompt` | 发送消息(**SSE 流式**返回事件) |
| POST | `/agent/workspaces/:id/abort` | 中止当前生成 |
| GET | `/agent/workspaces/:id/run` | 当前 run 快照(DAG 图 / 闸门状态 / 恢复) |
| GET | `/agent/workspaces/:id/run/agents/:callId` | 子代理调用历史(模态窗回看) |

统一响应结构:`{ code, message, data }`。

## 目录结构

```
workflows/
├── apps/
│   ├── api/              # Hono API 服务(生产时托管 web/dist)
│   │   └── src/
│   │       ├── agent/    # agent 相关路由(配置/工作区/会话)
│   │       ├── pi/       # pi SDK 服务层(ModelRuntime + 会话管理)
│   │       └── config.ts # .workflows 存储(JSON 读写)
│   │       └── app.ts    # Hono app(静态托管 + SPA fallback)
│   └── web/              # Vue 3 前端(dev 15200 / 构建产物 dist)
│       └── src/
│           ├── components/   # ChatPane / WorkspaceRail / InfoPanel 等
│           ├── composables/  # useAgent(SSE 接入、消息聚合)
│           └── utils/        # markdown 渲染
├── packages/
│   └── shared/           # 共享类型(构建产物供 api/web 消费)
├── .workflows/           # 本地运行数据(开发环境,已 gitignore)
└── turbo.json
```
