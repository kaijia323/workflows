# 实施计划:「空 run 不落盘」

- 仓库:C:/Users/kaijia/codes/github/workflows(TS monorepo,turbo + vitest)
- 依据:`.wf-runs/6f5a33ee/01-exploration-1.md`(行号已对当前源码逐一复核,见各节「核对」)
- 目标产物:`.wf-runs/6f5a33ee/02-plan-1.md`(本文件)
- 状态:待实施(只读规划,未改任何代码)

---

## 1. 目标与范围

### 做什么(目标)
1. **治本(Fix1)**:`complete_task` 无进行中 run 可复用时**不再新建**,返回提示文本;`wait_for_approval` 对称处理。上一任务 done 后模型在无内容消息上再调 complete_task → 零落盘、零新目录。
2. **兜底(Fix2)**:runManager 提供「空 run 判定 + 不落盘/清理」能力,应用于 complete_task 落盘前与 finally done 分支,确保任何路径都不会留下空 run 文件。
3. **加固(Fix3,评估后纳入)**:`createRun` 惰性化(不 mkdir、不立即写盘),从根上消除「先建空目录再删」的窗口。
4. 新增单测(空 run 不落盘、有 agents 不删、无 run 时 complete_task 不新建)+ 现有 15 例回归 + 端到端验证(git status 干净)。

### 不做什么(明确排除)
- 不改 `resolveCurrentRun` 的 done 排除(「新需求开新 run」是设计,保留)。
- 不改 saveRun 的 done 冻结(L75-77)、`decideTurnEnd` 语义、finally keep 分支不写盘。
- **不自动清理历史已 done 的空 run 目录**(如 `2381975b`):已进 git 的不影响干净度;未进 git 的按 §4.5 一次性手动清理,不做代码级自动删除(避免触碰已提交历史与误删边界)。
- 不做「纯文本答疑 vs 交付」区分(R3,探索报告 §7,超出范围)。
- 不改模型行为层(orchestrator.md 仅可选加一句提示,非主方案)。

---

## 2. 方案决策(取舍结论)

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| Fix1 治本 | **采纳**(Step 1) | 根因 = complete_task 无条件 ensureRun 新建;5~10 行,真实任务路径零行为变化。 |
| Fix2 兜底 | **采纳**(Step 2) | 防 Fix1 未覆盖的边角(子代理循环上限 throw 留下的 planning 空 run、磁盘残留空 run 被纯文本回合交付),且是 Fix3 的语义前提(目录缺失视为空)。 |
| Fix3 惰性创建 | **采纳,独立步骤、带 go/no-go 门**(Step 3) | Fix1 后 `createRun` 唯一生产调用方 = 子代理 execute(piService L371),其 L385 同步 `saveRun`(saveRun L78 自动建目录),真实路径零影响;崩溃窗口进一步缩小(循环上限 throw 路径 L377-380 不再留盘)。现有 15 例测试逐一核对:全部在读取磁盘前 saveRun/appendRunAgentCall,无回归。若 Step 3 回归,单独回滚(仅 runManager.ts createRun 一处)。 |

关键设计点(与探索报告建议的差异修正):
- **`isRunEmpty` 对「目录不存在」返回 true**(探索报告未明确):Fix3 后 createRun 不建目录,若此处返回 false 会走 saveRun 重建空 run 目录,兜底失效。agents 非空 ⇒ 目录必存在(appendRunAgentCall 必 saveRun),判定顺序 agents 在前,无歧义。
- **Fix1 不复制 ensureRun 前半段到 complete_task**(探索报告给了两种等价实现),而是给 `ensureRun` 加 `create` 参数 + **TS 重载签名**,子代理调用点 L371 类型不塌缩(保持 `RunFile`),gate/complete_task 传 `false` 得 `RunFile | null`,最 DRY、最不易漏。
- **落盘/清理二选一逻辑抽成 runManager 的 `persistRunDone`**,使「空 run 不落盘」可单测(piService 无测试基建,execute 内逻辑无法直接单测)。

