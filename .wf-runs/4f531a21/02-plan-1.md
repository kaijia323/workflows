# 02 实施计划:为 workflows 接入小米视觉模型(识图能力)

> 依据:`.wf-runs/4f531a21/01-exploration-1.md`(事实来源,以下简称 E1)+ 本文撰写时对关键文件的复核
> (piService.ts / config.ts / routes.ts / shared / useAgent.ts / ChatPane.vue / ApiKeysPanel.vue / MessageBubble.vue /
> history.ts / mcpTools.ts / pi-ai 0.83.0 的 types.d.ts、agent-session.d.ts、model-runtime.d.ts、providers/xiaomi.js、data/xiaomi.json)。
>
> 复核新增确认的关键事实(探索报告之外):
> - `ModelRuntime.setRuntimeApiKey(providerId, apiKey, refreshOptions?): Promise<void>`(异步,会触发网络目录刷新);`getModels(providerId?)`、`getModel(providerId, modelId)` 均按 provider 分发。
> - `AgentSession.prompt(text, options?: PromptOptions)`,`PromptOptions.images?: ImageContent[]`;`ImageContent` 从 `@earendil-works/pi-ai/compat` 导出(`{ type:'image'; data: string; mimeType: string }`,data 为**裸 base64,无 `data:` 前缀**)。
> - xiaomi 内置目录 6 模型全量确认:`mimo-v2.5` 为 `input: ["text","image"]`、contextWindow 1048576、maxTokens 131072、`compat.thinkingFormat: "deepseek"`、**无 thinkingLevelMap**。
> - 仓库已有验证脚本范式:`apps/api/scripts/verify-anysearch.mjs`(无依赖、不打印 key、失败非零退出),新脚本照此风格。
> - 现有测试:`apps/api/src/config.test.ts`、`pi/history.test.ts`、`app.test.ts`、`pi/piService.test.ts`(私有构造注入 fake runtime)、`apps/web/src/composables/useAgent.test.ts`、`components/ChatPane.test.ts`、`MessageBubble.test.ts`。
> - `.workflows/config.json` 现为 `{ apiKey, thinkingLevel: "max", anySearchApiKey }`(无 `model` 字段 → 走默认)。

---

## 1. 目标与范围

### 1.1 做什么

1. **后端 provider 泛化**:把 `'deepseek'` 硬编码泛化为多 provider(deepseek + xiaomi),per-provider API key 存储/注入/校验,模型列表与切换按 provider 分发。**零 node_modules 改动**:直接使用 pi-ai 0.83.0 内置 `xiaomi` provider(id `xiaomi`,baseUrl `https://api.xiaomimimo.com/v1`,env `XIAOMI_API_KEY`)与内置模型目录(含 `mimo-v2.5` 视觉模型)。
2. **前端配置 UI 泛化**:ApiKeysPanel 增加 Xiaomi key 输入;ChatPane 模型按钮支持多 provider(复合标识 `provider:id`),移除 `m.id.replace('deepseek-','')` 硬编码;无 key 的 provider 模型置灰标注。
3. **视觉链路**:前端图片上传/粘贴 → base64 → `POST /prompt`(images)→ `session.prompt(text, { images })` → 流式回复;会话历史(JSONL 已由 pi SDK 自动持久化图片 base64)增加 image block 渲染,**至少覆盖本次会话内**(刷新/切会话可回放)。
4. **模型目录治理**:按任务要求将 `mimo-v2-omni / mimo-v2-pro / mimo-v2-flash` 标记为已下线并从 UI 列表过滤(解析层保留,旧存储引用不炸)。
5. **验证**:离线单元测试 + 无依赖验证脚本(`verify-xiaomi.mjs`,可指向本地 mock)+ 真实 key 冒烟清单 + 构建/类型检查全绿 + deepseek 全流程回归。

### 1.2 不做什么(范围外,记录为 follow-up)

