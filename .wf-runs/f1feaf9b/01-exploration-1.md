# 探索报告:web 前端"设置模态窗"(ApiKeyModal)垂直 tabs 改造前调研

> 调研时间:2026-XX;工作区:`/home/kaijia/codes/github/workflows`(pnpm monorepo,turbo)
> 结论先行:设置模态窗 = `apps/web/src/components/ApiKeyModal.vue`(内部再嵌 `McpPanel.vue`),当前为单列垂直堆叠;仓库无现成 tab 组件,但有明确的分栏/激活态视觉先例(主界面左栏 WorkspaceRail + 三栏布局)。改造主要落在 ApiKeyModal.vue 一个文件(+ 可选 McpPanel.vue 微调),数据层零改动。

---

## 1. 仓库概览

- **Monorepo 结构**(pnpm workspace + turbo):
  - `apps/web/` — Vue 3.5 + Vite 8 + TypeScript 6 前端(SFC `<script setup lang="ts">` 风格)
  - `apps/server/`(推测,未展开)— 提供 `/api/agent/*` REST 接口
  - `packages/shared/` — 共享类型(`McpServerConfig` / `McpServerStatus` / `McpToolInfo` 等,见 `packages/shared/src/index.ts:80-108`)
  - `docs/`、`.workflows/`(本地运行配置)
- **前端技术栈**:Vue 3.5.40、Vite 8.2、TypeScript 6、Tailwind CSS v4(`tailwindcss ^4.3.3` + `@tailwindcss/vite`)、`@lucide/vue` 图标、`marked`(Markdown 渲染)、`@workflows/shared` workspace 包。
- **测试**:vitest + @vue/test-utils + jsdom(`pnpm --filter @workflows/web test`);现有测试文件:`App.test.ts`、`ChatPane.test.ts`、`WorkspacePickerModal.test.ts`、`composables/useAgent.test.ts`。
- **设计体系**:Tailwind v4 `@theme` token 定义在 `apps/web/src/style.css`(`--color-canvas #101010`、`--color-primary #00d992`、`--color-hairline`、`--radius-*`、`--shadow-modal` 等);组件几乎全部只用 utility class,仅 3 个组件带 `<style scoped>`(InfoPanel / MessageBubble / PipelineHeader)。

## 2. 设置模态窗位置(核心发现)

**不存在 SettingsModal/SettingsPanel 命名的文件**。搜索 `Settings|设置` 后确认,"设置"模态窗实际是:

- **`apps/web/src/components/ApiKeyModal.vue`**(文件名沿用了历史职责,内部标题为"连接 · CONNECT")
- 由 **`apps/web/src/App.vue`** 挂载并控制开关:

```vue
<!-- App.vue -->
const showSettings = ref(false)
<!-- PipelineHeader @open-settings="showSettings = true";ChatPane :on-open-settings -->
<ApiKeyModal v-if="showSettings" :agent="agent" :meta="meta" @close="showSettings = false" />
```

- 打开入口(两处):
  - `PipelineHeader.vue:105-109` — 顶栏"设置"按钮(带 `Settings` 图标),emit `open-settings`
  - `ChatPane.vue:286,372` — 空态/侧栏的"配置 DeepSeek API KEY"入口,走 `onOpenSettings` prop 回调

## 3. ApiKeyModal 组件结构摘要

**整体形态**:单列垂直堆叠,自上而下 4 个区块(标题 + DeepSeek key → AnySearch key → MCP 面板 → 环境信息),区块之间用 `border-t border-hairline` 分隔。当前没有内部导航。

模态窗外壳(`ApiKeyModal.vue` template 顶部):

```html
<div class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-canvas/80 p-6 backdrop-blur-sm"
     @click.self="emit('close')">
  <div class="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-md border border-hairline bg-canvas p-6 shadow-modal">
    <!-- 标题行:连接 · CONNECT + 关闭按钮 -->
```