---

## 3. 实施步骤

### Step 0:前置核对(实施开始前,5 分钟)
- [ ] `git status` 记录当前脏文件清单(应只有 `.wf-runs/6f5a33ee/` 等本次探索产物与既有改动)。
- [ ] 确认 baseline 测试通过:`pnpm --filter @workflows/api test`(15 例 runManager 用例全绿)。
- [ ] 复核 §3.1~§3.3 所列行号与当前文件一致(探索报告行号已复核一次,实施前再对一遍)。

---

### Step 1:Fix1 — complete_task / wait_for_approval 无 run 时空操作(治本)

#### 1a. `apps/api/src/pi/runManager.ts` — 新增导出 `findReusableRun`(放在 `resolveCurrentRun` L112-127 之后)
提取 ensureRun 的「复用查找」为纯函数,供单测覆盖「无 run 时 complete_task 不新建」的查找侧:

```ts
/** 复用查找:内存进行中优先,磁盘扫描兜底;只复用、绝不新建 */
export function findReusableRun(
  workspacePath: string,
  sessionId: string,
  currentRun: RunFile | null,
): RunFile | null {
  if (currentRun && currentRun.status !== 'done') return currentRun
  return resolveCurrentRun(workspacePath, sessionId, currentRun?.runId ?? null)
}
```

#### 1b. `apps/api/src/pi/piService.ts` L333-348 — `ensureRun` 加 `create` 参数(重载签名)
```ts
/** 确保存在可用的 run:进行中归并;create=true(默认)时未命中则新建,false 时返回 null */
private ensureRun(handle: SessionHandle): RunFile
private ensureRun(handle: SessionHandle, create: false): RunFile | null
private ensureRun(handle: SessionHandle, create = true): RunFile | null {
  const workspace = handle.workspace
  const run = findReusableRun(workspace.path, handle.sessionId, handle.run)
  if (run) {
    handle.run = run
    return run
  }
  if (!create) return null
  const created = createRun(workspace.path, handle.sessionId)
  handle.run = created
  return created
}
```
- 同步改 piService.ts import 区(L22-28 区域):`findReusableRun` 加入 `./runManager.js` 的导入列表。
- L371 子代理调用点 `const run = this.ensureRun(handle)` 不变(重载解析为 `RunFile`,类型不塌缩,后续 `run.agents` 无需改动)。

#### 1c. `apps/api/src/pi/piService.ts` L504-528 — complete_task execute
- L508 改:`const run = this.ensureRun(handle, false)`。
- L508 后新增空分支(在 L509 `handle.turnCompleteCalled = true` **之前** return,不置任何回合标志、不落盘、不释放):
```ts
if (!run) {
  return {
    content: [{ type: 'text' as const, text: '当前没有进行中的任务,无需标记完成。' }],
    details: undefined,
  }
}
```
- 其余行(L509-517)原样保留:有 run 时置 done、`saveRun`(Step 2 将替换为 persistRunDone)、`handle.run = null`。正常路径行为完全不变,崩溃安全 done 落盘保留。

#### 1d. `apps/api/src/pi/piService.ts` L466-470 — wait_for_approval execute(对称)
- L466 改:`const run = this.ensureRun(handle, false)`。
- 其后新增空分支(return 提示文本,不置 `turnWaitCalled`、不落盘):
```ts
if (!run) {
  return {
    content: [{ type: 'text' as const, text: '当前没有进行中的任务,无需请求批准。' }],
    details: undefined,
  }
}
```
- 正常闸门路径(子代理已创建 run → 复用命中)行为不变:awaiting_approval + gate 落盘、`turnWaitCalled = true`、gate_required 事件照旧。

