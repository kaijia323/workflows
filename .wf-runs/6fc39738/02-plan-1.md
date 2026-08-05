# 实施计划:「UI 与体验优化」— apps/web

> 依据:`.wf-runs/6fc39738/01-exploration-2.md`(4 HIGH / 8 MEDIUM / 3 LOW,共 15 条,结论 **Block**)。
> 本计划已逐条对照源码核实(file:line 与修复方向均确认可行)。
> 约束:改动全部集中在 `apps/web/src`;保持 VoltAgent 设计语言(近黑 `#101010` + 电光绿 `#00d992` + hairline 描边,token 只从 `style.css` `@theme` 取),不引入新设计体系;不修改 `apps/api` 与 `packages/shared`。
> 测试现状:web 共 **5 个** vitest 文件(4 组件 + 1 composable:`App` / `ChatPane` / `McpPanel` / `WorkspacePickerModal` / `useAgent`),全部须保持绿色;本计划新增 3 个测试文件 + 扩展 1 个。

---

## 一、目标与范围

### 做(11 个任务,分两阶段)

| # | 严重度 | 任务 | 对应 finding | 阶段 |
| --- | --- | --- | --- | --- |
| T1 | HIGH | 模态窗对话框契约(role=dialog + 焦点 trap/还原 + Esc + 背景 inert) | #2 | Phase 1 |
| T2 | HIGH | 工作区行「只读/移除」常显 + 移除前确认 | #1 + #3 | Phase 1 |
| T3 | HIGH | 窄视口响应式兜底(<1100px 侧栏收为抽屉,聊天列永不为 0) | #4 | Phase 1 |
| T4 | MED | 表单控件 label 补齐(可见/sr-only,placeholder 降级为示例) | #6 | Phase 2 |
| T5 | MED | 折叠状态语义(THINKING/工具行 `aria-expanded`) | #7 | Phase 2 |
| T6 | MED | 按压状态语义(MODEL/THINK `aria-pressed`) | #8 | Phase 2 |
| T7 | MED | live region(消息流 `role="log"`、错误 `role="alert"`) | #9 | Phase 2 |
| T8 | MED | skill 下拉 combobox 语义(`listbox`/`option`/`aria-activedescendant`) | #5 | Phase 2 |
| T9 | MED | 元数据对比度 + 字号下限(`text-mute/70-80%` → 全量 mute;8-9px → ≥10-11px) | #10 + #11 | Phase 2 |
| T10 | LOW | 标题大纲(页面级 h1;section-label 降为非标题) | #12 | Phase 2 |
| T11 | LOW | 消息列宽 `max-w-3xl` → `max-w-2xl`;DAG 节点/连线尺寸修正 | #14 + #15 | Phase 2 |

### 不做(明确排除)

- **#13 会话条目加名称/摘要**:需要后端会话元数据(`SessionMeta` 无首条消息字段)→ 超出「改动集中在 apps/web/src」约束,记录为后续迭代(可单独做 `packages/shared` + `apps/api` + 前端三端改动)。
- 审查报告 Considered-but-Rejected 表中的 6 项(焦点环 2px、按压 scale、flow-dot transform、死 keyframe、SessionSwitcher 自定义确认、iOS 16px)——维持拒绝理由。
- SessionSwitcher 下拉(listbox 化)、闸门流程重构、真实读屏(需 NVDA/VoiceOver)验证——不在本轮范围。
- 不改 `apps/api`(含 `piService.ts` 删除行为)、`packages/shared`、`index.html`(viewport meta 已正确)。

---

## 二、Phase 1(高优先级,4 个 HIGH 全覆盖)

### T1 模态窗对话框契约(#2)

**目标文件**:
- 新建 `apps/web/src/composables/useModalDialog.ts`
- `apps/web/src/components/ApiKeyModal.vue`
- `apps/web/src/components/WorkspacePickerModal.vue`
- `apps/web/src/components/SubAgentModal.vue`