### 3.1 区块 1:DeepSeek API key(内联,`ApiKeyModal.vue` 内)
- 小节标题:`DEEPSEEK · 对话模型`(font-mono text-[10px] text-mute)
- 说明文字:key 仅存后端 `.workflows` 配置,不返回前端
- 表单:`<input type="password" v-model="keyInput" placeholder="sk-…">` + 保存按钮
- 状态:未配置 / 已配置(可覆盖)徽标(`agent.hasApiKey.value`);错误与成功提示(`error` / `saved` ref)
- 逻辑:`handleSave()` → `agent.saveApiKey(key)`(PUT `/api/agent/config/key`)

### 3.2 区块 2:AnySearch API key(内联,`ApiKeyModal.vue` 内)
- 标题:`ANYSEARCH · 网络搜索`;说明:匿名调用限流、`ANYSEARCH_API_KEY` 环境变量优先、空保存=清空
- 表单:`v-model="anyKeyInput"` placeholder `anysearch-…` + 保存按钮
- 逻辑:`handleAnySave()` → `agent.saveAnySearchApiKey()`(PUT `/api/agent/config/anysearch-key`)

### 3.3 区块 3:MCP Servers(**独立组件 `McpPanel.vue`**,`<McpPanel :agent="agent" />`)
数据来源:`agent.mcp`(GET `/api/agent/mcp`),打开即 `onMounted` 拉取(`agent.refreshMcp()`)。组件内部结构:
- 头部行:`MCP · 外部工具` 标题 + **刷新** 按钮(`handleRefresh`,防重复点击)
- 安全警告块(border-err 样式)
- **server 列表**(`v-for servers`,`space-y-2` 卡片):每卡片含
  - name + `command args`(truncate)
  - 状态标签:`statusLabel()` → 已连接 · N 工具 / 连接中… / 未连接 · 新建会话后自动连接 / 异常:err / 未启用;颜色 `statusClass()`
  - 操作行:**启用** checkbox(`toggleEnabled` → `saveMcpServer({...server, enabled: !enabled})`)、**测试** 按钮(`handleTest` → `testMcpServer`,结果展开显示 ok/tools 列表/error)、**删除** 按钮(`handleDelete` → `deleteMcpServer`)
- **添加表单**:`name` + `command` 两列 grid + 全宽 `args` 输入(空格分隔);**"添加并测试"** 按钮(`handleAdd` → `saveMcpServer({enabled:false})` 后自动 `handleTest`);提示"新增默认不启用(opt-in)"
- 底部提示:增改需新建会话/重开工作区生效
- 相关 composable 方法(`useAgent.ts:196-250`):`saveApiKey` / `saveAnySearchApiKey` / `refreshMcp` / `saveMcpServer`(PUT upsert,透传 `env`)/ `deleteMcpServer`(DELETE)/ `testMcpServer`(POST test)

### 3.4 区块 4:环境信息(内联,`v-if="meta"`)
- 两行:环境(environment)+ 配置目录(workflowsRoot,truncate)

### 3.5 组件内部状态(ref)
- ApiKeyModal:`keyInput/saving/error/saved`、`anyKeyInput/anySaving/anyError/anySaved`
- McpPanel:`nameInput/commandInput/argsInput/saving/error/saved`、`refreshing`、`testResults`(内存态,不持久化)、`servers/statusByName` computed

## 4. 样式方案与模态窗状态管理

- **Tailwind CSS v4**(`@import "tailwindcss"` + `@theme` token),无 scoped css 在 ApiKeyModal/McpPanel 中——两者都只用 utility class,无 `<style>` 块。
- **开关管理**:App.vue 持有 `showSettings` ref,`v-if` 挂载/卸载(无 transition);关闭通过子组件 `emit('close')`(遮罩 `@click.self` + 关闭按钮);无 v-model。
- **尺寸**:当前 `max-w-md`(448px)+ `max-h-[85vh]` 内部滚动。改造为"左 tab 导航 + 右内容区"后需要加宽(仓库已有更宽模态窗先例:`SubAgentModal` 用 `max-w-3xl` 且采用"标题条 + 内容区"的 `flex flex-col` 结构;`WorkspacePickerModal` 用 `w-[620px]`)。

