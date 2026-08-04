# 实施计划:workflows 前端 UI 重新设计(VoltAgent 视觉语言 + Warp 行式消息块)

> 产物目录:.wf-runs/d6a3b5b6
> 依据:01-exploration-1.md(项目现状)、01-exploration-2.md(设计候选,推荐 VoltAgent 9/10 + Warp 8/10 叠加)
> 设计参考:awesome-design-md `design-md/voltagent/DESIGN.md`(已精读,色值/字号直接取自该文件)
> 执行边界:只改 `apps/web` 表现层;**零改动** `packages/shared`、`apps/api`、`composables/useAgent.ts`、`utils/markdown.ts`、两个测试文件

---

## 1. 目标与范围

### 做什么
以 **VoltAgent** 视觉语言为主(近黑画布 `#101010`、单一电光绿 `#00d992` 强调色、1px hairline 分层、
4px 间距体系、Inter + JetBrains Mono 双字体、agent 状态徽标、6px 按钮 / 8px 卡片圆角、无阴影靠描边),
叠加 **Warp 行式消息块**思路(助手消息 = 行式块,块间 hairline 分隔,工具调用 = 命令行 + 展开式 code-mockup),
对 `apps/web` 全部 10 个组件 + `style.css` + `main.ts` 做表现层重构。保留「管线控制台」的 flow-dot / breathe /
caret 动效(换绿色、克制保留),弱化「节点端口入边」等隐喻(消息块不再画入边竖线)。

### 不做什么(硬边界)
- **不动数据契约与状态**:`useAgent.ts`(AgentStore 形状、UiMessage/PlanBlock、planBlocks 合并规则、
  思考块折叠持久化、toolRuns/subSessions/gateRequest)、`packages/shared`、`apps/api` 全部零改动。
- **不动交互逻辑**:闸门批准/驳回、流式渲染与自动滚底、思考块自动展开/收起(用户点击后以用户为准)、
  工具块点击开子代理模态窗、目录选择器全部键盘交互(↑↓/Tab/Enter/←·⌫/双击/Esc)、会话切换/新建/删除(window.confirm)、
  RO/RW 切换、断连错误条。
- **不动 XSS 防线**:`utils/markdown.ts` 的 marked 转义 + 链接协议白名单原样保留,`renderMarkdown` 调用方式不变。
- **不破坏测试断言文案**(见 §5.6 清单,默认全部保留;若个别文案确需调整,必须同步改对应测试并在验收时跑绿)。
- 不引入 vue-router / 组件库 / CSS-in-JS;不做移动端响应式;不做虚拟滚动;不新增组件(除可选的
  `PanelSection.vue` 提取,见 §4.10,可选且非必须)。

---

## 2. 新设计 token 体系定义(写入 `apps/web/src/style.css` 的 `@theme`)

### 2.1 颜色(角色语义映射,旧 → 新)

| 新 token | 值 | 旧 token(删除) | 语义 |
| --- | --- | --- | --- |
| `--color-canvas` | `#101010` | `--color-ink #0d1017` | 唯一页面底 |
| `--color-canvas-soft` | `#1a1a1a` | `--color-panel #141923`、`--color-raised #1b2230` | 输入框/代码块/悬停行/面板填充 |
| `--color-canvas-soft-2` | `#202020` | —(新增,派生) | hover 加深一档(列表行/卡片悬停) |
| `--color-hairline` | `#3d3a39` | `--color-edge #253041`、`--color-edge-soft #1c2431` | 1px 描边,唯一"边缘色";次级用 `hairline/60` 透明度 |
| `--color-ink` | `#f2f2f2` | `--color-fg #e8ecf3` | 主文本(略偏白降眩光) |
| `--color-ink-strong` | `#ffffff` | —(新增) | 高强调文本 |
| `--color-body` | `#bdbdbd` | `--color-dim #8a94a8` | 次级文本 |
| `--color-mute` | `#8b949e` | `--color-faint #5b6577` | 最低优先级文本(时间戳/注释) |
| `--color-primary` | `#00d992` | `--color-signal #f0a83c`、`--color-ok #3fbf74` | 唯一强调色:CTA/状态徽标/激活/运行/成功 |
| `--color-primary-soft` | `#2fd6a1` | `--color-signal-dim #b47a26` | ghost 按钮文字 / hover / focus 指示 |
| `--color-primary-deep` | `#10b981` | `--color-wire-dim #3d5f9e` | 正文内联链接、代码块左侧条 |
| `--color-on-primary` | `#101010` | —(新增) | 绿底按钮上的文字 |
| `--color-err` | `#f2555a` | `--color-err #e4574f`(微调提亮) | 驳回/失败/错误(自建,对齐新文本亮度体系) |
| ~~`--color-wire`~~ | 删除 | `#5c8bee` | 蓝色整体移除;原用途改 mute/hairline/primary-deep |

