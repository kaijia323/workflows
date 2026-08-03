# 探索报告:run.json 写盘逻辑与「done 后冻结」改造准备

> 任务:调研 `apps/api/src/pi/runManager.ts` 与 `piService.ts`(及相关文件)的 run.json 写盘逻辑,为「run 在运行最终完成后不再被改写」的改造做准备。
> 本文只读调研,未修改任何代码。

---

## 1. 仓库概览

- **技术栈**:Turborepo + pnpm monorepo;`apps/api` = Hono + pi SDK(`@earendil-works/pi-ai` / `pi-coding-agent`)+ fff-node + typebox;`apps/web` = Vue 3 + Vite;`packages/shared` = 纯类型包。
- **关键目录**:
  - `apps/api/src/pi/` — 工作流核心:piService.ts(服务层/工具注册)、runManager.ts(run 生命周期)、subAgent.ts(子代理运行器)、agentDefs.ts(代理 md 解析)、fffTools.ts、workspaceGuard.ts、agents/*.md(内置代理定义)
  - `apps/api/src/agent/routes.ts` — HTTP 路由(prompt / run 快照 / abort 等)
  - `docs/dag-workflow.md` — 设计文档(§5.1 run 语义、§8 恢复可靠性)
- **构建/测试**:`pnpm --filter @workflows/api test/typecheck/lint/build`(Vitest);无 CI,husky pre-commit 本地门禁。
- **产物约定**:`<workspace>/.wf-runs/<runId>/run.json` + `NN-role-N.md` 产物(进 git,删会话不删产物);子代理会话 JSONL 在 `.workflows/agent/sessions/<workspaceId>/sub/<runId>/`。

---

## 2. runManager.ts 完整逻辑(run.json 写盘核心)

文件:`apps/api/src/pi/runManager.ts`(173 行,全部只读/写盘/决策逻辑)

| 函数 | 行号 | 说明 |
|---|---|---|
| `createRun` | L50-64 | 新建 run:随机 8 位 runId(`shortId`),`mkdirSync` 建目录,status=`planning`,`createdAt/updatedAt=Date.now()`,agents=[];内部调 `saveRun` 落盘(L63) |
| `saveRun` | L67-73 | **唯一写盘入口**:`run.updatedAt = Date.now()`(L71)→ `writeFileSync(file, JSON.stringify(run, null, 2) + '\n')`(L72)。**全量重写**(非 merge),无原子写(直接覆盖)。目录不存在自动创建 |
| `loadRun` | L75-80 | 读 run.json;不存在/损坏返回 null |
| `listRuns` | L82-93 | 扫 `.wf-runs` 下所有 run,按 `updatedAt` 倒序 |
| `resolveCurrentRun` | L96-119 | 归并判定:①内存优先(传入 currentRunId,要求 `run.sessionId===sessionId && run.status !== 'done'`);②磁盘扫描:取最新且 `run.gate.pending || run.status !== 'done'` 的同会话 run。**done run 两条路径均被排除** |
| `toSnapshot` / `collectArtifacts` | L122-134 | 快照 / 产物列表(agents[].artifact 收集) |
| `appendRunAgentCall` | L140-146 | agents[] 追加或按 callId 覆盖一条子代理调用记录,然后 `saveRun`(L145)。**这是 done 之后仍可能触发的写盘之一** |
| `decideTurnEnd` | L150-173 | 回合结束决策纯函数(单一事实源):`turnFailed→keep`;`turnWaitCalled→awaiting_approval`(**闸门优先**,即使同时调过 complete_task);`turnCompleteCalled || !turnSubAgentCalled→done`;否则 `keep` |

### 状态字段

- 共享类型 `RunStatus`(`packages/shared/src/index.ts` L191):`'planning' | 'awaiting_approval' | 'executing' | 'reviewing' | 'done'`
- **实际写盘用到的只有 4 个**:`planning`(createRun)、`awaiting_approval`(wait_for_approval / finally)、`executing`(子代理调用时翻转)、`done`(complete_task / finally)。
- `'reviewing'` **在类型与文档状态机中有(docs L109 `planning → awaiting_approval → executing → reviewing → done`),但生产代码从不写入**——遗留/未实现,前端无消费(grep 全仓仅类型声明与文档命中)。
- **没有 `error` 状态**。异常/abort 的处理是「不写盘、保持原状态」(turnFailed → keep),没有错误态。

### updatedAt 赋值点

只有一处:`saveRun` L71(`run.updatedAt = Date.now()`)。**每次写盘都会 bump updatedAt**,即使内容相同。这是「done 后再写一次」会留下痕迹的根本原因。

---

## 3. piService.ts 所有更新 run 的调用点清单

文件:`apps/api/src/pi/piService.ts`。run.json 的全部写盘最终都收敛到 `saveRun`(runManager.ts L72)。

### 3.1 写盘调用点总表(生产代码 9 处)

| # | 位置 | 触发时机 | 状态/内容变化 | 备注 |
|---|---|---|---|---|
| 1 | `ensureRun` L341(`createRun`) | 子代理/闸门/完成工具调用时无可用 run(含磁盘扫描无进行中 run) | 新建 run:status=`planning` | 内存捷径 L337-338:`handle.run` 非空**直接返回,不查状态** ⚠️ |
| 2 | `createSubAgentTool.execute` L378-381 | 每次子代理调用开始 | `if (status==='awaiting_approval' \|\| status==='done') status='executing'`;`gate.pending=false`;saveRun | **显式把 done 翻回 executing** ⚠️ |
| 3 | `createSubAgentTool.execute` catch L407-419 | 子代理执行失败收尾 | `appendRunAgentCall`(追加失败记录,artifact=null,isError)→ saveRun | 失败也计数(保证 -N 序号稳定) |
| 4 | `createSubAgentTool.execute` 成功 L426-439 | 子代理成功收尾 | `appendRunAgentCall`(summary/artifact/sessionFile)→ saveRun | 模态窗回看数据源 |
| 5 | `createWaitForApprovalTool.execute` L466-470 | 模型调用 wait_for_approval | `status='awaiting_approval'`;`gate={pending:true, planFile:detectPlanFile()}`;saveRun;置 `turnWaitCalled` | 闸门落盘(崩溃安全) |
| 6 | `createCompleteTaskTool.execute` L509-511 | 模型调用 complete_task | `status='done'`;`gate={pending:false, planFile:null}`;saveRun;置 `turnCompleteCalled` | **崩溃安全落盘**(注释明言);**不置空 handle.run** ⚠️ |
| 7 | `prompt()` finally L674 | 回合结束,决策=awaiting_approval | `status='awaiting_approval'` + gate.pending=true + planFile;saveRun | 不释放 run(闸门续跑归并) |
| 8 | `prompt()` finally L676-681 | 回合结束,决策=done | `status='done'`;`gate.pending=false`;saveRun;**`handle.run=null` 释放** | **即使 complete_task 已落盘 done,这里仍会再写一次** ⚠️ |
| 9 | `prompt()` finally keep 分支 | 决策=keep(中途停止/失败) | **不写盘**、不释放 | 测试断言内容/updatedAt 不变 |

### 3.2 各调用点上下文与状态转换

- **子代理调用(createSubAgentTool)**:回合内 `turnSubAgentCalled=true`(try 外,失败也计数,L371)→ `ensureRun` → 状态翻转 + saveRun(先落盘,防崩溃丢状态)→ `runSubAgent` 执行(内部子代理模型写产物)→ 成功/失败均 `appendRunAgentCall` + saveRun。循环上限(executor⇄reviewer 3 轮、planner 2 次)抛错强制收尾。
- **wait_for_approval**:`ensureRun` → status=awaiting_approval + gate.pending=true + planFile → saveRun → 发 `gate_required` SSE → 返回「立即停止回合」。批准续跑无专门接口:**前端复用 `POST /prompt`**("用户已批准计划,继续执行")(docs L144),下一回合子代理调用把它翻回 executing。
- **complete_task**:`ensureRun` → `turnCompleteCalled=true` → status=done + gate.pending=false → saveRun(崩溃安全)→ 返回「立即结束回合」。释放发生在 finally。
- **prompt() finally 三分支**:回合标志在回合开始时重置(L530-532);catch 置 `turnFailed`;finally 用 `decideTurnEnd` 决策:awaiting_approval→写盘不释放;done→写盘+释放;**keep→不写盘不释放**(注释:避免无谓写盘与 updatedAt 漂移)。abort 走 catch(turnFailed)→ keep → 不写盘。
- **断点续跑/服务重启恢复**:`openSession` L255 `run: resolveCurrentRun(workspace.path, finalId, null)` — 扫描 `.wf-runs`,取最新且 `gate.pending || status!=='done'` 的同会话 run 作为当前 run。**done run 不会被恢复为其他状态**。前端刷新经 `GET /api/agent/workspaces/:id/run` → `getRunSnapshot`(L700-710):`handle.run` 为空时取磁盘最新同会话 run,但 **L708 有 done 防护:只回填非 done run**(注释「方案 A 配套:防止磁盘已完成的 run 被重新挂回 handle」)。

---

## 4. 重点排查:done 之后是否还会被改写?

### 4.1 跨回合 / 重启:不会(现有防护完备) ✅

- `resolveCurrentRun`(runManager L96-119):内存路径要求 `status !== 'done'`,磁盘路径要求 `gate.pending || status !== 'done'` → **done run 永不会被归并/恢复**。
- `getRunSnapshot` L708:非 done 才回填 handle → done run 不会重新挂回内存。
- `openSession` 恢复扫描同上 → **服务重启不会把 done run 恢复成任何其他状态**。
- 新需求:ensureRun 找不到进行中 run → 新建新 runId、新目录。

### 4.2 同回合内(complete_task 之后、回合结束之前):存在真实改写窗口 ⚠️

这是**唯一**的「done 后再写」代码路径,成因链条:

1. **`ensureRun` 内存捷径不查状态**(L337-338):`handle.run` 非空直接返回。complete_task **不置空 handle.run**(L509 只改状态+落盘),释放要等到 finally。因此 complete_task 之后、回合结束之前,`handle.run` 仍是那个已 done 的 run。
2. **`createSubAgentTool.execute` L379 显式翻转 done→executing**:`if (run.status === 'awaiting_approval' || run.status === 'done') run.status = 'executing'` — 模型若在 complete_task 后(违反契约)继续调子代理,done run 被翻回 executing 并落盘(L381),随后 appendRunAgentCall 再写两次。
3. **wait_for_approval 可复活 done run**:同回合 complete_task 之后再调 wait_for_approval → L466 置 awaiting_approval + saveRun;回合结束 `decideTurnEnd` **闸门优先**(L163-164,测试矩阵明确「模型异常行为,闸门胜出」)→ finally 置 awaiting_approval、**不释放** → done run 被永久复活,后续回合继续归并同一 runId 并追加写入。
4. **崩溃窗口**:complete_task 落盘 done → 同回合子代理翻转落盘 executing → 进程崩溃 → 磁盘停留在 executing,done 状态丢失(updatedAt 也被推进)。

### 4.3 即使完全正常,也有「done 后再写一次」的最小实例 ⚠️

happy path:complete_task 落盘 done(L509)→ 回合结束 finally done 分支**再次 saveRun**(L678-680)。内容相同但 `updatedAt` 二次 bump(runManager L71)。纯文本交付回合则是唯一一次 done 写入(无此重复)。

### 4.4 结论

- **跨回合/重启:已 done 的 run 不会被后续运行或重启改写**(现有代码已保证)。
- **同回合窗口:存在 3 个真实改写点**(L379 翻转 / L509 后 finally 重写 / 闸门复活),其中 L379 翻转 + 闸门复活可把 done 永久抹掉。
- 改造目标「done 后不再写盘」需要同时堵住:**ensureRun 内存捷径**(源头)、**L379 的 done 翻转**(状态回退)、**finally done 分支的重复写**(updatedAt 漂移)。

---

## 5. 多 run 共享目录 / 断点续跑复用

- **无共享目录**:每 runId 独立目录(`.wf-runs/<runId>/`),run.json 只属于一个 runId。
- **续跑复用同一 runId(设计如此,非 done 场景)**:① 闸门续跑:`awaiting_approval` + gate.pending=true 的 run 被 resolveCurrentRun 恢复,下一回合子代理调用翻回 executing(runManager.test.ts「闸门归并」用例验证);② 中途停止续跑:keep 分支保留 handle.run,下回合内存归并同一 runId。这两种续跑都在 run 未 done 时发生,agents[] 追加、状态翻转、updatedAt 推进均属预期。
- **done run 在续跑扫描中不会被恢复**(resolveCurrentRun 排除)→ 不会出现「done 被恢复到 awaiting_approval/executing」的磁盘侧行为。
- 真实样例 `.wf-runs/2a2b4d0d/run.json`:`done` 状态 + 4 条 agents(explorer/planner/executor/reviewer),gate.planFile 残留旧计划路径(`.wf-runs\2a2b4d0d\02-plan-1.md` 反斜杠 Windows 分隔符,注意 done 分支只清 `gate.pending` 不清 `planFile`——reviewer 曾记录此观察)。

---

## 6. 其他写 .wf-runs 的代码:NN-role-N.md 产物

- **产物文件由谁写**:**服务端不直接写产物**。子代理会话运行时,模型经自己的 write 工具写入(subAgent.ts `runSubAgent` L296-307 把权威产物文件名注入 prompt:「产物文件:.wf-runs/<runId>/<artifactName>」)。写入白名单来自 agents/*.md frontmatter:explorer/planner/reviewer 仅 `.wf-runs/*/0X-role-*.md`,executor 为 `**` 全量写(subAgent.ts `buildSubAgentTools`)。服务端事后用 `detectArtifact`(subAgent.ts L192-218)扫描 run 目录最新命中文件作为 artifact 记录进 run.json。
- **命名**:`nextArtifactName`(subAgent.ts L49-55)= `NN-role-N.md`,`N` = run.agents 中同角色调用数+1(含失败调用,失败在 catch 中也 append 记录)。**同 run 内多轮调用互不覆盖**(旧版无序号命名曾互相覆盖,见 `.wf-runs/46569220/run.json`:7 条 agents 全部 artifact=`01-exploration.md`/`03-execution.md`/`04-review.md` 被反复覆盖;后已由 -N 命名 + 白名单结构性修复)。
- **是否存在提交后改写问题**:与 run.json 同源——**正常流程下 done run 不会被再次调用子代理,产物随之冻结**;但同回合窗口(complete_task 后模型继续调子代理)会让模型在已 done 的 run 目录里写**新序号**的产物文件(不覆盖旧文件,但目录被污染、run.json agents[] 被追加)。冻结 run.json 后,若不同步堵 ensureRun 内存捷径,产物仍可能被写,但 run.json 不再记录(数据不一致风险)。

---

## 7. 状态机流转图

```
createRun ──► planning ──(子代理调用 L378-381)──► executing
                                                    │
        (wait_for_approval L466)                   │ (中途停止回合 keep:不写盘)
              │                                    │
              ▼                                    ▼
   awaiting_approval ◄────────────────── executing(下回合归并同一 runId)
   gate.pending=true
              │ (批准续跑 = 新 prompt → 子代理调用)
              ▼
   executing ──(complete_task L509 / 纯文本回合 finally L678)──► done ──(handle.run=null 释放)
                                                                    │
                         done 之后:resolveCurrentRun 排除 / getRunSnapshot 不回填
                         ⚠️ 同回合窗口:ensureRun 内存捷径 + L379 翻转 + 闸门优先 可复活
