# 探索报告:前端图标使用现状(为替换为 @lucide/vue 做准备)

> 调研范围:`C:/Users/kaijia/codes/github/workflows`(pnpm workspace 仓库)
> 重点:`apps/web/src` 下所有 Vue 组件中的手写 / Unicode 图标用法
> 结论先行:**@lucide/vue 未安装,可从零引入;Vue 3.5 完全兼容;建议 `pnpm --filter @workflows/web add @lucide/vue`**

---

## 1. 依赖现状

### 1.1 pnpm-workspace.yaml
```yaml
packages:
  - "apps/*"
  - "packages/*"
onlyBuiltDependencies:
  - esbuild
```
- 工作区含 `apps/*`(web、api)与 `packages/*`(shared)。
- 安装依赖遵循 pnpm workspace 约定:**必须用 `--filter <包名>` 指定目标包,不能加到根**(根 package.json 是纯编排层,`devDependencies` 只有 eslint/turbo/vitest 等工具链)。

### 1.2 @lucide/vue 是否已安装
- `apps/web/package.json`:**未包含** @lucide/vue 或任何 lucide 包。
- 全仓 `pnpm-lock.yaml` grep `lucide`:**无匹配**,确认从未安装过。
- `apps/web/src` 全文 grep `lucide`(ignoreCase):无匹配,无任何使用样例可参考。

### 1.3 apps/web dependencies 完整清单
```json
"dependencies": {
  "@fontsource/chakra-petch": "^5.3.0",
  "@fontsource/instrument-sans": "^5.3.0",
  "@fontsource/jetbrains-mono": "^5.3.0",
  "@workflows/shared": "workspace:*",
  "marked": "^18.0.7",
  "vue": "^3.5.40"
},
"devDependencies": {
  "@tailwindcss/vite": "^4.3.3",
  "@types/node": "^26.1.2",
  "@vitejs/plugin-vue": "^6.0.8",
  "@vue/test-utils": "^2.4.11",
  "cross-env": "^10.1.0",
  "jsdom": "^30.0.1",
  "tailwindcss": "^4.3.3",
  "typescript": "^6.0.3",
  "vite": "^8.2.0",
  "vue-tsc": "^3.3.9"
}
```

### 1.4 构建 / 测试方式
- 根:`turbo run dev|build|typecheck|lint|test`;web 包自身:`vite` / `vue-tsc -b && vite build` / `vitest run`。
- 前端纯静态,无 SSR;图标组件通过 `vue-tsc` 类型检查,模板中直接 `<Settings />` 写法会被 vue-eslint-parser + eslint-plugin-vue 校验。

---

## 2. 图标使用位置清单(文件:行号:现状:样式)

### 2.1 核心目标(任务点名)

| 文件 | 行号 | 当前写法 | 上下文 | 样式 |
|---|---|---|---|---|
| `apps/web/src/components/PipelineHeader.vue` | 109 | Unicode `⚙` | 右上角「设置」按钮(点击 emit `open-settings`,打开 ApiKeyModal) | `<button class="grid size-6 place-items-center border border-edge font-mono text-[11px] text-dim transition hover:border-signal/60 hover:text-signal">` |
| `apps/web/src/components/ApiKeyModal.vue` | — | **无图标** | 设置弹窗:右上关闭是文字按钮「关闭」(L64-69),无 ✕ 图标 | `class="border border-edge px-2 py-0.5 font-mono text-[10px] text-dim hover:border-err/50 hover:text-err"` |

> 注:任务假设 ApiKeyModal 有设置图标,实际该弹窗本身不含 Unicode 图标;可选项:顺手把「关闭」文字按钮换成 lucide `X` 图标(与 SubAgentModal 的 ✕ 风格统一)。

### 2.2 全局其他 Unicode / 手写图标(按组件)

