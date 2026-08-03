# 探索报告:主代理系统提示词与 complete_task 工具定义

> 目标:为调整「complete_task 调用规则」做准备 —— complete_task 不应是每次会话结束必调命令,主代理应自行判断;无进行中 run 时调用 complete_task 不应自动新建空 run。
> 本报告只读调研,未修改任何代码。

## 1. 仓库概览

- 技术栈:pnpm workspace monorepo(`apps/api` + `packages/shared` + `apps/web` 未见,web 未在本仓库),TypeScript,`@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` SDK,TypeBox 参数 schema,vitest 单测。
- 关键目录:`apps/api/src/pi/`(主代理/子代理编排服务层)、`apps/api/src/config.ts`(会话存储)、`packages/shared/src/index.ts`(共享类型)。
- 构建:tsc + `apps/api/scripts/copy-agents.mjs`(把 `src/pi/agents/*.md` 复制到 `dist/pi/agents`,tsc 不复制 .md)。
- 测试:`apps/api/src/pi/*.test.ts`(vitest)。

## 2. 主代理(编排者)系统提示词

### 2.1 位置

- **独立文件**:`apps/api/src/pi/agents/orchestrator.md`(整文件 = 提示词,frontmatter + 正文)。
- 加载链路:`agentDefs.ts` 的 `parseAgentFile`(解析 frontmatter + body)→ `getAgentDefinitions`(内置 `BUILTIN_AGENTS_DIR = src/pi/agents` + 用户覆盖)→ `piService.ts:277` `createPromptOnlyLoader(undefined, [orchestrator.body])` → 作为 `appendSystemPrompt` 追加在 pi SDK 默认 system prompt 之后(不替换默认规则)。`promptLoader.ts` 是极简 ResourceLoader,只注入 appendSystemPrompt。
- `piService.ts:87-96`(PiAgentService.create):启动时校验 `defs.has('orchestrator')`,缺失直接抛错。

### 2.2 与「任务完成/会话结束/complete_task/闸门/回合结束」相关的完整文本(文件 + 行号)

`apps/api/src/pi/agents/orchestrator.md`:

- 行 12-18(可用工具清单):
  ```
  - explorer(探索):调研仓库。参数 task:调研任务
  - planner(计划):基于探索报告制定实施计划。参数 task:计划要求
  - executor(执行):按计划改代码。参数 task:执行任务
  - reviewer(审查):对照计划审查改动。参数 task:审查任务
  - wait_for_approval(等待批准):暂停等待用户确认。参数 summary:给用户的计划摘要
  - complete_task(完成任务):声明任务已全部完成(最终交付)。参数 summary:交付总结
  ```
- 行 25(调度策略 3,闸门强制规则):
  ```
  3. 计划完成后必须调用 wait_for_approval 等待用户批准。调用后立即结束回合,不要再调用任何工具
  ```
- **行 28(调度策略 6,complete_task 强制规则 —— 本次调整的核心)**:
  ```
  6. 任务交付完成后必须调用 complete_task 声明完成,然后立即结束回合;未调用闸门也未调用 complete_task 的回合不结束任务(任务保持进行中,后续消息继续归并同一任务)
  ```
- 行 29(调度策略 7)与行 35(约束,重复):
  ```
  7. 不要在任务中途仅以纯文本结束回合;纯文本只用于交付总结/简短汇报
  - 不要在任务中途仅以纯文本结束回合,纯文本只用于交付总结/简短汇报
  ```

### 2.3 强制规则措辞确认

- ✅ 包含「任务交付完成后必须调用 complete_task 声明完成」的强制规则:orchestrator.md 行 28(「任务交付完成后必须调用 complete_task 声明完成,然后立即结束回合」)+ 工具 description(见 §3)。
- ✅ 包含「未调用闸门也未调用 complete_task 的回合不结束任务(任务保持进行中)」这句:orchestrator.md 行 28 后半句,原文为「未调用闸门也未调用 complete_task 的回合不结束任务(任务保持进行中,后续消息继续归并同一任务)」。
- 注意:这句「不结束任务」是**提示词层面的规则**,服务端实际语义略有不同(见 §5):服务端对「未调子代理/闸门/完成的纯文本回合」是自动置 done(兜底),「调过子代理但中途停止」才是 keep。即提示词把「未调 complete_task 就不结束」写死了,而服务端只对「调过子代理」的回合强制 keep。

