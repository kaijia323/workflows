# 02 实施计划(重写):为 workflows 接入小米视觉识图能力(内置视觉理解工具)

> 依据:`.wf-runs/4f531a21/01-exploration-3.md`(以下简称 E3,工具注册机制事实来源)+ 本文撰写时对
> piService.ts / subAgent.ts / anySearchTools.ts / workspaceGuard.ts / config.ts / routes.ts /
> shared/src/index.ts / ApiKeyModal.vue / ApiKeysPanel.vue / useAgent.ts / subAgent.test.ts /
> anySearchTools.test.ts / AGENTS.md / docs/mcp.md / docs/dag-workflow.md 的逐文件复核。
>
> **本计划是 02-plan-1.md 的替代品(用户已驳回旧计划)**。旧计划走「provider 泛化 + 模型切换 +
> 用户传图」路线;本计划走「**内置视觉理解工具**」路线:主力文字模型仍是 deepseek,**不做模型切换、
> 不做 provider 泛化**,视觉能力以工具形式提供给主代理与各子代理。与旧计划的差异详见 §2。

---

## 1. 目标与范围

### 1.1 做什么

1. **内置视觉理解工具 `vision-understand`**(仿 `anySearchTools.ts` 的内置 HTTP 工具模式):
   - agent(主代理 + 各子代理)以工具调用方式识图:传入工作区内图片路径 + 问题,工具内部读取图片、
     调小米 OpenAI 兼容接口 `POST https://api.xiaomimimo.com/v1/chat/completions`(model=`mimo-v2.5`),
     返回图片内容的**文字描述**;
   - 主力文字模型(deepseek)**不动**——不换模型、不接用户传图链路;识别能力完全由工具承担。
2. **前端设置新增「视觉模型」tab**:一个开关(默认**关闭**)+ 小米 API key 输入 + 保存;
   开关开启且已配置 key 后,主代理与各子代理的工具集才注册 `vision-understand`。
3. **Key 与开关状态持久化**:`.workflows/config.json` 新增 `visionEnabled` / `visionApiKey` 两个字段
   (明文存储,与既有 `apiKey`/`anySearchApiKey` 同设计);key **不回传前端**;`env XIAOMI_API_KEY`
   优先于配置文件(与 anysearch 的 key 解析纪律一致)。
4. **按量付费,不接订阅/Token Plan**:只使用按量付费的小米 key(`sk-xxxxx`);`xiaomi-token-plan-*`
   类 provider/套餐不在任何范围内。
5. **验证**:单元测试(fetchImpl 注入 mock)+ 离线 mock server + 验证脚本 + 构建/类型检查 +
   🔑 真实 key 冒烟(用户提供)。

### 1.2 不做什么(范围外,记录为 follow-up)

- **不**做 provider 泛化(无 `SUPPORTED_PROVIDERS` / `parseModelRef` / per-provider key 双写 /
  模型切换 UI);`'deepseek'` 硬编码与既有模型按钮全部保持原样。
- **不**做用户传图链路(`session.prompt(text, { images })`、图片上传/粘贴、`HistoryBlock` image 成员、
  前端 `<img>` 渲染、canvas 压缩)——用户把图发给 agent 聊天是旧计划路线,本计划不做。
- **不**做模型目录治理(无 `DEPRECATED_MODEL_IDS`、无 thinkingLevel 兜底表)。
- **不**做工具返回图片(`AgentToolResult.content` 的 `ImageContent`):SSE/历史/前端渲染全是纯文本管道
  (E3 §8.3),v1 工具只返回文字描述,图片回传评估为后续迭代(§5 决策 D5)。
- **不**自建 MCP server 进程走 mcp.json 通道(取舍见 §3 D1)。
- **不**做多图参数(v1 单图,多图由 agent 多次调用工具实现;如需数组参数见 §5 决策项)。
- **不**修改任何 `node_modules` 内 pi SDK 代码;不新增 SSE 事件类型;不改子代理事件镜像。

---

## 2. 与旧计划(02-plan-1.md)的差异(用户驳回点逐一对照)

