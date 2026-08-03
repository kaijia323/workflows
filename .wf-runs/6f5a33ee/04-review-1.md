# 审查报告:「complete_task 主代理自行判断、无 run 不创建」

> 审查对象:`.wf-runs/6f5a33ee/02-plan-1.md`、`03-execution-1.md` 及 4 个改动文件(未提交)。
> 需求基准:`.wf-runs/6f5a33ee/01-exploration-2.md` §8 改动清单。
> 审查方式:只读。逐一阅读 orchestrator.md / piService.ts / piService.test.ts / docs/dag-workflow.md / runManager.ts,全文检索残留措辞,核实 `.wf-runs` 目录清单。

## 结论:pass

---

## 1. orchestrator.md(行 18/25/28/29/35 条件式措辞)— 通过

| 位置 | 状态 | 说明 |
| --- | --- | --- |
| 行 18(工具清单 complete_task) | 通过 | 「仅当存在进行中的任务且任务确实已完成时,声明任务完成(最终交付)」,已由无条件改为条件式 |
| 行 25(规则 3 wait_for_approval) | 通过 | 「计划完成后调用 wait_for_approval…」+「没有进行中任务时不要调用 wait_for_approval,直接以文本回应」,已去「必须」 |
| 行 28(规则 6 complete_task) | 通过 | 「仅当存在进行中的任务且任务确实已完成时,调用 complete_task…;纯操作类消息…直接以文本回应;没有进行中任务时不要调用 complete_task」;原「未调用闸门也未调用 complete_task 的回合不结束任务」绝对化表述已删除 |
| 行 29(规则 7 纯文本) | 通过 | 「任务中途不要仅以纯文本结束回合;纯文本用于交付总结、简短汇报,以及没有进行中任务时的直接回应」— 已限定「任务中途」作用域并补充无任务场景 |
| 行 35(约束) | 通过 | 同规则 7 的澄清版 |

残留检索(全文 grep「必须调用」「不结束任务」「纯文本结束回合」):**无残留**。全文唯一「必须」为规则 2「复杂需求必须走 explorer → planner」(与 complete_task 无关,不构成语义矛盾)。整体自洽:主代理可理解「有进行中任务且完成 → complete_task;无任务 → 纯文本回应」,与 piService.ts execute 行为(无 run 返回提示、finally 无 run 跳过、纯文本回合 done 兜底)一致。

## 2. piService.ts — 通过

- **ensureRun 重载(行 333-335)**:`ensureRun(handle): RunFile` / `ensureRun(handle, create: false): RunFile | null` / 实现 `create = true`。类型安全:仅两个调用点 `ensureRun(handle)`(行 374,子代理)与 `ensureRun(handle, false)`(行 470、519),无 `(handle, true)` 塌缩调用;实现体内 `if (!create) return null`,默认 true 分支保留 `createRun` 新建。子代理路径(行 374)自动创建行为不变。
- **complete_task execute(行 517-537 区间)**:`ensureRun(handle, false)`;无 run 分支在置 `turnCompleteCalled` **之前** return,返回提示「当前没有进行中的任务,无需调用 complete_task。」,不置回合标志、零落盘、不释放;有 run 分支原样保留(置 done + gate 复位 + `saveRun` 崩溃安全落盘 + `handle.run = null` 释放)。
- **wait_for_approval execute(行 468-490 区间)**:对称处理;无 run 返回提示、不置 `turnWaitCalled`;有 run 分支(gate.pending + gate_required 事件 + `turnWaitCalled = true`)完全不变。
- **description 同步**:complete_task description(行 512-515)已改为「仅当存在进行中的任务且任务确实已完成时调用…没有进行中任务时(如咨询、问答、查看状态)不要调用此工具,直接以文本回应即可」,与 orchestrator.md 行 28 一致。
- **finally 三分支、decideTurnEnd、saveRun 调用点**:均未改动(与「未实施 Fix2/Fix3」一致;finally done 分支仍裸 `saveRun`,无 `persistRunDone`)。import 区无新增、无冗余。

## 3. piService.test.ts(6 条用例)— 通过

- 用例覆盖与执行摘要一一对应:
  - complete_task 无 run(空工作区)→ 断言提示文本、`.wf-runs` 不存在、`turnCompleteCalled=false`、`handle.run` 仍 null — 真实覆盖「提示 + 零落盘 + 不置标志」
  - complete_task 磁盘仅 done run → 断言 `readdirSync(.wf-runs)` 仅 `['old1']` 且 run.json 内容逐字段未变 — 真实覆盖「仅剩 done run 不新建」
  - complete_task 有进行中 run → 断言 `loadRun` status=done、gate.pending=false、`turnCompleteCalled=true`、`handle.run=null`、run.json 存在 — 真实覆盖「有 run 正常落盘 + 释放」
  - wait_for_approval 无 run → 提示 + `.wf-runs` 不存在 + `turnWaitCalled=false` — 真实覆盖
  - wait_for_approval 有 run → awaiting_approval + gate.pending=true + `turnWaitCalled=true` — 真实覆盖「有 run 行为不变」
  - ensureRun 默认 create=true → 断言创建 run 且 run.json 落盘(planning)— 真实覆盖「子代理路径自动创建」
