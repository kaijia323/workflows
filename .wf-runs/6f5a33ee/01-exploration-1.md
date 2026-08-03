# 空 run 产生机制探索报告(run 创建与结束逻辑)

任务背景:complete_task 完成后,用户下一条消息(如"提交"/简短询问)会创建新 runId(实测 2381975b,agents: [],status done),run.json 落盘导致 `.wf-runs/` 出现新未跟踪目录,git status 永远脏。
目标:弄清 run 创建/结束逻辑,定位"空 run"产生机制,给出"空 run 不落盘或自动清理"的最小改动建议(行号级),不改代码。

---

## 0. 结论摘要(先看这里)

1. **空 run 不是 prompt() 创建的,而是 `complete_task` 工具 execute 内的 `ensureRun` 创建的**。上一任务 complete_task 后 `handle.run = null`(piService.ts L517);下一条消息模型把"提交"解读为完成信号,**再次调用 complete_task**(L508)→ `ensureRun` 找不到可复用 run(`resolveCurrentRun` 排除 done)→ `createRun`(L345)立即写盘(planning, agents:[])→ L510 置 done + L513 saveRun → 空 run 以 done 终态落盘。
2. **prompt() 的 finally 三分支完全没有参与**空 run 的产生:complete_task 在 L517 已把 `handle.run` 置 null,finally(L671)看到 null 直接跳过三分支。`decideTurnEnd` 对空 run 一次都没执行。
3. **"新建而非复用"是有意设计**(done=终态,新需求开新 run,docs §5.1);上一轮加的 done 冻结(saveRun L75-77)只防"改写已 done 的 run.json",**不防"新建"**——两者是不同路径,所以冻结没拦住。
4. **纯文本消息本身零创建**:run 只在"需要 run 的工具被调用"时才创建(子代理/闸门/complete_task 三个 execute),消息到达 prompt() 不创建任何东西。所以"让无内容消息不创建 run"在服务端层面已经成立,当前问题只是**模型在无内容消息上多调了一次 complete_task**,而 complete_task 无条件 ensureRun 新建。
5. **最小修复**(~5 行):complete_task(及对称的 wait_for_approval)把 `ensureRun` 改为"复用优先、无 run 则空操作"。这样无内容消息调 complete_task 时什么都不落盘,真实任务(done 前有 agents 的 run)行为完全不变。可选加"空 run 判定 + 删除目录"兜底清理历史残留,以及 createRun 惰性化加固。

---

## 1. 仓库概览

- **技术栈**:TypeScript monorepo(turbo workspace);apps/api(Hono + SSE,`@earendil-works/pi-coding-agent` 的 AgentSession 驱动 LLM)、packages/shared(类型)、apps/web(前端,非本次重点)。
- **pi 模块**:`apps/api/src/pi/` 下 piService.ts(服务层/回合编排)、runManager.ts(run 生命周期)、subAgent.ts(子代理执行)、workspaceGuard.ts(路径守卫)、fffTools.ts(搜索)、agentDefs.ts/promptLoader.ts/history.ts。
- **构建/测试**:turbo(pnpm);单测 vitest(`apps/api/src/pi/*.test.ts`,runManager.test.ts 15 例);typecheck/lint/build。
- **设计文档**:`docs/dag-workflow.md` §5.1(run 语义)、§7(闸门)、§8(恢复)。
- **产物**:`.wf-runs/<runId>/run.json` + `NN-role-N.md`(git 可追踪,已全量进 git;`.gitignore` 已无 `.wf-runs` 规则,故新 run 目录 = 未跟踪 = git 脏)。

---

