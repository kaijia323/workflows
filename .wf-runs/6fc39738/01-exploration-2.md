# 界面审查报告:Web Agent 控制台(better-interface · full 模式)

> 审查时间:本次运行;审查对象:`apps/web`(Vue 3.5 + Vite + Tailwind v4,VoltAgent 设计语言,`style.css` `@theme` token 单一来源);浏览器实测 `http://localhost:15200`(dev server 运行中,Chrome CDP)。
> 前置报告:`.wf-runs/6fc39738/01-exploration-1.md`(仓库结构/技术栈/模块清单,此处不重复)。

## Scope and Coverage

**模式**:`full`(六域全审,含空态/窄宽状态;finding 上限 15)。**范围**:控制台主界面(三栏布局 + 头部)+ 4 个模态窗 + 消息流组件 + 设置面板;后端 API 仅核对了与数据丢失相关的 `DELETE /workspaces/:id` 行为。

**技能加载**:`ui-skills-root` 协议 → better-interface(编排)+ 六个域技能全部通过 GitHub 源仓库(jakubkrehel/skills)加载,无缺失域。**技能获取方式说明**:本环境无 shell,`npx ui-skills get` 不可用,规则文件改为直接抓取 raw.githubusercontent.com 上的 SKILL.md 原文,内容与 registry 一致(已与 ui-skills.com 页面交叉核对)。

**验证方式**:源码逐文件阅读 + Chrome 实测(DOM snapshot / computed style / 真实键盘事件 / 视口缩放 / 几何测量)+ 手动对比度计算。未验证项见 Verification 节。

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | 全部组件源码 + 键盘实测(Tab 真实按键、模态窗焦点、aria 树快照) | 4 HIGH / 5 MEDIUM / 1 LOW |
| Layout | App.vue 布局 + 320/1024/1699px 三档视口实测 | 1 HIGH / 1 LOW |
| Writing | 全部界面文案 + 后端删除行为核对(数据丢失) | 1 HIGH |
| Typography | style.css 字号体系 + 全页 <11px 元素统计 | 1 MEDIUM / 1 LOW |
| Colors | `@theme` token 与实渲染配对的手动对比度计算 | 1 MEDIUM |
| UI | 圆角/描边/动效/reduced-motion 降级 | 1 LOW(其余进 restraint) |

## Findings

| # | Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | HIGH | Accessibility | `WorkspaceRail.vue:81-97` | 工作区行的「只读/移除」按钮 `class="absolute ... hidden gap-1 group-hover:flex"`,仅在鼠标 hover 时 `display:flex` | 改为常显(或 `group-focus-within:flex`),并保留键盘可达;至少给「移除」加 `window.confirm` | 实测:未 hover 时快照/a11y 树中不存在(display:none 不可聚焦),键盘用户永远无法切换读写或移除工作区;其中「移除」会删除该工作区全部会话文件(见 #3),隐藏即隐藏了一个破坏性操作。违反"native elements + full keyboard support + hit areas"原则 |
| 2 | HIGH | Accessibility | `ApiKeyModal.vue:21-27, 44-84`、`SubAgentModal.vue:60-64`、`WorkspacePickerModal.vue:226-232` | 三个模态窗均无 `role="dialog"`/`aria-modal`,无 focus trap,无背景 `inert`,无焦点还原;除 WorkspacePickerModal 输入框外无 Escape 处理 | 统一对话框契约:打开时移焦入内 + 背景 `inert` + Tab 循环 + 关闭后焦点还原 + Escape 关闭 + `role="dialog" aria-modal="true"` | 实测:打开设置模态窗后焦点仍留在背景 THINKING 按钮上;按 Tab 焦点直接落到遮罩后面的消息区按钮;按 Escape 无反应。键盘用户可在模态窗"背后"操作,焦点去向不可预测。违反"Trap and Restore Focus" |
| 3 | HIGH | Writing | `WorkspaceRail.vue:12-19, 94-97` + `apps/api/src/pi/piService.ts:690` | 「移除」按钮直接 `handleRemove(id)` → `DELETE /workspaces/:id`,无任何确认;后端 `cleanupWorkspaceSessions` 会 `rmSync(meta.sessionFile)` 并清理 sub/ 目录 | 移除前弹确认,文案明示"该工作区的会话历史将被永久删除";或改为先归档 | 实测核对后端:删除工作区 = 删除该工作区全部会话 JSONL(不可恢复)。同一组件库里 `SessionSwitcher.vue:135` 的会话删除用了 `window.confirm('删除后该会话的历史文件将被移除,不可恢复')`——同一后果,工作区路径却零确认,且该按钮还被 #1 隐藏。数据丢失风险 + 一致性破坏 |
| 4 | HIGH | Layout | `App.vue:22, 26-30`、`WorkspaceRail.vue:6 (w-60)`、`InfoPanel.vue:4 (w-72)`;全仓库唯一 @media 是 `style.css:161` 的 reduced-motion | 三栏固定宽度(240+288px 永不折叠),无任何响应式断点;根容器 `overflow-hidden` | 中档以下(≈<1100px)让侧栏折叠/变抽屉,或加 `min-width` 声明桌面范围;保证聊天列 ≥ 一个可用宽度 | 实测 320px 视口(viewport meta `width=device-width` 已声明窄屏意图):聊天区 getBoundingClientRect 宽度 = 0(主输入框完全消失),InfoPanel 右缘到 x=528 被 overflow-hidden 裁掉——主流程被隐藏,违反"Hold Structure Until It Breaks"与 WCAG 1.4.10 reflow |
| 5 | MEDIUM | Accessibility | `ChatPane.vue:382-401`(skill 下拉),全文件 0 个 aria 属性(已 grep 确认) | 下拉是 8 个平铺 `<button>`,高亮仅 `i === skillIndex ? 'bg-primary/10'`;无 `role="listbox"/"option"`、无 `aria-selected`、无 `aria-activedescendant`、textarea 无 `aria-expanded`/`aria-controls` | 补 listbox 语义与 `aria-activedescendant` 指向当前高亮项,输入框 `aria-expanded` | 实测输入 `/` 弹出 8 项菜单:键盘方向键可走通(代码 ChatPane.vue:128-156),但屏幕阅读器完全不知道菜单存在、也听不到当前选中项——纯视觉高亮。违反"Announce Dynamic Content"/APG combobox 模式 |
| 6 | MEDIUM | Accessibility | `ChatPane.vue:413`(聊天输入)、`ChatPane.vue:343`(驳回意见)、`WorkspacePickerModal.vue:302`(过滤)、`ApiKeysPanel.vue:76-79, 134-137`、`McpPanel.vue:384-405`(name/command/args/env) | 全部表单控件只有 placeholder,无 `<label>`;实测 a11y 树中 textbox 的可访问名称 = placeholder 文案 | 每个输入加可见/`sr-only` 的 `<label for>`,placeholder 降级为格式示例 | 主聊天框是应用最重要控件,其名称来自会消失的占位文案;输入后名称即失联,且「先在左侧选择一个工作区」这类状态提示被当作字段名朗读。违反"Label and Type Every Control" |
| 7 | MEDIUM | Accessibility | `MessageBubble.vue:85-95`(THINKING 折叠)、`MessageBubble.vue:119-133`(工具行) | 折叠按钮只含文本 + `<ChevronRight/ChevronDown>`,无 `aria-expanded`;展开态仅由 chevron 旋转(transform)与内容显隐表达 | 两个按钮加 `aria-expanded`,pre 内容区可加 `aria-hidden` 联动或保留 | 屏幕阅读器无法获知思考/工具内容当前展开还是收起,状态切换无宣告。违反"Accessible Names / states"原则 |
| 8 | MEDIUM | Accessibility | `ChatPane.vue:443-470`(MODEL/THINK 快速切换) | 两组按钮,激活态仅 `bg-primary/15 text-primary`(颜色+背景),无 `aria-pressed`,非 radiogroup | 加 `aria-pressed`(或 `role="radiogroup"` + `aria-checked` + 方向键) | 实测选中态在 a11y 树中无任何表达;屏幕阅读器听到的是一排平级按钮,无法得知当前模型/思考档位。违反"Don't Rely on Color Alone" |
| 9 | MEDIUM | Accessibility | `ChatPane.vue:261-264`(消息滚动区)、`App.vue:58-62`(连接错误条)、`ChatPane.vue:350-354`(发送错误) | 消息流容器无 `role="log"`/`aria-live`;错误条/错误文案无 `role="alert"` | 滚动容器 `role="log" aria-live="polite"`;连接错误条 `role="alert"` | 流式回复、连接失败、发送失败三类动态内容均无播报通道,读屏用户看不到新消息到达、也收不到故障提示。违反"Announce Dynamic Content" |
| 10 | MEDIUM | Colors | `WorkspaceRail.vue:76-77`(添加于日期)、`InfoPanel.vue:183`(工具时间戳)、`WorkspacePickerModal.vue:363`(按键提示) | `text-mute/70`、`text-mute/80`(即 #8b949e 70%/80% 不透明度)叠加在 #101010 上,字号 9-10px | 元数据提升到全量 `--color-mute`(6.8:1)或加大到 11-12px 并提亮 | 实测计算:70% 合成 ≈ #666c72 对 #101010 = 3.6:1,80% ≈ 4.4:1,均低于普通文本 AA 4.5:1,且字号 9-10px——最小字号 × 最低对比度同时落在时间/日期类元数据上。违反 WCAG 1.4.3 + 颜色域对比度规则 |
| 11 | MEDIUM | Typography | 全局字号体系(见 style.css @theme)+ `ChatPane.vue:396`(9px source 徽标)、`WorkspacePickerModal.vue:363`(9px 提示)、`DagPanel.vue:207`(8px rounds 徽标) | 实测全页 35 个元素字号 < 11px;10px 是元数据主力字号,最低 8px | 元数据下限提到 11-12px;8px/9px 徽标并入 10px 最低档 | 10px+0.2em 字距的中文/长路径在窄栏内辨识吃力,8-9px 已低于可读下限。违反 better-typography "Size and Contrast Floors"(rarely below 12px) |
| 12 | LOW | Accessibility | `ChatPane.vue:276-278`(空态 h2)、`InfoPanel.vue:34,46,77,100,126`(h3 区块标题) | 页面无 h1,首个标题是空态 h2,右侧观测面板直接是 5 个 h3 | 补一个页面级 h1(App 标题或"工作区"h2),或把 section-label 降为非标题元素 | 标题大纲从 h2/h3 开始且跨栏跳跃,读屏"按标题导航"时结构不完整。违反"Structure Is Navigation"(推荐一个 h1) |
| 13 | LOW | Writing | `SessionSwitcher.vue:119-121` | 会话条目只显示 `08-05 02:17` + `N msgs`,无名称/摘要 | 显示会话首条消息摘要或可命名 | 同一天多个会话无法区分,只能靠时间+消息数猜测;控制台风格可保留时间,但需第二信息维度 |
| 14 | LOW | Typography | `ChatPane.vue:296`(消息列 `max-w-3xl`) | 消息列 768px(≈85ch @13px),超出 60-75ch 行长上限 | `max-w-2xl`(≈672px)或加 `max-w-[65ch]` | 长回复跨行回找吃力;聊天场景影响略低,故 LOW |
| 15 | LOW | UI | `DagPanel.vue:81-160`(4 节点 + 3 连线) | 固定 w-14×4 + w-5×3 = 308px > 面板内宽 256px,flex 压缩按钮;实测节点按钮被压到 45.6px(设计 56px) | 节点改 `w-12`/连线改 `w-3`,或面板加宽到 w-80 | 签名 DAG 图被静默压扁,节点/状态点视觉密度失衡(同心圆角与对齐不受影响,仅尺寸挤压) |

## Considered but Rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| `PipelineHeader.vue:71-75`、`SessionSwitcher.vue:131` | 图标按钮(title-only)加 `aria-label` | `title` 已参与可访问名称计算(实测 a11y 树有名称),语义上合格;仅触摸场景不可发现,而该应用无触摸布局(#4 已覆盖更根本的问题)。不单列 |
| `style.css:64-66` | focus 环从 1.5px 加粗到 2px | 实测真实键盘 Tab 下 `:focus-visible` 命中,`1.5px solid #00d992` 对比 ≈10:1,清晰可见且符合品牌;2px 是建议起点而非硬性要求。拒绝 |
| 各按钮 | 加 `active:scale(0.96)` 按压反馈 | 该设计语言全局无按压缩放(统一用颜色/glow 过渡),单点引入会破坏一致性;属 better-ui 的"存在更佳"而非缺陷。拒绝 |
| `PipelineHeader.vue:110-130`(.flow-dot 用 `left` 属性动画)与 `style.css:73-87`(未使用的 `flow-pulse` keyframe) | 改 `transform` 动画、删死代码 | 仅 2 个 5px 光点、动画简单,性能影响可忽略;死 keyframe 无害。记录不修 |
| `SessionSwitcher.vue:135` | 用自定义确认对话框替换 `window.confirm` | 原生 confirm 可访问、文案清晰;自定义对话框反而引入 #2 的模态窗契约负担。保留 |
| 输入框 iOS 16px 放大问题(better-typography #15) | textarea 14px → 16px | 该应用在窄视口下聊天列宽度为 0(#4),iOS 场景本身不可用;先修 #4,此条随之消解。拒绝单列 |

## Verification

**通过(实测)**:
- `http://localhost:15200` Chrome 加载,真实数据(2 个工作区、历史消息、工具块)渲染正常;`lang="zh-CN"` 正确(index.html:7)。
- 真实键盘 Tab(CDP 按键):`:focus-visible` 命中,焦点环 `1.5px solid rgb(0,217,146)` 可见 → 焦点环通过。
- 模态窗焦点行为:打开设置后 `document.activeElement` 仍在背景(THINKING 按钮),Tab 一跳到遮罩后方,`Escape` 无效,`[role="dialog"]` 计数 0 → 确认 #2。
- 320px 视口:chat rect `{left:240, right:240, width:0}`、info rect 右缘 528(超视口被裁)、`scrollWidth===clientWidth`(overflow-hidden 掩盖)→ 确认 #4。
- 1024px 视口:chat 宽 496px 可用;DAG 按钮实测 45.6px → 确认 #15。
- Skill 下拉(输入 `/`):8 项、无任何 listbox/aria 属性 → 确认 #5。
- WorkspacePicker:输入框自动聚焦(通过);123 行条目为平铺 button,无 listbox 语义;提示行 9px → 确认 #6/#10/#11。
- WorkspaceRail hover 按钮:未 hover 时 `display:none` 且不在 a11y 树;hover 后出现 → 确认 #1。
- 对比度(手动计算,sRGB 线性化):`#8b949e@70%` 合成于 `#101010` = 3.6:1;`@80%` = 4.4:1;全量 `#8b949e` = 6.8:1;`#00d992` on `#101010` = 10.1:1;`#f2555a` on `#101010` = 5.6:1 → 确认 #10,其余 token 通过。
- `DELETE /workspaces/:id` 行为核对:`routes.ts:172` → `cleanupWorkspaceSessions` → `piService.ts:690 rmSync(sessionFile)` → 确认 #3 数据删除事实。

**Not verified**(不转化为 finding):
- 闸门批准/驳回完整流程(需真实 agent 运行,dev 下无密钥未触发);
- MCP 增删改/测试失败态、API 错误态渲染(仅代码审查);
- SessionSwitcher 下拉的真实键盘遍历(逻辑代码审查,`onKeydown`/`onDocClick` 已实现);
- 屏幕阅读器实际播报(NVDA/VoiceOver 未运行,aria 缺失项基于 DOM 树与规范判定)。

## Verdict

**Block** — 存在 4 条 HIGH(模态窗焦点管理、hover 隐藏的破坏性操作、无确认的数据删除、窄视口主流程消失)。

## 最值得优先修的 Top 5

1. **模态窗对话框契约**(#2,#5 联动):三个模态窗统一 `role="dialog"` + 背景 `inert` + 焦点 trap/还原 + Escape;顺带把 skill 下拉补成 combobox 语义——一次改动覆盖全部弹层键盘体验。
2. **工作区行操作重构**(#1 + #3):「只读/移除」常显(或 `focus-within` 显示),移除前加确认并明示"会话历史将永久删除"——当前是"隐藏按钮 × 无确认 × 真删文件"三重叠加。
3. **窄视口兜底**(#4):≥1100px 保持三栏,以下将 InfoPanel/WorkspaceRail 收为可开合抽屉(或声明桌面 `min-width`),保证聊天列永不为 0。
4. **表单标签与状态语义批量补齐**(#6/#7/#8/#9):label/aria-expanded/aria-pressed/live region 四件套,全部是低风险高杠杆的静态属性改动。
5. **元数据可读性**(#10/#11):`text-mute/70-80%` 提到全量 mute、9-10px 字号下限提到 11-12px——全局一处 token/一条规则同时解决对比度与字号两个问题。
