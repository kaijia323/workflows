# 代码审查报告:设置模态窗垂直 tabs 改造

> 审查对象:计划 `.wf-runs/f1feaf9b/02-plan-1.md` vs 执行 `.wf-runs/f1feaf9b/03-execution-1.md` + 实际改动
> 审查方式:全量阅读 ApiKeyModal.vue / ApiKeysPanel.vue / McpPanel.vue / App.vue / useAgent.ts(契约部分)/ style.css(token),交叉比对探索报告与历史工作流记录
> 环境限制:本审查环境无 shell,**无法独立执行 `git diff` 与 `pnpm typecheck/lint/test`**;改动范围与验证结果以静态证据交叉核验(详见问题清单 1)

## 结论:pass

---

## 一、计划符合度逐条核对

| # | 计划项 | 状态 | 说明(文件:行) |
|---|---|---|---|
| ① | 模态窗加宽 `max-w-3xl` + `flex flex-col` + `max-h-[85vh]` | 通过 | `ApiKeyModal.vue:22` — `flex max-h-[85vh] w-full max-w-3xl flex-col rounded-md border border-hairline bg-canvas shadow-modal`,与计划模板一致;遮罩 `@click.self="emit('close')"` 保留(`:17-20`) |
| ② | 左侧垂直 tab 导航 `w-44`、`border-r`、激活态 `border-l-2 border-l-primary bg-canvas-soft` | 通过 | `ApiKeyModal.vue:35` `<nav class="flex w-44 shrink-0 flex-col border-r border-hairline">`;tab 按钮 `:36-63` 基类含 `border-l-2`,激活 `border-l-primary bg-canvas-soft`、非激活 `border-l-transparent hover:bg-canvas-soft/60`;「配置 · CONFIG」标题 `tracking-[0.2em]`(`:38-40`)——与 WorkspaceRail.vue:51-52 激活范式逐字一致 |
| ③ | 右内容区 `min-h-0 flex-1 overflow-y-auto` 独立滚动 | 通过 | `ApiKeyModal.vue:64` `<main class="min-h-0 flex-1 overflow-y-auto px-5 py-4">`;主体行 `:34` `flex min-h-0 flex-1`;标题条(`:25` `shrink-0`)、footer(`:73` `shrink-0`)、nav(`shrink-0`)均不参与滚动。无缺 `min-h-0` 隐患 |
| ④ | `v-show` 切换(非 v-if)保证输入保留 | 通过 | `ApiKeyModal.vue:65-70` — `<ApiKeysPanel v-show="activeTab === 'api'">` + `<McpPanel v-show="activeTab === 'mcp'">`,双面板常驻 DOM |
| ⑤ | API Keys 默认激活 | 通过 | `ApiKeyModal.vue:12` — `const activeTab = ref<TabId>('api')` |
| ⑥ | 环境信息(meta)移入底部 footer 常驻 | 通过 | `ApiKeyModal.vue:72-85` — `v-if="meta"` 保留(`:74`),`shrink-0 border-t` 单行 flex,`truncate` + `title` 悬停(`:82-83`);切 tab 不消失,meta 为 null 不渲染 |
| ⑦ | 壳层干净:仅 activeTab + tab 切换 | 通过 | script(`:1-13`)仅 `ref`/`AgentStore` import、`ApiKeysPanel`/`McpPanel` import、`defineProps`/`defineEmits`、`TabId`/`activeTab`;无残留 ref/方法;关闭行为(标题条「关闭」按钮 + 遮罩 self click)不变 |
| ⑧ | ApiKeysPanel 逐字搬移(8 ref + 2 方法) | 通过* | 见下节专核 |

## 二、ApiKeysPanel.vue "逐字搬移"专核

逐项核对(文件:行):

