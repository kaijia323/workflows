# 执行报告:前端手写/Unicode 图标 → @lucide/vue

> 任务:`apps/web` 前端手写/Unicode 图标替换为 `@lucide/vue` 组件
> 依据:探索报告 `.wf-runs/dbc5f020/01-exploration-1.md`
> 状态:全部完成(9 文件、16 处替换)

---

## 1. 依赖安装

- 命令:`pnpm --filter @workflows/web add @lucide/vue`(仓库根执行,未加 `-w`)
- 结果:`@lucide/vue@^1.28.0` 写入 `apps/web/package.json` dependencies;`pnpm-lock.yaml` 新增对应 lock 条目(importers + packages + snapshot)。`pnpm-workspace.yaml` 无需改动(lucide 无构建脚本)。
- 版本:`1.28.0(vue@3.5.40(typescript@6.0.3))`,peer 要求 `vue >=3.0.1`,与项目 Vue 3.5 兼容。

---

## 2. 替换明细(文件:旧字符 → 新组件)

| 文件 | 行号(替换后) | 旧写法 | 新写法 | 说明 |
|---|---|---|---|---|
| `PipelineHeader.vue` | 109 | `⚙` | `<Settings class="size-4" />` | 方块按钮原样式(`size-6 border border-edge text-dim hover:border-signal/60 hover:text-signal`)与 emit 逻辑原样保留;字号类 `font-mono text-[11px]` 保留(对 svg 无副作用) |
| `App.vue` | 60 | `⚠` | `<TriangleAlert class="mr-1 inline-block size-3.5 align-[-2px]" />` | `v-if="agent.connectionError.value"` 条件渲染逻辑未动;仅把字符换成行内图标(保留 `text-err`) |
| `MessageBubble.vue` | 97 | `▸` | `<ChevronRight class="size-3" />` | rotate-90 过渡动画保留在外层 span class(`transition-transform duration-200` + `:class` 旋转) |
| `MessageBubble.vue` | 139 | `▸ 详情`/`▾ 收起` | `<ChevronRight v-if="collapsed"/>` + `详情` / `<ChevronDown v-else/>` + `收起` | 尾部 span 改 `flex items-center gap-1` 以对齐图标与 9px 文字 |
| `MessageBubble.vue` | 165 | `⚠` | `<TriangleAlert class="mr-1 inline-block size-3.5 align-[-2px]" />` | `text-err` 继承,行内对齐微调 |
| `SubAgentModal.vue` | 104 | `✕` | `<X class="size-4" />` | 关闭按钮样式原样保留(尺寸由 `grid size-6` 决定) |
| `SubAgentModal.vue` | 118 | `THINKING ⇅` | `THINKING` + `<ArrowUpDown class="size-3" />` | 按钮加 `flex items-center gap-1` 对齐 |
| `ChatPane.vue` | 222 | `⏸` | `<Pause class="size-3" />` | **语义确认**:此为「计划待批准」闸门徽标(等待/暂停状态装饰,非停止操作按钮),`Pause` 最贴切;未用 `Square`/`CircleStop`(那两个语义是"中止/停止")。原 `text-[9px] leading-none` 随字符移除,`grid size-4 place-items-center` 保证居中 |
| `ChatPane.vue` | 358 | `THINKING ⇅` | `THINKING` + `<ArrowUpDown class="size-3" />` | 同上,按钮加 `flex items-center gap-1` |
| `DagPanel.vue` | 158 | `⏸` | `<Pause class="size-2.5" />` | 与 ChatPane 一致选 `Pause`(同一闸门语义);方块 `size-3.5` 不变,移除 `text-[8px]` |
| `DagPanel.vue` | 186 | `⇄` | `<ArrowLeftRight class="size-3" />` | 执行⇄审查回边装饰;外层 `flex h-px w-5 items-center` 自动居中 |
| `DagPanel.vue` | 218 | `⏸ 计划待批准…` | `<Pause class="mr-1 inline-block size-3 align-[-2px]" /> 计划待批准…` | 提示行 `font-mono text-signal` 保留,`planFile` 插值逻辑未动 |
| `SessionSwitcher.vue` | 91 | `▾` | `<ChevronDown class="size-3 text-faint" />` | 父按钮已 `flex items-center gap-1.5`,无需改 |
| `SessionSwitcher.vue` | 133 | `×` | `<X class="size-3.5" />` | 删除按钮 hover:text-err 保留 |
| `SessionSwitcher.vue` | 149 | `＋ 新建会话` | `<Plus class="size-3" /> 新建会话` | 按钮 `block` → `flex items-center gap-1.5`(保 `text-left w-full`) |
| `WorkspacePickerModal.vue` | 253 | `❯` | `<ChevronRight class="mr-2 size-3 shrink-0 text-signal" />` | 面包屑 prompt 装饰;父容器已 flex |
| `WorkspacePickerModal.vue` | 349 | `✕ {{ error }}` | `<X class="mr-1 inline-block size-3 align-[-1px]" /> {{ error }}` | 错误行装饰,`text-err` 继承 |
| `WorkspaceRail.vue` | 110 | `+ 添加工作区` | `<Plus class="size-3.5" /> 添加工作区` | 按钮改 `flex items-center justify-center gap-1.5` 保持原居中效果 |