## 2. 需求相关模块清单

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/pi/runManager.ts` | run 生命周期:createRun(L51)/saveRun(L69,含 done 冻结 L75-77)/loadRun(L84)/listRuns(L95)/resolveCurrentRun(L112)/decideTurnEnd(L166)/appendRunAgentCall(L149) |
| `apps/api/src/pi/piService.ts` | PiAgentService:prompt() 回合编排(L641 起)、ensureRun(L333)、三个"需要 run 的工具"execute(子代理 L371/闸门 L466/complete_task L508)、finally 三分支(L665-694) |
| `apps/api/src/pi/subAgent.ts` | 子代理执行:产物写 `.wf-runs/<runId>/NN-role-N.md`(L367 prompt 注入产物名、detectArtifact L105 检测) |
| `apps/api/src/agent/routes.ts` | HTTP 入口:POST /prompt → pi.prompt(L171);GET run 快照等 |
| `apps/api/src/pi/runManager.test.ts` | run 生命周期/决策矩阵单测(15 例,改动需回归) |
| `docs/dag-workflow.md` | §5.1 run 开启/归并/释放规则;§8 恢复;§12 决策记录 |

---

## 3. createRun/ensureRun 调用点清单(行号,已逐一核对)

**createRun 定义**:`runManager.ts L51-65`(L52 shortId 8 位;L54 `mkdirSync` 立即建目录;L55-62 构造 run(planning, agents:[]);L64 `saveRun` 立即写盘)。
**createRun 唯一生产调用点**:`piService.ts L345`(ensureRun 内,`const created = createRun(...)`)。测试文件 runManager.test.ts 多处直接调用(测试专用)。

**ensureRun 定义**:`piService.ts L333-348`。
- L336-340:内存优先(`handle.run` 非 done 直接复用)→ 磁盘扫描(`resolveCurrentRun`)。
- L341-344:命中则挂回 `handle.run` 返回。
- L345-347:未命中 → `createRun` 新建。

**ensureRun 三个调用点**(全部在工具 execute 内,**消息路径上没有调用**):
- `piService.ts L371` — createSubAgentTool.execute(模型调用子代理时;调用前先 `turnSubAgentCalled = true` L370)
- `piService.ts L466` — createWaitForApprovalTool.execute(闸门)
- `piService.ts L508` — createCompleteTaskTool.execute(任务完成)

**恢复路径(只读,不新建)**:`piService.ts L321` openSession 时 `resolveCurrentRun(workspace.path, finalId, null)` 挂回进行中 run。

**结论**:不是每个用户消息都触发;只有"模型在回合内调用了子代理/闸门/complete_task 且当前无可复用 run"时才新建。同一 sessionId 非 done 复用(内存 `handle.run` 优先,磁盘 `resolveCurrentRun` 兜底,run.json 记录 sessionId 作归属索引),done 不复用。

---

## 4. 空 run 完整产生路径(代码片段 + 行号)

实测数据(本仓库 `.wf-runs/`):
- `4a6bb996/run.json`:status done,reviewer 最后记录 ts=1785783988808(上一任务完成)。
- `2381975b/run.json`:createdAt=1785784027816(与上任务完成间隔 ~39s,即用户下一条消息),updatedAt=+992ms,`status: "done"`, `gate.pending: false`, `agents: []`。
- `6f5a33ee/run.json`(本次探索任务):planning,agents [] 暂空(子代理调用在途,appendRunAgentCall 尚未落)。

**产生路径(逐步)**:

```
① 上一任务 complete_task 收尾(piService.ts L504-527):
   L508  const run = this.ensureRun(handle)      // 复用 4a6bb996
   L510  run.status = 'done'
   L513  saveRun(workspace.path, run)            // 首次 done 写盘(冻结 L75-77 不拦)
   L517  handle.run = null                       // 立即释放,done 即终态

② 用户下一条消息 "提交" → routes.ts L171 → prompt()(L641) → session.prompt(text)(L659)
   (prompt 本身不创建 run;回合标志清零 L644-647)

③ 模型把"提交"解读为完成信号 → 同回合再次调用 complete_task

④ complete_task.execute(piService.ts L504-527):
   L508  const run = this.ensureRun(handle)
         → handle.run 为 null
         → resolveCurrentRun(L340)→ runManager.ts L119/L123-125:4a6bb996 是 done,被排除 → null
         → L345 createRun → runManager.ts L51-65:
             L54 mkdirSync(.wf-runs/2381975b)
             L64 saveRun → run.json 落盘(status=planning, agents:[])
   L509  handle.turnCompleteCalled = true
   L510  run.status = 'done'
   L511  run.gate = { pending: false, planFile: null }
   L513  saveRun(workspace.path, run)            // 空 run 以 done 终态落盘
   L517  handle.run = null