## 3. complete_task / wait_for_approval 工具定义

### 3.1 位置与完整文本

全部硬编码在 `apps/api/src/pi/piService.ts`(非独立文件、非配置):

**complete_task —— `createCompleteTaskTool`,piService.ts:492-528:**

- 行 497-498:`name: 'complete_task'`,`label: 'complete_task'`
- 行 499-502(description,两段字符串拼接):
  ```
  声明当前任务已全部完成(最终交付)。任务交付完成后必须调用此工具并立即结束回合;
  调用后本任务的 run 标记为完成,下一次新需求将开启新的 run(新产物目录)。
  ```
- 行 503:`promptSnippet: 'Mark the current task as complete'`
- 行 504-506:参数 schema `Type.Object({ summary: Type.String({ description: '交付总结(已完成内容、关键产物位置)' }) })`
- 行 507-508(execute 关键行为):
  ```ts
  // 与 wait_for_approval 一致:无 run 则新建(罕见,容忍空 done run)
  const run = this.ensureRun(handle)
  ```
  → **无进行中 run 时,ensureRun 会 createRun 新建一个 run(行 333-348),随后置 done —— 即产生「空 done run」,这正是用户指出的问题点。**
- 行 509-527:置 `turnCompleteCalled = true`、`run.status = 'done'`、`gate.pending = false`、立即 saveRun(崩溃安全)、`handle.run = null`(立即释放),返回「任务已标记为完成。立即结束回合,向用户做最终交付总结。」

**wait_for_approval —— `createWaitForApprovalTool`,piService.ts:452-489:**

- 行 457-458:`name: 'wait_for_approval'`,`label: 'wait_for_approval'`
- 行 459-460(description):
  ```
  暂停工作流等待用户批准。计划类需求在计划完成后必须调用此工具,然后立即结束回合,等待用户决定。
  ```
- 行 466:execute 同样调用 `this.ensureRun(handle)`(无 run 也会新建 —— 同源风险,用户未要求但建议一并评估)。

**ensureRun —— piService.ts:333-348:**

- 内存归并(handle.run 非 done)→ 磁盘恢复(resolveCurrentRun)→ 兜底 `createRun`(新建)。`createRun` 在 `runManager.ts:45-61`,创建 `.wf-runs/<runId>/run.json`,status='planning',agents=[]。

### 3.2 注册位置

`piService.ts:272`(wait_for_approval)、`piService.ts:274`(complete_task)push 进 `subAgentTools`,经 `createAgentSession` 的 `customTools` + `tools`(行 285-286)注入主代理。

## 4. 提示词/工具定义是硬编码还是独立文件

| 内容 | 位置 | 形态 |
| --- | --- | --- |
| 主代理提示词正文 | `src/pi/agents/orchestrator.md` | 独立 md 文件(构建复制到 dist,用户可在 `.workflows/agent/agents/` 同名覆盖) |
| 工具名/description/schema | `piService.ts:452-528` | 硬编码 |
| 回合结束决策逻辑 | `runManager.ts:160-170` `decideTurnEnd` | 代码 |
| 设计文档 | `docs/dag-workflow.md` | 独立 md(提及 complete_task 语义,行 93/157/209) |

## 5. 会话(session)与 run 的关系

