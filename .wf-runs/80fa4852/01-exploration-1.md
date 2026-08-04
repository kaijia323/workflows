# 探索报告:workflows 项目调研(工作流编排 / agent 定义 / 交互 / 外部访问 / 配置)

> 任务:调研 `C:/Users/kaijia/codes/github/workflows` 项目,回答 6 个问题(项目结构、workflow 定义方式、暂停询问用户、外部 URL 访问、现成"外部资源挑选"示例、agent 配置),产出文件级报告供下一步制定实施计划。
> 本报告即本次 run(`80fa4852`)的探索产物,位于 `<repo>/.wf-runs/80fa4852/`。

---

## 1. 仓库概览

### 1.1 这是什么类型的项目

**不是**通用 workflow 引擎,也**不是** GitHub Actions。它是一个**自研的 Web Agent 工作台**(聊天 + 工作区 + 工具调用),并在其上实现了一层**"主代理编排(orchestrator-workers)"式的工作流编排**:用户在工作台对某个本地目录(工作区)下发需求,主代理(orchestrator)临场调度 4 个内置子代理(explorer → planner → executor ⇄ reviewer)完成,计划需人工闸门批准。**"运行一个 workflow" = 向某个工作区的 agent 会话发一条消息**,工作流由主代理的提示词策略驱动,而非 YAML/JSON 声明。

### 1.2 技术栈(见 `package.json`、`apps/api/package.json`、`apps/web/package.json`)

| 层 | 技术 |
| --- | --- |
| 仓库 | Turborepo + pnpm 10 monorepo(`pnpm-workspace.yaml`;Node >= 20.19) |
| `apps/web` | Vue 3 + TypeScript + Vite + Tailwind CSS v4 + marked + @lucide/vue(SSE 流式聊天 UI) |
| `apps/api` | Hono + `@hono/node-server` + **pi SDK**(`@earendil-works/pi-coding-agent@^0.83.0`、`@earendil-works/pi-ai@^0.83.0`)+ `typebox@1.3.7` + `@ff-labs/fff-node@0.10.1`(Rust 索引搜索)+ `unbash@^4.0.5`(bash 静态审计) |
| `packages/shared` | 纯类型包(改动后必须先 `pnpm build` 才被 api/web 消费) |

关键设计约束:**不读取/不修改 pi 全局配置(`~/.pi/agent`)**,一切运行数据隔离在项目自身 `.workflows/`(开发环境在仓库根,已 gitignore;生产在 `~/.workflows`)。

### 1.3 目录结构与入口

```
workflows/
├── apps/api/src/
│   ├── index.ts            # 启动入口:serve Hono,端口 PORT(生产 5200 / 开发 3000)
│   ├── app.ts              # Hono app + initAgentRoutes() + 生产托管前端 + SPA fallback
│   ├── agent/routes.ts     # 全部 HTTP 路由(/api/agent/...)
│   ├── config.ts           # .workflows 存储(config/workspaces/sessions JSON 读写)
│   └── pi/
│       ├── piService.ts    # ★ 核心服务层:会话/工具注册/子代理与闸门工具/run 生命周期
│       ├── subAgent.ts     # ★ 子代理运行器:独立 AgentSession + 工具集构建 + 产物检测
│       ├── runManager.ts   # ★ run 生命周期:run.json / 归并 / 回合结束决策
│       ├── agentDefs.ts    # ★ 代理定义加载:frontmatter 解析 + write 白名单 glob
│       ├── agents/*.md     # ★ 内置代理定义(主代理 + 4 子代理),即系统提示词
│       ├── fffTools.ts     # fff-find / fff-grep 自定义工具(工作区索引搜索)
│       ├── anySearchTools.ts # anysearch-search 网络搜索工具(外部信息)
│       ├── workspaceGuard.ts # 工作区边界守卫(路径审计 + bash 命令审计)
│       ├── promptLoader.ts # 极简 ResourceLoader(注入 system prompt)
│       └── history.ts      # 会话历史渲染
├── apps/web/src/
│   ├── composables/useAgent.ts # SSE 接入、事件聚合、闸门/run 状态
│   └── components/           # ChatPane(闸门按钮)/ DagPanel(DAG 图)/ SubAgentModal 等
├── packages/shared/src/index.ts # 共享类型:SessionEvent / RunSnapshot / RunStatus 等
├── docs/dag-workflow.md    # 工作流编排设计文档(已实现,是权威语义说明)
├── .workflows/             # 本地运行数据(gitignore;agents/ 目录当前为空)
└── .wf-runs/               # ★ 每次需求处理的产物黑板(git 可追踪)
```