| 旧计划(02-plan-1.md) | 本计划 | 差异说明 |
| --- | --- | --- |
| provider 泛化:多 provider 注入/校验、模型列表分发、`provider:id` 复合标识、切模型路由 | **完全不做** | deepseek 仍是唯一文字模型;`config.model`、模型按钮、`setModel`、`hasApiKey` 语义零改动 |
| 用户传图:`prompt(images)` + 前端压缩上传 + HistoryBlock image + `<img>` 渲染 | **完全不做** | 视觉能力交付形态 = **工具**,不是消息管道;识图发生在 agent 自主调用工具时 |
| per-provider key:`apiKeys: Record<string,string>` + 双写迁移 | **不做** | 新增独立字段 `visionApiKey`(纯增量,无迁移);deepseek key 路径不动 |
| 模型目录治理:下线模型过滤、thinkingLevel 兜底 | **不做** | 不把 xiaomi 当聊天 provider,不涉及模型列表/思考级别 |
| ApiKeysPanel 增加 Xiaomi key 输入 | **改为独立「视觉模型」tab** | 开关 + key 一体,与「API Keys」tab 并列(新组件 VisionPanel.vue) |
| 验证脚本 `verify-xiaomi.mjs` + mock-openai-server | **保留思路,改名** | `verify-vision.mjs` + `mock-xiaomi-server.mjs`(仅验证 chat/completions 协议形状) |
| 小米 key 按量付费、不接 Token Plan | **一致** | 两版都明确 |
| 双点注册纪律(主代理 openSession + 子代理 runSubAgent/buildSubAgentTools) | **保留并强化** | 新增工具注册点 + 开关门 + 会话重建刷新;含只读工作区注册决策(§5 D4) |

---

## 3. 设计决策

| # | 决策 | 结论 |
| --- | --- | --- |
| D1 | 工具通道:内置 HTTP 工具 vs 内置 MCP 工具 | **内置 HTTP 工具(anysearch 模式)**。取舍说明:仓库的 MCP 通道是**用户外部 server**通道(`mcp.json` 配置 stdio 进程,`createMcpTools` 包装为 `mcp__<server>__<tool>`);`docs/mcp.md` §7 ADR 明确 v1 不做 MCP server 端;pi SDK 无内置 MCP API(E3 §4.1)。若把「内置视觉工具」做成 MCP 工具,必须自建一个 stdio server 子进程(HTTP 转发/包装),成本高、与「内置」语义冲突、且引入进程生命周期管理。anysearch 模式 = 代码内置、无进程、无配置面、fetch 注入可测,与仓库既有内置工具完全同构,故选用。 |
| D2 | 工具名与 schema | 工具名 **`vision-understand`**(避开 `mcp__` 前缀与内置/仓库工具名,`docs/mcp.md` 命名冲突清单同步登记)。参数:`image_path`(必填,相对工作区根的图片路径)+ `question`(可选,缺省「请详细描述这张图片的内容」)。**单图 v1**;多图 = 多次调用(§5 决策项可升级为数组)。 |
| D3 | 实现:直接 fetch vs pi-ai xiaomi provider | **直接 fetch**(OpenAI 兼容 `chat/completions`)。理由:(a) 与 anySearchTools 同构,`fetchImpl` 注入可离线单测;(b) 不走 `ModelRuntime.setRuntimeApiKey` → 避开 pi.dev 目录网络刷新副作用(E3 §9 风险 5);(c) 工具内起第二个模型的 `Api` 实例在 SDK 中无现成模式,序列化/上下文行为不可控;(d) 与主力模型(deepseek)完全解耦,deepseek 收到文字结果即可继续推理。小米 provider 的内置目录仅作为**协议事实参考**(baseUrl / mimo-v2.5 输入类型),不通过 SDK 调用。 |
| D4 | 开关与 key 的注册门 | 工具注册条件 = `visionEnabled === true` **且** 有 key(`env XIAOMI_API_KEY` 或 `config.visionApiKey`);任一不满足 → **不注册**(模型视野中无此工具)。注册门在 piService/subAgent 两处共用同一纯函数 `visionAvailable(store)`(单一事实源)。工具 execute 内再做防御性 key 校验(运行期 key 被删时返回明确错误文本,不 throw)。 |
| D5 | 工具结果回传 | **纯文字描述**(SSE `tool_end.output` string 即通,主/子代理管道零改动)。工具返回 `ImageContent` 需扩展 shared 事件类型 + history + 前端渲染(E3 §8.3),v1 不做,列为后续迭代。 |
| D6 | key 管理 | `config.json` 新增 `visionApiKey`(明文,既有设计);env `XIAOMI_API_KEY` 优先(与 anysearch 的 `resolveApiKey` 纪律一致);key 经 `getApiKey` 回调**调用时动态读取**(保存后立即生效,无需重建会话)。开关变更(注册面变化)才触发会话重建。 |
| D7 | 开关变更的会话刷新 | 新增 `PiAgentService.refreshOpenSessions()`:重建所有已打开会话(含只读工作区);忙碌会话挂起下回合重建(复用既有 `mcpRebuildPending` 机制,字段改名为通用 `rebuildPending`)。`refreshMcpForOpenSessions` 保留只读跳过(仅 mcp 语义),共用同一重建循环。 |
| D8 | 图片路径守卫 | 工具参数名是 `image_path`(非 `path`),`guardPathTool` 只校验 `path` 参数 → **守卫内置于工具**:execute 内用 `isAllowedTargetPath(imagePath, workspacePath, extraAllowedRoots)`(workspaceGuard.ts 单一事实源)校验,越界抛「工作区边界拦截」同类文案。`extraAllowedRoots` = skills 放行根(与 read 工具同语义)。 |
| D9 | 只读工作区 | 视觉工具在只读工作区**也注册**(对齐 anysearch:无副作用只读 HTTP 工具;只读文件 + 外部 API,不写盘)。 |
| D10 | 限制 | 单图 ≤ 10MB 二进制(小米单图上限;base64 膨胀 ~1.37× 由工具内部处理);超时 60s(MCP call 同级);输出 50KB 截断(对齐 anysearch/fff);mime 白名单 jpeg/png/gif/webp(按扩展名判定,v1 不做魔数嗅探);非流式请求(`stream:false`),响应 `reasoning_content` 忽略。 |