- **8 个 ref**:`keyInput/saving/error/saved`(`:15-18`)、`anyKeyInput/anySaving/anyError/anySaved`(`:20-23`)全部在位,无增删;
- **handleSave**(`:26-40`):`trim()` → 空/`saving` 拦截 → `saving=true; error=null; saved=false` → `await props.agent.saveApiKey(key)` → `keyInput=''` → `saved=true` → catch 提取 message → finally `saving=false`。与 useAgent.ts:196 `saveApiKey(key: string): Promise<void>` 契约吻合;
- **handleAnySave**(`:43-57`):无 trim(空输入=清空语义,直接传 `anyKeyInput.value`)→ `await props.agent.saveAnySearchApiKey(anyKeyInput.value)` → 清空。与 useAgent.ts:206 契约吻合;
- **徽标逻辑**(`:59-63` / `:142-147`):`agent.hasApiKey.value` / `agent.hasAnySearchApiKey.value` → 「已配置(可覆盖)」绿点 / 「未配置」「未配置(匿名可用)」,与探索报告 §3.1/3.2 及 24d5aebd 工作流记录的旧文案逐字一致;
- **说明文字**:DeepSeek `meta?.environment === 'production' ? '~/.workflows' : '.workflows'` 条件保留(`:66`);AnySearch「匿名限流 / ANYSEARCH_API_KEY 优先 / 空保存清空」文案与 24d5aebd/02-plan-2.md:306 记录一致;
- **区块分隔**:AnySearch `mt-6 border-t border-hairline pt-4`(`:117`)与旧结构一致;根元素为无 class 的 `<div>`(`:55`),无壳层/导航/footer 混入;无 `<style>` 块。

> \* 说明:本环境无 shell,无法对原 ApiKeyModal.vue 做字节级 diff 比对;上述通过"探索报告(改造前撰写)的结构描述 + 历史工作流(24d5aebd/d6a3b5b6)记录的旧文案 + useAgent 契约 + 计划 Step 1 验收项"四路交叉验证,未发现搬移偏差或逻辑改动痕迹。

## 三、约束遵守核对

| 约束 | 状态 | 说明 |
|---|---|---|
| McpPanel.vue 零改动 | 通过* | 全量阅读:根 class `mt-6 border-t border-hairline pt-4`、`onMounted → refreshMcp().catch()`、statusLabel/statusClass/toggleEnabled/handleAdd/handleTest/handleDelete 均与探索报告 §3.3 改造前描述逐项一致,无修改痕迹 |
| App.vue 零改动 | 通过* | 挂载方式 `v-if="showSettings"` + `:agent` `:meta` `@close="showSettings = false"` 与探索报告 §2 引用内容一致;打开入口(PipelineHeader `@open-settings` / ChatPane `:on-open-settings`)不变 |
| useAgent.ts 零改动 | 通过* | `saveApiKey` 仍在 :196、`saveAnySearchApiKey` :206、`refreshMcp` :218、`hasApiKey` :174、`hasAnySearchApiKey` :175——与探索报告引用的行号区间(196-250)吻合,文件无位移迹象 |
| 后端 / packages/shared 零改动 | 通过* | 两个改动文件仅 import `vue` / `../composables/useAgent` / `./McpPanel.vue`,均为既有依赖 |
| 无新依赖 | 通过 | 两文件无新增 import;`package.json` 无涉及 |
| diff 仅 2 文件 | 通过* | 执行报告自检 + 全仓 grep:`ApiKeysPanel` 仅被 ApiKeyModal 引用;无其他文件引用新组件;静态无夹带痕迹 |

## 四、风险排查