#### 1e.(可选)`apps/api/src/pi/piService.ts` L501-503 — complete_task 工具 description 补一句
`'仅在存在进行中任务(本会话有未完成 run)时调用此工具;没有进行中任务时不要调用。'`(降低模型困惑,不影响逻辑)。

**预期结果**:上一任务 done(handle.run=null、磁盘全 done)后,模型再调 complete_task/wait_for_approval → 直接返回提示文本,`.wf-runs` 零新目录。

---

### Step 2:Fix2 — 空 run 判定 + 不落盘/清理(兜底)

#### 2a. `apps/api/src/pi/runManager.ts` — 新增三个导出(放 saveRun L69-82 附近)
```ts
/** 空 run 判定:无子代理记录,且目录中除 run.json 外无任何文件(子代理是唯一产物写入通道)。
 *  目录不存在视为空(Fix3 惰性创建后 createRun 不建目录;此时若判非空会走 saveRun 重建空目录,兜底失效)。
 *  有 agents 或目录有 NN-*.md / 02-plan-*.md 等任何文件 → 非空,必须保留。 */
export function isRunEmpty(workspacePath: string, run: RunFile): boolean {
  if (run.agents.length > 0) return false
  const dir = runDirFor(workspacePath, run.runId)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return true // 目录不存在 = 无任何产物
  }
  return entries.filter((e) => e !== RUN_FILE).length === 0
}

/** 删除 run 目录(仅限空 run 清理;force+recursive,目录不存在时静默) */
export function removeRunDir(workspacePath: string, runId: string): void {
  rmSync(runDirFor(workspacePath, runId), { recursive: true, force: true })
}

/** 置 done 后的落盘统一入口:空 run → 不落盘并清理目录;非空 run → saveRun(崩溃安全保留)。
 *  调用前提:run.status 已置 'done'(complete_task 与 finally done 分支在调用前设置)。 */
export function persistRunDone(workspacePath: string, run: RunFile): void {
  if (isRunEmpty(workspacePath, run)) {
    removeRunDir(workspacePath, run.runId)
    return
  }
  saveRun(workspacePath, run)
}
```
- import 区(L2)补 `rmSync`:`import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'`。
- 与 done 冻结(L75-77)无冲突:空 run 从不以 done 落盘(或刚被删),冻结无感知。

#### 2b. `apps/api/src/pi/piService.ts` — 两处应用
- **complete_task L513**(置 done 后):`saveRun(workspace.path, run)` → `persistRunDone(workspace.path, run)`。非空 run 的 done 崩溃安全落盘不变;空 run 跳过写盘并删目录。
- **finally done 分支 L685-690**(`if (run.status !== 'done')` 块内,L689):`saveRun(workspace.path, run)` → `persistRunDone(workspace.path, run)`。覆盖「磁盘残留 planning 空 run 被纯文本回合交付」的边角。
- **finally awaiting_approval 分支 L679-682 不动**:闸门必须落盘(gate.pending 归并依赖);Fix1 后空 gate run 不再产生。
- piService 同步在 import 区加入 `isRunEmpty`?——不需要:两处调用点只调 `persistRunDone`,单测直接测 runManager 三个函数。

**预期结果**:即使 Fix1 未拦住(如旧版本代码、循环上限 throw 残留),空 run 也会在 complete_task / finally done 时被清理,不留 run.json、不留目录。

---

### Step 3:Fix3 — createRun 惰性化(加固,独立 go/no-go 门)

#### 3a. `apps/api/src/pi/runManager.ts` L51-65 — createRun
- 删除 L54 `mkdirSync(dir, { recursive: true })` 与 L64 `saveRun(workspacePath, run)`,只返回内存对象。
- 函数上方补注释:`// 惰性创建:不建目录、不写盘,由调用方负责首次 saveRun(saveRun 自动建目录);返回后未落盘即崩溃 = 零残留`。