| 文件 | 行号 | 当前写法 | 上下文 | 样式 |
|---|---|---|---|---|
| `App.vue` | 60 | Unicode `⚠` | 底部连接失败提示条(装饰) | 外层 `border-t border-err/40 bg-err/10 px-5 py-1.5 font-mono text-[10px] text-err`,⚠ 直接拼在文本前 |
| `MessageBubble.vue` | 97 | Unicode `▸`(旋转 90° 变 ▾) | 思考块展开/收起箭头(按钮) | `<span class="inline-block w-3 text-center transition-transform duration-200" :class="open ? 'rotate-90' : ''">`,父按钮 `font-mono text-[10px] tracking-wider text-wire hover:bg-wire/[0.06]` |
| `MessageBubble.vue` | 139 | Unicode `▸` / `▾` | 工具块折叠状态文本(按钮尾部) | `{{ collapsed ? '▸ 详情' : '▾ 收起' }}`,`ml-auto shrink-0 font-mono text-[9px]` |
| `MessageBubble.vue` | 165 | Unicode `⚠` | 助手消息错误提示(装饰) | `<p class="font-mono text-[11px] text-err">`,⚠ 拼在 `{{ errorText }}` 前 |
| `SubAgentModal.vue` | 104 | Unicode `✕` | 子代理模态窗关闭按钮 | `<button class="grid size-6 place-items-center border border-edge text-faint transition hover:border-err/60 hover:text-err">` |
| `SubAgentModal.vue` | 118 | Unicode `⇅` | 「THINKING ⇅」全部展开/收起按钮 | `<button class="border border-edge px-2 py-1 font-mono text-[9px] text-faint transition hover:text-fg">` |
| `SubAgentModal.vue` | 96 / 153 | Unicode `●` | 运行中状态(● 运行中) | 状态文本 `font-mono text-[9px]`,running 时 `text-signal` |
| `ChatPane.vue` | 222 | Unicode `⏸` | 闸门「计划待批准」条目的暂停图标(装饰) | `<span class="grid size-4 place-items-center border border-signal/70 bg-signal/10 text-[9px] leading-none text-signal">⏸</span>` |
| `ChatPane.vue` | 358 | Unicode `⇅` | 「THINKING ⇅」按钮(与 SubAgentModal 同款) | 同 SubAgentModal L118 |
| `DagPanel.vue` | 158 | Unicode `⏸` | DAG 图中闸门节点图标 | `<span class="mx-auto grid size-3.5 place-items-center border text-[8px] leading-none" :class="gatePending ? 'border-signal/80 bg-signal/15 text-signal' : 'border-edge text-faint'">` |
| `DagPanel.vue` | 186 | Unicode `⇄` | 执行 ⇄ 审查回边装饰 | `<span class="mx-auto font-mono text-[8px] text-faint">⇄</span>` |
| `DagPanel.vue` | 218 | Unicode `⏸` | 闸门提示行「⏸ 计划待批准…」 | `<p class="mt-2.5 border border-signal/40 bg-signal/5 px-2.5 py-1.5 font-mono text-[9.5px] text-signal">` |
| `SessionSwitcher.vue` | 91 | Unicode `▾` | 会话切换按钮下拉指示 | `<span class="text-faint">▾</span>`,父按钮 `flex items-center gap-1.5 border border-edge px-2 py-0.5 font-mono text-[9px] text-dim hover:border-signal/50 hover:text-signal` |
| `SessionSwitcher.vue` | 133 | Unicode `×` | 删除会话按钮 | `<button class="shrink-0 px-2.5 py-2 font-mono text-[12px] leading-none text-faint transition hover:text-err">×</button>` |
| `SessionSwitcher.vue` | 149 | Unicode `＋`(全角) | 「＋ 新建会话」按钮 | `<button class="block w-full border-t border-edge px-3 py-2 text-left font-display text-[10px] tracking-widest text-signal hover:bg-signal/10">` |
| `WorkspacePickerModal.vue` | 253 | Unicode `❯` | 面包屑 shell 提示符(装饰) | `<span class="mr-2 shrink-0 text-signal">❯</span>`,font-mono text-[11px] |
| `WorkspacePickerModal.vue` | 349 | Unicode `✕` | 错误行前缀(装饰) | `<p class="border-t border-edge px-4 py-1.5 font-mono text-[10px] text-err">✕ {{ error }}</p>` |
| `WorkspacePickerModal.vue` | 363 | Unicode `⏎ ⇥ ↑↓ ← ⌫ ·` | 按键操作提示(纯文本装饰,非按钮) | `font-mono text-[9px] leading-relaxed text-faint/80` |
| `WorkspaceRail.vue` | 110 | ASCII `+` | 「+ 添加工作区」按钮 | `<button class="w-full border border-signal/50 bg-signal/10 px-2.5 py-1.5 font-display text-[11px] tracking-widest text-signal hover:bg-signal/20">` |