---

## 4. 实施步骤

> 图例:🔑 = 需要用户提供小米 API key;❓ = 需要用户决策。每 Phase 结束一个可独立回滚的 commit。
> 所有 phase 均不触碰 `node_modules`。

### Phase 0:基线确认(无代码改动)

- [ ] 0.1 `git status` 确认工作区干净;必要时 `pnpm install`。
- [ ] 0.2 基线:`pnpm build && pnpm typecheck && pnpm test` 全绿(记录耗时,便于回归对比)。

### Phase 1:后端 —— 工具 + 配置 + 双点注册 + 路由(commit c1)

**1.1 `apps/api/src/pi/visionTools.ts`(新建,核心)**
- 常量:`VISION_TOOL_NAME = 'vision-understand'`、`VISION_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions'`、
  `VISION_MODEL = 'mimo-v2.5'`、`DEFAULT_TIMEOUT_MS = 60_000`、`MAX_IMAGE_BYTES = 10MB`、`MAX_OUTPUT_BYTES = 50KB`、
  `SUPPORTED_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }`。
- `createVisionTools(options: { workspacePath; extraAllowedRoots?; getApiKey?; fetchImpl?; endpoint?; timeoutMs?; maxImageBytes? })`
  返回 `ToolDefinition[]`(单工具;工厂签名对齐 `createAnySearchTools`,测试注入友好)。
- 工具 `description`(中文,模型可见):何时使用(用户要求描述/分析工作区内图片、截图、UI 图、流程图、
  报错截图等)、参数说明、前提(设置中开启「视觉模型」并配置小米 key,按量付费)、返回文字描述。
- `execute` 流程(仿 anySearchTools 纪律,错误**返回文本不 throw**,唯一透传 `Operation aborted`):
  1. `abortIfSignaled(signal)`;`image_path` 非空校验;
  2. 守卫:`isAllowedTargetPath(image_path, workspacePath, extraAllowedRoots)` → 越界抛「工作区边界拦截:…」;
  3. `readFile`(node:fs/promises,路径 `path.resolve(workspacePath, image_path)`);文件不存在/超限(>10MB)报明确错误;
  4. 扩展名 → mime 白名单,不支持报「支持的图片格式:JPEG/PNG/GIF/WebP」;
  5. key:`env XIAOMI_API_KEY` > `options.getApiKey()`;无 key → 报「未配置小米视觉 API key(请先在设置 → 视觉模型中开启并填写)」;
  6. `fetch` POST:`{ model: 'mimo-v2.5', messages: [{ role: 'user', content: [
     { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
     { type: 'text', text: question } ] }], stream: false }`,
     `Authorization: Bearer <key>`,`AbortSignal.any([AbortSignal.timeout(60s), signal])`(组合信号,同 anysearch);
  7. 错误分层(同 anysearch `mapHttpError` 风格):400 参数错误 / 401·403 key 无效 / 402 额度用完 /
     429 限流 / ≥500 服务端 / 非 JSON / `choices[0].message.content` 结构缺失;
  8. 成功:`content` 文本 → `truncateOutput`(50KB)→ `{ content: [{ type: 'text', text }], details: undefined }`。
