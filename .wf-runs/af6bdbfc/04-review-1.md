# 审查报告:工作区操作 UI 重构(移除动作行 → 卡片右上角移除按钮 + InfoPanel 权限切换按钮)

## 结论:pass(附 2 条非阻塞建议)

> 说明:产物目录中无 `02-plan-*.md`(run.json 状态为 planning),本审查以**任务说明的用户需求(① ② ③)为计划基准**,对照最新的执行报告 `03-execution-2.md`(4 文件改动,已覆盖并取代 `03-execution-1.md` 的旧方向)与实际代码逐条核对。当前文件状态与 execution-2 描述一致。

---

## 一、逐条核对(计划项 → 状态 → 说明)

| # | 计划项(用户需求/执行声明) | 状态 | 说明 |
|---|---|---|---|
| 1 | ③ 左栏卡片下方原动作行删除 | 通过 | `WorkspaceRail.vue` 中 `mt-1.5 flex gap-1 px-3 pb-1` 动作行(只读/读写切换 + 移除两按钮)已整体删除,无残留 |
| 2 | ② 移除操作替换左栏卡片右上角 RW 徽标 | 通过 | `WorkspaceRail.vue:83` 头部 RO/RW 徽标 span 已删除(仅留注释);`:99-108` 外层 `div.relative` 内新增绝对定位 Trash2 移除按钮 `absolute right-2 top-2`(原徽标位) |
| 3 | ① 只读/读写切换操作移到 InfoPanel「只读」徽标处 | 通过 | `InfoPanel.vue:73-84` 原 kv span 升级为 `<button>`:保留胶囊样式(原子类复刻 `.kv`,避开 scoped 特异性)、Lock/Unlock(size-3)图标、`title="切换为只读/切换为读写"`、`@click="agent.toggleReadOnly(ws.id, !ws.readOnly)"` |
| 4 | window.confirm 保留 | 通过 | `WorkspaceRail.vue:37-42` `handleRemove` 仍先 `window.confirm` 二次确认,确认后才 `removeWorkspace(id)` |
| 5 | toggleReadOnly 逻辑正确 | 通过 | 取反参数 `!ws.readOnly` 正确;`useAgent.ts:292` 存在 `toggleReadOnly(id, readOnly)` 且 `:845` 已导出(`AgentStore = ReturnType<typeof useAgent>`,`:863`),App.vue 传同一 agent 给 InfoPanel,类型/数据链完整 |
| 6 | HTML 合法性:无 button 嵌套 | 通过 | 移除按钮是卡片 `<button>` 的**兄弟节点**(同处 `div.relative` 内),未嵌套;卡片 button 仍为合法按钮元素 |
| 7 | 绝对定位与原徽标视觉对齐、不遮文字 | 通过 | 按钮 22px 高(14px 图标 + p-1),top-2 后垂直中心 ≈19px,与原徽标中心(名称行 py-2.5 + 13px 行高 ≈19.75px)基本一致;卡片 button 加 `pr-9`(36px),名称 `truncate` 止于 184px,按钮左缘 ≈190px,不重叠;路径/日期行(y≈33.5px 起)低于按钮底(y=30px),无垂直重叠 |
| 8 | 点击热区可用 | 通过 | `p-1` 热区 22px,绝对定位元素在 DOM 序中位于卡片之后、绘制于其上,点击命中移除按钮不冒泡触发卡片激活(兄弟节点) |
| 9 | a11y:icon-only 有 aria-label + title | 通过 | 移除按钮 `title="移除"` + 动态 `:aria-label="移除工作区 ${ws.name}"`(WorkspaceRail.vue:104-105);InfoPanel 切换按钮有可见文本「只读/读写」非 icon-only |
| 10 | a11y:键盘可达 + hover/focus 反馈 | 通过 | 两处均为原生 `<button type="button">`,Tab 可达;全局 `:focus-visible`(style.css:91-94,primary 绿 outline);移除按钮 `hover:text-err`、切换按钮 `hover:border-primary hover:text-primary`,反馈清晰 |
| 11 | 视觉一致性:tokens/mono 10px/无新 token/无动画 | 通过 | 全部使用既有 tokens(text-mute/err/primary、border-primary/40、border-hairline、bg-canvas-soft、text-body);font-mono text-[10px] 体系保持;`transition-colors duration-200` 与全仓既有范式(卡片 button、添加按钮)一致,非新增 slop |
| 12 | 测试有效性:覆盖新交互 | 通过 | WorkspaceRail.test.ts 5 条:移除按钮常显/aria-label/title/icon-only 断言、确认→调用、取消→不调用、行点击 emit+openWorkspace、键盘聚焦;InfoPanel.test.ts 3 条:读写态文案/图标/title、只读态文案+`text-primary`/`border-primary/40`、点击调用 `toggleReadOnly('ws-1', true)` |
| 13 | 无重要覆盖丢失 | 通过 | 被删的 2 条 WorkspaceRail 切换按钮用例其交互已迁移至 InfoPanel(新 3 条覆盖文案/只读态样式/调用),确认/取消/键盘用例保留 |
| 14 | 测试与 typecheck 全绿 | 见说明 | **本环境无 shell 工具,无法独立重跑** `pnpm --filter @workflows/web test` / `vue-tsc -b`。静态核对:执行报告声称 11 files / 109 tests 通过(107 + InfoPanel 3 − WorkspaceRail 1,数量自洽)+ typecheck 无错;我逐条推演了 8 条用例与组件实现的对应关系,均能成立(见问题清单外分析)。建议 CI 或本地复核一次 |

---

## 二、问题清单

| 严重度 | 文件/位置 | 问题描述 | 修复建议 |
|---|---|---|---|
| 低(非阻塞) | `apps/web/src/components/InfoPanel.test.ts:41,52` | 用例名写「+ Unlock 图标」/「+ Lock 图标」,但断言仅 `toggle.find('svg')).toBeTruthy()`,未校验具体是 Lock 还是 Unlock。若图标逻辑被反装,测试不会失败 | 断言图标组件:`toggle.findComponent(Lock).exists()`(import { Lock, Unlock } from '@lucide/vue'),或用 class 定位 |
| 低(非阻塞) | `apps/web/src/components/WorkspaceRail.test.ts:23-25` | mountRail stub 仍保留 `toggleReadOnly`(WorkspaceRail 已不再使用),属残留死桩 | 删除该 stub 字段,保持测试与组件契约一致 |
| 提示 | `apps/web/src/components/WorkspaceRail.vue:70` | 卡片 button 同时含 `px-3` 与 `pr-9`,依赖 Tailwind 排序使 `pr-9` 覆盖右侧 padding(标准用法,当前成立);若未来升级 Tailwind 出现覆盖顺序变化,名称可能与移除按钮重叠 | 无操作必要;如需加固可改为显式 `pr-9 pl-3` 或在该行加注释说明依赖 |

## 三、需求符合度总结

- ①②③ 三条用户需求全部落实,位置与交互语义与需求一致(移除=卡片右上角原徽标位、切换=右栏激活工作区徽标处、左栏动作行删除);
- 确认弹窗、卡片点击激活、选中态等既有行为零改动;
- 未发现 button 嵌套、文字重叠、热区失效、a11y 缺失或新 token/动画引入。

## 四、最终建议

**通过。** 改动范围精确(4 文件)、行为符合需求、测试覆盖迁移完整。两条低严重度建议可择机处理(图标断言、死桩清理),不阻塞合入。

⚠️ 复核提示:因审查环境无 shell,`pnpm test`/typecheck 未能独立重跑,建议在 CI 或本地执行一次确认全绿(执行报告已自检通过)。