> ⚠️ **改名陷阱(必须注意)**:旧 `--color-ink` 是**背景**色,新 `--color-ink` 是**文本**色。
> 组件里旧 `bg-ink` → 新 `bg-canvas`;旧 `text-fg` → 新 `text-ink`。按 §2.1 角色表逐处替换,勿按名字机械替换。
> 同理旧 `bg-signal`(激活点)→ 新 `bg-primary`;旧 `text-signal` → 新 `text-primary`。

### 2.2 字体(改 `@theme` 值 + `main.ts` 引入)

| 新 token | 值 | 说明 |
| --- | --- | --- |
| `--font-display` | `"Inter", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif` | 大写标签/标题/按钮字(Inter 600 + tracking,即 VoltAgent eyebrow 风格) |
| `--font-body` | `"Inter", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif` | 正文 |
| `--font-mono` | `"JetBrains Mono", "Noto Sans Mono CJK SC", monospace` | 代码/路径/数字(SF Mono 的免费替代,VoltAgent 官方认可) |

`main.ts`:删除 `@fontsource/chakra-petch/*` 与 `@fontsource/instrument-sans/*` 引入,
新增 `@fontsource/inter/400.css`、`500.css`、`600.css`、`700.css`;保留 `@fontsource/jetbrains-mono/400.css`、`500.css`。
中文字符走 Noto Sans SC / 系统回退(现状同机制,风险低)。

### 2.3 字号刻度(统一落地为显式类,不重定义全局 `--text-*` 以免与 Tailwind 默认刻度冲突)

| 用途 | 值 | 现有值 → 新值 |
| --- | --- | --- |
| mono 元数据(时间/计数/路径小字) | 10px(`text-[10px]`) | 9–9.5px → 10px |
| 次级标签/说明 | 11px | 10–11px → 11px |
| 小节正文/空状态 | 12px | 11–12px → 12px |
| 聊天正文/消息 markdown | 13px | 13px 保持 |
| 输入框文字/按钮文字(VoltAgent body-sm) | 14px | 13px → 14px |
| 模态窗标题/会话头部 | 14px,Inter 600 + tracking 0.15em | 12px → 14px |
| section eyebrow 标签 | 10px,Inter 600,`tracking-[0.2em]`(密面板用;VoltAgent 营销页 14px/2.52px 不适配高密度) | 9–10px → 10px |
| 数字指标 | `tabular-nums` 保持,13px Inter 600 | 保持 |

### 2.4 圆角(重定义 `@theme` 的 `--radius-*`,全局生效)

| token | 值 | 用途 |
| --- | --- | --- |
| `--radius-xs` | 4px | 内联 code chip、极小状态点容器 |
| `--radius-sm` | 6px | 按钮、输入框、分段控制器(VoltAgent button/text-input) |
| `--radius-md` | 8px | 卡片、消息块、代码块、模态窗面板(VoltAgent card/code-mockup) |
| `rounded-full` | 9999px | **仅**内联状态徽标/胶囊(API 状态、RO/RW、LINK 等) |

### 2.5 间距(沿用 Tailwind v4 默认 4px 基准 `--spacing:0.25rem`,规范化落地)

- 块内边距统一为 4px 倍数:卡片 16–24px(`p-4`~`p-6`)、列表行 8–12px(`py-2`/`py-3`)、
  消息块 12–16px(`px-3.5`→`px-4`,`py-3`)、输入框 12px(`px-3 py-2` 及以上)。
- 三栏宽度保持:左 `w-60`、中 `flex-1`、右 `w-72`;栏间用 1px hairline(`border-r`/`border-l border-hairline`)。

### 2.6 阴影(替代现有 `shadow-xl`/`shadow-2xl shadow-black/*`)

| token | 值 | 用途 |
| --- | --- | --- |
| `--shadow-glow` | `0 0 15px rgba(0, 217, 146, 0.18)` | 卡片 hover / 激活的 inset-glow(VoltAgent Level 2 绿色化) |
| `--shadow-modal` | `0 20px 60px rgba(0,0,0,0.7), inset 0 0 0 1px rgba(148,163,184,0.1)` | 模态窗(VoltAgent Level 3) |

### 2.7 动效(保留现有 keyframes,只换色与微调)

| 动效 | 处置 |
| --- | --- |
| `flow-pulse` / `dot-flow`(管线流动光点) | **保留**,光点 `bg-primary` + 绿 glow(组件内 scoped 样式改色),时长 1.6s 不变 |
| `breathe`(运行呼吸) | 保留,`bg-primary` |
| `msg-in` / `modal-in` | 保留,180ms,`--ease-flow` 不变 |
| `caret-blink`(流式光标) | 保留,0.9s steps(2),光标 `bg-primary` |
| `prefers-reduced-motion` 全局降级 | 保留原块 |
| `::selection`、`:focus-visible` | 选中色 `primary 30%`、focus outline `1.5px solid primary` |