### 1.4 构建/测试/运行

```bash
pnpm install   # 安装
pnpm dev       # 开发:web 15200(Vite, /api 代理到 3000)+ api 3000
pnpm build     # shared → api/web;api 构建时 scripts/copy-agents.mjs 把 agents/*.md 复制到 dist/pi/agents
pnpm start     # 生产:仅 API 5200(托管前端构建产物)
pnpm typecheck / lint / test   # Vitest(apps/api/src/pi/*.test.ts 等)
```

### 1.5 如何"定义并运行一个 workflow/agent 任务"

1. 用户在网页左侧添加本地目录为工作区(可只读);打开会话。
2. 发送需求文本 → `POST /api/agent/workspaces/:id/prompt`(SSE)→ `PiAgentService.prompt`(`piService.ts`)→ 主代理(orchestrator)会话。
3. 主代理根据 `orchestrator.md` 的调度策略,通过**子代理工具**(`explorer` / `planner` / `executor` / `reviewer`,每个都是 TypeBox 参数为 `{task}` 的工具)依次调用;每次调用在 `createSubAgentTool.execute`(`piService.ts`)中经 `runSubAgent`(`subAgent.ts`)启动一个**独立的子代理 AgentSession**。
4. 子代理产物写入黑板 `<workspace>/.wf-runs/<runId>/NN-role-N.md`;摘要文本返回给主代理;plan 完成后主代理调 `wait_for_approval` 暂停等用户批准;批准后用户再发消息续跑;最终 `complete_task` 声明完成,run 置 `done`。

---

## 2. 需求相关模块清单(文件级)

| 文件 | 一句话说明 |
| --- | --- |
| `apps/api/src/pi/piService.ts` | 核心:主代理会话创建、工具注册(`customTools` + `tools` 白名单)、子代理工具/`wait_for_approval`/`complete_task` 工具内联实现、run 回合决策、SSE 事件映射 |
| `apps/api/src/pi/subAgent.ts` | 子代理运行器:独立会话 + `buildSubAgentTools`(只读 + fff + write 白名单)、产物命名/检测、`sub_*` 事件镜像 |
| `apps/api/src/pi/runManager.ts` | run 生命周期:创建/归并/快照/`decideTurnEnd` 回合结束决策(闸门优先) |
| `apps/api/src/pi/agentDefs.ts` | 代理定义加载:frontmatter 解析(name/agents/tools/write)、用户覆盖、write 白名单 glob 编译与匹配 |
| `apps/api/src/pi/agents/*.md` | 5 个内置代理定义(系统提示词):`orchestrator.md`(调度策略)、`explorer.md`、`planner.md`、`executor.md`、`reviewer.md` |
| `apps/api/src/pi/anySearchTools.ts` | `anysearch-search` 网络搜索工具(REST POST,Node fetch,30s 超时,50KB 截断,匿名可用) |
| `apps/api/src/pi/fffTools.ts` | `fff-find`/`fff-grep` 工作区内索引搜索工具(毫秒级) |
| `apps/api/src/pi/workspaceGuard.ts` | 工作区边界守卫:`guardPathTool` 路径校验 + `createWorkspaceBashHook` 静态审计 bash 命令 |
| `apps/api/src/pi/promptLoader.ts` | `createPromptOnlyLoader`:注入 system prompt / appendSystemPrompt,不触碰 pi 扩展 |
| `apps/api/src/config.ts` | `.workflows/config.json`(apiKey/anySearchApiKey/model/thinkingLevel)+ workspaces + sessions 存储 |
| `apps/api/src/agent/routes.ts` | HTTP 路由:config/key/model/thinking、workspaces、sessions、prompt(SSE)、run 快照、子代理历史 |
| `apps/api/src/app.ts` / `index.ts` | Hono app 组装 / 启动入口 |
| `packages/shared/src/index.ts` | 共享类型:`SessionEvent`(含 `sub_*`、`gate_required`)、`RunSnapshot`、`RunStatus`、`RunAgentCall` |
| `apps/web/src/composables/useAgent.ts` | 前端 SSE 接入、`gate_required` 事件处理、`dismissGate`/`sendMessage` |
| `apps/web/src/components/ChatPane.vue` | 闸门 UI:`approvePlan()`(发"用户已批准计划,继续执行")/ `rejectPlan()`(发"用户驳回:<意见>,请修改计划") |
| `apps/web/src/components/DagPanel.vue` | 右侧 DAG 图:explorer → planner → ⏸闸门 → executor ⇄ reviewer 节点状态 |
| `docs/dag-workflow.md` | 设计文档(与实现一致):流程/权限/数据模型/闸门交互/恢复/决策记录 |
| `.wf-runs/*/` | 历史 run 产物(本 run 之前的 8 个 run 均为项目内部开发任务,见 §6) |

