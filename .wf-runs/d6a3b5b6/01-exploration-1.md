# 前端 UI 现状调研报告(workflows 仓库)

> 调研日期:2026-01(仓库当前状态)
> 调研范围:`apps/web`(前端)、`packages/shared`(数据契约)、`apps/api`(接口确认)
> 方式:只读代码阅读(组件 10 个、组合式函数、样式、测试、README、API 路由)

---

## 1. 项目整体结构

### 用途
**Web Agent 工作台**:本地运行、前后端同源的 AI 编码代理控制台。用户添加本地目录为「工作区」,
主代理(总指挥)调度 4 个子代理(explorer → planner → ⏸人工闸门 → executor ⇄ reviewer),
前端以「DAG 流水线」可视化呈现,聊天区 SSE 实时渲染思考/正文/工具调用,计划需人工批准后执行。

### 技术栈(README 表 + 代码确认)

| 包 | 技术 |
| --- | --- |
| `apps/web` | **Vue 3.5**(`<script setup>` + Composition API)+ TypeScript + Vite 8 + Tailwind CSS v4 + marked |
| `apps/api` | Hono + `@hono/node-server` + pi SDK(`@earendil-works/pi-coding-agent`、`pi-ai`) |
| `packages/shared` | 纯类型包(构建产物供 api/web 消费) |

### 仓库形态
- pnpm workspace + Turborepo(`turbo.json`:`build` 依赖 `^build` 顺序 shared → api/web)
- Node >= 20.19.0,pnpm 10.33.0;husky + lint-staged
- 测试:Vitest(web 用 `@vue/test-utils` + jsdom;api 有较多单测)

### 目录树要点
```
workflows/
├── apps/
│   ├── api/src/
│   │   ├── app.ts            # Hono app:统一错误/404、/api/health、/api/dag 示例、生产静态托管+SPA fallback
│   │   ├── index.ts          # 启动(端口 5200,可 PORT 覆盖)
│   │   ├── agent/routes.ts   # 全部 /api/agent/* 路由(见 §5)
│   │   ├── pi/               # pi SDK 服务层:piService / subAgent / runManager / history / fffTools / anySearchTools / designTools
│   │   │   └── agents/       # 子代理 markdown 定义(explorer/planner/executor/reviewer/orchestrator)
│   │   └── config.ts         # .workflows 存储(JSON 读写)
│   └── web/                  # ★ 前端(本报告主体)
│       ├── index.html        # 标题「workflows · Agent 控制台」,zh-CN
│       ├── vite.config.ts    # 端口 15200,/api 代理到 localhost:3000
│       └── src/
│           ├── main.ts       # 字体引入(@fontsource 三族)+ style.css + App
│           ├── style.css     # Tailwind v4 入口 + @theme 设计 token(核心!)
│           ├── App.vue       # 单页布局容器(无 vue-router)
│           ├── components/   # 10 个组件(见 §3)
│           ├── composables/  # useAgent.ts(全局状态 + SSE 接入)+ 单测
│           └── utils/        # markdown.ts(marked 安全渲染)
├── packages/shared/src/index.ts  # 全部数据契约类型(见 §5)
├── .workflows/               # 运行数据(开发环境,gitignore;生产在 ~/.workflows)
└── .wf-runs/<runId>/         # 每次需求处理的产物报告(本报告所在)
```

---

## 2. 前端技术栈结论

| 维度 | 结论 |
| --- | --- |
| 框架 | Vue 3.5(`<script setup>`、`reactive`/`computed`/`ref`),**无 vue-router(单页无路由)**,无 Pinia(状态集中在 `useAgent()` 组合式函数单例) |
| 构建 | Vite 8(`@vitejs/plugin-vue` + `@tailwindcss/vite`),dev 端口 **15200**,`/api` 代理到 3000 |
| 样式 | **Tailwind CSS v4**(CSS-first,`@import "tailwindcss"` + `@theme` token);组件内少量 scoped CSS;**无组件库**(无 antd/element 等),无 CSS-in-JS |
| 设计系统 | 有:**`style.css` 中 `@theme` 定义了完整 token 体系**(颜色/字体/动效曲线,主题名「管线控制台」),组件全部消费 `--color-*`/`--font-*` 变量与 Tailwind 类 |
| 图标 | `@lucide/vue`(设置/暂停/箭头/加号/X 等,零散使用) |
| Markdown | `marked` 18(走 walkTokens 转义 HTML 防 XSS、链接协议白名单、未闭合 fence 补全防闪烁) |
| 字体 | `@fontsource` 本地打包:**Chakra Petch**(display 标题)/ **Instrument Sans**(正文)/ **JetBrains Mono**(数据/代码) |
| 测试 | Vitest + @vue/test-utils + jsdom:App.test.ts(三栏渲染/断线状态)、WorkspacePickerModal.test.ts、useAgent.test.ts |
| 类型 | `@workflows/shared` 共享契约类型,`vue-tsc -b` 严格检查 |