1. **滚动布局**:结构链完整——壳 `flex flex-col max-h-[85vh]` → 主体行 `flex min-h-0 flex-1` → main `min-h-0 flex-1 overflow-y-auto`;标题条/footer/nav 均 `shrink-0`。无缺 `min-h-0` 导致内容区不滚、无导航被压缩问题。nav 内部 `min-h-0 flex-1` 无 overflow(仅两项,无滚动需求),可接受。
2. **v-show 下 McpPanel 挂载时机**:模态窗打开即挂载两个面板,McpPanel `onMounted → refreshMcp()` 在打开时触发**一次**——与改造前(旧版打开即显示 MCP 区块并拉取)行为一致,非新行为、无重复请求。切 tab 不重挂载,`testResults` 等内存态保留。✅
3. **其他入口**:PipelineHeader「设置」按钮与 ChatPane「配置 DeepSeek API KEY」均走 App.vue 同一 `showSettings` + `v-if` 路径,props/emit 契约未变,两入口不受影响。✅
4. **类型契约**:App.vue `meta` 类型与 ApiKeyModal/ApiKeysPanel 的 props 类型(`{ workflowsRoot: string; environment: string } | null`)一致;`AgentStore`(`useAgent.ts:789`)含 `saveApiKey/saveAnySearchApiKey/hasApiKey/hasAnySearchApiKey/mcp/refreshMcp`,ApiKeysPanel 调用全部命中。✅
5. **样式 token**:用到的 `canvas/canvas-soft/hairline/ink/body/mute/primary/primary-soft/on-primary/err/shadow-modal/font-display/font-mono` 均在 style.css `@theme` 定义(`:12-42`)。✅
6. **执行报告披露的 2 处机械性偏差**:① `defineProps` 未赋 const(避免 `noUnusedLocals` 报错;模板按名访问 props 是 `<script setup>` 标准用法,`activeTab` 场景下 `props` 确无引用)——合理,非偏离;② footer `<p>` 多行书写(消除 `vue/singleline-html-element-content-newline` warning)——合理,非偏离。

## 五、问题清单

| # | 严重度 | 文件/位置 | 问题 | 建议 |
|---|---|---|---|---|
| 1 | 低(环境受限) | 全改动 | 审查环境无 shell,无法独立复跑 `git diff` / `pnpm typecheck` / `lint` / `test`;「diff 仅 2 文件」「McpPanel/App.vue/useAgent 零改动」「0 错误 0 警告 34 tests 全绿」依赖执行报告自检 + 上述静态交叉验证 | 在有 shell/CI 环境补一次 `git diff --stat` + 三命令复跑确认 |
| 2 | 低(计划内未完成) | 计划 Step 5 | 可选测试 `ApiKeyModal.test.ts` 未执行(计划标注 P2 可选,任务清单未要求)——不构成违约,但 v-show 输入保留、默认 tab 高亮等行为无自动化回归保护 | 后续任务补测试(参照 WorkspacePickerModal.test.ts 范式,`global.stubs: { McpPanel: true }`) |
| 3 | 低(计划内未完成) | 计划 Step 4 | 10 条手测清单未执行(需 dev + 浏览器环境),执行报告已如实披露;重点:切 tab 输入保留、内容区独立滚动、打开时 `refreshMcp` 仅一次、小屏(~800px)无横向溢出 | 建议后续人工/浏览器任务按 Step 4 清单补验,尤其 4/5/6/10 条 |
| 4 | 信息 | ApiKeyModal.vue:65-70 | `v-show` 下 McpPanel 打开即挂载并 `refreshMcp`——用户仅配置 key 时也会发起一次 MCP 请求;与改造前行为完全一致(旧版打开即拉取),非回归,仅提示 | 无需处理;如未来想省请求可改为 `v-if` + KeepAlive,但会引入新语义,不建议 |
| 5 | 信息 | ApiKeysPanel.vue:56 | 首区块保留 `mt-5`,叠加内容区 `py-4` 后顶部间距约 36px,较旧布局(p-6=24px)略大 | 纯视觉;如在意可把首区块 `mt-5` 改 `mt-0`,但会偏离"逐字搬移"原则,建议保留现状 |
| 6 | 信息(可选增强) | ApiKeyModal.vue:36-63 | tab 按钮无 `role="tab"`/`aria-selected`/键盘方向键支持 | 计划未要求、与 WorkspaceRail 范式一致;如做无障碍增强可补 |

## 六、最终建议

**通过(pass)**。

- 计划六项布局验收(①-⑥)全部静态核验通过,实现与计划目标模板逐字吻合;
- ApiKeysPanel 抽组件零逻辑改动(8 ref + 2 方法 + 徽标/文案逐项核对),壳层干净无夹带;
- 约束面(数据层/后端/shared/McpPanel 零改动、无新依赖、2 文件范围)静态证据充分;
- 两处未完成项(可选测试、手测清单)均为计划内可选/环境受限项,已如实披露,不阻塞;
- 唯一遗留动作:在可执行环境补跑 git diff 与 typecheck/lint/test 复核(问题 1),并按 Step 4 清单补手测(问题 3)。
