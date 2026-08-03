# 实施计划:子代理产物永不覆盖(A+B 组合方案)

> runId: d06adb0f ｜ 类型:实施规划 ｜ 依据:01-exploration.md(覆盖根因 = 「run 归并 + 固定文件名」两层叠加)

## 一、目标与范围

### 做什么
1. **方案 A(跨任务隔离)**:回合结束释放内存中的 run,使同一会话的下一个编排任务自动新建 runId、新产物目录(对齐 docs/dag-workflow.md §5.1「进行中归并,否则新建」原意)。
2. **方案 B(同 run 内不覆盖)**:子代理产物改为「按角色 + 调用序号」命名(`NN-role-N.md`),同一 run 内同角色多次调用(executor⇄reviewer 循环、planner 重做、explorer 二次调用)各自独立文件,白名单与检测逻辑同步适配。

### 不做什么(范围控制)
- 不改 `.wf-runs` 目录结构、run.json schema、`RunSnapshot`/`RunAgentCall` 类型(collectArtifacts 已天然支持多产物)。
- 不改前端(产物以路径字符串展示,新文件名自动透传;run 快照仍只展示最新 run——既有限制,不在本次范围)。
- 不做「子目录按调用分」「前端多 run 历史 UI」「自定义代理命名扩展」等方案(探索报告方案 3/4)。
- 不迁移/重写已有 run 目录(46569220、d06adb0f)中已落盘的旧名产物,只保证不被触碰。
- 不改 executor 的 `write: **` 白名单(executor 全量写,仅改其 md 正文中的文件名引用与命名/检测逻辑)。
- 不改 agentDefs.ts 的 glob 机制(现有 picomatch 已支持 `-*.md` 模式)。

## 二、命名方案详细设计(方案 B 核心)

### 2.1 新文件名格式
- **统一规则**:`<NN>-<role>-<seq>.md`,其中 `<NN>-<role>` 沿用现有 `ROLE_ARTIFACT` 值去掉 `.md`(`01-exploration` / `02-plan` / `03-execution` / `04-review`),`<seq>` = 该 run 内同角色**已发生调用次数 + 1**(含失败调用,保证按调用顺序稳定递增)。
- 例:第 1 次 explorer → `01-exploration-1.md`;第 2 次 → `01-exploration-2.md`;reviewer 第 3 轮 → `04-review-3.md`。
- **旧名 `NN-role.md` 不再可写**(白名单只留 `-*.md` 模式)→ 从结构上杜绝模型写旧名覆盖历史产物;旧 run 目录里的旧名文件是历史资产,原样保留。
- 产物路径仍走 `path.join`(平台原生分隔符,与现有 run.json 中 `.wf-runs\46569220\01-exploration.md` 格式一致);注入给模型的提示文本用正斜杠模板串(与现有 `runDirRel` 一致)。

### 2.2 白名单改动(agents/*.md frontmatter `write`)
| 文件 | 旧 write | 新 write |
| --- | --- | --- |
| explorer.md | `.wf-runs/*/01-exploration.md` | `.wf-runs/*/01-exploration-*.md` |
| planner.md | `.wf-runs/*/02-plan.md` | `.wf-runs/*/02-plan-*.md` |
| executor.md | `**` | `**`(不变) |
| reviewer.md | `.wf-runs/*/04-review.md` | `.wf-runs/*/04-review-*.md` |

glob 语义:单层 `*` 匹配 runId、`-*` 匹配序号,`isWriteAllowed` 的路径归一化(win32 反斜杠→斜杠、大小写归一)已覆盖,agentDefs.ts 零改动。

### 2.3 调用方注入(谁决定文件名)
服务端在 `runSubAgent` 中**调用前**计算文件名并注入提示文本:
```
产物目录(相对工作区根):.wf-runs/<runId>
产物文件:.wf-runs/<runId>/<NN-role-N.md>
最终回复只给摘要。
```
「产物文件」行是权威指令,覆盖 md 正文里的旧名引用;白名单只允许 `-N.md` 名,模型无自由度写旧名。

