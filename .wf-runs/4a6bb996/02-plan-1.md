# 实施计划:撤销 run.json 的 .gitignore 规则 + 实现「done 后冻结 run.json」

> 依据探索报告 `.wf-runs/4a6bb996/01-exploration-1.md`(下称「探索报告」);行号以探索报告与源码 grep 实测为准。
> 本计划只读调研产物,实施时按本计划改代码;所有文件路径相对仓库根 `C:/Users/kaijia/codes/github/workflows`。

---

## 1. 目标与范围

### 做什么(A:git 恢复)

1. 移除 `.gitignore` 中上一轮新增的 `.wf-runs/*/run.json` 规则(第 27 行,连同其上方注释 `# workflow run metadata (regenerated on every run)` 一并删除)。
2. 恢复 3 个被 `git rm --cached` 的 run.json 的跟踪:`.wf-runs/2a2b4d0d/run.json`、`.wf-runs/46569220/run.json`、`.wf-runs/d06adb0f/run.json`(文件均在工作区,`git add` 即可恢复)。
3. 顺带把其他未跟踪的 run.json(`.wf-runs/696fc399/run.json`、`.wf-runs/4a6bb996/run.json`,如 `git ls-files` 确认未跟踪)一并纳入,实现「.wf-runs 全量进 git」。

### 做什么(B:done 冻结)

1. `ensureRun` 内存捷径加 `status === 'done'` 检查(堵住同回合改写源头)。
2. 子代理调用前的状态翻转不再允许 `done → executing`。
3. `prompt()` finally 的 done 分支仅在尚未 done 时写盘(消除 complete_task 后的重复写 / updatedAt 二次 bump)。
4. `complete_task` 内立即释放 `handle.run = null`(收窄同回合窗口,堵住「先 wait_for_approval 后 complete_task」经 finally 闸门分支复活 done run 的剩余漏洞——见 §5)。
5. `saveRun` 加冻结熔断:磁盘上已是 done 的 run.json 永不改写(兜底,防御未来新增写路径)。
6. 同步注释与文档(`runManager.ts` 头注释、`docs/dag-workflow.md` §5.1/§7/§8)。

### 不做什么

- 不改 `decideTurnEnd` 纯函数语义(闸门优先矩阵保留,其正确性由 ensureRun 层面的 done 排除来保证)。
- 不动 `reviewing` 状态(生产代码从不产生,遗留类型,非本次目标)。
- 不清理 `gate.planFile` 在 done 分支的残留(现状遗留,探索报告明确「非本次目标,可顺手清理」——仅在 B3 改动处顺带清为 null,见 B3 代码;若实施者认为风险高可跳过)。
- 不加 `saveRun` 的 `force` 参数(仅注释说明未来手动补录 done run 需显式通道)。
- 不改子代理产物写入(subAgent.ts 白名单 / `NN-role-N.md` 命名)——done 冻结后 ensureRun 不再复用 done run,产物写入路径自然随之封死,无需改动。
- 不新增 run 状态、不改前端。

---

## 2. 现状要点(证据,来自探索报告与源码实测)

- 唯一写盘入口:`runManager.ts` `saveRun` L67-73(`run.updatedAt = Date.now()` L71 → `writeFileSync` 全量重写 L72)。每次写盘都 bump updatedAt,即使内容相同。
- done 后仍可能改写的 3 个同回合窗口(探索报告 §4.2):`ensureRun` 内存捷径不查状态(L336 `handle.run ?? resolveCurrentRun(...)`);L379 `if (run.status === 'awaiting_approval' || run.status === 'done') run.status = 'executing'`;finally done 分支 L676-681 无条件再写一次(updatedAt 二次 bump)。
- 跨回合/重启防护已完备:`resolveCurrentRun` L111/L115 排除 done、`getRunSnapshot` L709 只回填非 done、`openSession` 恢复扫描走 resolveCurrentRun——done run 不会被恢复为其他状态(探索报告 §4.1)。
- `decideTurnEnd` L150-173:闸门优先(L163-164 `turnWaitCalled → awaiting_approval`,即使同时 completeCalled)。
- git 现状:`.gitignore` L27 有 `.wf-runs/*/run.json`;3 个 run.json(2a2b4d0d/46569220/d06adb0f)已 `git rm --cached`;`.wf-runs/` 下共 5 个 run 目录,均有 run.json。
- 崩溃安全:complete_task 的 done 落盘(L509)是「任务已完成状态不丢」的关键,必须保留首次 done 写盘。
- 测试:仅 `apps/api/src/pi/runManager.test.ts`(12 例,全部在 runManager 层,不涉及「done 后再写」);piService 无直接单测(构造需 ModelRuntime,重)。`app.test.ts` 不触 run.json。

