# 审查报告:renderHistory 两遍扫描修复(历史会话 tools 展开内容为空)

## 结论:pass

改动范围与执行报告一致:`apps/api/src/pi/history.ts` 的 `renderHistory()` 单遍扫描 → 两遍扫描,新增 `apps/api/src/pi/history.test.ts`(3 用例),未触碰 `renderBlocks`/`extractText`/`piService.ts`/前端。修复逻辑正确、输出格式完全兼容、测试真实覆盖回归场景,可合入。注:产物目录无 `02-plan.md`(run.json `gate.planFile: null`,计划即任务说明),与上一轮相同,不影响结论。

## 逐条核对

| # | 计划项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 两遍扫描逻辑:toolCallId 关联、isError、同 id 取最后一条 | 通过 | 第一遍(h:16-23)遍历全部消息,`toolResult` → `lastToolOutput.set(toolCallId, {output: extractText(content), isError})`,Map.set 天然"同 id 最后一条覆盖",与修复前 `set` 语义一致;第二遍(h:26-50)按原顺序渲染,`renderBlocks` 内 `lastToolOutput.get(call.id)`(h:74)此时必然命中。`renderBlocks`/`extractText` 与修复前逐行一致(对照 01-exploration.md 引用的旧代码),`isError: result?.isError` 透传不变。唯一理论差异:toolResult 排在引用它的 assistant 之前且同 id 后又出现一条的乱序场景,两遍扫描取全局最后一条(修复前取该点之前最后一条)——属病态乱序,且两遍语义更正确,非回归。 |
| 2 | 输出格式与字段完全兼容 | 通过 | `HistoryItem` 结构(id/role/blocks/usage/model)未动;toolResult 仍不单独成条(测试 1 断言 items 长度 2);块顺序仍按 content 数组原序(h:52-80 未改);tool 块字段 `callId/name/args/output/isError` 与 `packages/shared/src/index.ts:139` 类型一致。空输出场景由 `undefined` 变为 `''`(extractText 对空数组返回 ''),前端 `useAgent.ts:247/582` 的 `block.output ?? ''` 两值同归 `''`,`isError ?? false` 亦然——API 返回结构与前端消费均不受影响。无 toolResult 的 toolCall 仍渲染 `output: undefined` 的 tool 块(与修复前一致,无行为变化)。 |
| 3 | 单测覆盖回归场景且断言有效 | 通过 | 用例 1(assistant toolCall 在前、toolResult 在后)是根因场景:旧单遍代码下渲染 assistant 时 Map 为空 → `output` 为 `undefined`,断言 `output: '文件内容'` 必失败,即该用例能真实捕获回归;同时断言 `callId/name/args/isError` 与块序 `['thinking','tool']`,锁住格式。用例 2(toolResult 在前)验证顺序无关;用例 3 验证同 id 多条取最后一条。断言均为实质断言(toMatchObject 具体值、长度、块序),非空跑。 |
| 4 | 遗漏场景 | 未完成(非阻断) | ① 多轮会话交错场景未测:user → assistant(toolCall a) → toolResult a → assistant(toolCall b) → toolResult b → assistant(纯文本),即真实 JSONL 中最常见形态;② 无 toolResult 的 toolCall(应渲染 output 为 undefined 的块)未测;③ `isError: true` 的 toolResult 透传未测。均为建议补充,代码路径已由用例 1/3 覆盖核心逻辑,不构成缺陷。 |
| 5 | 运行 pnpm test | 通过(证据有限) | 审查环境无 shell,无法亲自执行;静态核实:apps/api 共 7 个测试文件(config/app/subAgent/agentDefs/fffTools/workspaceGuard/history),与执行报告"7 文件 92 用例全过"吻合;`package.json` `test: vitest run` 默认 glob 会拾取 `src/pi/history.test.ts`;测试风格/`./history.js` 导入与 `subAgent.test.ts` 一致;`import type` 不引入运行时依赖。执行报告另称 `tsc --noEmit` 通过,与代码类型(HistoryBlock 可选字段)相符。 |

## 问题清单

无阻断问题。建议(非阻断):

1. `apps/api/src/pi/history.test.ts` — 建议补一个多轮交错用例(user → assistant(toolCall a) → toolResult a → assistant(toolCall b) → toolResult b → assistant 文本,断言两 tool 块各自 output 正确、assistant 文本块在 tool 块之后),这是磁盘真实 JSONL 的典型形态,可同时锁定块顺序与多工具关联。
2. `apps/api/src/pi/history.test.ts` — 建议补"toolCall 无对应 toolResult"(断言 tool 块存在且 `output` 为 `undefined`)与 `isError: true` 透传两例,防止未来重构改变这两处行为。
3. 代码注释(h:14-16)可顺带说明"第一遍仅收集 toolResult,第二遍才渲染"的两遍结构;非必需。

## 最终建议

通过。两遍扫描正确修复了时序 bug(工具输出在渲染 assistant 时已就绪),输出结构零变更、API 兼容,回归测试真实有效;遗漏场景仅为测试覆盖度建议,不涉及代码缺陷,可合入。
