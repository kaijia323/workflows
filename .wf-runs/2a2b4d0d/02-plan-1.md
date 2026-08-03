# 实施计划:runId 粒度修正——一个编排任务一个 runId(方案 c1)

> 依据:.wf-runs/2a2b4d0d/01-exploration-1.md(必读,含完整链路分析、方案对比与实测反例 707736e6/1c0fdcc1)
> 目标:修复 fd6057f 方案 A「回合结束 done 即释放 run」导致的同任务跨非闸门回合被拆成多个 runId;实现方案 c1(显式 `complete_task` 工具 + 回合结束三分支)。
> 约束:只读调研已完成,本计划仅规划;除本文件外不产生任何代码改动。

---

## 1. 目标与范围

### 1.1 做什么
1. 新增服务端工具 `complete_task`:编排者(orchestrator)在**最终交付完成时**显式声明任务完成 → run 置 `done` + 释放内存 run。
2. 重写 `prompt()` 回合结束 finally 为**三分支**:
   - 调过 `wait_for_approval`(闸门)→ `awaiting_approval`(不释放,归并,保持现状);
   - 调过 `complete_task` 或**纯文本交付回合**(未调任何子代理/闸门/完成工具)→ `done` + `handle.run = null`(释放);
   - 调过子代理但无闸门无 complete_task(中途停止)→ **保持 `executing`、不释放**,下一条消息自然归并同 runId。
3. 增加「回合失败(错误/abort)不处置 run」防护:失败回合不置 done、不释放,续跑自然归并(对齐 docs §8「崩溃 = 标记中止 + 手动续跑」)。
4. 同步 `orchestrator.md` 契约与 `docs/dag-workflow.md` §5.1/§7/§12 措辞。
5. 新增 `decideTurnEnd` 纯函数单测 + run 生命周期归并集成测试。

### 1.2 不做什么(明确排除)
- **不改** `runManager.ts` 的 `ensureRun` / `resolveCurrentRun` / `createRun` / `saveRun` / `toSnapshot`(语义已兼容,零改动,见 §4)。
- **不改** `packages/shared` 类型(run.json schema、RunStatus、SessionEvent 均不变)。
- **不改** 前端(useAgent.ts / ChatPane.vue / DagPanel.vue)与 API 路由(routes.ts):不新增 SSE 事件类型,`complete_task` 复用现有 `done` 事件 + 前端 `refreshRun()` 完成 DAG 刷新(探索报告所述「可选 task_complete 事件」**本期不做**,避免 shared 类型与前端联动改动的扩散)。
- **不引入** 文本解析/启发式完成判定(方案 c3)、前端 taskId 贯穿(方案 c2)、内容比对写盘优化(与本期正交,探索报告 §6 已确认兼容、不冲突)。
- **不改** 子代理产物命名、子代理会话存储、闸门交互(按钮仍发普通文本)。

---

## 2. 改动文件清单与精确改动点

