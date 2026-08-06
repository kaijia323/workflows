# 执行报告(第二轮小加固):审查报告 3 项建议修问题

> 依据:`.wf-runs/c4c0c7d6/04-review-1.md` 问题清单(建议修 1/2/3);未处理项:问题 4(ChatPane 批准时序,设计取舍保留)、问题 5(双标签页实测/JSONL 落点,人工验收)。
> 基线提交:f7cd97d(web)、0161fa1(api)。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/web/src/composables/useAgent.ts` | `openWorkspace` 早退分支(`activeWorkspaceId.value === id`)由 `return` 改为 `openSeq++` + `switchingWorkspaceId.value = null` 后返回 | 在途 open(A) 期间点回当前工作区 W:早退 bump openSeq 使在途请求的晚到响应因 `seq !== openSeq` 被丢弃、其 finally 也不清位(由早退分支清),「最后点击者」语义成立,修复审查问题 1 |
| `apps/api/src/pi/piService.ts` | `prompt()` 中 `this.activeEmitters.set(workspace.id, onEvent)` 从 subscribe 之前移到 subscribe 之后、try 之内(紧邻 `await handle.session.prompt(text)`);相关注释同步调整 | subscribe 抛异常时 set 不再执行,Map 无残留条目,与 finally 的 delete 严格成对,修复审查问题 2 |
| `apps/web/src/composables/useAgent.test.ts` | 新增 2 例:(a) 在途切换期间点回当前工作区 → 晚到 /open 响应被作废、视图不跳走、窗口期标志清位;(b) abort 按流归属:流式期间改 `activeWorkspaceId` 后调 `abort()` → POST 目标为流所属工作区 ws-1(而非当前激活 ws-2),归属流连接以 AbortError 断开收尾 | (a) 为问题 1 修复补回归测试;(b) 为审查问题 2 指出的测试缺口补单测(计划验收标准「abort 中止流所属工作区」)。测试中 fetch mock 将 signal 真实接线到流(abort 时以 `DOMException('AbortError')` 拒绝 read),完整走通客户端断开路径 |
| `apps/api/src/pi/piService.test.ts` | 新增 1 例:fake session 的 `subscribe` 抛异常 → `prompt` rejects 且 `activeEmitters.size === 0`(无残留、无幽灵条目) | 为问题 2 修复补回归测试,沿用「私有成员视图 + fake handle」既有直测模式 |

## 自检结果

- 定向测试:`pnpm --filter @workflows/web test` → 10 文件 / 107 用例全绿;`pnpm --filter @workflows/api test` → 18 文件 / 375 用例全绿。
- 全量测试:`pnpm test`(turbo)→ 3 tasks 全部成功(web 107、api 375 通过)。
- 类型检查:`pnpm typecheck`(turbo)→ 3 tasks 全部成功(web vue-tsc / api tsc --noEmit)。
- 提交时 husky + lint-staged(eslint --fix)自动过检。

## 未完成项与原因

- 审查问题 4(ChatPane approvePlan/rejectPlan 中 dismissGate 先于 sendMessage,窗口期批准意图丢失):按任务说明属设计取舍,保留不处理。
- 审查问题 5(双标签页并发子代理回合实测、`~/.workflows/workspace-sessions.json` messageCount 与 JSONL header cwd 核对、dev 冒烟):需真实运行环境,属人工验收项,不在本改动范围。
