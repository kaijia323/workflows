# 执行报告:runId 粒度修正——一个编排任务一个 runId(方案 c1)

> 计划:.wf-runs/2a2b4d0d/02-plan-1.md;探索:.wf-runs/2a2b4d0d/01-exploration-1.md
> 结论:**全部验收项通过**(test 115 通过 / typecheck / lint / build 全绿),改动严格限于计划列出的 5 个文件。

## 1. 改动文件清单

### 1.1 `apps/api/src/pi/runManager.ts`(+22 行,纯新增)
- 文件尾部新增导出 `TurnEndDecision` 类型(`'awaiting_approval' | 'done' | 'keep'`)与纯函数 `decideTurnEnd(flags)`——回合结束决策的单一事实源:
  - `turnFailed` → `'keep'`(失败/abort 一律不处置);
  - `turnWaitCalled` → `'awaiting_approval'`(闸门优先,含同时调 complete_task 的异常组合);
  - `turnCompleteCalled || !turnSubAgentCalled` → `'done'`(显式完成 / 纯文本交付回合);
  - 其余(调过子代理、无闸门、无完成)→ `'keep'`(中途停止)。
- `ensureRun` / `resolveCurrentRun` / `createRun` / `saveRun` / `toSnapshot` / `appendRunAgentCall` **零改动**(git diff 确认仅尾部新增)。

### 1.2 `apps/api/src/pi/piService.ts`(+84/-12)
- `SessionHandle` 接口新增两字段:`turnCompleteCalled: boolean`(本回合是否调过 complete_task)、`turnSubAgentCalled: boolean`(本回合是否调过子代理)。
- `openSession`:handle 字面量初始化两新标志为 `false`;在 `createWaitForApprovalTool` push 之后挂载 `subAgentTools.push(this.createCompleteTaskTool(workspace))`(`tools: [...activeTools, ...subAgentTools.map(...)]` 自动包含,无需另改)。
- `createSubAgentTool.execute` 入口(handle 取得后、ensureRun 前,try 外)置 `handle.turnSubAgentCalled = true`——失败调用也计数,保证「子代理报错回合」落入 keep。
- 新增私有方法 `createCompleteTaskTool(workspace)`,与 `wait_for_approval` 完全对称:参数 `{summary}`,execute 置 `handle.turnCompleteCalled = true` + `run.status = 'done'` + `run.gate = { pending: false, planFile: null }` + `saveRun`(立即落盘,崩溃安全),返回「任务已标记为完成。立即结束回合,向用户做最终交付总结。」占位文本;**不发新 SSE 事件**(复用 done 事件 + 前端 refreshRun)。
- `prompt()`:
  - 回合开始除 `turnWaitCalled` 外重置 `turnCompleteCalled` / `turnSubAgentCalled`,并声明局部 `let turnFailed = false`;
  - catch 块置 `turnFailed = true`(对齐 docs §8「崩溃 = 标记中止 + 手动续跑」);
  - finally 重写为三分支,决策逻辑完全收敛到 `decideTurnEnd`:
    - `awaiting_approval` → status + gate + saveRun,不释放(闸门续跑归并,现状不变);
    - `done` → status + gate.pending=false + saveRun + `handle.run = null`(任务完成释放,触发条件从「回合结束」收窄为「任务完成」);
    - `keep` → 不写盘、不释放(中途停止回合 status 已在子代理 execute 时置 executing 落盘,避免 updatedAt 漂移;handle.run 保留 → 下回合 ensureRun 直接内存归并)。
- `getRunSnapshot` 的 done 回填防护**原样保留**(git diff 0 行)。

### 1.3 `apps/api/src/pi/agents/orchestrator.md`(+4 行)
- 工具列表补 `complete_task(完成任务):声明任务已全部完成(最终交付)。参数 summary:交付总结`。
- 调度策略新增规则 6:「任务交付完成后必须调用 complete_task 声明完成,然后立即结束回合;未调用闸门也未调用 complete_task 的回合不结束任务(任务保持进行中,后续消息继续归并同一任务)」。
- 调度策略新增规则 7 + 约束区补:「不要在任务中途仅以纯文本结束回合;纯文本只用于交付总结/简短汇报」。