| # | 文件 | 函数/位置 | 改动内容 |
|---|---|---|---|
| 1 | `apps/api/src/pi/runManager.ts` | 新增导出纯函数 `decideTurnEnd` + 类型 `TurnEndDecision`(文件尾部) | 回合结束决策的单一事实源,便于单测(见 §3.1) |
| 2 | `apps/api/src/pi/piService.ts` | `SessionHandle` 接口(L66-75) | 新增两字段:`turnCompleteCalled: boolean`、`turnSubAgentCalled: boolean`(注释:本回合是否调过 complete_task / 子代理) |
| 3 | 同上 | `openSession`(L309-315) | ① handle 字面量初始化两新标志为 `false`;② 挂载新工具:`subAgentTools.push(this.createCompleteTaskTool(workspace))`(在 `createWaitForApprovalTool` push 之后)。`tools: [...activeTools, ...subAgentTools.map(t => t.name)]` 自动包含 complete_task,无需另改 |
| 4 | 同上 | `prompt()`(L580 与 L605-625) | ① 回合开始处(L580 附近)除现有 `turnWaitCalled = false` 外,重置 `turnCompleteCalled = false`、`turnSubAgentCalled = false`;② `try/catch` 的 catch 块加 `turnFailed = true`(局部 `let turnFailed = false` 声明于函数顶部);③ finally 重写为三分支 + 失败防护,调用 `decideTurnEnd`(见 §3) |
| 5 | 同上 | `createSubAgentTool.execute`(L352-360 附近) | 在 `const handle = this.handles.get(workspace.id)` 之后、`ensureRun` 之前加 `handle.turnSubAgentCalled = true`(放在 try/catch 外,失败调用也计入「本回合调过子代理」) |
| 6 | 同上 | 新增私有方法 `createCompleteTaskTool(workspace: Workspace): ToolDefinition`(放在 `createWaitForApprovalTool` 之后,仿其结构) | 见 §3.2 完整要点 |
| 7 | `apps/api/src/pi/agents/orchestrator.md` | 工具列表 + 调度策略 | ① 工具列表补 `complete_task(完成任务):参数 summary:交付总结`;② 新增规则:「任务交付完成后必须调用 complete_task 声明完成,然后立即结束回合;未调用闸门也未调用 complete_task 的回合不结束任务(任务保持进行中)」;③ 约束区补「不要在任务中途仅以纯文本结束回合,纯文本只用于交付总结/简短汇报」 |
| 8 | `docs/dag-workflow.md` | §5.1、§7、§12 | 见 §5 文档同步点 |
| 9 | `apps/api/src/pi/runManager.test.ts` | **新增测试文件** | `decideTurnEnd` 全分支矩阵 + run 生命周期集成测试(见 §6.2) |
| — | `apps/api/src/pi/subAgent.ts`、`subAgent.test.ts`、shared、routes.ts、前端 | 零改动 | run.json schema 不变,`subAgent.test.ts` 的 RunFile fixture 无需改 |

---

## 3. 核心逻辑设计

### 3.1 `decideTurnEnd` 纯函数(runManager.ts 新增)

```ts
export type TurnEndDecision = 'awaiting_approval' | 'done' | 'keep'

/**
 * 回合结束决策(纯函数,供 prompt() finally 与单测共用)。
 * - turnFailed: 回合异常(错误/abort),不做任何处置(任务状态未知,保守保持)
 * - turnWaitCalled: 闸门优先(即使同时调过 complete_task 也以闸门为准,模型异常行为,闸门胜出)
 * - turnCompleteCalled || !turnSubAgentCalled: 显式完成 / 纯文本交付回合 → done
 * - 其余(调过子代理、无闸门、无 complete_task)= 中途停止 → keep(保持 executing,下回合归并)
 */
export function decideTurnEnd(flags: {
  turnFailed: boolean
  turnWaitCalled: boolean
  turnCompleteCalled: boolean
  turnSubAgentCalled: boolean
}): TurnEndDecision {
  if (flags.turnFailed) return 'keep'
  if (flags.turnWaitCalled) return 'awaiting_approval'
  if (flags.turnCompleteCalled || !flags.turnSubAgentCalled) return 'done'
  return 'keep'
}
```

### 3.2 `prompt()` finally 重写伪代码(piService.ts)

