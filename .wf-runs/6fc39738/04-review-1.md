# 审查报告:UI 优化实施(36dd226..dee96cb,11 commits)

> 审查对象:`.wf-runs/6fc39738/02-plan-1.md`(批准范围)+ `01-exploration-2.md`(问题清单)+ `03-execution-1.md`(声称 11/11 完成)。
> 方法:逐文件读源码 + git 日志核对(11 个 commit 与报告一一对应)+ 构建产物 CSS 验证(dist/assets/index-eSSssFsH.css,经浏览器载入检索)+ 全部 8 个测试文件静态核对。
> 限制:本环境无 shell,无法实际执行 `pnpm test/typecheck/lint`;改为静态核对测试断言真实性 + 构建产物验证(见「验证方式说明」)。

## 结论:fail

(10 项任务核实通过;T4 有一处计划点未落实,且执行报告声称「全部加 label」与代码不符 → 按审查指令「执行报告与代码不符必须 fail」。缺口为一行级修复,打回执行即可,无需重做计划。)

---

## 一、逐条核对(11 项)

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| T1 模态窗对话框契约 | ✅ 通过 | `useModalDialog.ts`:onMounted 保存 restoreTarget、对 `root.parentElement.children` 兄弟节点置 inert(`'inert' in el` 特性守卫)、`root.focus()` + `initialFocus` 优先;document 级 keydown(**bubble 阶段 + `event.defaultPrevented` 短路**,与 WorkspacePicker Tab 补全不冲突);Escape → preventDefault + onClose;Tab/Shift+Tab 仅在首/末位(或焦点在 root 外)时 preventDefault 循环,中间位置放行浏览器默认;onBeforeUnmount 清 inert、移监听、`isConnected` 守卫还原焦点。三模态窗(ApiKeyModal / WorkspacePickerModal / SubAgentModal)遮罩均有 `role="dialog" aria-modal="true" tabindex="-1"` + 各自 aria-label;WorkspacePicker 传 `initialFocus: () => inputRef.value`(组件自身 onMounted 后注册,聚焦输入框行为保留);Escape 双重 close 幂等(与计划一致)。 |
| T2 工作区行常显 + 移除确认 | ✅ 通过 | `WorkspaceRail.vue`:**button 嵌套 button 已修复**(v-for 根改 `div.relative`,选中按钮为第一子元素,动作按钮移出为兄弟节点);动作行 `mt-1.5 flex gap-1 px-3 pb-1` 常显,无 `hidden`/`group-hover:flex`,无 `@click.stop`;`handleRemove` 先 `window.confirm('移除工作区后,其会话历史文件将被永久删除,不可恢复。确定移除?')`,文案与计划一字不差,且与 SessionSwitcher 范式一致。 |
| T3 窄视口响应式 | ✅ 通过 | `style.css` `@theme` 新增 `--breakpoint-console: 1100px`(唯一新 token,合理);WorkspaceRail/InfoPanel 根 aside `max-console:fixed inset-y-0 left/right-0 z-40 transition-[translate,visibility]` + open 时 `translate-x-0 visible`/关闭 `-translate-x-full(-translate-x-full/translate-x-full) invisible`,`tabindex="-1"` + watch open 收焦;App.vue `railOpen/infoOpen`、中栏外包 `flex min-w-0 flex-1 flex-col`、开关条 `hidden ... max-console:flex`(「工作区」「观测」+ `aria-expanded` + trigger ref)、遮罩 `v-if="railOpen \|\| infoOpen"` + `hidden max-console:block` + `@click="closeDrawers"`、window keydown Escape 关闭抽屉并还原焦点(isConnected 守卫)。**构建产物实测确认**:`@media not all and (width>=1100px)` 下生成全部 `max-console:` 工具类(visible/invisible/fixed/inset-y-0/left-0/right-0/z-40/block/flex/translate-x-*)且 translate 工具类用原生 `translate` 属性 → `transition-[translate,visibility]` 偏差(报告偏差 #1)属实且正确;≥1100px 全部类带 `max-console:` 前缀,桌面零变化;聊天列外包 min-w-0 永不为 0。 |
| T4 表单 label | ⚠️ **未完全完成** | 已落实:ChatPane `chat-input`/「消息输入」、WorkspacePickerModal `ws-picker-filter`/「过滤目录」、ApiKeysPanel `deepseek-key`/`anysearch-key`、McpPanel `mcp-name`/`mcp-command`/`mcp-args`/`mcp-env`,均为 `label.sr-only[for]` + id,placeholder 全部保留。**缺失:ChatPane 驳回意见 input `id="reject-reason"`(ChatPane.vue:342)没有对应的 `<label for="reject-reason">「驳回意见」`** —— 全文件仅 1 个 label(chat-input),grep 确认无第二个。执行报告声称 T4「ChatPane(chat-input/「消息输入」、reject-reason/「驳回意见」)全部加 label」与实际代码不符。该输入可访问名称目前仍回落为 placeholder。 |
| T5 折叠语义 | ✅ 通过 | MessageBubble:THINKING 按钮 `:aria-expanded="isThinkingBlockOpen(message, plan, block.key)"`;工具行按钮 `:aria-expanded="!block.tool.collapsed"`;pre 收起时从 DOM 移除(无需 aria-hidden),与计划一致。 |
| T6 按压语义 | ✅ 通过 | ChatPane MODEL/THINK 按钮 `:aria-pressed="agent.config.value?.model === m.id"` / `=== level`(全等);两个按钮簇容器 `role="group"` + `aria-label`(模型选择/思考级别)。 |
| T7 live region | ✅ 通过 | ChatPane 消息滚动容器 `role="log" aria-live="polite"`;App.vue 连接错误条 `role="alert"`;ChatPane 发送错误 `<p role="alert">`。 |
| T8 combobox 语义 | ✅ 通过 | textarea `role="combobox" aria-autocomplete="list" aria-controls="skill-listbox" :aria-expanded :aria-activedescendant`(仅菜单打开且有匹配时指向 `skill-opt-<i>`);下拉容器 `id="skill-listbox" role="listbox"`;选项按钮 `role="option" :id :aria-selected`;空态 `role="status"`。键盘逻辑(onKeydown)零改动,既有行为保留。 |
| T9 对比度 + 字号 | ✅ 通过 | WorkspaceRail「添加于」/InfoPanel 工具时间戳:`text-[10px] text-mute/70` → `text-[11px] text-mute`(全量 #8b949e on #101010 = 6.8:1);WorkspacePickerModal 按键提示 `text-[9px] text-mute/80` → `text-[11px] text-mute`;ChatPane source 徽标 `text-[10px]`;DagPanel rounds 徽标 `text-[10px] leading-none`(size-3.5 盒)。grep 确认 `text-mute/70`、`text-mute/80`、`text-[8px]`、`text-[9px]` 全仓库归零;`text-mute/50` 仅剩 WorkspacePickerModal.vue:289 面包屑分隔符(计划明确保留)。 |
| T10 标题大纲 | ✅ 通过 | PipelineHeader 品牌 span → `<h1>`(类名不变,页面级唯一 h1);InfoPanel 5 处 `h3.section-label` → `p.section-label`(grep 确认全仓库无 `<h3` 残留)。大纲:h1(品牌)→ h2(空态),无跳级。 |
| T11 列宽 + DAG | ✅ 通过 | ChatPane 与 SubAgentModal 消息列 `max-w-3xl` → `max-w-2xl`(≈672px);DagPanel 节点 `w-14` → `w-12`(48px)、连线 `w-5` → `w-3`(12px),总宽 252px ≤ 面板内宽;构建产物确认含 `w-12` 且无 `w-14`。ApiKeyModal 壳 `max-w-3xl` 未动(非消息列,符合计划)。 |
| 测试 | ✅ 通过 | 新增 3 文件:useModalDialog.test.ts(5 例:焦点入内/背景 inert 守卫/Tab 末位循环+中间放行/Shift+Tab 反向/Escape+卸载还原)、WorkspaceRail.test.ts(5 例:常显无 hidden/文案与 readOnly 对应/confirm true 调 removeWorkspace、false 不调/可聚焦)、MessageBubble.test.ts(2 例:aria-expanded 随点击切换)。ChatPane.test.ts 扩展 2 例(combobox 语义 + activedescendant 随 ArrowDown 移动、aria-pressed + role=group)。全部断言真实有效(非空断言,验证默认行为/焦点/属性值)。既有测试结构兼容性:McpPanel 测试按 `findAll('input')` 索引取控件,label 不改变 input 结构;WorkspacePickerModal 测试 `find('input')` 单输入;App 测试仅文本断言。**用例总数核对:2+16+17+6+14+5+5+2 = 67,与执行报告 67 完全一致**。 |
| 范围约束 | ✅ 通过 | git 日志 11 个 commit(36dd226→dee96cb)与报告逐条对应、顺序与计划一致;改动全部位于 apps/web/src;`style.css` 仅新增断点 token;未引入新设计体系、新色值(遮罩/开关条均用既有 token);apps/api、packages/shared 未在本次范围触碰。 |

---

## 二、问题清单

| # | 严重度 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| 1 | 中 | `apps/web/src/components/ChatPane.vue:342`(input `id="reject-reason"`) | **T4 未完全落实**。计划明确要求「驳回意见 input `id="reject-reason"`,label「驳回意见」」,但代码只有 id 无 label;全文件仅 chat-input 一个 label。执行报告 T4 条目声称「ChatPane(chat-input/「消息输入」、reject-reason/「驳回意见」)全部加 label」与代码不符。该输入可访问名称回落为 placeholder(输入内容后名称失联的原始问题在驳回框仍存在)。 | 在 input 前补一行:`<label for="reject-reason" class="sr-only">驳回意见</label>`(与 chat-input 同构);随后重跑 test/typecheck/lint。 |
| 2 | 低 | `apps/web/src/App.vue:57-62`(onWindowKeydown) | 罕见组合场景:窄视口下抽屉与模态窗同时打开时按 Escape,App 的 window 处理器会先关闭抽屉并把焦点还原到开关按钮(该按钮此时位于模态窗 inert 背景内,`focus()` 静默无效),随后模态窗自身处理器才关闭。结果仍正确(焦点最终还原到打开模态窗的按钮),无实际危害,但焦点还原顺序略绕。 | 可选:在 Escape 分支加 `if (railOpen.value && !showSettings && !showPicker && !subModal)` 守卫;或维持现状(幂等无害)。不阻塞。 |
| 3 | 低 | 执行报告「二、新增/扩展测试」 | 叙述偏差:报告(及计划)称「既有 12 个 ChatPane 用例」,实际基线为 14(基线 53 = App 2 + ChatPane 14 + McpPanel 17 + WorkspacePicker 6 + useAgent 14);总数 53→67 与报告一致,不影响结论,仅计数叙述不准确。 | 无修复必要;后续报告引用计数前先数一遍 `it(`。 |
| 4 | 信息 | — | 本审查环境无 shell,**未能实际执行** `pnpm --filter @workflows/web test / typecheck / lint`。已通过:静态核对全部 8 个测试文件(断言真实、结构兼容)+ 构建产物 CSS 实测(max-console 媒体查询、w-12、max-w-2xl、translate 属性均存在)交叉验证。 | 有 shell 的环境重跑三件套确认 67 用例全绿、`vue-tsc -b` 与 `eslint .` 零错误后再合入。 |

---

## 三、验证方式说明

- **git 范围**:`.git/logs/HEAD` 确认 36dd2264904f..dee96cb0edf 共 11 个 commit,消息与执行报告逐条一致。
- **构建产物**:`apps/web/dist/assets/index-eSSssFsH.css`(fff 索引不覆盖 gitignore 的 dist,改用浏览器载入检索):确认 `@media not all and (width>=1100px)` 下生成全部 `max-console:*` 工具类、`translate` 属性用法、`w-12` 存在且 `w-14` 不存在、`max-w-2xl` 存在 → 执行报告「构建验证」与偏差 #1 声明属实。
- **未验证项**:浏览器实测走查(计划六、验收标准 1-12)留待人工;`inert` 在现代浏览器的真实聚焦行为基于规范判定(jsdom 单测已覆盖守卫与逻辑分支)。

## 四、最终建议

**打回执行**(非打回重做计划):
1. 补 T4 遗漏:ChatPane.vue:342 reject-reason 的 sr-only label(一行);
2. 重跑 `pnpm --filter @workflows/web test`(67 用例)+ typecheck + lint;
3. 完成浏览器走查(验收标准 1-12)后可合入。

除 T4 一处遗漏外,其余 10 项任务实现完整、正确,无测试造假、无计划范围外改动,VoltAgent 设计语言保持(唯一新 token 为合理断点)。