- **不**修改任何 `node_modules` 内 pi SDK 代码。
- **不**接入 `xiaomi-token-plan-cn/ams/sgp` 套餐 provider(按量付费 `xiaomi` 即可;如需可后续一行白名单扩展)。
- **不**做子代理(sub_*)传图:主代理会话图片不转发给子代理(子代理任务参数保持纯文本)。
- **不**升级 MCP 工具结果图片(`mcpTools.ts` 的 `[image, mime, bytes]` 占位降级保持现状)。
- **不**做图片跨会话归档/导出/磁盘压缩(JSONL 内 base64 直存,已知体积膨胀风险,见 §5)。
- **不**新增 SSE 事件类型:用户图片由前端本地即时渲染,历史回放走 `getHistory`/`renderHistory`。
- **不**做 key 真伪校验(与现状一致:保存即注入,不验证;真伪由验证脚本与冒烟测试负责)。
- **不**迁移 `apiKey` 旧字段(见决策 D2,零迁移风险)。

---

## 2. 设计决策(实现前确认,标 ❓ 的需要你拍板)

| # | 决策 | 结论 |
| --- | --- | --- |
| D1 | 模型标识 | config.json `model` 改为复合标识 **`provider:id`**(如 `xiaomi:mimo-v2.5`);向后兼容裸 id(`deepseek-v4-flash` 无冒号 → 视为 deepseek)。工具函数 `parseModelRef()`。`AgentConfig.model` 返回复合标识,前端拆分展示。 |
| D2 | per-provider key 存储 | `StoredConfig` 新增 `apiKeys: Record<string,string>`(deepseek 也写入,同时**继续写旧 `apiKey` 字段**,双写保兼容);读取 `getApiKey(store, provider)`:deepseek → `apiKeys.deepseek ?? apiKey`,其他 → `apiKeys[provider]`。零迁移。 |
| D3 | 支持 provider 白名单 | `SUPPORTED_PROVIDERS = ['deepseek', 'xiaomi']` + `PROVIDER_NAMES` 显示名映射(piService.ts 导出)。模型列表 = 遍历白名单合并,顺序 deepseek → xiaomi。 |
| D4 ❓ | 已下线模型 | `DEPRECATED_MODEL_IDS = { xiaomi: ['mimo-v2-omni', 'mimo-v2-pro', 'mimo-v2-flash'] }`(按任务要求三款全标;E1 内置目录仅 omni/pro 明确标注,flash 以 pi.dev overlay 实际目录为准,上线前冒烟确认,可一键增删)。**处理:从 UI 列表过滤隐藏,解析层保留**。 |
| D5 | 图片链路 | 前端压缩(长边 ≤2048px、JPEG q0.85、透明 PNG 保留格式、单张输出 ≤5MB、每消息 ≤8 张)→ 发送 `images: [{ data: 裸 base64, mimeType }]` → 后端白名单校验(jpeg/png/gif/webp + 大小) → `session.prompt(text, { images })`。 |
| D6 | key 校验时机 | (a) 保存 key:只存+注入,不验证;(b) 切模型:目标 provider 无 key → 400「请先配置 {provider} API key」;(c) prompt 路由:按**当前模型 provider** 校验(替代现在的 `hasApiKey(store)` deepseek 语义)。 |
| D7 | thinkingLevel 兜底 | xiaomi 无 `thinkingLevelMap` → `availableThinkingLevels` 返回全量 `off..max`(E1 风险点 3)。预实现空常量 `MODEL_THINKING_OVERRIDES: Record<string, string[]>`(key=`provider:id`),冒烟发现实际档位后填值约束;默认空 = 保持 SDK 行为。 |
| D8 | 验证脚本 | 新增 `apps/api/scripts/verify-xiaomi.mjs`(仿 verify-anysearch:无依赖、不打印 key、失败非零退出),支持 `--base-url` 指向本地 mock server 做离线验证;文本 + 视觉(image_url)两种请求。 |

---

## 3. 实施步骤

> 图例:🔑 = 此步需要用户提供小米 API key;❓ = 此步需要用户决策。每 Phase 结束一个可独立回滚的 commit。

### Phase 0:基线确认(无代码改动)

- [ ] 0.1 确认 git 工作区干净(`git status`);跑 `pnpm install`(如有 lock 变动)。
- [ ] 0.2 基线:`pnpm build && pnpm typecheck && pnpm test` 全绿(记录基线耗时,便于对比回归)。

### Phase 1:后端 provider 泛化(commit c1)

