# 执行报告:工作区操作 UI 重构(移除动作行 → 卡片右上角移除按钮 + InfoPanel 权限切换按钮)

> 产物目录中无 `02-plan-*.md`(run.json 状态与上轮一致,仅探索完成),以任务说明作为计划逐条落实。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
|---|---|---|
| `apps/web/src/components/WorkspaceRail.vue` | 1) 删除卡片下方整个动作行(只读/读写切换 + 移除两个按钮);2) 删除卡片头部右侧 RO/RW 徽标 span;3) 卡片 button 头部行 `justify-between` → 仅名称(注释说明徽标已移除),button 增加 `pr-9` 为右上角按钮预留空间防文字重叠;4) 外层 `relative` 容器内新增绝对定位移除按钮 `absolute right-2 top-2`,Trash2(size-3.5)icon-only,`p-1 rounded-sm text-mute`,选中态 `bg-canvas-soft` 融入卡片,`hover:text-err`,`transition-colors duration-200`;带静态 `title="移除"` + 动态 `:aria-label="移除工作区 ${ws.name}"`;点击仍走原 `handleRemove`(保留 window.confirm) | 卡片整体是 `<button>`,不能嵌套 button;绝对定位放徽标原位置(视觉同位,垂直中心 ≈ 徽标原中心);权限徽标按用户要求移除且不补回;点击切换激活、选中态样式等其余行为不变 |
| `apps/web/src/components/InfoPanel.vue` | 「工作区」section 的只读/读写 `kv` span → 可点击 `<button>`:保留 kv 胶囊样式(用原子类复刻 `.kv`:`rounded-full border px-2 py-px font-mono text-[10px] tracking-wider`,避开 scoped `.kv` 选择器特异性覆盖 border 的问题),`cursor-pointer` + `transition-colors`,hover 边框/文字变 primary,只读态 `border-primary/40 text-primary`;`title="切换为只读/切换为读写"`,点击 `agent.toggleReadOnly(ws.id, !ws.readOnly)`;加 Lock/Unlock(size-3)图标提示可交互(与 WorkspaceRail 同款 `@lucide/vue` 用法);日期徽标不变;容器加 `items-center` 对齐按钮与徽标 | 权限切换入口从左侧动作行迁移到右侧激活工作区信息,保持 kv 视觉语言并增强可发现性 |
| `apps/web/src/components/WorkspaceRail.test.ts` | describe 改「WorkspaceRail 工作区卡片」:删除 2 条基于文本「只读/读写」的切换按钮用例(该交互已移入 InfoPanel);「移除」按钮定位从 `b.text() === '移除'` 改为 `aria-label` 前缀/精确匹配(icon-only 无文本),新增断言 `title="移除"`、`text() === ''`(icon-only);确认/取消/键盘可达用例同步适配 | 适配新结构:移除按钮不再有文本,仅 title/aria-label 可定位 |
| `apps/web/src/components/InfoPanel.test.ts`(新增) | 3 条用例:读写态文案/图标/title;只读态(切换 activeWorkspace 后)文案「只读」+ Lock + text-primary/border-primary/40 + title;点击调用 `toggleReadOnly('ws-1', true)` | 覆盖迁移到 InfoPanel 的权限切换交互(原 WorkspaceRail 中对应用例被删) |

**未改动**:`handleRemove` 确认逻辑、点击卡片切换激活、选中态样式、添加工作区按钮、日期/路径展示、无动画、无新颜色 token、其他组件与测试文件。

## 自检结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 测试 | `pnpm --filter @workflows/web test` | ✅ 11 files / 109 tests 全部通过(含重写的 WorkspaceRail.test.ts 5 条 + 新增 InfoPanel.test.ts 3 条) |
| 类型检查 | `pnpm --filter @workflows/web typecheck`(`vue-tsc -b`) | ✅ 无错误 |

(过程中两次自检失败均为新测试自身问题:① 改 `activeWorkspace.value` 后未 `await nextTick()` 断言读到旧值;② `it` 回调漏标 `async` 导致 `await` 报 TS1308。均已修复。)

## Diff 摘要

```
 apps/web/src/components/InfoPanel.vue         | 23 ++++++++---
 apps/web/src/components/WorkspaceRail.test.ts | 47 +++++--------------
 apps/web/src/components/WorkspaceRail.vue     | 43 +++++------------
 apps/web/src/components/InfoPanel.test.ts     | 新增(3 用例)
```

- WorkspaceRail.vue:动作行(-25 行)与 RO/RW 徽标(-7 行)删除;卡片 button `pr-9`;新增绝对定位 Trash2 移除按钮(约 +12 行)
- InfoPanel.vue:kv span → button(+Lock/Unlock 图标、hover 态、title、@click toggleReadOnly)

## 未完成项

无。全部目标已落实。

(注:`.wf-runs/fff99d72/run.json` 有既存未提交改动,与本次任务无关,未触碰。)