- 从 `anySearchTools.ts` **导出 `truncateOutput`**(现为模块私有;视觉工具复用,不做重复实现)。
- 文件头注释写明协议事实来源(E3 §探索结论:baseUrl/model/单图上限/OpenAI 兼容)。

**1.2 `packages/shared/src/index.ts` 类型扩展**
- `AgentConfig` 增加:`visionEnabled: boolean`(注释:视觉模型开关,默认关)、`hasVisionApiKey: boolean`
  (注释:env `XIAOMI_API_KEY` 或配置文件已配置;key 本身不回传前端)。
- 预期:`pnpm --filter @workflows/shared build` 通过;api/web 编译期消费新字段。

**1.3 `apps/api/src/config.ts` 存储层**
- `StoredConfig` 增加:`visionEnabled?: boolean`、`visionApiKey?: string`(均注释说明 env 优先/明文存储/不回传)。
- 新增:`setVisionConfig(store, patch: { enabled?: boolean; apiKey?: string })`(走 `saveConfig`,空串 apiKey =
  删除,复用既有语义)、`getVisionEnabled(store): boolean`(`=== true`)、`hasVisionApiKey(store): boolean`、
  `visionAvailable(store): boolean`(= `getVisionEnabled(store) && Boolean(process.env.XIAOMI_API_KEY?.trim() || hasVisionApiKey(store))`。
  **注册门单一事实源,主/子代理共用**)。
- 更新 `apps/api/src/config.test.ts`:新增 vision 字段持久化 / 空串删除 / 默认关 / `visionAvailable` 门组合用例
  (env 用 `vi.stubEnv` 注入,用后 `vi.unstubAllEnvs`)。

**1.4 `apps/api/src/pi/piService.ts`(主代理注册点)**
- import:`createVisionTools`、`visionAvailable`、`getVisionEnabled`、`hasVisionApiKey`、`setVisionConfig`(config.ts)。
- `openSession()`(webTools 块之后):
  ```ts
  const visionTools = visionAvailable(this.store)
    ? createVisionTools({
        workspacePath: workspace.path,
        extraAllowedRoots, // skills 放行根,与 read 工具同语义(D8)
        getApiKey: () => loadConfig(this.store).visionApiKey ?? undefined, // 动态读取,保存 key 立即生效
      })
    : []
  const visionToolNames = visionTools.map((t) => t.name)
  ```
  - `guardedTools` **两个分支**(readOnly / 非 readOnly)均追加 `...visionTools`(D9:只读工作区也注册);
  - `activeTools` **两个分支**均追加 `...visionToolNames`(白名单必须显式列入,否则 SDK 过滤掉,既有纪律)。
- `getConfig()`:`visionEnabled: getVisionEnabled(this.store)`、`hasVisionApiKey: hasVisionApiKey(this.store)`
  (key 本身不返回)。
- 新增 `setVisionConfig(patch: { enabled?: boolean; apiKey?: string }): void`:
  - `before = getVisionEnabled(this.store)` → `setVisionConfig(this.store, patch)` → `after = getVisionEnabled(this.store)`;
  - `before !== after`(开关翻转,注册面变化)→ `await this.refreshOpenSessions()`;仅 key 变更(开关不变)→
    不重建(getApiKey 动态读取,已注册工具下次调用即用新 key)。
- `refreshMcpForOpenSessions` 泛化:私有字段 `mcpRebuildPending` 改名 `rebuildPending`(语义变更为
  「配置变更待重建」,触发源 = mcp 配置变更 + 视觉开关变更;私有字段,低风险,同步更新全部引用);
  抽出私有 `rebuildAllHandles(skipReadOnly: boolean)`;`refreshMcpForOpenSessions()` 调 `rebuildAllHandles(true)`
  (只读跳过,既有行为);新增 `refreshOpenSessions()` 调 `rebuildAllHandles(false)`(视觉开关变更,只读也重建)。
- `prompt()` 中 `handle.mcpRebuildPending` 引用同步改名。

**1.5 `apps/api/src/pi/subAgent.ts`(子代理注册点)**
- `buildSubAgentTools` options 增加 `visionTools?: ToolDefinition[]`(缺省 `[]`,保持既有行为;
  对齐 `mcpTools` 的「调用方构建后传入」模式):
  - `tools.push(...visionTools)`;`activeNames` 增加 `...visionTools.map((t) => t.name)`(白名单纪律)。