### 2.4 detectArtifact 解析适配
优先级:
1. **精确命中**:服务器注入的 `expectedName`(`NN-role-N.md`)在 run 目录存在 → 直接返回(正常路径,快路径)。
2. **前缀扫描兜底**:内置角色按 `ROLE_ARTIFACT` 推导前缀(`NN-role`),扫描 `.wf-runs/<runId>/` 下 `前缀*.md` 文件,按 mtime 降序(同时刻按文件名降序)取最新(覆盖「模型写成旧名/近似名」的容错)。
3. **自定义代理**:保留现有逻辑(白名单单层 `*` 替换 runId 后精确 existsSync),不扩展(范围控制;自定义代理非本次目标)。

### 2.5 detectPlanFile 适配(闸门)
`piService.ts:735` 现硬编码 `02-plan.md` → 改为前缀扫描:run 目录下 `02-plan*.md` 最新一份(支持首次 `02-plan-1.md` 与重做 `02-plan-2.md`)。闸门 `gate.planFile` 指向最新计划,前端 DagPanel 仅展示该字符串,无需前端改动。

## 三、方案 A 置空时机与代码位置

### 3.1 回合结束释放(主改动)
**文件**:`apps/api/src/pi/piService.ts`,`prompt()` 的 `finally` 块(现约 604-618 行)。
**位置**:`saveRun(workspace.path, run)` 之后追加:
```ts
// 方案 A:回合结束释放 run——done 的 run 不再被本会话后续需求复用(对齐 §5.1)
if (run.status === 'done') handle.run = null
```
- `turnWaitCalled` 分支(awaiting_approval、gate.pending)不置空 → 闸门续跑仍归并同一 run(用户批准后 executor 继续,runId 不变)。
- 状态机不受影响:run.json 仍按原逻辑落盘 `done` + `gate.pending=false`;`resolveCurrentRun` 磁盘扫描本来就跳过 done run,磁盘侧语义与内存侧从此一致。

### 3.2 快照回填防护(必要配套,否则方案 A 失效)
**文件**:`apps/api/src/pi/piService.ts`,`getRunSnapshot()`(约 633-642 行)。
**问题**:`if (handle && !handle.run) handle.run = run` 会把磁盘上的 **done** run 重新挂回 handle,导致下一任务再次复用旧 runId,方案 A 失效(前端刷新/拉快照即触发)。
**改动**:
```ts
if (handle && !handle.run && run.status !== 'done') handle.run = run
```
(awaiting_approval / 进行中 run 仍回填,保证断连恢复与闸门续跑。)

### 3.3 不需要改的点
- `ensureRun()`(327-334 行)逻辑不变:handle.run 为 null 时走 `resolveCurrentRun`(跳过 done)→ 新建 `createRun`。
- `openSession` 恢复逻辑不变(resolveCurrentRun 本就跳过 done)。
- `createSubAgentTool.execute` 中 `if (run.status === 'done') run.status = 'executing'` 保留为防御(方案 A 后 ensureRun 不会返回 done run,该分支成死代码但无害)。

## 四、改动文件清单(9 个文件)

### 4.1 apps/api/src/pi/subAgent.ts(方案 B 主体)
1. `ROLE_ARTIFACT`(45-51 行)保留为「角色 → 旧名基名」映射(语义注释改为:基名,用于推导 `-N.md` 与检测前缀)。
2. 新增导出函数(供单测):
   ```ts
   /** 本次调用的产物文件名:同 run 同角色第 N 次调用 → NN-role-N.md;自定义角色返回 null */
   export function nextArtifactName(run: RunFile, roleName: string): string | null {
     const base = ROLE_ARTIFACT[roleName]
     if (!base) return null
     const seq = run.agents.filter((a) => a.agent === roleName).length + 1
     return `${base.replace(/\.md$/, '')}-${seq}.md`
   }
   ```
3. `runSubAgent()`(约 295-306 行):
   - 调用前 `const artifactName = nextArtifactName(run, name)`。
   - prompt 注入改为(有 artifactName 时追加 `产物文件:` 行,正斜杠):
     ```ts
     const promptText = artifactName
       ? `${task}\n\n产物目录(相对工作区根):${runDirRel}\n产物文件:${`.wf-runs/${run.runId}/${artifactName}`}\n最终回复只给摘要。`
       : `${task}\n\n产物目录(相对工作区根):${runDirRel}\n最终回复只给摘要。`
     await session.prompt(promptText)
     ```
   - `detectArtifact(workspace, run, definition, artifactName)` 传预期名。
