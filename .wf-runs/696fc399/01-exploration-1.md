# 探索报告:.wf-runs 与 run.json 机制(任务 01)

调研对象:C:/Users/kaijia/codes/github/workflows(下文简称"本仓库")
调研日期:2026-08-03(会话 4ad12a92-ca51-4914-bdc6-5d41d1fcbaca)

---

## 0. 结论速览(TL;DR)

1. **`.wf-runs/` 是本仓库自研的"工作流运行记录 + 产物黑板"目录**,与 pi-coding-agent 包**无关**——包内(0.83.0)搜不到任何 `.wf-runs`/`run.json` 引用。
2. **run.json 的 `updatedAt` 由 `apps/api/src/pi/runManager.ts` 的 `saveRun()` 写入**(`run.updatedAt = Date.now()` 后全量重写文件)。字段名是 camelCase **`updatedAt`**(不存在 `updateAt`/`update_at`),单位是 epoch 毫秒。
3. **每次工作流运行(任意子代理调用 / 闸门 / 任务完成 / 回合结束判定)都会重写 run.json → updatedAt 必变 → git status 必显示 modified**。这是**设计行为**,不是 bug。
4. **`.wf-runs` 未被任何 gitignore 忽略**(根 `.gitignore`、`.git/info/exclude` 均无),docs 明确「产物进 git,删会话不删产物」。
5. **没有任何配置开关**可以控制这个行为:应用配置(AgentConfig)只有 `apiKey/model/thinkingLevel`;pi-coding-agent 文档中也无 runs/workflow/tracking 相关配置(仅有遥测 analytics 的 `trackingId`,与本问题无关)。
6. 推荐方案见 §7:嫌噪音 → gitignore 单文件 `.wf-runs/*/run.json` 或整个 `.wf-runs/`;想保留产物进 git 则接受现状或改代码。

---

## 1. 仓库概览

- **技术栈**:Turborepo + pnpm 10 monorepo,Node ≥ 20.19
  - `apps/web`:Vue 3 + Vite + Tailwind v4(Web Agent 工作台前端,SSE 双轨渲染、DAG 图、闸门交互)
  - `apps/api`:Hono + `@earendil-works/pi-ai`(模型运行时)+ `@earendil-works/pi-coding-agent`(AgentSession/ToolDefinition/ResourceLoader)+ `@ff-labs/fff-node`(全文索引搜索)+ typebox + unbash(工作区守卫)
  - `packages/shared`:纯类型包(RunSnapshot、事件、DagNode 等)
- **核心模块**:`apps/api/src/pi/piService.ts`(服务核心:会话、子代理/闸门/完成工具、回合决策)、`runManager.ts`(run 生命周期)、`subAgent.ts`(子代理运行器 + 产物落盘)、`agentDefs.ts`(代理 md 解析 + 可写白名单)、`agents/*.md`(orchestrator 主代理 + explorer/planner/executor/reviewer 4 子代理)
- **工作流**:orchestrator 编排 `explorer → planner → ⏸闸门(wait_for_approval) → executor ⇄ reviewer`,产物落 `.wf-runs/<runId>/`
- **构建/测试**:`pnpm dev` / `pnpm build` / `pnpm test`(Vitest);husky pre-commit = lint-staged(仅 ts/vue 文件)+ typecheck + test;无 CI
- **配置目录**:`.workflows/`(dev 本地配置,已被 gitignore;生产环境在 `~/.workflows`)

---

## 2. run.json 完整结构与实际样例

路径:`<工作区>/.wf-runs/<8位runId>/run.json`(runId = `randomUUID().slice(0,8)`)

结构(`RunFile`,定义于 `apps/api/src/pi/runManager.ts:24-33`):

