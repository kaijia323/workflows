# 探索报告:Agent 控制台前端源码与全局样式调研

> 目标:定位 dev 端口 15200 的 Agent 控制台前端源码、入口与全局 CSS,查明 button 光标(cursor)样式现状,确定加全局 `button:not(:disabled){cursor:pointer}` 的最佳位置。
> 方式:只读调研,未修改任何代码。

---

## 1. 仓库概览

**pnpm + Turborepo monorepo**(`package.json` + `pnpm-workspace.yaml` + `turbo.json`),包结构:

| 包 | 职责 |
| --- | --- |
| `apps/web` | **Vue 3 + Vite + Tailwind v4 前端**(聊天 UI),dev 端口 **15200** |
| `apps/api` | Hono + pi SDK 后端(端口 3000 dev / 5200 prod) |
| `packages/shared` | 纯类型包(workspace 依赖,改动后需 `pnpm build`) |

- 技术栈:Vue 3.5(`<script setup lang="ts">`)、Vite 8(`@vitejs/plugin-vue` + `@tailwindcss/vite`)、Tailwind CSS **v4.3.3**、Vitest + @vue/test-utils(jsdom)、ESLint(flat config)+ lint-staged + husky。
- 构建/测试:根目录 `pnpm dev`(turbo 并行跑 web 15200 + api 3000)、`pnpm build`、`pnpm typecheck`、`pnpm test`(web 用 vitest,测试文件 `*.test.ts` 与组件同目录)。
- 设计体系:近黑画布 `#101010` + 电光绿 `#00d992` + 1px hairline 分层 + 4px 间距体系(见 `style.css` 注释,VoltAgent 视觉语言)。

## 2. 需求相关模块清单

| 文件路径 | 职责 |
| --- | --- |
| `apps/web/vite.config.ts` | Vite 配置:dev 端口 **15200**,`/api` 代理到 3000,`tailwindcss()` 插件(V4 CSS-first 模式) |
| `apps/web/index.html` | HTML 入口(title「workflows · Agent 控制台」),挂载 `#app`,引 `/src/main.ts` |
| `apps/web/src/main.ts` | **JS 入口**:createApp + 字体(fontsource inter/jetbrains-mono)+ **`import './style.css'`**(全局样式唯一导入点) |
| `apps/web/src/style.css` | **全局样式文件(唯一)**:`@import "tailwindcss"` + `@theme` 设计 token + 基础样式 + 滚动条/selection/focus-visible + keyframes。**无任何 cursor 规则** |
| `apps/web/src/App.vue` | 根布局:PipelineHeader + WorkspaceRail + ChatPane + InfoPanel + 三个模态窗(ApiKeyModal / WorkspacePickerModal / SubAgentModal),全屏 flex 三栏管线 |
| `apps/web/src/components/*.vue`(14 个) | 全部按钮的所在地,按钮均用**内联 Tailwind 类名**逐处编写,无共享 `.btn` 类 |
| `apps/web/src/composables/useAgent.ts` | SSE 接入 / agent 状态管理(与样式无关,列作上下文) |

## 3. 关键发现

### 3.1 前端目录与入口(已确认)
- 前端在 **`apps/web`**,dev 端口 15200 在 `vite.config.ts` 中配置(`server.port: 15200`)。
- 入口链:`index.html` → `src/main.ts` → 挂载 `App.vue`(三栏布局:左工作区 / 中聊天 / 右观测)。

