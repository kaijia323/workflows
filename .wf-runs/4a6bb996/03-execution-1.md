# 执行报告:撤销 run.json 忽略规则 + done 冻结改造

> 依据计划 `.wf-runs/4a6bb996/02-plan-1.md`;全部 A/B 项已完成并提交。
> 提交:`c1cba88ea5594fa0ea539ed1a3861d7bc9ffd673`(main)

## 改动文件清单

| 文件 | 改动内容 | 对应计划 |
|---|---|---|
| `.gitignore` | 删除末尾两行 `# workflow run metadata (regenerated on every run)` 与 `.wf-runs/*/run.json`,恢复原状;`.workflows/` 等其余规则不动 | A1 |
| `apps/api/src/pi/piService.ts` | ① `ensureRun` 内存捷径改为 `handle.run && handle.run.status !== 'done' ? handle.run : resolveCurrentRun(...)`(done 即终态,不再内存归并) | B1 |
| 同上 | ② 子代理调用前状态翻转:仅 `if (run.status === 'awaiting_approval') run.status = 'executing'`(去掉 done 分支,注释「done 为终态,永不回退」) | B2 |
| 同上 | ③ finally done 分支加 `if (run.status !== 'done')` 守卫,仅首次进入 done 时写盘(顺带 `run.gate.planFile = null` 清理残留);`handle.run = null` 释放保留 | B3 |
| 同上 | ④ complete_task 在 `saveRun` 后立即 `handle.run = null`(带注释:配合 B1 堵住「先 wait_for_approval 后 complete_task」经 finally 闸门分支复活 done run 的漏洞) | B4 |
| `apps/api/src/pi/runManager.ts` | ⑤ `saveRun` 加冻结熔断:`run.status === 'done'` 且磁盘 `loadRun` 亦为 done 时直接 return(首次 done 写盘保留,崩溃安全不受影响;注释说明未来补录需显式 force 通道) | B5 |
| 同上 | ⑥ 头注释加一行「冻结:done 后 run.json 不再改写…,新需求开新 run」 | B6 |
| `docs/dag-workflow.md` | §5.1 加「done 后 run.json 冻结」bullet;§7 任务完成段加「done 即终态:complete_task 后同回合再调任何工具不再复用该 run,闸门仅对非 done 的 run 生效」;§8 崩溃恢复行加「done 的 run 不参与恢复扫描,不会从终态复活」 | B6 |
| `apps/api/src/pi/runManager.test.ts` | 新增 3 个 done 冻结单测(done 冻结双向 / done 后 appendRunAgentCall 不落盘 / 非 done→done 首次写不被误伤) | §6.2 |

## git 恢复(A 部分)

- `git check-ignore .wf-runs/2a2b4d0d/run.json` → 退出码 1(不再忽略)✓
- 3 个被 `git rm --cached` 的 run.json 已 `git add` 恢复跟踪;内容与旧提交一致(无 diff,工作区文件即原版本),无 deleted 条目 ✓
- `git add .wf-runs/` 全量纳入:`.wf-runs/{2a2b4d0d,46569220,4a6bb996,696fc399,d06adb0f}/run.json` 共 5 个 runId 全部进索引 ✓
- 提交后 `git status --porcelain` 干净 ✓

## 自检结果

- **单测**:`pnpm --filter @workflows/api test` → 8 个文件 118 例全过(含 runManager 原 12 例 + 新增 3 例,15/15)✓
- **typecheck**:`pnpm --filter @workflows/api typecheck` 通过;提交时 husky 触发 turbo 全仓 typecheck(3/3 包)通过 ✓
- **lint**:`pnpm --filter @workflows/api lint` 通过(无输出)✓
- **build**:`pnpm --filter @workflows/api build` 通过 ✓
- **端到端(runManager 层冻结验收)**:脚本模拟「complete_task 首次 done 落盘 → finally 重复写 / 闸门复活 / appendRunAgentCall 追加 / 再次兜底写」,断言 done run 的 run.json **mtime、内容(逐字节)、updatedAt 全部不变**,状态/gate/agents 均未复活;`resolveCurrentRun` 排除 done;闸门续跑(awaiting_approval→批准→executing)不受冻结影响、仍归并同一 runId ✓
- **piService 层 B1 验证**(§6.3 可选,已做):私有访问构造服务,`ensureRun` 对 handle 上挂 done run 时新建 runId、旧 done run 磁盘不变;对 awaiting_approval run 内存归并 ✓

## 未完成项与说明

- 计划 §7.3 的「启动 apps/api + 真实 LLM 走完整闸门→complete_task 回合」未执行:需要新开真实模型会话(含交互式批准),超出本执行回合可验证范围;已用 runManager 层逐字节冻结验收 + piService 层 ensureRun 行为验证覆盖同一验收标准(done 后 run.json mtime/内容/updatedAt 不变)。
- 本流程自身 run(4a6bb996)的 done 冻结自验证(§7.6)由编排器在 complete_task 时落定,执行报告不代为改写 run.json。
- 提交时机:报告文件在本提交之后写入,`03-execution-1.md` 为未跟踪新增,随下一轮产物提交。