```jsonc
{
  "runId": "696fc399",              // 8 位 hex,run 唯一标识
  "sessionId": "4ad12a92-...",      // 所属会话 UUID(归属索引)
  "status": "planning",             // planning | awaiting_approval | executing | done
  "gate": { "pending": false, "planFile": null },   // 闸门:是否等待批准 + 计划文件(相对路径)
  "createdAt": 1785782958448,       // epoch 毫秒,createRun 时写入
  "updatedAt": 1785782958449,       // epoch 毫秒,saveRun 每次写入时刷新
  "agents": [                       // 子代理调用记录数组(按调用顺序追加)
    {
      "callId": "call_00_75czhGIRohb27iDtax9u8665",  // 子代理会话 callId
      "agent": "explorer",                            // 角色
      "summary": "调研完成,报告已写入 ...",            // 最终摘要(失败时为错误消息)
      "artifact": ".wf-runs\\2a2b4d0d\\01-exploration-1.md",  // 产物文件(相对路径,可能为 null)
      "sessionFile": "sessions\\...\\sub\\2a2b4d0d\\2026-...jsonl",  // 子代理会话 JSONL(可能为 null)
      "ts": 1785782336321          // 调用完成时间戳
    }
  ]
}
```

实际样例(3 个已读):

- **`.wf-runs/696fc399/run.json`**(当前任务):`status: "planning"`,`gate.pending: false`、`planFile: null`,`createdAt == updatedAt`(仅 createRun 写过一次),`agents: []`
- **`.wf-runs/2a2b4d0d/run.json`**:`status: "done"`,`gate.planFile: ".wf-runs\\2a2b4d0d\\02-plan-1.md"`(Windows 反斜杠),`agents` 4 条(explorer/planner/executor/reviewer)
- **`.wf-runs/46569220/run.json`**:`status: "done"`,`gate.planFile: null`,`agents` 6 条(多次子代理调用,同一 run 内多轮)

同目录还存放各角色产物 md:`01-exploration-N.md` / `02-plan-N.md` / `03-execution-N.md` / `04-review-N.md`(`N` 为同 run 内同角色调用序号)。

**注意:字段名为 `updatedAt`(camelCase),不存在 `updateAt`/`update_at`。**

---

## 3. run.json 生成/更新机制(代码链路)

全部写入集中在 **`apps/api/src/pi/runManager.ts`**(非 pi-coding-agent):

| 函数 | 作用 |
| --- | --- |
| `createRun(workspacePath, sessionId)` | 新建 `<workspace>/.wf-runs/<runId>/` + 写 run.json(`status: planning`,`createdAt = updatedAt = Date.now()`,`agents: []`) |
| `saveRun(workspacePath, run)` | **`run.updatedAt = Date.now()` 然后 `writeFileSync` 全量重写 run.json**(目录不存在自动创建)。这是 `updatedAt` 唯一赋值点 |
| `appendRunAgentCall(...)` | 追加/更新一条 agents 记录后调 `saveRun` |
| `loadRun` / `listRuns` | 读取;扫描按 updatedAt 倒序 |
| `resolveCurrentRun(...)` | 归并判定:服务重启后扫描 `.wf-runs`,取「最新且未完成(gate.pending 或 status≠done)且属于该会话」的 run 作为当前 run(断点续跑) |
| `decideTurnEnd(...)` | 回合结束决策纯函数(keep / awaiting_approval / done) |

**调用方 `apps/api/src/pi/piService.ts` 中每个触发点**(每处都会 bump updatedAt 并写盘):

1. **主代理调子代理工具**(explorer/planner/executor/reviewer 的 execute,约 381 行):`ensureRun()`(无进行中 run 则 `createRun` 新建)→ `status='executing'`、`gate.pending=false` → `saveRun`
2. **子代理成功/失败返回**(约 407 / 426 行):`appendRunAgentCall`(失败也记录)→ 写盘
3. **`wait_for_approval` 闸门工具**(约 466 行):`status='awaiting_approval'`、`gate={pending:true, planFile:detectPlanFile(...)}` → `saveRun`
4. **`complete_task` 完成工具**(约 509 行):`status='done'`、`gate.pending=false` → `saveRun`(崩溃安全:立即落盘)
5. **`prompt()` finally 三分支**(约 674 / 678 行):`decideTurnEnd` 结果为 `awaiting_approval` 或 `done` 时 `saveRun`;结果为 `keep`(失败/abort/中途停止)**刻意不写盘**(代码注释:避免无谓写盘与 updatedAt 漂移,handle.run 保留供内存归并)

