# 代码审查报告:workflows 前端 UI 重新设计

> 审查对象:02-plan-1.md(实施计划)vs 实际改动(执行报告 03-execution-1.md)
> 审查方式:只读静态核对(逐文件阅读 + 全量 grep 残留扫描 + 与探索报告基线对比)
> 审查环境限制:本环境无 shell,无法执行 `git diff` 与 `pnpm typecheck/lint/test/build`;已验证方式见 §4

## 结论:pass

---

## 1. 硬边界零改动核对(计划 §1「不做什么」)

| 边界 | 状态 | 说明 |
| --- | --- | --- |
| `apps/web/src/composables/useAgent.ts` | 通过 | 全文无任何新 token 痕迹(canvas/hairline/primary/text-ink 等 0 命中);核心函数完整:messageText/planBlocks/isThinkingBlockOpen/toolLabel/findToolSegment(行 54–127),SSE/AgentStore 逻辑在位;唯一 `signal` 命中为行 616 `abortController.signal`(DOM API,非样式 token) |
| `apps/web/src/utils/markdown.ts` | 通过 | walkTokens 转义 + renderMarkdown(行 21/48)保留,XSS 防线未动;无新 token 痕迹 |
| `packages/shared` | 通过 | 无 `#101010`/`#00d992`/`fontsource/inter`/`connectorClass` 等新内容命中 |
| `apps/api` | 通过 | 同上,0 命中 |
| 3 个测试文件(App.test.ts / WorkspacePickerModal.test.ts / useAgent.test.ts) | 通过 | 无新 token 痕迹;断言文案与计划 §5.5 冻结清单逐条命中(见 §5) |
| `apps/web/index.html` | 通过 | 标题「workflows · Agent 控制台」原样保留 |

> 注:无法执行 git diff 做字节级确认,以上基于「新内容零侵入」+「核心逻辑/文案完整在位」的静态证据,与执行报告 §1.3 一致。

## 2. 计划覆盖度(13 个计划文件 + token 体系)

### 2.1 新 token 体系落地(style.css)
- 颜色:canvas `#101010` / canvas-soft `#1a1a1a` / canvas-soft-2 `#202020` / hairline `#3d3a39` / ink `#f2f2f2`(新=文本)/ ink-strong `#ffffff` / body `#bdbdbd` / mute `#8b949e` / primary `#00d992` / primary-soft `#2fd6a1` / primary-deep `#10b981` / on-primary `#101010` / err `#f2555a` —— 与计划 §2.1 逐值一致 ✅
- 旧 token 全部删除:ink(旧背景)/panel/raised/edge/edge-soft/fg/dim/faint/signal/signal-dim/wire/wire-dim/ok 均无残留 ✅
- 字体:display/body = Inter 回退链、mono = JetBrains Mono ✅;main.ts 引入 inter 400/500/600/700 + jetbrains-mono 400/500,chakra-petch/instrument-sans 移除 ✅;package.json 增 `@fontsource/inter ^5.3.0`、删两旧字体包,lockfile 同步(仅剩 inter/jetbrains-mono)✅
- 圆角:xs 4px / sm 6px / md 8px;`rounded-full` 仅用于状态胶囊/状态点(grep 10 处均为此类)✅
- 阴影:glow / modal 定义 ✅;动效 keyframes(flow-pulse/breathe/msg-in/modal-in/caret-blink)+ prefers-reduced-motion + ::selection(primary 30%)+ :focus-visible(1.5px primary)全部保留 ✅

