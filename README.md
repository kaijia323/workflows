# workflows — Web Agent 工作台

`@kaijia/workflows` 是一个可直接在浏览器里使用的 Web Agent 工作台:安装后运行 `wfs start`,即得一个本地 Web 应用,让 AI 代理在你的工作区里探索代码、制定计划、执行任务,全程可视化、可把关。

## 核心特性

- **工作区管理**:添加/移除本地目录作为工作区,支持只读模式(只读工作区只暴露只读工具,适合只查看不修改的场景)
- **持久化会话**:每个工作区拥有独立会话,上下文严格限定在该目录内,可随时恢复历史对话
- **流式对话**:思考过程、正文、工具调用通过 SSE 实时渲染,并统计 token 用量与费用
- **模型配置**:切换 DeepSeek 模型与思考级别,手动填入 API key 即可使用
- **工作流编排**:主代理统一调度 4 个内置子代理——explorer(探索)→ planner(计划)→ executor(执行)⇄ reviewer(审查);planner 产出计划后需**人工批准**才进入执行。运行状态在**顶部流水线**(源 → 处理 → 观测)与**右侧观测面板**(工作区/会话/用量/工具流/系统)实时呈现,点击聊天中的子代理块可回看完整对话
- **代理即 markdown 文件**:每个代理的定义就是一个 markdown 文件(frontmatter 声明能力 + 正文定义行为),可在工作台配置目录中同名覆盖或新增自定义代理
- **多来源 skills**:代理可读取来自全局、项目、工作台等多个来源的 skills,聊天框输入 `/` 即可搜索,`/skill:<name>` 即时调用
- **MCP 外部工具**:作为 MCP client 接入外部工具服务器(stdio),其工具自动注册进主代理与子代理会话,例如 `mcp__github__create_issue`
- **内置识图**:自带视觉工具(小米 mimo-v2.5),可识别截图与图片,可选开关
- **黑板产物**:每次需求处理的探索/计划/执行/审查报告都会落盘,便于追踪与复盘

## 快速开始

要求:Node.js >= 20.19.0

```bash
# 全局安装
npm i -g @kaijia/workflows
# 或使用 pnpm:pnpm add -g @kaijia/workflows

# 启动工作台
wfs start
```

启动后打开浏览器访问 **http://localhost:5200** 即可使用。

常用启动参数:

```bash
wfs start --port 5211   # 指定端口(优先级:--port > 环境变量 PORT > 默认 5200)
wfs start --dev         # 开发模式:运行数据存到包安装位置上一级的 .workflows,不写入 ~/.workflows
```

## 命令一览

| 命令 | 说明 |
| --- | --- |
| `wfs start` | 启动工作台(生产模式,默认端口 5200,托管前端与 API) |
| `wfs upgrade` | 按检测到的包管理器(pnpm/npm/yarn/bun)升级到最新版;`--dry-run` 只打印升级命令不执行 |
| `wfs --help` / `-h` | 查看帮助 |
| `wfs --version` / `-V` | 查看版本 |

升级到新版本:

```bash
wfs upgrade
```

## 配置说明

运行数据默认存储在 `~/.workflows/` 目录:

- `config.json` — API key、模型与思考级别等运行配置
- `workspaces.json` — 工作区列表
- `mcp.json` — MCP 外部工具服务器配置(可在设置面板维护,也可手工编辑)
- `agents/` — 自定义代理定义(同名覆盖内置代理,或新增代理)
- `skills/` — 工作台级 skill 来源

API key 也可以在界面右上角的设置面板中直接填写,保存后即写入 `config.json`。

## 常见问题

- **端口被占用?** 用 `wfs start --port <端口>` 指定其他端口。
- **不想让数据写入家目录?** 使用 `wfs start --dev`,运行数据会存放在包安装位置附近的 `.workflows`,便于隔离测试。
- **升级后没有生效?** 确认使用 `wfs upgrade`(或按你的包管理器重新安装 `@kaijia/workflows@latest`)后,重启 `wfs start`。

## 从源码运行

要求:Node.js >= 20.19.0,pnpm >= 10。

```bash
pnpm install
pnpm dev       # 开发模式:http://localhost:15200
```

开发文档(技术栈 / 架构 / API 一览等):[docs/development.md](docs/development.md)

## 项目地址

本项目仓库地址:https://github.com/kaijia323/workflows