产物 md 文件由 `apps/api/src/pi/subAgent.ts` 写入(子代理按 agents/*.md 白名单 `write` 到 `.wf-runs/<runId>/` 目录)。

**结论:只要工作流在运行(任意子代理调用/闸门/完成/回合收尾),run.json 就会被重写,updatedAt 必变,git status 必显示 `.wf-runs/<runId>/run.json` modified。** 且每次都是全量 JSON 序列化,agents 数组越长文件越大。

---

## 4. 是谁在更新?有没有配置开关?

### 4.1 不是 pi-coding-agent,是本项目自研代码

- 在 `node_modules/.pnpm/@earendil-works+pi-coding-agent@0.83.0_ws@8.21.1_zod@4.4.3/node_modules/@earendil-works/pi-coding-agent/` 中搜索 `wf-runs` / `run.json`:**零命中**(注意:fff 索引遵循 .gitignore,node_modules 不可被 fff-grep 搜索,以上为 read 直读确认)。
- pi-coding-agent 在本项目中的角色:仅提供 `AgentSession`(会话)、`ToolDefinition`、`ResourceLoader` 等类型与 SDK 能力(`apps/api/src/pi/*.ts` 的 import 均为类型/会话/工具加载);pi 自身的会话持久化在 `~/.pi/agent/sessions`,与本目录无关。
- `.wf-runs` 的一切读写都在 `apps/api/src/pi/runManager.ts` + `piService.ts`(见 §3)。

### 4.2 配置开关:不存在

- **应用侧**:`AgentConfig`(`apps/api/src/config.ts` 的 `StoredConfig`)只有 `apiKey / model / thinkingLevel`,存在 `.workflows/config.json`(实测内容仅 `{"apiKey": "...", "thinkingLevel": "max"}`);无任何 run/tracking 相关字段。`RUNS_DIR_NAME = '.wf-runs'` 是硬编码常量(`runManager.ts:15`)。
- **pi-coding-agent 文档侧**(docs/settings.md 等):与 runs/workflow/tracking 相关的只有遥测 `enableAnalytics` / `trackingId` / `enableInstallTelemetry`(与 run.json 完全无关);无工作流 run 记录类配置。项目设置 `~/.pi/agent/settings.json` / `.pi/settings.json` 亦无此类项。

### 4.3 git 侧:被跟踪是有意设计

- 根 `.gitignore`(唯一,无嵌套):`node_modules/`、`dist/`、`.turbo/`、`*.tsbuildinfo`、`.env*`、`logs/`、`*.log`、`.DS_Store`、`*.local`、**`.workflows/`**——**没有 `.wf-runs/`**。
- `.git/info/exclude`:空(仅注释)。
- 设计文档 `docs/dag-workflow.md` 明示:「产物进工作区 `.wf-runs/<runId>/`,**git 可追踪**;删会话不删产物」「run.json 的 sessionId 是归属索引」(§5.1/§5.2/§12)。
- husky pre-commit 只跑 lint-staged(仅 `*.{ts,tsx,...,vue}`)+ typecheck + test,**不写 run.json**。所以「提交后 updateAt 又变」不是 commit 造成的,而是提交后工作流继续运行(或下一轮运行)时 `saveRun` 重新写盘导致的。

---

## 5. .wf-runs 的用途

1. **运行记录(产物黑板)**:每个 run 绑定「会话内一次需求处理」(run 与会话非 1:1,一个会话可多次下发需求,产物各自隔离);`run.json` 记录状态机(`planning → awaiting_approval → executing → reviewing → done`)、闸门状态、每次子代理调用摘要/产物/子会话文件索引;`NN-role-N.md` 是各角色产物(探索报告 / 实施计划 / 执行报告 / 审查报告),供下游子代理作为输入。
2. **断点续跑(恢复)**:服务重启后 `resolveCurrentRun` 扫描 `.wf-runs`,取最新 `gate.pending` 或未完成 run 归并续跑;闸门(`awaiting_approval`)是天然恢复点(回合已结束、计划已落盘,续跑只是一条新用户消息);前端 `GET /api/agent/workspaces/:id/run` 拉快照重建 DAG/闸门按钮。
3. **历史资产**:删除会话**不删** `.wf-runs/` 产物(已进 git,是用户资产)。

---

## 6. 关键发现与风险点

- **每次运行必脏 git 工作区**:run.json 每次 `saveRun` 全量重写 + updatedAt 刷新,工作流每跑一轮就产生一次 modified——这是用户观察现象的直接根因(设计行为)。
- **无开关**:想控制只能改代码(§7 方案 3)或 gitignore(§7 方案 1/2)。
- **run.json 会持续膨胀**:agents 数组按调用追加(含失败记录),且每次子代理调用有两次写盘(置 executing + append 记录),文件大小随轮次增长。
- 已提交历史:`.wf-runs/` 下的 run.json 与产物 md 均已进入 git(2a2b4d0d / 46569220 / d06adb0f 可见);若改用 gitignore 需 `git rm -r --cached` 解除跟踪。
- 既有风险(与本问题无关,顺带记录):`.workflows/config.json` 明文存 DeepSeek API key(该目录已被 gitignore,但仍是明文落盘);无 CI,全靠本地 husky 门禁。
- 工具限制备注:fff 索引遵循 .gitignore,node_modules / .workflows / 日志等不可被 fff-grep/find 搜索,本次对 pi 包采用 read 直读。

---

## 7. 结论与推荐方案

**可行性判断**:`.wf-runs` 机制完全由本项目自研代码控制(`runManager.ts` + `piService.ts`),无外部依赖、无配置开关;处理方式完全自主,可行。

**推荐方案(按代价从低到高)**:

1. **只忽略 run.json、保留产物 md 进 git(推荐,改动最小、保留设计)**:在根 `.gitignore` 追加
   ```
   # workflow run metadata (keep artifact md, ignore volatile json)
   .wf-runs/*/run.json
   ```
   并对已跟踪的 run.json 执行 `git rm -r --cached .wf-runs` 后 `git add` 重新加入 md 产物(或逐目录 `git rm --cached .wf-runs/*/run.json`)。此后每次运行的 git 噪音只剩新增/修改的产物 md(仍会随运行变化,但语义上是"交付物"而非"状态元数据");断点续跑/快照功能不受影响(全部基于磁盘文件,与 git 无关)。注意:若同时希望彻底安静,可进一步连 md 一起忽略(见方案 2)。
2. **整个 `.wf-runs/` 不进 git**:`.gitignore` 加 `.wf-runs/` + `git rm -r --cached .wf-runs`。产物与运行记录仍在磁盘,删会话不删产物、断点续跑、前端快照均不依赖 git,功能无损;代价是放弃"产物进 git 是用户资产"的设计初衷(历史提交中已有的产物不受影响,只是不再跟踪新变更)。
3. **改代码减少写盘(不推荐,除非确实需要)**:给 `saveRun` 增加「内容无变化不写盘」或把 `updatedAt` 改为状态迁移时(而非每次 append)更新——影响 `runManager.ts`/`piService.ts`,与「崩溃安全立即落盘」设计存在权衡,且需同步 `runManager.test.ts`(现有用例断言"keep 分支 run.json 内容不变不写盘")。

**一句话建议**:日常使用选方案 1(只 ignore `run.json` 元数据文件,保留产物 md 进 git);若完全不想要运行噪音,选方案 2。
