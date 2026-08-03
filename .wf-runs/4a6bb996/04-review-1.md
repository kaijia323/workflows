# 审查报告:提交 c1cba88(撤销 run.json 忽略规则 + done 冻结改造)

> 对照计划 `.wf-runs/4a6bb996/02-plan-1.md` 逐条核验;审查对象为 HEAD 提交 `c1cba88ea5594fa0ea539ed1a3861d7bc9ffd673`(parent `eac4591`)。
> 审查方式:源码逐行核对 + 工作树文件状态 + git 时间线交叉核对(审查环境无 shell,无法执行 `git show/diff/status`,git 侧事实为间接验证,见问题清单 N3)。

## 结论:pass

---

## 逐条核对结果

### A 部分:git 恢复

| 计划项 | 状态 | 说明 |
|---|---|---|
| A1 `.gitignore` 删除 `.wf-runs/*/run.json` 规则及注释 | 通过 | 实测 `.gitignore` 全文已无任何 `.wf-runs` 相关规则(注释行一并删除),`.workflows/` 等其他规则保留;`.git/info/exclude` 亦无 `.wf-runs` 规则。`git check-ignore` 退出码 1 的声明与文件状态一致 |
| A2 3 个 run.json(2a2b4d0d/46569220/d06adb0f)恢复跟踪 | 通过 | 时间线验证:696fc399 轮次的 `git rm --cached` 未单独提交(logs/HEAD 中 eac4591→c1cba88 之间无中间提交),c1cba88 的 `git add` 使 3 文件重新进索引,与报告「内容一致无 diff」自洽 |
| A3 .wf-runs 全量进 git(5 个 runId) | 通过 | `.wf-runs/` 下 5 个 run 目录(2a2b4d0d/46569220/4a6bb996/696fc399/d06adb0f)的 run.json 均存在;报告声明 5 个 runId 全部进索引,时间线无矛盾 |
| A4 提交 + 工作树干净 | 通过(提交时点) | `refs/heads/main` = c1cba88,commit message 与计划 A4 一致;提交时点(19:01:02)早于 executor 自身 append(19:02:57)与报告文件写入,「提交时干净」声明自洽。当前工作树存在本轮运行中的 4a6bb996/run.json 修改与 03/04 报告未跟踪——属流程进行中预期状态,本轮结束 complete_task 后冻结、下轮提交(计划 §7.6 自验证设计) |

### B 部分:5 处代码改动

| 计划项 | 状态 | 说明 |
|---|---|---|
| B1 `ensureRun` 内存捷径 done 检查 | 通过 | `piService.ts:333-347`,捷径条件为 `handle.run && handle.run.status !== 'done'`,done 时回退 `resolveCurrentRun`(其内存/磁盘路径均排除 done)→ 新建 run。一处堵住子代理翻转/闸门复活/agents 追加三窗口 |
| B2 子代理调用前翻转去掉 done | 通过 | `piService.ts` `createSubAgentTool.execute` 内:`if (run.status === 'awaiting_approval') run.status = 'executing'`,done 不再回退;`run.gate.pending = false` 与 `saveRun` 保留。planning/executing 行为与改造前一致,无回归 |
| B3 finally done 分支仅首次写盘 | 通过 | `piService.ts` finally done 分支带 `if (run.status !== 'done')` 守卫(首次置 done 才写盘,消除 updatedAt 二次 bump);`handle.run = null` 释放保留;顺带 `run.gate.planFile = null` 清理(计划允许) |
| B4 complete_task 后 `handle.run = null` | 通过 | `piService.ts` `createCompleteTaskTool.execute`:`saveRun` 之后、return 之前置 `handle.run = null`,注释说明堵「先 wait_for_approval 后 complete_task」经 finally 闸门分支复活 done run 的漏洞。崩溃安全落盘顺序(saveRun 先于释放)正确 |
| B5 `saveRun` 冻结熔断 | 通过 | `runManager.ts:69-80`:`run.status === 'done'` 且磁盘 `loadRun` 亦 done → return;首次 done 写盘(磁盘非 done)不受影响;`loadRun` 为函数声明,提升无问题 |
| B6 注释与 docs 同步 | 通过 | `runManager.ts` 头注释加冻结行;`docs/dag-workflow.md` §5.1 加「done 后 run.json 冻结」bullet、§7 任务完成段加「done 即终态…闸门仅对非 done 生效」、§8 崩溃行加「done 的 run 不参与恢复扫描」,三处均实测在位 |

### 语义安全核验

| 检查项 | 状态 | 说明 |
|---|---|---|
| wait_for_approval 对非 done run 的闸门功能 | 保留 | 闸门路径未改:ensureRun 对非 done run 正常归并,置 awaiting_approval + gate.pending + 落盘;finally awaiting_approval 分支无条件写盘行为不变 |
| 断点续跑(awaiting_approval/keep 归并) | 保留 | `resolveCurrentRun` 未改(内存/磁盘路径排除 done);keep 分支不写盘不释放;闸门续跑翻回 executing 路径实测保留 |
| complete_task 崩溃安全落盘 | 保留 | saveRun 在释放前执行;B5 仅拦「磁盘已是 done」的后续写 |
| 首次进入 done 的写盘 | 保留 | B3 守卫只跳「已 done」;B5 只跳「磁盘已 done」;两条路径的首次 done 写均放行 |
| 新增 bug 排查(内存/磁盘 done 判定不一致致 run 卡死) | 无 | B5 只拦「内存 done && 磁盘 done」;内存非 done 而磁盘 done 的可达状态不存在(ensureRun/resolveCurrentRun/openSession 均排除 done,complete_task 置 done 后立即释放),无卡死路径 |
| finally 三分支回归(keep/awaiting_approval) | 无 | 仅 done 分支改动;keep/awaiting_approval 分支逐行比对与改造前一致 |
| 快照/历史展示 | 保留 | `getRunSnapshot` 磁盘回填有 `status !== 'done'` 防护;complete_task 后 handle.run=null 时快照回退磁盘 find 仍返回 done run,展示不受影响 |