## 5. 可复用 tab / 分栏布局先例

- **仓库内没有现成 tab 组件**(grep `tab|Tab` 仅命中 ChatPane 键盘 Tab 键处理)。
- **最接近的分栏视觉先例是主界面三栏布局**(`App.vue`):
  - 左栏 `WorkspaceRail.vue`:`<aside class="flex w-60 shrink-0 flex-col border-r border-hairline bg-canvas">`,激活项样式 = `border-l-2 border-l-primary bg-canvas-soft`(hover `bg-canvas-soft/60`),标题 `font-display text-[10px] font-semibold tracking-[0.2em] text-mute`——**这套"左侧窄栏 + border-r 分隔 + 绿色左缘激活态"可直接迁移为设置窗的垂直 tab 导航风格**。
  - 右栏 `InfoPanel.vue`:`w-72 border-l` + `section-label` scoped 样式。
- `McpPanel.vue` 本身已是一个自包含 section 组件(只依赖 `agent` prop),是"内容区独立组件"的现成范式——新 tab 内容区可沿用"每 tab 一个独立组件"或继续内联。

## 6. 测试情况

- **ApiKeyModal.vue / McpPanel.vue 均无专属测试文件**。
- 相关既有测试:
  - `App.test.ts`:挂载 App 后断言三栏界面文本(工作区/观测面板),**未打开设置模态窗**,不覆盖 ApiKeyModal。
  - `useAgent.test.ts:314-359`:覆盖 `refreshMcp` / `saveMcpServer` / `testMcpServer` / `deleteMcpServer` 的请求层行为(数据层无忧)。
  - `WorkspacePickerModal.test.ts` 是模态窗组件测试的现有范式(改造后如补测试可参照)。

## 7. 改造范围评估

| 事项 | 影响 |
|---|---|
| 布局改造(单列 → 垂直 tabs) | **主体在 `ApiKeyModal.vue` 一个文件**:新增 `activeTab` ref + 左侧 tab 导航列(可抄 WorkspaceRail 激活态样式)+ 右侧内容区;现有四个区块拆成 `<div v-show>` 或抽成子组件;模态窗外壳 `max-w-md` → 加宽(参考 `max-w-2xl/3xl`,flex 行布局) |
| MCP 区块 | `McpPanel.vue` 大概率**无需改动**(已是独立组件,接收 `agent` prop);若需"每 tab 独立滚动"或内容区统一样式,可能加少量 wrapper class |
| 数据层 | 零改动:`agent` store 方法(keys/MCP CRUD/测试)全部现成 |
| 打开/关闭 | 零改动:App.vue 的 `showSettings`/`@close` 机制不变 |
| 测试 | 无既有测试被破坏(无 ApiKeyModal 测试);建议新增(参照 WorkspacePickerModal.test.ts 范式) |
| 相关文件清单 | 改:`apps/web/src/components/ApiKeyModal.vue`(+ 可选 `McpPanel.vue`);参考:`App.vue`、`WorkspaceRail.vue`(tab 样式)、`SubAgentModal.vue`(宽模态结构)、`style.css`(token) |

**结论:可行,且改动面小——核心只动 `ApiKeyModal.vue` 一个组件文件。** 风险点:
1. 模态窗当前整体 `overflow-y-auto` 单列滚动;改 tabs 后需决定滚动归属(整窗滚动 vs 内容区滚动),MCP 列表+表单较长,建议内容区独立滚动(`min-h-0 overflow-y-auto`)。
2. `max-w-md` 过窄,左 tab(建议 w-40/w-44)+ 右内容区至少需要 `max-w-2xl` 起步,注意与 SubAgentModal(`max-w-3xl`)视觉一致。
3. 无现成 tab 组件,新导航样式需自建;建议直接复用 WorkspaceRail 的激活态语言(`border-l-2 border-l-primary bg-canvas-soft`),保持品牌一致。
4. 环境信息区块(meta)较小,可考虑并入某个 tab 或保留在底部,需产品决策。
