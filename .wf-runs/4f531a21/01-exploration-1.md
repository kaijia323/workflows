# 01 探索报告:workflows 仓库结构 + LLM 接入方式调研

> 目标:摸清仓库技术栈、目录结构、agent 模型接入方式(provider 抽象层)、多模态/视觉支持现状,
> 为后续规划接入小米(MiMo)视觉模型提供事实依据。
> 调研对象:仓库根 `C:/Users/kaijia/codes/github/workflows`(Turborepo monorepo)。
> 说明:`.workflows/config.json` 中存在真实 DeepSeek API key,本报告一律脱敏为 `sk-***` 引用,不复制原文。

---

## 1. 仓库概览

### 1.1 技术栈

| 包 | 技术 | 说明 |
| --- | --- | --- |
| `apps/web` | Vue 3 + TypeScript + Vite + Tailwind CSS v4 + marked | 聊天/工作区/DAG UI |
| `apps/api` | Hono + `@hono/node-server` + **pi SDK**(`@earendil-works/pi-ai@0.83.0`、`@earendil-works/pi-coding-agent@0.83.0`)+ `@ff-labs/fff-node` + `@modelcontextprotocol/sdk` + `typebox` | agent 服务层,LLM 能力全部来自 pi SDK |
| `packages/shared` | 纯 TypeScript 类型 | 构建产物供 api/web 消费(改动需先 `pnpm build`) |

- 包管理器:pnpm >= 10(`packageManager: pnpm@10.33.0`),workspace glob `apps/*`、`packages/*`(`pnpm-workspace.yaml`)
- Node >= 20.19.0;monorepo 编排 turbo(`turbo.json`),lint-staged + husky
- 命令:`pnpm dev`(web 15200 / api 3000)、`pnpm build`、`pnpm start`(生产 5200 单端口)、`pnpm typecheck`、`pnpm lint`、`pnpm test`(Vitest)

### 1.2 目录结构(与任务相关部分)

```
workflows/
├── apps/api/src/
│   ├── index.ts / app.ts        # Hono 入口(生产托管 web/dist)
│   ├── config.ts                # .workflows 存储层(config.json/workspaces.json/sessions)
│   ├── mcpConfig.ts             # mcp.json 独立存储
│   ├── agent/routes.ts          # /api/agent/* 路由(配置/工作区/会话/SSE)
│   └── pi/                      # ★ LLM 服务层
│       ├── piService.ts         # ★ PiAgentService:ModelRuntime + 会话管理(核心)
│       ├── subAgent.ts          # 子代理运行器(独立 AgentSession)
│       ├── agentDefs.ts + agents/*.md  # 代理定义(orchestrator/explorer/planner/executor/reviewer)
│       ├── promptLoader.ts      # skills 加载(system prompt 注入)
│       ├── workspaceGuard.ts    # 工作区边界守卫(工具参数校验)
│       ├── fffTools.ts / anySearchTools.ts / mcpTools.ts  # 工具注册
│       ├── history.ts / runManager.ts  # 历史渲染 / run 产物管理(.wf-runs/)
├── apps/web/src/
│   ├── composables/useAgent.ts  # SSE 接入、config 状态
│   └── components/              # ChatPane / ApiKeysPanel / MessageBubble / InfoPanel ...
├── packages/shared/src/index.ts # 共享类型(AgentConfig/AgentModel/SessionEvent 等)
├── .workflows/                  # ★ 运行数据(dev;生产为 ~/.workflows)
│   ├── config.json              # ★ apiKey / anySearchApiKey / model / thinkingLevel
│   ├── mcp.json / workspaces.json / workspace-sessions.json
│   └── agent/                   # pi 隔离目录(不写 ~/.pi/agent)
│       ├── auth.json            # pi credential 存储(当前为空 {})
│       ├── models-store.json    # ★ 每 provider 的模型目录缓存(当前仅 deepseek)
│       └── settings.json        # defaultThinkingLevel: "max"
└── docs/                        # dag-workflow.md / mcp.md
```

---