**1.1 `packages/shared/src/index.ts` 类型扩展**
- `AgentModel` 增加 `input: ('text' | 'image')[]`、`deprecated?: boolean`;更新顶部注释(去掉「来自 pi 内置 deepseek provider」)。
- `AgentConfig` 增加 `providers: Array<{ id: string; name: string; hasKey: boolean }>`;`model` 注释改为「复合标识 provider:id」;`hasApiKey` 注释改为「DeepSeek key 是否配置(兼容旧语义)」。
- `HistoryBlock` 增加联合成员 `{ type: 'image'; data: string; mimeType: string }`(data 为裸 base64)。
- 预期:共享类型先行落地,api/web 编译期消费新字段;`pnpm --filter @workflows/shared build` 通过。

**1.2 `apps/api/src/config.ts` per-provider key 存储**
- `StoredConfig` 增加 `apiKeys?: Record<string, string>`。
- `setApiKey(store, key)` → `setApiKey(store, provider, key)`:写 `apiKeys[provider]`;`provider === 'deepseek'` 时**同时写旧 `apiKey` 字段**(双写保兼容)。
- 新增 `getApiKey(store, provider): string | undefined`(规则见 D2);`hasApiKey(store, provider?)`:无参 = 旧语义(deepseek),带参按 provider。
- 同步更新 `apps/api/src/config.test.ts`(新增 per-provider 用例:双写、fallback、空串删除)。

**1.3 `apps/api/src/pi/piService.ts` provider 泛化(核心)**
- 顶部常量:`SUPPORTED_PROVIDERS`、`PROVIDER_NAMES`、`DEPRECATED_MODEL_IDS`、`MODEL_THINKING_OVERRIDES`;`DEFAULT_MODEL` 改为复合 `'deepseek:deepseek-v4-flash'`。
- 新增 `parseModelRef(ref: string): { provider: string; id: string }`(裸 id → `{ provider: 'deepseek', id }`)。
- `create()`:遍历 `SUPPORTED_PROVIDERS`,`getApiKey(store, p)` 有值则 `runtime.setRuntimeApiKey(p, key).catch(console.error)`(fire-and-forget,补 catch 防 unhandled rejection;xiaomi 首次注入会触发 pi.dev 目录刷新 → `models-store.json` 出现 xiaomi 条目,这是验证点)。
- `setApiKey(key)` → `setApiKey(provider: string, key: string)`(默认 `'deepseek'` 由路由层兜底):写存储 + `setRuntimeApiKey(provider, key.trim())`。
- `listModels()`:`[...SUPPORTED_PROVIDERS].flatMap(p => runtime.getModels(p))`,过滤 `DEPRECATED_MODEL_IDS[provider]`。
- `getConfig()`:
  - `model` 解析走 `parseModelRef`;返回 `model: ${provider}:${id}`(复合标识);
  - `hasApiKey: hasApiKey(store, 'deepseek')`(旧语义保留);
  - `providers: SUPPORTED_PROVIDERS.map(p => ({ id: p, name: PROVIDER_NAMES[p], hasKey: hasApiKey(store, p) }))`;
  - `thinkingLevels`: `availableThinkingLevels(model)` 结果被 `MODEL_THINKING_OVERRIDES['provider:id']` 覆盖时用覆盖值。
- `setModel(workspaceId, modelRef)`:parse → `runtime.getModel(provider, id)`;不存在 → 400「未知模型」;**provider 无 key → 400「请先在设置中配置 {PROVIDER_NAMES[provider]} API key」**(D6-b);命中已打开会话则 `session.setModel(model)`;`storeConfig({ model: modelRef })`。
- `openSession()`:模型解析改 `parseModelRef(stored.model ?? DEFAULT_MODEL)` 后 `getModel(provider, id)`,其余不动(会话工具集/子代理自动跟随主会话模型,无需改)。
- 新增 `hasModelKey(): boolean`:当前模型(parseModelRef(config.model))对应 provider 的 `hasApiKey`(供路由,D6-c)。
- `getStatus()` 的 `model` 保持 `session.model.id`(裸 id,展示用,不改)。

**1.4 `apps/api/src/agent/routes.ts`**
- `PUT /api/agent/config/key`:body 增加可选 `provider`(默认 `'deepseek'`);不在 `SUPPORTED_PROVIDERS` → 400;调 `pi.setApiKey(provider, key)`。
- `POST /api/agent/workspaces/:id/prompt`:把 `if (!hasApiKey(store))` 换成 `if (!pi.hasModelKey())`,错误文案带当前模型 provider 名(如「尚未配置 Xiaomi API key…」);移除 `hasApiKey` import(若不再使用)。
- 其余路由不动(`POST /config/model` 的 `modelId` 语义自动变为复合标识)。
- 更新受影响的测试:`apps/api/src/app.test.ts` 中 key 保存/提示语相关断言。