```ts
// 回合开始(L580 附近)
handle.turnWaitCalled = false
handle.turnCompleteCalled = false
handle.turnSubAgentCalled = false
let turnFailed = false

try {
  await handle.session.prompt(text)
  onEvent({ type: 'done' })
} catch (error) {
  turnFailed = true                                  // ← 新增:失败回合不处置 run
  onEvent({ type: 'error', message: ... })
} finally {
  const run = handle.run
  if (run) {
    const decision = decideTurnEnd({
      turnFailed,
      turnWaitCalled: handle.turnWaitCalled,
      turnCompleteCalled: handle.turnCompleteCalled,
      turnSubAgentCalled: handle.turnSubAgentCalled,
    })
    if (decision === 'awaiting_approval') {
      run.status = 'awaiting_approval'
      run.gate = { pending: true, planFile: detectPlanFile(workspace.path, run) }
      saveRun(workspace.path, run)
      // 不释放 handle.run:闸门续跑归并(现状不变)
    } else if (decision === 'done') {
      run.status = 'done'
      run.gate.pending = false
      saveRun(workspace.path, run)
      handle.run = null                               // 任务完成释放(原方案 A 的置空,触发条件收窄)
    }
    // decision === 'keep':不写盘、不释放。
    // 中途停止回合:run.status 已在子代理工具 execute 时置为 executing 并 saveRun,
    // finally 无状态变化,不写盘(避免无谓写盘与 updatedAt 漂移);
    // handle.run 保留 → 下回合 ensureRun 直接命中内存归并,连磁盘扫描都省了。
  }
  unsubscribe()
  handle.busy = false
  handle.lastActivityAt = Date.now()
  this.activeEmitter = null
  updateSessionMeta(...)
}
```

### 3.3 状态迁移表(完整分支矩阵,含边缘)

| turnFailed | turnWaitCalled | turnCompleteCalled | turnSubAgentCalled | 决策 | run.status(写盘后) | gate | handle.run | 典型场景 |
|---|---|---|---|---|---|---|---|---|
| true | 任意 | 任意 | 任意 | **keep** | 不变(不写盘) | 不变 | 不释放 | API 报错 / 用户 abort / 子代理工具抛错致回合失败 |
| false | true | 任意 | 任意 | **awaiting_approval** | awaiting_approval | `{pending:true, planFile}` | 不释放 | explorer→planner→闸门(含同回合连调子代理);闸门胜出(同时调 complete_task 的模型异常也归此) |
| false | false | true | 任意 | **done** | done | pending=false | 释放(null) | executor→reviewer→complete_task 交付 |
| false | false | false | false | **done** | done | pending=false | 释放(null) | 纯文本交付总结回合 / 闲聊回合(handle.run 为 null 时本就无操作) |
| false | false | false | true | **keep** | executing(不变,不写盘) | 不变 | 不释放 | **中途停止**(实测反例回合 1:explorer 后停下汇报)→ 下条消息归并同 runId |

**边缘说明(探索报告结论)**
- **纯文本回合(无子代理、无闸门、无 complete_task)→ done + 释放**:该回合被解释为「交付总结/闲聊」。风险:任务中途的纯文本确认回合会被误判完成(见 §8.5);缓解:orchestrator 契约明确「不要在任务中途仅以纯文本结束回合」,且误判方向不丢任何产物(NN-role-N 序号命名)。
- **闸门优先级**:`turnWaitCalled` 判定最先,即使模型异常地同时调了 complete_task 也以闸门为准(计划未批准前任务未完成)。
- **失败防护(turnFailed)**:错误/abort 回合一律 keep——否则「回合一开始就 API 失败」会被纯文本分支误判 done 并释放,再次拆分任务。子代理工具执行失败会向上抛 → session.prompt reject → catch → turnFailed=true → keep,与「崩溃 = 标记中止 + 手动续跑」(docs §8)语义一致。
- **keep 分支不写盘**:状态在子代理 execute 时已落盘为 executing;不写避免 updatedAt 漂移。若后续实施「saveRun 内容比对」(探索报告 §6),与本逻辑正交兼容。

### 3.4 `createCompleteTaskTool` 实现要点(与 `wait_for_approval` 对称)

