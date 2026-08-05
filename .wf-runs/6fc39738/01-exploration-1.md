# 探索报告:workflows 仓库结构与 UI 现状

> 调研时间:本次运行;范围:仓库根 `C:/Users/kaijia/codes/github/workflows`(只读)。

## 1. 仓库概览

**这是什么项目**:`workflows` —— 基于 pi SDK 的 Web Agent 工作台(DAG 可视化骨架)。主代理(总指挥)调度 4 个内置子代理(explorer → planner → 人工闸门 → executor ⇄ reviewer),聊天界面 + 右侧 DAG 实时图;支持工作区管理、持久化会话、SSE 流式对话、DeepSeek 模型配置、skills 读取、MCP 外部工具、黑板产物(`.wf-runs/<runId>/`)。

**技术栈**(pnpm + Turborepo monorepo):

| 包 | 技术 | 说明 |
| --- | --- | --- |
| `apps/web` | Vue 3.5 + TypeScript + Vite 8 + Tailwind CSS v4(`@tailwindcss/vite`)+ marked + lucide-vue 图标 + fontsource(Inter/JetBrains Mono) | 前端控制台,无 vue-router,单页应用 |
| `apps/api` | Hono 4 + `@hono/node-server` + pi SDK(`@earendil-works/pi-coding-agent` 0.83、`pi-ai`)+ MCP SDK + fff-node | 后端 API(SSE 流式) |
| `packages/shared` | 纯 TS 类型 | 跨端共享类型(API 响应、Workspace、SessionEvent 等) |