### 2.8 全局基础样式(style.css 非 @theme 部分)

- body:背景 `canvas`、文字 `ink`、`font-body`、antialiased 保留;
- 滚动条:thumb 用 `hairline`,hover 用 `mute`(原 edge/faint);
- 其余 keyframes 与媒体查询按 §2.7 调整。

---

## 3. 需要改动的文件清单(逐个,含改动性质)

| # | 文件 | 改动性质 | 内容摘要 |
| --- | --- | --- | --- |
| 1 | `apps/web/src/style.css` | **token 重定义(全量重写)** | §2 全部:颜色/字体值/圆角/阴影/动效色;基础样式、滚动条、选区、focus 同步换新 token;删除 signal/wire/ok 旧 token |
| 2 | `apps/web/src/main.ts` | 依赖变更 | 字体引入:去 chakra-petch + instrument-sans,加 inter 400–700 |
| 3 | `apps/web/index.html` | 不改 | 标题「workflows · Agent 控制台」保留 |
| 4 | `apps/web/src/App.vue` | 组件类名重写(结构不动) | 容器 `bg-ink text-fg` → `bg-canvas text-ink`;错误条 `border-err/40 bg-err/10 text-err` 沿用新 err token;三栏挂载结构、v-if 逻辑、onMounted 全不动 |
| 5 | `apps/web/src/components/PipelineHeader.vue` | 组件类名重写 + scoped 样式 | 品牌块绿方块;管线节点/连线换 primary;LINK/API 状态改 pill-tag;设置按钮 hairline;scoped `.flow-dot` 改绿 glow |
| 6 | `apps/web/src/components/WorkspaceRail.vue` | 组件类名重写 | 左栏 app-shell-row 化:激活行绿色左指示条 + canvas-soft 底;RO/RW 改 pill;「添加工作区」改绿色 outline(保留文案) |
| 7 | `apps/web/src/components/ChatPane.vue` | 组件类名重写 | 头部/空状态/闸门/输入区/分段控制器全换新 token;「批准执行」实心绿按钮、「驳回」红 outline;textarea 改 canvas-soft 输入框;空状态「AGENT 控制台」「配置 DeepSeek API KEY」文案保留 |
| 8 | `apps/web/src/components/MessageBubble.vue` | **组件类名重写 + 模板微调 + scoped `:deep(.md)` 重写** | 去掉助手消息「入边竖线 + 端口点」;消息块 = hairline + rounded-md;思考行改 mute 中性色;工具行 = 命令行样式;`:deep(.md)` 全部 var() 换新 token(标题 Inter、代码块 canvas-soft + primary-deep 左边条、链接 primary-deep);caret 换绿;plan/折叠/事件逻辑零改动 |
| 9 | `apps/web/src/components/InfoPanel.vue` | 组件类名重写 + scoped 样式 | section-label/kv/metric 换新 token;指标卡 rounded-md + hairline;状态点 primary;「观测 · OBSERVE」文案保留 |
| 10 | `apps/web/src/components/DagPanel.vue` | 组件类名重写 | 节点状态色:running=primary 脉冲、done=primary 降饱和、error=err、idle=hairline+canvas-soft;闸门节点/提示条 primary;「流程 · PIPELINE」文案保留 |
| 11 | `apps/web/src/components/SubAgentModal.vue` | 组件类名重写 | 面板 rounded-md + `shadow-modal` + hairline;标题/状态/关闭按钮换 token;MessageBubble 复用不变;摘要/产物标签 Inter 600 tracking |
| 12 | `apps/web/src/components/ApiKeyModal.vue` | 组件类名重写 | 面板同 11;两个 key 输入框改 canvas-soft 输入框;「保存」改实心绿按钮;已配置状态绿点 + primary 文字;「连接 · CONNECT」文案保留 |
| 13 | `apps/web/src/components/WorkspacePickerModal.vue` | 组件类名重写(仅视觉) | 面板同 11;面包屑/输入框/列表/匹配高亮/确认按钮换新 token;`modal-in` 保留;**键盘逻辑、rows 计算、data-selected、双击、refs 全部不动** |
| 14 | `apps/web/src/components/SessionSwitcher.vue` | 组件类名重写 | 触发器/下拉面板/行 hover/激活行/新建会话按钮换新 token;删除确认流程不动 |
| 15 | `apps/web/src/App.test.ts`、`WorkspacePickerModal.test.ts`、`useAgent.test.ts` | **不改**(文案全部保留) | 见 §5.6 断言清单 |
| 16 | `composables/useAgent.ts`、`utils/markdown.ts`、`packages/shared`、`apps/api` | **零改动** | 硬边界 |

> 可选(非必须):提取 `PanelSection.vue`(section 标题 + 内容插槽)统一右栏五个 section——若实施中觉得重复度过高再做;不做也不影响验收。