---

## 3. 现有页面 / 组件清单(单页应用 = 1 布局 + 3 栏 + 3 模态窗)

### 3.1 App.vue — 布局容器
`h-screen flex-col` 深色底。挂载:PipelineHeader、WorkspaceRail、ChatPane、InfoPanel、底部连接错误条、
三个模态窗(ApiKeyModal / WorkspacePickerModal / SubAgentModal,`v-if` 控制)。
启动时 `agent.init()` 拉配置+工作区,再拉 `/api/agent/meta`。

### 3.2 PipelineHeader.vue — 顶栏「管线签名」(h-12)
- 左:品牌块 —— 琥珀色小方块 logo + 大写 `WORKFLOWS` + `AGENT CONSOLE`(xl 屏显示)
- 中:管线图 —— 源(工作区)→ 连线(流式时琥珀光点 `flow-dot` 沿连线流动)→ 处理(代理/模型名,运行中琥珀呼吸)→ 连线 → 观测节点
- 右:设置按钮 + `LINK` 标签 + API 连接状态胶囊(绿 ok / 红 离线)

### 3.3 WorkspaceRail.vue — 左栏「工作区 · SOURCE」(w-60)
- 工作区卡片列表:名称、RO/RW 徽章、路径(mono)、添加日期;左侧 1.5px 端口点标记激活
- hover 显示操作:只读↔读写切换、移除
- 空状态引导文案;底部「添加工作区」琥珀描边按钮 + mono 说明

### 3.4 ChatPane.vue — 中栏聊天区(flex-1,核心)
- 头部:激活工作区名称/路径/只读徽章、`N msgs`、**SessionSwitcher**
- 消息流:空状态(logo + 「AGENT 控制台」+ 未配 key 时「配置 DeepSeek API KEY」按钮);消息列表 `max-w-3xl`
- 输入区(自下而上):
  - **闸门条**(计划待批准):Pause 图标 + 摘要 + 计划文件;「批准执行」绿按钮 + 驳回意见输入 + 「驳回」红按钮
  - 发送错误 / 未配 key 提示
  - textarea(Enter 发送/Shift+Enter 换行)+ 发送(琥珀实底)/ 停止(红)
  - 快速切换:**MODEL** 分段按钮组、**THINK** 思考级别按钮组;有思考时出现「THINKING 折叠/展开全部」按钮

### 3.5 MessageBubble.vue — 消息气泡(主/子会话共用)
- 用户消息:右对齐,琥珀细边框淡底卡片,markdown 渲染
- 助手消息:左缘竖线「入边」+ 端口点,节点卡(`bg-raised/60` 细边框)按模型输出顺序渲染三类片段:
  - **THINKING** 折叠条(线缆蓝,展开后 mono 灰蓝 pre,流式时最后一块自动展开、结束自动收起,用户点击后状态以用户为准)
  - **正文** markdown(标题用 display 字体、代码块墨底 + 线缆蓝左边条、表格细边框)
  - **工具调用** 折叠条(绿/红状态点 + 中文标签如 读取/执行/修改 + 详情 pre 输出;点击:有子会话/run 则开模态窗,否则仅展开)
- 流式琥珀光标(caret-blink);错误条;页脚 mono 小字:模型 + 输入/输出/token 数

### 3.6 InfoPanel.vue — 右栏「观测 · OBSERVE」(w-72)
- 顶部 **DagPanel**(见下)
- 五个 section(9px 大写 section-label):工作区信息 / 会话状态(模型/思考/消息/运行中状态点)/ 用量(tabular-nums 指标卡:输入/输出/缓存读/合计 + 成本 $)/ 工具流(最近 8 条:绿红点 + 标签 + 时间)/ 系统(环境 + 配置目录)

