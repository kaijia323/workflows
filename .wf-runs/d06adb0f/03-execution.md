# 执行报告:子代理产物永不覆盖(A+B 组合方案)

> runId: d06adb0f ｜ 类型:实施 ｜ 依据:02-plan.md(已批准方案 A+B)

## 改动文件清单(9 个计划文件,无越界)

### 1. apps/api/src/pi/subAgent.ts(方案 B 主体)
- `ROLE_ARTIFACT` 语义注释改为「基名」:值(旧名 `NN-role.md`)仅用于推导序号名与检测前缀。
- 新增导出 `nextArtifactName(run, roleName)`:同 run 同角色第 N 次调用 → `NN-role-N.md`(seq = `run.agents` 同角色计数 + 1,含失败调用);未知角色返回 null。
- `runSubAgent`:调用前算 `artifactName`,prompt 注入追加权威指令行 `产物文件:.wf-runs/<runId>/<NN-role-N.md>`(正斜杠;自定义角色无此行,保持原注入格式);`detectArtifact` 传预期名。
- `detectArtifact` 改为导出 + 三优先级:① 预期名精确 existsSync 命中(快路径)→ ② 内置角色按基名前缀扫描 run 目录取最新 → ③ 自定义代理原逻辑(白名单单层 `*` 替换 runId + existsSync)不变。
- 新增辅助 `newestArtifactInRunDir`:`readdirSync` + `statSync`(仅文件),按 `(mtimeMs, name)` 双键降序取第一个,返回 `.wf-runs/<runId>/<name>`;import 增补 `readdirSync`、`statSync`。

### 2. apps/api/src/pi/piService.ts(方案 A + 闸门适配)
- `prompt()` finally:`saveRun` 后追加 `if (run.status === 'done') handle.run = null`(回合结束释放;awaiting_approval 分支不置空,闸门续跑仍归并)。
- `getRunSnapshot()`:回填条件改为 `if (handle && !handle.run && run.status !== 'done') handle.run = run`(防止磁盘 done run 重新挂回 handle 使方案 A 失效)。
- `detectPlanFile()`:硬编码 `02-plan.md` → 前缀扫描 run 目录最新 `02-plan*.md`(支持 `02-plan-1.md` 与重做 `02-plan-2.md`);import 增补 `readdirSync`、`statSync`。
- `ensureRun` / `resolveCurrentRun` / `createSubAgentTool.execute` 的防御分支(`status==='done'` 置 executing)按计划保留未动。

### 3-6. agents/{explorer,planner,executor,reviewer}.md
- explorer/planner/reviewer 的 write 白名单:`NN-role.md` → `NN-role-*.md`(旧名结构性不可写;executor `**` 不变)。
- 正文文件名引用全部去旧名:写报告改为「写入**任务说明指定的产物文件**」,读前置文件改为「产物目录中**最新的 XX**(`NN-role-*.md`)」,「报告格式(NN-role.md)」改为「报告格式」。

### 7. apps/api/src/pi/agentDefs.test.ts
- 72 行附近断言:改为 `w.includes('01-exploration') || ...` 前缀判断 + 追加 `w.endsWith('-*.md')` 断言。
- 保留原 glob 语义测试(旧模式串测 glob 机制),新增「方案 B 新模式」用例:`.wf-runs/*/01-exploration-*.md` 命中 `01-exploration-2.md`、拒绝旧名 `01-exploration.md`、`*` 不跨层。

### 8. apps/api/src/pi/subAgent.test.ts
- 新增 `nextArtifactName` 5 例(空 run→-1、已有 1 条→-2、reviewer 2 条→-3 含失败计数、executor 递增、未知角色→null)。
- 新增 `detectArtifact` 5 例(预期名精确命中、旧名前缀扫描容错、多文件取最新 mtime + 同时刻文件名降序、空目录→null、自定义代理回退)。
- 说明:自定义代理分支返回白名单模式串(正斜杠)、预期名快路径返回 `path.join` 结果(win32 反斜杠),两处断言按实际行为分别断言。

### 9. docs/dag-workflow.md
- §3.2/§3.3/§4:write 示例与表格 `NN-role.md` → `NN-role-*.md`(含 executor 的 `03-execution-*.md`)。
- §5.1:补充「回合结束(done)后服务端释放内存 run,新需求自动开新 run;仅 awaiting_approval 归并」。
- §5.2:目录树改为 `NN-role-N.md` + 新增命名规则说明(seq = 同角色调用次数 + 1,旧名结构性不可写,历史全部保留)。
- §6:事件示例 `artifact` 改为 `01-exploration-1.md`。

## 自检结果

- `pnpm test`(root, turbo):7 个测试文件全部通过,**103/103 用例通过**(api 7 文件 103 例;web/shared 通过)。
- `pnpm typecheck`(root):3/3 任务成功,无错误。
- `pnpm build`(root):3/3 成功;`copy-agents.mjs` 确认把新白名单复制进 `dist/pi/agents`(grep 验证 `-*.md` 模式)。

## 一致性自查(验收清单逐条核对)

- A1 ✅ finally 块 saveRun 后、done 时置空;awaiting_approval 不置空。
- A2 ✅ getRunSnapshot 只回填非 done run。
- A3 ✅(逻辑保证:handle.run=null 后 ensureRun 走 resolveCurrentRun,磁盘 done run 被跳过 → 新建 runId)。
- A4 ✅ turnWaitCalled 分支不置空,闸门续跑归并同一 run。
- B1 ✅ nextArtifactName 按 run.agents 同角色计数从 1 起,含失败调用。
- B2 ✅ 三角色白名单 `NN-role-*.md`,`-` 为字面量故旧名结构性不可写;executor `**` 不变。
- B3 ✅ runSubAgent 注入 `产物文件:.wf-runs/<runId>/<NN-role-N.md>`(正斜杠)。
- B4 ✅ detectArtifact 精确→前缀扫描(内置)→自定义回退;detectPlanFile 前缀扫描最新 `02-plan*.md`。
- C1 ✅ test / typecheck / build 全绿。
- C2 ⚠️ 旧 run 目录未被本次改动触碰:`.wf-runs/46569220/run.json` 的 `updatedAt` 变更(02:03:00)发生在本次执行开始(02:16)之前,属探索阶段既有状态,非本任务改动所致;`.wf-runs/d06adb0f/` 为本 run 新增产物。测试全部使用临时目录,不触碰旧 run。
- C3 ✅ 改动文件仅限计划的 9 个文件(+ 本执行报告产物)。

## 未完成项

- 无代码未完成项。手动端到端验收(§6.2 连续两条需求、审查打回多轮等)需要运行中的服务 + 模型调用,不在本次执行范围(需人工/后续验证)。