---

## 3. A 部分:git 恢复步骤(改动 1 个文件 + git 操作)

### A1. 编辑 `.gitignore`

删除以下两行(当前 L26-27):

```
# workflow run metadata (regenerated on every run)
.wf-runs/*/run.json
```

`.wf-runs/` 其余规则不动(`.workflows/` 等保持忽略)。改后 `.gitignore` 不再有任何 `.wf-runs` 相关规则。

**预期结果**:`git check-ignore .wf-runs/2a2b4d0d/run.json` 退出码非 0(不再被忽略);`git status` 中 3 个 run.json 从「已忽略」变为「未跟踪」(因已被 `git rm --cached`,索引中无条目)。

### A2. 恢复 3 个被 rm --cached 的 run.json 的跟踪

```bash
git add .wf-runs/2a2b4d0d/run.json .wf-runs/46569220/run.json .wf-runs/d06adb0f/run.json
```

(文件内容比旧提交新,恢复后 git 会显示 modified,属预期;`git rm --cached` 产生的 staged deletion 会被本次 add 覆盖。)

### A3. 全量纳入 .wf-runs(含新 run)

```bash
git ls-files .wf-runs/            # 核对当前跟踪清单
git add .wf-runs/                 # 纳入 696fc399/run.json 与本流程自身产物 4a6bb996/*(含本计划文件)
git status                        # 预期:无 deleted;新 run 目录为 A(新增)条目,属预期
```

**预期结果**:`.wf-runs` 下所有 run.json 与 NN-role-N.md 产物全部进 git 索引;`git ls-files .wf-runs/ | grep run.json` 应含全部 5 个 runId。

### A4. 提交

```bash
git add .gitignore
git commit -m "chore: 撤销 .wf-runs/*/run.json 忽略规则,run.json 全量进 git"
```

> 注:本流程自身运行在 `.wf-runs/4a6bb996/`,其 run.json 会在本轮完成后被 B 部分新代码冻结——正好作为自验证样例。

---

## 4. B 部分:源码改造(done 冻结,5 处代码 + 文档)

### B1. `ensureRun` 内存捷径加 done 检查(主修复,必做)

文件:`apps/api/src/pi/piService.ts`,函数 `ensureRun`(L333-344,内存捷径在 L336)。

改动(把 L336 一行改为带 done 检查的表达式):

```ts
private ensureRun(handle: SessionHandle): RunFile {
  const workspace = handle.workspace
  const currentId = handle.run?.runId ?? null
  // done 即终态:已完成的 run 不再内存归并(走 resolveCurrentRun 的 done 排除 / createRun 新建)
  const run =
    handle.run && handle.run.status !== 'done'
      ? handle.run
      : resolveCurrentRun(workspace.path, handle.sessionId, currentId)
  if (run) {
    handle.run = run
    return run
  }
  const created = createRun(workspace.path, handle.sessionId)
  handle.run = created
  return created
}
```

说明:`resolveCurrentRun` 的内存路径(L111)与磁盘路径(L115)本就排除 done,因此 done 的 handle.run 传入后返回 null → 磁盘扫描无进行中 run → `createRun` 新建。**一个改动同时堵住:L379 的 done 翻转、wait_for_approval 复活(L462 的 ensureRun)、appendRunAgentCall 追加(L407/L426)——全部同回合改写窗口的源头。**

### B2. 子代理调用前的状态翻转去掉 done(防御,必做)

文件:`apps/api/src/pi/piService.ts`,`createSubAgentTool.execute` L378-381。

改动(L379):

```ts
// 子代理运行中 run 进入执行态(闸门续跑翻回 executing;done 为终态,永不回退)
if (run.status === 'awaiting_approval') run.status = 'executing'
run.gate.pending = false
saveRun(workspace.path, run)
```