### 3.7 DagPanel.vue — 流程 DAG 图(右栏顶部)
- 横向节点链:探索 → 计划 → ⏸闸门 → 执行 ⇄ 审查(回边用 ArrowLeftRight 图标)
- 节点 = 7px 方框内小方块,状态色:idle 灰 / running 琥珀呼吸 / done 绿 / error 红;审查节点显示轮次角标
- 闸门待批准时闸门节点琥珀高亮 + 下方提示条(计划文件);无 run 时显示引导文案
- 点击有 callId 的节点 → 打开 SubAgentModal

### 3.8 SubAgentModal.vue — 子代理模态窗(max-w-3xl)
- 遮罩(墨底 70% + blur)+ 面板:标题(代理名 + callId + 运行状态)、THINKING 全局折叠条、消息流(**复用 MessageBubble**)、底部「摘要 + 产物」
- 数据源:实时 `subSessions` 容器优先,缺失时拉 `/run/agents/:callId` 历史

### 3.9 ApiKeyModal.vue — 连接配置模态窗(max-w-md)
- 两个独立 section:DeepSeek key(必填,password 输入)、AnySearch key(可选,空串=清空)
- 均显示「已配置(可覆盖)/未配置」状态 + 保存反馈;底部环境信息(环境/配置目录)

### 3.10 WorkspacePickerModal.vue — 目录选择器(620px)
- **shell 式交互**:❯ 面包屑(祖先段可点击)、单输入框汇聚全部键盘操作:
  ↑↓ 选择 / Tab 前缀补全 / Enter 进入或确认 / ←·⌫ 上级 / 双击进入 / Esc 关闭
- 列表:目录条目(隐藏目录变暗)、搜索匹配段琥珀高亮(fzf 风)、选中行左侧琥珀竖条;底部路径 + 按键提示 + 「确认添加」
- 数据来自服务端 `/api/agent/fs/list`(浏览器无法枚举本地目录)

### 3.11 SessionSwitcher.vue — 会话下拉(w-60 浮层)
- 触发器:会话时间戳 + ChevronDown;下拉列出会话(时间 + N msgs)、激活项高亮、行尾 X 删除(window.confirm 确认)、底部「新建会话」

### 3.12 数据层 useAgent.ts(非组件,但 UI 骨架)
`AgentStore` = `useAgent()` 返回值,暴露:config/workspaces/activeWorkspace/sessionList/messages/streaming/
status/toolRuns/connectionError/run/subSessions/gateRequest/hasApiKey 等状态 + 约 20 个方法。
消息渲染核心:`UiMessage.segments`(text/thinking/tool 三类片段交错)→ `planBlocks()` 合并相邻同类
成渲染块(thinking-N / tool-callId 稳定 key)→ `isThinkingBlockOpen()` 折叠策略。

---

## 4. 现有 UI 风格特征(「管线控制台 / 仪表台」)

### 色彩(style.css `@theme`,全部深色)
| Token | 值 | 语义 |
| --- | --- | --- |
| ink / panel / raised / edge | `#0d1017 / #141923 / #1b2230 / #253041` | 石墨蓝画布四层层级 |
| fg / dim / faint | `#e8ecf3 / #8a94a8 / #5b6577` | 文本三级 |
| **signal** 琥珀 | `#f0a83c`(dim `#b47a26`) | 激活/流动/主操作 |
| **wire** 线缆蓝 | `#5c8bee`(dim `#3d5f9e`) | 连接/信息/思考 |
| ok / err | `#3fbf74 / #e4574f` | 少量使用 |

### 布局与形态
- 固定三栏桌面布局(左 w-60 / 中 flex-1 / 右 w-72)+ h-12 顶栏;**无响应式断点适配**(仅 xl 显示副标题),移动端不可用
- 全部**方角**(无 border-radius),1px 细边框分层;徽章/胶囊只用于状态(LINK、RO/RW、API 状态)
- **节点隐喻贯穿全局**:方块内小方块、左侧端口点、消息入边竖线、连线流动光点动画

### 字体与字号
- 三字体分工:display(Chakra Petch,标题/按钮/标签,`tracking-[0.18em~0.25em]` 宽字距大写)、body(Instrument Sans,正文 11–13px)、mono(JetBrains Mono,路径/时间/数字/技术标签 9–10.5px)
- 字号普遍极小(9–13px),信息密度高,仪表台气质;数字 `tabular-nums`

