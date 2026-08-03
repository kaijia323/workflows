# 探索报告:.wf-runs 运行目录机制调研

> runId: d06adb0f ｜ 类型:仓库探索 ｜ 结论:**`.wf-runs` 机制完全由本仓库实现(非 pi 内核功能),覆盖根因是「run 归并 + 固定文件名」两层叠加**

## 一、仓库概览(与本机制相关部分)

- **workflows**:基于 pi SDK 的 Web Agent 工作台(Turborepo monorepo,`apps/api` + `apps/web` + `packages/shared`)。
- **DAG 工作流**:主代理(orchestrator)编排 4 个子代理 explorer→planner→⏸闸门→executor⇄reviewer;产物黑板落盘 `<工作区>/.wf-runs/<runId>/`,可 git 追踪(`.gitignore` 未忽略 `.wf-runs`,而 `.workflows/` 被忽略)。
- 相关模块:
  - `apps/api/src/pi/runManager.ts` — run 生命周期(`.wf-runs/<runId>/run.json` 创建/持久化/归并判定)
  - `apps/api/src/pi/subAgent.ts` — 子代理运行器(独立 AgentSession、产物文件名映射 `ROLE_ARTIFACT`、产物检测)
  - `apps/api/src/pi/piService.ts` — 编排工具(子代理工具 `createSubAgentTool`、`ensureRun` 归并、闸门、回合结束 run 状态机)
  - `apps/api/src/pi/agentDefs.ts` — 代理 md 加载 + write 白名单 glob 编译/校验
  - `apps/api/src/pi/agents/*.md` — explorer/planner/executor/reviewer/orchestrator 定义(含 write 白名单)
  - `docs/dag-workflow.md` — 设计文档(含「多轮覆盖最新」的明确决策)
  - `packages/shared/src/index.ts` — `RunFile/RunAgentCall/RunSnapshot` 类型

## 二、.wf-runs/runId 目录结构(实测)

```
.wf-runs/
├── 46569220/                          ← 已完成 run(含 2 个编排任务、7 次子代理调用)
│   ├── run.json                       ← { runId, sessionId, status, gate, agents[] }
│   ├── 01-exploration.md              ← explorer 产物(最后写入者覆盖)
│   ├── 03-execution.md                ← executor 产物(同上)
│   └── 04-review.md                   ← reviewer 产物(同上)
│   (无 02-plan.md:该 run 未走 planner,主代理临场简化流程)
└── d06adb0f/                          ← 本次调研的 run(planning,仅 run.json)
    └── run.json
```

- 每个 run 目录 = `run.json`(状态机:planning→awaiting_approval→executing→reviewing→done)+ 若干 `NN-role.md` 产物。
- 子代理会话 JSONL **不在** `.wf-runs` 下,而在 store 的 `agentDir`(`dev: <repo>/.workflows/agent`,`prod: ~/.workflows/agent`):
  `.workflows/agent/sessions/<workspaceId>/sub/<runId>/<ISO时间戳(冒号/点→-) >_<uuidv7>.jsonl`(实测 `2026-08-03T17-48-49-451Z_019fc8be-....jsonl`)。`.workflows/` 被 gitignore,JSONL 不提交。

## 三、产物 md 命名规则(回答「sub_explorer_xxx.md」)

**不存在 `sub_explorer_xxx.md` 之类的命名**。实际规则是**按角色固定的两段式 `NN-role.md`**,无时间戳、无序号:

| 角色 | 文件名 | 定义处 |
| --- | --- | --- |
| explorer | `01-exploration.md` | `subAgent.ts` `ROLE_ARTIFACT` + `agents/explorer.md` write 白名单 `.wf-runs/*/01-exploration.md` |
| planner | `02-plan.md` | 同上 `02-plan.md` |
| executor | `03-execution.md` | 同上 `03-execution.md` |
| reviewer | `04-review.md` | 同上 `04-review.md` |