- 断言缺陷:未发现。私有构造 + fake handle 注入(handles key `'w1'` 与 workspace.id 一致)可真实驱动 execute;`PiAgentService` 私有构造无 IO 副作用(仅赋值 store/runtime),测试 1/4 的「`.wf-runs` 不存在」断言成立。测试 2 的 `readdirSync` 单元素比较与 JSON 往返比较均安全。

## 4. docs/dag-workflow.md(行 93/157/209)— 通过

- 行 93(「任务完成释放」):已同步「`complete_task` 仅在存在进行中任务且任务确实完成时调用;没有进行中任务时不要调用,服务端也不会新建 run(直接返回提示文本)」— 准确。
- 行 157(「任务完成」段):已同步「仅当存在进行中的任务且任务确实完成时调用;没有进行中任务时不要调用,直接文本回应」+「无进行中 run 时调用 complete_task / wait_for_approval,服务端不新建 run,直接返回提示文本」— 准确,且同时覆盖了 wait_for_approval。
- 行 209(决策记录):「任务边界 = 显式 complete_task(仅在有进行中任务且完成时调用;无任务时不调用,系统侧无 run 不创建)」— 准确。

## 5. 关键核实:.wf-runs/2381975b/ — 通过

- `ls .wf-runs/2381975b` → **Path not found**(当前目录不存在);`.wf-runs/` 实际仅含 `2a2b4d0d / 46569220 / 4a6bb996 / 696fc399 / 6f5a33ee / d06adb0f`,无 2381975b。
- 执行摘要「该目录已不存在、为索引残留」与实况一致。删除发生在**本轮之前**:01-exploration-1.md 记载其为上一轮复现实验产物(createdAt=1785784027816,「实测 2381975b」),02-plan-1.md 亦以「如未 commit 的 2381975b」指代历史残留;本轮执行时已不存在,无需删、也未删。**不在问题清单。**
- 注:审查工具集无 git,「git status 无它」未能直接执行核实;但目录级核实已确认其不存在。

## 6. 改动范围与 git 状态 — 通过(附限制说明)

- 改动文件与执行摘要一致:orchestrator.md、piService.ts、piService.test.ts(新增)、docs/dag-workflow.md 共 4 个;runManager.ts / runManager.test.ts 经内容核对确认未动(createRun 仍 mkdir+saveRun;无 findReusableRun / isRunEmpty / removeRunDir / persistRunDone,与「未实施 Fix2/Fix3」一致)。
- 未提交:执行摘要声明未提交;无 git 工具无法直接验证,交叉证据(文件内容、目录清单)与声明吻合。

## 7. 与计划(02-plan-1.md)的偏离 — 记录(不构成 fail)

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| Fix1(ensureRun create 参数 + 空分支) | 已实施 | 与计划 1b/1c/1d 一致 |
| Fix2(isRunEmpty/removeRunDir/persistRunDone)、Fix3(createRun 惰性化) | 未实施(偏离) | 任务明确要求不做兜底删除/惰性化;执行报告 §5 已记录 |
| 测试落在 runManager.test.ts T1-T9 | 偏离 | 改为新建 piService.test.ts 6 条(真实 execute 路径,优于计划的纯函数模拟),与探索报告 §8.2 #8 建议一致 |
| 计划验收 A5-A10、A13(涉及 Fix2/Fix3 与 T1-T9) | 不适用 | 因范围收缩未实施,非缺陷 |

偏离均有据可查且方向正确,不构成质量问题。

---

## 问题清单

无阻断性问题。以下为轻微观察(不阻塞):

1. **piService.ts 行 463(wait_for_approval description)**:仍保留「计划类需求在计划完成后**必须**调用此工具」——语义上限定于「计划类需求在计划完成后」(此时必存在进行中 run,与无 run 分支不冲突),不构成矛盾;但与 orchestrator.md 行 25(已删「必须」)存在措辞粒度不一致。修复建议(可选):改为「计划类需求在计划完成后应调用此工具;没有进行中任务时不要调用」,与提示词保持完全一致。
2. **git 状态未经 git 命令直接核实**(工具集无 git/bash):已用文件内容 + 目录清单交叉验证,建议提交前以 `git status` 终检一次。

---

## 最终建议:通过

4 个改动文件与需求(01-exploration-2.md §8 清单)完全吻合:提示词全部条件式、无绝对化残留且自洽;ensureRun 重载类型安全、子代理路径默认创建不变;两个工具无 run 分支提示 + 零落盘 + 不置标志,有 run 分支行为不变;6 条测试真实覆盖且无断言缺陷;文档三处同步准确;2381975b 目录确已不存在。可提交。
