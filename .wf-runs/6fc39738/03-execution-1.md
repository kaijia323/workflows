# 执行报告:UI 与体验优化(apps/web)

> 依据计划:`.wf-runs/6fc39738/02-plan-1.md`;审查报告:`.wf-runs/6fc39738/01-exploration-2.md`
> 执行范围:全部 11 个任务(Phase 1:T1-T3;Phase 2:T4-T11),改动全部在 `apps/web/src`,未触碰 `apps/api` / `packages/shared` / `index.html`。

---

## 一、任务完成情况

### Phase 1

| 任务 | 完成 | 说明 |
| --- | --- | --- |
| T1 模态窗对话框契约 | ✅ | 新建 `composables/useModalDialog.ts`:onMounted 保存焦点目标、对 root 兄弟子节点设 `inert`(带 `'inert' in el` 特性守卫)、移焦入内(`initialFocus` 优先);document 级 keydown(**bubble 阶段 + `defaultPrevented` 短路**,与 WorkspacePicker Tab 补全不冲突):Escape → onClose,Tab/Shift+Tab 在 root 内可聚焦元素间循环;onBeforeUnmount 清除 inert、移除监听、焦点还原(`isConnected` 守卫)。三个模态窗(ApiKeyModal / WorkspacePickerModal / SubAgentModal)遮罩加 `role="dialog" aria-modal="true" tabindex="-1"` + 各自 aria-label,并接入 composable;WorkspacePicker 传 `initialFocus: () => inputRef.value` 保留「打开即聚焦输入框」;其输入框 Escape 分支保留(双重 close 幂等)。 |
| T2 工作区行常显动作 + 移除确认 | ✅ | `WorkspaceRail.vue` 重构,修复非法 HTML(button 嵌套 button):v-for 根改为 `<div class="relative">`,选中按钮保留为第一个子元素;动作按钮移出为兄弟节点,改常显动作行 `mt-1.5 flex gap-1 px-3 pb-1`(去掉 `hidden group-hover:flex` 与 `@click.stop`);`handleRemove` 加 `window.confirm('移除工作区后,其会话历史文件将被永久删除,不可恢复。确定移除?')`(与 SessionSwitcher 范式一致,文案明示永久删除)。 |
| T3 窄视口响应式 | ✅ | `style.css` `@theme` 增加 `--breakpoint-console: 1100px`;构建验证 Tailwind v4 生成 `max-console:` 变体(`@media not all and (width>=1100px)`,与 `width<1100px` 等价)——**无需降级 `max-[1100px]:`**。WorkspaceRail/InfoPanel 根 aside 加 `max-console:fixed inset-y-0 left/right-0 z-40 transition-[translate,visibility]` + `open` 时 `translate-x-0 visible`、关闭时 `-translate-x-full/translate-x-full invisible`(invisible 保证关闭时不在 a11y 树/Tab 序),`tabindex="-1"` + watch open 收焦;App.vue 加 `railOpen/infoOpen`、中栏外包 `flex min-w-0 flex-1 flex-col`、顶部 `max-console:flex` 开关条(「工作区」「观测」,带 `aria-expanded` + trigger ref)、`z-30` 遮罩(`v-if="railOpen || infoOpen"`,`hidden max-console:block`)、window keydown Escape 关闭抽屉并还原焦点(isConnected 守卫)。≥1100px 三栏零变化;聊天列永不为 0。 |

### Phase 2