---

## 3. 六个问题的详细回答

### Q1 项目整体结构 —— 见 §1。要点重申

- 入口:`apps/api/src/index.ts` → `app.ts` → `agent/routes.ts` → `pi/piService.ts`。
- "运行一个任务" = 向工作区会话发消息;工作流由主代理提示词驱动,子代理是工具。

### Q2 workflow / agent 的定义方式:markdown 文件化 + 主代理编排,支持多步与中间结果传递

**不是 YAML/JSON 声明式工作流**。定义分两层:

1. **代理定义 = markdown 文件**(frontmatter 声明能力 + 正文定义行为),解析在 `agentDefs.ts`:
   - frontmatter 字段:`name`(必填)、`description`、`agents`(主代理的子代理白名单)、`tools`(工具白名单,省略 = 只读默认)、`write`(可写目标 glob,省略 = 纯只读,`**` = 全量写)。
   - 内置:`apps/api/src/pi/agents/*.md`;用户覆盖/新增:`.workflows/agents/*.md`(同名覆盖,当前为空目录,即无自定义代理)。**新增自定义代理 = 丢一个 md 文件,零代码**。
2. **工作流步骤与调度策略在 `orchestrator.md` 正文**中定义:
   - 复杂需求:`explorer(探索)→ planner(计划)→ wait_for_approval(人工闸门)→ executor(执行)⇄ reviewer(审查,最多 3 轮)→ complete_task(完成)`;简单需求可跳过 planner/reviewer。
   - 主代理被约束"只调度不亲自执行",子代理工具一次只调一个。

**多步执行 + 中间结果传递:黑板(blackboard)模式**,代码在 `runManager.ts` + `subAgent.ts`:

- 每次子代理调用的产物落盘 `<workspace>/.wf-runs/<runId>/`:`01-exploration-N.md` → `02-plan-N.md` → `03-execution-N.md` → `04-review-N.md`(N 为同 run 同角色调用序号,由 `nextArtifactName` 生成,注入子代理 prompt)。
- 每个子代理被要求"先读产物目录中最新的上一份报告"(见各 .md 正文),即**通过文件传递中间结果**;同时子代理最终摘要文本返回主代理上下文(子代理内部细节不进主上下文,只留摘要)。
- `run.json`(runManager.ts)记录 run 状态、闸门、每次子代理调用(callId/agent/summary/artifact/sessionFile)。
- run 状态机:`planning → awaiting_approval → executing → reviewing → done`(`packages/shared/src/index.ts` 的 `RunStatus`;`reviewing` 为计划内字段)。
- 循环上限由代码兜底:`piService.ts` `createSubAgentTool` 中 executor⇄reviewer 3 轮、回 planner 2 次,超限抛错强制收尾。