说明:B1 已保证此处 run 不可能为 done,此改动是双保险,防止未来代码路径回归。

### B3. finally done 分支仅在尚未 done 时写盘(必做)

文件:`apps/api/src/pi/piService.ts`,`prompt()` finally(L655-689),done 分支 L676-681。

改动:

```ts
} else if (decision === 'done') {
  // done 已由 complete_task 落盘时不再重复写(消除 updatedAt 二次 bump);仅首次进入 done 时写盘
  if (run.status !== 'done') {
    run.status = 'done'
    run.gate.pending = false
    run.gate.planFile = null   // 顺手清理残留(探索报告 §5 观察;如不愿扩大改动面可省略此行)
    saveRun(workspace.path, run)
  }
  // 任务完成释放:done 的 run 不再被本会话后续需求复用
  // (keep / awaiting_approval 分支不置空:前者内存归并,后者闸门续跑归并)
  handle.run = null
}
```

### B4. complete_task 内立即释放 handle.run(必做——堵剩余复活漏洞)

文件:`apps/api/src/pi/piService.ts`,`createCompleteTaskTool.execute` L498-510(状态置 done 在 L504-505,saveRun 在 L509)。

改动(在 L509 `saveRun` 之后、`return` 之前插入):

```ts
// 立即落盘:崩溃安全(complete_task 后进程崩溃,任务已完成状态不丢)——保留不动
saveRun(workspace.path, run)
// 立即释放:done 即终态,收窄「complete_task 后同回合改写」窗口。
// 配合 B1 的 done 检查:后续工具调用(子代理/闸门)经 ensureRun 新建 run 而非复用本 run;
// finally 因 handle.run 为 null 跳过三分支,闸门决策(turnWaitCalled 优先)不再能把 done 复活。
handle.run = null
```

**为什么 B4 是必做而非可选**(探索报告列为可选,但分析后必须做):

- 只做 B1+B2+B3 时存在剩余漏洞:同回合**先调 wait_for_approval、后调 complete_task**(模型违约,decideTurnEnd 矩阵明确覆盖此异常组合且「闸门胜出」)。此时 wait 把 run 置 awaiting_approval 并落盘 → complete_task 经 ensureRun 拿到同一 run(状态非 done)→ 置 done 落盘,但 handle.run 仍是该 done run → finally 决策 = awaiting_approval(闸门优先)→ awaiting_approval 分支**无条件写盘**,把 done run 翻回 awaiting_approval + gate.pending → **done 被永久复活**。
- B4 后:complete_task 置 handle.run=null → finally 拿到 null → 跳过三分支 → 磁盘保持 done。✓
- 等价替代方案(不选,仅备选):在 finally awaiting_approval 分支加 `if (run.status !== 'done')` 守卫。B4 更干净(1 行 + 与文档「任务完成释放」语义一致),且同时收窄 complete→后续工具调用的窗口。
- 副作用核对(B4 后语义):
  - complete_task 后再调 wait_for_approval:B1 使 ensureRun 新建 run,闸门作用于新 run,旧 done run 冻结——符合「闸门仅对非 done 的 run 生效」的设计确认(§5)。
  - complete_task 连调两次:第二次 ensureRun 新建空 run 并置 done(有无 B4 行为一致,罕见契约违约,可接受)。
  - 回合内 complete_task 后 `getRunSnapshot`:handle.run 为 null → 回退 `listRuns().find()` 取磁盘最新同会话 run(done run,updatedAt 刚被 bump)→ 快照仍返回该 run,历史展示不受影响。

### B5. `saveRun` 冻结熔断(兜底,必做)

文件:`apps/api/src/pi/runManager.ts`,`saveRun` L67-73。

改动:

```ts
/** 持久化 run.json(不存在的目录自动创建) */
export function saveRun(workspacePath: string, run: RunFile): void {
  const file = runFileFor(workspacePath, run.runId)
  // 冻结:磁盘上已是 done 的 run.json 永不改写(done 即终态,run.json 是仓库记录)。
  // 首次进入 done 的写盘(complete_task L509 / finally 首次 done)不受影响——此时磁盘还不是 done。
  // 未来如需手动补录 done run,须显式通道(如 force 参数),当前不实现。
  if (run.status === 'done') {
    const existing = loadRun(workspacePath, run.runId)
    if (existing?.status === 'done') return
  }
  mkdirSync(path.dirname(file), { recursive: true })
  run.updatedAt = Date.now()
  writeFileSync(file, JSON.stringify(run, null, 2) + '\n', 'utf-8')
}
```