### 动效(克制)
- `flow-dot` 琥珀光点沿连线流动(1.6s,`offset-path` 风格)、`breathe` 呼吸、`msg-in`/`modal-in` 进场(180ms)、`caret-blink` 流式光标
- `prefers-reduced-motion` 全局降级;focus-visible 琥珀 outline;选中色琥珀 30%

### 整体观感
「深色工业控制台」:石墨蓝底 + 信号琥珀点睛 + 线缆蓝信息,方角细边框,大写宽字距标签,
mono 数据密度,流动光点强调「数据在管线中流动」。风格统一、完成度高,是一套完整的自研 token 体系。

---

## 5. 后端 API / 数据契约(前端取数方式)

### 通用约定
- 统一响应 `{ code, message, data }`,非 0 即错误;前端 `request<T>()` 统一解析并 throw
- 前端全部通过相对路径 `/api/...` 取数:dev 由 Vite 代理(→ 3000),生产同源(Hono 托管)
- 唯一非 JSON 响应:`POST /api/agent/workspaces/:id/prompt` 返回 **SSE 流**(`data: <json>` 行)

### 端点清单(前端实际消费)
| 方法 路径 | 用途 | 前端调用点 |
| --- | --- | --- |
| GET `/api/agent/meta` | 环境 + 配置目录 | App.vue onMounted |
| GET `/api/agent/config` | 运行配置(模型/思考/key 状态) | init / 各保存后刷新 |
| PUT `/api/agent/config/key` | 存 DeepSeek key | ApiKeyModal |
| PUT `/api/agent/config/anysearch-key` | 存 AnySearch key(空串清空) | ApiKeyModal |
| POST `/api/agent/config/model` | 切模型 | ChatPane MODEL 组 |
| POST `/api/agent/config/thinking` | 切思考级别 | ChatPane THINK 组 |
| GET `/api/agent/fs/list?path=` | 目录浏览(选工作区) | WorkspacePickerModal |
| GET/POST `/api/agent/workspaces` | 列表 / 添加 | init / Picker |
| PATCH/DELETE `/api/agent/workspaces/:id` | 只读切换 / 移除 | WorkspaceRail |
| POST `/api/agent/workspaces/:id/open` | 打开会话+恢复历史 | openWorkspace |
| GET `/api/agent/workspaces/:id/status` | 会话状态(模型/用量/流式) | refreshStatus |
| POST `/api/agent/workspaces/:id/prompt` | 发消息(**SSE 流**) | sendMessage |
| POST `/api/agent/workspaces/:id/abort` | 中止生成 | abort |
| GET `/api/agent/workspaces/:id/run` | run 快照(DAG/闸门/恢复) | refreshRun |
| GET `/api/agent/workspaces/:id/run/agents/:callId` | 子代理历史回看 | SubAgentModal |
| POST `/api/agent/workspaces/:id/sessions` | 新建会话 | SessionSwitcher |
| POST `/api/agent/workspaces/:id/sessions/:sid` | 切换会话 | SessionSwitcher |
| DELETE `/api/agent/workspaces/:id/sessions/:sid` | 删除会话 | SessionSwitcher |
| GET/POST `/api/agent/workspaces/:id/sessions` | 会话列表(open 响应内嵌) | — |

### 关键类型契约(`packages/shared/src/index.ts`)
- `Workspace{id,path,name,readOnly,createdAt}`、`AgentConfig{hasApiKey,hasAnySearchApiKey,model,thinkingLevel,models[],thinkingLevels[]}`
- `SessionStatus{model,thinkingLevel,messageCount,streaming,usage?{input,output,cacheRead,cacheWrite,totalTokens,cost}}`
- `HistoryItem{id,role,blocks:HistoryBlock[],usage?,model?}`;`HistoryBlock = thinking|text|tool{callId,name,args,output?,isError?}`
- `SessionEvent`(SSE):`text_delta/thinking_delta/tool_start/tool_update/tool_end/message_start/agent_start/agent_end/error/done`
  + 子代理镜像 `sub_message_start/sub_text_delta/sub_thinking_delta/sub_tool_start/sub_tool_update/sub_tool_end/sub_end{callId,agentName,summary,artifact,isError}`
  + `gate_required{runId,planFile,summary}`
- `RunSnapshot{runId,sessionId,status:planning|awaiting_approval|executing|reviewing|done,gate{pending,planFile},artifacts[],agents[]{callId,agent,summary,artifact,sessionFile,ts}}`
- `DirListing{path,parent,entries[]}`

