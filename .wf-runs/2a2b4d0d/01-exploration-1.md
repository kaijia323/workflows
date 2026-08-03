# 探索报告:runId 生命周期粒度问题

> 任务:调研「一个编排任务被拆成多个 runId」问题,给出修正方案。
> 实测反例:同一会话 06f47913 内,707736e6(explorer done)与 1c0fdcc1(planner awaiting_approval)属同一任务,却被拆成两个 run;planner 计划(`1c0fdcc1/02-plan-1.md`)明确引用 `707736e6/01-exploration-1.md` 的探索报告。
> 根因:上次修复 commit fd6057f(「.wf-runs 子代理产物不再互相覆盖」)引入的「回合结束 done 即释放 run」在任务跨多个 prompt 时把任务拆开。

---

## 1. 仓库概览

- **Monorepo(Turborepo + pnpm)**:`apps/web`(Vue 3 + Vite 8 + Tailwind v4)、`apps/api`(Hono + pi SDK + fff-node + unbash + typebox)、`packages/shared`(纯类型包,改动后必须 `pnpm build`)。
- **工作流编排层**(本次调研核心,自实现,非 pi SDK 功能):
  - `apps/api/src/pi/piService.ts` — 服务层:会话管理、主代理 prompt、子代理工具、闸门工具、run 生命周期、事件映射。
  - `apps/api/src/pi/runManager.ts` — run 的创建/持久化/归并/快照(`createRun` / `saveRun` / `resolveCurrentRun` / `listRuns` / `toSnapshot` / `appendRunAgentCall`)。
  - `apps/api/src/pi/subAgent.ts` — 子代理运行器(独立 AgentSession + sub_* 事件镜像 + 产物命名 `NN-role-N.md`)。
  - `apps/api/src/pi/agents/*.md` — orchestrator + 4 子代理定义(frontmatter + 正文)。
  - `apps/web/src/composables/useAgent.ts` + `ChatPane.vue` + `DagPanel.vue` — 前端 SSE 双轨渲染、闸门按钮、DAG 图。
  - 产物:`<workspace>/.wf-runs/<runId>/`(run.json + NN-role-N.md,进 git);子代理会话 JSONL 在 `.workflows/.../sub/<runId>/`(gitignored)。
- **测试**:Vitest,api 侧 `apps/api/src/pi/*.test.ts` 5 个文件(暂无 runManager.test.ts);命令 `pnpm --filter @workflows/api test/typecheck/lint/build`。
- **git 历史**:HEAD=bb2b77c6;`fd6057f`(fix: .wf-runs 子代理产物不再互相覆盖)= 方案 A(回合结束释放 run)+ 方案 B(NN-role-N 命名),本次问题即方案 A 的副作用。

---

## 2. 文档定义的 run/runId 生命周期语义(docs/dag-workflow.md)

### 2.1 run 对应什么
§5.1:**run 绑定「会话内的一次需求处理」**,不是与会话 1:1——一个会话可连续多次下发需求,产物各自隔离。即文档口径 = **一个 run ≈ 一个任务(一次需求处理)**。

### 2.2 开启/归并规则(§5.1,文档原话)
- 用户发新消息时,当前会话有**进行中**的 run(status 非 done)→ 归并进该 run(闸门续跑即此场景);
- 否则 → 新建 run(新 runId)。
- **回合释放**:回合结束(status 置 done)后服务端释放内存中的 run(`handle.run = null`),同一会话的下一个需求自动开新 run、新产物目录;仅 awaiting_approval(闸门等待)归并同一 run。

### 2.3 状态机(§5.2)
`planning → awaiting_approval → executing → reviewing → done`。

### 2.4 闸门与 run 的关系(§7)
- planner 完成后主代理调用 `wait_for_approval` 工具 → 服务端记录闸门状态 + 发 `gate_required` 事件 → 回合自然结束(**run 保持 awaiting_approval,不置 done**)。
- 批准 → `POST /prompt("用户已批准计划,继续执行")`;驳回 → `POST /prompt("用户驳回:<意见>…")` —— **都只是普通用户消息文本**,服务端靠 `gate.pending=true` 归并到同一 run。
- 闸门是「回合制、无长连接」:续跑 = 一条新用户消息,不依赖内存状态。

