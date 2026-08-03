# 审查报告:runId 粒度修正(方案 c1)

> 审查对象:`.wf-runs/2a2b4d0d/03-execution-1.md` vs `.wf-runs/2a2b4d0d/02-plan-1.md`(依据 01-exploration-1.md)
> 审查方式:逐文件静态核对(读全部 5 个改动文件 + 全仓符号分布 grep);无 shell 环境,test/typecheck/lint/build 以执行报告声明为准

## 结论:pass

---

## 逐条核对结果

### 1. `apps/api/src/pi/runManager.ts` — 通过
- `decideTurnEnd` + `TurnEndDecision` 新增于文件尾部(runManager.ts:149-168),逻辑与计划 §3.1 逐字一致:turnFailed→keep;turnWaitCalled→awaiting_approval;turnCompleteCalled||!turnSubAgentCalled→done;其余→keep。
- `createRun`/`saveRun`/`loadRun`/`listRuns`/`resolveCurrentRun`/`toSnapshot`/`collectArtifacts`/`appendRunAgentCall` 全文核对零改动(与探索报告 §3 描述的既有实现逐行一致)。**注意**:`ensureRun` 位于 piService.ts(非 runManager.ts),同样零改动(piService.ts:344-355)。

### 2. `apps/api/src/pi/piService.ts` — 通过
- `SessionHandle` 新增 `turnCompleteCalled`/`turnSubAgentCalled`(L75-78)✓
- `openSession` 初始化两标志 false(L322-324);`createCompleteTaskTool` 在 `createWaitForApprovalTool` push 之后挂载(L311-314),`tools` 白名单自动包含 ✓
- `prompt()`:回合开始重置 3 标志(L627-629)+ `let turnFailed = false`(L630);catch 置 turnFailed(L655);finally 三分支完全收敛到 `decideTurnEnd`(L657-687)——awaiting_approval 写闸门不释放 / done 写盘+`handle.run=null` 释放 / keep 零操作(不写盘不释放)✓
- `createSubAgentTool.execute` 入口(handle 取得后、ensureRun 前、try 外)置 `turnSubAgentCalled = true`(L366),失败调用也计数 ✓
- `createCompleteTaskTool`(L488-517)与 `wait_for_approval` 对称:参数 `{summary}`;execute = ensureRun → turnCompleteCalled → status=done → gate={pending:false, planFile:null} → saveRun(立即落盘,崩溃安全)→ 占位返回文本;不发任何 SSE 事件 ✓
- `getRunSnapshot` done 回填防护原样保留(L700-707,`run.status !== 'done'` 才回填 handle.run)✓

### 3. 三分支与状态迁移表一致性 — 通过(含全部重点边缘)
| 场景 | 代码行为 | 与计划 §3.3 表 |
|---|---|---|
| 失败/abort 回合 | turnFailed→keep,不写盘不释放(run.json 维持 executing) | 一致 |
| 闸门优先于 complete_task | turnWaitCalled 判定最先;先调 complete_task 再调 wait_for_approval 时 run 先 done 后 awaiting_approval,最终以闸门为准 | 一致 |
| 纯文本回合 | 全 false→done+释放;run 为 null 时无操作 | 一致 |
| 中途停止(核心修复) | 调过子代理、无闸门无 complete→keep:finally 零写盘、`handle.run` 保留 → 下回合 `ensureRun` 内存直接命中归并同 runId | 一致 |
| complete_task 后同回合再调子代理(模型违规) | 子代理 execute 将 done 翻回 executing,turnCompleteCalled 仍 true → finally 再置 done | 与 §3.4 自愈说明一致 |
| 子代理工具抛错(循环上限等) | 无论 SDK 吞错(tool_end isError→keep)或向上抛(catch→turnFailed→keep),均落 keep 不误判 done | 与 §8.6 一致 |

### 4. 挂载时序安全性 — 通过
complete_task 挂载于 wait_for_approval 之后仅影响工具列表顺序;两工具均无顺序依赖。若模型先调 complete_task 再调 wait_for_approval:run 先置 done 落盘、后置 awaiting_approval 落盘,回合结束闸门胜出,最终状态 awaiting_approval + gate.pending——可观测、无害,符合「闸门优先」设计。