**1.5 回归**:`pnpm build && pnpm typecheck && pnpm test`;手动验证 deepseek 全流程不变(设置 key、发消息、切模型、思考级别)。

### Phase 2:前端配置 UI 泛化(commit c2)

**2.1 `apps/web/src/composables/useAgent.ts`**
- `saveApiKey(key, provider = 'deepseek')`:`PUT /api/agent/config/key` body 带 `provider`。
- `switchModel(modelRef)`:透传复合标识(后端负责解析);成功后 `status.value.model = modelRef`。
- 新增 computed `activeProvider`(从 `config.model` 拆分冒号前段,缺省 `'deepseek'`)、`activeProviderHasKey`(查 `config.providers`)。

**2.2 `apps/web/src/components/ApiKeysPanel.vue`**
- 新增 Xiaomi section(仿 DeepSeek section 结构):`XIAOMI · 视觉模型` 说明文字(含「key 仅存后端 .workflows/config.json,不返回前端」+「mimo-v2.5 支持图片」);密码输入 + 保存;已配置状态从 `config.providers` 找 `id === 'xiaomi'` 的 `hasKey` 显示。
- 说明文字补一句:小米平台按量计费,key 可在 platform 侧查看用量。

**2.3 `apps/web/src/components/ChatPane.vue` 模型按钮泛化**
- 按钮 `:key` 与选中判断改用复合标识:`${m.provider}:${m.id}`;文案 `m.id.replace('deepseek-','')` → 显示 `m.id`,并加 provider 徽标(`D`/`XM` 或短名,无 key 的 provider 整组灰显 + `title="未配置 key"`)。
- 无 key provider 的模型按钮 `disabled`(D6-b 前端侧,后端仍双保险)。
- 空状态与输入区提示:根据 `activeProvider` 泛化「配置 {name} API KEY」文案(去掉 DeepSeek 硬编码)。
- 更新 `ChatPane.test.ts` 中断言(模型按钮文案/key 变化)。

### Phase 3:视觉链路(commit c3)

**3.1 `apps/api/src/pi/history.ts` 历史渲染支持图片**
- `renderHistory()` user 消息:由 `extractText(content)` 单块改为**按 content 数组逐 part 渲染**(text → text block,image → image block,顺序保持);`if (!text) continue` 改为「无任何 block 才跳过」(纯图片消息也能渲染)。
- `extractText` 保持(子代理/其他调用仍用)。
- 更新 `apps/api/src/pi/history.test.ts`(新增:混排 text+image、纯图片消息)。

**3.2 `apps/api/src/pi/piService.ts` prompt 接受图片**
- `prompt(workspace, text, images: ImageContent[] | undefined, onEvent)`:`images?.length` 时 `handle.session.prompt(text, { images })`,否则维持 `session.prompt(text)`。
- `ImageContent` 类型从 `@earendil-works/pi-ai/compat` 导入(E1 已确认该导出路径)。

**3.3 `apps/api/src/agent/routes.ts` /prompt 图片解析与校验**
- body 增加 `images?: Array<{ data: string; mimeType: string }>`;内联 `validateImages()`:
  - 数量 ≤ 8、`mimeType ∈ {image/jpeg, image/png, image/gif, image/webp}`、`data` 为裸 base64(拒绝含 `data:` 前缀,防双写)、单张 base64 长度 ≤ 7_000_000(≈5.2MB 二进制);
  - 当前模型 `model.input` 不含 `'image'` → 400「当前模型不支持图片」(取 `runtime.getModel` 解析当前 config.model);
  - 校验失败 400 零副作用(在 openSession 之前)。
- 转换:`images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType }))` 传给 `pi.prompt`。
- 更新 `app.test.ts`(图片校验用例:非法 mime、超量、带前缀、文本模型拒图)。