## 2. 需求相关模块清单(文件路径 + 一句话说明)

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/pi/piService.ts` | ★ 唯一 LLM 接入点:`ModelRuntime.create()`、`setRuntimeApiKey('deepseek', …)`、`getModel('deepseek', id)`、`getModels('deepseek')`、`DEFAULT_MODEL='deepseek-v4-flash'`、`session.prompt(text)` |
| `apps/api/src/config.ts` | `.workflows/config.json` 读写;`StoredConfig` = `{ apiKey?, anySearchApiKey?, model?, thinkingLevel?, plannerMaxRetries? }`(单 key 字段,无 per-provider) |
| `apps/api/src/agent/routes.ts` | `/api/agent/config`、`PUT /config/key`、`POST /config/model`、`POST /config/thinking` 等路由 |
| `packages/shared/src/index.ts` | `AgentConfig` / `AgentModel`(注释「来自 pi 内置 deepseek provider」)/ `SessionEvent`(SSE 事件,纯文本) |
| `apps/web/src/components/ChatPane.vue` | 模型/思考级别快速切换按钮(模型名 `m.id.replace('deepseek-','')` 硬编码去前缀) |
| `apps/web/src/components/ApiKeysPanel.vue` | DeepSeek + AnySearch 两个 key 输入表单 |
| `apps/web/src/composables/useAgent.ts` | 前端 config 状态与 API 调用封装 |
| `apps/api/src/pi/mcpTools.ts` (L151-157) | MCP 工具结果转文本:`image/audio` 项降级为占位符 `[image, mime, bytes]` |
| `apps/api/src/pi/history.ts` | 会话历史渲染(仅 text/thinking/tool 三类 block) |
| `apps/api/src/pi/subAgent.ts` | 子代理会话(复用同一 ModelRuntime 与模型) |
| `.workflows/agent/models-store.json` | pi 的 provider 模型目录持久缓存(remote overlay) |

---

## 3. agent 如何接入模型能力(LLM 接入方式)

### 3.1 接入路径(全部经 pi SDK,仓库自身不实现任何 HTTP/LLM 协议)

1. `PiAgentService.create()`(`piService.ts` L84-104):
   ```ts
   const runtime = await ModelRuntime.create({
     authPath: path.join(store.agentDir, 'auth.json'),      // .workflows/agent/auth.json
     modelsPath: path.join(store.agentDir, 'models.json'),  // 不存在也无妨(ModelConfig 空载)
   })
   const config = loadConfig(store)
   if (config.apiKey) runtime.setRuntimeApiKey('deepseek', config.apiKey)  // ★ provider 名硬编码
   ```
2. 模型选择/列表全部限定 provider `'deepseek'`:`getModels('deepseek')`、`getModel('deepseek', id)`、`setModel()` 内 `runtime.getModel('deepseek', modelId)`、`openSession()` 内 `runtime.getModel('deepseek', stored.model ?? DEFAULT_MODEL)`。
3. 会话:`createAgentSession({ modelRuntime: this.runtime, model, … })` → `handle.session.prompt(text)`(piService.ts prompt 方法);子代理 `runSubAgent` 同样使用该 runtime。
4. 配置格式:`.workflows/config.json`(dev;prod 为 `~/.workflows/config.json`):
   ```json
   { "apiKey": "sk-***", "thinkingLevel": "max", "anySearchApiKey": "as_***" }
   ```
   key 仅存后端,前端只拿 `hasApiKey` 布尔(`config.ts` `hasApiKey()` 不返回明文)。

### 3.2 支持的 provider(由 pi-ai 0.83.0 内置,非仓库实现)

pi-ai 内置 37 个 provider(`node_modules/.pnpm/@earendil-works+pi-ai@0.83.0_*/node_modules/@earendil-works/pi-ai/dist/providers/all.js` `builtinProviders()`),
包括:**openai、anthropic、deepseek、google(gemini)、xai、groq、cerebras、mistral、minimax、moonshotai、kimi-coding、zai、qwen-token-plan、openrouter、amazon-bedrock、github-copilot、xiaomi、xiaomi-token-plan-cn/ams/sgp** 等。
认证方式统一为 `envApiKeyAuth(name, [ENV_VARS])`(`dist/auth/helpers.js`),如 `DEEPSEEK_API_KEY`、`XIAOMI_API_KEY`;运行时可用 `setRuntimeApiKey(providerId, key)` 覆盖。

### 3.3 模型列表来源(两级)

- **内置目录**:`dist/providers/data/<provider>.json`(生成产物,`models.generated.js`),例如 `deepseek.json` 含 `deepseek-v4-flash / deepseek-v4-pro`。
- **远端 overlay**:`ModelRuntime.create` 用 `withRemoteCatalog(provider, catalogBaseUrl = 'https://pi.dev', …)`(`pi-coding-agent/dist/core/remote-catalog-provider.js`)包裹每个内置 provider,启动时(及 `setRuntimeApiKey` 触发 `refresh()`)请求 `https://pi.dev/api/models/providers/:id`,结果持久化到 `.workflows/agent/models-store.json`(每 provider 一条 `{ models, checkedAt, lastModified, etag }`,4h 刷新窗口)。仓库当前 `models-store.json` 只有 `deepseek` 一条(说明尚未触发过 xiaomi 的目录加载)。