---

## 4. 三栏布局与各组件改造点(具体到类)

### 4.1 整体骨架(App.vue + 三栏容器)
- `App.vue` 根容器:`bg-ink font-body text-fg` → `bg-canvas font-body text-ink`。
- 三栏底色统一 `bg-canvas`;栏间分隔:`border-r border-hairline`(左栏右缘)、`border-l border-hairline`(右栏左缘);
  面板内次级区域用 `bg-canvas-soft/40`~`/60`(替代旧 `bg-panel/40`、`/60`)。

### 4.2 左工作区栏 WorkspaceRail(w-60)
- 标题行:「工作区 · SOURCE」`font-display text-[10px] font-semibold tracking-[0.2em] text-mute`(文案不变);计数 mono `text-mute`。
- 工作区行(VoltAgent `ex-app-shell-row`):
  - 激活:`bg-canvas-soft` + 左侧 2px `border-l-2 border-primary`(替代旧 1.5px 端口点)+ 名称 `text-ink`;
  - 非激活:`bg-transparent hover:bg-canvas-soft/60`,名称 `text-body group-hover:text-ink`;
  - 整体 `rounded-sm`;行高 `py-2.5` 保持。
- RO/RW 徽章 → pill-tag:`rounded-full border border-hairline px-2 py-px font-mono text-[10px]`,
  RO=`text-primary border-primary/40`,RW=`text-mute border-hairline`。
- 路径/日期:`font-mono text-[10px] text-mute`。
- hover 操作(读写切换/移除):`border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px]`,
  读写 hover `hover:border-primary/50 hover:text-primary`,移除 hover `hover:border-err/50 hover:text-err`。
- 底部「添加工作区」:绿色 outline 按钮(VoltAgent `button-ghost-green` 变体)
  `border border-primary/50 bg-primary/5 text-primary hover:bg-primary/10 rounded-sm`;下方 mono 说明 `text-mute`。

### 4.3 中聊天区 ChatPane + MessageBubble(核心)

**ChatPane 头部(h-12)**
- 激活指示 `size-2 border border-primary/70 bg-primary/30`;工作区名 `text-ink tracking-widest`;
  路径 `font-mono text-[10px] text-mute`;RO/RW pill 同上;`N msgs` mono `text-mute`。

**空状态**
- logo:外层 `size-14 border border-hairline bg-canvas-soft rounded-md`,内层绿方块 `border border-primary/50 bg-primary/10`,
  内点 `bg-primary`(去掉原 wire 蓝);
- 标题「AGENT 控制台」`font-display text-sm tracking-[0.25em] text-ink`(文案不变);
- 说明 `text-xs text-body`;
- 「配置 DeepSeek API KEY」→ **实心主按钮**(VoltAgent `button-primary`):
  `bg-primary text-on-primary rounded-sm px-5 py-2 font-display text-[11px] tracking-widest hover:bg-primary-soft`
  (文案不变,测试断言 `wrapper.text()` 命中)。

**消息列表容器**
- 保持 `mx-auto max-w-3xl flex flex-col gap-4`(VoltAgent 文档阅读列节奏)。

**MessageBubble 助手消息(Warp 行式块)**
- 删除模板中 `absolute left-2.5 top-0 h-full w-px bg-edge` 入边竖线与端口点(整个「入边」div 移除);
- 消息块:`border border-hairline bg-canvas rounded-md overflow-hidden`(VoltAgent `card-feature` chrome);
  error 状态 `border-err/40`。
- 三类片段(顺序、key、折叠状态、caret 逻辑**全部不动**):
  - **THINKING 行**:`border-t border-hairline/60`(首块无上边),行内 `font-mono text-[10px] tracking-wider text-mute`,
    chevron 旋转保留,hover `hover:bg-canvas-soft`;展开 pre `bg-canvas-soft text-body`(原 wire 蓝 → 中性,单强调色纪律);
  - **正文块**:`px-4 py-3`;`:deep(.md)` 重写(见下);
  - **工具调用行(Warp 命令行)**:状态点 `size-1.5 rounded-full bg-primary`(成功)/`bg-err`(失败);
    标签 `font-display text-[10px] tracking-widest text-body`;工具名 mono `text-mute`;右缘 `详情/收起` mono `text-mute`;
    展开输出 pre:`border-t border-hairline/60 bg-canvas-soft px-4 py-2.5 font-mono text-[11px] text-body`(error `text-err`);
- **用户消息**:`max-w-[85%] border border-hairline bg-canvas-soft rounded-md px-4 py-2.5`(原琥珀淡底 → 中性 canvas-soft);
- 页脚(模型/token):`font-mono text-[10px] text-mute`;错误条 `text-err`;流式光标 `.caret` 改 `background: var(--color-primary)`。