⑤ 回合结束 finally(L665-694):
   L671  const run = handle.run                  // = null(被 L517 清空)
   L672  if (run) …                              // 跳过,三分支不执行
   → 空 run 已由 complete_task 自己写 done,finally 无任何动作
```

**回答 Q2(哪个 finally 分支把空 run 置 done 写盘)**:**都不是**。空 run 由 complete_task.execute 自身(L508-517)置 done 并写盘,finally 三分支在此场景整体被跳过(handle.run 为 null)。finally 的 done 分支(L683-690)只处理"回合结束时 handle.run 仍指向非 done run"的情况。

**兄弟路径(同类风险)**:wait_for_approval(L466-470)同样无条件 ensureRun——若模型在无内容消息上调用闸门,会创建 agents:[] 的 awaiting_approval 空 run(gate.pending=true, planFile=null),同样产生未跟踪目录,只是状态不是 done。本次实测没出现,但同一根因。

---

## 5. 问题逐答

### Q1 createRun 调用点 / 触发时机 / sessionId 关联
见 §3。要点:
- **不是每个用户消息都触发**:消息本身走 prompt()(L659),零 run 操作;只有回合内模型调用"需要 run 的三种工具"且无可复用 run 时新建。所以"complete_task 之后的下一条消息"本身不会创建 run——是"下一条消息上模型又调了一次 complete_task"才创建。
- **run 与 sessionId**:createRun 把当前 `handle.sessionId` 写入 run.json(归属索引);同一 sessionId 非 done 复用(内存 handle.run 优先 → 磁盘 resolveCurrentRun 扫描,L121-125 按 sessionId 过滤),done 不复用;不同 sessionId 不交叉(openSession L321 按 finalId 恢复)。

### Q2 空 run 生命周期 / finally 三分支
见 §4。**空 run = complete_task 在"无进行中任务"时被调用**的产物:创建(planning,空)→ 同工具调用内置 done → 落盘 → 释放。finally 未参与。纯文本无工具消息:有进行中 run → finally done 分支(L685-690)置 done(设计:"纯文本交付回合");无 run → 无任何动作。**"无内容消息"本身从不创建 run**。

### Q3 为什么新建不复用;能否让无内容消息不创建 run
- **不复用是有意设计**:resolveCurrentRun 排除 done(runManager.ts L119、L123-125),complete_task 置 done + L517 释放 → 下一次需求开新 runId(docs §5.1"done 即终态,新需求开新 run")。
- **done 冻结没拦住"新建"是正常现象**:saveRun 冻结(L75-77)只对"磁盘已是 done 的 run.json"生效,防的是改写;而 2381975b 是全新 runId,从未 done 过,冻结无从触发。这是两条正交路径。
- **能让无内容消息不创建 run**:能,服务端硬防护即可(§6 Fix1)——complete_task/wait_for_approval 改为"复用优先、无 run 则空操作"。模型行为层(orchestrator.md 加提示"无进行中任务不要调 complete_task")不可靠,不作为主方案。

### Q4 惰性创建/延迟落盘可能性
- **现状**:createRun 立即写盘(L54 mkdirSync + L64 saveRun),planning 状态在创建瞬间就落盘。
- **可行**:createRun 改为只返回内存 RunFile、不碰磁盘;saveRun(L78 `mkdirSync(path.dirname(file))`)本来就自动建目录,第一次真实写盘时目录自然出现。子代理路径 L385(子代理启动前 saveRun 置 executing 语义)保证目录在产物写入前已存在;崩溃在首次 saveRun 前 → run 无任何内容,丢失零损失。
- **但仅惰性化不够**:complete_task L513 的 saveRun(对真实 run 是崩溃安全必需)仍会把空 run 写盘。必须搭配"空 run 判定 + 跳过写盘/删除目录"(§6 Fix2)才闭环。
- **"空 run 不落盘"最小改动点**:见 §6 Fix1(治本,一行改调用)+ Fix2(兜底,runManager 加判定/删除工具)。

### Q5 服务端如何决定 turn 结束;无工具消息的状态流转
- **decideTurnEnd**(runManager.ts L166-176):turnFailed→keep;turnWaitCalled→awaiting_approval;`turnCompleteCalled || !turnSubAgentCalled`→done;否则 keep。
- **一条消息不触发任何工具**(四标志全 false):决策恒为 **done**(因为 `!turnSubAgentCalled`)。若有进行中 run(handle.run 非空)→ finally done 分支把它置 done + 落盘 + 释放(L685-693):状态 flow = planning/executing → **done**(不经过 keep);若无 run(complete_task 后)→ 无任何流转、无写盘。
- **planning→keep 不存在于无工具回合**:keep 只在 `turnSubAgentCalled=true` 时出现,而子代理调用在 L371 后已推进状态(L383-385:awaiting_approval→executing 翻转 + saveRun)。即:无工具回合只有"有 run→done"或"无 run→无操作"两条路。
- **观察(非本次目标)**:子代理工具的 executing 翻转只对 awaiting_approval 生效(L383),fresh run 落盘状态实际保持 planning 直到 done/gate(6f5a33ee 即 planning);docs §5.1"run 保持 executing"与真实落盘状态有出入。

---

## 6. 最小改动建议(行号级)

### Fix1(主修复,治本,~5 行):complete_task 无 run 时空操作
- **位置**:`piService.ts L508`。
- **改法**:complete_task 不再无条件 `ensureRun`(它会新建),改为"复用优先、无 run 则直接返回":
  ```ts
  // L508 之前(推荐实现:给 ensureRun 加可选参数,避免重复逻辑)
  private ensureRun(handle: SessionHandle, create = true): RunFile | null {
    …(L336-344 原逻辑不变)…
    if (!create) return null                    // ← 新增:不允许新建
    const created = createRun(workspace.path, handle.sessionId)   // L345 原样
    …
  }
  // L508
  const run = this.ensureRun(handle, false)
  if (!run) {
    return { content: [{ type: 'text', text: '当前没有进行中的任务,无需标记完成。' }], details: undefined }
  }
  ```
- **效果**:上一任务 done 后(handle.run=null、磁盘全 done),模型再调 complete_task → 空操作,零落盘、零目录。真实任务(有 agents 的 planning/executing/awaiting_approval run)仍被 resolveCurrentRun 命中 → 正常置 done(语义不变,包括"完成一个被搁置的 pending 任务")。
- **注意**:ensureRun 返回类型变 `RunFile | null`,L371(子代理)与 L466(闸门)调用处需非空断言或保持默认 `create=true` 的窄化;也可不加参数、在 complete_task 内联 L336-340 的复用查找(L341-344 + 空返回),两者等价。
- **对称建议**:wait_for_approval L466 同样改 `ensureRun(handle, false)`,无 run 时空操作(防 awaiting_approval 空 run 目录);实际闸门总是跟在子代理调用之后,复用路径足够,无行为损失。

### Fix2(兜底,~10 行):空 run 不落盘 + 自动清理
- **空 run 判定**:`agents.length === 0` 且 run 目录内除 run.json 外无其他文件。依据:子代理是唯一能写 `.wf-runs/<runId>/` 的通道(agentDefs write 白名单 `NN-role-*.md` 只对子代理开放,orchestrator 只读),agents 空 ⇒ 无产物;目录检查再兜一层防御(防"子代理写出产物但记录未落"的极端窗口)。
- **新增工具函数**(runManager.ts,建议放 saveRun 附近):`isRunEmpty(workspacePath, run): boolean`(读目录 + agents 判空)、`removeRunDir(workspacePath, runId): void`(rmSync 目录,参考 piService 已 import 的 rmSync)。
- **complete_task**(piService.ts L510-513):置 done 后,若 `isRunEmpty` → 跳过 L513 saveRun 并 `removeRunDir`;非空 → 原路径(崩溃安全保留)。
- **finally done 分支**(piService.ts L685-690):`if (run.status !== 'done')` 内,若 `isRunEmpty` → 跳过 L689 saveRun + removeRunDir;非空 → 原路径。覆盖"磁盘残留 planning 空 run 被纯文本回合交付"的边角。
- **与冻结不冲突**:空 run 从未以 done 落盘(或刚被删),saveRun 冻结(L75-77)无感知。

### Fix3(可选加固,~6 行):createRun 惰性化
- **位置**:`runManager.ts L51-65`。删 L54 `mkdirSync` 与 L64 `saveRun`,createRun 只返回内存对象。
- **依赖**:saveRun L78 的 mkdirSync 自动建目录;所有真实路径(子代理 L385/L411/L430、闸门 L470、finally L682/L689)都会在产物产生前写盘。配合 Fix1/Fix2,空 run 从"写了又删"变成"从不落盘"。
- **测试影响**:runManager.test.ts 各用例在读盘前都有 saveRun/appendRunAgentCall,预计无回归;但语义变化较大(createRun 不再持久化),建议 Fix1+2 先行,Fix3 视回归情况再上。

### 不改的部分
- `resolveCurrentRun` 的 done 排除(L119/L123-125):"新需求开新 run"的设计,保留。
- saveRun 冻结(L75-77)、decideTurnEnd 语义、finally keep 分支不写盘:全部保留。

---

## 7. 风险分析

| 风险 | 评估 |
| --- | --- |
| **R1 误删有产物的 run** | Fix2 仅在 `agents.length===0` 且目录无其他文件时删除;子代理成功/失败都会记录 agents(L411/L430),有记录即不删;目录检查兜底防"产物已写、记录未落"的极端崩溃窗口。低风险。 |
| **R2 断点续跑(闸门/中途停止)** | Fix1 只影响"无 run 可复用"分支;awaiting_approval/executing run 仍被 resolveCurrentRun 命中,续跑归并同一 runId 不变。Fix3 只延迟落盘,续跑依赖的磁盘状态在真实内容产生前不存在。恢复扫描(openSession L321)不受影响。 |
| **R3 相邻风险(非本次修复,建议记录)** | 进行中 run 上用户发简短提问,模型纯文本回答(不调工具)→ finally done 分支把**有内容**的 run 置 done 释放(纯文本交付语义,decideTurnEnd L174)。若想区分"交付"与"答疑"(如 gate.pending 时纯文本回合不置 done),需额外启发式,超出本次范围。 |
| **R4 complete_task 行为变化** | 无任务时返回提示文本,前端显示工具输出;不影响 run 快照/闸门 UI。可在工具 description(L499-501)补一句"仅存在进行中任务时调用",降低模型困惑。 |
| **R5 崩溃窗口** | Fix1 无窗口;Fix2 在"saveRun→removeRunDir"之间有极小窗口(残留空 run 目录,与现状等同,不更差);Fix3 把窗口从"创建即落盘"变为"首次真实写盘前无盘",更安全。 |

---

## 8. 结论

- **可行性:高,改动面小**。根因 = "模型在无内容消息上再次调用 complete_task"(模型行为)+ "complete_task 无条件 ensureRun 新建"(服务端无防护)的组合;complete_task 改复用优先(piService.ts L508 一处,~5 行)即可杜绝新空 run;Fix2 清历史残留;Fix3 可选加固。
- **推荐实施顺序**:Fix1(+wait_for_approval 对称)→ Fix2 兜底 → Fix3 惰性化(可选)。
- **验证建议**:① 单测:complete_task 无 run 时空操作、空 run 不落盘/删除、有 agents 的 run 不受影响、wait_for_approval 对称;② 端到端:任务 done 后同会话发"提交",断言 `.wf-runs` 无新目录、`git status` 干净;③ 回归:runManager.test.ts 15 例 + 闸门续跑 + 崩溃恢复。