---

## 4. 模型 provider 抽象层在哪里、新增 provider 要改什么

### 4.1 抽象层位置(全部在 node_modules,仓库内无自建抽象)

- **pi-ai 层**(协议无关统一接口):`dist/models.js` 的 `createProvider({ id, name, baseUrl, auth, models, api, fetchModels? })` + `ModelsImpl`(`getModels/getModel/stream/complete/setProvider`);`dist/types.d.ts` 定义 `Model<TApi>`(`input: ("text"|"image")[]`、`thinkingLevelMap`、`compat`)、`Api`(如 `openai-completions`)、`KnownProvider`。
- **pi-coding-agent 层**:`dist/core/model-runtime.js` 的 `ModelRuntime`(实现 `Models` 接口):`create()` 组装内置 providers + remote catalog;`setRuntimeApiKey(providerId, key)`、`getModel(providerId, modelId)`、`getModels(providerId?)`、`registerNativeProvider(provider)` / `registerProvider(providerId, config)`(运行时注册自定义 provider)。
- **仓库层**:`piService.ts` 只调 `ModelRuntime` 的 API,无任何 provider 定义。

### 4.2 ★ 关键事实:xiaomi provider 已存在于 pi-ai 内置目录,无需为 pi-ai 打补丁

`dist/providers/xiaomi.js`:

```js
export function xiaomiProvider() {
  return createProvider({
    id: "xiaomi", name: "Xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
    auth: { apiKey: envApiKeyAuth("Xiaomi API key", ["XIAOMI_API_KEY"]) },
    models: Object.values(XIAOMI_MODELS),   // dist/providers/data/xiaomi.json
    api: openAICompletionsApi(),
  })
}
```

`dist/providers/data/xiaomi.json` 内置 6 个模型:

| 模型 id | 名称 | input | contextWindow / maxTokens | 备注 |
| --- | --- | --- | --- | --- |
| `mimo-v2-flash` | MiMo-V2-Flash | `["text"]` | 262144 / 65536 | 纯文本 |
| **`mimo-v2-omni`** | MiMo-V2-Omni | **`["text","image"]`** | 262144 / 131072 | ★ 视觉 |
| `mimo-v2-pro` | MiMo-V2-Pro | `["text"]` | 1048576 / 131072 | |
| **`mimo-v2.5`** | MiMo-V2.5 | **`["text","image"]`** | 1048576 / 131072 | ★ 视觉 |
| `mimo-v2.5-pro` | MiMo-V2.5-Pro | `["text"]` | 1048576 / 131072 | |
| `mimo-v2.5-pro-ultraspeed` | MiMo-V2.5-Pro-UltraSpeed | `["text"]` | 1048576 / 131072 | |

全部 `api: "openai-completions"`、`reasoning: true`、`compat: { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" }`、无 `thinkingLevelMap`(意味着思考级别走默认全量,注意与 deepseek 的 `thinkingLevelMap` 行为不同)。

另有 `xiaomi-token-plan-cn/ams/sgp` 三个配套 provider(按区域 token 计费计划,同 `api.xiaomimimo.com`)。

### 4.3 「新增 xiaomi provider 到本工作台」实际要改的文件

pi-ai 已内置 xiaomi,所以仓库侧需要改动的是把硬编码的 `'deepseek'` 泛化 + 补 UI/配置:

1. `apps/api/src/pi/piService.ts`:
   - `create()` 与 `setApiKey()`:`runtime.setRuntimeApiKey('deepseek', …)` → 按 provider 分发(如 `setRuntimeApiKey('xiaomi', key)`)
   - `listModels()` / `getConfig()` / `setModel()` / `openSession()` 中 `getModel('deepseek', …)` / `getModels('deepseek')` → 改为按当前 provider(或遍历全部 provider)
   - `DEFAULT_MODEL = 'deepseek-v4-flash'` 保留或改为可配置