### 2.3 手写「边框方块」装饰(非字符图标,替换时建议保留或一并评估)
项目大量用「带边框的 span + 内嵌小色块」模拟节点/状态灯,属设计语言的一部分,不建议替换为 lucide:
- `PipelineHeader.vue` L17-19(品牌方块)、L49-52 / L72-75 / L94-96(管线节点)、L131-134(API 状态灯)
- `DagPanel.vue` L147-153 等(DAG 节点方块)、`ChatPane.vue` L176-179(空状态 LOGO 方块)、`WorkspaceRail.vue` L68-73(端口点)、`InfoPanel.vue` L152-155(状态灯)、`SessionSwitcher.vue` L89(会话按钮小方块)、`MessageBubble.vue` L73-75(入边端口)

### 2.4 不属于图标、无需处理
- 注释/文档中的 `→ ⇄ ⏸`(如 `DagPanel.vue` L6、`PipelineHeader.vue` L6/35/56/84 等)
- 省略号 `…`、间隔点 `·`、占位符 `—`(全项目大量,属排版字符)
- markdown 渲染内容(v-html,`MessageBubble.vue` `:deep(.md)`)——内容是模型输出,不可替换

---

## 3. 现有样式约定(替换时保持视觉一致)

### 3.1 设计 token(Tailwind v4 `@theme`,见 `apps/web/src/style.css`)
| Token | 值 | 用途 |
|---|---|---|
| `signal` | `#f0a83c` 琥珀 | 激活/流动/主强调 |
| `wire` | `#5c8bee` 线缆蓝 | 连接/信息 |
| `ok` | `#3fbf74` | 成功 |
| `err` | `#e4574f` | 错误 |
| `edge` | `#253041` | 边框 |
| `fg`/`dim`/`faint` | `#e8ecf3`/`#8a94a8`/`#5b6577` | 文本三级 |

### 3.2 图标按钮通用范式(替换 lucide 时的目标样式)
- **小方块按钮**:`grid size-6 place-items-center border border-edge` + hover 换色(⚙ 按钮:`hover:border-signal/60 hover:text-signal`;✕ 按钮:`hover:border-err/60 hover:text-err`;× 删除:`hover:text-err`)。lucide 图标建议 `size-3.5`~`size-4`(当前 ⚙ 是 11px 字号的字体字形,方块 24px)。
- **inline 装饰**:`text-err` / `text-signal` / `text-faint`,与文字同排、同字号(如 ⚠、⏸、❯)。
- **纯文本型按钮里的字符**:字体 `font-mono`、9-10px,替换为 lucide 后需 `vertical-align` 微调(图标与 `font-mono` 基线不同,建议 `class="size-3 inline-block align-[-1px]"` 或包一层 flex)。
- 所有图标均无 `fill`、无描边动画;lucide 默认 `stroke="currentColor"` 可直接继承 `text-*` 颜色。

---

## 4. Vue 组件使用方式 / 兼容性