**:deep(.md) markdown 样式重写(MessageBubble scoped)**
| 元素 | 新样式 |
| --- | --- |
| h1–h4 | `font-family: var(--font-display); font-weight: 600; color: var(--color-ink)`;h1 下边线 `border-bottom: 1px solid var(--color-hairline)` |
| pre 代码块 | `background: var(--color-canvas-soft); border: 1px solid var(--color-hairline); border-left: 2px solid var(--color-primary-deep)`(原 wire-dim 左边条 → primary-deep);`font-family: var(--font-mono); font-size: 12px; color: var(--color-body)` |
| 行内 code | `background: var(--color-canvas-soft); border-radius: 4px; color: var(--color-ink)` |
| a 链接 | `color: var(--color-primary-deep); text-decoration-color: var(--color-primary-deep)`;hover `color: var(--color-primary)` |
| blockquote | `border-left: 2px solid var(--color-primary-deep/60); color: var(--color-body)` |
| hr | `border-top: 1px solid var(--color-hairline)` |
| table th/td | `border: 1px solid var(--color-hairline)`;th `background: var(--color-canvas-soft); font-family: var(--font-display)` |
| strong | `color: var(--color-ink)`;del `color: var(--color-mute)` |
| checkbox | `accent-color: var(--color-primary)` |

**ChatPane 输入区**
- 容器:`border-t border-hairline bg-canvas px-5 pb-3.5 pt-3`(原 `bg-panel/60`)。
- **闸门条**:`border border-primary/50 bg-primary/5 rounded-md px-4 py-3`;Pause 图标格 `border-primary/70 bg-primary/10 text-primary`;
  「计划待批准」`text-primary tracking-[0.2em]`;planFile mono `text-mute`;
  - 「批准执行」→ **实心绿**:`bg-primary text-on-primary rounded-sm px-4 py-1.5 font-display text-[10px] tracking-widest hover:bg-primary-soft disabled:opacity-40`;
  - 驳回意见输入 → text-input:`bg-canvas-soft border-hairline rounded-sm px-3 py-1.5 text-[13px] text-ink placeholder:text-mute focus:border-primary`;
  - 「驳回」→ 红 outline:`border-err/60 text-err rounded-sm px-3 py-1.5 hover:bg-err/10`。
- textarea → text-input:`bg-canvas-soft border-hairline rounded-sm px-4 py-2.5 text-[14px] text-ink placeholder:text-mute focus:border-primary`。
- 「发送」→ 实心绿(同批准按钮);「停止」→ 红 outline。
- MODEL/THINK 分段:外层 `flex gap-px border border-hairline bg-canvas-soft p-px rounded-sm`;
  激活段 `bg-primary/15 text-primary`,非激活 `text-body hover:text-ink`;标签 `text-mute tracking-[0.2em]`(原 wire 蓝激活 → primary)。
- 「THINKING 折叠/展开全部」:hairline 按钮 `text-mute hover:text-ink`。
- 未配 key 提示:`text-primary/90` + 绿脉冲点(原 signal)。

### 4.4 右观测栏 InfoPanel + DagPanel(w-72)

**InfoPanel**
- 标题「观测 · OBSERVE」`text-mute`(文案不变);五个 section 标签 `.section-label` → `font-display(Inter) 600 10px tracking-[0.2em] text-mute`;
- 工作区信息:名称 `text-ink text-[13px] font-medium`;路径 mono `text-mute`;kv 徽章 → pill(`rounded-full border-hairline px-2 py-px font-mono text-[10px]`,RO `text-primary`/RW `text-mute`);
- 会话 dl:键 `text-mute`、值 `text-body`,mono 11px;状态点:流式 `bg-primary animate-pulse`、空闲 `bg-primary/60`;
- 用量指标卡 `.metric` → `border border-hairline bg-canvas-soft rounded-md p-2 flex flex-col gap-0.5`;
  label mono `text-mute`;value `font-display 600 text-[13px] text-ink tabular-nums`;成本行 mono `text-mute`;
- 工具流行:`flex items-center gap-2 border border-hairline/60 bg-canvas-soft/60 rounded-sm px-2 py-1`,
  状态点 `bg-primary`/`bg-err`,标签 `text-body`,工具名/时间 mono `text-mute`;
- 系统 dl:同上键值对。

**DagPanel**
- 容器:`border-b border-hairline bg-canvas px-4 py-3`;标题「流程 · PIPELINE」`text-mute`(文案不变);
- 节点状态(7px 方块 + 内点):
  - running:`border-primary bg-primary/10`,点 `bg-primary animate-pulse`;
  - done:`border-primary/40 bg-primary/5`,点 `bg-primary/80`;
  - error:`border-err/60 bg-err/5`,点 `bg-err`;
  - idle:`border-hairline bg-canvas-soft`,点 `bg-mute`;
  - 节点文字 `font-display text-[10px] tracking-wider text-body`;