说明:
- `loadRun`(L75-80)在 `saveRun` 之后声明,函数声明提升,直接调用无问题。
- 只拦截「内存 done + 磁盘 done」的写;createRun(planning)、executing/awaiting_approval 写、首次 done 写均不受影响。
- 静默跳过语义 = 「磁盘 done 后,对 done run 的 agents[] 追加等一律丢弃」,与 B1 配合时这些追加本就不该发生,行为一致。

### B6. 注释与文档同步

1. `runManager.ts` 头注释(L4-5 产物约定附近)加一句:「done 后 run.json 冻结:状态落盘为 done 后不再改写(git 保持干净),新需求开新 run」。
2. `docs/dag-workflow.md`:
   - §5.1(约 L90-96「任务完成释放」bullet 之后)加一条 bullet:「**done 后 run.json 冻结**:run 置 done 后其 run.json 不再被改写(updatedAt 不二次 bump),提交后 git 不脏;新需求开新 runId、新产物目录」。
   - §7「任务完成」段(约 L141-144)末尾加一句:「done 即终态:complete_task 后同回合再调任何工具不再复用该 run(ensureRun 排除 done),闸门仅对非 done 的 run 生效」。
   - §8 恢复表「运行中崩溃」行附近加一句:「done 的 run 不参与恢复扫描,不会从终态复活」。

---

## 5. 设计确认(闸门与 done、断点续跑、崩溃安全)

| 问题 | 结论 |
|---|---|
| done 后同回合再调 wait_for_approval 会复活 run 吗? | 不会。B1 使 wait 的 ensureRun 对 done run 返回 null → 新建 run,闸门作用于新 run;B4 使 finally 拿不到 done run。磁盘 done run 保持冻结。 |
| 「闸门仅对非 done 的 run 生效」符合设计吗? | 符合。done 即终态(任务完成),闸门语义是「计划批准后续跑同一任务」,已完成任务不存在续跑;新需求开新 run(文档 §5.1 已如此定义)。 |
| 断点续跑(awaiting_approval / keep 归并)受影响吗? | 不受影响。续跑只发生在非 done run:闸门归并(L115 gate.pending)、keep 内存归并(B1 的 `status !== 'done'` 分支保留)。done 排除早已存在(L111/L115/L709),冻结无冲突。 |
| complete_task 落盘(L509)保留吗? | 保留。首次 done 写盘是崩溃安全关键(进程崩溃后任务完成状态不丢),B5 只拦截「磁盘已是 done」的后续写。 |
| 崩溃窗口(complete_task 落盘 done → 同回合再写 → 崩溃丢 done)? | B1+B4 后同回合不再有任何对 done run 的写;即使未来新增写路径,B5 熔断兜底。 |
| done run 被闸门「永久无法恢复」可接受吗? | 可接受。done = 终态,用户新需求走新 run(完整交付总结在对话流中,产物在旧 run 目录可查)。 |

---

## 6. 测试策略

### 6.1 现有测试影响

- `apps/api/src/pi/runManager.test.ts` 12 例全部在 runManager 层,不涉及「done 后再写」,B5 冻结对既有用例无影响(逐例核对:所有 done 写盘均为「磁盘非 done → 首次写 done」,不被冻结拦截;`complete_task 释放`用例的 `resolveCurrentRun` 断言不变)。
- 其他测试(subAgent/agentDefs/history/fffTools/workspaceGuard/config/app)不触 runManager 写盘,无影响。
- piService 无直接单测,无回归面。

### 6.2 新增单测(3 个,`apps/api/src/pi/runManager.test.ts` 追加)

测试 1(done 冻结双向:首次 done 写盘成功 + 后续写盘跳过,updatedAt 不变):