- `runSubAgent()`(mcpTools 块之后):
  ```ts
  const visionTools = visionAvailable(store)
    ? createVisionTools({
        workspacePath: workspace.path,
        extraAllowedRoots: skillReadRoots(skillCtx),
        getApiKey: () => loadConfig(store).visionApiKey ?? undefined,
      })
    : []
  ```
  传入 `buildSubAgentTools({ ..., visionTools })`。
- 更新 `apps/api/src/pi/subAgent.test.ts`:新增用例 —— 传入 visionTools 时 tools 与 activeNames 含
  `vision-understand` 恰一次(各角色);缺省时不包含(仿既有 `mcpTools` 用例组)。

**1.6 `apps/api/src/agent/routes.ts` 配置路由**
- 新增 `PUT /api/agent/config/vision`:
  - body `{ enabled?: unknown; apiKey?: unknown }`;`enabled` 非 boolean → 400「缺少 enabled(布尔)」;
  - `apiKey` 为 string 时 trim(空串 = 清空);非 string 且非 undefined → 400;
  - `await pi.setVisionConfig({ enabled, apiKey })` → 返回 `pi.getConfig()`(key 不回传)。
- 更新 `apps/api/src/app.test.ts`(或 routes 层既有测试):保存开关+key / 非法 body 400 / 空串清空 / 响应不含明文 key。

**1.7 文档同步(同一 commit)**
- `AGENTS.md` 工具段:登记 `vision-understand`(内置 HTTP 工具、双点注册、开关门 `visionAvailable`、
  只读工作区也注册、守卫内置于工具)。
- `docs/mcp.md` 命名冲突清单:内置/仓库工具列表追加 `vision-understand`。
- `docs/dag-workflow.md` 子代理工具集补充:追加 `vision-understand`(开关开启且配置 key 时)。

**1.8 回归**:`pnpm build && pnpm typecheck && pnpm test`;手动确认 deepseek 全流程不变(开关默认关 =
  零注册、零行为变化)。

### Phase 2:前端 —— 视觉模型 tab(commit c2)

**2.1 `apps/web/src/composables/useAgent.ts`**
- computed:`visionEnabled`(`config.value?.visionEnabled ?? false`)、`hasVisionApiKey`
  (`config.value?.hasVisionApiKey ?? false`),与既有 `hasApiKey`/`hasAnySearchApiKey` 并列。
- 新增 `saveVisionConfig(patch: { enabled: boolean; apiKey?: string }): Promise<void>`:
  `PUT /api/agent/config/vision`(body = patch)→ `await refreshConfig()`。
- 在 `AgentStore` 返回/解构中暴露以上三项(参照 `saveAnySearchApiKey` 的既有写法)。

**2.2 `apps/web/src/components/VisionPanel.vue`(新建)**
- 仿 `ApiKeysPanel.vue` 的视觉语言(段标题 `font-mono text-[10px] tracking-wider text-mute`、说明
  `text-xs text-body`、密码输入、保存按钮、错误/成功提示)。
- 结构:
  1. 段标题:「视觉模型 · VISION」;说明文字:小米按量付费(不计入订阅/Token Plan)、key 仅存后端
     `<code>{{ meta?.environment === 'production' ? '~/.workflows' : '.workflows' }}</code>` 不回传前端、
     `env XIAOMI_API_KEY` 优先、agent(主代理+子代理)以工具 `vision-understand` 方式识图、
     **开关关闭或未填 key 时工具不可用**、默认关闭;
  2. 开关:`button role="switch" :aria-checked`(样式仿既有 border 风格,开启态 `bg-primary` 系),
     默认取自 `agent.visionEnabled.value`;
  3. key 输入:`type="password"`、placeholder `sk-…`,开关关闭时 `disabled`(并提示「开启后可用」);
  4. 保存按钮:提交 `{ enabled, apiKey: keyInput }`(关闭时也可保存,仅提交 `{ enabled: false }`);
  5. 状态行:`已开启 · 已配置 key(工具可用)` / `已开启 · 未配置 key(工具不可用)` / `已关闭(工具不可用)`,
     由 `agent.visionEnabled.value` + `agent.hasVisionApiKey.value` 组合,样式仿 ApiKeysPanel 的
     「已配置(可覆盖)」圆点行。