```ts
private createCompleteTaskTool(workspace: Workspace): ToolDefinition {
  const params = Type.Object({
    summary: Type.String({ description: '交付总结(已完成内容、关键产物位置)' }),
  })
  return {
    name: 'complete_task',
    label: 'complete_task',
    description:
      '声明当前任务已全部完成(最终交付)。任务交付完成后必须调用此工具并立即结束回合;' +
      '调用后本任务的 run 标记为完成,下一次新需求将开启新的 run(新产物目录)。',
    promptSnippet: 'Mark the current task as complete',
    parameters: params,
    execute: async (_callId, params) => {
      const handle = this.handles.get(workspace.id)
      if (!handle) throw new Error('会话已关闭')
      const run = this.ensureRun(handle)              // 与 wait_for_approval 一致:无 run 则新建(罕见,容忍空 done run)
      handle.turnCompleteCalled = true
      run.status = 'done'
      run.gate = { pending: false, planFile: null }
      saveRun(workspace.path, run)                    // 立即落盘:崩溃安全(complete_task 后进程崩溃,任务已完成状态不丢)
      return {
        content: [{ type: 'text' as const, text: '任务已标记为完成。立即结束回合,向用户做最终交付总结。' }],
        details: undefined,
      }
    },
  }
}
```

**对称性对照(wait_for_approval vs complete_task)**
| 维度 | wait_for_approval(现状) | complete_task(新增) |
|---|---|---|
| 工具形态 | 普通工具,参数 `{summary}` | 普通工具,参数 `{summary}` |
| execute 副作用 | ensureRun → status=awaiting_approval + gate.pending=true + saveRun + turnWaitCalled=true | ensureRun → status=done + gate.pending=false + saveRun + turnCompleteCalled=true |
| 回合结束处置 | finally:awaiting_approval(不释放) | finally:done + handle.run=null(释放) |
| 返回 | 占位文本「已请求批准,停止回合」 | 占位文本「已标记完成,结束回合做交付总结」 |
| SSE 事件 | 发 `gate_required` | **不发新事件**(本期;前端靠 `done` 事件 + refreshRun 刷新 DAG) |

**自愈说明**:complete_task execute 即置 done;若模型违规在 complete_task 后又调子代理,`createSubAgentTool.execute` 现有逻辑会把 done 翻回 executing(现状代码),而 `turnCompleteCalled` 仍为 true → finally 再次置 done。状态最终一致。

---

## 4. ensureRun / resolveCurrentRun / getRunSnapshot 处置结论

- **`ensureRun`(piService.ts L324-338):零改动**。「`handle.run` 优先 → 磁盘扫「同会话 && (gate.pending || status≠done)」→ 否则 createRun」正是新语义所需:中途停止回合后 handle.run 保留(内存命中);服务重启后 executing run 被磁盘扫描命中;done run 不再复用。
- **`resolveCurrentRun`(runManager.ts L100-118):零改动**。同上。
- **`getRunSnapshot`(piService.ts L636-647)的 done 回填防护:`保留`**。探索报告 §6 结论:它是「done run 不被后续任务复用」的最后防线(去掉后磁盘 done run 会在前端轮询/恢复时重新挂回 handle,过度归并复发)。本方案不触碰。
- **finally 的 `handle.run = null`:保留,但触发条件收窄**——从「回合结束且 status=done」改为「任务完成(done)分支」;keep/awaiting_approval 分支不置空。

---

## 5. 文档同步点

### 5.1 `docs/dag-workflow.md`
- **§5.1**:将「回合释放」段落改写为「任务完成释放」:
  - 原:「回合结束(status 置 done)后服务端释放内存中的 run(`handle.run = null`)……仅 awaiting_approval(闸门等待)归并同一 run」
  - 新:任务完成(status 置 done,由 `complete_task` 工具或纯文本交付回合触发)后释放内存 run;闸门等待(awaiting_approval)与**中途停止回合(调过子代理但未到闸门/完成)**均不释放——前者靠 gate.pending 归并,后者 run 保持 executing,下一条消息自然归并同一 runId。