```ts
it('done 冻结:首次 done 落盘成功(崩溃安全),之后写盘不再改动文件', () => {
  const dir = makeWorkspace()
  try {
    const sessionId = 's1'
    const run = createRun(dir, sessionId)
    run.status = 'executing'
    saveRun(dir, run)
    // complete_task 语义:首次 done 写盘必须成功
    run.status = 'done'
    run.gate = { pending: false, planFile: null }
    saveRun(dir, run)
    expect(loadRun(dir, run.runId)?.status).toBe('done')
    const frozen = readFileSync(path.join(dir, '.wf-runs', run.runId, 'run.json'), 'utf-8')
    // 模拟 finally 重复写 / 同回合改写企图:内容与 updatedAt 均不得变化
    run.updatedAt = 0
    run.gate = { pending: true, planFile: 'x' }
    saveRun(dir, run)
    expect(readFileSync(path.join(dir, '.wf-runs', run.runId, 'run.json'), 'utf-8')).toBe(frozen)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

测试 2(done 后 appendRunAgentCall 不落盘):

```ts
it('done 后 appendRunAgentCall 不落盘(磁盘冻结,agents 不追加)', () => {
  const dir = makeWorkspace()
  try {
    const sessionId = 's1'
    const run = createRun(dir, sessionId)
    run.status = 'done'
    run.gate = { pending: false, planFile: null }
    saveRun(dir, run)                     // 首次 done 写盘
    const frozen = readFileSync(path.join(dir, '.wf-runs', run.runId, 'run.json'), 'utf-8')
    appendRunAgentCall(dir, run, makeCall('explorer', 'c9', 999))
    const persisted = loadRun(dir, run.runId)
    expect(persisted?.agents).toHaveLength(0)   // 磁盘未追加
    expect(readFileSync(path.join(dir, '.wf-runs', run.runId, 'run.json'), 'utf-8')).toBe(frozen)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

测试 3(非 done → done 的写盘不被冻结误伤,updatedAt 正常推进):

```ts
it('非 done → done 的首次写盘不被冻结误伤(纯文本交付 finally 语义)', () => {
  const dir = makeWorkspace()
  try {
    const sessionId = 's1'
    const run = createRun(dir, sessionId)
    run.status = 'executing'
    appendRunAgentCall(dir, run, makeCall('explorer', 'c1', 1))
    const before = loadRun(dir, run.runId)!
    // 纯文本交付回合 finally:决策 done → 首次置 done 落盘
    run.status = 'done'
    run.gate.pending = false
    saveRun(dir, run)
    const after = loadRun(dir, run.runId)!
    expect(after.status).toBe('done')
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)  // 正常推进一次
    // 且 resolveCurrentRun 从此排除该 run(终态)
    expect(resolveCurrentRun(dir, sessionId, null)).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

### 6.3 可选集成测试(不强制)

piService 层行为(B1 ensureRun done 排除 / B4 释放)可用私有访问构造测试:`apps/api/src/pi/piService.test.ts`(新增,可选):
- `(PiAgentService as any)` 绕过私有构造,`store = createStore()`(config.ts,可临时目录),`runtime = {} as any`;
- 手工构造 `handle = { workspace, sessionId: 's1', run: doneRun, turnWaitCalled/turnCompleteCalled/turnSubAgentCalled: false, ... } as any`;
- 断言 `(service as any).ensureRun(handle).runId !== doneRun.runId`(done 被排除 → 新建)。
- 依赖私有 API,较脆;若构造成本高可跳过,以 6.2 三例 + §7 端到端验证覆盖。

---

## 7. 验证步骤(端到端)

前置:`pnpm install` 无变化;`pnpm --filter @workflows/api test/typecheck/lint/build` 全绿(husky pre-commit 同款门禁)。

1. **A 部分验证**:
   - `git check-ignore .wf-runs/2a2b4d0d/run.json` → 退出码非 0(不再忽略)。
   - `git status` → 3 个 run.json 显示为 modified(恢复跟踪,内容比旧提交新),无 deleted。
   - `git ls-files .wf-runs/ | grep 'run.json'` → 5 个 runId 全在(含 696fc399、4a6bb996)。
   - 提交后 `git status` 干净(除 .workflows/ 等本就忽略项)。
2. **B 部分单测**:`pnpm --filter @workflows/api test` → 原 12 例 + 新 3 例全过。
3. **运行态验证(核心验收)**:启动 `apps/api`,在工作区发起一个需求任务,让主代理走完(含 wait_for_approval 闸门 → 批准 → complete_task 完成,再跑一个纯文本交付回合验证 B3 分支):
   - 完成回合结束后,记下 `.wf-runs/<runId>/run.json` 的 mtime 与内容;
   - 同会话再发任意消息(新需求),等待回合结束;
   - **断言**:旧 run.json 的 mtime、内容、updatedAt 全部不变;新 run 目录为新增文件。
   - `git status --porcelain` 在任务完成提交后不再因 run.json 变脏(新 run 目录是未跟踪新增,add+commit 后即净)。
4. **闸门回归**:计划类需求 → wait_for_approval → run.json 为 awaiting_approval + gate.pending=true → 批准续跑 → 同一 runId 归并 → 完成 → done。确认续跑行为与改造前一致。
5. **崩溃安全抽查(可选)**:complete_task 后立即 kill 进程 → 重启服务 → 该 run 磁盘状态仍为 done,且不会被恢复/改写。
6. **自验证**:本流程自身的 `.wf-runs/4a6bb996/run.json` 在本轮完成后应为 done 且冻结——`git status` 中无变化即为通过。

---

## 8. 风险与回滚

| 风险 | 影响 | 缓解 / 回滚 |
|---|---|---|
| B5 冻结静默丢弃合法写 | 仅影响「磁盘已是 done」的写;当前代码无合法场景 | 已注释说明未来手动补录需 force 通道;单测 2 固化行为 |
| B4 提前释放 handle.run | 回合内快照回退磁盘 find,仍返回同 run;无用户可见差异 | 单测 + §7 端到端;回滚 = 删掉 B4 一行(但需同时给 finally awaiting_approval 分支加 done 守卫,见 §4 B4 备选) |
| 闸门语义变化(done 后闸门建新 run) | 仅模型违约场景(complete 后/前混调闸门);设计确认可接受(§5) | 文档 §7 明示;不满足可回退 B4 并改走分支守卫方案 |
| .gitignore 移除后新 run.json 全部未跟踪 | 每次运行产生新文件需提交,属用户诉求(全量进 git) | 无回滚需求;A4 提交固化 |
| 单测误伤(冻结误拦首次 done 写) | 会直接挂测试 1/3 | 实现时注意 B5 条件为「内存 done && 磁盘 done」双 true 才跳过 |

回滚方案(整体):
- 源码:对 5 处改动 `git checkout -- <file>` 逐文件还原(B1-B5 各自独立、互不依赖,均可单独回滚;B4 回滚须补 finally awaiting_approval 守卫或接受原漏洞)。
- git:A 部分回滚 = 重新在 `.gitignore` 加回两行 + `git rm --cached .wf-runs/{2a2b4d0d,46569220,d06adb0f}/run.json` + 提交。
- 测试:新增 3 例随源码一并还原。

---

## 9. 验收清单(逐条核对)

- [ ] A1:`.gitignore` 不再含 `.wf-runs/*/run.json` 规则(及注释行)。
- [ ] A2/A3:3 个被 rm --cached 的 run.json 恢复跟踪;`git ls-files .wf-runs/` 含全部 5 个 runId 的 run.json;.wf-runs 全量进 git。
- [ ] B1:`ensureRun` L336 内存捷径带 `status !== 'done'` 检查。
- [ ] B2:L379 翻转条件仅剩 `awaiting_approval`。
- [ ] B3:finally done 分支带 `run.status !== 'done'` 守卫,释放逻辑保留。
- [ ] B4:complete_task 在 saveRun 后立即 `handle.run = null`(带注释)。
- [ ] B5:`saveRun` 有「内存 done && 磁盘 done → return」熔断。
- [ ] B6:runManager.ts 头注释与 docs/dag-workflow.md §5.1/§7/§8 同步 done 冻结语义。
- [ ] 测试:runManager.test.ts 原 12 例全绿;新增 3 例(§6.2)全绿;`pnpm --filter @workflows/api test/typecheck/lint/build` 通过。
- [ ] 端到端:任务完成提交后 `git status` 不再因 run.json 变脏;done run 的 run.json mtime/内容/updatedAt 在后续回合中保持不变。
- [ ] 闸门回归:awaiting_approval → 批准 → 同 runId 续跑 → done,行为与改造前一致。
- [ ] 崩溃安全:complete_task 首次 done 写盘保留(单测 1/3 覆盖)。