### 2.5 任务结束的判定(文档隐含假设)
文档假设 **任务 = 一个 prompt 回合**:回合内 orchestrator 完成 explorer→planner→闸门(或简单需求 explorer→executor),回合结束 = 任务结束;唯一跨回合的是闸门续跑(awaiting_approval 归并)。**文档没有「任务跨多个非闸门回合」的模型**——这正是本次 bug 的语义缺口。

---

## 3. 代码现状:prompt() 全流程与 runId 创建/复用路径

### 3.1 SessionHandle 相关字段(piService.ts:66-75)
```ts
run: RunFile | null          // 当前 run(本次需求处理);无则 null
turnWaitCalled: boolean      // 本回合是否调用过 wait_for_approval
```

### 3.2 关键读写时机(按时间序)

| 时机 | 代码位置 | 动作 |
|---|---|---|
| 打开会话 | `openSession`(piService.ts:314-315) | `run: resolveCurrentRun(workspace, sessionId, null)`(恢复磁盘 run) |
| 子代理工具执行 | `createSubAgentTool.execute`(piService.ts:~352-360) | `ensureRun(handle)`;若 `status==='awaiting_approval'||'done'` 置回 `'executing'`;`gate.pending=false`;`saveRun` |
| 闸门工具执行 | `createWaitForApprovalTool.execute`(piService.ts:437-460) | `ensureRun`;`status='awaiting_approval'`、`gate={pending:true, planFile}`、`handle.turnWaitCalled=true`、发 `gate_required` |
| 回合开始 | `prompt()`(piService.ts:580) | `handle.turnWaitCalled = false` |
| **回合结束 finally** | piService.ts:605-625 | `turnWaitCalled` → `awaiting_approval`+gate;否则 → **`status='done'` + `gate.pending=false`**;`saveRun`;`if (run.status==='done') handle.run = null`(**方案 A,fd6057f 引入**) |
| 快照 | `getRunSnapshot`(piService.ts:636-647) | `handle?.run ?? listRuns().find(同 sessionId)`;**只回填非 done run**(方案 A 配套防护) |
| 归并判定 | `resolveCurrentRun`(runManager.ts:100-118) | 内存 `currentRunId` 优先;否则扫磁盘取「同会话 && (gate.pending || status≠done)」最新 run |

### 3.3 ensureRun 的完整路径(piService.ts:324-338)
```ts
private ensureRun(handle) {
  const currentId = handle.run?.runId ?? null
  const run = handle.run ?? resolveCurrentRun(workspace.path, handle.sessionId, currentId)
  if (run) { handle.run = run; return run }   // 进行中(非 done)归并
  const created = createRun(...)              // 否则新建 runId(8 位 uuid 短码)
  handle.run = created
  return created
}
```

### 3.4 结论:**「每个子代理回合结束 done 即释放 run」如何导致任务拆分**
链路(实测 707736e6 → 1c0fdcc1,同一 session 06f47913):
1. **回合 1**:用户消息 → orchestrator 调 explorer → 子代理结束 → **orchestrator 回合结束,未调用 wait_for_approval**(模型行为:explorer 后停下汇报/等待用户) → finally:`turnWaitCalled=false` → `707736e6.status='done'` → `handle.run=null`。
2. **回合 2**(约 2 分钟后,用户消息「继续/制定计划」):orchestrator 调 planner → `ensureRun`:`handle.run=null` → `resolveCurrentRun` 扫磁盘:`707736e6` 已 done → 返回 null → **`createRun` 新建 `1c0fdcc1`**。
3. planner 任务文本引用 `707736e6/01-exploration-1.md`(跨 run 引用),产物与 DAG 分家,`1c0fdcc1` 的 `02-plan-1.md` 与探索报告不在同一目录。

即:**任务只要跨过任何一个「非闸门」回合边界就会被拆**。闸门(awaiting_approval)是唯一被文档认可的跨回合归并点;explorer 后、executor 后、reviewer-fail 后的回合边界都没有归并信号。

> 补充发现(影响方案 b 的前提):实测 req-guide 会话 JSONL 显示 orchestrator **可以在一个 prompt 内连调多个子代理**(explorer→planner→wait_for_approval 三连)。「一次 prompt 只调一个子代理」不是必然,而是模型行为不确定:可能一次调完,也可能 explorer 后就停。因此「prompt 内共享、prompt 间靠闸门归并」并不能覆盖全部情况。