---

## 6. 启动方式

```bash
pnpm install          # Node>=20.19, pnpm>=10
pnpm dev              # 前端 15200 + 后端 3000(内部)→ http://localhost:15200
pnpm build            # shared → api/web 构建
pnpm start            # 生产:仅启动已构建 API(5200,托管 web/dist)
pnpm preview          # build + start(生产模式 5200)
pnpm typecheck / lint / test   # 类型检查(web 用 vue-tsc)/ ESLint / Vitest
```
环境要求:首次使用需在设置模态窗填入 DeepSeek API key(存 `.workflows/config.json`,不写 pi 全局配置)。

---

## 7. 重新设计 UI 的关键约束与建议

### 不能破坏的接口(数据契约层)
1. **API 响应结构与错误语义**:`{code,message,data}`、非 0 = 错误;`useAgent.request()` 封装请保留或等价替换
2. **SSE 事件名与字段**(见 §5 `SessionEvent`):流式渲染完全依赖 `text_delta/thinking_delta/tool_*` 与 `sub_*`/`gate_required` 事件;改字段需同步改 `packages/shared` 与后端
3. **`AgentStore`(useAgent 返回值)是组件间的唯一状态接口**:10 个组件直接消费其状态与方法;重设计若改动其形状,全部组件需同步
4. **渲染块模型**:`UiMessage.segments`(三类片段交错)与 `planBlocks()` 合并规则、思考块按 key 的折叠状态持久化——这是流式正确性的核心,建议原样保留,UI 只换皮
5. **`/api/agent/fs/list` 目录浏览**与 `WorkspacePickerModal` 的键盘交互(↑↓/Tab/Enter/←·⌫/双击/Esc)是高频操作,重设计应保持或增强

### 需保持的交互
- 闸门「批准/驳回(带意见)」流程(通过发送特定文本续跑,前端逻辑在 ChatPane)
- 流式期间:光标跟随、自动滚底(stick-to-bottom)、停止(abort)、流式思考块自动展开/收起
- 工具块点击 = 打开子代理模态窗(有 run/sub 记录时),否则仅展开详情
- 会话:切换/新建/删除(删除有 confirm)、RO/RW 切换、断连错误条
- XSS 防线:marked 的 HTML 转义 + 链接协议白名单(renderMarkdown 管线不要绕过)

### 技术上的注意点
- **无路由**:目前是单页无 vue-router;若重设计引入多页/路由,需同步改 `app.ts` 的 SPA fallback(已就绪)与导航结构
- **响应式缺失**:固定三栏布局无移动端适配;重设计可决定是否补断点(Tailwind v4 已支持,成本可控)
- **性能**:每次 text_delta 全量重解析 marked(注释称毫秒级);若改渲染管线(如虚拟滚动/增量渲染)需重新验证长会话性能;消息列表目前是整列表渲染
- **样式改造路径**:token 集中在 `style.css @theme`(改色即改主题);组件内 Tailwind 类分散,若换组件库需逐组件重写;若保留「管线控制台」气质,推荐**保留现有 token 语义**(ink/panel/signal/wire),只调形态
- **中英混排**:界面中文为主 + 英文大写技术标签(SOURCE/OBSERVE/PIPELINE/THINKING 等),设计稿需保持双语节奏;字体已含中文回退(Noto Sans SC 等,但 display/mono 中文字体回退观感需验证)
- **测试**:App.test.ts / Picker / useAgent 测试断言了部分文案(如「工作区 · SOURCE」「观测 · OBSERVE」),改文案需同步更新测试
- **产物落盘**:`.wf-runs/<runId>/` 报告是产品特性(黑板),设计上可考虑在 UI 中展示产物链接(目前仅子代理模态窗显示 artifact 文本,未做成可点击入口)

### 结论
- **可行性:高**。前端是自研 token 体系 + Tailwind v4 的干净实现,组件边界清晰(三栏 + 模态窗)、无第三方 UI 库包袱,重新设计(换肤或重构)风险可控。
- **建议路径**:优先「保持数据层与交互逻辑、替换表现层」——保留 `useAgent.ts` 与 `MessageBubble` 的渲染块模型,重构布局/视觉 token;若引入外部设计库,注意其色彩/字体 token 与本项目 `@theme` 的映射,以及深色工业风与「管线控制台」隐喻的兼容性。