- **一个会话可有多个 run**:`docs/dag-workflow.md:91`「run 绑定『会话内的一次需求处理』,不是与会话 1:1——一个会话可连续多次下发需求,产物各自隔离」。会话 = 持久化 JSONL 上下文容器(`.workflows/agent/sessions/<workspaceId>/`),run = 一次需求处理(产物在 `.wf-runs/<runId>/`)。删除会话不删 run 产物。
- **会话结束 ≠ 任务完成**:服务端**没有**「会话结束」与 complete_task 的联动概念。会话操作(openSession/createSession/switchSession/deleteSession,piService.ts:214-290)只管理 JSONL 与 handle;run 的结束只由**回合结束决策**决定(`prompt()` finally 三分支,piService.ts:668-700 + `decideTurnEnd`):
  - 回合失败(turnFailed)→ `keep`(不写盘不释放,保守)
  - 调过闸门(turnWaitCalled)→ `awaiting_approval`(gate.pending,续跑归并)
  - 调过 complete_task(turnCompleteCalled)→ `done` + 释放
  - **纯文本交付回合(未调子代理/闸门/完成)→ `done`(服务端兜底)** —— 注意:若 handle.run 为 null(无进行中任务),此时不产生任何 run,纯文本问答天然不会创建空 run
  - 调过子代理但中途停止 → `keep`(run 保持 executing,下条消息归并同一 runId)
- **风险联动**:新建/切换会话后 `handle.run = null`,但磁盘上未完成的 run 会在下次 `ensureRun` 经 `resolveCurrentRun`(runManager.ts:99-121,按 sessionId 匹配)恢复 —— run 生命周期与「当前打开的会话」不完全绑定,而是与 sessionId 绑定。
- **结论**:「无任务时」要避免创建 run,仅需堵住两个工具 execute 里的 `ensureRun`(complete_task 行 508、wait_for_approval 行 466)以及子代理工具(行 371,子代理调用是任务开始的正当入口,不应改)。

## 6. 现有测试影响面

**没有任何测试断言「提示词包含必须调用 complete_task」这类文本。** 改提示词正文不会直接破坏测试:

- `agentDefs.test.ts`:只断言 orchestrator 的 frontmatter(agents 白名单 4 个、body.length > 50),不检查正文文本。
- `runManager.test.ts`:测 `decideTurnEnd` 纯函数矩阵 + run 生命周期,与提示词文本无关。其中涉及 complete_task 的用例:
  - 行 78「调过子代理 + complete_task → done」(decideTurnEnd 矩阵)
  - 行 108-131「complete_task 释放」(手工构造 run → 置 done → resolveCurrentRun 为 null)
  - 行 203「done 冻结:首次 done 落盘成功」
  - 行 60 附近「纯文本交付回合(全 false)→ done」与「纯文本交付释放」——**只有改动 decideTurnEnd 语义(例如把纯文本兜底 done 改掉)才会破坏这些用例**;若本次只改提示词 + 工具 description + complete_task execute 的「无 run 不新建」逻辑,`decideTurnEnd` 不变,测试全部保持绿色。
- **无 piService.test.ts**:piService 没有直接单测,工具 execute 行为(ensureRun 新建)目前无测试覆盖 —— 改「无 run 不新建」不会破坏现有单测,但建议补一条针对 execute 语义的测试(当前 runManager.test.ts 的「complete_task 语义」注释行 113/203 是手工模拟的,不是真调 execute)。

## 7. 关键发现与风险点

1. **强制规则存在两处文本**:orchestrator.md 行 28 + piService.ts 行 500(工具 description),都写「必须调用」;orchestrator.md 行 29/35 还把纯文本回合贬为「不要」,与「主代理自行判断」的新语义冲突,需一并调整。
2. **空 run 根因**:complete_task execute(piService.ts:508)与 wait_for_approval execute(piService.ts:466)无条件 `ensureRun` → 无 run 时 `createRun`(piService.ts:347)。complete_task 后置 done,产生 `.wf-runs/<runId>/run.json`(status=done,agents=[])的**空 done run**,污染产物目录与 git。
3. **模型自觉依赖**:服务端对「调过子代理但未 complete_task」的回合是 keep(不结束任务),所以提示词行 28 的「未调用 complete_task 不结束任务」对任务类场景是服务端强制的;但「无任务时误调 complete_task」只有代码层能兜住 —— 仅改提示词不够,必须改 execute。
4. **纯文本兜底 done 与「无任务不创建 run」兼容**:无 run 时纯文本回合决策为 done 但 `handle.run` 为 null,finally 跳过写盘,不产生 run。因此「无任务场景」保持现有 decideTurnEnd 即可,无需改决策逻辑。
5. **wait_for_approval 同源问题**:无任务时调用 wait_for_approval 同样会新建空 run(且状态为 awaiting_approval 卡闸门),本次需求虽只提 complete_task,建议顺带处理或至少记录。
6. **文档滞后**:docs/dag-workflow.md 行 93/157/209 把 complete_task 描述为任务完成机制,新语义需同步修订,否则设计文档与实现不一致。

