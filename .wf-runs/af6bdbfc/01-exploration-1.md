# 探索报告:工作区(Workspaces)管理 UI 定位

> 任务:在 `C:/Users/kaijia/codes/github/workflows` 仓库中定位渲染"工作区卡片(名称 / RW 标签 / 路径 / 添加日期 / 只读 / 移除按钮)"的 UI 代码。
> 结论先行:该界面由 **`apps/web/src/components/WorkspaceRail.vue`** 渲染,样式为 **Tailwind CSS v4 原子类 + 自定义 design tokens**。

---

## 1. 仓库概览

| 项 | 内容 |
|---|---|
| 形态 | pnpm monorepo(`pnpm-workspace.yaml` + `turbo.json`),**非 VS Code 扩展**,是独立 Web 应用(浏览器运行,UI 视觉风格近似 VS Code 面板) |
| 子包 | `apps/web`(前端,Vue 3 + Vite)、`apps/api`(后端,Express + TypeScript)、`packages/shared`(共享类型)、`packages/cli`(命令行工具) |
| 前端技术栈 | Vue 3.5(`<script setup lang="ts">`)、Vite 8、TypeScript、**Tailwind CSS v4**(`@tailwindcss/vite` 插件,CSS-first 配置)、图标 `@lucide/vue`、markdown 渲染 `marked`、图片压缩 `compressorjs` |
| 组件库 | **无** —— 无 element-plus / naive-ui 等,全部自研组件 + Tailwind 原子类 |
| CSS 方案 | Tailwind v4 原子类;design tokens 定义在 `apps/web/src/style.css` 的 `@theme` 块(VoltAgent 视觉语言);无独立 CSS 文件、无 CSS Modules、无 style scoped |
| 测试 | Vitest + @vue/test-utils + jsdom(组件旁 `.test.ts` 文件);构建 `vue-tsc -b && vite build` |
| 后端关联 API | `apps/api/src/agent/routes.ts`(workspaces 路由);前端调用封装在 `apps/web/src/composables/useAgent.ts` |

## 2. 需求相关模块清单

| 文件路径 | 一句话说明 |
|---|---|
| `apps/web/src/components/WorkspaceRail.vue` | **★ 核心目标组件**。左栏"工作区 · SOURCE"面板:渲染工作区卡片列表(名称 + RO/RW 徽标 + 路径 + 添加日期),卡片下方是「只读/读写」「移除」两个常显按钮;底部「添加工作区」按钮 |
| `apps/web/src/components/WorkspacePickerModal.vue` | "添加工作区"目录选择器模态窗(shell 风格:`❯` 面包屑、ls 式条目、单输入框键盘操作),非卡片列表 |
| `apps/web/src/components/InfoPanel.vue` | 右栏"观测 · OBSERVE"面板,展示**当前激活**工作区的名称/路径/只读标签/日期(只读展示,无操作按钮) |
| `apps/web/src/composables/useAgent.ts` | 工作区状态与 API:`addWorkspace`(POST)、`removeWorkspace`(DELETE)、`toggleReadOnly`(PATCH,第 282-300 行),`workspaces`/`activeWorkspaceId` 响应式数据 |
| `apps/web/src/style.css` | 全部设计 tokens(`@theme` 块)+ 全局样式(滚动条/焦点/动画),Tailwind v4 入口 |
| `apps/web/src/App.vue` | 挂载 `WorkspaceRail`(第 76 行,传 `agent` 与 `open` props)、`WorkspacePickerModal`、`InfoPanel`;三栏布局 |
| `apps/web/src/components/WorkspaceRail.test.ts` | 组件测试:验证「只读/读写」「移除」按钮常显、文案与 readOnly 状态对应、移除需确认弹窗 |
| `apps/api/src/agent/routes.ts` | 后端 workspaces CRUD 路由(DELETE 会级联删除该工作区全部会话历史文件) |

## 3. 目标组件关键代码片段(WorkspaceRail.vue)

### 3.1 工作区卡片(与截图对应的元素)

```html
<!-- 每张卡片 = 一个选中按钮(点击切换激活工作区) -->
<button type="button"
  class="group block w-full rounded-sm border-l-2 px-3 py-2.5 text-left transition-colors duration-200"
  :class="ws.id === agent.activeWorkspaceId.value
    ? 'border-l-primary bg-canvas-soft'
    : 'border-l-transparent hover:bg-canvas-soft/60'">
  <div class="flex items-center justify-between gap-2">
    <span class="truncate text-[13px] font-medium" :class="..."> {{ ws.name }} </span>
    <!-- RW/RO 徽标:胶囊形 -->
    <span class="shrink-0 rounded-full border px-2 py-px font-mono text-[10px]"
      :class="ws.readOnly ? 'border-primary/40 text-primary' : 'border-hairline text-mute'">
      {{ ws.readOnly ? 'RO' : 'RW' }}
    </span>
  </div>
  <p class="mt-1 truncate font-mono text-[10px] text-mute" :title="ws.path">{{ ws.path }}</p>
  <p class="mt-0.5 font-mono text-[11px] text-mute">添加于 {{ formatDate(ws.createdAt) }}</p>
</button>
```