2. `apps/api/src/config.ts`:`StoredConfig` 的 `apiKey` 单字段 → 需支持 per-provider(如 `apiKeys: Record<providerId, string>` 或 `xiaomiApiKey` 字段),`setApiKey`/`hasApiKey` 相应扩展(兼容旧字段)
3. `apps/api/src/agent/routes.ts`:`PUT /api/agent/config/key` 增加 provider 参数(当前只存 deepseek key)
4. `packages/shared/src/index.ts`:`AgentConfig`(如 `hasApiKey` 语义、模型列表可含多 provider)注释与类型
5. `apps/web/src/components/ApiKeysPanel.vue`:增加 Xiaomi key 输入区
6. `apps/web/src/components/ChatPane.vue` L487:`m.id.replace('deepseek-', '')` 硬编码去前缀,多 provider 时按钮需区分(且模型 id 可能跨 provider 重名,建议按钮 key/显示带 provider)

> 备选(零代码)路径:pi-coding-agent 的 `ModelConfig`(`models.json`,即 `ModelRuntime.create` 的 `modelsPath`)支持声明自定义 provider(含 `baseUrl/apiKey/api/headers/models`),但目前仓库未创建 `.workflows/agent/models.json`;该路径不解决 UI/key 管理,仅可做模型目录覆盖。

---

## 5. 视觉/图片输入(多模态)现状

### 5.1 pi SDK 层:多模态能力完整存在(仓库未使用)

- `pi-ai/dist/types.d.ts`:`ImageContent { type:"image"; data: string; mimeType: string }`(base64);`UserMessage.content: string | (TextContent|ImageContent)[]`;`Model.input: ("text"|"image")[]` 是模型能力标记。
- `pi-ai/dist/api/openai-completions.js` `convertMessages()`:user 消息中的 `ImageContent` → OpenAI `image_url`(`data:<mime>;base64,<data>`);tool result 中的图片在 `model.input.includes("image")` 时也会作为 `image_url` 附加发送。
- `pi-coding-agent/dist/core/agent-session.d.ts`:`AgentSession.prompt(text, options?: PromptOptions)` 的 `PromptOptions.images?: ImageContent[]`;另有 `steer(text, images?)`、`followUp(text, images?)`、`sendUserMessage(content: string | (TextContent|ImageContent)[])`。
- 配套工具:`dist/utils/image-convert.ts`(`convertToPng`)、`image-resize.ts`(TUI 粘贴图片用,工作台未接)。

### 5.2 仓库层:无任何视觉支持痕迹

- 前端无图片上传/粘贴;`ChatPane.vue` 输入框仅 textarea。
- `piService.ts` `prompt()` 只调 `handle.session.prompt(text)`(未传 `images`)。
- SSE/历史链路纯文本:`SessionEvent`/`HistoryBlock`(shared)只有 thinking/text/tool;`mapSessionEvent`、`history.ts` `renderHistory` 无 image 分支。
- `mcpTools.ts` L151-157 把 MCP 返回的 image/audio 内容降级为占位文本 `[image, mime, bytes]`(说明工具结果图片当前是丢弃的)。
- 子代理链路(`subAgent.ts`)同样只有文本任务参数。

→ **结论:接入小米视觉模型时,「喂图」链路需从零搭:前端取图(上传/粘贴/文件)→ base64 `ImageContent[]` → `session.prompt(text, { images })` → SSE 与历史渲染增加 image 事件/block 类型。**

---

## 6. 配置与 API key 管理方式

