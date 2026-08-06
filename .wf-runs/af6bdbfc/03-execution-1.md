# 执行报告:WorkspaceRail.vue 动作行 UI 优化

> 产物目录中暂无 `02-plan-*.md`(run.json 状态为 planning,仅探索完成),本次以任务说明中的「优化方向(务必落实)」作为计划逐条落实。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
|---|---|---|
| `apps/web/src/components/WorkspaceRail.vue` | 动作行容器:`.mt-1.5 flex gap-1 px-3 pb-1` → `.mt-1.5 flex items-center gap-2 pb-1 pl-3.5 pr-3` | **对齐修正(方向 2)**:卡片文本起始 = `border-l-2`(2px)+ `px-3`(12px)= 左缘 14px;原动作行 `px-3` 仅 12px,存在 2px 错位。`pl-3.5`(=14px)使动作行与卡片文本精确对齐;`gap-2` 拉开两个 quiet 文本操作的距离,避免粘连成一句;`items-center` 显式垂直居中。 |
| 同上 | 两个按钮 class:`border border-hairline bg-canvas px-1.5 py-0.5 text-body hover:border-*/50 hover:text-*` → `py-0.5 font-mono text-[10px] text-mute hover:text-primary`(切换)/ `hover:text-err`(移除) | **quiet 文本式(方向 1/3)**:去掉边框框体+背景,改为 VS Code 列表式纯文本操作;平时 `text-mute` 弱化(主次分明),只读切换 hover 变 `primary`、移除 hover 变 `err`(危险暗示)。选纯文字而非 icon-only:与 rail 内 mono 10px 文本体系一致、视觉最干净,且不破坏既有测试按 `b.text()` 断言按钮的用例;保留 `py-0.5` 维持最小点击热区。 |

**未改动(方向 4)**:常显不依赖 hover、`toggleReadOnly` 调用、`window.confirm` 确认、点击卡片切换激活、`title` 属性、无动画、无新颜色 token、无其他组件。

## 自检结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 测试 | `pnpm --filter @workflows/web test` | ✅ 10 files / 107 tests 全部通过(含 `WorkspaceRail.test.ts` 全部 6 条:按钮常显、文案与 readOnly 对应、确认弹窗、取消不调用、行点击、键盘可达) |
| 类型检查 | `pnpm --filter @workflows/web typecheck`(`vue-tsc -b`) | ✅ 无错误 |

## Diff 摘要

```
apps/web/src/components/WorkspaceRail.vue | 8 ++++----
```

- `-<div class="mt-1.5 flex gap-1 px-3 pb-1">` → `+<div class="mt-1.5 flex items-center gap-2 pb-1 pl-3.5 pr-3">`
- 只读切换按钮:`-border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary` → `+py-0.5 font-mono text-[10px] text-mute hover:text-primary`
- 移除按钮:`-border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-body hover:border-err/50 hover:text-err` → `+py-0.5 font-mono text-[10px] text-mute hover:text-err`

(注:工作区另一 run 的 `.wf-runs/fff99d72/run.json` 有既存未提交改动,与本次任务无关,未触碰。)

## 未完成项

无。全部优化方向已落实。