4. `detectArtifact()`(225-239 行)改签名与逻辑(见 2.4):
   ```ts
   function detectArtifact(workspace: Workspace, run: RunFile, definition: AgentDefinition, expectedName: string | null): string | null {
     if (expectedName) {
       const p = path.join('.wf-runs', run.runId, expectedName)
       if (workspaceHasFile(workspace.path, p)) return p
     }
     const roleName = definition.frontmatter.name
     const fixed = ROLE_ARTIFACT[roleName]
     if (fixed) {
       const prefix = fixed.replace(/\.md$/, '')
       return newestArtifactInRunDir(workspace.path, run, (name) => name.startsWith(prefix) && name.endsWith('.md'))
     }
     // 自定义代理:原逻辑不变(单层 * 替换 runId + existsSync)
     ...
   }
   ```
5. 新增辅助 `newestArtifactInRunDir(workspacePath, run, predicate)`:`readdirSync` run 目录,过滤文件 + predicate,按 `(mtimeMs, name)` 双键降序取第一个,返回 `.wf-runs/<runId>/<name>` 相对路径或 null。
6. import 增补:`readdirSync`、`statSync`(现仅 `existsSync`)。

### 4.2 apps/api/src/pi/piService.ts(方案 A + 闸门适配)
1. `prompt()` finally 块:`saveRun` 后追加 `if (run.status === 'done') handle.run = null`(见 3.1)。
2. `getRunSnapshot()`:回填条件加 `run.status !== 'done'`(见 3.2)。
3. `detectPlanFile()`(735-738 行)改为前缀扫描最新 `02-plan*.md`(见 2.5);import 增补 `readdirSync`、`statSync`(现 import 行 2 只有 existsSync/readFileSync/rmSync/writeFileSync)。

### 4.3 apps/api/src/pi/agents/explorer.md
- frontmatter `write` → `.wf-runs/*/01-exploration-*.md`。
- 正文:第 3 条「把探索报告写入 01-exploration.md(产物目录由任务说明给出)」→「把探索报告写入**任务说明指定的产物文件**(产物目录与文件名由任务说明给出)」;「报告格式(01-exploration.md)」→「报告格式」(避免模型误按旧名写)。

### 4.4 apps/api/src/pi/agents/planner.md
- `write` → `.wf-runs/*/02-plan-*.md`。
- 正文:第 1 条「先读 01-exploration.md」→「先读产物目录中**最新的探索报告**(`01-exploration-*.md`)」;第 3 条与「计划格式(02-plan.md)」同步改为任务指定产物文件。

### 4.5 apps/api/src/pi/agents/executor.md
- `write: **` 不变。
- 正文:第 1 条「先读 02-plan.md」→「先读产物目录中**最新的计划文件**(`02-plan-*.md`)」;第 3 条「把执行摘要写入 03-execution.md」与「执行报告格式(03-execution.md)」改为任务指定产物文件。

### 4.6 apps/api/src/pi/agents/reviewer.md
- `write` → `.wf-runs/*/04-review-*.md`。
- 正文:第 1 条「读 02-plan.md(计划)与 03-execution.md」→「读产物目录中**最新的计划文件与执行报告**(`02-plan-*.md` / `03-execution-*.md`)」;第 3 条与「审查报告格式(04-review.md)」改为任务指定产物文件。

### 4.7 apps/api/src/pi/agentDefs.test.ts(适配断言)
- 72 行断言:`w.includes('01-exploration.md')` 等对新模式 `01-exploration-*.md` 不再命中 → 改为 `w.includes('01-exploration') || w.includes('02-plan') || w.includes('04-review')`(或断言含 `-*.md`)。
- 127-131 行 glob 语义测试(用旧模式串)仍有效,保留;可追加一条新模式用例:`.wf-runs/*/01-exploration-*.md` 匹配 `.wf-runs/r1/01-exploration-2.md`、拒绝 `.wf-runs/r1/01-exploration.md`。