- 交互细节:保存成功后清空 key 输入(与 ApiKeysPanel 一致);失败保留输入并显示错误。

**2.3 `apps/web/src/components/ApiKeyModal.vue`**
- `type TabId = 'api' | 'mcp' | 'vision'`;左侧 nav 增加「视觉模型」按钮(副标题「识图工具」);
  右内容区 `v-show="activeTab === 'vision'"` 挂 `VisionPanel`(传 `:agent`、`:meta`);
  对话框 `aria-label` 更新为「设置:API Keys、MCP 与视觉模型配置」。

**2.4 前端测试**
- 更新 `useAgent.test.ts`:saveVisionConfig 请求体 / 响应刷新 config。
- 新增/更新 `VisionPanel` 相关组件测试(开关切换、保存请求、状态行文案)——若仓库既有组件测试
  范式是逐组件 Vitest(如 MessageBubble.test.ts),按同范式补;否则至少覆盖 useAgent 层。

**2.5 回归**:`pnpm build && pnpm typecheck && pnpm test`;手动:打开设置 → 视觉模型 tab →
  开关默认关;开启 + 输入 key → 保存 → 状态行「已开启 · 已配置 key」;关闭 → 保存。

### Phase 3:验证脚本、离线 mock 与冒烟(commit c3)

**3.1 离线 mock + 验证脚本(不需要 key)**
- `apps/api/scripts/mock-xiaomi-server.mjs`(新建,无依赖 node http,仿 verify-anysearch 风格):
  `POST /v1/chat/completions` → 解析 body,打印 `model`、`image_url` 数量与 data URL 前 80 字符
  (确认 base64 前缀/mime 序列化),返回 `{ choices: [{ message: { content: 'mock 识图成功(1 张图)' } }] }`;
  支持 `--port`(默认 3999)。
- `apps/api/scripts/verify-vision.mjs`(新建):参数 `--base-url`(默认 `https://api.xiaomimimo.com/v1`)、
  `--model`(默认 `mimo-v2.5`);内置程序生成的 1×1 PNG base64 常量;构造 text+image_url 请求,断言
  200 + `choices[0].message.content` 非空;不打印 key;失败非零退出;
  线上模式无 `XIAOMI_API_KEY` 时提示跳过;离线组合:
  `node apps/api/scripts/mock-xiaomi-server.mjs &` + `node apps/api/scripts/verify-vision.mjs --base-url http://127.0.0.1:3999/v1`。

**3.2 🔑 真实 key 冒烟(用户提供小米 API key;清单化)**
- 设置 `XIAOMI_API_KEY` 跑 `verify-vision.mjs`(线上 baseUrl):通过。
- `pnpm dev` 冒烟清单:
  1. 设置 → 视觉模型:开关默认关;开启并保存 key → `.workflows/config.json` 出现 `visionEnabled: true` 与
     `visionApiKey`(明文,既有设计);前端响应/config 接口**不含** key 明文;
  2. 发送「用 vision-understand 描述 <工作区内某图片的相对路径>」(或直接让 agent 找图)→ 主代理工具卡片
     出现 `vision-understand` 调用,返回图片内容文字描述;deepseek 继续基于描述回答;
  3. 让子代理(如 explorer)执行含识图的任务 → 模态窗 sub_* 事件中出现 `vision-understand` 调用且正常回传;
  4. 开关关闭 + 保存 → 已打开会话被重建,agent 不再列出/调用该工具(问「你有哪些工具」不含 vision-understand);
     仅清空 key(开关仍开)→ 工具保持注册但调用报「未配置小米视觉 API key…」错误文本(防御路径);
  5. 未开启开关时让 agent 识图 → agent 回复无视觉能力(可接受行为,见 §5 决策项 4);
  6. 超限图片(>10MB)与不支持格式 → 工具报明确错误;越界路径 → 工作区边界拦截;
  7. 流式期间点「停止」不崩溃(abort 透传纪律回归);
  8. deepseek 全流程回归(发消息/切思考级别/子代理/闸门)不变。
- 冒烟结论记录到本 run 产物(截图/输出摘要)。

**3.3 回归**:`pnpm build && pnpm typecheck && pnpm lint && pnpm test` 全绿;Phase 1.8 清单重跑。

---

## 5. 需要用户提供 / 决策的清单