### Q3 交互能力:有完整的"暂停询问用户"机制(wait_for_approval 人工闸门)

**有,且是核心特性**,全链路如下:

1. **服务端工具**:`piService.ts` `createWaitForApprovalTool()`(工具名 `wait_for_approval`,参数 `summary`):
   - 置 `run.status = 'awaiting_approval'`、`run.gate = { pending: true, planFile }` 并落盘(`runManager.ts` 的 `detectPlanFile` 找最新 `02-plan*.md`);
   - 发 `gate_required` SSE 事件(shared 类型),返回"立即停止回合"文本。
2. **回合结束决策**:`runManager.ts` `decideTurnEnd` —— 调过闸门 → `awaiting_approval`(不释放 run);闸门优先于 complete_task。
3. **前端交互**:`ChatPane.vue` 的 `approvePlan()` / `rejectPlan()` —— 批准:发普通消息 `"用户已批准计划,继续执行"`;驳回:发 `"用户驳回:<意见>,请修改计划"`(回 planner)。**复用现有 prompt 接口续跑,无长连接、无异步工具结果,断线/重启可恢复**。`DagPanel.vue` 渲染 ⏸ 闸门节点与"计划待批准"提示。
4. 对称的 `complete_task` 工具(`createCompleteTaskTool`)显式声明任务完成,run 置 `done` 并释放。

其他交互:`abort` 接口中止生成;闸门等待点是天然恢复点(§8 of docs/dag-workflow.md)。没有独立的 `ask_user` / `wait_for_input` 通用工具——**唯一的"询问用户"机制就是 `wait_for_approval` 闸门**(计划批准),要扩展"执行中任意节点询问选择"需新增类似工具。

### Q4 外部访问能力:部分具备

**现状盘点**(关键差异:主代理 vs 子代理):

| 通道 | 主代理(读写工作区) | 主代理(只读工作区) | 子代理(explorer/planner/reviewer) | executor |
| --- | --- | --- | --- | --- |
| `anysearch-search` 网络搜索 | ✅ | ✅ | ❌ | ❌ |
| bash(`curl` / `git clone`) | ✅(守卫未拦截) | ❌(无 bash) | ❌(无 bash) | ✅ |
| 专用 fetch-URL / git 工具 | ❌ 不存在 | ❌ | ❌ | ❌ |

- **网络搜索**:`anysearchTools.ts` —— `anysearch-search` 工具,REST `POST https://api.anysearch.com/v1/search`,Node 原生 fetch,30s 超时 + AbortSignal 透传,输出 50KB 字节安全截断,key 解析 env `ANYSEARCH_API_KEY` > `.workflows/config.json` 的 `anySearchApiKey` > 匿名。注册点:`piService.ts` `openSession` 中 `webTools` 加入 `customTools` 且名字列入 `tools` 白名单(只读/读写两分支都有)。**注意:子代理工具集(`subAgent.ts` `buildSubAgentTools`)没有加入 webTools,子代理无法联网搜索。**
- **bash 抓 URL / git clone**:`workspaceGuard.ts` 的审计只覆盖 `FILE_PATH_COMMANDS`(cat/rm/cp/.../ls 等)的参数路径、重定向目标、cd、嵌套命令替换;`git`/`curl` 不在审计清单,且 `git clone <url>` 落点在工作区内(相对 cwd),故**技术上可执行**。但这是"未显式禁止"而非"显式支持",且依赖工作区为读写、调用方有 bash(主代理/executor)。
- **无任何现成 git clone / fetch-url 示例**:全库 grep `git clone|curl|fetch(` 无命中(仅 anySearchTools 内部 fetch 调用);历史 run `24d5aebd` 的探索报告明确记录过:"本会话工具集无 bash/curl,`read` 无法抓取 URL(实测 ENOENT),官方文档未能联网核实"。