### 2.2 13 个文件逐项核对

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| style.css | 通过 | 全量重写符合 §2 |
| main.ts | 通过 | 字体按 §2.2 |
| App.vue | 通过 | 根容器 `bg-canvas font-body text-ink`;错误条 `border-err/40 bg-err/10 text-err`;挂载结构/v-if/onMounted 未动 |
| PipelineHeader.vue | 通过 | 绿方块 logo、节点/连线 primary、flow-dot 绿 glow `0 0 8px 1px primary 60%`、API/LINK pill、设置按钮 hairline;「离线」保留 |
| WorkspaceRail.vue | 通过 | 激活行 `border-l-2 border-l-primary` + canvas-soft、RO/RW pill、hover 操作 hairline 按钮、「添加工作区」绿色 outline |
| ChatPane.vue | 通过 | 头部/空状态(「AGENT 控制台」「配置 DeepSeek API KEY」实心绿)/闸门(批准实心绿、驳回红 outline + 意见输入)/textarea 14px/发送停止/MODEL·THINK 分段(激活 primary)/THINKING 折叠按钮;script 逻辑逐函数完整(approvePlan/rejectPlan/toggleThinking/toggleAllThinking/onToolClick/滚动吸附/Enter 发送) |
| MessageBubble.vue | 通过(1 处小偏差) | 入边竖线+端口点已删;块 = hairline + rounded-md;工具行命令行样式 + 绿/红点;caret 换绿;`:deep(.md)` 全部新 token(h1–h4 Inter、pre canvas-soft+primary-deep 左边条、链接 primary-deep、blockquote/表格/hr/strong/del/checkbox 全换);plan/caret/showCaretRow 逻辑未动。**小偏差:THINKING 展开 pre 缺计划要求的 `bg-canvas-soft`(见 §6-1)** |
| InfoPanel.vue | 通过 | 「观测 · OBSERVE」保留;section-label 10px Inter 600 mute;kv pill;metric 卡 rounded-md+hairline+canvas-soft;工具流行 hairline + 绿/红点;状态点 primary 脉冲 |
| DagPanel.vue | 通过 | 节点状态色 running=primary 脉冲/done=primary 降饱和/error=err/idle=hairline+canvas-soft;连线 `bg-hairline`(完成 primary/50);闸门节点/提示条 primary;轮次角标;`wireClass`→`connectorClass`(更名,行为不变,§7-2) |
| SubAgentModal.vue | 通过 | 面板 rounded-md+shadow-modal+hairline;标题 14px Inter;状态/关闭/折叠条/摘要·产物标签换新 token;实时/历史回看逻辑未动 |
| ApiKeyModal.vue | 通过 | 「连接 · CONNECT」保留;输入框 canvas-soft;保存实心绿;已配置绿点+primary;环境 footer |
| WorkspacePickerModal.vue | 通过 | 仅模板 class 换皮;「添加工作区 · SOURCE」「确认添加」「已在列表中」「无匹配目录」等文案全保留;script(segments/rows/filtered/onKeydown 全部按键/complete/goUp/enterOrConfirm/confirmAdd/dblclick/data-selected/onMounted)逐字节未动 |
| SessionSwitcher.vue | 通过 | 触发器/下拉 shadow-modal/激活行 primary 指示/删除 X/新建会话;window.confirm 删除确认、Escape/外点关闭逻辑保留 |

### 2.3 旧 token 残留扫描(计划 §5.3 清单)
对 `apps/web/src` 全量 grep:`bg-ink`、`text-fg`、`text-dim`、`text-faint`、`border-edge`、`bg-panel`、`bg-raised`、`signal`、`wire`、`--color-signal/wire/ok`、`chakra-petch`、`instrument-sans`、`shadow-2xl/xl/black`、`panel/`、`edge-soft` —— **0 命中**(唯一例外 useAgent.ts:616 的 `abortController.signal`,DOM API 误报,且该文件零改动)。`bg-ink→bg-canvas` 语义映射正确,无「旧背景 ink 被当作新文本 ink」的反转类错误。

## 3. 功能与交互保全抽查

- 思考块折叠:ChatPane.toggleThinking/toggleAllThinking、MessageBubble 的 isThinkingBlockOpen 调用、流式最后一块自动展开逻辑 —— 全部保留 ✅
- 闸门批准/驳回:approvePlan(「用户已批准计划,继续执行」)/rejectPlan(「用户驳回:…」)原样 ✅
- 目录选择器键盘交互:↑↓/Tab 补全/Enter/←·⌫/Esc/双击、data-selected、rows/filtered 计算 —— 逐行核对未动 ✅
- SSE 流式渲染:MessageBubble 的 plan computed(caret 跟随最后一个 text 块)、showCaretRow、planBlocks 合并 —— 未动 ✅
- 自动滚底/停止/RO-RW/会话删除 confirm/断连错误条 —— 全部在位 ✅