## 8. 结论与最小改动清单(实现「主代理自行判断 + 无 run 不创建」)

### 8.1 必须改(实现新语义的最小集)

| # | 文件:行 | 改动 |
| --- | --- | --- |
| 1 | `apps/api/src/pi/agents/orchestrator.md:28`(规则 6) | 改为条件式:存在进行中任务且任务全部完成时才调用 complete_task 并结束回合;无进行中任务(咨询/问答/闲聊)直接文本回复,不要调用 complete_task。删除「未调用闸门也未调用 complete_task 的回合不结束任务」的绝对化表述(或改为仅针对任务场景) |
| 2 | `apps/api/src/pi/agents/orchestrator.md:18`(工具清单) | complete_task 描述补「仅当存在进行中的任务且已全部完成时调用」 |
| 3 | `apps/api/src/pi/agents/orchestrator.md:29,35`(纯文本规则) | 澄清:纯文本仅限交付总结/简短汇报**及无任务的问答回合**,任务中途不要纯文本结束 |
| 4 | `apps/api/src/pi/piService.ts:499-502`(complete_task description) | 改为「声明当前任务已全部完成(最终交付)。仅当存在进行中的任务且任务已全部完成时调用;若当前没有进行中的任务(如咨询、问答),不要调用此工具,直接文本回复即可。调用后本任务的 run 标记为完成…」 |
| 5 | `apps/api/src/pi/piService.ts:503-528`(complete_task execute) | 把行 508 的 `ensureRun(handle)` 改为「无进行中 run 则不创建」:仅当 `handle.run`(非 done)或 `resolveCurrentRun(workspace.path, sessionId, null)` 存在时复用,否则直接返回文本(如「当前没有进行中的任务,无需调用 complete_task」),不置 turnCompleteCalled/不写盘/不新建。注意 handle.run 为 null 时 finally 三分支自动跳过(piService.ts:671),无副作用 |

### 8.2 建议一并改(同源/文档/测试)

| # | 文件:行 | 改动 |
| --- | --- | --- |
| 6 | `apps/api/src/pi/piService.ts:466`(wait_for_approval execute) | 同样去掉「无 run 则新建」语义(否则无任务时调闸门仍会产生空 run 并卡 awaiting_approval);或至少确认产品意图 |
| 7 | `docs/dag-workflow.md:93,157,209` | 同步修订 complete_task 语义(「任务完成释放」段落)与纯文本兜底描述 |
| 8 | 新增测试 | 补一条覆盖 complete_task execute「无 run 不新建」的用例(现有 runManager.test.ts 只模拟语义、不调真 execute);若 decideTurnEnd 语义不变,现有测试(尤其 runManager.test.ts 行 60/108/203)无需改动 |

### 8.3 不需要改

- `runManager.ts` 的 `decideTurnEnd`(行 160-170):「纯文本→done」兜底在无 run 时无副作用,保留可维持现有测试全绿;「调过子代理未完成→keep」是任务场景正确语义。
- `ensureRun` 本身(行 333-348):子代理工具(行 371)仍需「无 run 新建」(任务开始的正当入口),只是 complete_task/wait_for_approval 不再无条件走它。
- `agentDefs.ts` / `promptLoader.ts`:提示词注入机制不变。
