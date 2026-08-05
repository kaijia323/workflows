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
- **MCP 外部工具**:通过设置面板(或手工编辑 `mcp.json`)添加外部 MCP server(stdio),其工具以 `mcp__<server>__<tool>` 命名注册进主代理与子代理会话(见下文「MCP(外部工具)」)
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

`mcp.json` —— MCP server 插件配置(独立于 config.json,划分清晰):

```json
{ "mcpServers": [{ "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "enabled": true }] }
```

- 由设置面板维护,亦可手工编辑;agent 无任何工具可写(与 config.json 同为 agent 不可写配置文件,由 workspaceGuard 保证;**仅当工作区不包含 `.workflows` 目录时成立**——若把本仓库根添加为工作区,`.workflows/mcp.json` 即在工作区内,bash/write/edit 均可写)
- **信任模型**:agent 与 OS 用户同权限,workspaceGuard 等护栏防误操作而非防恶意,与 config.json 同一既有局限
- **保存后立即生效**(设置面板):已打开会话自动重建工具集(忙碌会话下一回合生效),删除/禁用立即断开连接并失效;手工编辑 mcp.json 需重启进程生效

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
- **工作区边界**:工作区外的 skills 目录(`~/.pi/agent/skills`、`~/.agents/skills`、生产 `~/.workflows/skills`)对 read/ls 只读放行(放行根为子树语义,仅 skills 根之下;兄弟路径如 `~/.workflows/config.json`、`~/.workflows/mcp.json` 仍拦);fff-find/fff-grep 参数校验同样放行但**索引仍限工作区**(搜不到工作区外 skills,读取主路径是 read/ls);write/edit/bash 一律不放行。

## MCP(外部工具)

本工作台是 **MCP client**(stdio 传输):用户在设置面板添加外部 MCP server(启动命令 + 参数),
应用在会话创建时连接该 server、拉取 `tools/list`,把每个工具包装为 pi SDK 工具
(`mcp__<server>__<tool>` 命名,如 `mcp__github__create_issue`)注册进**主代理与子代理**会话。

### 配置文件 mcp.json

独立于 config.json(语义划分:config.json = 运行/密钥类配置,mcp.json = 外部工具插件配置),
与 config.json 同目录(开发 `<repo>/.workflows/mcp.json`,生产 `~/.workflows/mcp.json`),格式:

```json
{
  "mcpServers": [
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "enabled": true
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 唯一名,`/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`,≤ 40 字符 |
| `command` | 启动可执行文件(如 `npx` / `node` / `python`),**直接 spawn,不经 shell** |
| `args` | 启动参数数组(如 `["-y", "@modelcontextprotocol/server-filesystem", "/path"]`) |
| `enabled` | 是否启用;新增默认 `false`(opt-in),缺省视为未启用 |

### 配置方式与生效时机

- **设置面板**(左下角连接 → MCP · 外部工具 section):添加(默认不启用,可「添加并测试」)/ 启用禁用 / 测试连接 / 删除;也可**手工编辑 mcp.json**
- 校验失败(非法名 / 重名 / 空 command / args 非字符串数组)不会写入文件(零写入);写入为 tmp + rename 原子替换
- **保存后立即生效**:设置面板保存后已打开会话自动重建工具集(忙碌会话下一回合生效);工具调用时按最新配置解析,删除/禁用立即断开连接并失效;手工编辑 mcp.json 需重启进程生效

### 安全模型

- MCP server 是**用户显式配置的可信插件**,以当前用户权限运行,可访问本地文件与网络;仅添加信任的 server
- server 启动命令**只从 mcp.json 读取**:agent 无任何工具可写 `.workflows/mcp.json`(与 config.json 同级,由 workspaceGuard 保证:bash 静态审计限工作区内、write/edit 路径校验拦截工作区外路径、skills 只读放行根为子树语义;**该保证仅在「工作区不包含 `.workflows` 目录」时成立**——dev 下 `.workflows` 位于仓库根,若把仓库根本身添加为工作区,`.workflows/mcp.json` 就在工作区内,bash/write/edit 均可写)
- **信任模型**:agent 与 OS 用户同权限,上述护栏防误操作而非防恶意(与 config.json 同一既有局限,不构成恶意 agent 的安全边界)
- 启动不经过 shell:command/args 直接作为 argv spawn,无 shell 注入面
- **只读工作区不注册 MCP 工具**(MCP 工具可能产生工作区外副作用,只读语义 = 只读)
- 工具输出视为**不可信内容**(与 anysearch 结果同级):50KB 截断,错误文案中文脱敏(不回显 args)
- 超时:连接 10s / 工具列表 10s / 调用 60s;单 server 故障不阻塞会话打开(status 面板可见异常)

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
| GET | `/agent/mcp` | MCP server 配置 + 运行时状态列表 |
| PUT | `/agent/mcp/:name` | 新增/更新 MCP server(upsert;校验失败 400 零写入) |
| DELETE | `/agent/mcp/:name` | 删除 MCP server(404 若不存在) |
| POST | `/agent/mcp/:name/test` | 一次性测试连接(不污染缓存;返回 `{ ok, tools?, error? }`) |

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