## 4. 验证复跑

本审查环境无 shell 工具,**无法独立复跑** `pnpm typecheck / lint / test / build`(亦无法执行 git diff)。依据:
- 执行报告 §2.2 声称 4 项命令 3/3 全绿(web 3 测试文件 15 用例 + api 191 用例);
- 静态证据与报告自洽:测试文件未动且断言文案在位、组件文案与测试断言一一对应、lockfile 与 package.json 一致、无残留 token 破坏类名命中、所有引用类名均有对应 token 定义(如 text-on-primary/caret-primary/bg-primary/[0.07]/border-l-primary 等 Tailwind v4 合法写法)。
- 建议在具备 shell 的环境做一次最终复跑确认,但不影响本审查结论。

## 5. 文案冻结核对(计划 §5.5)

- App.test.ts:`工作区 · SOURCE`、`AGENT 控制台`、`deepseek-v4-flash`→`v4-flash`、`观测 · OBSERVE`、`/repo/.workflows`、`配置 DeepSeek API KEY`、`离线`、`network down` —— 全部命中(行 65–90)✅
- WorkspacePickerModal.test.ts:`添加工作区 · SOURCE`、`C:`、`dev`、`../`、`node_modules/`、`.git/`、HOME、`确认添加`、`pkg-2/`、`pkg-10/`、`无匹配目录`、`已在列表中`、Tab 补全 value、`addWorkspace(HOME)`、close 事件 —— 全部命中 ✅
- useAgent.test.ts:无 UI 文案断言,不受影响 ✅

## 6. 问题清单(均为非阻塞小项)

| # | 文件/位置 | 问题 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | `MessageBubble.vue` THINKING 展开 `<pre>`(约行 141) | 计划 §4.3 要求展开 pre 带 `bg-canvas-soft text-body`;实际只有 `text-body`,缺背景类,展开后为 canvas 底、与正文/工具输出 pre 的层次感不一致 | 低(纯视觉层次) | 补 `bg-canvas-soft` 类 |
| 2 | `style.css` `--shadow-glow`(行 41) | token 已定义但全组件无消费点(计划 §2.6 用途为卡片 hover/激活 glow) | 低(未用 token,不影响验收) | 可在卡片/消息块 hover 时补 `hover:shadow-glow`,或接受保留备用 |
| 3 | `ApiKeyModal.vue` 两个 key 输入框(行 98/157 附近) | 字号为 `text-xs`(12px),计划 §2.3 输入框刻度为 14px(§4.5 表述「同 4.3」,4.3 为 13px 驳回输入) | 低(12px mono 与模态窗密度协调,原样保留) | 可不改;若严格对齐刻度可提至 13–14px |

## 7. 三处偏差评估

1. **`apps/web/package.json` 依赖变更(+@fontsource/inter,−chakra-petch/instrument-sans)**:合理且必要 —— 计划 §2.2 明确要求 main.ts 引入 Inter,不装包无法构建;lockfile 同步正确。**接受**。
2. **`DagPanel.vue` `wireClass` → `connectorClass`**:纯函数名更名,行为逐行等价,且满足计划 §5.3「wire 0 命中」清扫要求。**接受**。
3. **ChatPane 头部徽章保留中文「只读/读写」**(计划表述为 RO/RW pill):与左栏 RO/RW 英文 pill 并存属原 UI 既有差异;文案无测试断言,保留中文降低改动面,且探索报告确认原头部即中文徽章。**接受**。

## 8. 最终建议

**通过。**

13 个计划文件全部按改造点完成;新 token 体系(色值/字体/圆角/间距/阴影/动效)与计划逐值一致;旧 token 零残留;硬边界(useAgent/markdown/shared/api/3 测试/index.html)无侵入证据;交互逻辑与测试文案冻结清单完整保全;3 处偏差均合理。问题清单 3 项均为低影响视觉细节,不构成打回理由。唯一遗留事项:在具备 shell 的环境补跑一次 `pnpm typecheck && pnpm lint && pnpm test && pnpm build` 作最终确认。
