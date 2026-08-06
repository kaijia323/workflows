# 探索报告:@kaijia/workflows 发布到 npm 的 CLI 库

> 调研时间:2026-07-31(仓库快照);只读调研,未修改任何文件。

## 1. 仓库概览

Turborepo + pnpm 10 monorepo(`packageManager: pnpm@10.33.0`,Node >= 20.19.0),项目 = **基于 pi SDK 的 Web Agent 工作台(Web Agent 工作台 / 聊天 + 工作区 + 工具调用 + DAG 工作流编排)**。

### 目录结构

```
workflows/
├── apps/
│   ├── api/              # Hono API 服务(src/pi 为 pi SDK 服务层;src/agent 路由;src/pi/agents/*.md 内置代理定义)
│   └── web/              # Vue 3 + Vite + Tailwind CSS v4 前端(index.html title: "workflows · Agent 控制台")
├── packages/
│   ├── shared/           # 跨端共享类型(纯类型包)
│   └── cli/              # ★ 发布到 npm 的 CLI 包 @kaijia/workflows(bin: wfs)
├── docs/                 # dag-workflow.md(DAG 工作流设计)、mcp.md(MCP client 设计)
├── README.md             # 根 README(内容最全,见 §4)
├── AGENTS.md             # 给 AI 编码 agent 的上下文速览
├── turbo.json / pnpm-workspace.yaml / .npmrc(registry=https://registry.npmjs.org/)
└── kaijia-workflows-0.1.0.tgz   # 旧版 pack 产物(v0.1.0),当前 package.json 版本 0.2.1
```

### 构建/测试/发布方式