### 1.4 `docs/dag-workflow.md`(+5/-1)
- §5.1:「回合释放」→「**任务完成释放**」:done(complete_task 或纯文本交付回合触发)后释放;闸门等待与中途停止回合均不释放(前者 gate.pending 归并,后者保持 executing 下条消息自然归并同一 runId)。
- §7:闸门交互小节后补「任务完成」:complete_task 与 wait_for_approval 同构的普通工具 → run 置 done + 释放;纯文本交付回合为服务端兜底;失败回合不处置 run。
- §12:追加决策记录「任务边界 = 显式 complete_task / 纯文本交付回合;中途停止回合不释放 run(方案 c1,修复 fd6057f 回合级释放副作用,一个任务一个 runId)」。

### 1.5 `apps/api/src/pi/runManager.test.ts`(新增,~170 行,12 用例)
- **A. decideTurnEnd 矩阵(7 例)**:失败防护(任意组合 keep)×3 断言、闸门优先(含闸门+complete 异常组合)、显式完成、纯文本交付、中途停止、子代理+闸门、子代理+complete_task。
- **B. run 生命周期集成(5 例,tmpdir 真实落盘,走 createRun/saveRun/resolveCurrentRun/appendRunAgentCall)**:
  1. 中途停止不释放(核心回归):keep 决策后 run 保持 executing,回合 2 子代理调用仍同一 runId(对应 707736e6→1c0fdcc1 反例);
  2. complete_task 释放:done 后 resolveCurrentRun 返回 null,新 createRun 不同 runId;
  3. 闸门归并:awaiting_approval + gate.pending 返回同一 run,续跑翻回 executing/gate.pending=false(现有行为回归);
  4. 纯文本交付释放:done → null → 新 runId;
  5. 失败防护:turnFailed → keep,run.json 内容字节级不变(不写盘),续跑仍归并同一 run。

## 2. 自检结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 单测 | `pnpm --filter @workflows/api test` | ✅ 8 文件 / **115 用例全过**(含新增 runManager.test.ts 12 例;既有 5 测试文件零回归) |
| 类型 | `pnpm --filter @workflows/api typecheck` | ✅ tsc --noEmit 通过 |
| Lint | `pnpm --filter @workflows/api lint` | ✅ 通过(修复一处:complete_task execute 未用参数改 `_params` 符合 eslint unused-args 规则) |
| 构建 | `pnpm --filter @workflows/api build` | ✅ tsc + copy-agents.mjs 通过;`dist/pi/agents/orchestrator.md` 已含 complete_task 契约(2 处) |

**边界核对**:
- 三分支逻辑一致性:决策唯一入口 `decideTurnEnd`,piService 仅按其返回值执行副作用(awaiting_approval→写闸门;done→写 done+释放;keep→零操作),矩阵单测覆盖全部 5 行状态迁移表场景。
- 工具挂载:`createCompleteTaskTool` 在 `createWaitForApprovalTool` 之后 push,`tools` 白名单自动包含;会话内两标志在 openSession 初始化、prompt 回合开始重置。
- 测试覆盖:矩阵 7 例 + 集成 5 例全部落地;`getRunSnapshot`、`ensureRun`、`resolveCurrentRun` git diff 零改动。
- 提交范围:git status 仅含计划内 5 个文件(2 源码 + 1 新测试 + 2 文档);无 shared/前端/路由改动。

## 3. 未完成项与说明

- **手动 E2E(计划 §7.2 场景 A-E)未执行**:需 DeepSeek API key 且模型行为非确定,计划本身以单测为主、E2E 为抽查;本环境无 API key。核心反例路径(中途停止回合不释放 → 下回合归并同 runId)已由集成测试用例 1 以真实磁盘状态覆盖。
- 提交(commit)未执行:任务仅要求代码改动与报告;如需提交,建议 message 按计划 `fix(pi): run 按任务粒度释放——新增 complete_task 工具,中途停止回合不再释放 run(修复 fd6057f 副作用)`。