---

## 4. 关键设计问题:如何界定「编排任务」的边界

### 4.1 可用信号盘点

| 信号 | 来源 | 可用性 | 说明 |
|---|---|---|---|
| `run.gate.pending`(awaiting_approval) | run.json | ✅ 强信号 | 闸门续跑:任何消息 = 批准/驳回/继续 → 归并。前端按钮发的也只是普通文本(`ChatPane.vue:118/132`) |
| `run.status !== 'done'` | run.json | ✅ 强信号 | 归并判定现成(`resolveCurrentRun` 已实现) |
| `turnWaitCalled` | 内存(handle) | ✅ 强信号 | 回合内是否调过闸门 |
| **「回合内是否调过子代理」** | 内存(可加 `turnSubAgentCalled`) | ✅ 可新增 | 当前无此标志,但 `createSubAgentTool.execute` 处一行可加 |
| 用户消息文本 | prompt 参数 | ⚠️ 弱 | 只有前端闸门按钮的固定文案("用户已批准计划…"/"用户驳回:…")可识别,依赖文本约定,脆弱 |
| tool call 记录 / 会话消息 | session.messages | ⚠️ 中 | 可判「回合最后一个 assistant 消息是否含 toolCall」,但交付回合与中途停止回合的末条消息形态相同(都是无 toolCall 的文本),区分不了意图 |
| agents[] 构成 | run.json | ⚠️ 中 | explorer-only = 中途停止;explorer→planner→gate = 闸门;executor→reviewer+pass = 交付。reviewer pass 需读 review 报告文本(reviewer.md 约定首行「结论 pass/fail」),脆弱 |
| 显式任务 ID / 完成工具 | 新增 | ✅ 最强 | 见方案 c |

### 4.2 核心结论:信号缺失的本质
「中途停止(还会继续)」与「任务完成(该开新任务)」在**服务端可观察的信号上同构**——都是「回合结束、无闸门、末条消息无工具调用」。现有实现用「回合结束」一刀切当「任务结束」,必然二选一错:fd6057f 前错在**过度归并**(46569220 一个 run 装了两个任务 7 次调用),fd6057f 后错在**过度拆分**(707736e6/1c0fdcc1)。要同时满足「一个任务一个 runId」+「不同任务互不覆盖」,必须给「任务完成」一个**显式的、区别于回合结束的信号**。

---

## 5. 修正方案对比

> 目标:一个编排任务一个 runId;不同任务互不覆盖。即修复 707736e6/1c0fdcc1 式拆分,同时不回退到 46569220 式过度归并。

### 方案 a:回合结束不释放,改为「检测到新任务信号时开新 runId」

**机制**:回合结束不再置 done/释放;prompt 开始时检测新任务信号(如「非闸门批准的新用户消息」)才开新 runId。

**判定信号可用性分析**:
- 若新任务信号 = 「非 gate.pending 的用户消息」:**不能修复拆分**。explorer 后的「继续制定计划」恰恰就是一条非闸门消息,按此规则仍会开新 run——与现状等价。
- 若新任务信号 = 「run 已 done」:则必须回答「done 何时置」——回到方案 b 的老问题。**方案 a 单独不完整**,它只是把决策点从「回合结束」挪到「下一条消息到来时」,而两个时刻可用的信号一样贫乏。

**结论**:方案 a 作为独立方案不成立;它必须搭配一个「任务完成」的判定(见方案 c 的兜底),否则无法区分「继续」与「新任务」。

### 方案 b:保留 done 释放,「回合 = 任务」(当前行为)

**机制**:现状(fd6057f):回合结束无闸门 → done + 释放;prompt 内多子代理调用共享一个 run;prompt 间只靠闸门归并。

**为什么仍会拆任务**:任务边界 = 回合边界的前提是「一个任务恰好一个回合」,但 orchestrator 的回合数由模型临场决定(可能 explorer 后停、可能一口气到闸门)。任何一次中途停止都会把任务切成两个 run。707736e6/1c0fdcc1 即实证;且这是 docs §5.1 明文规定的行为(「回合结束 status 置 done → 下一需求开新 run;仅 awaiting_approval 归并」),**文档与用户期望冲突,方案 b 只是文档自洽**。

