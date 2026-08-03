# 执行报告:「complete_task 改为主代理自行判断、无 run 不创建」

> 方案:依据 `.wf-runs/6f5a33ee/01-exploration-2.md`(行号已核对)与 `02-plan-1.md` 的 Fix1 部分实施。
> 按任务约束**未实施**计划中的 Fix2(兜底删除 isRunEmpty/removeRunDir/persistRunDone)与 Fix3(createRun 惰性化)——用户明确不要新增兜底删除/惰性化逻辑。
> 未提交 git。

## 1. 改动文件清单

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/agents/orchestrator.md` | ① 行 18 工具清单 complete_task 描述 → 「仅当存在进行中的任务且任务确实已完成时,声明任务完成」;② 行 25 规则 3(wait_for_approval 强制措辞「必须调用」)→ 条件式「没有进行中任务时不要调用 wait_for_approval,直接以文本回应」;③ 行 28 规则 6 → 按任务给定示例改为条件式(删「未调用闸门也未调用 complete_task 的回合不结束任务」绝对化表述);④ 行 29 规则 7、⑤ 行 35 约束(两处「不要在任务中途仅以纯文本结束回合」)→ 澄清纯文本用途含「没有进行中任务时的直接回应」 | 核心规则改为「主代理自行判断」,全文强制措辞统一为条件式,语义自洽 |
| `apps/api/src/pi/piService.ts` | ① `ensureRun` 增加 `create` 参数 + TS 重载签名:`ensureRun(handle)` 返回 `RunFile`(默认 create=true,子代理路径不变),`ensureRun(handle, false)` 返回 `RunFile | null` 且不新建;② `wait_for_approval` execute(原行 466):改 `ensureRun(handle, false)`,无 run 时直接返回提示文本「当前没有进行中的任务,无需请求批准。」,不置 turnWaitCalled、不落盘;有 run 时行为完全不变;③ `complete_task` description(原行 499-502):改为「仅当存在进行中的任务且任务确实已完成时调用…没有进行中任务时(如咨询、问答、查看状态)不要调用此工具,直接以文本回应即可」;④ `complete_task` execute(原行 508):改 `ensureRun(handle, false)`,无 run 时返回提示「当前没有进行中的任务,无需调用 complete_task。」,不置 turnCompleteCalled、不落盘、不释放;有 run 时完全不变(置 done + `saveRun` 崩溃安全落盘保留 + `handle.run = null`) | 根因修复:两个工具无条件 ensureRun 会在无任务时新建空 run;现在无 run 可复用时零落盘 |
| `docs/dag-workflow.md` | 行 93 / 157 / 209 三处 complete_task 语义同步:仅在有进行中任务且完成时调用;无任务时不调用;系统侧无 run 不创建(直接返回提示文本) | 设计文档与实现保持一致 |
| `apps/api/src/pi/piService.test.ts`(新增) | 6 条用例(见下节) | 覆盖「无 run → 提示 + 零落盘」「有 run → 正常落盘」及子代理自动创建路径回归 |

## 2. 测试

新增 `apps/api/src/pi/piService.test.ts`(私有构造 + 注入 fake handle,直测真实工具 execute):

- complete_task 无进行中 run(空工作区)→ 返回提示「当前没有进行中的任务,无需调用 complete_task。」,`.wf-runs` 目录/文件零创建,回合标志不置位
- complete_task 磁盘仅有已 done run(上一任务完成场景)→ 不新建 run,旧产物目录/run.json 原样保留(零新增)
- complete_task 有进行中 run → 行为不变:置 done、run.json 落盘(status=done、gate.pending=false)、释放内存 run
- wait_for_approval 无进行中 run → 返回提示「当前没有进行中的任务,无需请求批准。」,零落盘,不置闸门标志
- wait_for_approval 有进行中 run → 行为不变:awaiting_approval 落盘、gate.pending=true、turnWaitCalled=true
- ensureRun 默认 create=true 仍自动创建 run 并落盘(子代理调用路径不受影响)

验证结果(全部通过):

```
pnpm typecheck  → tsc --noEmit 通过
pnpm lint       → eslint . 通过(0 error)
pnpm test       → 9 files / 124 tests 全部通过(新增 6 条;既有 118 条无回归,含 runManager.test.ts 15 例与 decideTurnEnd 矩阵)
```

## 3. 清理历史残留

- `.wf-runs/2381975b/`:执行时以 `bash ls` 与文件索引工具双重确认**该目录已不存在**(`ls: cannot access ... No such file or directory`;索引亦报 Path not found),无需删除操作。此前索引曾短暂显示 run.json,为索引残留,已核实目录实际不存在。

## 4. 端到端验证

- 「无 run 时调用 complete_task 不产生新目录」:由新增单测自动化模拟(空工作区 execute 后断言 `.wf-runs` 不存在;仅含 done run 时断言无新增目录)——通过。
- `git status` 确认 `.wf-runs/` 下无新增未跟踪目录(仅有本次产物目录 `6f5a33ee/`);改动文件为 3 个 M + 1 个新测试文件,未提交 git。

## 5. 未完成项与原因

- 无。计划的 Fix2(空 run 兜底清理)/ Fix3(createRun 惰性化)按用户明确要求未实施;`decideTurnEnd` 语义、finally 三分支、子代理自动创建 run 路径均未改动。