- **§5.2**:状态机 `planning → awaiting_approval → executing → reviewing → done` 不变,无需改。
- **§7**:在闸门交互小节后补「任务完成」说明:orchestrator 在最终交付时调用 `complete_task`(与 `wait_for_approval` 同构的普通工具)→ run 置 done + 释放;纯文本交付回合为服务端兜底(模型未调 complete_task 时自动 done)。
- **§12 决策记录**:追加一条「任务边界 = 显式 complete_task / 纯文本交付回合;中途停止回合不释放 run(方案 c1,修复 fd6057f 回合级释放副作用)」。

### 5.2 `apps/api/src/pi/agents/orchestrator.md`
- 工具列表补 `complete_task`(见 §2 第 7 行)。
- 调度策略新增规则 5/6(见 §2 第 7 行),规则编号顺延现有 1-5。

---

## 6. 测试影响与新增用例

### 6.1 对现有测试的影响
| 测试文件 | 影响 | 说明 |
|---|---|---|
| `subAgent.test.ts` | **无** | RunFile fixture 的 schema(status/gate/agents)不变;`makeRun()` 无需改 |
| `agentDefs.test.ts` | **无** | orchestrator 断言:`frontmatter.agents` 仍为 `['explorer','planner','executor','reviewer']`(complete_task 是工具不是子代理,不进 agents 白名单);body 长度断言不受影响 |
| `fffTools/history/workspaceGuard/config/app.test.ts` | **无** | 不触及 |
| 现有全量 | 无回归预期 | run.json schema、shared 类型、路由、前端均未改 |

### 6.2 新增测试:`apps/api/src/pi/runManager.test.ts`(新文件,仿 subAgent.test.ts 的 tmpdir 模式)

**A. `decideTurnEnd` 纯函数矩阵(7 用例)**
1. `turnFailed=true` → `'keep'`(即使其他标志任意组合)
2. `turnWaitCalled=true` → `'awaiting_approval'`(含同时 completeCalled=true 的异常组合,闸门胜出)
3. `turnCompleteCalled=true` + 调过子代理 → `'done'`
4. 纯文本回合(全 false)→ `'done'`
5. 调过子代理、无闸门、无 complete(中途停止)→ `'keep'`
6. 调过子代理 + 闸门 → `'awaiting_approval'`
7. 调过子代理 + complete_task → `'done'`

**B. run 生命周期集成测试(真实 tmp 目录,走 createRun/saveRun/resolveCurrentRun/appendRunAgentCall)**
1. **中途停止回合不释放(核心回归)**:turn1 子代理调用后决策 keep → run.json status=executing、`resolveCurrentRun` 返回同一 run;turn2 再次子代理调用(appendRunAgentCall)→ 仍同一 runId。
2. **complete_task 释放**:决策 done + saveRun 后,`resolveCurrentRun` 返回 null(不再复用);`createRun` 产生**不同** runId。
3. **闸门归并**:status=awaiting_approval + gate.pending=true → `resolveCurrentRun` 返回同一 run;续跑后子代理调用将 status 翻回 executing、gate.pending=false(现有行为回归)。
4. **纯文本交付释放**:决策 done → resolveCurrentRun null → 新 runId。
5. **失败防护**:turnFailed=true → run.json 内容不变(updatedAt 不变,不写盘)、handle 语义上不释放(以 resolveCurrentRun 返回同一 run 验证)。

> 说明:不做 piService 级集成测试(`PiAgentService.create` 需 ModelRuntime + 真实模型配置,单测不可行);决策逻辑已抽为 `decideTurnEnd` 纯函数置于 runManager.ts(依赖轻、无 SDK 导入),配合上述集成测试即覆盖 finally 三分支。

---

## 7. 验证步骤