#### 3b. 依赖核对(全部满足,无需额外改动)
- `saveRun` L78 `mkdirSync(path.dirname(file), { recursive: true })` 自动建目录 → 所有真实写盘路径目录自然出现。
- 子代理 execute:ensureRun(L371)→ 循环上限检查(L373-380,可能 throw)→ L385 `saveRun`。**throw 路径不再留盘**(Fix3 直接收益)。
- 闸门/complete_task:复用已有 run(Fix1 后不新建),dir 已存在。
- `detectPlanFile`(piService L819)对缺失目录 try/catch 返回 null,安全。
- 恢复扫描 `listRuns`/`resolveCurrentRun` 只扫已存在目录,不受影响。

#### 3c. go/no-go 门
- 先跑 `pnpm --filter @workflows/api test` + `pnpm --filter @workflows/api typecheck`:全绿 → 保留;任一回归 → 仅回滚 3a 一处(runManager.ts createRun),Fix1/Fix2 不受影响。

**预期结果**:空 run 从「写了又删」变为「从不落盘」;`.wf-runs` 目录只会在第一次真实内容写盘时出现。

---

### Step 4:新增测试(全部落在 `apps/api/src/pi/runManager.test.ts`,与既有 15 例同文件)

新增 describe「空 run 不落盘与复用查找」,用例:

| # | 用例 | 断言 |
| --- | --- | --- |
| T1 | `findReusableRun`:内存进行中 run → 原样返回(不扫描磁盘) | 返回同一 runId |
| T2 | `findReusableRun`:内存 run 为 done → 回退磁盘扫描;磁盘全 done → **返回 null**(配合 ensureRun create=false 即「不新建」) | null |
| T3 | `isRunEmpty`:createRun 后(目录仅 run.json、agents 空)→ true | true |
| T4 | `isRunEmpty`:目录中写入 `01-explorer-1.md`(模拟产物)→ false(**有产物必留**) | false |
| T5 | `isRunEmpty`:appendRunAgentCall 记录 agents(目录仅 run.json)→ false(**agents 非空必留**) | false |
| T6 | `isRunEmpty`:目录不存在(Fix3 惰性创建语义)→ true | true |
| T7 | `removeRunDir`:删除后 `loadRun` 返回 null、目录不存在 | null |
| T8 | `persistRunDone` 空 run:置 done 后调用 → 目录被删、`loadRun` null、无 run.json 残留 | 目录不存在 |
| T9 | `persistRunDone` 有 agents 的 run:置 done 后调用 → run.json 落盘且 status=done、目录保留(崩溃安全回归) | loadRun.status==='done' |

实现要点:复用文件顶部 `makeWorkspace()`/`makeCall()` 工具;T1/T2 用 `createRun` + `appendRunAgentCall`/`saveRun` 造磁盘状态(与既有用例同风格)。

**既有 15 例回归核对**(已逐一读码确认,全部不受影响):
- 「complete_task 释放」「闸门归并」「纯文本交付释放」「失败防护」「done 冻结×3」:均先 saveRun 后读盘,与 Fix3 惰性创建兼容;Fix1 不改 runManager 语义;`persistRunDone` 未替代这些用例中的裸 `saveRun`(用例模拟工具行为,保持原样)。
- `decideTurnEnd` 矩阵 7 例:纯函数,不动。

---

### Step 5:端到端验证(手动,`apps/api` 本地起服务)