数据字段(来自 `packages/shared` 的 `Workspace` 类型):`id`、`name`、`path`、`readOnly: boolean`、`createdAt: number(ms)`。

### 3.2 「只读 / 读写」与「移除」按钮(卡片下方动作行)

```html
<!-- 常显动作行(注释:不依赖 hover,键盘可达) -->
<div class="mt-1.5 flex gap-1 px-3 pb-1">
  <!-- 只读/读写 切换 -->
  <button type="button"
    class="border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary"
    :title="ws.readOnly ? '切换为读写' : '切换为只读'"
    @click="agent.toggleReadOnly(ws.id, !ws.readOnly)">
    {{ ws.readOnly ? '读写' : '只读' }}
  </button>
  <!-- 移除 -->
  <button type="button"
    class="border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-body hover:border-err/50 hover:text-err"
    title="移除" @click="handleRemove(ws.id)">移除</button>
</div>
```

### 3.3 按钮样式实现细节

| 按钮 | class 构成 | 视觉 |
|---|---|---|
| 只读/读写 | `border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary` | 小尺寸文本按钮:1px `#3d3a39` hairline 描边、画布底色、10px 等宽字体;hover 时边框与文字变**电光绿 `--color-primary`(#00d992)** |
| 移除 | `border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-body hover:border-err/50 hover:text-err` | 与只读按钮同构,仅 hover 变**错误红 `--color-err`(#f2555a)** |
| 添加工作区(底部) | `flex w-full items-center justify-center gap-1.5 rounded-sm border border-primary/50 bg-primary/5 px-2.5 py-1.5 font-display text-[11px] tracking-widest text-primary transition hover:bg-primary/10` | 主 CTA:primary 绿描边 + 5% 绿色底 + 绿色文字,display 字体、字距加宽 |

按钮风格总结:全仓库统一"**细描边 ghost 按钮**"范式 —— `border + bg-canvas + font-mono text-[10px]` 的小按钮,无填充色、无圆角(或 `rounded-sm`)、hover 靠边框/文字变色表达语义(绿=操作、红=危险)。全局 `style.css` 中 `button:not(:disabled) { cursor: pointer }`、`:focus-visible` 绿描边。

## 4. 其他发现与风险点

1. **移除有二次确认**:`handleRemove` 用 `window.confirm` 明示"会话历史文件将被永久删除,不可恢复"(注释:与 SessionSwitcher 删除会话范式一致)。
2. **三处工作区 UI 易混淆**:WorkspaceRail(列表+操作)、InfoPanel(激活工作区只读信息,含"只读/读写"标签文字)、WorkspacePickerModal(添加流程)。若需求是"改卡片样式",只动 WorkspaceRail.vue;若涉及"添加"流程则涉及 WorkspacePickerModal.vue + 后端 `/api/agent/fs/list`。
3. **非 VS Code 扩展**:仓库内无 vscode extension/webview 代码(仅 pnpm-lock 中 `vscode-uri` 是传递依赖);截图界面是浏览器中运行的 Vue 应用,风格仿 VS Code。
4. **响应式**:`<1100px`(`--breakpoint-console`)时左栏变为左侧抽屉(translate 滑入/滑出),改样式时注意 `max-console:` 前缀变体。
5. **Tailwind v4 无配置文件**:所有 tokens 在 `style.css @theme` 中,新增颜色/字号需在那里注册才能使用对应原子类。

## 5. 结论

- **可行性:高**。目标 UI 完全集中在 `apps/web/src/components/WorkspaceRail.vue`(单文件,约 150 行,无 scoped 样式,全部 Tailwind 原子类),样式 tokens 集中在 `apps/web/src/style.css`。改动影响面小、测试覆盖已有(`WorkspaceRail.test.ts`)。
- **建议**:改按钮样式直接调整 WorkspaceRail.vue 中两个按钮的 class;若引入新设计 token(颜色/圆角/阴影),在 style.css `@theme` 中注册;跑 `pnpm --filter @workflows/web test` 验证。