### 测试质量

| 检查项 | 状态 | 说明 |
|---|---|---|
| 新增 3 个单测存在且与计划一致 | 通过 | `runManager.test.ts`「done 冻结」describe 3 例:①首次 done 写成功 + 冻结后改写内容逐字节不变(updatedAt/gate 变更被拒);②done 后 appendRunAgentCall 磁盘 agents 不追加 + 内容不变;③非 done→done 首次写不被误伤 + updatedAt 正常推进 + resolveCurrentRun 排除 done |
| 双向语义覆盖 | 通过 | done→不写(①②)与非 done→正常写(③)双向覆盖;断言为文件内容比对(JSON 含 updatedAt/agents/gate 全部字段),非仅 mtime,无「只测 mtime 不测内容」缺陷 |
| 现有测试全过 | 通过(声明) | runManager 12 旧 + 3 新 = 15 例;报告声明 api 8 文件 118 例全过 + typecheck/lint/build 全绿。审查环境无 shell 无法复跑,以报告声明为准(见 N3) |
| 计划 §6.3 可选 piService 测试 | 偏离(可接受) | 未提交单测,以私有访问手工验证 ensureRun done 排除/awaiting_approval 归并;计划标为可选,结果记录在报告中 |

### git 历史与工作树

- 提交 c1cba88 为 HEAD,message 与计划 A4(+B 改造)一致;parent 链无中间提交,与「696fc399 的 rm --cached 未提交、c1cba88 一并恢复」的报告自洽。
- 改动文件清单(8 个:`.gitignore`、`piService.ts`、`runManager.ts`、`docs/dag-workflow.md`、`runManager.test.ts` + .wf-runs 产物)与计划范围一致;工作树未见计划外新增文件(pi 目录无 `piService.test.ts` 等意外文件)。

---

## 问题清单

| # | 文件/位置 | 问题描述 | 修复建议 |
|---|---|---|---|
| N1(非阻断) | 计划 §7.3 | 真实 LLM 端到端(完整闸门→批准→complete_task→同会话新消息→旧 run.json mtime/内容/updatedAt 不变)未执行,以 runManager 层逐字节冻结验收 + piService ensureRun 行为验证替代。B3/B4 在真实服务中的 finally 集成路径仅静态核验 | 后续有真实会话时补一次冒烟:完成一个需求后同会话再发消息,核对旧 run.json 三项不变、新 run 目录新增;同时观察 wait_for_approval 续跑归并同一 runId 无回归 |
| N2(非阻断) | 计划 §6.3 | piService 层 B1/B4 行为验证未固化为可复现单测(仅报告中记录),CI 无法回归 | 若成本可接受,按计划 §6.3 模板补 `piService.test.ts`(私有访问构造 handle 断言 ensureRun 对 done run 新建、对非 done 归并) |
| N3(验证局限) | 全仓 | 审查环境无 shell,`git show --stat c1cba88` / `git ls-files .wf-runs/` / `git status` 无法直接执行;提交 diff 范围与 tracked 清单为间接验证(HEAD、commit message、时间线、文件状态交叉核对),单测/typecheck/lint/build 未复跑 | 建议人工快速复核:`git show --stat c1cba88`(确认无计划外文件)、`git ls-files .wf-runs/ | grep run.json`(确认 5 个 runId)、提交后 `git status --porcelain` |
| N4(观察,非问题) | runManager.ts:69-80 | B5 熔断只拦「内存 done && 磁盘 done」;理论上「内存非 done && 磁盘 done」会覆盖写,当前可达状态不存在(所有写路径的 run 来源均排除磁盘 done),已确认无卡死/复活路径 | 无需修复;如未来新增不经过 ensureRun 的写路径,建议把 B5 条件改为「磁盘 done 即拦」并加 force 参数 |

---

## 最终建议

**通过。**

- A 部分 git 恢复与计划一致(.gitignore 已清规则、3 个 run.json 恢复跟踪、.wf-runs 全量进 git、提交为 HEAD 且 message 匹配)。
- B 部分 5 处代码改动(B1-B5)+ 文档同步(B6)逐行核对与计划一致,无缺项、无越界改动。
- 语义安全核验通过:闸门/断点续跑/崩溃安全/首次 done 写盘全部保留,未发现新增卡死或 done 复活路径;先 wait_for_approval 后 complete_task 的剩余漏洞由 B4 正确关闭。
- 测试:3 个新增单测真实覆盖 done 冻结双向语义且为内容级断言;现有 15 例 runManager 用例结构完整。
- 仅存非阻断项:N1(真实 LLM 端到端未跑,已有等价验收替代)、N2(可选 piService 测试未固化)、N3(审查环境无法复跑 git/test 命令,建议人工快速复核)。