**结论**:外部访问目前只有"网络搜索(返回 Markdown 片段)"一条正式通道;要"抓取 GitHub 仓库内容/远程文件",需新增专用工具(仿 `anySearchTools.ts` 模式:Node fetch + AbortSignal + 截断,或在 `buildSubAgentTools` 中给子代理开放网络工具)。

### Q5 现成"查看外部资源库并挑选"示例:没有,但能力拼图齐全

- `.wf-runs/` 下 8 个历史 run 全部是**项目内部开发任务**:AnySearch 工具落地(`24d5aebd`)、runId 粒度修正(`2a2b4d0d`)、run 写盘/冻结(`4a6bb996`、`696fc399`)、空 run 机制(`6f5a33ee`)、模态窗修复(`46569220`)、.wf-runs 机制调研(`d06adb0f`)、前端图标(`dbc5f020`)。**没有任何"读取 awesome-list / 调研某 GitHub 仓库后做选择"的示例**。
- 但支撑该场景的机制全部就位:① `anysearch-search` 可拿外部信息(搜索结果含 title/url/snippet/content);② explorer 子代理可做调研判断并落盘报告;③ `wait_for_approval` 可在"挑选结果"后暂停征求用户确认(或直接用普通文本询问);④ 黑板产物可记录候选清单。**缺口只有一个:子代理(explorer/planner)当前没有网络工具**(anysearch 未注册进 `buildSubAgentTools`),且 explorer 的 `write` 白名单只允许 `.wf-runs/*/01-exploration-*.md`(要输出"选择清单"类新产物需扩展白名单或加新代理)。

### Q6 agent 配置:模型/系统提示词/自定义指令

- **模型与思考级别**:存 `.workflows/config.json`(`config.ts` 的 `StoredConfig`:`apiKey`、`anySearchApiKey`、`model`、`thinkingLevel`);默认模型 `deepseek-v4-flash`(`piService.ts` `DEFAULT_MODEL`)。运行配置经 `POST /api/agent/config/model`、`POST /api/agent/config/thinking` 切换(路由在 `routes.ts`;`piService.setModel`/`setThinkingLevel` 同步到已开会话)。当前配置文件含 `thinkingLevel: "max"`(具体 key 值不入本报告)。
- **系统提示词与自定义指令**:
  - 每个代理 = md 文件,正文即 system prompt:内置 `apps/api/src/pi/agents/*.md`;**用户自定义/覆盖 = 在 `.workflows/agents/` 放同名或新名 md**(同名覆盖内置;新名注册为新代理,`agentDefs.ts` 加载优先级用户 > 内置)。当前 `.workflows/agents/` 为空。
  - 注入机制:`promptLoader.ts` `createPromptOnlyLoader` —— 主代理 = 默认 prompt + `orchestrator.body` 追加;子代理 = `definition.body`(在 `runSubAgent` 中)。
  - 主代理的可用子代理白名单来自 orchestrator frontmatter 的 `agents` 字段(`piService.ts` 组装 `subAgentTools`)。
  - 注意:内置 md 由 `apps/api/scripts/copy-agents.mjs` 在 build 时复制到 dist;**改 md 后生产需重新 `pnpm build`**(dev 直接跑 src 不受影响);`PiAgentService.create()` 启动时校验 orchestrator 定义存在,缺失即抛错。

---

## 4. 关键发现与风险点