**3.4 前端图片输入(`apps/web/src/utils/image.ts` 新建 + ChatPane.vue)**
- `utils/image.ts`:`fileToImageContent(file): Promise<{ data: string; mimeType: string }>` — FileReader → canvas 压缩(长边 >2048 缩放;透明 PNG 保留 PNG,否则 JPEG q0.85)→ 输出 ≤5MB,超限抛错;mime 白名单外(如 BMP)经 canvas 转 PNG;GIF 原样直传(不处理动画帧,超限拒绝)。
- ChatPane:输入区左侧新增附加按钮(隐藏 `<input type="file" accept="image/*" multiple>`,≤8 张)+ textarea `@paste` 提取 `clipboardData.files`;已选图片预览行(64px 缩略图 + 文件名 + 移除 ×);当前模型不支持图片时隐藏附加按钮并提示。
- `handleSend()`:`agent.sendMessage(text, pendingImages)`;成功后清空;失败保留待重发。
- 更新 `ChatPane.test.ts`。

**3.5 前端渲染(`useAgent.ts` + MessageBubble.vue)**
- `UiSegment` 增加 `{ kind: 'image'; data: string; mimeType: string }`。
- `pushUserMessage(text, images?)`:图片段追加在 text 段之前或按传入顺序;`applySessionData`/`fetchSubHistory` 的 block → segment 映射增加 image 分支(现有 `block.type === 'tool' ? … : { kind: block.type, text }` 需显式分支,否则 image block 会把 `text: undefined` 塞进 text 段)。
- `planBlocks()`:image 段作为独立块(`key: image-N`,不与 text 合并)。
- MessageBubble.vue:用户消息由单块 markdown 改为遍历 blocks(text 合并渲染 markdown + image 渲染 `<img :src="data:${mimeType};base64,${data}">`,圆角/描边/最大宽度约束);助手消息的 plan 渲染增加 image 块分支(理论上助手不产图,防御性支持);`messageText()` 不受影响(text 过滤天然忽略 image)。
- 更新 `useAgent.test.ts` / `MessageBubble.test.ts`。

### Phase 4:验证与冒烟(commit c4)

**4.1 离线单元测试 + 静态检查(不需要 key)**
- `pnpm build && pnpm typecheck && pnpm lint && pnpm test` 全绿。
- 新单测覆盖:config per-provider key(双写/fallback/删除)、`parseModelRef`(复合/裸 id/非法格式)、history image 渲染、路由图片校验、模型切换无 key 400(piService 私有构造 + fake runtime 模式已有先例)。

**4.2 离线 mock(不需要 key)**
- 新建 `apps/api/scripts/mock-openai-server.mjs`:无依赖 node http,`/v1/chat/completions` 返回流式 SSE 假回复(打印收到的 `image_url` 数量与首 80 字符,用于确认序列化)。
- 新建 `apps/api/scripts/verify-xiaomi.mjs`(仿 verify-anysearch):
  - 参数:`--base-url`(默认 `https://api.xiaomimimo.com/v1`)、`--model`(默认 `mimo-v2.5`);
  - 内置 1×1 PNG base64 常量(程序生成,不依赖图片文件);
  - 请求 1:纯文本;请求 2:text + `image_url`(`data:image/png;base64,…`);断言 200 + `choices[0].message.content` 非空;不打印 key;
  - 无 key 时:若 `--base-url` 指向本地 mock,照常跑(验证协议形状);指向线上则提示「未设置 XIAOMI_API_KEY,跳过」。
  - 离线组合:`node apps/api/scripts/mock-openai-server.mjs &` + `node apps/api/scripts/verify-xiaomi.mjs --base-url http://127.0.0.1:3999/v1`。