- 连线 `bg-hairline`(完成 `bg-primary/50`);闸门节点:待批准 `border-primary bg-primary/15 text-primary`,否则 `border-hairline text-mute`;
- 闸门提示条:`border-primary/40 bg-primary/5 text-primary`;引导文案 mono `text-mute`;
- 审查轮次角标:`border-hairline bg-canvas text-mute`;ArrowLeftRight `text-mute`。

### 4.5 三个模态窗(统一 chrome)
- 遮罩:`fixed inset-0 z-50 grid place-items-center bg-canvas/80 backdrop-blur-sm`(原 `bg-ink/80`);
- 面板:VoltAgent `ex-modal-card` 规范:
  `border border-hairline bg-canvas rounded-md shadow-modal`(替代 `shadow-2xl shadow-black/*`),
  WorkspacePicker 保留 `modal-in` 动画与 `w-[620px] max-w-[94vw]`;
- 标题:Inter 600 `text-[14px] tracking-[0.15em] text-ink`;关闭按钮 hairline + hover err;头部下边线 `border-hairline`。

**ApiKeyModal**
- 两个 section 标签 `font-mono text-[10px] tracking-wider text-mute`;说明文字 `text-xs text-body`;
- 输入框:text-input(同 4.3);「已配置(可覆盖)」:绿点 + `text-primary`;「未配置」`text-mute`;
- 「保存」→ 实心绿(两个都是本模态主操作);「关闭」hairline ghost;
- 环境信息 footer:mono `text-mute`,值 `text-body`。

**WorkspacePickerModal(交互零改动,仅换皮)**
- 面板:`modal-in w-[620px] max-w-[94vw] border border-hairline bg-canvas rounded-md shadow-modal`;
- 标题「添加工作区 · SOURCE」保留(测试断言);
- 面包屑:`❯` chevron `text-primary`;祖先段 `text-mute hover:text-primary`;当前段 `text-ink`;分隔符 `text-mute/50`;
- 输入框:text-input + `caret-primary focus:border-primary`;
- 列表容器:`h-[264px] overflow-y-auto border-y border-hairline bg-canvas p-1`;
- 行:`flex w-full items-center gap-1.5 border-l-2 px-3 py-[5px] font-mono text-[12px] rounded-sm`,
  选中 `border-primary bg-primary/[0.07] text-ink`(原 `border-signal bg-signal/[0.07]`)、普通 `border-transparent hover:bg-canvas-soft`;
  匹配高亮段 `text-primary`(原 signal);尾斜杠 `text-primary-deep/70`(原 wire/70);隐藏目录/`../` `text-mute`;
- 底部路径 mono `text-mute`;按键提示 `text-mute/80`;「确认添加」→ 实心绿 / 「已在列表中」`border-primary/50 text-primary bg-primary/5`;
- 错误行 `text-err`。**保留:`data-selected`、所有 keydown handler、rows/filtered 计算、双击、confirmAdd、onMounted 加载。**

**SubAgentModal**
- 面板:`max-h-[85vh] w-full max-w-3xl flex flex-col border border-hairline bg-canvas rounded-md shadow-modal`;
- 标题:绿方块 logo + 代理名 `text-ink tracking-[0.2em]` + callId mono `text-mute`;
  状态:「运行中」`● text-primary`、「失败」`text-err`、「完成」`text-mute`;关闭按钮 hairline;
- THINKING 全局折叠条:同 ChatPane 的 hairline 按钮;
- 内容区复用 MessageBubble(自动继承新样式);「摘要」/「产物」标签 `font-display(Inter) 600 10px tracking-[0.2em] text-mute`,
  正文 `text-xs text-body`、artifact mono `text-mute`。

### 4.6 顶栏 PipelineHeader
- 容器:`relative z-10 flex h-12 shrink-0 items-center gap-4 border-b border-hairline bg-canvas/80 px-4 backdrop-blur`;
- 品牌:绿方块 logo(`size-6 grid place-items-center border border-primary/60 bg-primary/10 rounded-sm`,内点 `bg-primary`)
  + 「WORKFLOWS」`font-display text-sm font-semibold tracking-[0.18em] text-ink` + 「AGENT CONSOLE」mono `text-mute`(xl 显示);
- 管线节点:源/处理/观测方块同上节 DAG 状态色(running 用 primary);连线 `bg-hairline`,流动光点 `bg-primary`(scoped `.flow-dot` box-shadow 换绿);
- 设置按钮:`grid size-6 place-items-center border border-hairline rounded-sm text-body hover:border-primary/50 hover:text-primary`;
- 「LINK」mono `text-mute`;API 状态 → **pill-tag**:`rounded-full border px-2 py-0.5 font-mono text-[10px]`,
  在线 `border-primary/40 text-primary`(点 `bg-primary`),离线 `border-err/40 text-err`(点 `bg-err`)。