```

- `reviewing` 状态仅存在于类型与文档,代码不产生。
- 异常/abort:turnFailed → keep → 不写盘、不释放。

---

## 8. 结论与最小改动位置建议(仅报告,不改代码)

### 可行性判断

**可行,且现有代码已为「done 冻结」提供了大部分防护**(resolveCurrentRun / getRunSnapshot / openSession 三处均已排除 done)。改造只需收窄「同回合窗口」与消除「done 后重复写」,改动面小、风险低。

### 最小改动位置建议(按优先级)

**主修复(源头,建议必做)**:

1. **`ensureRun`(piService.ts L334-344)内存捷径加 done 检查**:`handle.run?.status === 'done'` 时视为无 run,走 `resolveCurrentRun`/`createRun`。这一处同时堵住:同回合 done 复用(L379 翻转)、闸门复活(L466)、appendRunAgentCall 追加(L407/426)——**一个改动消灭全部同回合改写窗口**。
2. **`createSubAgentTool.execute` L379 翻转条件去掉 `done`**:`if (run.status === 'awaiting_approval')` 即可(执行中的 run 不需要翻回 executing;防御性双保险)。
3. **`prompt()` finally done 分支(L676-681)加守卫**:仅当 run 尚未 done 时才 `saveRun`;已 done(complete_task 已落盘)则只做 `handle.run=null` 释放,消除 happy path 的第二次写盘与 updatedAt 漂移。keep 分支保持不写盘。
4. **(可选)complete_task(L509)内立即 `handle.run = null`**,不等 finally,进一步收窄窗口。

**兜底熔断(防御性,建议加)**:

5. **`saveRun`(runManager.ts L67-73)加冻结判断**:写盘前 `loadRun` 现有内容,若 `run.status === 'done' && existing?.status === 'done'` 则直接 return(跳过写盘)。语义 =「磁盘已是 done 的 run.json 永不改写」;首次进入 done 的写盘(complete_task L509)不受影响(此时磁盘状态还不是 done)。注意:此熔断会静默丢弃对 done run 的 agents[] 追加,与主修复 1 配合时这些追加本就不该发生,行为一致。

**注意点**:

- 熔断是「静默跳过」,若将来有合法需求要修改 done run(如手动补录 agents),需显式通道(如 `force` 参数)。
- done run 的读取不受影响:`getRunSnapshot`/`listRuns`/`getSubAgentHistory` 均走 loadRun/内存,不经过 saveRun。
- `gate.planFile` 在 done 分支只清 `pending` 不清 `planFile`(现状残留,非本次目标,可顺手清理)。
- 测试:`runManager.test.ts` 现有 12 例不涉及「done 后再写」,无回归预期;建议新增:①complete_task 后同回合子代理调用不改变磁盘 done;②finally done 分支对已 done run 不写盘(updatedAt 不变);③saveRun 熔断单测。
- 文档 `docs/dag-workflow.md` §5.1/§8 需同步一句「done 后 run.json 冻结」。

---

## 附:关键代码片段(行号速查)

```ts
// runManager.ts
export function saveRun(workspacePath: string, run: RunFile): void {   // L67
  const file = runFileFor(workspacePath, run.runId)
  mkdirSync(path.dirname(file), { recursive: true })
  run.updatedAt = Date.now()                                           // L71
  writeFileSync(file, JSON.stringify(run, null, 2) + '\n', 'utf-8')     // L72 全量重写
}
// resolveCurrentRun L96-119:内存/磁盘两路均排除 done
// decideTurnEnd L150-173:turnFailed→keep;turnWaitCalled→awaiting_approval(闸门优先);complete||!subAgent→done

// piService.ts
// ensureRun L334-344:内存捷径 L337-338 handle.run 非空直接返回(不查状态)← 关键风险点
// createSubAgentTool L378-381:
//   if (run.status === 'awaiting_approval' || run.status === 'done') run.status = 'executing'
//   run.gate.pending = false; saveRun(...)                              // L381 ← done 翻转
// appendRunAgentCall L407(L 失败)/ L426(成功)                          // done 后仍可追加
// createWaitForApprovalTool L466-470:awaiting_approval + gate.pending + saveRun
// createCompleteTaskTool L509-511:done + gate.pending=false + saveRun(崩溃安全;不置空 handle.run)
// prompt() finally L655-689:awaiting_approval→L674 saveRun;done→L678 saveRun + L681 handle.run=null
// getRunSnapshot L700-710:L708 只回填非 done run(done 防护)
// openSession L255:恢复扫描 resolveCurrentRun(...) — done run 不会被恢复

// subAgent.ts
// nextArtifactName L49-55:NN-role-N.md,序号=同角色调用数+1(含失败)
// runSubAgent L296-307:prompt 注入产物文件权威名(产物由子代理模型 write 工具写入)
// detectArtifact L192-218:扫描 run 目录最新命中产物
```