### 7.1 自动化(api 包,`pnpm --filter @workflows/api` 前缀)
1. `pnpm --filter @workflows/api test` — 全量 vitest 通过(新增 runManager.test.ts + 既有 5 个测试文件无回归)
2. `pnpm --filter @workflows/api typecheck` — tsc --noEmit 通过
3. `pnpm --filter @workflows/api lint` — eslint 通过
4. `pnpm --filter @workflows/api build` — tsc 构建 + copy-agents.mjs 复制 agents/*.md(dist 中 orchestrator.md 含新契约)
5. shared 包无需重建(零改动)

### 7.2 手动 E2E(需 DeepSeek API key;模型行为非确定,以单测为主、E2E 为抽查)
场景 A — **同任务跨多回合单 runId(核心回归,复现 707736e6/1c0fdcc1 反例)**:
1. 打开工作区会话,发消息「先探索一下这个仓库的结构」(诱导 orchestrator 只调 explorer 后停下);
2. 回合结束后查 `GET /api/agent/workspaces/:id/run` → status=executing、runId=R1(不再 done);
3. 发「基于探索结果制定实施计划」→ planner → 闸门;再次查 run → 仍 R1,gate.pending=true,`02-plan-1.md` 与 `01-exploration-1.md` 同目录 `.wf-runs/R1/`;
4. 批准 → executor → reviewer → complete_task;查 run → status=done;
5. 核对 `.wf-runs/R1/` 含 01-exploration-1.md / 02-plan-1.md / 03-execution-1.md / 04-review-1.md,全程仅一个 runId 目录。

场景 B — **完成任务后再开新任务 → 新 runId**:场景 A 后发全新需求 → 查 run → 新 runId R2,新目录,`R1` 产物不受影响。

场景 C — **闸门归并回归**:planner → 闸门(awaiting_approval)→ 批准 → 续跑 → 全程同一 runId(现状行为不倒退)。

场景 D — **中途 abort 不释放**:子代理运行中前端中止 → 查 run → 仍 executing(不 done);重发同任务消息 → 归并同 runId。

场景 E — **纯文本交付兜底**(观察项):若模型交付回合未调 complete_task 仅输出总结文本 → run 应自动 done;下个新需求新 runId。

### 7.3 提交
- 单 commit,message 建议:`fix(pi): run 按任务粒度释放——新增 complete_task 工具,中途停止回合不再释放 run(修复 fd6057f 副作用)`;
- 提交前确认 `git status` 仅含:piService.ts、runManager.ts、runManager.test.ts、agents/orchestrator.md、docs/dag-workflow.md。

---

## 8. 风险与边界

### 8.1 回滚方案
- 改动集中在 5 个文件(2 源码 + 1 新测试 + 2 文档),单 commit 可 `git revert` 整体回退;回退后回到 fd6057f 行为(回合级释放,任务仍会跨非闸门回合拆分,但不产生数据损坏)。
- 回退前无需迁移:run.json schema 未变,新旧代码读同一格式。

### 8.2 旧 run 目录兼容
- **存量 done run**:不受影响(本就 done,新任务直接开新 run)。
- **fd6057f 之后、本方案之前的「bug 窗口」run**:
  - 已 done 但任务实际未完成(707736e6 型):无法回溯合并,用户续跑会开新 run——可接受,产物不丢,文档说明即可;
  - 已 done 但任务实际已完成:与新语义一致,无影响;
  - 处于 executing 的(极少,方案 A 下回合结束必置 done):后续消息会归并,方向正确。
- 本方案上线后中途停止回合保持 executing——这是新语义,与 docs §5.1 同步后的口径一致。

### 8.3 崩溃续跑语义(与 docs §8 对齐)
- 回合内崩溃/abort → turnFailed → keep → run 保持 executing,重发消息归并同 runId(主代理上下文在会话 JSONL 中完好,自行判断重跑或继续)。
- complete_task 之后崩溃 → run 已落盘 done(execute 即落盘,崩溃安全),续跑开新 run——语义正确(任务已声明完成)。

### 8.4 与 46569220 既有 done run 的交互
- 46569220 是「过度归并」反例(一个 run 装两个任务,7 次调用,status=done)。新代码下:该 run 已 done → `resolveCurrentRun` 不返回它、`getRunSnapshot` done 防护不回填 → 新任务自动开新 runId,不会继续污染。无迁移动作。
- 用户若需拆分该 run 的产物,是既有数据问题,不在本期范围(可手工整理目录)。

### 8.5 模型行为风险
- **模型忘记调 complete_task**:纯文本交付回合兜底自动 done(§3.3 第 4 行);极端情况(最后一条消息是工具结果、无文本)→ run 停在 executing,下一个新任务被误归并(过度归并方向)——产物不覆盖(NN-role-N 序号),agents[] 时序完整,可人工恢复;与闸门「代码兜底、不靠模型自觉」的既有哲学一致(探索报告已接受)。
- **任务中途纯文本确认回合**(模型违规):误判 done + 释放 → 下一消息开新 run(拆分方向,但无工作丢失)。缓解:orchestrator.md 契约明文禁止中途纯文本结束回合;属可接受的文档/模型博弈成本。
- **同回合连调子代理后闸门 / complete_task**:分别命中 awaiting_approval / done 分支,正常。
- **同回合既调闸门又调 complete_task**(模型异常):闸门胜出(§3.3),以 run.json gate 状态可观测,无需额外处理。

### 8.6 其他
- `turnSubAgentCalled` 在子代理工具 execute 入口(handle 取得后)即置位,失败调用也计数——保证「子代理报错回合」落入 keep 而非 done。
- `complete_task` 在 handle.run 为 null 时调用会创建空 done run(罕见,模型异常):无害,`listRuns`/DAG 可见一个空 run,可接受。

---

## 9. 验收标准(逐条核对)

- [ ] `runManager.ts` 新增导出 `decideTurnEnd` + `TurnEndDecision`;`ensureRun`/`resolveCurrentRun`/`createRun`/`saveRun`/`toSnapshot` **零改动**(git diff 确认)。
- [ ] `piService.ts` `SessionHandle` 含 `turnCompleteCalled`/`turnSubAgentCalled`,openSession 初始化并在 `wait_for_approval` 之后挂载 `complete_task` 工具。
- [ ] `prompt()` 回合开始重置 3 标志;catch 置 `turnFailed`;finally 三分支 + 失败防护完整实现,决策逻辑仅经 `decideTurnEnd`。
- [ ] `createSubAgentTool.execute` 入口置 `turnSubAgentCalled = true`(try 外)。
- [ ] `createCompleteTaskTool` 与 `wait_for_approval` 对称:参数 `{summary}`,execute 置 `turnCompleteCalled` + status=done + gate.pending=false + saveRun,返回「结束回合做交付总结」占位文本;未新增 SSE 事件类型。
- [ ] `getRunSnapshot` done 回填防护**原样保留**(git diff 无此函数改动)。
- [ ] `orchestrator.md` 含 complete_task 工具说明与「交付完成必须调用 complete_task;未调闸门/complete_task 的回合不结束任务;勿中途纯文本结束回合」契约。
- [ ] `docs/dag-workflow.md` §5.1 措辞为「任务完成释放」、§7 补 complete_task 说明、§12 追加决策记录。
- [ ] `runManager.test.ts` 新增且覆盖 §6.2 全部用例(矩阵 7 + 集成 5),`pnpm --filter @workflows/api test` 全绿。
- [ ] `pnpm --filter @workflows/api typecheck / lint / build` 全绿;build 产物 dist/pi/agents/orchestrator.md 含新契约。
- [ ] 手动 E2E 场景 A(单 runId 贯穿多回合)与场景 B(新任务新 runId)验证通过;场景 C(闸门归并)/D(abort 不释放)无回归。
- [ ] 提交仅含 5 个文件(piService.ts、runManager.ts、runManager.test.ts、agents/orchestrator.md、docs/dag-workflow.md),无 shared/前端/路由改动。