| # | 场景 | 步骤 | 通过标准 |
| --- | --- | --- | --- |
| E1 | 空 run 不产生(主场景) | 完成一个真实任务(子代理+complete_task)→ 同会话发「提交」→ 等待回合结束 | `.wf-runs/` 无新 runId 目录;`git status` 干净(无未跟踪目录) |
| E2 | 无任务时 complete_task | 任务 done 后,诱导模型再调 complete_task(或对无进行中 run 的会话触发) | 返回「当前没有进行中的任务…」提示;`.wf-runs` 零变化 |
| E3 | 闸门回归 | 计划 → wait_for_approval → 批准 → 续跑 → complete_task | 全程同一 runId;gate 归并正常;完成后再发消息无新目录 |
| E4 | 断点续跑回归 | 子代理执行中停止/abort → 重启服务 → 发消息续跑 | 归并同一 runId,`resolveCurrentRun` 命中 |
| E5 | 崩溃安全回归(非空 run) | complete_task 落盘后(有 agents)kill 进程 → 重启 | run.json 保持 done,不丢状态 |
| E6 | 历史残留(一次性,可选) | 手工列出空 run 目录(`readdirSync` 检查 agents 空且仅 run.json 的目录)→ `git clean -fd .wf-runs/<id>` 或 `rm -rf` | git status 干净 |

---

## 4. 风险与回滚

### 风险与对策

| 风险 | 评估 | 对策 |
| --- | --- | --- |
| R1 误删有产物的 run | 低。`isRunEmpty` 双条件:agents 非空必留(T5);目录有 NN-*.md / 02-plan-*.md 等任何文件必留(T4)。子代理失败路径也会 appendRunAgentCall(记录 agents)→ 有记录不删 | T4/T5/T8/T9 单测锁定;`removeRunDir` 只被 `persistRunDone` 在 `isRunEmpty` 为 true 时调用 |
| R2 断点续跑 / 闸门受影响 | 低。`resolveCurrentRun` 与 finally keep 分支未动;Fix1 只影响「无 run 可复用」分支;awaiting_approval 仍归并 | E3/E4 回归验证 |
| R3 Fix3 语义变化 | 中低。createRun 不再持久化;若未来新增 createRun 调用方未及时 saveRun 会踩坑 | 3a 加注释;go/no-go 门(3c);Fix3 独立提交可单独回滚 |
| R4 complete_task 行为变化 | 低。无任务时返回提示文本(工具输出,前端正常展示);真实路径不变 | 1e 可选 description 提示;E1/E2 验证 |
| R5 并发/异步时序 | 低。fs 操作全同步、单线程事件循环内原子:complete_task execute 与 finally 之间无 await 点;`persistRunDone` 内 isRunEmpty→saveRun/removeRunDir 二选一同步执行,无「删后又被写」窗口(删除后 handle.run 已 null,子代理 ensureRun 只会新建 runId,不会写已删目录)。Fix3 后 saveRun 是目录唯一创建者,创建必然伴随真实内容 | E5 崩溃窗口验证;代码评审确认无异步插入 |
| R6 历史已 done 空 run 目录 | 低。不进 git 的残留(如未 commit 的 2381975b)不自动清理 | E6 一次性手动清理,不做代码级自动删 |

### 回滚方案
1. **粒度**:每步独立提交(建议 commit 拆分:①Fix1 ②Fix2 ③Fix3 ④测试)。回滚顺序:Fix3 → Fix2 → Fix1,互不依赖。
2. **方式**:`git revert <commit>` 或手动还原 4 个文件(`apps/api/src/pi/runManager.ts`、`apps/api/src/pi/piService.ts`、`apps/api/src/pi/runManager.test.ts`,可选 `apps/api/src/pi/agents/orchestrator.md` 未改则无)。
3. **回滚后状态**:回到现状(模型再调 complete_task 会产生空 run 目录、git 脏)——与修复前等价,无数据丢失风险(空 run 无内容)。
4. **验证回滚**:`pnpm --filter @workflows/api test` 15 例回归 + E1 复现空 run 产生(确认回滚生效)。

---

## 5. 验收清单(逐条核对)

