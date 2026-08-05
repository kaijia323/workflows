# 探索报告:localhost:15200 AGENT 控制台源码定位

> 任务:定位提供 localhost:15200 的 AGENT 控制台 Web 页面源码,重点找出输入框(textbox)与「发送」按钮的 JSX/HTML 结构与 CSS(布局、flex、居中)。
> 范围:只读调研,未修改任何文件。

## 1. 仓库概览

- **仓库**:`C:/Users/kaijia/codes/github/workflows` — pnpm + Turborepo monorepo,名为 **workflows** 的 Web Agent 工作台。
- **技术栈**:
  - 前端 `apps/web`:**Vue 3.5** + **Vite 8**(`@vitejs/plugin-vue`)+ **Tailwind CSS v4**(`@tailwindcss/vite`,CSS-first `@theme` 模式)+ `@lucide/vue` 图标 + `marked` 渲染 Markdown。
  - 后端 `apps/api`:Hono + pi SDK(dev 端口 3000,生产单端口 5200)。
  - `packages/shared`:共享类型包。
- **构建/测试**:根目录 `pnpm dev`(turbo 并行:web 15200 + api 3000);`pnpm build` / `pnpm typecheck`(vue-tsc)/ `pnpm test`(Vitest,web 测试文件与组件同目录,如 `ChatPane.test.ts`)。

## 2. 15200 端口归属(服务项目)

- **提供 15200 服务的项目:`apps/web`**(`@workflows/web`)。
- `apps/web/package.json`:`"dev": "cross-env NODE_ENV=development vite"`。
- **端口配置在 `apps/web/vite.config.ts`**(绝对路径 `C:\Users\kaijia\codes\github\workflows\apps\web\vite.config.ts`):
  ```ts
  server: {
    port: 15200,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
  ```

## 3. 页面渲染链(入口 → 控制台组件)

| 文件(绝对路径) | 作用 |
|---|---|
| `C:\Users\kaijia\codes\github\workflows\apps\web\index.html` | HTML 入口,`<title>workflows · Agent 控制台</title>`,挂载 `#app`,`<script type="module" src="/src/main.ts">` |
| `...\apps\web\src\main.ts` | 创建 Vue app:导入字体、`./style.css`、`App.vue`,`createApp(App).mount('#app')` |
| `...\apps\web\src\App.vue` | 根组件:三栏布局(左 `WorkspaceRail` / 中 `ChatPane` / 右 `InfoPanel`),`<div class="flex h-screen flex-col overflow-hidden ...">` |
| `...\apps\web\src\components\ChatPane.vue` | **「AGENT 控制台」页面本体**:消息流 + 输入区 + 发送按钮(核心目标文件) |
| `...\apps\web\src\style.css` | 唯一全局 CSS:`@theme` 设计 token + 全局基础样式 |

## 4. 需求相关模块清单

| 文件 | 一句话说明 |
|---|---|
| `apps/web/src/components/ChatPane.vue` | 中栏聊天面板:空状态「AGENT 控制台」标题(L277)、textarea 输入框(L410-417)、「发送/停止」按钮(L420-436)、模型/思考级别切换器 |
| `apps/web/src/components/MessageBubble.vue` | 消息气泡渲染(用户/agent 消息、thinking/tool 块) |
| `apps/web/src/components/SessionSwitcher.vue` | 会话切换下拉 |
| `apps/web/src/composables/useAgent.ts` | Agent 状态 store:`draft` 提交、`sendMessage`、流式、闸门、skill 搜索逻辑 |
| `apps/web/src/style.css` | Tailwind v4 `@theme`(颜色/字体/圆角 token)+ 全局 button 光标、滚动条、动画 |
| `apps/web/src/App.vue` | 三栏骨架布局与模态窗编排 |
| `apps/web/vite.config.ts` | 端口 15200 与 `/api` 代理 |

## 5. 关键发现:输入框与「发送」按钮布局与样式

### 5.1 「AGENT 控制台」标题(空状态,ChatPane.vue L270-283)

位于消息区空状态,`grid h-full place-items-center` 垂直水平居中:

```html
<div v-if="agent.messages.value.length === 0" class="grid h-full place-items-center">
  <div class="max-w-sm text-center">
    ...
    <h2 class="mt-5 font-display text-sm tracking-[0.25em] text-ink">AGENT 控制台</h2>
```

### 5.2 输入区布局(输入框 + 发送按钮,ChatPane.vue L378-436)

**外层容器是 `flex items-end gap-2`(左对齐、底对齐、8px 间距),不是居中**;输入框用 `relative flex-1` 占满剩余宽度,按钮 `shrink-0` 固定右侧:

