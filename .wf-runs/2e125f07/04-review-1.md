# 审查报告:packages/cli README + package.json 元信息

> 审查时间:2026-08-07;依据 `.wf-runs/2e125f07/01-exploration-1.md` / `03-execution-1.md`、`packages/cli/README.md`、`packages/cli/package.json`,并对照源码核验(`packages/cli/src/cli.ts`、`apps/api/src/config.ts`、`apps/api/src/pi/*`、`apps/web/src/*`、`docs/mcp.md`、根 `README.md`、`.git/config`)。只读审查,未修改任何文件。

## pass

## 逐条核对结果

### 需求 1:CLI 包发布到 npm 没有 README.md → 新增

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| `packages/cli/README.md` 新建 | 通过 | 文件存在(3.6KB),探索报告确认改动前该目录零 markdown |
| README 随包发布 | 通过 | `files: ["dist"]` 为白名单,npm 发布始终自动附带包根 README;`packages/cli/` 下无 `.npmignore`(ls 核实),`package.json` 也无 `"files"` 之外的排除项,零配置即可随包发布 |

### 需求 2:README 面向用户,介绍 agent 产品而非项目

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 定位为产品介绍 | 通过 | H1「workflows — Web Agent 工作台」+ 一句话定位(安装后 `wfs start` 即得本地 Web 应用) |
| 无内部开发视角表述 | 通过 | 全文未出现「tsc 编译」「自包含 npm 包」「monorepo」「源码」等表述;原内部向 description 已替换 |

### 事实准确性(逐条对照 cli.ts / api / web / docs 核验)

| README 声明 | 状态 | 核验依据 |
| --- | --- | --- |
| `wfs start`(默认端口 5200) | 通过 | cli.ts `resolvePort` 默认 5200 |
| 端口优先级 `--port` > `PORT` > 5200 | 通过 | cli.ts `resolvePort` |
| `wfs start --dev` 不写 `~/.workflows` | 通过 | cli.ts HELP + config.ts `workflowsRoot()`(NODE_ENV=development → 包上两级 .workflows) |
| `wfs upgrade` 按 pnpm/npm/yarn/bun 检测 | 通过 | cli.ts `detectInstaller`/`upgradeCommand` |
| `wfs upgrade --dry-run` | 通过 | cli.ts `runUpgrade` |
| `wfs --help/-h`、`--version/-V` | 通过 | cli.ts 顶层 parseArgs |
| Node.js >= 20.19.0 | 通过 | package.json `engines` |
| 生产存储 `~/.workflows/` 及 config.json / workspaces.json / mcp.json / agents/ / skills/ | 通过 | config.ts `createStore`(agentsDir 注释「用户自定义代理目录(同名覆盖内置 agents)」)、routes.ts:87 mcp.json、config.ts:44 skillsDir |
| 右上角设置面板填 API key 写入 config.json | 通过 | PipelineHeader.vue 设置按钮在头部右侧;config.ts:106 saveConfig |
| 4 个子代理 explorer→planner→executor⇄reviewer | 通过 | `apps/api/src/pi/agents/` 下 5 个 .md(主代理 orchestrator + 4 子代理) |
| planner 计划后人工批准(闸门) | 通过 | piService.ts:345 闸门工具、`gate_required` 事件、tests |
| 右侧 DAG 图实时展示、点击回看子代理对话 | 通过 | useAgent.ts:160「右侧 DAG 图」;根 README:11 |
| 代理即 markdown(frontmatter + 正文,同名覆盖) | 通过 | explorer.md 带 frontmatter;config.ts agentsDir 注释 |
| 多来源 skills、`/` 搜索、`/skill:<name>` 调用 | 通过 | piService.ts:351 四来源;ChatPane 测试 `/skill:<name>` 输入/搜索 |
| MCP client(stdio),工具 `mcp__<server>__<tool>`,示例 `mcp__github__create_issue` | 通过 | docs/mcp.md:45 同一示例;piService.ts:324 mcp__ 注册 |
| 内置识图(小米 mimo-v2.5,可选开关) | 通过 | visionTools.ts(VISION_MODEL='mimo-v2.5')、piService.ts:157 开关 |
| SSE 流式渲染 + token/费用统计 | 通过 | useAgent.ts SSE;根 README:9 |
| 工作区只读模式(只暴露只读工具) | 通过 | config.ts readOnly 字段;根 README:7、127 |
| 独立会话、上下文限定工作区目录 | 通过 | piService.ts:249 sessions 按工作区隔离;根 README:8 |
| 黑板产物落盘(.wf-runs) | 通过 | 本次运行产物即位于 `.wf-runs/<runId>/` |
| 许可节仓库地址 | 通过 | `.git/config` origin = `git@github.com:kaijia323/workflows.git`,https 转写正确 |

### package.json 元信息

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 合法 JSON | 通过 | 结构完整、可解析;name/version/bin/files/engines/scripts/dependencies/devDependencies 与探索报告基线一致,未改动 |
| description 用户向 | 通过 | 已替换为产品文案,无「tsc 编译/自包含」表述 |
| keywords | 通过 | 新增 10 个,与产品能力吻合 |
| homepage | 通过 | npm 主页(仓库无独立官网,合理) |
| repository | 通过 | `https://github.com/kaijia323/workflows.git` 与 git remote origin 一致 |

### 范围控制

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 仅改 README 与元信息 | 通过 | 运行记录仅 explorer(只读调研)+ executor 两个 agent;packages/cli 下仅新增 README.md;package.json 相对探索基线仅 description/keywords/homepage/repository 四处变化;scripts/dependencies/源码未动 |
| 未新增 .npmignore 等干扰发布配置 | 通过 | 无需也不存在 |

## 问题清单(均为非阻塞小项)

1. **`packages/cli/README.md`「许可」节(L67-69)**:标题为「许可」,内容仅仓库地址链接,无实际许可声明(仓库无 LICENSE 文件,package.json 亦无 license 字段)。建议:标题改为「项目地址」,或待仓库补 LICENSE 后同步补许可说明。
2. **`packages/cli/README.md` 快速开始 `--dev` 注释(L42)**:「运行数据存到包所在位置的 .workflows」措辞不精确——实际为包安装位置的**上一级**(全局安装为 `node_modules/.workflows`,见 cli.ts HELP)。建议改为「包安装位置上一级的 .workflows」;同文件 FAQ(L63)「包安装位置附近」写法已准确。
3. **`packages/cli/package.json` 缺 `license` 字段**(advisory):执行报告已记录跳过原因(仓库无 LICENSE 文件),不阻塞本次需求;建议仓库补充 LICENSE 后补填。

## 最终建议

**通过**。需求 1、2 均达成:README 位于 `packages/cli/` 且会随 npm 发布;内容面向最终用户、全部事实(命令/参数/端口/存储/特性)经源码与文档逐一核验无编造、无夸大;package.json 合法且元信息正确;范围控制良好,未动源码逻辑。上述 3 项小问题可后续顺手修订,不影响本次交付。未发现需打回执行或重做计划的问题。