**根配置**:`package.json`(pnpm@10.33.0、node>=20.19.0)、`pnpm-workspace.yaml`(apps/* + packages/*)、`turbo.json`(build/dev/typecheck/lint/test 任务)。

**构建/测试方式**:
- `pnpm dev` → web(15200)+ api(3000)并行;`pnpm build` → shared → api/web;`pnpm start` → 生产 API(5200,托管 web/dist);`pnpm preview` = build+start
- `pnpm typecheck` / `pnpm lint` / `pnpm test` 均走 turbo 并行
- 运行数据(API key/工作区/会话)存 `.workflows/`(dev 下 gitignored,生产 `~/.workflows`);黑板产物落 `.wf-runs/<runId>/`

## 2. 需求相关模块清单(UI 焦点)

### 页面与入口
- `apps/web/index.html` — SPA 入口,`<title>workflows · Agent 控制台</title>`,挂载 `/src/main.ts`
- `apps/web/src/main.ts` — 应用启动:注册字体(Inter 400-700、JetBrains Mono 400/500)、引入 `style.css`、挂载 App
- `apps/web/src/App.vue` — 根布局:整体三栏管线布局(见 §4),持有全局状态 `useAgent()`,挂载 4 个模态窗

### 布局组件(左源 → 中处理 → 右观测)
- `apps/web/src/components/PipelineHeader.vue` — 顶部 48px 头部:品牌 WORKFLOWS + 「工作区 → 代理 → 观测」管线签名(流式时绿色光点沿连线流动)+ LINK/API 状态灯 + 设置入口
- `apps/web/src/components/WorkspaceRail.vue` — 左栏 240px:工作区列表(只读 RO/读写 RW 徽标、hover 切换/移除)、添加工作区按钮
- `apps/web/src/components/ChatPane.vue` — 中栏(弹性):消息流 + 输入区;`/` skill 搜索下拉(方向键/IME 兼容)、计划闸门批准/驳回条、停止/发送按钮、MODEL/THINK 快速切换、THINKING 全部折叠
- `apps/web/src/components/InfoPanel.vue` — 右栏 288px:观测面板(工作区/会话/Token 用量/工具流/系统 5 个 section)+ 内嵌 `DagPanel`
- `apps/web/src/components/DagPanel.vue` — DAG 图:探索/计划/⏸闸门/执行/审查节点,运行/完成/错误/空闲状态色,点击节点打开子代理模态窗

### 消息与模态
- `apps/web/src/components/MessageBubble.vue` — 消息渲染:用户右对齐气泡;助手为行式块(思考/正文/工具按输出顺序交错),含 markdown 样式、流式光标、token 页脚
- `apps/web/src/components/SubAgentModal.vue` — 子代理完整对话模态窗(实时容器 → 历史 JSONL 回看)+ 产物链接
- `apps/web/src/components/WorkspacePickerModal.vue` — 目录选择器(服务端枚举,shell 风格交互)
- `apps/web/src/components/ApiKeyModal.vue` / `ApiKeysPanel.vue` / `McpPanel.vue` — 设置模态窗:API key 面板 + MCP server 配置面板
- `apps/web/src/components/SessionSwitcher.vue` — 会话切换/新建/删除

### 状态与工具
- `apps/web/src/composables/useAgent.ts` — 核心组合式:SSE 接入、消息聚合(segments → PlanBlock)、run 快照、闸门、子代理容器
- `apps/web/src/utils/markdown.ts` — marked 渲染:HTML 转义、链接协议白名单(https/mailto)、流式未闭合 fence 补全
- `apps/web/src/style.css` — 全部设计 token(Tailwind v4 `@theme`)与全局动画

### 样式方案(设计语言 "VoltAgent")
- 近黑画布 `#101010` + 层级 `#1a1a1a/#202020`,1px hairline `#3d3a39` 描边分层
- 单一电光绿 `#00d992` 作为唯一强调色(CTA/激活/运行/成功),`#f2555a` 红仅驳回/失败
- 文本 `#f2f2f2`(ink)/`#bdbdbd`(body)/`#8b949e`(mute);字体 Inter + JetBrains Mono;圆角 4/6/8px;glow 阴影仅 hover;动效 ease-flow
- 特征:10px 宽字距英文标签(如 `工作区 · SOURCE`)、mono 小字元数据、细滚动条、`prefers-reduced-motion` 降级

### API(前端消费,前缀 `/api`)
`apps/api/src/app.ts`(Hono 应用、统一 `{code,message,data}`、错误/404 处理、生产托管 dist)、`apps/api/src/index.ts`(端口:dev 3000 / prod 5200,可 PORT 覆盖;优雅退出)、`apps/api/src/agent/routes.ts`(agent 全部路由:config/workspaces/prompt SSE/run/mcp/skills 等)、`apps/api/src/config.ts`(`.workflows` JSON 存储)、`apps/api/src/pi/*`(pi SDK 服务层:piService、runManager、subAgent、workspaceGuard、mcpTools、skillsLoader、fffTools、anySearchTools、history、promptLoader、agents/ 内置代理 markdown)

## 3. 关键发现与风险点

1. **端口 15200 归属明确**:`apps/web/vite.config.ts` 中 `server.port: 15200`,为 Vite dev server 唯一对外入口,`/api` 代理到 `http://localhost:3000`(api dev 端口,内部)。生产单端口 5200(Hono 托管前端 + API 同源)。
2. **UI 已相当完整**:三栏管线布局 + DAG + 4 模态窗 + skill 下拉 + 闸门交互均已在库,非空白骨架;README 与代码注释高度详尽(中文),文档即设计规范。
3. **无 vue-router**:单页应用,无路由层;页面切换依赖条件渲染(模态窗 `v-if`)。
4. **工具链齐备**:三包均有 `eslint.config.mjs`(eslint 10 + typescript-eslint + eslint-plugin-vue flat config);测试为 Vitest 4 + jsdom + @vue/test-utils(web),api 侧 14 个测试文件覆盖核心逻辑;根有 husky + lint-staged(eslint --fix);typecheck 用 vue-tsc。
5. **测试样例**:`App.test.ts` 以 stub fetch 断言渲染;`ChatPane.test.ts`、`McpPanel.test.ts`、`WorkspacePickerModal.test.ts`、`useAgent.test.ts` 覆盖交互与 SSE 聚合。
6. **注意点**:
   - `.workflows/`(dev 数据,含 mcp.json/config.json)已在工作区内但被 gitignore——若把仓库根作为工作区,agent 的 bash/write 可触及(README 自述的既有信任模型局限);
   - 测试运行 `pnpm test` 依赖 `build`(turbo `test.dependsOn: ["^build"]`);
   - Tailwind v4 无 tailwind.config.js,全部 token 集中在 `style.css` 的 `@theme` 中——改主题只动这一个文件。

## 4. 结论:可行性判断与建议

- **可行性:高**。项目是成熟、文档完备的 monorepo;UI 现状清晰:三栏管线 + DAG + 模态窗 + 完整交互,工具链(lint/typecheck/test/husky)全部就位。
- **若后续任务是改 UI**:直接改 `apps/web/src/components/*.vue` 与 `style.css`(token 单一来源),`pnpm dev` 后访问 `http://localhost:15200` 即可预览;新增页面组件需挂到 App.vue(无路由)。
- **若后续任务是加功能**:优先复用 `useAgent.ts` 的 AgentStore 模式与 shared 包类型;前后端契约走 `/api` + 统一 `{code,message,data}` 结构;测试照 `App.test.ts` 的 stub-fetch 方式。
- **建议**:改动前先跑 `pnpm typecheck && pnpm lint`(turbo 并行,快);涉及样式时保持 VoltAgent token 体系(勿硬编码颜色/字体)。
