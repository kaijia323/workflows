# 审查报告:子代理产物永不覆盖(A+B 组合方案)

> runId: d06adb0f ｜ 类型:代码审查 ｜ 依据:02-plan.md(计划)、03-execution.md(执行报告)、01-exploration.md(探索报告)
> 审查方式:静态通读 9 个改动文件 + 关联文件(agentDefs.ts / runManager.ts / orchestrator.md / copy-agents.mjs / package.json / .gitignore / dist 构建产物)+ 新旧 run.json 交叉核对

## 结论:pass

方案 A(回合释放 run)与方案 B(NN-role-N 命名)均已按计划实施,逻辑闭环成立,无阻断性缺陷。附 4 条非阻断问题与建议(见问题清单)。

---

## 一、逐条核对结果

### 方案 A(跨任务隔离)

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| A1 回合结束释放 run | 通过 | `apps/api/src/pi/piService.ts:621` — `prompt()` finally 块 `saveRun` 之后追加 `if (run.status === 'done') handle.run = null`;`turnWaitCalled` 分支(awaiting_approval / gate.pending)不置空,闸门续跑仍归并同一 runId。位置与顺序符合计划 §3.1。 |
| A2 快照回填防护 | 通过 | `piService.ts:640-641` — `if (handle && !handle.run && run.status !== 'done') handle.run = run`。磁盘 done run 不会重新挂回 handle,方案 A 不会被前端拉快照击穿。 |
| A3 连续任务产生新 runId | 通过(静态链) | handle.run=null → 下次 `ensureRun` 走 `resolveCurrentRun(..., null)` → 磁盘 done run 被跳过 → `createRun` 新 runId。`runManager.ts` 的 `resolveCurrentRun`(行 105-118)确认跳过 done 与 gate.pending=false 的 run。真实运行证据待 E2E(见问题 3)。 |
| A4 闸门续跑归并 | 通过 | awaiting_approval 回合结束不置空;批准回合 `createSubAgentTool.execute` 中 `if (run.status === 'awaiting_approval' ...) run.status = 'executing'` + `gate.pending=false`,ensureRun 返回同一 in-memory run。 |

### 方案 B(同 run 内不覆盖)

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| B1 序号命名 | 通过 | `subAgent.ts:60-66` `nextArtifactName`:seq = `run.agents` 同角色计数 + 1(从 1 起);失败调用在 `piService.ts` catch 分支先 `appendRunAgentCall`(artifact:null)再抛错,故计入下次序号;未知角色返回 null。单测 5 例覆盖(subAgent.test.ts:79-99)。 |
| B2 白名单 | 通过 | explorer/planner/reviewer 三个 md 的 write 均为 `.wf-runs/*/NN-role-*.md`;旧名 `NN-role.md` 缺 `-N` 段,结构性不可写(agentDefs.test.ts:140 断言拒绝);executor `**` 不变。dist/pi/agents 构建产物实测含新白名单(copy-agents.mjs 已复制)。 |
| B3 指令注入 | 通过 | `subAgent.ts:362-367` — 调用前算 artifactName,prompt 追加 `产物文件:.wf-runs/<runId>/<NN-role-N.md>`(正斜杠模板串);自定义角色(artifactName 为 null)保持原注入格式,无「产物文件」行。 |
| B4 检测逻辑 | 通过 | `detectArtifact`(subAgent.ts:247-273):① 预期名精确 existsSync(快路径)→ ② 内置角色按 ROLE_ARTIFACT 基名前缀扫描 run 目录、`(mtimeMs, 文件名)` 双键降序取最新(`newestArtifactInRunDir`,行 277-296)→ ③ 自定义代理原逻辑(白名单单层 `*` 替换 runId + existsSync)保留。`detectPlanFile`(piService.ts:743-763)前缀扫描最新 `02-plan*.md`,兼容首次与重做。 |
| B5 多轮产物互异 | 通过(逻辑/单测) | 命名按调用序严格递增、互不重复;run.json agents[] 的 artifact 由 detectArtifact 返回真实存在路径。真实多轮内容 sha256 互异属模型行为,需 E2E 验证(见问题 3)。 |