- 根 scripts:`dev` / `build`(turbo)/ `typecheck` / `lint` / `test`(Vitest)/ `start` / `preview`
- 发布:`publish:cli` = `pnpm build && pnpm --filter @kaijia/workflows publish`(根 package.json)
- CLI 包构建三件套:`scripts/prepare.mjs`(把 `apps/api/src` 整树复制进 `packages/cli/src/api`,排除 `*.test.ts`)→ `tsc -p tsconfig.json` → `scripts/copy-assets.mjs`(复制 `apps/api/src/pi/agents/*.md` 与 `apps/web/dist` → `dist/web-dist`)
- 发布产物 = 自包含 `dist/`(cli.js + api/** + api/pi/agents/*.md + web-dist/**),零 workspace 私有依赖(api 源码以复制方式随包分发)

## 2. CLI 包发布配置(packages/cli/package.json)

路径:`packages/cli/package.json`(版本 0.2.1)

```json
{
  "name": "@kaijia/workflows",
  "version": "0.2.1",
  "description": "workflows Web Agent 工作台 CLI(wfs 命令):tsc 编译 + npm 发布的自包含 npm 包",
  "type": "module",
  "bin": { "wfs": "./dist/cli.js" },
  "files": ["dist"],
  "engines": { "node": ">=20.19.0" },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "node scripts/prepare.mjs && tsc -p tsconfig.json && node scripts/copy-assets.mjs",
    "prepack": "node scripts/prepare.mjs && tsc -p tsconfig.json && node scripts/copy-assets.mjs",
    "typecheck": "tsc --noEmit"
  }
}
```

要点:

- **无 `main` 字段**(纯 CLI 包,入口只有 `bin.wfs` → `dist/cli.js`);`cli.js` 运行时读 `../package.json` 取版本号(随 files 白名单自动带上,正常)。
- `description` 是**内部实现视角**的文案(「tsc 编译 + npm 发布的自包含 npm 包」),不适合做面向用户的包描述,重写 README 时建议一并改。
- **缺少 `homepage` / `repository` / `keywords` / `license` 字段**(npm 页面展示信息不全)。
- 依赖均为公开包:`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@ff-labs/fff-node`、`@hono/node-server`、`@modelcontextprotocol/sdk`、`hono`、`picomatch`、`typebox`、`unbash`。

## 3. README.md 现状与发布排除情况

- **`packages/cli/` 下没有 README.md**——`fff-find **/*.md` 显示整个 `packages/cli`(含 dist/)零个 markdown 文件;全仓库仅根目录一个 README.md。
- **无 `.npmignore`**(全仓库 `fff-find **/.npmignore` 无结果)。
- 发布排除结论:`files: ["dist"]` 是**白名单**,但 npm 发布时**始终自动附带**包根目录的 `README.md`(以及 package.json / LICENSE),`files` 白名单**不会**排除 README。因此:**只要在 `packages/cli/README.md` 新增文件,无需任何配置改动即可随包发布**;当前没有 README,故已发布的包里也没有 README。

## 4. CLI 包功能简介(packages/cli/src/cli.ts + 根 README「CLI 发布」节)

入口 `packages/cli/src/cli.ts` 头部注释:

> workflows CLI(`wfs`)入口。零 CLI 依赖:仅用 Node 内置 util.parseArgs 完成 flag 解析与子命令分派。

- 顶层 flag:`--help/-h`、`--version/-V`
- 子命令:
  - `start [--port <port>] [--dev]` —— 启动整个工作台(生产默认端口 5200;`--port` > 环境变量 `PORT` > 5200;`--dev` 存储根 = 包上一级 `.workflows`,生产 = `~/.workflows`);动态 import `./api/index.js` 的 `startServer(port)`(Hono 服务,托管前端 + API)
  - `upgrade [--dry-run]` —— 按 `npm_config_user_agent` 探测安装器(pnpm/npm/yarn/bun)生成 `@kaijia/workflows@latest` 升级命令并执行

核心能力(工作台本体,即 CLI 启动后提供的 Web UI + API,引自根 README):

- **工作区管理**:添加/移除本地目录,支持只读模式(只读工作区仅暴露只读工具)
- **持久化会话**:每工作区独立会话(JSONL),上下文限定工作区目录,可恢复历史
- **流式对话**:思考/正文/工具调用 SSE 实时渲染,统计 token 与费用
- **模型配置**:切换 DeepSeek 模型与思考级别,手动 API key(存 `~/.workflows/config.json`)
- **工作流编排**:主代理(orchestrator)调度 4 个内置子代理 explorer(探索)→ planner(计划)→ executor(执行)⇄ reviewer(审查),planner 产出计划后**人工闸门批准**才执行,右侧 DAG 图实时展示节点状态(设计文档:`docs/dag-workflow.md`;内置代理定义:`apps/api/src/pi/agents/{orchestrator,explorer,planner,executor,reviewer}.md`)
- **代理文件化**:代理定义 = markdown(frontmatter 声明能力 + 正文定义行为),`.workflows/agents/` 同名覆盖或新增自定义代理
- **skills**:agent 可读四个来源 skills(`~/.pi/agent/skills` / `<工作区>/.pi/skills` / `.workflows/skills` / `~/.agents/skills`),`/skill:<name>` 调用
- **MCP 外部工具**:MCP client(stdio),`mcp.json` 配置,工具以 `mcp__<server>__<tool>` 注册进主/子代理(设计文档:`docs/mcp.md`)
- **黑板产物**:每次 run 的探索/计划/执行/审查报告落盘 `.wf-runs/<runId>/`,可 git 追踪
- 内置视觉工具 `vision-understand`(小米 mimo-v2.5 识图,可选开关)

## 5. 可参考的介绍文档/文案

| 来源 | 路径 | 内容与可用性 |
| --- | --- | --- |
| **根 README.md**(推荐主参考) | `README.md` | 最全:功能列表、技术栈表、存储说明、Skills/MCP 章节、端口策略、命令、**「CLI 发布(`@kaijia/workflows`,命令 `wfs`)」专节**(安装/启动/端口/升级 + 发布产物说明,已近乎一份 CLI 用户文档)、API 一览表、目录结构 |
| DAG 工作流设计文档 | `docs/dag-workflow.md` | 编排模式(orchestrator-workers)、流程定义、闸门、循环上限、权限模型——写功能简介的权威来源 |
| MCP 设计文档 | `docs/mcp.md` | MCP client 架构与配置说明 |
| AGENTS.md | `AGENTS.md` | 开发者视角的架构速览(含 CLI 包构建细节),可参考但不适合直接作为用户文案 |
| 前端标题 | `apps/web/index.html` | `<title>workflows · Agent 控制台</title>`(产品对外名称 ≈ "workflows Agent 控制台 / 工作台") |
| npm 线上页面 | registry.npmjs.org/@kaijia/workflows | 本次联网核验超时,无法确认线上展示内容;本地有 0.1.0 tarball + `publishConfig.access=public` + `publish:cli` 脚本,说明包已/预期公开发布 |

## 6. 关键发现与风险点

1. **CLI 包零 README**:发布到 npm 的 `@kaijia/workflows` 没有 README,`files:["dist"]` 不会排除 README,直接新增 `packages/cli/README.md` 即可随包发布,零配置改动。
2. **description 偏内部**:「tsc 编译 + npm 发布的自包含 npm 包」是工程视角,重写 README 时应同步改为用户视角描述(如「一键启动 Web Agent 工作台的 CLI」)。
3. **package.json 缺元信息**:无 homepage/repository/keywords/license,建议补全以提升 npm 页面展示质量。
4. **文档素材充足**:根 README「CLI 发布」节 + 功能列表 + docs/ 两份设计文档可覆盖用户 README 所需全部内容;无独立官网/宣传站点。
5. **版本轨迹**:仓库内旧 tarball 为 0.1.0,当前源码版本 0.2.1,存在多次发版;npm 线上状态未能在本次调研中联网确认(registry 直连超时),不影响 README 工作。

## 7. 结论与建议

- **可行性:高**。目标包定位清晰(`@kaijia/workflows`,`bin: wfs`),功能可完整归纳(见 §4),参考文案充足(见 §5)。
- 建议动作:
  1. 在 `packages/cli/README.md` 写面向用户的 README:项目简介(基于 pi SDK 的 Web Agent 工作台 CLI)、安装(`npm i -g @kaijia/workflows`)、快速开始(`wfs start` → http://localhost:5200)、命令参考(start/upgrade/--help/--version + 端口优先级)、功能特性(工作区/会话/流式对话/工作流编排/人工闸门/skills/MCP)、配置与存储说明(`~/.workflows/`)、升级方式;
  2. 同步更新 `packages/cli/package.json` 的 description 与元信息(homepage/repository/keywords);
  3. 可选:在根 README「CLI 发布」节与包 README 间做互相引用,避免文案分叉。