### 4.7 会话切换器 SessionSwitcher
- 触发器:`flex items-center gap-1.5 border border-hairline rounded-sm px-2 py-1 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary`;
- 下拉:`absolute right-0 top-full z-20 mt-1.5 w-60 border border-hairline bg-canvas rounded-md shadow-modal`(替代 shadow-xl);
- 头部「会话 · SESSIONS」`text-mute`;行 `hover:bg-canvas-soft`,激活 `bg-primary/[0.06]` + 时间 `text-primary` + 右侧绿方块指示;
- 删除 X `text-mute hover:text-err`;「新建会话」`text-primary hover:bg-primary/10 border-t border-hairline`;错误行 `text-err`。

### 4.8 动效保留清单(实施时逐项确认)
- `flow-dot`(PipelineHeader scoped):点 `bg-primary`,glow `0 0 8px 1px color-mix(in srgb, var(--color-primary) 60%, transparent)`,1.6s 不变;
- `breathe`(Picker 读取中、运行节点):`bg-primary`;
- `msg-in`/`modal-in`、`caret-blink`、`prefers-reduced-motion`:原样保留。

---

## 5. 实施顺序(依赖关系)与验收清单

### 5.1 实施顺序(6 步,每步可独立提交)

| 步 | 内容 | 文件 | 预期结果 |
| --- | --- | --- | --- |
| 1 | token 体系落地 | `style.css`(§2 全量)、`main.ts`(字体) | `pnpm dev` 能起;页面整体变近黑 + 绿色强调(部分组件仍是旧类名,可能出现类名未命中 → 属预期中间态) |
| 2 | 骨架与外围 | `App.vue`、`PipelineHeader.vue`、`WorkspaceRail.vue`、`InfoPanel.vue`、`DagPanel.vue` | 顶栏/左右栏完成新视觉;中栏聊天暂时新旧混合 |
| 3 | 聊天核心 | `MessageBubble.vue`(含 `:deep(.md)`)、`ChatPane.vue`、`SessionSwitcher.vue` | 消息块/Warp 行式渲染/闸门/输入区完成;流式与折叠逻辑验证正常 |
| 4 | 模态窗 | `ApiKeyModal.vue`、`WorkspacePickerModal.vue`、`SubAgentModal.vue` | 三模态完成;目录选择器键盘交互回归通过 |
| 5 | 清扫 | 全仓 grep 旧 token(见 5.3)、`index.html` 确认 | 无 `signal|wire|bg-ink(旧)|text-fg|text-dim|text-faint|border-edge|bg-panel|bg-raised|--color-signal` 残留(新语义的 `text-ink` 除外) |
| 6 | 全量验证 | — | `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全绿;手动清单(5.4)通过 |

> 依赖说明:步骤 1 是全部后续的前置;步骤 3 的 MessageBubble 须先于步骤 4 的 SubAgentModal(后者复用前者);
> 步骤 2 与 3 可并行,但建议按序提交便于定位回归。

### 5.2 验证命令
```bash
pnpm typecheck   # vue-tsc 严格检查
pnpm lint        # ESLint
pnpm test        # Vitest:App.test.ts + WorkspacePickerModal.test.ts + useAgent.test.ts
pnpm build       # shared → web 构建
pnpm dev         # 15200 手动验证
```

### 5.3 旧 token 残留检查(grep 清单)
对 `apps/web/src` 执行(每项应 0 命中,除新语义的 `text-ink`):
`bg-ink`(旧背景用法)、`text-fg`、`text-dim`、`text-faint`、`border-edge`、`bg-panel`、`bg-raised`、
`signal`、`wire`、`--color-signal`、`--color-wire`、`--color-ok`、`chakra-petch`、`instrument-sans`。

### 5.4 手动验收清单(dev 环境,逐条打勾)
- [ ] 三栏渲染:左 w-60 / 中 flex-1 / 右 w-72,栏间 1px hairline,全站近黑 `#101010`;
- [ ] 全站唯一彩色强调为绿 `#00d992`(err 红除外),无琥珀/蓝色残留;
- [ ] 顶栏管线:flow-dot 绿色流动、运行节点绿色呼吸、API 状态为 pill 徽标;
- [ ] 左栏:激活工作区行绿色左指示条;RO/RW pill;hover 显示读写/移除;
- [ ] 空状态:「AGENT 控制台」「配置 DeepSeek API KEY」(实心绿按钮)文案与样式正确;
- [ ] 聊天:助手消息为 hairline 圆角块(无入边竖线);THINKING 折叠/展开正常(流式最后一块自动展开、结束自动收起、手动点击后以用户为准);
- [ ] 工具行:命令行样式 + 绿/红状态点;点击有子会话/run 时开 SubAgentModal,否则展开输出;
- [ ] 流式:光标绿色闪烁跟随、自动滚底、停止按钮可用;SSE 三种片段交错渲染顺序正确;
- [ ] 闸门:待批准条出现;「批准执行」实心绿、驳回意见输入 + 红「驳回」,流程可走通;
- [ ] MODEL/THINK 分段切换正常,激活段绿色;
- [ ] 目录选择器:↑↓/Tab 补全/Enter/←·⌫/双击/Esc 全部正常;匹配段绿色高亮;「确认添加/已在列表中」正确;
- [ ] 会话切换器:切换/新建/删除(window.confirm)正常;
- [ ] 右栏:五个 section 新样式;用量指标卡、工具流、DAG 状态色正确;
- [ ] 模态窗:ApiKey 保存反馈、SubAgent 历史回看与产物、关闭/Esc 行为正常;
- [ ] 断连错误条显示「离线」与错误信息;
- [ ] `prefers-reduced-motion` 下动效降级正常;focus-visible 绿色 outline。