```html
<div class="flex items-end gap-2">                              <!-- L378 -->
  <div class="relative flex-1">                                 <!-- L379 输入框容器(弹性占满) -->
    <!-- / skill 搜索下拉(绝对定位 bottom-full) -->
    <textarea
      ref="textareaRef"
      v-model="draft"
      :disabled="!agent.activeWorkspaceId.value"
      rows="1"
      spellcheck="false"
      :placeholder="agent.activeWorkspaceId.value ? '输入消息,输入 / 可搜索 skills,Enter 发送,Shift+Enter 换行…' : '先在左侧选择一个工作区'"
      class="max-h-40 min-h-[40px] w-full resize-none rounded-sm border border-hairline bg-canvas-soft px-4 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-mute focus:border-primary disabled:opacity-50"
      @keydown="onKeydown"
      @blur="skillMenuOpen = false"
    />                                                          <!-- L410-417 -->
  </div>
  <button v-if="agent.streaming.value" ...>停止</button>        <!-- L420-426 -->
  <button
    v-else
    type="button"
    class="shrink-0 rounded-sm bg-primary px-4 py-2.5 font-display text-[11px] font-semibold tracking-widest text-on-primary transition hover:bg-primary-soft disabled:opacity-40"
    :disabled="!draft.trim() || !agent.activeWorkspaceId.value"
    @click="handleSend"
  >发送</button>                                                  <!-- L427-435 -->
</div>
```

### 5.3 样式定义位置(纯 Tailwind v4 工具类 + @theme token)

- **布局/flex/居中**:全部是 Tailwind 工具类内联在 ChatPane.vue 的 `class` 属性里(`flex items-end gap-2`、`relative flex-1`、`shrink-0`、`w-full`、`place-items-center` 等),**没有独立 CSS 文件/`<style>` 块**。
- **颜色/字体 token**:定义于 `apps/web/src/style.css` 的 `@theme` 块:
  - `--color-canvas: #101010`、`--color-canvas-soft: #1a1a1a`、`--color-hairline: #3d3a39`
  - `--color-ink: #f2f2f2`(文本色)、`--color-primary: #00d992`(电光绿 CTA)、`--color-on-primary: #101010`
  - `--font-display` / `--font-body` / `--font-mono`、`--radius-xs/sm/md`
- **Tailwind v4 扫描范围**:`@tailwindcss/vite` 自动扫描源码,无需 tailwind.config。

## 6. 关键发现与风险点

1. **「发送」按钮不是绝对定位/居中**:它通过父容器 `flex items-end gap-2` 与 `relative flex-1` 的输入框右侧底对齐。若需求是「按钮居中/布局调整」,改动点在 **ChatPane.vue L378-436**,一行容器 class 即可整体改变布局。
2. **按钮有 hover 变体**:`hover:bg-primary-soft`;禁用态 `disabled:opacity-40`(透明度变淡,非 cursor)。
3. **全局已存在 `button:not(:disabled) { cursor: pointer }`**(style.css L47-49)——按钮光标已是 pointer,禁用态走默认 `not-allowed`。
4. **输入框是 `<textarea>`(非 `<input type="text">`)**,`rows="1"` + `max-h-40 min-h-[40px] resize-none` 实现单行可增长;闸门「驳回意见」才是 `<input type="text">`(L355 附近,注意勿混淆)。
5. **同一输入区的其他按钮**:流式时「发送」被「停止」按钮(v-if/else)替换;skill 搜索下拉以 `absolute bottom-full` 浮在 textarea 上方,若调整输入区高度/定位需一并检查。
6. 既有探索报告(`.wf-runs/d9332f85/01-exploration-1.md` 等)证实此项目此前已被多次调研,15200/布局结论一致。

## 7. 结论

- **可行,定位明确**:localhost:15200 由 `apps/web`(Vue 3 + Vite 8 + Tailwind v4)提供,端口在 `apps/web/vite.config.ts`。
- 「AGENT 控制台」页面 = `apps/web/src/components/ChatPane.vue`;输入框(textarea)与「发送」按钮位于该文件 **L378-436** 的 `flex items-end gap-2` 容器内。
- 样式为 Tailwind v4 工具类(内联 class),主题 token 集中在 `apps/web/src/style.css` `@theme`。
- 建议:任何布局/居中改动只需修改 ChatPane.vue 中该段模板与相应工具类;如需新增全局样式(如按钮光标)则放 style.css 全局段(注意 L47 已有 button cursor 规则,避免重复)。