**代码**
- [ ] A1 `runManager.ts` 导出 `findReusableRun`(复用查找,不新建)
- [ ] A2 `piService.ts` `ensureRun` 重载:`ensureRun(handle)` 返回 `RunFile`;`ensureRun(handle, false)` 返回 `RunFile | null` 且不新建
- [ ] A3 complete_task execute:无 run → 返回提示文本,不置回合标志、不落盘、不释放;有 run → 原逻辑(置 done + 崩溃安全落盘 + 释放)
- [ ] A4 wait_for_approval execute:无 run → 返回提示文本;有 run → 原逻辑不变
- [ ] A5 `runManager.ts` 导出 `isRunEmpty`(agents 空 **且** 目录除 run.json 无其他文件;目录缺失视为空)
- [ ] A6 `runManager.ts` 导出 `removeRunDir`(rmSync force+recursive)
- [ ] A7 `runManager.ts` 导出 `persistRunDone`(空 run → 清理;非空 → saveRun)
- [ ] A8 complete_task 落盘点改用 `persistRunDone`(非空 run 的 done 崩溃安全落盘保留)
- [ ] A9 finally done 分支落盘点改用 `persistRunDone`;awaiting_approval 分支不动
- [ ] A10 `createRun` 惰性化(不 mkdir、不 saveRun),含注释;saveRun 自动建目录逻辑未改
- [ ] A11 `resolveCurrentRun` done 排除、saveRun done 冻结、decideTurnEnd 语义全部未改
- [ ] A12 `pnpm --filter @workflows/api typecheck` 通过;`pnpm --filter @workflows/api lint` 通过

**测试**
- [ ] A13 新增 T1-T9 全绿(复用查找 null / 空 run 判定 5 场景 / 删除 / 落盘与清理二选一)
- [ ] A14 既有 runManager.test.ts 15 例全绿(回归)
- [ ] A15 `pnpm --filter @workflows/api test` 全量通过(含 subAgent/fffTools/workspaceGuard/history/agentDefs 用例)

**端到端**
- [ ] A16 E1:任务完成后发「提交」→ `.wf-runs` 无新目录、`git status` 干净
- [ ] A17 E2:无进行中任务时调 complete_task → 提示文本、零落盘
- [ ] A18 E3 闸门流程回归:同一 runId 归并
- [ ] A19 E4 断点续跑回归:同一 runId
- [ ] A20 E5 崩溃安全:非空 run 的 done 状态在重启后保留
- [ ] A21 E6(可选)历史空 run 目录一次性清理后 `git status` 干净

**文档(可选)**
- [ ] A22 complete_task 工具 description 补充「仅在存在进行中任务时调用」

---

## 6. 附:关键行号索引(已对当前源码复核)

| 位置 | 当前行号 | 改动 |
| --- | --- | --- |
| runManager.ts import | L2 | 补 `rmSync` |
| runManager.ts `createRun` | L51-65 | Step 3 删 L54 mkdirSync、L64 saveRun |
| runManager.ts `saveRun` | L69-82 | 不动(冻结 L75-77、建目录 L78) |
| runManager.ts `resolveCurrentRun` | L112-127 | 不动;后新增 `findReusableRun` |
| runManager.ts 新增工具 | saveRun 附近 | 新增 `isRunEmpty`/`removeRunDir`/`persistRunDone` |
| piService.ts import | L22-28 | 补 `findReusableRun`、`persistRunDone` |
| piService.ts `ensureRun` | L333-348 | Step 1 重载 + create 参数(L345 createRun 保留) |
| piService.ts 子代理 ensureRun | L371 | 不动(默认 create=true) |
| piService.ts 闸门 ensureRun | L466 | 改 `(handle, false)` + 空分支 |
| piService.ts complete_task | L508-517 | L508 改 `(handle, false)` + 空分支;L513 saveRun → persistRunDone |
| piService.ts finally done 分支 | L683-693(L689 saveRun) | L689 → persistRunDone |
| piService.ts finally awaiting_approval 分支 | L679-682(L682 saveRun) | 不动 |
| piService.ts complete_task description | L501-503 | 可选补提示 |
| runManager.test.ts | 全文 | 新增 T1-T9;既有 15 例不动 |