| 项 | 位置 | 现状 |
| --- | --- | --- |
| API key(DeepSeek) | `.workflows/config.json` `apiKey` | 明文存储(README 已声明局限);`PUT /api/agent/config/key` 写入;运行时注入 `ModelRuntime`(仅注入 provider `'deepseek'`);key 不回传前端(`hasApiKey` 布尔) |
| AnySearch key | 同文件 `anySearchApiKey` | 工具调用时动态读取;env `ANYSEARCH_API_KEY` 优先 |
| 模型选择 | 同文件 `model` | 默认 `deepseek-v4-flash`;`POST /api/agent/config/model` 切换(会话热切换 `session.setModel`) |
| 思考级别 | 同文件 `thinkingLevel` + `.workflows/agent/settings.json` `defaultThinkingLevel` | `POST /api/agent/config/thinking`;可用级别由模型 `thinkingLevelMap` 推导(`piService.availableThinkingLevels`;无 map 时默认全量) |
| pi 凭据 | `.workflows/agent/auth.json` | 当前 `{}`(`setRuntimeApiKey` 走内存 credential,不落盘) |
| 模型目录缓存 | `.workflows/agent/models-store.json` | 仅 deepseek 一条;结构 `{ [providerId]: { models, checkedAt, lastModified, etag } }` |
| 自定义 provider 覆盖 | `.workflows/agent/models.json` | 不存在(可选能力) |

---

## 7. 关键发现与风险点

1. **pi-ai 0.83.0 已内置 xiaomi provider 与两个视觉模型(mimo-v2-omni / mimo-v2.5)**,baseUrl `https://api.xiaomimimo.com/v1`,env var `XIAOMI_API_KEY` —— 底层零改动即可接入;风险是内置目录数据可能滞后/与小米实际开放模型不一致(可经 `models.json` 覆盖或等 pi.dev overlay 刷新)。
2. **仓库侧 `'deepseek'` 硬编码遍布 5+ 处**(piService.ts 的 create/setApiKey/listModels/setModel/openSession、routes.ts、ApiKeysPanel.vue、ChatPane.vue 的 `replace('deepseek-','')`、shared 注释),泛化时需全链路核对;`config.json` 是**单 key 字段**,多 provider 需设计 per-provider key 存储(注意向后兼容旧 `apiKey`)。
3. **思考级别差异**:xiaomi 模型无 `thinkingLevelMap`,`availableThinkingLevels` 会返回全量 `off..max`;小米实际可能只支持部分档位,实测需关注;`mimo-v2-omni` maxTokens 仅 131072,与 deepseek 384000 不同。
4. **视觉链路缺口**:SDK 支持(images 参数 + image_url 序列化),但工作台从输入 → SSE → 历史 → 渲染全部是文本管道,`HistoryBlock` 等类型需扩展;工具结果中的图片目前直接降级为占位文本。
5. **模型 id 冲突风险**:多 provider 后按钮以 `m.id` 为 key 且不显示 provider,`mimo-v2.5` 与未来其他 provider 可能撞 id;建议模型标识统一用 `provider:id`。
6. **`setRuntimeApiKey` 会触发 `refresh()`(网络 enabled,除非设 `PI_OFFLINE`)**,首次设置 xiaomi key 时会请求 pi.dev 拉取/校验 xiaomi 目录并写入 `models-store.json`,离线环境需注意。
7. 安全:key 明文存 `.workflows/config.json` 是既有设计(README 明示非安全边界);报告不含任何真实 key。

---

## 8. 结论:可行性判断与建议

**可行性:高。** pi SDK(pi-ai/pi-coding-agent 0.83.0)已完整内置小米 provider、视觉模型目录与多模态消息管道,仓库侧无需改任何 node_modules 内代码;全部工作落在「把硬编码 deepseek 泛化为多 provider + 补 key/模型 UI + 打通图片输入到会话/SSE/历史的链路」。

建议实施顺序(供 plan 参考):
1. **后端 provider 泛化**(piService.ts + config.ts + routes.ts + shared 类型):per-provider key 存储与注入、模型列表/切换按 provider 分发;回归 deepseek 现有流程。
2. **前端 key/模型 UI**(ApiKeysPanel + ChatPane):Xiaomi key 输入;模型按钮带 provider 标识,消除 `deepseek-` 硬编码。
3. **视觉链路**:前端图片输入(上传/粘贴)→ `session.prompt(text, { images })`;`SessionEvent`/`HistoryBlock` 增加 image 事件与渲染;子代理与 MCP 工具结果图片(当前占位丢弃)按需升级。
4. **验证清单**:小米 key 设置后 `models-store.json` 出现 xiaomi 条目;切换 `mimo-v2.5` 后思考级别档位表现;图片消息能正确序列化为 `image_url` 且历史可回放;token/费用统计(小米单价已在内置目录,`calculateCost` 自动生效)。