- `apps/web/package.json` 中 `vue: ^3.5.40` → **Vue 3.x,与 @lucide/vue(官方支持 Vue 3,peerDependency vue >=3.2)完全兼容**。
- 项目内**没有**任何 lucide 使用样例(前文已确认)。
- @lucide/vue 当前最新版本约 `0.5xx`(如 0.544.0+),提供命名导出如 `Settings`、`X`、`AlertTriangle`、`Pause`、`ChevronDown`、`ChevronRight`、`Plus`、`Trash2`、`Repeat2` 等,与现有需求一一对应。
- 使用方式:模板中 `<Settings class="size-4" />`(class 透传到 svg),`stroke="currentColor"` 继承 `text-*`。
- 注意 vue-tsc 严格模式:组件模板中使用的 lucide 组件需在 `<script setup>` 中 import(不能全局注册)。

---

## 5. 结论与安装建议

### 5.1 可行性判断
- **可行,风险低**。@lucide/vue 未安装,干净引入;Vue 3.5 兼容;替换点集中在 7 个组件、约 16 处 Unicode 字符,均为静态渲染,无运行时动态图标。
- 替换收益点:⚙(PipelineHeader)、✕(SubAgentModal)、×/＋/▾(SessionSwitcher)、▸/▾(MessageBubble)、⏸(DagPanel/ChatPane)、⚠(App/MessageBubble)、⇅(两个 THINKING 按钮)、⇄(DagPanel)。
- 风险点:① `font-mono` 小字号字符换成 SVG 后行内对齐需微调(建议 icon 尺寸 12-14px、`align-middle`/flex 包裹);② `MessageBubble.vue` L97 的 ▸ 旋转动画(`rotate-90` transition)换成 `ChevronRight` 后可保留同一旋转 class;③ 键盘提示行(L363)的 `⏎ ⇥ ↑↓ ← ⌫` 是纯文本排版,建议**不替换**(lucide 无键盘符号集,替换会破坏提示可读性);④ DAG 节点方块、状态灯等「手写边框方块」是设计语言,建议保留。

### 5.2 安装命令(推荐)
```bash
# 在仓库根目录执行,只装入 apps/web
pnpm --filter @workflows/web add @lucide/vue
```
> 不要 `pnpm add @lucide/vue -w`(会装到根,根是编排层,只有工具链 devDependencies)。
> 该命令会自动更新 `pnpm-lock.yaml` 与 `apps/web/package.json`;无需改动 `pnpm-workspace.yaml`(只有 esbuild 需要 onlyBuiltDependencies 放行,lucide 无构建脚本,不会触发拦截)。

### 5.3 建议替换映射(供下一步实施参考)
| 现字符 | 建议 lucide 图标 | 位置 |
|---|---|---|
| ⚙ | `Settings` | PipelineHeader.vue L109 |
| ⚠ | `TriangleAlert`(或 `AlertTriangle` 旧名) | App.vue L60、MessageBubble.vue L165 |
| ✕ / × | `X` | SubAgentModal.vue L104、SessionSwitcher.vue L133、WorkspacePickerModal.vue L349 |
| ▸ / ▾ | `ChevronRight`(保留 rotate-90 动画)/ `ChevronDown` | MessageBubble.vue L97/L139、SessionSwitcher.vue L91 |
| ⏸ | `Pause` | ChatPane.vue L222、DagPanel.vue L158/L218 |
| ⇅ | `ArrowUpDown` | SubAgentModal.vue L118、ChatPane.vue L358 |
| ⇄ | `Repeat2` | DagPanel.vue L186 |
| ＋ / + | `Plus` | SessionSwitcher.vue L149、WorkspaceRail.vue L110 |
| ● | `Circle`(或保留色点 span) | SubAgentModal.vue L96/L153 |
| ❯ | `ChevronRight`(或保留) | WorkspacePickerModal.vue L253 |