| 项 | 类型 | 说明 |
| --- | --- | --- |
| 小米 API key | 🔑 | Phase 3.2 冒烟必需(平台 api.xiaomimimo.com,按量付费 `sk-xxxxx`)。仅用于本地验证;不回传前端、不写入本计划。 |
| 工具名 | ❓ | 默认 **`vision-understand`**(备选:`xiaomi-vision` / `vision`)。一旦定名,§4 各文件引用同步。 |
| 图片参数形态 | ❓ | 默认 **单图** `image_path` + `question`,多图 = agent 多次调用。若希望一次传多张(如 `image_paths: string[]`,maxItems 8),在 1.1 的 schema 与 1.4/1.5 注册点同步调整,需在 Phase 1 前拍板。 |
| 开关关闭时 agent 被要求识图 | ❓ | 默认接受现状:工具不注册 → deepseek 无视觉能力 → agent 如实回复「无法查看图片」。不做系统提示词兜底(v1)。 |
| 工具返回图片(ImageContent) | ❓ | 默认 **v1 不做**(纯文本描述,SSE/历史/前端零改动);图片回传需扩展事件类型+渲染,列为后续迭代。 |
| env `XIAOMI_API_KEY` 通道 | ❓ | 默认支持(env 优先于 config,与 anysearch 一致)。如只想用配置文件可去掉 env 分支(仅删 `resolveApiKey` 一处)。 |
| 订阅/Token Plan | — | **明确不接**(两版一致):仅按量付费 xiaomi key。 |

---

## 6. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 开关关闭/无 key 时 agent 被要求识图 | 工具不注册,模型无视觉能力,回复「无法查看」 | 可接受(用户已认可「不注册/报错」倾向);工具 description 与前端说明文字写清前置条件;不做 prompt 兜底(v1) |
| key 明文存储于 config.json | 本地明文(既有 `apiKey`/`anySearchApiKey` 同设计) | 维持现状;key 永不回传前端/日志/错误文案;错误文案脱敏(仿 anysearch 纪律) |
| 图片体积超限 / 格式不支持 | 小米 API 拒绝或工具报错 | 工具内 10MB + mime 白名单前置校验,报明确中文错误;单图 v1,多图多次调用 |
| 视觉推理慢 | 回合等待久 | 60s 超时(与 MCP call 同级);超时/abort 区分报错;流式(`stream:true`)解析列为后续优化 |
| 双点注册漏白名单 | 工具注册但模型不可见 / 子代理无视觉能力(既有高发回归点) | 1.4/1.5 显式列出;subAgent.test.ts 恰一次用例 + AGENTS.md 纪律登记;冒烟 3.2-2/3 覆盖 |
| 开关翻转后旧会话仍持有工具 | 关闭不生效 / 开启不生效 | `setVisionConfig` 检测 enabled 翻转 → `refreshOpenSessions()`(空闲重建,忙碌挂起下回合;`mcpRebuildPending` 改名 `rebuildPending` 共用) |
| `mcpRebuildPending` 改名波及 mcp 刷新路径 | 回归风险 | 私有字段,引用点少(piService 内 3 处);Phase 1.8 回归含 mcp 保存/删除刷新验证;mcpRefresh.test.ts 已有覆盖 |
| 小米 API 协议/模型变动 | 工具失效 | endpoint/model 常量集中 visionTools.ts 顶部;验证脚本可离线/线上复测 |
| mimo-v2.5 返回 `reasoning_content` 或空 content | 输出异常 | 结构校验 + 空 content 报「响应缺少文本内容」;reasoning_content 忽略(文档注明) |

**回滚方案**:每 Phase 一个独立 commit(c1 后端 / c2 前端 / c3 验证),任一 Phase 出问题 `git revert` 对应
commit;`config.json` 新增字段纯增量(无迁移、无破坏);共享类型仅向后兼容新增字段;开关默认关 =
  Phase 1 合入后若不开启,线上行为与改动前完全一致(零注册),天然灰度。

---

## 7. 验收标准(逐条核对)

**后端**
- [ ] `createVisionTools` 工厂可注入 `fetchImpl`/`endpoint`/`timeoutMs`;成功返回文字内容;401/403/402/429/
      5xx/非 JSON/结构缺失/无 key/越界路径/文件不存在/超限/不支持格式/超时/abort 均有对应错误文本(不 throw,
      除 Operation aborted)。
- [ ] `config.json`:`visionEnabled`/`visionApiKey` 持久化;空串 apiKey 删除;默认关;`visionAvailable` 门 =
      开关开 && (env key || config key)(env 注入测试通过)。