1. **子代理无外部网络能力**(`subAgent.ts` `buildSubAgentTools` 只含 read/ls/fff + write 白名单;anysearch 只注册在主代理)。这是"调研外部 GitHub 仓库 / awesome-list 并挑选"类需求的最大缺口,也是实施计划的最关键改动点。
2. **工作区边界守卫是"护栏"而非安全边界**:bash 中 `curl`/`git clone` 未被路径审计拦截(设计取舍,`workspaceGuard.ts` 注释明确);如需正式支持"抓 URL",建议新增专用 fetch 工具(仿 anySearchTools:fetch + AbortSignal + 50KB 截断 + key 脱敏),而不是依赖 bash 隐式放行。
3. **write 白名单 glob 决定子代理可写范围**(`agentDefs.ts` `compileWriteMatcher`/`isWriteAllowed` + `subAgent.ts` `guardWriteTool`):新需求若让 explorer 产出"候选清单"类产物,需在其 `write` 白名单加新模式(如 `.wf-runs/*/05-selection-*.md`),或在 `.workflows/agents/` 覆盖/新增代理定义(零代码)。
4. **新增/修改工具的三处同步**(已有先例 AnySearch):`anySearchTools.ts`(或新文件)定义 → `piService.ts` `openSession` 的 `customTools` + `tools` 白名单(只读/读写两分支)→ 如子代理也要用则 `subAgent.ts` `buildSubAgentTools`;SDK 的 `allowedToolNames` 会过滤 customTools,**不列入白名单即不可用**。
5. **shared 类型改动需先 `pnpm build`** 再被 api/web 消费(workspace 依赖构建产物),否则 TS 检查失败。
6. **产物目录 `.wf-runs/` 已 git 追踪**(不在 .gitignore;只有 `.workflows/` 被忽略),done 后 `run.json` 冻结不再改写;删会话不删产物。
7. 循环上限、闸门优先、崩溃恢复(状态落盘 + 快照重建)等机制成熟,新功能应复用而非另起炉灶;`docs/dag-workflow.md` 是权威语义文档,改动前先对齐。
8. 历史 run 均为内部开发任务,无外部资源挑选先例——新实施计划将首次打通"外部信息 → 子代理判断 → 闸门确认"链路。

---

## 5. 结论:可行性判断与建议

**可行性:高。** 项目本身就是"探索 → 计划 → 闸门 → 执行 → 审查"的 agent 编排框架,本次调研任务即运行在该框架上;外部信息通道(`anysearch-search`)、暂停确认(`wait_for_approval`)、黑板产物、代理文件化等能力均已存在并经过生产验证。

**面向"调研外部资源库并挑选"类需求的最小实施路径建议**:

1. **网络能力下沉到子代理**:在 `subAgent.ts` `buildSubAgentTools` 中把 `createAnySearchTools(...)`(或新增的 fetch-url 工具)加入子代理工具集与 `activeNames` 白名单——让 explorer/planner 能联网查外部仓库/文档/awesome-list(改 1 个文件 + 补测试,参考 `anySearchTools.test.ts`)。
2. **(可选)新增 fetch-URL 专用工具**:仿 `anySearchTools.ts` 建 `fetchUrlTools.ts`(Node fetch、30s 超时、50KB 截断、AbortSignal 透传、可选 key),在 `piService.openSession` 注册,并在子代理工具集同步开放,满足"抓取 GitHub 仓库 README/文件内容"的精确需求。
3. **(可选)扩展产物模式**:给 explorer 的 `write` 白名单加新产物模式(如 `05-selection-*.md`)或在 `.workflows/agents/` 新增"选择器"代理(如 `selector.md`),把候选清单/选择结论落盘黑板。
4. **复用闸门**:在需要用户"挑选确认"的节点,沿用 `wait_for_approval` 机制(工具 + `gate_required` 事件 + ChatPane 按钮),或在 orchestrator.md 中指示主代理以文本询问。
5. **验证链路**:`pnpm --filter @workflows/api typecheck` → `lint` → `test`(Vitest),改动 agents/*.md 后 `pnpm build`(copy-agents.mjs);端到端可手动 `pnpm dev` 后在网页对工作区下达含"调研外部 xxx 并挑选"的任务。

**风险点回顾**(见 §4):子代理联网是行为变更(注意输出可信度提示与 50KB 截断)、工具注册三处同步易漏、shared 构建顺序、bash curl 隐式通道不应用于生产级能力。