**改动要点**:
1. 新建 composable `useModalDialog(opts: { root: Ref<HTMLElement|null>; onClose: () => void; ariaLabel: string; initialFocus?: () => HTMLElement|null })`:
   - `onMounted`:保存 `document.activeElement` 作为焦点还原目标;对 `root.parentElement` 的所有兄弟子节点设置 `el.inert = true`(带 `'inert' in el` 特性守卫,旧浏览器仅降级、不报错);焦点移入 root(`tabindex="-1"` 已在模板上),`initialFocus` 提供时优先聚焦该元素;
   - `document` 级 `keydown`(**bubble 阶段**,且 `if (event.defaultPrevented) return`——避免与 WorkspacePicker 输入框的 Tab 补全冲突):`Escape` → `onClose()`;`Tab`/`Shift+Tab` 在 root 内可聚焦元素(`a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])`)间循环;
   - `onBeforeUnmount`:清除兄弟节点 inert、移除监听、焦点还原(仅当目标 `isConnected`;如触发按钮已被卸载则跳过);
   - 注释说明:三个模态窗均为 App.vue 根 div 的直接子节点,故「兄弟节点 inert」方案天然成立,无需 Teleport。
2. 三个模态窗模板:最外层 `fixed inset-0` 遮罩 div 加 `role="dialog" aria-modal="true"` + `tabindex="-1"` + 各自 `aria-label`(设置:API Keys 与 MCP 配置 / 添加工作区 / 子代理 agentName),并把该 ref 传给 composable;`ApiKeyModal` 与 `WorkspacePickerModal` 现有 `@click.self="emit('close')"` 保留(与焦点 trap 不冲突)。
3. `WorkspacePickerModal`:composable 的 `initialFocus` 传 `inputRef`(保留现有「打开即聚焦输入框」行为);其 `onKeydown` 里的 Escape 分支保留(Escape 双重触发 close 幂等无害)。

**验证方式**:
- 新增单测 `apps/web/src/composables/useModalDialog.test.ts`(见「五、测试清单」)。
- 浏览器(15200):打开设置 → 焦点应进入对话框;连续 Tab 到最后一个控件后再 Tab 回到第一个;Shift+Tab 反向循环;Escape 关闭且焦点回到「设置」按钮;打开期间背景按钮不可 Tab 到达。

### T2 工作区行「只读/移除」常显 + 移除确认(#1 + #3)

**目标文件**:`apps/web/src/components/WorkspaceRail.vue`
**新建测试**:`apps/web/src/components/WorkspaceRail.test.ts`

**改动要点**:
1. 重构行结构,修复**非法 HTML(button 嵌套 button)**:`v-for` 根元素由 `<button>` 改为 `<div class="relative">`,原选中按钮(`@click="agent.openWorkspace(ws.id)"`,含 border-l 激活态等样式)保留为第一个子元素;动作按钮**移出选中按钮、改为兄弟节点**。
2. 动作区由 `absolute right-2 top-2 hidden gap-1 group-hover:flex`(hover 才显示、覆盖 RO/RW 徽标)改为**常显动作行**:`<div class="mt-1.5 flex gap-1 px-3 pb-1">`,内含「读写/只读」与「移除」两个小按钮(沿用现有 `border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px]` 样式与 hover 变色),去掉 `@click.stop`(已无需阻止冒泡),保留 `title` 说明。
3. `handleRemove(id)` 加确认,与 `SessionSwitcher.vue:135` 的既有范式一致:
   ```ts
   if (!window.confirm('移除工作区后,其会话历史文件将被永久删除,不可恢复。确定移除?')) return
   ```
   文案明示「会话历史将被永久删除」(后端 `DELETE /workspaces/:id` → `piService.ts:690 rmSync` 已核实为真删文件)。

**验证方式**:
- 新增单测:动作按钮存在于 DOM 且无 `hidden` 类;`window.confirm` 返回 true 时调用 `removeWorkspace`;返回 false 时不调用。
- 浏览器:不 hover 也能看到并 Tab 到两个按钮;点「移除」弹出确认框,文案含「永久删除」。

### T3 窄视口响应式兜底(#4)

