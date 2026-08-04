# 探索报告:为 pi SDK 添加自定义工具(AnySearch 网络搜索)

> 任务:调研 `workflows` 项目,产出「为 pi SDK 添加自定义工具(网络搜索,AnySearch Search API)」的可行性报告。
> 结论先行:**完全可行,且项目内已有 5+ 个现成自定义工具样例可循**;建议按「新文件 `apps/api/src/pi/anySearchTool.ts` + 在 `piService.openSession` 的 `customTools`/`tools` 白名单注册」的路径落地。唯一未闭环点:AnySearch API 文档页本次未能联网抓取(见 §6)。

---

## 1. 仓库概览

- **形态**:Turborepo + pnpm 10 monorepo(`pnpm-workspace.yaml`:`apps/*`、`packages/*`),Node >= 20.19.0。
- **结构**:
  - `apps/web` — Vue 3 + TypeScript + Vite + Tailwind v4(工作台前端,SSE 渲染)。
  - `apps/api` — Hono + `@hono/node-server` + **pi SDK**(`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`)+ `@ff-labs/fff-node` + `unbash` + `typebox`。
  - `packages/shared` — 跨端共享类型(改动后需 `pnpm build`)。
  - `docs/dag-workflow.md` — 工作流编排设计文档(run/闸门/子代理语义)。
  - `.workflows/`(gitignored)— 本地运行数据:`config.json`(API key/模型/思考级别)、`agent/`(pi ModelRuntime 的 auth/models/会话)、`agents/`、`workspaces.json`、`workspace-sessions.json`。
  - 产物目录:`<workspace>/.wf-runs/<runId>/`(本报告即在此)。