- 🔑 **4.3 真实 key 冒烟(用户提供小米 API key;清单化)**
  - 设置 `XIAOMI_API_KEY` 后跑 `verify-xiaomi.mjs`(线上 baseUrl):文本 + 视觉两次调用通过。
  - 启动 `pnpm dev`:
    1. 设置面板输入 Xiaomi key → 保存成功 → 后端 `.workflows/config.json` 出现 `apiKeys.xiaomi`(明文存储,既有设计);`models-store.json` 出现 xiaomi 条目(网络 enabled 时,pi.dev 目录刷新);
    2. 模型按钮区出现 xiaomi 组(6 个模型,3 个已下线被过滤)→ 切 `mimo-v2.5` → 发纯文本消息 → 正常流式回复;
    3. 传图(本仓库 README 截图或任意 JPEG/PNG)→ 发送「描述这张图」→ agent 回复包含对图片内容的描述;回复底部 token/cost 正常;
    4. 思考级别:切 max/off 各发一条,观察是否报错(验证 thinkingFormat 兼容;若报错 → 填 `MODEL_THINKING_OVERRIDES` 约束档位后重测);
    5. 刷新页面 / 切到另一会话再切回 → 历史中图片消息仍渲染(JSONL 回放);
    6. 切回 `deepseek-v4-flash` → 文本流程正常;此时发图应被 400 拦截(deepseek 不支持 image);
    7. 并发/中止:流式期间点「停止」不崩溃。
  - 冒烟结论记录到本计划文件末尾或 run 产物(截图/输出摘要)。

**4.5 回归**:deepseek 全流程(Phase 1.5 清单重跑)+ 无 key 场景(未配置 xiaomi key 时切 xiaomi 模型 → 置灰/400 文案正确)。

---

## 4. 需要用户提供 / 决策的清单

| 项 | 类型 | 说明 |
| --- | --- | --- |
| 小米 API key | 🔑 | Phase 4.3 冒烟必需(平台:api.xiaomimimo.com,按量付费)。仅用于验证脚本与本地配置,不回传前端、不写入本计划。 |
| D4 已下线模型清单 | ❓ | 默认按任务要求 `mimo-v2-omni / mimo-v2-pro / mimo-v2-flash` 三款隐藏;内置目录仅 omni/pro 明确标注,flash 是否真下线以 pi.dev overlay 实际目录为准,可一键增删 `DEPRECATED_MODEL_IDS`。 |
| D5 图片参数 | ❓ | 默认长边 2048px / 单张 ≤5MB / 每消息 ≤8 张 / 白名单 jpeg·png·gif·webp;如需改数值,集中在 `utils/image.ts` 与 `routes.ts validateImages()` 两处。 |
| 思考级别兜底 | ❓ | 默认 `MODEL_THINKING_OVERRIDES` 为空(全量档位),冒烟报错后按实测档位填充(预期小米实际支持档位可能与 deepseek 不同)。 |
| MCP 工具结果图片 | ❓ | 默认保持 `[image, mime, bytes]` 占位(范围外),如需随视觉模型透传为后续迭代。 |

---

## 5. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `setRuntimeApiKey` 触发 pi.dev 网络刷新(离线失败) | 首次设置 xiaomi key 时目录刷新失败;内置目录兜底,功能不受影响 | create()/setApiKey() 均 `.catch(console.error)` 防 unhandled;models-store.json 无 xiaomi 条目属预期(见验证点,不视为错误) |
| thinkingLevel 映射缺失 | xiaomi 无 thinkingLevelMap,档位行为未验证;可能报错或静默降级 | `MODEL_THINKING_OVERRIDES` 预置钩子,冒烟后按实测填充(风险点提前设计,非事后补) |
| 模型 id 跨 provider 撞名 | UI key/选中态错乱 | 全链路复合标识 `provider:id`;按钮 key、config.model、切换参数统一 |
| 图片 payload 过大 | base64 膨胀 ~33%,API 拒绝或卡顿 | 前端 canvas 压缩(2048px/q0.85/5MB 上限)+ 后端双重校验(数量/大小/mime) |
| 历史 JSONL 体积增长 | 图片 base64 直存,会话文件变大 | 已知限制(范围外);会话可删(现有 deleteSession);后续迭代可做压缩归档 |
| 模型切换后旧会话上下文 | 切 provider 后会话携带旧模型上下文 | SDK 行为:session.setModel 热切,新回合用新模型,风险低;冒烟 4.3-6 覆盖 |
| `hasApiKey` 语义变化波及路由 | 误伤 deepseek 既有流程 | 保持无参 `hasApiKey` = deepseek 旧语义;prompt 路由改 `pi.hasModelKey()` 并回归 1.5/4.5 |

**回滚方案**:每 Phase 一个独立 commit(c1 后端泛化 / c2 前端 UI / c3 视觉链路 / c4 验证脚本),任一 Phase 出问题 `git revert` 对应 commit 即可;config.json 新增 `apiKeys` 字段为纯增量(旧字段双写),无迁移、无破坏性数据变更;`packages/shared` 类型变更仅向后兼容新增字段。