### 3.2 全局 CSS 位置(已确认)
- **唯一**全局样式文件:`apps/web/src/style.css`(不是 index.css/globals.css),在 `main.ts` 中导入。
- 结构:`@import "tailwindcss"` → `@theme { ... }`(设计 token)→ 全局基础(html/body/#app)→ 滚动条 → selection → `:focus-visible` → keyframes + reduced-motion。
- **现状:全文件没有任何 cursor 规则**。全仓 grep `cursor`(忽略大小写)仅 2 处命中,都在 `McpPanel.vue`:
  - `McpPanel.vue:287` — `cursor-pointer` 加在 **label** 上;
  - `McpPanel.vue:382` — `cursor-not-allowed` 加在 **input** 上(**不是 button**,不会与全局按钮规则冲突)。
- 另有 3 个组件带 `<style scoped>`(MessageBubble / InfoPanel / PipelineHeader),其中也无 button cursor 规则。

### 3.3 Tailwind 版本与按钮类名约定(已确认)
- **Tailwind v4.3.3**,CSS-first 配置:`@tailwindcss/vite` 插件 + `style.css` 内 `@theme` 块;**无 `tailwind.config.*` 文件**(fff-find 无结果)。
- 按钮**大量使用内联任意值类名**,与任务截图一致,例如 `ChatPane.vue`:
  - `rounded-[3px] px-2 py-1 font-mono text-[10px] transition disabled:opacity-40`(模型/思考切换按钮);
  - `rounded-sm bg-primary px-4 py-2.5 font-display text-[11px] ...`(发送/停止按钮)。
- 全组件 grep `button {` / `.btn` 无结果 → **不存在共享按钮类**,所有按钮样式逐处内联。

### 3.4 为什么按钮没有 pointer 光标(Tailwind v4 行为)
- 已直接核对 `apps/web/node_modules/tailwindcss/preflight.css`:Tailwind **v4 的 preflight 不再包含 `cursor: pointer`**(v3 有,对 `button, [role="button"]` 生效;v4 移除了该规则),只保留 `appearance: button`、字体/颜色继承等。
- 因此本项目中所有 `<button>` 都回落到浏览器默认箭头光标 —— 这正是需要加全局 `cursor: pointer` 修复的原因。

### 3.5 添加全局规则的安全性与位置
- 组件按钮的禁用态**统一用 `:disabled` 属性**(如发送按钮 `:disabled="!draft.trim() || ..."`、切换按钮 `:disabled="agent.streaming.value"`),并配 `disabled:opacity-40` 视觉弱化 → `button:not(:disabled){cursor:pointer}` 可精确覆盖"可点击"状态,不会给禁用按钮加手型。
- 唯一反例:`cursor-not-allowed` 只用于 input(非 button),无冲突。
- **推荐位置:`apps/web/src/style.css`** —— 全局样式唯一落点,`main.ts` 已导入,改动一处全局生效。建议放在「全局基础」段(如 `body` 规则之后、`:focus-visible` 附近),纯 CSS 或 `@layer base` 均可(该文件目前未用 `@layer`,加普通规则最贴合现状):
  ```css
  /* 可交互按钮显示手型(禁用按钮除外) */
  button:not(:disabled) {
    cursor: pointer;
  }
  ```

## 4. 风险点

1. **Tailwind v4 语义**:若在 `@layer base` 之外直接写,规则不参与 Tailwind 层叠排序,但本项目按钮无其他 cursor 规则,无竞态;用普通规则最稳妥。
2. **特定性覆盖**:`button:not(:disabled)` 特定性 (0,1,1) 高于工具类 `.cursor-not-allowed` (0,1,0)。当前无按钮使用 `cursor-not-allowed`(仅 input),若未来有"视觉禁用但未加 `:disabled` 属性"的按钮需要 `cursor-not-allowed`,需用 `:disabled` 属性或更高特定性规则 —— 属已知低风险。
3. **测试影响**:web 测试为 jsdom 单元测试(App.test.ts 等),不校验计算样式,全局 CSS 改动不会破坏测试;改动后跑 `pnpm test` 与 `pnpm lint` 即可。

## 5. 结论

- 可行性:**高**。前端唯一全局样式文件 `apps/web/src/style.css` 无任何 cursor 规则,Tailwind v4 preflight 也不提供按钮手型,添加一行全局规则即可修复全部按钮。
- 建议:在 `apps/web/src/style.css` 的「全局基础」区域(约 `:focus-visible` 之前)新增:
  ```css
  button:not(:disabled) { cursor: pointer; }
  ```
- 无需改任何组件文件;按钮统一使用 `:disabled` 属性的现有约定使该规则语义精确、无副作用。