- 文件名**硬编码**于 `apps/api/src/pi/subAgent.ts:45-51`(`ROLE_ARTIFACT`),子代理 system prompt(agents/*.md 正文)指示「把报告写入 01-exploration.md(产物目录由任务说明给出)」,任务说明由 `runSubAgent` 注入:`` `${task}\n\n产物目录(相对工作区根):.wf-runs/${run.runId}\n最终回复只给摘要。` ``(subAgent.ts:301-302)。
- 子代理写文件受 `guardWriteTool` 白名单拦截(agentDefs.ts `isWriteAllowed`),只能写 `NN-role.md` 固定名 → 模型没有自由度生成带时间戳/序号的文件名。
- run.json 中 `agents[]` 每条含 `callId / agent / summary / artifact / sessionFile / ts`(`artifact` 由 `detectArtifact` 检测固定路径是否存在得到)。

## 四、覆盖根因(回答「为什么后一任务覆盖前一任务」)

**不是 `sub_explorer_1.md` 式命名冲突,而是两层叠加:**

1. **run 归并(跨任务覆盖的主因)**:`piService.ts` 的 `ensureRun()`(约 327-334 行)逻辑为 `handle.run ?? resolveCurrentRun(...)`。`handle.run` 是**内存态**,回合结束(piService.ts:612-618)只把 run.status 置 `done`,**从不把 `handle.run` 置空** → 同一会话(服务进程存活期间)后续所有需求的子代理调用**永远复用同一个 runId**,产物目录不隔离。设计意图(docs/dag-workflow.md §5.1)是「进行中归并,否则新建」,但代码实际变成「会话内永远归并」。实测证据:run `46569220` 的 run.json 含 7 条调用(17:48/17:50 两个 explorer、17:51 executor、17:51 reviewer = 任务 A;17:54 explorer、17:58 executor、17:59 reviewer = 任务 B),两个任务全部落在同一 runId。
2. **固定文件名(同 run 内多轮覆盖)**:`ROLE_ARTIFACT` 角色→固定文件名,同一 run 内同名角色多次调用(如任务 A 的 explorer 调了 2 次)或 executor⇄reviewer 多轮循环,后一次覆盖前一次。这是**设计上有意为之**——docs/dag-workflow.md §5.2 明写 reviewer「多轮覆盖最新,标注『第 N 轮』,历史由 git 兜底」。磁盘上只保留最后一次;run.json 的 agents[] 保留全部调用记录(含各自 artifact 路径)。

**不受影响的部分**:子代理会话 JSONL 文件名含 ISO 时间戳 + uuidv7,**永无碰撞**(实测 7 条 sessionFile 各不相同),覆盖只发生在黑板 md 产物上。

## 五、pi 源码与文档中的相关位置

**`.wf-runs` 不是 pi 内核功能**(pi-coding-agent CHANGELOG/docs 无任何 workflow run 概念),pi 侧只提供会话基础设施:

- `node_modules/.pnpm/@earendil-works+pi-coding-agent@0.83.0_ws@8.21.1_zod@4.4.3/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` — **会话文件名生成**在 `newSession()`:`timestamp.replace(/[:.]/g, '-')` + `_` + sessionId(uuidv7) + `.jsonl`;会话 id 由 `uuidv7()` 生成(同文件顶部)。
- 对应文档:`docs/session-format.md`「File Location:`<timestamp>_<uuid>.jsonl`」;`docs/sessions.md`;源码入口 `packages/coding-agent/src/core/session-manager.ts`(GitHub pi-mono)。
- `docs/environment-variables.md`:`PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR` 可改会话存储目录(本仓库 `SessionManager.create(workspace.path, sessionDir)` 已显式传入 `agentDir/sessions/<workspaceId>/sub/<runId>`,故仅间接相关);**无任何控制 md 产物命名/避免覆盖的环境变量**。
- 本仓库 `subAgent.ts:267` 把子代理会话目录定为 `<agentDir>/sessions/<workspace.id>/sub/<run.runId>`(按 run 分目录、每次调用一个新文件)。

## 六、配置项调查:能否改命名/避免覆盖?

- **产物命名**:无配置项。`ROLE_ARTIFACT` 硬编码在 `subAgent.ts:45-51`;自定义代理可从 write 白名单推导(`detectArtifact` 用 `*` 替换 runId,subAgent.ts:230-239),但白名单本身也写在 agents/*.md frontmatter(用户目录 `.workflows/agents/*.md` 可同名覆盖内置)。要改命名必须改代码或覆盖 agent md + `ROLE_ARTIFACT`。
- **run 归并**:无配置项,行为在 `piService.ts ensureRun` 代码里。
- `.workflows/config.json` 只有 `apiKey/model/thinkingLevel`,无 run 相关设置。

## 七、可行解决方案(按侵入度排序)

1. **最小修复(推荐)**:`piService.ts` 回合结束时若 `run.status = 'done'` 则同时 `handle.run = null`(及 `run.gate.pending` 分支保持),使下次需求经 `resolveCurrentRun` 判定——磁盘上 done 的 run 不再复用,新任务自动开新 runId、新产物目录。改动 1 行级,符合设计文档 §5.1 原意。
2. **产物文件名加序号/时间戳**:改造 `ROLE_ARTIFACT` + 四个 agents/*.md 的 write 白名单(如 `.wf-runs/*/01-exploration-*.md`),`detectArtifact` 改为扫描目录匹配;同步更新 `guardWriteTool` 白名单与前端 artifact 展示。改动面大,但可根治同 run 内多轮覆盖,并保留 git 兜底。
3. **产物子目录按调用分**:`runSubAgent` 在 `.wf-runs/<runId>/` 下按 `callId` 或序号建子目录,文件仍叫 `01-exploration.md`,互不覆盖;`detectArtifact` 与前端快照需适配(collectArtifacts 已支持多 artifact)。
4. **约定层**:不改代码,靠 orchestrator prompt 指示子代理「先读旧文件再追加/标注第 N 轮」——不可靠(文件名是白名单写死的,且依赖模型自觉),仅作过渡。

> 补充风险:`.wf-runs` 进 git 但无人提交时覆盖即丢失(无 git 兜底);前端 run 快照 `collectArtifacts` 只取 `agents[]` 里最后一次非空 artifact,历史产物无法从 run.json 还原内容(仅能定位 runId)。