---

## 6. 验收标准(逐条核对)

**后端**
- [ ] `SUPPORTED_PROVIDERS` 遍历注入 key:`create()` 启动时 deepseek + xiaomi 已配置 key 均注入;`models-store.json` 首次设置 xiaomi key 后出现 xiaomi 条目。
- [ ] `parseModelRef`:`xiaomi:mimo-v2.5` → `{xiaomi, mimo-v2.5}`;`deepseek-v4-flash` → `{deepseek, deepseek-v4-flash}`。
- [ ] 切模型:目标 provider 无 key → 400 且文案含 provider 名;有 key → 热切换生效。
- [ ] prompt 路由:当前模型 provider 无 key → 400 拦截;deepseek 模型收图 → 400「不支持图片」。
- [ ] `config.json`:`apiKeys` 写 deepseek 时旧 `apiKey` 同步更新(双写);空串删除语义保留。
- [ ] 历史渲染:user 消息 content 数组 text/image 顺序还原;纯图片消息不丢。

**前端**
- [ ] ApiKeysPanel 有 Xiaomi 输入区;已配置状态按 `config.providers` 显示;保存后 key 不回传(响应中无明文)。
- [ ] ChatPane 模型按钮按 provider 分组/徽标,无 key provider 整组禁用;无 `replace('deepseek-','')` 残留(全仓库 grep 零命中)。
- [ ] 图片:文件选择与粘贴均可附加;预览可移除;压缩生效(>2048px 图上传后体积下降);发送时 images 随请求;流式正常。
- [ ] 消息渲染:用户图片消息(实时 + 历史回放)以 `<img>` 显示;助手消息不受影响。
- [ ] 子代理模态窗/工具块/MCP 占位行为与改动前一致(回归)。

**验证**
- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm test` 全绿(含新增单测)。
- [ ] 离线:`mock-openai-server.mjs` + `verify-xiaomi.mjs --base-url` 跑通,确认协议形状与 image_url 序列化。
- [ ] 🔑 真实冒烟 4.3 清单 1-7 全部通过(需用户提供小米 key)。
- [ ] deepseek 全流程回归通过(Phase 1.5 清单)。

---

## 7. 文件改动总览

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/index.ts` | AgentModel.input/deprecated;AgentConfig.providers;HistoryBlock image 成员;注释去硬编码 |
| `apps/api/src/config.ts` | StoredConfig.apiKeys;setApiKey(provider)/getApiKey/hasApiKey(provider?) |
| `apps/api/src/pi/piService.ts` | SUPPORTED_PROVIDERS/parseModelRef/DEPRECATED_MODEL_IDS/MODEL_THINKING_OVERRIDES;create/setApiKey/listModels/getConfig/setModel/openSession/prompt/hasModelKey 泛化 |
| `apps/api/src/pi/history.ts` | user 消息逐 part 渲染(image block) |
| `apps/api/src/agent/routes.ts` | key 路由 provider 参数;prompt 图片校验 + hasModelKey |
| `apps/api/src/config.test.ts` / `history.test.ts` / `app.test.ts` | 新增/更新用例 |
| `apps/api/scripts/verify-xiaomi.mjs` | 新增:小米 key/协议验证脚本(--base-url 可指 mock) |
| `apps/api/scripts/mock-openai-server.mjs` | 新增:离线 mock OpenAI 兼容端点 |
| `apps/web/src/composables/useAgent.ts` | saveApiKey(provider)/switchModel 复合标识/activeProvider/image segment 映射 |
| `apps/web/src/components/ApiKeysPanel.vue` | Xiaomi key section |
| `apps/web/src/components/ChatPane.vue` | 模型按钮泛化、图片附加/预览/粘贴 |
| `apps/web/src/components/MessageBubble.vue` | image 块渲染(用户 + 防御性助手) |
| `apps/web/src/utils/image.ts` | 新增:文件 → 压缩 → ImageContent |
| `apps/web/src/composables/useAgent.test.ts` / `ChatPane.test.ts` / `MessageBubble.test.ts` | 更新/新增用例 |
| `.workflows/config.json` | 运行时数据(新增 apiKeys.xiaomi,不提交明文 key 的敏感变更为用户本地行为) |