**目标文件**:
- `apps/web/src/style.css`(`@theme` 加自定义断点)
- `apps/web/src/App.vue`(抽屉开关状态 + 开关条 + 遮罩 + Esc)
- `apps/web/src/components/WorkspaceRail.vue`(新增 `open` prop)
- `apps/web/src/components/InfoPanel.vue`(新增 `open` prop)

**改动要点**:
1. `style.css` `@theme` 增加 `--breakpoint-console: 1100px;`(注释:三栏 ↔ 抽屉的切换断点,>=1100px 保持三栏);Tailwind v4 据此生成 `max-console:` 变体。
2. `WorkspaceRail.vue` 根 aside:加 `max-console:fixed max-console:inset-y-0 max-console:left-0 max-console:z-40 max-console:transition-[transform,visibility]`;`:class="open ? 'max-console:translate-x-0 max-console:visible' : 'max-console:-translate-x-full max-console:invisible'"`;`tabindex="-1"` 以便打开时收焦。`InfoPanel.vue` 同构,方向为 `right-0` + `translate-x-full`。关闭时 `invisible` 保证抽屉不在 a11y 树/Tab 序中。
3. `App.vue`:
   - 新增 `railOpen` / `infoOpen` 两个 `ref`,分别传入两个侧栏;
   - 中栏(聊天列)外包一层 `flex min-w-0 flex-1 flex-col`,顶部加窄视口开关条:`<div class="hidden shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5 max-console:flex">`,两个小按钮「工作区」「观测」(沿用 `rounded-sm border border-hairline px-2 py-1 font-mono text-[10px]`,激活态 `border-primary/50 text-primary`),各带 `aria-expanded`;
   - 遮罩:`v-if="railOpen || infoOpen"` 的 `fixed inset-0 z-30 bg-canvas/60 backdrop-blur-sm max-console:block hidden`,`@click` 同时关闭两者;
   - `window` keydown:`Escape` 且任一抽屉打开时关闭;关闭时把焦点还原到对应开关按钮(存 trigger ref,`isConnected` 守卫)。
4. 效果:<1100px 时两侧栏脱离文档流(fixed),聊天列占满剩余宽度,**永不为 0**;≥1100px 完全不变。320px 下 240px/288px 抽屉均可完整容纳。

**验证方式**:
- 无单测(jsdom 不实现媒体查询,响应式 CSS 无法单测),以浏览器实测为准(见「六、验收标准」)。
- 浏览器:1440px 三栏不变 → 缩至 1024px/800px/320px:聊天输入框始终可见可输入;开关条出现;点「工作区」抽屉滑出、背景遮罩、Esc/点遮罩关闭;`document.documentElement.scrollWidth === clientWidth`(无横向溢出)。

---

## 三、Phase 2(中优先级,按成本/收益排序)

> T4–T8 均为低风险静态属性/小逻辑改动,可任意顺序;建议按 4→5→6→7→8 执行(同属 a11y 语义补齐,一次心智上下文)。

### T4 表单 label 补齐(#6)

**目标文件**:`ChatPane.vue`(主输入框 + 驳回意见)、`WorkspacePickerModal.vue`(过滤框)、`ApiKeysPanel.vue`(2 个 key 输入)、`McpPanel.vue`(name/command/args/env)

**改动要点**:每个控件加 `<label class="sr-only" for="...">` + 对应 `id`(Tailwind v4 内置 `sr-only`):
- ChatPane:主 textarea `id="chat-input"`,label「消息输入」;驳回意见 input `id="reject-reason"`,label「驳回意见」。**placeholder 文案全部保留**(现有测试断言 placeholder,且降级为格式示例)。
- WorkspacePickerModal:过滤 input `id="ws-picker-filter"`,label「过滤目录」。
- ApiKeysPanel:`deepseek-key`/「DeepSeek API Key」、`anysearch-key`/「AnySearch API Key」。
- McpPanel:`mcp-name`/「名称」、`mcp-command`/「命令」、`mcp-args`/「参数」、`mcp-env`/「环境变量」(name 输入框是非 v-model 的 `:value`+`@input` 写法,加 id 即可)。