**结论**:不可行(除非接受「任务可拆多个 runId」,与需求相悖)。

### 方案 c:显式任务边界信号(推荐)

#### c1(推荐):显式完成工具 `complete_task` + 「纯文本回合自动完成」兜底

**机制**:
- 新增服务端工具 `complete_task`(与 `wait_for_approval` 同构):orchestrator 在**最终交付完成时**调用 → run 置 done + 释放 handle.run。orchestrator.md 加契约:「任务交付完成后必须调用 complete_task 并结束回合;未调用闸门也未调用 complete_task 的回合不结束任务」。
- 回合结束 finally 三分支:
  1. `turnWaitCalled` → `awaiting_approval` + gate(现状不变,闸门续跑归并);
  2. `turnCompleteCalled`(新标志) → `done` + `handle.run = null`;
  3. **兜底**:本回合**未调用任何子代理**且未调用闸门/complete_task(纯文本回合 = 交付总结/闲聊)→ `done` + 释放;
  4. 其余(调了子代理、没闸门、没 complete_task,即「中途停止」)→ **保持 executing,不置 done、不释放**,下一条消息自然归并同一 runId。
- `ensureRun` / `resolveCurrentRun` **零改动**:其「status≠done → 归并;done → 新建」规则正是新语义所需。
- `getRunSnapshot` 的 done 防护:**保留**(见 §6)。

**效果**(对照实测反例):
- 回合 1:explorer 结束,无闸门无 complete_task → run 707736e6 保持 executing、不释放;
- 回合 2:「继续制定计划」→ planner → `ensureRun` 归并 707736e6 → `02-plan-1.md` 与探索报告同目录 → 闸门 awaiting_approval → 批准 → executor/reviewer → complete_task(或纯文本交付回合)→ done + 释放;
- 下一个新任务 → 新 runId。**一个任务一个 runId 达成**;标准流程(explorer→planner→闸门→executor→reviewer→交付)的交付回合要么调 complete_task、要么是纯文本回合,都能正确 done。
- 崩溃/中断续跑:回合中断(错误/abort)不再误置 done,重发消息自然归并同一 run(与 docs §8「崩溃 = 标记中止 + 手动续跑」语义更一致)。

**信号可用性**:全部服务端、确定性、零文本解析——`turnWaitCalled`(现有)、`turnCompleteCalled`(新增,`complete_task` execute 内置 true)、`turnSubAgentCalled`(新增,子代理工具 execute 内置 true,用于兜底分支 3)、`gate.pending`、`status`。

**实现位置**:
| 文件 | 函数 | 改动 |
|---|---|---|
| `apps/api/src/pi/piService.ts` | `SessionHandle`(L66-75) | + `turnCompleteCalled`、`turnSubAgentCalled` |
| 同上 | `prompt()`(L580/L605-625) | 初始化两标志;finally 改三/四分支 |
| 同上 | `createSubAgentTool.execute`(L352) | `handle.turnSubAgentCalled = true` |
| 同上 | 新增 `createCompleteTaskTool`(仿 `createWaitForApprovalTool` L437-460) | 置 `turnCompleteCalled` + status done + gate.pending=false + saveRun + 发事件(可选 `task_complete` 事件) |
| 同上 | `openSession`(L309-315) 挂载新工具 | `subAgentTools.push(this.createCompleteTaskTool(workspace))` |
| `apps/api/src/pi/agents/orchestrator.md` | 调度策略 | 加「交付完成必须调用 complete_task」 |
| `apps/api/src/pi/runManager.ts` | `resolveCurrentRun` | **不改**(语义已兼容) |
| `docs/dag-workflow.md` | §5.1/§7 | 「回合释放」改「任务完成释放」;补 complete_task 流程 |
| 测试 | 新增/修改 | finally 三分支单测(建议补 piService 级或提取纯函数);`subAgent.test.ts` 的 RunFile fixture 无需改 schema |

**对既有 run 目录影响**:run.json schema 不变(status/gate/agents 字段语义不变);存量 done run 不受影响;存量「executing 但任务实际已完成」的 run(仅存在于 fd6057f 之后、本方案之前的窗口)会被后续消息继续归并——可接受,或由 `complete_task` 契约自然收敛。