- **构建/测试**:`pnpm install` → `pnpm dev`(web 15200 / api 3000);`pnpm build`(shared→api/web,api 构建会 `scripts/copy-agents.mjs` 复制 agents/*.md);`pnpm --filter @workflows/api test|typecheck|lint`(Vitest,`apps/api/src/pi/*.test.ts` 共 6 个测试文件)。
- **关键设计约束**:项目**不读取/不修改 pi 全局配置(`~/.pi/agent`)**,一切数据隔离在项目自身 `.workflows/`(开发)/ `~/.workflows`(生产);DeepSeek API key 由用户手动输入存 `.workflows/config.json`,运行时经 `runtime.setRuntimeApiKey('deepseek', key)` 注入。

## 2. 需求相关模块清单(现有自定义工具代码)

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/pi/fffTools.ts` | **最佳参考样例**:fff-find / fff-grep 两个自定义工具完整实现(索引管理 + TypeBox schema + ToolDefinition + 结果格式化/截断) |
| `apps/api/src/pi/piService.ts` | 主服务层:`openSession` 中组装 `customTools` + `tools` 白名单;内联定义子代理工具/闸门工具/完成任务工具 |
| `apps/api/src/pi/workspaceGuard.ts` | `guardPathTool()` 包装工具做路径越界校验;`toToolDefinition()` 把 SDK 内置工具转成 customTools 形式 |
| `apps/api/src/pi/subAgent.ts` | 子代理会话的工具集构建(`buildSubAgentTools`:只读工具 + fff 搜索 + write 白名单) |
| `apps/api/src/config.ts` | `.workflows/config.json` 读写(API key 存储) |
| `apps/api/src/agent/routes.ts` | HTTP 路由:`PUT /api/agent/config/key` 接收用户输入的 API key |
| `apps/api/src/index.ts` | 启动入口(端口 `PORT` 环境变量) |
| `apps/api/package.json` | 依赖声明(`@earendil-works/pi-coding-agent@^0.83.0`、`typebox@1.3.7` 等) |

### 2.1 写法样例 A:独立工厂函数(fffTools.ts,推荐新工具照此写)

```ts
import { Type, type Static } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'

const findSchema = Type.Object({
  pattern: Type.String({ description: '搜索模式...' }),
  mode: Type.Optional(Type.Union([Type.Literal('glob'), Type.Literal('fuzzy')], { description: '...' })),
  path: Type.Optional(Type.String({ description: '限定搜索的子目录...' })),
  limit: Type.Optional(Type.Number({ description: '最多返回条数(默认 1000)' })),
})
type FindParams = Static<typeof findSchema>

export function createFffFindTool(finder: FileFinder, workspacePath: string): ToolDefinition<typeof findSchema> {
  return {
    name: 'fff-find',
    label: 'fff-find',
    description: '基于实时索引的文件名搜索(毫秒级,索引随文件变化自动更新)。...',
    promptSnippet: 'Search filenames by glob or fuzzy pattern (fast indexed search)',
    parameters: findSchema,
    async execute(_toolCallId, params: FindParams, signal, _onUpdate): Promise<AgentToolResult<undefined>> {
      abortIfSignaled(signal)
      // ... 调用底层、格式化、截断(50KB / 1000 行)
      return { content: [{ type: 'text', text: output }], details: undefined }
    },
  }
}
```

### 2.2 写法样例 B:内联定义 + 注册(piService.ts `openSession`,主代理工具)

```ts
// 组装:guardedTools(内置工具包装)+ subAgentTools(子代理/闸门/完成)
const { session } = await createAgentSession({
  cwd: workspace.path,
  agentDir: this.store.agentDir,
  modelRuntime: this.runtime,
  model,
  thinkingLevel,
  sessionManager,
  resourceLoader: mainResourceLoader,
  customTools: [...guardedTools, ...subAgentTools],   // ← 自定义工具注册点
  tools: [...activeTools, ...subAgentTools.map((t) => t.name)],  // ← 白名单,不列即不开放
})
```

内联工具样例(piService.ts `createSubAgentTool`,用 `Type` 来自 typebox):

```ts
const params = Type.Object({
  task: Type.String({ description: '交给子代理的任务说明(要具体:目标、范围、约束)' }),
})
return {
  name,                          // def.frontmatter.name
  label: name,
  description: `${description}。调用后返回子代理的最终摘要;...`,
  promptSnippet: `Invoke sub-agent ${name}`,
  parameters: params,
  execute: async (callId, params, signal, onUpdate) => {
    // ...
    return { content: [{ type: 'text' as const, text: result.summary }], details: undefined }
  },
}
```

要点:注册的 `customTools` 必须同时在 `tools` 白名单中显式列出(注释原文:「SDK 的 allowedToolNames(tools 参数)会过滤 customTools 注册表」)。

## 3. pi SDK 依赖情况

- `apps/api/package.json` 直接依赖:`@earendil-works/pi-ai@^0.83.0`、`@earendil-works/pi-coding-agent@^0.83.0`、`typebox@1.3.7`、`@ff-labs/fff-node@0.10.1`、`hono@^4.12.34`、`unbash@^4.0.5` 等。
- **无 `pi.json` 或扩展入口文件**:本项目不走 pi CLI 的扩展发现机制(`.pi/extensions/`、`~/.pi/agent/extensions/`),而是**纯 SDK 编程式集成**——`createAgentSession({ customTools })` 直接注入。`promptLoader.ts` 中 `getExtensions: () => ({ extensions: [], errors: [], runtime })` 显式空扩展,印证这一点。
- 安装位置:`node_modules/.pnpm/@earendil-works+pi-coding-agent@0.83.0_ws@8.21.1_zod@4.4.3/node_modules/@earendil-works/pi-coding-agent/`(SDK 自身依赖 `typebox@1.3.7`;`zod@4.4.3` 仅是其传递依赖,来自 `@anthropic-ai/sdk` 等,**自定义工具不需要 zod**)。

## 4. pi SDK 自定义工具(Custom Tools)机制总结

依据:`docs/sdk.md`(Custom Tools 一节)、`docs/extensions.md`(Custom Tools 一章)、`examples/sdk/05-tools.ts`、`examples/sdk/06-extensions.ts`、`examples/extensions/dynamic-tools.ts`、`dist/core/extensions/types.d.ts` 中 `ToolDefinition` 类型定义。

### 4.1 ToolDefinition 字段(官方类型,必填/选填一目了然)

```ts
interface ToolDefinition<TParams extends TSchema, TDetails = unknown, TState = any> {
  name: string                                    // 必填:LLM 工具调用名
  label: string                                   // 必填:UI 显示名
  description: string                             // 必填:给 LLM 的描述
  promptSnippet?: string                          // 选填:系统提示 Available tools 单行摘要
  promptGuidelines?: string[]                     // 选填:附加 Guidelines 子弹(须自报工具名)
  parameters: TParams                             // 必填:TypeBox schema
  constrainedSampling?: false | ConstrainedSamplingConfig
  renderShell?: 'default' | 'self'
  prepareArguments?: (args: unknown) => Static<TParams>  // 选填:兼容旧参数
  executionMode?: ToolExecutionMode               // 'sequential' | 'parallel'
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>  // 必填
  renderCall?: ...; renderResult?: ...            // 选填:TUI 自定义渲染
}
```

- 参数 schema 用 **typebox**(`Type.Object({...})`),**不需要 zod**;字符串枚举用 `StringEnum`(来自 `@earendil-works/pi-ai`)以兼容 Google API。
- `execute` 返回 `{ content: [{ type: 'text', text }], details }`;**抛错 = 工具失败**(isError=true 报给 LLM);输出**必须截断**(内置上限 50KB / 2000 行,可用 `truncateHead` 等工具函数)。
- 独立定义(非内联)建议用 `defineTool({...})` 保持参数类型推断(项目内 fffTools.ts 未用,直接 `ToolDefinition<typeof schema>` 泛型标注亦可)。

### 4.2 两种注册入口

1. **SDK 方式(本项目采用)**:`createAgentSession({ customTools: [tool], tools: ['read', ..., 'my_tool'] })` — customTools 与扩展注册的工具合并,`tools` 是白名单。
2. **扩展方式(CLI 场景)**:`.pi/extensions/*.ts` 默认导出 `(pi: ExtensionAPI) => void`,内调 `pi.registerTool({...})`;`DefaultResourceLoader` 自动发现。本项目未用。

### 4.3 项目内现成参考

- 完整独立工具:`apps/api/src/pi/fffTools.ts`(`createFffFindTool` / `createFffGrepTool`)。
- 内联工具:`piService.ts` 的 `createSubAgentTool` / `createWaitForApprovalTool` / `createCompleteTaskTool`。
- 工具包装/守卫:`workspaceGuard.ts`(`guardPathTool` 包 execute 前置校验;网络搜索工具不涉及路径,可不包)。
- 测试样例:`fffTools.test.ts`、`workspaceGuard.test.ts`(Vitest,构造 ToolDefinition 直接调 execute 断言)。

## 5. API key 配置方式与环境变量约定

- **现状:无 `.env` 文件**(`fff-find .env*` 无结果;`.gitignore` 忽略 `.env`/`.env.*` 但保留 `.env.example`,项目中也不存在 `.env.example`)。
- **本项目密钥存储**:`.workflows/config.json`(开发)/ `~/.workflows/config.json`(生产),结构 `{ apiKey, model, thinkingLevel }`;用户经 `PUT /api/agent/config/key` 提交 → `config.ts:setApiKey` 落盘 → `piService.setApiKey` 调 `runtime.setRuntimeApiKey('deepseek', key)` 运行时注入(不持久化到 pi auth.json)。当前文件实测含 `apiKey`、`thinkingLevel: "max"`。
- **用到的环境变量**:`NODE_ENV`(存储根目录/端口)、`PORT`(生产端口 5200)、`HOME`/`USERPROFILE`、`TEMP`/`TMP`/`TMPDIR`。
- **pi 生态的 provider key 约定**:`ModelRuntime` 认证优先级 = 运行时覆盖(`setRuntimeApiKey`)→ `auth.json` → **环境变量**(如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`)→ fallback;provider 配置里可用 `$ENV_VAR` / `${ENV_VAR}` 引用环境变量。SDK 文档环境变量清单含 `HTTP_PROXY`/`HTTPS_PROXY`。
- **建议**:AnySearch key 遵循同一模式——方案 A(推荐,与现有 DeepSeek key 一致):存入 `.workflows/config.json`(扩展 `StoredConfig` 增加 `anySearchApiKey`),提供 `PUT /api/agent/config/key` 类似接口或复用;方案 B:环境变量 `ANYSEARCH_API_KEY`(需在工具执行时读取,注意 bash 子进程与 api 进程环境隔离)。环境变量命名若依惯例为 `ANYSEARCH_API_KEY`(待与官方文档核对,见 §6)。

## 6. AnySearch Search API(https://www.anysearch.com/docs#search-api)

### 6.1 本次调研限制(如实说明)

本会话工具集仅含 `read`(本地文件)、`ls`、`fff-find`、`fff-grep`、`write`,**无 bash/curl 可执行工具,`read` 无法抓取 URL**(实测 `read https://www.anysearch.com/docs` 报 ENOENT 本地路径)。工作区内全文搜索 `anysearch` 亦无缓存资料。**因此以下 API 细节未能从官方文档核实,标注为「待验证」,落地前必须人工确认。**

### 6.2 待验证清单(打开 https://www.anysearch.com/docs#search-api 逐项确认)

1. **端点**:Search API 的完整 URL(常见形态如 `https://api.anysearch.com/v1/search` 或文档页给出的其他路径)。
2. **认证方式**:API key 放哪——`Authorization: Bearer <key>` 请求头 / `X-API-Key` 头 / query 参数;key 从何处获取(控制台/订阅页)。
3. **请求参数**:必填(query 关键字等)与选填(语言、地区、数量 limit、页码、搜索类型 web/news/image 等)字段名与取值。
4. **响应结构**:结果列表字段(标题、URL、摘要/正文片段、发布时间、站点等)、分页字段、错误码语义(401 无 key、429 限流)。
5. **免费额度**:注册后的免费额度/速率限制(如每日请求数、QPS),以及超限行为。

### 6.3 最小调用示例(模板,占位符待按官方文档替换)

```bash
# 假设端点与认证(以最常见的 REST 搜索 API 形态给出,字段名待官方文档核实后替换)
curl -sS "https://api.anysearch.com/v1/search" \
  -H "Authorization: Bearer $ANYSEARCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "pi coding agent SDK custom tools", "limit": 5}'
```

### 6.4 集成建议(API 细节确认后照此实现)

- 新建 `apps/api/src/pi/anySearchTool.ts`,仿 `fffTools.ts` 导出 `createAnySearchTool(): ToolDefinition`(或接收 key 解析函数),内部用 Node 原生 `fetch`(Node >= 20.19 内置)。
- 参数 schema(TypeBox):`query`(必填,string)、`limit`/`maxResults`(选填,number)、可选语言/区域字段。
- `execute` 内:`fetch(..., { signal })`(透传 AbortSignal,支持用户中止)→ 校验响应状态 → 提取标题/URL/摘要 → **按 50KB 截断**后返回 `{ content: [{ type: 'text', text }], details: { raw } }`;错误(401/429/网络)抛 Error 或返回错误文本。
- 在 `piService.openSession` 的 `customTools` 数组追加,并在 `tools` 白名单加工具名(注意同时考虑只读工作区与 `subAgent.buildSubAgentTools`,按需求决定子代理是否可用搜索)。
- key 管理走 `.workflows/config.json` 扩展 + 运行时注入(与 DeepSeek key 同模式),避免硬编码与进 git。
- 补测试 `anySearchTool.test.ts`(mock fetch,断言参数构造/结果格式化/截断/错误路径)。

## 7. 结论:可行性判断与建议

- **可行性:高**。机制上 pi SDK 0.83 原生支持 `customTools`(TypeBox schema + execute),本项目已有 fff 工具、子代理工具、闸门工具等多个生产级样例,注册链路(`piService.openSession`)清晰、有测试范式。
- **不需要** zod、不需要 pi.json、不需要扩展文件——纯 SDK 注入即可。
- **前置阻塞项仅一个**:AnySearch API 官方文档未核实(端点/认证/参数/响应/额度)。建议下一步:人工用浏览器或 curl 抓取 https://www.anysearch.com/docs#search-api,回填 §6.2 清单后再进入实现;实现时严格按「新文件 + 工厂函数 + 注册 + 白名单 + 测试」的项目惯例落地。
- **风险点**:
  1. 网络工具打破「工作区边界」语义——搜索工具不触碰本地路径,无越界风险,但需在描述中明确其输出为外部网络内容(信息可信度提示)。
  2. key 泄露风险——key 不得进 git(现有 `.workflows/` 已 gitignore,`config.json` 安全);不要放进工具描述或日志。
  3. 输出体积——必须截断(50KB),否则污染 LLM 上下文(项目 fff 工具已有 50KB 截断先例)。
  4. 与 `guardPathTool` 无关(无 path 参数),但若搜索工具被主代理白名单之外使用,注意 `tools` 白名单过滤行为(不列即不可用)。