- [ ] 主代理 `openSession`:开关开 + 有 key → `customTools` 与 `tools` 白名单均含 `vision-understand`;
      开关关或无 key → 均不含(只读/读写工作区同规则);开关翻转 → 已打开会话重建。
- [ ] 子代理 `buildSubAgentTools`/`runSubAgent`:传入 visionTools → tools 与 activeNames 恰一次;
      未传入 → 不含;四个内置角色一致。
- [ ] `PUT /api/agent/config/vision`:`enabled` 非布尔 400;apiKey 非字符串 400;空串清空;响应 config 不含 key 明文;
      开关翻转触发会话重建(key-only 变更不重建)。
- [ ] `AgentConfig` 返回 `visionEnabled`/`hasVisionApiKey`,无 `visionApiKey` 明文。
- [ ] deepseek 全流程(默认开关关)与改动前一致;`mcpRebuildPending` 改名后 mcp 刷新测试全绿。

**前端**
- [ ] 设置模态窗出现「视觉模型」tab;开关默认关;关闭时 key 输入禁用;保存请求体
      `{ enabled, apiKey? }`;状态行三态文案正确(已开启·已配置 / 已开启·未配置 / 已关闭)。
- [ ] 保存后 key 输入清空、config 刷新;响应/本地状态不含 key 明文;错误与成功提示与 ApiKeysPanel 风格一致。
- [ ] 全仓库 grep `vision-understand` 无遗漏的注册点(piService/subAgent 双点 + 白名单 + 文档登记)。

**验证**
- [ ] `pnpm build && pnpm typecheck && pnpm lint && pnpm test` 全绿(含新增单测)。
- [ ] 离线:`mock-xiaomi-server.mjs` + `verify-vision.mjs --base-url` 跑通,确认 image_url 序列化与协议形状。
- [ ] 🔑 真实冒烟 3.2 清单 1-8 全部通过(需用户提供小米 key);冒烟结论记录到 run 产物。
- [ ] deepseek 全流程回归(Phase 1.8 / 3.3 清单)。

---

## 8. 文件改动总览

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/pi/visionTools.ts` | 新建:视觉理解工具工厂(schema/守卫/读图/fetch/错误分层/50KB 截断) |
| `apps/api/src/pi/anySearchTools.ts` | 导出 `truncateOutput`(供 visionTools 复用,其余不动) |
| `apps/api/src/config.ts` | StoredConfig.visionEnabled/visionApiKey;setVisionConfig/getVisionEnabled/hasVisionApiKey/visionAvailable |
| `apps/api/src/pi/piService.ts` | openSession 注册 + 白名单(双分支);getConfig 新字段;setVisionConfig(开关翻转→refreshOpenSessions);mcpRebuildPending→rebuildPending 改名;rebuildAllHandles 抽取;refreshOpenSessions 新增 |
| `apps/api/src/pi/subAgent.ts` | buildSubAgentTools 增加 visionTools 参数;runSubAgent 按 visionAvailable 构建并传入 |
| `apps/api/src/agent/routes.ts` | `PUT /api/agent/config/vision`(校验 + 保存 + 返回 config) |
| `packages/shared/src/index.ts` | AgentConfig.visionEnabled / hasVisionApiKey |
| `apps/api/src/pi/visionTools.test.ts` | 新建:工具全路径单测(fetchImpl mock + tmpdir 图片 fixture + env 注入) |
| `apps/api/src/config.test.ts` / `subAgent.test.ts` / `app.test.ts` / `piService.test.ts` | 新增/更新用例 |
| `apps/web/src/components/VisionPanel.vue` | 新建:视觉模型 tab(开关 + key + 保存 + 状态行) |
| `apps/web/src/components/ApiKeyModal.vue` | 新增 vision tab(nav + v-show + aria-label) |
| `apps/web/src/composables/useAgent.ts` | visionEnabled/hasVisionApiKey computed;saveVisionConfig;AgentStore 暴露 |
| `apps/web/src/composables/useAgent.test.ts` | saveVisionConfig 用例 |
| `apps/api/scripts/mock-xiaomi-server.mjs` | 新建:离线 mock(打印 image_url 序列化) |
| `apps/api/scripts/verify-vision.mjs` | 新建:协议验证脚本(--base-url 可指 mock) |
| `AGENTS.md` / `docs/mcp.md` / `docs/dag-workflow.md` | 工具登记与命名冲突清单 |
| `.workflows/config.json` | 运行时数据(新增 visionEnabled/visionApiKey;明文 key 为用户本地行为,不提交) |