**验证方式**:
- 既有测试全绿(`McpPanel.test.ts` 用 `findAll('input')` 按索引取控件,label 不改变索引结构)。
- 浏览器 DevTools → Elements → Accessibility:各输入框可访问名称 = 真实 label 文案,不再是 placeholder。

### T5 折叠状态语义(#7)

**目标文件**:`apps/web/src/components/MessageBubble.vue`

**改动要点**:
- THINKING 折叠按钮加 `:aria-expanded="isThinkingBlockOpen(message, plan, block.key)"`;
- 工具行按钮加 `:aria-expanded="!block.tool.collapsed"`(默认展开=true,与现状一致);
- 展开内容 `<pre>` 保留原样(收起时从 DOM 移除,无需 aria-hidden)。

**验证方式**:
- 新增 `MessageBubble.test.ts`:断言两个按钮 `aria-expanded` 随点击在 true/false 间切换(thinking 需构造含 thinking 段的 UiMessage;tool 用 toggle 事件)。
- 浏览器:a11y 树中 THINKING/工具按钮出现 expanded 状态。

### T6 按压状态语义(#8)

**目标文件**:`apps/web/src/components/ChatPane.vue`

**改动要点**:
- MODEL/THINK 两组按钮各加 `:aria-pressed="...=== 当前值"`(model: `agent.config.value?.model === m.id`;think: `agent.config.value?.thinkingLevel === level`);
- 两个按钮簇容器加 `role="group"` + `aria-label`(「模型选择」/「思考级别」)。

**验证方式**:
- 扩展 `ChatPane.test.ts`:断言激活按钮 `aria-pressed="true"`、其余为 false。
- 浏览器:a11y 树可见 pressed 状态,不再仅靠颜色。

### T7 live region(#9)

**目标文件**:`ChatPane.vue`、`App.vue`

**改动要点**:
- ChatPane 消息滚动容器(`ref="scroller"`)加 `role="log" aria-live="polite"`;
- 连接错误条(App.vue `v-if="agent.connectionError.value"` 的 div)加 `role="alert"`;
- 发送错误 `v-if="sendError"` 的 `<p>` 加 `role="alert"`。

**验证方式**:
- 无新单测(jsdom 无真实播报;静态属性断言并入 T5/T8 的组件测试可选)。浏览器:DevTools a11y 树确认 role 存在。

### T8 skill 下拉 combobox 语义(#5)

**目标文件**:`apps/web/src/components/ChatPane.vue`

**改动要点**(键盘逻辑已存在,仅补语义,不动 `onKeydown`):
- textarea 加 `role="combobox"` `aria-autocomplete="list"` `aria-controls="skill-listbox"` `:aria-expanded="skillMenuOpen"` `:aria-activedescendant="skillMenuOpen && filteredSkills.length > 0 ? 'skill-opt-' + skillIndex : undefined"`;
- 下拉容器加 `id="skill-listbox"` `role="listbox"`;
- 每个选项按钮加 `role="option"` `:id="'skill-opt-' + i"` `:aria-selected="i === skillIndex"`;
- 「无可用 skill」空态 `<p>` 加 `role="status"`(可选,顺手)。

**验证方式**:
- 扩展 `ChatPane.test.ts`:输入 `/` 后断言 listbox 存在、`aria-activedescendant` 指向当前高亮项、方向键切换后跟随变化。
- 既有 12 个 ChatPane 用例(键盘/IME/占位符/点击)必须保持全绿——本次不改任何键盘行为。

### T9 元数据对比度 + 字号下限(#10 + #11)

**目标文件**:`WorkspaceRail.vue:76`、`InfoPanel.vue:183`、`WorkspacePickerModal.vue:363`、`ChatPane.vue:396`、`DagPanel.vue:207`