### 5.5 测试断言文案保护清单(默认不改,若改必须同步测试)
- `App.test.ts`:`工作区 · SOURCE`、`AGENT 控制台`、`deepseek-v4-flash`.replace('deepseek-','')、
  `观测 · OBSERVE`、`/repo/.workflows`、`配置 DeepSeek API KEY`、`离线`、`network down`;
- `WorkspacePickerModal.test.ts`:`添加工作区 · SOURCE`、`C:`、`dev`、`../`、`node_modules/`、`.git/`、HOME、
  `确认添加`、`pkg-2/`、`pkg-10/`、`无匹配目录`、`已在列表中`、输入 value `node_modules`、`addWorkspace(HOME)`、close 事件;
- `useAgent.test.ts`:无 UI 文案断言(已核实),不受影响。

---

## 6. 风险与回退策略

| 风险 | 概率/影响 | 缓解与回退 |
| --- | --- | --- |
| 旧 token 机械替换出错(`bg-ink` 背景 vs `text-ink` 文本语义反转) | 中/高 | §2.1 角色映射表逐处对照;步骤 5 的 grep 清扫兜底;替换以「语义」为准,不以名字为准 |
| 大面积类名重写遗漏导致部分组件样式错乱 | 中/中 | 每步独立 git 提交;任一步异常 `git revert` 该提交即可,不影响其余 |
| WorkspacePickerModal 交互回归(键盘/选中/双击) | 低/高 | 该文件只允许改 class,禁止触碰 script;`WorkspacePickerModal.test.ts` 6 个用例全量覆盖;手动清单 5.4 复查 |
| 测试文案断言被误改 | 低/高 | §5.5 清单冻结;`pnpm test` 是验收硬门槛;确需改文案时必须同提交改测试 |
| 流式渲染正确性回归(planBlocks/折叠/caret) | 低/高 | MessageBubble 只动 template class 与 `:deep(.md)`;plan 计算、事件、`caret` 元素结构保留;useAgent.test.ts 覆盖合并逻辑 |
| 字体切换后中文混排观感(Inter 无 CJK) | 中/低 | 回退链含 Noto Sans SC/PingFang;若观感差,保留 Instrument Sans 仅作中文回退(改 `--font-body` 值即可,一行回退) |
| marked/XSS 防线被绕过 | 低/高 | `utils/markdown.ts` 零改动;`renderMarkdown` 调用方式不变 |
| 单绿强调下「运行中/成功/批准」同色难区分 | 低/低 | 靠亮度层级区分:running=primary 实心+脉冲、done=primary/40~80、批准=实心绿按钮;err 红保留 |
| 高密度字号调整(9→10px 等)撑破布局 | 低/低 | 字号刻度集中在 10–14px;若溢出仅调个别行高/内边距,不动 token |

**总回退方案**:本计划全部改动限于 `apps/web/src` 下 14 个文件(13 改 + 1 不动),
逻辑层(`useAgent.ts`/`markdown.ts`/测试/契约/API)零改动;任一时间点 `git checkout -- apps/web/src/<文件>` 或 revert 对应步骤提交即可完整回退到旧视觉,且功能不受任何影响。

---

## 7. 摘要(最终回复要点)

- **方向**:VoltAgent(近黑 `#101010` + 电光绿 `#00d992` 单强调 + hairline 分层 + 4px 体系 + Inter/JetBrains Mono)+ Warp 行式消息块(助手消息 = hairline 圆角块,工具 = 命令行 + code-mockup 展开);
- **范围**:`apps/web` 表现层 13 个文件重写(style.css 全量 token、main.ts 字体、10 组件类名重写),逻辑/数据/测试零改动;
- **顺序**:token → 骨架(顶栏/左右栏)→ 聊天核心(MessageBubble/ChatPane)→ 模态窗 → grep 清扫 → 全量验证;
- **验收**:typecheck/lint/test/build 全绿 + 手动清单 5.4(16 项)+ 测试断言文案冻结(§5.5);
- **回退**:按步骤独立提交,单步 revert 即可;逻辑层零改动保证功能无损。