### 有意保留(未替换)
- `SubAgentModal.vue` L97/L155 的 `● 运行中` 色点状态文本 —— 任务明确"状态装饰,保留不动"。
- `WorkspacePickerModal.vue` L363 键盘提示(`⏎ ⇥ ↑↓ ← ⌫ ·`) —— 非图标纯文本,替换会破坏可读性(探索报告 §5.1 风险点③)。
- `ApiKeyModal.vue` 的「关闭」文字按钮 —— 探索报告指出该弹窗无 Unicode 图标,任务未点名,不扩大范围。
- 注释/文档中的 `⏸ ⇄ ❯`(DagPanel.vue L7/L182、WorkspacePickerModal.vue L9)与「边框方块」设计语言(品牌方块/状态灯/DAG 节点) —— 均非渲染图标,保留。

### 导入方式
全部按规范在各自 `<script setup>` 顶部显式 import(无全局注册):
- `PipelineHeader.vue`:`import { Settings } from '@lucide/vue'`
- `App.vue`:`import { TriangleAlert } from '@lucide/vue'`
- `MessageBubble.vue`:`import { ChevronDown, ChevronRight, TriangleAlert } from '@lucide/vue'`
- `SubAgentModal.vue`:`import { ArrowUpDown, X } from '@lucide/vue'`
- `ChatPane.vue`:`import { ArrowUpDown, Pause } from '@lucide/vue'`
- `DagPanel.vue`:`import { ArrowLeftRight, Pause } from '@lucide/vue'`
- `SessionSwitcher.vue`:`import { ChevronDown, Plus, X } from '@lucide/vue'`
- `WorkspacePickerModal.vue`:`import { ChevronRight, X } from '@lucide/vue'`
- `WorkspaceRail.vue`:`import { Plus } from '@lucide/vue'`

### 最小样式微调(仅布局对齐,均已说明)
1. 三个「THINKING ⇅」/纯文本按钮加 `flex items-center gap-1`(图标与 9px font-mono 文字基线对齐)。
2. `MessageBubble.vue` L139 尾部 span 改 `flex items-center gap-1`。
3. `SessionSwitcher.vue` L149、`WorkspaceRail.vue` L110 按钮 `block`/默认 → `flex items-center`(保持原有居中/左对齐与点击区域)。
4. 行内装饰图标统一 `inline-block` + `align-[-1px]`/`align-[-2px]` + `mr-1` 补偿原字符间距。

---

## 3. 自检结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm --filter @workflows/web typecheck`(vue-tsc -b) | ✅ 通过,无错误 |
| Lint | `pnpm --filter @workflows/web lint`(eslint .) | ✅ 通过,无错误 |
| 构建 | `pnpm --filter @workflows/web build`(vue-tsc -b && vite build) | ✅ 491ms 构建成功;bundle `index--nXxQCf5.js` 含 lucide 代码(与 lucide 相关无报错) |
| 残留检查 | 全 `apps/web/src` grep 目标字符 | ✅ 仅剩:有意保留的 `●`(SubAgentModal L97/L155)、键盘提示行(L365)、代码注释(DagPanel L7/L182、WorkspacePickerModal L9);`×`/`＋`/`+ 添加` 均已清除 |

## 4. 改动文件清单

- `apps/web/package.json` — 新增依赖 `@lucide/vue@^1.28.0`
- `pnpm-lock.yaml` — lock 条目(importers/packages/snapshot)
- `apps/web/src/components/PipelineHeader.vue` — ⚙→Settings
- `apps/web/src/App.vue` — ⚠→TriangleAlert
- `apps/web/src/components/MessageBubble.vue` — ▸/▾→ChevronRight/ChevronDown、⚠→TriangleAlert
- `apps/web/src/components/SubAgentModal.vue` — ✕→X、⇅→ArrowUpDown
- `apps/web/src/components/ChatPane.vue` — ⏸→Pause、⇅→ArrowUpDown
- `apps/web/src/components/DagPanel.vue` — ⏸(×2)→Pause、⇄→ArrowLeftRight
- `apps/web/src/components/SessionSwitcher.vue` — ▾→ChevronDown、×→X、＋→Plus
- `apps/web/src/components/WorkspacePickerModal.vue` — ❯→ChevronRight、✕→X
- `apps/web/src/components/WorkspaceRail.vue` — +→Plus

> 注:git diff 中出现的 `ApiKeyModal.vue`、`useAgent.ts`、`apps/api/*`、`packages/shared/*` 及 PipelineHeader/App 的 emit 相关行均为任务开始前工作区已有的未提交改动(anysearch 功能等),本次任务未触碰,仅保留原样。

## 5. 未完成项

- 无。任务范围内 16 处替换全部完成,验证全部通过。