**改动要点**(全部为 token/字号替换,已核实目标位置):
- `WorkspaceRail.vue:76`「添加于」: `text-[10px] text-mute/70` → `text-[11px] text-mute`(全量 mute 合成 #8b949e on #101010 = 6.8:1,达 AA);
- `InfoPanel.vue:183` 工具时间戳:`text-[10px] text-mute/70` → `text-[11px] text-mute`;
- `WorkspacePickerModal.vue:363` 按键提示行:`text-[9px] ... text-mute/80` → `text-[11px] ... text-mute`;
- `ChatPane.vue:396` source 徽标:`text-[9px]` → `text-[10px]`;
- `DagPanel.vue:207` rounds 徽标:`text-[8px]` → `text-[10px]`(size-3.5 盒子内可容纳,加 `leading-none`);
- `WorkspacePickerModal.vue:274` 面包屑分隔符 `text-mute/50` 为装饰性,不动(记录不修)。

**验证方式**:
- 浏览器:DevTools 计算样式确认三处元数据为全量 `#8b949e`、字号 ≥11px;徽标 ≥10px。

### T10 标题大纲(#12)

**目标文件**:`PipelineHeader.vue`、`InfoPanel.vue`

**改动要点**:
- `PipelineHeader.vue` 品牌 `WORKFLOWS` 由 `<span>` 改为 `<h1>`(类名不变,页面级唯一 h1);
- `InfoPanel.vue` 5 处 `<h3 class="section-label">` 改为 `<p class="section-label">`(样式类不变;区块标题降为非标题元素,与报告给出的两条路径之一吻合);
- 大纲变为 h1(品牌)→ h2(空态「AGENT 控制台」),无跳级。

**验证方式**:浏览器 DevTools → Elements → Accessibility 树,标题层级完整、无 h3 孤悬。

### T11 消息列宽 + DAG 尺寸(#14 + #15)

**目标文件**:`ChatPane.vue`、`SubAgentModal.vue`、`DagPanel.vue`

**改动要点**:
- `ChatPane.vue` 消息列 `max-w-3xl` → `max-w-2xl`(≈672px,回落到 65-75ch);`SubAgentModal.vue` 同类 `max-w-3xl` 同步改(一致性);
- `DagPanel.vue` 节点 `w-14` → `w-12`(48px),连线 `w-5` → `w-3`(12px):总宽 4×48 + 3×12 + 6×8(mx-1) = 252px ≤ 面板内宽 256px,不再被压缩(实测 56→45.6px 的问题消除)。

**验证方式**:浏览器 1024px 视口下 DAG 节点按钮实测宽度 = 48px(设计值);消息列宽 ≤ 672px。

---

## 四、执行顺序与提交建议

```
Phase 1: T1 → T2 → T3   (每个任务一个 commit,可独立回滚)
Phase 2: T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11
```
- 每个任务完成后立即跑 `pnpm --filter @workflows/web test && pnpm --filter @workflows/web typecheck`,再进入下一个;
- 建议按 commit message 前缀 `fix(a11y):` / `fix(ui):` 区分;
- 总规模控制在 11 个任务、约 13 个源文件 + 3 个新测试文件,单次交付可完成;T1 是唯一有行为复杂度的任务,优先做、独立提交,便于出问题时单独回滚。

## 五、测试清单

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `src/composables/useModalDialog.test.ts` | **新增** | 挂载 harness(attachTo body):打开后焦点进入 dialog;Tab 到末位后循环回首;Shift+Tab 反向;Escape 触发 onClose;卸载后焦点还原到触发元素 |
| `src/components/WorkspaceRail.test.ts` | **新增** | 动作按钮在 DOM 且无 `hidden`;点「移除」先 `window.confirm`(true 才调 `removeWorkspace`;false 不调);按钮可聚焦 |
| `src/components/MessageBubble.test.ts` | **新增** | THINKING/工具按钮 `aria-expanded` 随点击切换 |
| `src/components/ChatPane.test.ts` | **扩展** | 输入 `/` 后:listbox/option 存在、`aria-activedescendant` 随 ArrowDown 移动;MODEL 按钮 `aria-pressed` 正确 |
| 既有 5 个测试文件 | 保持全绿 | `App` / `ChatPane` / `McpPanel` / `WorkspacePickerModal` / `useAgent` |

命令:`pnpm --filter @workflows/web test`(或 `cd apps/web && pnpm test`)、`pnpm --filter @workflows/web typecheck`、`pnpm --filter @workflows/web lint`。

## 六、验收标准(浏览器 http://localhost:15200)

**自动化**:`test` / `typecheck` / `lint` 全绿(含新增 3 个测试文件)。

**键盘走查(真实 Tab 按键)**:
1. 页面加载后 Tab 遍历:工作区行「读写/只读」「移除」按钮**无需 hover 即可到达**;
2. 打开设置模态窗:焦点进入对话框内;Tab 循环不逃逸到背景;Shift+Tab 反向;Escape 关闭且焦点回到「设置」按钮;
3. 打开「添加工作区」:焦点落在过滤输入框;输入框内 Tab 仍执行目录补全(不与焦点 trap 冲突);Escape 关闭;
4. 打开子代理模态窗(点击 DAG 节点/工具块):同上契约;
5. 聊天输入 `/`:方向键高亮在 a11y 树中可感知(aria-activedescendant);Tab/Enter 选中;Esc 关闭;输入框可访问名称 =「消息输入」;
6. THINKING/工具折叠按钮、MODEL/THINK 切换按钮在 a11y 树中有 expanded/pressed 状态。

**视口缩放(DevTools device toolbar / 缩窗口)**:
7. 1440px:三栏布局与现状一致(无回归);
8. 1100px 以下:顶部出现「工作区」「观测」开关条;聊天输入框始终可见、宽度 > 0;打开抽屉有遮罩,Esc/点遮罩关闭;关闭时抽屉不在 Tab 序中;
9. 320px:`document.documentElement.scrollWidth === clientWidth`(无横向滚动);主输入框 + 发送按钮可用;模型/思考切换行不溢出(wrap);
10. 1024px:DAG 节点按钮宽度 ≈48px 不再被压扁。

**视觉与对比度**:
11. 「添加于」日期、工具时间戳、按键提示行:计算样式为全量 `#8b949e`、字号 ≥11px(对比度 6.8:1);source/rounds 徽标 ≥10px;
12. 消息列宽 ≤672px;整体仍为 VoltAgent 视觉(近黑 + 电光绿 + hairline),无新增设计体系元素。

## 七、风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `inert` 浏览器兼容(2023 前浏览器不支持) | 背景仍可聚焦 | composable 内特性守卫(`'inert' in el`),焦点 trap 仍生效;现代浏览器全覆盖 |
| 焦点 trap 与 WorkspacePicker 的 Tab 补全冲突 | 目录补全失效 | trap 监听用 bubble 阶段 + `defaultPrevented` 短路;T1 单测覆盖该路径 |
| Escape 双重触发(输入框 + 文档级) | close 被调两次 | App 中 `v-if` 置 false 幂等,无害;不做特殊处理 |
| 抽屉方案影响桌面布局 | 三栏回归 | 全部响应式类带 `max-console:` 前缀,≥1100px 零变化;T3 独立 commit |
| Tailwind v4 自定义断点(`--breakpoint-console`)构建失败 | 变体不生成 | 降级方案:改用任意变体 `max-[1100px]:`(v4 原生支持),一行替换 |
| jsdom 无法测媒体查询/CSS | 响应式只能人工验证 | 已列入验收标准 7-10;单测只覆盖行为逻辑 |
| WorkspaceRail 结构重构(button 嵌套 button 修正) | 视觉/交互回归 | 动作行样式沿用现有按钮类;T2 单测 + 浏览器走查 1 |
| `role="log"` 流式播报过密 | 读屏噪音 | 维持报告建议的 `aria-live="polite"`;如实测噪音过大,可加 `aria-relevant="additions"`(一行) |

**回滚**:每任务独立 commit;出问题 `git revert <commit>` 即回退,不影响其他任务;T1 与 T3 是仅有的两个「行为新增」任务,优先单独验证。