**风险与缓解**:模型忘记调 complete_task → 兜底分支 3(纯文本交付回合自动 done)兜住大部分;若模型连纯文本交付都不给(罕见,最后一条是工具结果),run 停留在 executing,下一个新任务会被误归并(过度归并方向,可恢复:agents[] 时序完整、产物不覆盖——NN-role-N 序号命名保证不覆盖)。这与文档「代码兜底、不靠模型自觉」哲学一致(闸门本身就是模型驱动的先例,已接受同类风险)。

#### c2:前端显式 taskId 贯穿

**机制**:`POST /prompt` 带 `taskId`(前端:新任务生成新 id;闸门按钮复用当前 run 的 taskId);服务端 `ensureRun` 按 taskId 归并/新建。run.json 加 `taskId` 字段。

**分析**:完全确定性、用户意图驱动;但需 API + shared 类型 + 前端状态机三处改动,且「何时算新任务」的判定从服务端挪到前端(前端仍要依赖 run done 状态来生成新 taskId——判定逻辑没消失,只是搬家),对既有前端(SendMessage 无额外参数)与测试影响面大。**收益不匹配成本,不推荐为首选**;可作为 c1 的长期演进(消息携带 `{ taskId, gateAction }` 结构化闸门信号,替代文本约定)。

#### c3:启发式完成判定(无新工具)

**机制**:回合结束无闸门时,按 run.agents 构成 + review 文本判「任务完成」再置 done(如:reviewer 最近一次报告首行含 pass → done;或本回合无子代理调用且 agents 非空 → done;其余保持 executing)。

**分析**:零 API/工具改动,但依赖模型文本约定(reviewer.md 首行「结论 pass/fail」),判定脆弱、单测难写、误判方向不可控。**不推荐**;其「纯文本回合 = 完成」的规则已并入 c1 兜底分支 3。

---

## 6. getRunSnapshot done 防护与 finally 置空的调整

- **done 回填防护(getRunSnapshot:640-645,`status !== 'done'` 才回填 handle.run):必须保留**。它是「done run 不被后续任务复用」的最后防线:若去掉,磁盘 done run 会在下一次 `getRunSnapshot`(前端轮询/恢复)时重新挂回 handle,`ensureRun` 就会再次复用旧 runId,过度归并复发。
- **finally 的 `handle.run = null`(piService.ts:621):保留,但触发条件收窄**——从「回合结束且 status=done」(现行为)改为「任务完成(done)」:complete_task 分支 / 纯文本交付回合分支才置 null;中途停止回合不置 null(handle.run 保留,下回合 `ensureRun` 直接命中内存归并,连磁盘扫描都省了)。
- **saveRun 内容比对方案(上一任务 1c0fdcc1 计划中、尚未实施)与本方案正交**:中途停止回合 finally 不再改写 status(保持 executing),配合内容比对可进一步减少无谓写盘;两者兼容,无冲突。

---

## 7. 结论与建议

1. **现状**:fd6057f 方案 A(回合结束 done 即释放)解决了「多任务并一个 run」,但把任务边界错误地等同于回合边界,导致任务跨非闸门回合即拆分(707736e6/1c0fdcc1 实证)。
2. **推荐方案 c1**:新增 `complete_task` 工具 + 回合结束 finally 三分支(闸门→awaiting_approval;完成/纯文本回合→done+释放;中途停止→保持 executing 不释放)+ 保留 getRunSnapshot done 防护。核心改动集中在 `apps/api/src/pi/piService.ts`(SessionHandle 两标志、prompt finally、新工具、openSession 挂载)+ `orchestrator.md` 契约 + `docs/dag-workflow.md` §5.1 措辞(「回合释放」→「任务完成释放」)+ 单测;`runManager.ts` 与 shared 类型零改动。
3. **方案 a 单独不成立**(新任务信号仍需「任务完成」判定);方案 b 是现状,继续拆任务;c2/c3 为备选(代价高/判定脆)。
4. 与文档一致性:状态机 `planning → awaiting_approval → executing → reviewing → done` 不变;「进行中归并,否则新建」不变;仅把「回合结束置 done」改为「任务完成置 done」——文档 §5.1 需同步一句,其余章节(闸门、恢复、产物命名)不受影响。