### 4.8 apps/api/src/pi/subAgent.test.ts(新增单测)
- `nextArtifactName`:空 run → `01-exploration-1.md`;已有 1 条 explorer → `01-exploration-2.md`;reviewer 2 条后 → `04-review-3.md`;失败调用也计数;未知角色 → null。
- `detectArtifact`(需从 subAgent.ts 导出,或经临时目录+构造 RunFile/AgentDefinition 测):① 预期名存在 → 返回预期路径;② 预期名缺失但旧名存在 → 前缀扫描返回旧名;③ 目录空 → null。

### 4.9 docs/dag-workflow.md(文档同步,小改)
- §3.2/§3.3:write 示例与表格 `.wf-runs/*/01-exploration.md` → `.wf-runs/*/01-exploration-*.md`(4 行)。
- §5.2 目录树:`01-exploration.md` 等 → `NN-role-N.md`;「reviewer 多轮覆盖最新,标注『第 N 轮』,历史由 git 兜底」→「每轮独立文件(NN-role-N.md),历史全部保留」。
- §5.1:补充一句「回合结束(done)后服务端释放内存 run,新需求自动开新 run」。
- §6 事件示例 `artifact: '.wf-runs/r1/01-exploration.md'` → `01-exploration-1.md`。

### 明确不改
`agentDefs.ts`(glob 机制)、`runManager.ts`(多产物已支持)、`orchestrator.md`(不引用文件名)、`packages/shared`、前端全部、`.gitignore`。

## 五、实施步骤(顺序)