### 边界与范围

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 自定义代理 | 通过 | `nextArtifactName` 返回 null(不注入产物文件行);`detectArtifact` 自定义回退分支与原逻辑一致,单测覆盖(subAgent.test.ts:154-166,含正斜杠/平台分隔符两种断言)。 |
| 前缀扫描不误匹配 | 通过 | 四个角色基名前缀互斥(`01-exploration` / `02-plan` / `03-execution` / `04-review`),且仅扫描本 run 目录,不跨 run、不跨角色。 |
| 旧名兼容 | 通过 | 旧 run 目录(46569220、d06adb0f)中的旧名文件为历史资产;detectArtifact / detectPlanFile 前缀扫描对旧名仍容错(subAgent.test.ts:114-121 明确测试)。 |
| C3 无越界改动 | 通过 | 改动仅限计划 9 个文件。orchestrator.md 未动(不引用文件名);agentDefs.ts glob 机制零改动;runManager.ts 未动;shared 类型未动;前端 grep 无任何角色名/planFile 硬编码(仅字符串透传展示);.gitignore 未动(.wf-runs 仍可 git 追踪);copy-agents.mjs 未动。 |
| C2 旧 run 零改动 | 通过(有限验证) | `.wf-runs/46569220/` 目录仍为 4 个文件(01-exploration.md / 03-execution.md / 04-review.md / run.json),无新增、无新命名文件;`.wf-runs/d06adb0f/` 为本次 run(01-exploration.md / 02-plan.md / 03-execution.md 系改动前旧代码产生,属历史资产)。执行报告称 46569220/run.json 的 updatedAt(18:03)早于执行开始(18:14),审查环境无 git/shell 无法独立验证,但与时间线吻合、可信。 |
| C1 test/typecheck/build | 通过(声明,未复跑) | 执行报告称 api 7 文件 103/103、typecheck 3/3、build 3/3。审查环境无 shell 无法复跑;静态核对单测与实现一致(见下),dist 构建产物实测含新白名单,Node 引擎 ≥20.19 满足 `statSync(throwIfNoEntry)`(≥18.17)要求。 |

### 单测静态核对(与实现一致性)

- `subAgent.test.ts` 13 例:toSubEvents 3 + nextArtifactName 5 + detectArtifact 5。mtime 双键降序断言与 `newestArtifactInRunDir` 排序实现一致(同时刻文件名降序取 `-2.md`);自定义代理分支断言与实现一致(回退返回模式串、预期名快路径返回 path.join 结果,两分支平台分隔符不同,测试分别断言——正确)。
- `agentDefs.test.ts`:72 行附近断言改为前缀判断 + `w.endsWith('-*.md')`(仅对 explorer/planner/reviewer 断言);保留旧模式 glob 机制测试;新增方案 B 用例(行 136-141)验证 `-2.md` 命中、旧名拒绝、`*` 不跨层。
- 全仓库 grep:旧名 `NN-role.md` 残留仅存在于 ROLE_ARTIFACT 基名(subAgent.ts:50-53,语义注释已改)、测试用例(故意)与 agentDefs.ts 注释(行 11),无功能引用遗漏;docs 中仅 §5.2 说明「旧名结构性不可写」处提及。

---

## 二、问题清单(均非阻断)

1. **detectArtifact 兜底可能误记上一轮产物**(subAgent.ts:258-260 + 277-296)
   - 问题:当模型未写预期文件(精确命中失败)且 run 目录已有同前缀旧文件时,前缀扫描返回最新文件——若该文件是**上一次调用**的产物(如第 2 轮 executor 未产出 `03-execution-2.md`,兜底返回第 1 轮的 `03-execution-1.md`),run.json 中本次调用的 artifact 会指向旧文件,「artifact 与调用一一对应」保证被削弱。
   - 建议:兜底时排除 `run.agents` 中已记录过的 artifact 路径(未被认领的文件优先),全部已被认领时返回 null。低概率(正常路径为精确命中),可作后续加固。

2. **空序号文件技术上可写**(agents/*.md 白名单 `-*.md`)
   - 问题:picomatch 的 `*` 可匹配空串,`01-exploration-.md` 在语法上命中白名单。
   - 建议:如需严格化可用 `-[0-9]*.md` 或 `-+([0-9]).md`(extglob);实际影响可忽略,模型不会主动写空序号,可不改。

3. **手动 E2E 未执行(计划 §6.2)**
   - 问题:跨任务两 runId(A3)、审查打回多轮产物互异(B5)、闸门批准后归并同 runId(A4)、旧 run git 零改动(C2)均只有静态链 + 单测支撑,无真实运行证据。执行报告已声明属人工/后续验证范围。
   - 建议:按计划 §6.2 补一次手动验收(两条连续需求 + 一次审查打回),并核对 run.json agents[] 的 artifact 与目录文件一一对应。

4. **docs §8 崩溃续跑措辞与新释放语义的轻微张力**(docs/dag-workflow.md §8 恢复表)
   - 问题:§8「运行中崩溃 → 用户重发 prompt 续跑」,方案 A 后崩溃回合被标记 done 并释放,续跑实际在新 runId 进行;§5.1 已明确释放语义,但 §8 表述易误导。
   - 建议:§8 补一句「续跑将新建 run(产物目录隔离,旧产物保留)」;非阻断。

---

## 三、最终建议

**通过。**

实现与计划 9 文件范围一致、逻辑闭环(注入序号 ↔ 白名单 glob ↔ detectArtifact/detectPlanFile 前缀扫描 ↔ run 释放/回填防护五环自洽),单测覆盖关键场景,构建产物(dict)确认含新白名单。建议后续:① 按问题 3 补手动 E2E;② 按问题 1 加固 detectArtifact 兜底(可选);③ docs §8 措辞微调(可选)。