### 5. `apps/api/src/pi/agents/orchestrator.md` — 通过
工具列表补 complete_task(L18);调度策略规则 6(交付完成必须调用 complete_task、未调闸门/完成工具的回合不结束任务,L28)、规则 7 + 约束区(勿中途纯文本结束回合,L29/L36)。`frontmatter.agents` 仍为 4 子代理白名单(complete_task 是工具不进 agents,agentDefs.test.ts:64 断言不受影响;L58 body 长度断言 `>50` 不受影响)。

### 6. `docs/dag-workflow.md` — 通过
§5.1「回合释放」→「任务完成释放」措辞(L93,含中途停止回合不释放);§7 补「任务完成」段(L156,complete_task 同构工具 + 纯文本兜底 + 失败不处置);§12 追加决策记录(L208)。§5.2 状态机未动。

### 7. `apps/api/src/pi/runManager.test.ts` — 通过(新增,12 用例)
- 矩阵 7 例全覆盖(计划 §6.2 A1-A7):失败防护 3 组合、闸门优先(含闸门+complete 异常组合)、显式完成、纯文本、中途停止、子代理+闸门、子代理+complete ✓
- 集成 5 例全覆盖(计划 §6.2 B1-B5):
  1. **核心反例回归**(707736e6→1c0fdcc1):回合 1 explorer 决策 keep → run 保持 executing;回合 2 planner 调用 → 同一 runId,agents=[explorer, planner](runManager.test.ts:84-105)✓
  2. complete_task 释放:done 后 resolveCurrentRun 双路径 null → 新 runId 不同(L108-131)✓
  3. 闸门归并 + 续跑翻回 executing/gate.pending=false 回归(L133-152)✓
  4. 纯文本交付释放(L154-171)✓
  5. 失败防护:keep 不写盘(字节级相等)+ 续跑归并同一 run(L173-190)✓

### 8. 越界改动核查 — 通过
全仓 grep `complete_task|turnCompleteCalled|turnSubAgentCalled|decideTurnEnd|TurnEndDecision|turnFailed`:新符号仅出现在计划的 5 个文件 + 本任务产物(.wf-runs 报告/run.json)。无 shared/前端/routes/其它测试文件改动。

### 9. 自动化验证 — 通过(以执行报告声明为准,环境无 shell)
执行报告声明:test 8 文件 115 用例全绿、typecheck 通过、lint 通过(complete_task 未用参数改 `_params` 合规)、build 通过且 dist/pi/agents/orchestrator.md 含新契约。静态核对未发现类型/逻辑错误。

---

## 问题清单(均为低优先级观察项,不构成 fail)

1. **piService.ts:505 + L657-687(keep 分支)**:complete_task 调用后、同回合内 API 失败(turnFailed)→ keep,run 已落盘 done 且内存 `handle.run` 保留;下一条消息若再调子代理,`ensureRun` 会直接命中该 done run 并翻回 executing 归并。与计划状态表「keep→不释放」一致,但注意计划 §8.3「complete_task 之后崩溃→续跑开新 run」仅覆盖进程崩溃(内存丢失)场景,进程内错误路径行为不同。建议:后续可在 keep 分支对「run.status==='done' 且 turnCompleteCalled」做释放特判,或文档补一句说明;当前属已接受边缘,低风险。
2. **piService.ts:679-680(done 分支)**:finally done 分支仅 `run.gate.pending = false` 保留 planFile(complete_task 工具则整体清空 gate)。闸门之后接纯文本交付回合(罕见)会残留 planFile 于 done run.json。与计划伪代码一致,仅展示层面影响,可后续统一。
3. **runManager.test.ts:48-54**:失败防护矩阵未覆盖四标志全 true 组合(被优先级逻辑涵盖,trivial)。
4. **执行报告 §3 声明**:commit 未执行、手动 E2E(场景 A-E)未执行(无 API key)。按计划 §7.2 E2E 属抽查、核心反例已由集成测试 1 覆盖;commit 属交付步骤,均不阻塞正确性。

---

## 最终建议:通过

改动与计划完全一致:三分支状态迁移逐项吻合,核心修复(中途停止回合不释放 run、不写盘)实现正确且有集成测试覆盖反例;complete_task 与闸门对称、崩溃安全、无新 SSE 事件;getRunSnapshot 防护与 ensureRun 等零改动;无越界改动;测试/类型/lint/build 声明全绿。4 项观察均为低优先级,可留待后续迭代。