| 任务 | 完成 | 说明 |
| --- | --- | --- |
| T4 表单 label | ✅ | ChatPane(chat-input/「消息输入」、reject-reason/「驳回意见」)、WorkspacePickerModal(ws-picker-filter/「过滤目录」)、ApiKeysPanel(deepseek-key/anysearch-key)、McpPanel(mcp-name/command/args/env)全部加 `label.sr-only[for]` + `id`;placeholder 文案全部保留。 |
| T5 折叠语义 | ✅ | MessageBubble THINKING 按钮 `:aria-expanded="isThinkingBlockOpen(...)"`,工具行按钮 `:aria-expanded="!block.tool.collapsed"`;pre 收起时从 DOM 移除,无需 aria-hidden。 |
| T6 按压语义 | ✅ | ChatPane MODEL/THINK 按钮 `:aria-pressed`(model/thinkingLevel 全等),两个按钮簇容器 `role="group"` + `aria-label`(模型选择/思考级别)。 |
| T7 live region | ✅ | ChatPane 消息滚动容器 `role="log" aria-live="polite"`;App 连接错误条 `role="alert"`;ChatPane 发送错误 `<p>` `role="alert"`。 |
| T8 combobox 语义 | ✅ | textarea `role="combobox" aria-autocomplete="list" aria-controls="skill-listbox" :aria-expanded :aria-activedescendant`(仅菜单打开且有匹配时指向 `skill-opt-<index>`);下拉容器 `id="skill-listbox" role="listbox"`;选项 `role="option" :id :aria-selected`;空态 `role="status"`。**未改动任何键盘逻辑**,既有 12 个 ChatPane 用例保持全绿。 |
| T9 对比度+字号下限 | ✅ | WorkspaceRail「添加于」、InfoPanel 工具时间戳:`text-[10px] text-mute/70` → `text-[11px] text-mute`(全量 #8b949e = 6.8:1);WorkspacePickerModal 按键提示 `text-[9px] ... text-mute/80` → `text-[11px] ... text-mute`;ChatPane source 徽标 9px → 10px;DagPanel rounds 徽标 8px → 10px + `leading-none`。面包屑分隔符 `text-mute/50` 按计划不动。 |
| T10 标题大纲 | ✅ | PipelineHeader 品牌 `WORKFLOWS` span → `h1`(类名不变,页面级唯一 h1);InfoPanel 5 处 `h3.section-label` → `p.section-label`。大纲:h1(品牌)→ h2(空态),无跳级。 |
| T11 消息列宽 + DAG 尺寸 | ✅ | ChatPane 与 SubAgentModal 消息列 `max-w-3xl` → `max-w-2xl`(≈672px);DagPanel 节点 `w-14` → `w-12`(48px)、连线 `w-5` → `w-3`(12px),总宽 4×48+3×12+6×8 = 252px ≤ 面板内宽,不再被 flex 压缩。 |

## 二、新增/扩展测试

| 文件 | 内容 | 结果 |
| --- | --- | --- |
| `src/composables/useModalDialog.test.ts`(新增) | 打开后焦点入 dialog(initialFocus);背景兄弟 inert(带特性守卫);Tab 末位循环回首、中间 Tab 不拦截;Shift+Tab 反向;Escape 触发 onClose 且卸载后焦点还原到触发按钮 | 5/5 ✅ |
| `src/components/WorkspaceRail.test.ts`(新增) | 动作按钮常显(无 hidden 类)每行一对;文案/`title` 与 readOnly 对应;移除先 confirm(true 才调 removeWorkspace / false 不调);按钮可聚焦 | 5/5 ✅ |
| `src/components/MessageBubble.test.ts`(新增) | THINKING 按钮 aria-expanded 随点击 true↔false(模拟父级 toggle 处理);工具行 aria-expanded 默认 true、随 collapsed 切换 | 2/2 ✅ |
| `src/components/ChatPane.test.ts`(扩展) | combobox:role/aria-controls/aria-expanded/aria-activedescendant 存在,ArrowDown 后 activedescendant 与 aria-selected 随动,Esc 后清除;MODEL/THINK aria-pressed 标记激活项 + role=group | +2 用例 ✅ |
| 既有 5 个测试文件 | 保持全绿(App / ChatPane / McpPanel / WorkspacePickerModal / useAgent) | ✅ |

## 三、验证结果(最终状态)

- **test**:`pnpm --filter @workflows/web test` → **8 个测试文件 / 67 用例全部通过**(基线 5 文件 / 53 用例;新增 3 文件 12 用例 + 扩展 2 用例)
- **typecheck**:`vue-tsc -b` ✅ 无错误
- **lint**:`eslint .` ✅ 0 错误 0 警告(含 `vue/attributes-order` 经 `--fix` 归位)
- **build**:`vite build` ✅ 成功,`max-console:` 变体与 `transition-[translate,visibility]` 均确认生成在产物 CSS 中
- 仓库约束:改动文件全部位于 `apps/web/src`(18 个文件:13 源文件 + 3 新测试 + 2 扩展/新增 composable),`apps/api` / `packages/shared` 零改动

## 四、Commit 列表(11 个,每任务一个,可独立回滚)

```
36dd226 fix(a11y): modal dialog contract                    (T1)
a2bb5f6 fix(a11y): workspace row actions always visible + remove confirm  (T2)
1872cee fix(ui): responsive drawers below 1100px (chat column never 0)    (T3)
2befadc fix(a11y): form control labels (sr-only)            (T4)
f2cf9d7 fix(a11y): aria-expanded on thinking/tool toggles   (T5)
7dde8f7 fix(a11y): aria-pressed on model/think toggles      (T6)
70dcb82 fix(a11y): live regions (log/alert)                 (T7)
100b811 fix(a11y): skill dropdown combobox semantics        (T8)
0aacd15 fix(ui): metadata contrast + font-size floors       (T9)
894fde1 fix(a11y): heading outline (h1 brand, section labels as p)  (T10)
dee96cb fix(ui): message column max-w-2xl, dag node/connector sizing  (T11)
```

## 五、风险点处理情况

| 计划风险 | 处理结果 |
| --- | --- |
| `inert` 特性守卫 | ✅ `'inert' in el` 守卫,旧浏览器仅降级不报错;单测含守卫分支 |
| trap 与 Tab 补全冲突 | ✅ document 级 bubble 监听 + `event.defaultPrevented` 短路;既有 WorkspacePicker Tab 补全用例全绿 |
| Escape 双重触发 | ✅ 幂等,未做特殊处理(与计划一致) |
| 桌面三栏回归 | ✅ 全部响应式类带 `max-console:` 前缀,构建产物确认 ≥1100px 不应用 |
| 自定义断点构建失败 | ✅ 构建成功,`--breakpoint-console` 正常生成 `max-console:` 变体,**未触发降级** |
| WorkspaceRail 结构重构回归 | ✅ T2 单测(5 例)+ 既有 App 测试全绿 |
| jsdom 无媒体查询 | ✅ 响应式以构建产物 CSS 验证为主,行为逻辑(开关条/遮罩/Esc)已实现,浏览器实测留待验收(无法在此环境跑浏览器) |

## 六、与计划的小偏差(记录,非违规)

1. **T3 过渡属性**:`transition-[transform,visibility]` → `transition-[translate,visibility]`。Tailwind v4 的 translate 工具类使用原生 `translate` 属性(构建产物已确认),`transform` 不会触发 `translate` 变化动画;改用 `translate` 后抽屉滑动动画才实际生效,功能与意图不变。
2. **T3 抽屉收焦**:在 WorkspaceRail/InfoPanel 内部 watch `open` prop 后 `nextTick` 聚焦自身根(而非由 App 持有组件 ref),职责内聚、App 改动更小。
3. **T1 composable 的 `ariaLabel` 参数**:在 onMounted 时同步写入 root 的 aria-label(与模板属性幂等),使参数不落空。

## 七、遗留问题

- **浏览器实测未做**:本环境无浏览器(jsdom 不实现媒体查询),计划「六、验收标准」中的视口缩放(7-10)、键盘走查(1-6)、对比度计算(11-12)需在 `http://localhost:15200` 人工走查;代码侧已按计划实现并通过构建产物 CSS 验证响应式类生成。
- 计划明确排除项(#13 会话名称/摘要、Considered-but-Rejected 6 项、SessionSwitcher listbox 化等)未动,维持原决定。