1. **subAgent.ts**:改 `ROLE_ARTIFACT` 注释、加 `nextArtifactName`、改 `runSubAgent` 注入与调用、改 `detectArtifact` + 新增 `newestArtifactInRunDir`、补 import。
2. **piService.ts**:方案 A 两处(回合结束释放、getRunSnapshot 回填防护)+ `detectPlanFile` 前缀扫描 + import。
3. **四个 agents/*.md**:白名单 + 正文文件名引用(4.3-4.6)。
4. **测试**:改 `agentDefs.test.ts` 断言、扩 `subAgent.test.ts`。
5. **文档**:`docs/dag-workflow.md` 同步。
6. **验证**(见第六节)。
7. 提交(如适用):改动文件 + 新增产物,提交信息如 `fix(pi): 子代理产物永不覆盖(run 回合释放 + NN-role-N 命名)`。

## 六、验证步骤

### 6.1 自动验证
- `pnpm --filter @workflows/api test`(vitest):现有 6 个测试文件 + 新增用例全绿;重点:`agentDefs.test.ts` 白名单断言、`subAgent.test.ts` 命名/检测用例。
- `pnpm --filter @workflows/api typecheck`(tsc --noEmit):无错误。
- `pnpm --filter @workflows/api build`:确认 `scripts/copy-agents.mjs` 把改后的 agents/*.md 复制进 dist(构建产物含新白名单,生产运行依赖)。

### 6.2 手动端到端(核心验收)
前置:`pnpm dev` 起服务,选一个测试工作区(可用本仓库),连续下两条需求(两条都走 explorer→…→reviewer,第二条在第一条完成后发出):
1. **跨任务隔离(方案 A)**:两条需求完成后 `.wf-runs/` 下出现**两个不同 runId** 目录;各自含独立 `01-exploration-1.md`(及 plan/execution/review);`ls` 确认第一条 run 目录文件在第二条执行后 mtime/内容不变(`git status` 也应只显示新增,不显示对旧文件的修改)。
2. **同 run 内不覆盖(方案 B)**:构造同 run 多次同角色调用——a) 审查打回 1 轮再执行:run 目录出现 `04-review-1.md` + `04-review-2.md`(或 3 个),内容各不相同;b) 或让主代理对同一需求调两次 explorer(可提示主代理「先探索一遍,再补充探索一次」):出现 `01-exploration-1.md` + `01-exploration-2.md`。
3. **run.json 一致性**:两条 run 的 `agents[]` 中 `artifact` 字段全部指向**存在的、互不相同的**文件路径;同一 run 内同角色多条调用的 artifact 各不相同;失败调用 artifact 为 null 且序号不重复。
4. **闸门回归**:复杂需求走 planner → 闸门,`gate.planFile` 指向最新的 `02-plan-N.md`;点【批准】后续跑**仍在同一 runId**(run.json 的 agents[] 继续追加);完成后下一需求才开新 run。
5. **旧产物兼容**:`.wf-runs/46569220/` 与 `.wf-runs/d06adb0f/` 文件原样(不新增、不修改);前端子代理模态窗产物链接与 DAG 闸门提示显示新文件名路径(字符串透传,无需前端改动)。

### 6.3 不覆盖的强校验(可选自动化)
对任一 run 目录:`find .wf-runs/<runId> -name '*.md' | sort` 数量 = 该 run agents[] 中 artifact 非空条数;并对各 md 取 sha256,两两不同。

## 七、风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 模型无视注入的「产物文件」、尝试写旧名 `NN-role.md` | guardWriteTool 拦截抛错,该次子代理调用失败 | 白名单只留 `-*.md`(旧名结构性不可写);注入文本明确;md 正文已同步去旧名;失败后主代理可重试(新 callId 新序号) |
| 方案 A 改变「中断回合」语义:中断(含 abort)回合被标记 done 后,下次需求开新 run 而非归并 | 与旧行为不同,但**对齐 docs §5.1 原意**(done 不归并);中断恢复本就不保证 | 计划中明示;文档 §5.1 同步 |
| 前端刷新/拉快照把 done run 重新挂回 handle,方案 A 失效 | 下一任务又复用旧 runId | 3.2 的 `status !== 'done'` 回填防护(必须与 3.1 同批提交) |
| `agentDefs.test.ts` 旧断言不更新导致 CI 红 | 构建/测试失败 | 4.7 同步改断言 |
| 外部脚本/习惯依赖旧名 `01-exploration.md` | 读取失败 | 文档同步;detectArtifact/detectPlanFile 前缀扫描对旧名仍容错;旧 run 产物不受影响 |
| 自定义代理白名单含旧模式 `.wf-runs/*/01-exploration.md`(用户覆盖 agents) | 用户代理不受内置改动约束,仍可能覆盖 | 属用户自定义范畴,不在本次范围;内置四代理为本次目标 |
| 平台路径分隔符:注入文本用 `/`、run.json 记录用 `\`(win32) | 与现状一致,无新增问题 | 不引入 posix 转换,保持既有约定 |

**回滚方案**:全部改动集中在 9 个文件,`git checkout -- <9 个文件>` 即完整回退;已生成的新 run 目录/产物为增量资产,删除对应 `.wf-runs/<新runId>` 目录即可;旧 run 目录无任何迁移动作,天然可回滚。

## 八、验收标准(逐条核对清单)

- [ ] A1:`piService.ts` 回合结束 `saveRun` 后、`run.status === 'done'` 时 `handle.run` 置空(awaiting_approval 不置空)。
- [ ] A2:`getRunSnapshot` 只回填非 done run。
- [ ] A3:同一会话连续两个完整任务产生两个不同 runId,首个 run 目录文件在第二个任务后无变化。
- [ ] A4:闸门续跑(awaiting_approval → 批准)仍归并同一 runId。
- [ ] B1:内置四角色产物名为 `NN-role-N.md`(从 1 起),`nextArtifactName` 按 run.agents 同角色计数递增。
- [ ] B2:explorer/planner/reviewer 的 write 白名单为 `.wf-runs/*/NN-role-*.md`,旧名不可写;executor `**` 不变。
- [ ] B3:runSubAgent 注入文本含「产物文件:.wf-runs/<runId>/<NN-role-N.md>」。
- [ ] B4:detectArtifact 先精确后前缀扫描(内置角色),自定义代理回退逻辑未回归;detectPlanFile 返回最新 `02-plan*.md`。
- [ ] B5:同 run 内同角色多次调用产物文件全部存在、内容互异(sha256 两两不同),run.json agents[] 的 artifact 一一对应且路径真实存在。
- [ ] C1:`pnpm --filter @workflows/api test` 全绿(含新增用例)、`typecheck` 无错误、`build` 成功(copy-agents 后 dist 含新白名单)。
- [ ] C2:旧 run 目录(46569220、d06adb0f)零改动;前端模态窗产物链接与闸门 planFile 正常显示新路径。
- [ ] C3:改动文件仅限 4.1-4.9 列出的 9 个,无越界改动。
