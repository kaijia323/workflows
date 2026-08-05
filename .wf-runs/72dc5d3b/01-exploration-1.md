# 01 探索报告(补充):vision-understand 工具增强 + 前端粘贴图片缩略图

> 目标:基于 `.wf-runs/4f531a21/01-exploration-1.md`(LLM 接入/视觉现状)与 `01-exploration-3.md`(工具注册机制),
> 补充调研「前端消息输入框与粘贴能力 / 图片从浏览器到 agent 的传递路径 / vision-understand 增强点 / 历史持久化」,
> 为 planner 制定「vision-understand 多图+URL+base64 增强 + 前端粘贴图片缩略图」实施计划提供事实依据。
> 调研对象:仓库根 `C:/Users/kaijia/codes/github/workflows`;pi SDK `@earendil-works/pi-ai@0.83.0` / `pi-coding-agent@0.83.0`。
> 说明:`.workflows/config.json` 存在真实 key,本报告脱敏引用。

---

## 0. 结论先行(摘要)

1. **vision-understand 工具 v1 已落地**(上个 run 4f531a21,commit 20703ca/71ab29c/a1fff8c,审查 pass):
   `apps/api/src/pi/visionTools.ts` 单图 `image_path` + `question`,双点注册(piService + subAgent),守卫内置,
   `fetchImpl` 可注入,19 个单测。**本次需求 = 在该文件上做增强**,不是从零建。
2. **前端输入框无任何 paste/拖拽处理**:`ChatPane.vue` 只有 `@keydown`(Enter 发送 + /skill 菜单),
   textarea 上方存在现成的预览容器插入位(gateRequest 块与输入行之间);发送链路 `useAgent.sendMessage(text)`
   body 只有 `{ text }`,SSE 事件流处理集中在 `handleEvent`。
3. **deepseek 是纯文本模型(已确认 `input: ["text"]`)**:pi-ai 的 `convertMessages` 对用户消息图片**无条件**
   序列化为 `image_url`(客户端不过滤),但对 deepseek 传图服务端无法识别;tool result 图片在
   `model.input.includes("image")` 时才附加(deepseek 直接丢弃)。**结论:粘贴图片必须走 vision-understand 工具
   (图片落盘 → 工具读路径),不能走 `session.prompt(text, { images })` 多模态管道。**
4. **仓库无任何文件上传/保存接口**(routes 只有只读 `/api/agent/fs/list`;无 multipart/formData/bodyLimit),
   需要新增一个上传路由。**方案 A(图片落盘 + 路径入文本)改动面远小于方案 B(base64 进消息体/SSE/历史)**,推荐 A。
5. **工具增强建议分两层**:v1.1 多图 `image_paths[]` + base64 `image_data[]`(改动小、安全面少);
   URL `image_urls[]` 涉及 SSRF 防护(IP 黑名单/DNS 校验/超时/大小限制),建议同批实现但单列测试组,或明确列为 v2。
6. **历史持久化零改动**(方案 A):图片路径拼进用户消息文本,JSONL/HistoryBlock/SSE 全链路天然持久化;
   缩略图仅会话内展示。只读工作区与上传目录位置是需要 planner 拍板的两个决策点(§6)。

---

## 1. A. 前端消息输入框与粘贴能力

### 1.1 输入框组件与事件监听(现状)

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 输入框组件 | `apps/web/src/components/ChatPane.vue` | 中栏聊天区;textarea `#chat-input`(`v-model="draft"`)+ 发送按钮 |
| 键盘事件 | `ChatPane.vue` `onKeydown(event)` | Enter(非 Shift/非 IME)→ `handleSend()`;`/` 开头触发 skill 下拉(方向键/Tab/Enter/Esc) |
| 发送逻辑 | `ChatPane.vue` `handleSend()` | `draft.trim()` 非空 && 非 streaming && 有工作区 → `props.agent.sendMessage(text)`;成功后清空 draft |
| 发送 API | `useAgent.ts` `sendMessage(text)` | `POST /api/agent/workspaces/:id/prompt`,body `JSON.stringify({ text })`;AbortController;SSE 逐行解析 `data:` 前缀 → `handleEvent(JSON.parse(...))` |
| 本地推送 | `useAgent.ts` `pushUserMessage(text)` | 发送前把 `{ kind:'text', text }` segment 的 user 消息 push 进 `messages`(SSE 的 message_start 不重复 push,注释明示) |
| SSE 处理 | `useAgent.ts` `handleEvent(event)` | text_delta / thinking_delta / tool_start/update/end / agent_start/end / done / error / sub_* / gate_required |
| 消息体类型 | `useAgent.ts` `UiMessage.segments: UiSegment[]` | `{kind:'text'|'thinking'|'tool'}`;`pushUserMessage` 现只造 text segment |

**paste/拖拽现状:全仓库无**。`ChatPane.vue` 无 `@paste`/`@drop`;`useAgent.ts` 无上传相关函数;
grep `paste|ClipboardEvent|drop|upload|multipart|formData` 在 `apps/web/src` 与 `apps/api/src` 均无命中。

### 1.2 输入框上方可插入缩略图预览的容器(现成布局位)

`ChatPane.vue` 输入区 DOM 结构(自顶向下,全部在 `<div class="shrink-0 border-t ... px-5 pb-3.5 pt-3">` 内):

```
1. gateRequest 块(v-if,计划待批准:批准/驳回按钮)      ← 条件渲染,非恒在
2. sendError 提示(p v-if)
3. 未配置 key 提示(p v-if)
4. <div class="flex items-center gap-2">               ← 输入行:label + textarea(relative 容器,内含 /skill 下拉) + 停止/发送按钮
5. <div class="mt-2.5 flex ...">                        ← 模型/思考级别快速切换行
```

→ **预览容器插入位 = 第 3 与第 4 之间**(恒在、位于输入行正上方,与竞品「输入框上方显示缩略图」一致);
也可复用 `flex items-center gap-2` 输入行的左侧(在 textarea 容器前横向排列缩略图)。后者更贴近
ChatGPT 桌面端的「缩略图在输入框内左侧」形态,但竖排(输入框上方一行横向滚动)更简单、不挤压 textarea。

### 1.3 前端发送消息的消息体(能否附图片)

- 消息体仅 `{ text }`(`routes.ts` `readJson<{ text?: string }>` + 非空校验;`useAgent.sendMessage` 同)。
- **无 images 字段、无文件字段**;`HistoryItem.blocks` / `UiSegment` 均无 image 类型。
- SSE 事件流:后端 `streamSSE` → `pi.prompt(workspace, text, onEvent)` → `mapSessionEvent`(piService.ts)
  映射为 shared `SessionEvent` 联合;前端 `handleEvent` 按 type 分发,增量累积到 pending 消息。
- **结论:附图片的最小改动路径 = 不改消息体结构,把图片路径以文本形式拼进 `text`**(方案 A,见 §3)。

---

## 2. B. 图片从浏览器到 agent 的传递路径(重点设计空间)

### 2.1 B4:现有上传/保存接口与写文件能力(现状:无)

- **API 层**:`apps/api/src/agent/routes.ts` 全部路由清单(grep 复核)中**无 upload/save/file 写接口**;
  仅有 `GET /api/agent/fs/list`(只读目录浏览,供添加工作区选择器;注释明示"本地开发工具,agent 本就可读全盘,故无额外鉴权")。
- **中间件层**:`apps/api/src/app.ts` 仅 `serveStatic` + SPA fallback + 统一错误/404;**无 body 大小限制、无 multipart 解析**。
  Hono + `@hono/node-server` 无默认 body 上限(JSON body 完整读入内存),大 base64 请求体可到达路由,由应用层自行限制。
- **pi 的 workspace 写文件能力**:
  - agent 侧:`write` / `bash`(LLM 工具,带 `guardPathTool`/`createWorkspaceBashHook` 守卫)——这是给模型用的,不是 API。
  - API 侧:无任何能把 base64 写入工作区文件的接口 → **必须新增上传路由**。
- **run 产物目录**(`apps/api/src/pi/runManager.ts`):`<workspace>/.wf-runs/<runId>/`,工作区内、进 git、删会话不删产物;
  由 `createRun` 创建(子代理调用时才建)。**发送消息时 run 可能尚不存在**,所以上传目录**不宜挂在 runId 下**。

### 2.2 B5:deepseek 收到图片会怎样(已确证:必须走工具)

- **模型能力**:`apps/api/node_modules/@earendil-works/pi-ai/dist/providers/data/deepseek.json`:
  `deepseek-v4-flash` / `deepseek-v4-pro` 均 `"input": ["text"]`(纯文本,无 image)。
- **pi-ai 序列化行为**(`dist/api/openai-completions.js` `convertMessages()`):
  - 用户消息中的 `ImageContent` → `{ type:'image_url', image_url:{ url:'data:<mime>;base64,<data>' } }`,
    **无条件转换,不过滤 `model.input`** → 若对 deepseek 调 `session.prompt(text, { images })`,请求体仍会带 image_url,
    DeepSeek 服务端无法识别(大概率 400 或忽略),且即使接受模型也看不到图;
  - tool result 中的图片:**`hasImages && model.input.includes("image")` 才附加** → deepseek 下工具返回图片被丢弃。
- **结论**:`session.prompt(text, { images })` 多模态管道对当前唯一主模型(deepseek)不可用;
  图片必须「落盘/存在于工作区 → agent 调 vision-understand(image_paths) → 工具内读图 → 小米视觉模型识别 → 文字回传」。
  (这是上个 run 02-plan-2 已定案的路线,本次补充确认了 SDK 层行为。)

### 2.3 B6:两种传递方案评估

#### 方案 A:图片落盘 + 路径入文本(推荐)

流程:前端粘贴 → canvas 压缩 → base64 → `POST /api/agent/workspaces/:id/uploads` → 后端写
`<workspace>/.wf-uploads/<uuid>.<ext>` → 返回相对路径 → 前端把路径拼进消息文本(如
`[图片: .wf-uploads/xxx.png] 请分析这张截图`)+ 缩略图留在会话内 → agent 收到文本 → 调用
`vision-understand(image_paths=['.wf-uploads/xxx.png'])` → 文字描述回传。

| 改动面 | 内容 | 规模 |
| --- | --- | --- |
| 后端路由 | `routes.ts` 新增 1 个 `POST /api/agent/workspaces/:id/uploads`(base64 收图、体积/mime 校验、写盘、返回相对路径) | 小(~60 行 + 测试) |
| 后端工具 | `visionTools.ts` 增强:多图数组 + base64(data URL)输入(见 §4) | 中 |
| 前端 | `ChatPane.vue` `@paste` + 预览条 + 删除;`useAgent.ts` 新增 `uploadImage()` | 中 |
| shared 类型 | **零改动** | — |
| HistoryBlock / JSONL | **零改动**(路径在 user 消息文本里,pi `SessionManager` 原样持久化;`renderHistory` 的 `extractText` 天然透出) | — |
| SSE | **零改动**(`tool_end.output` 仍为文本;工具调用参数经 `HistoryBlock.tool.args` 可见) | — |

#### 方案 B:消息体扩展 images 字段(base64 数组)

流程:前端粘贴 → base64 → `sendMessage({ text, images: [...] })` → 后端存临时文件 → 注入 agent 上下文。

| 改动面 | 内容 | 规模 |
| --- | --- | --- |
| 后端路由 | `POST .../prompt` body 校验扩展 | 小 |
| 后端服务 | `piService.prompt()` 签名、临时文件管理 | 中 |
| shared 类型 | `SessionEvent`(新 image 事件)、`HistoryBlock`(新 image 块)、`HistoryItem` | 中 |
| 前端 | `UiSegment` 新类型、`handleEvent` 新分支、`MessageBubble` 渲染 | 中 |
| 历史持久化 | **JSONL 中 user 消息 content 数组含 image 项 → base64 直接落盘**(pi 序列化 UserMessage.content 数组原样存),会话文件体积爆炸、回放时要回传 base64 给 tool result | 大且差 |
| 上下文 | base64 注入 LLM 上下文对 deepseek 无意义(§2.2),必须转路径再走工具 → 绕一大圈回到方案 A | 冗余 |

**评估结论:推荐方案 A。** 理由:(a) 全链路(SSE/历史/JSONL/前端渲染)零类型改动,文本路径天然持久化;
(b) base64 只在「前端 → 上传接口」与「工具 → 小米 API」两段短生命周期内出现,不进会话文件;
(c) 复用既有 vision-understand 的守卫/错误/截断纪律,agent 行为可控(模型可自行决定是否识图、识图失败可自纠);
(d) 方案 B 的「注入上下文」最终也必须落盘成路径才能被工具消费,凭空多出消息体/事件/历史三层改动。
方案 B 唯一优势是消息体语义结构化,但可用「文本约定 + 工具参数」达成同等效果,收益不抵成本。

---

## 3. C. vision-understand 工具增强点

### 3.1 C7:当前结构与多图/URL/base64 增强点

**当前结构**(`apps/api/src/pi/visionTools.ts`,v1 已落地):

```
常量:VISION_TOOL_NAME='vision-understand' / VISION_ENDPOINT(api.xiaomimimo.com/v1/chat/completions) /
      VISION_MODEL='mimo-v2.5' / DEFAULT_TIMEOUT_MS=60_000 / MAX_IMAGE_BYTES=10MB /
      SUPPORTED_MIME={ jpg/jpeg/png/gif/webp }(按扩展名判定)
schema:Type.Object({ image_path: Type.String(必填), question: Type.Optional(Type.String()) })
callVision(opts, params, signal):
  abortIfSignaled → image_path 非空 → isAllowedTargetPath(守卫,extraAllowedRoots=skills 放行根)
  → stat 体积(>10MB 拒绝,先 stat 后 readFile)→ mimeFor(扩展名白名单)→ resolveApiKey(env XIAOMI_API_KEY > getApiKey())
  → readFile → base64 → fetch POST(单 image_url + text,stream:false,AbortSignal.any([60s, signal]))
  → mapHttpError 分层 / 结构校验 / truncateOutput(50KB)
createVisionTools(options) → ToolDefinition[](仿 createAnySearchTools;fetchImpl/endpoint/timeoutMs/maxImageBytes 可注入)
```

**增强设计(v1.1 建议)**:

1. **schema 扩展**(TypeBox,三路输入可选 + 互不排斥,`question` 保留):
   ```ts
   const visionSchema = Type.Object({
     image_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),  // 工作区相对路径(沿用守卫)
     image_data:   Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),  // data URL(data:<mime>;base64,<...>)或裸 base64
     image_urls:   Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),  // https URL(需 SSRF 防护,§3.2)
     question:     Type.Optional(Type.String()),
   })
   ```
   - 兼容:保留 v1 的 `image_path` 单数键(或直接移除——agent 是新注册,无历史调用需兼容,建议移除换 `image_paths` 并更新 description;planner 拍板)。
2. **callVision 重构**:单输入 → 三路归并循环:
   - `image_paths[]`:逐张走现有流程(守卫 → stat → mimeFor → readFile → base64);
   - `image_data[]`:解析 data URL(`/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/`)→ mime 白名单 + 解码后字节 ≤10MB;裸 base64 需魔数嗅探推断 mime(png `\x89PNG`、jpeg `\xFF\xD8\xFF`、gif `GIF8`、webp `RIFF....WEBP`)或直接拒绝;
   - `image_urls[]`:下载转 base64(见 §3.2),**不直传 URL 给小米**(避免小米服务端外网/SSRF 不确定性,统一 data URL 形态)。
3. **请求体 content 数组组织**(小米 OpenAI 兼容协议,多图 = 多个 image_url 项,text 放最后):
   ```json
   {
     "model": "mimo-v2.5",
     "messages": [{ "role": "user", "content": [
       { "type": "image_url", "image_url": { "url": "data:image/png;base64,<...>" } },
       { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,<...>" } },
       { "type": "text", "text": "<question>" }
     ]}],
     "stream": false
   }
   ```
   混合顺序 = 三路参数按 schema 声明序拼接;总字节上限建议 20MB(8×10MB 会超出小米单请求可承受量,planner 定)。
4. **description 同步更新**:写明三路输入、单图 ≤10MB、总上限、支持格式,提示「图片在本机时用 image_paths(推荐),
   剪贴板/网页图片可用 image_data/image_urls」。

### 3.2 C8:安全设计(URL 的 SSRF / base64 体积 / 与现有守卫的关系)

**URL 输入(image_urls)SSRF 防护**(护栏定位,与 workspaceGuard.ts 头注「护栏,非安全边界」同哲学):
1. **协议白名单**:仅 `https:`(`new URL(u)` 解析;`http:`/`file:`/`data:` 等拒绝);
2. **主机名解析后 IP 黑名单**:`dns.lookup(hostname, { all: true })` → 任一地址命中内网/保留段即拒绝:
   `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`0.0.0.0/8`、
   `::1`、`fc00::/7`(ULA)、`fe80::/10`(link-local);Node 20 的 `fetch`(undici)不支持自定义 DNS,
   采用「解析校验后连接」的简单方案,残余 DNS rebinding 窗口接受(与守卫「符号链接不解析」同级的信任取舍);
3. **下载限制**:`AbortSignal.timeout(10_000)` 下载超时;`redirect: 'follow'` 但限制重定向次数(默认 20 次,可显式设 `redirect: 'manual'` + 手工跟随 1-2 跳,每跳重新校验协议与 IP——v1 可简化为 `redirect:'follow'` 并接受同源重定向,planner 定);
4. **大小限制**:流式读 body,累计 >10MB 即 abort(不能整包读入后再判);
5. **mime 校验**:响应 `Content-Type` 白名单 + 魔数嗅探(与 image_data 共用 `sniffMime` 工具函数)。

**base64 输入(image_data)**:
- data URL 形式:`data:<mime>;base64,<payload>`;mime 白名单(SUPPORTED_MIME 值域);解码后字节 ≤10MB;
- 裸 base64:魔数嗅探推断 mime,嗅探失败 → 报「无法识别图片格式」;
- base64 解码用 `Buffer.from(s, 'base64')`,先按长度粗判(`len * 3/4 ≤ 10MB`)再解码,防超大字符串分配。

**与 workspaceGuard.isAllowedTargetPath 的关系**:
- `image_paths`:**继续走 `isAllowedTargetPath(imagePath, workspacePath, extraAllowedRoots)`**(工作区 + skills 放行根),
  与 v1 完全一致——三路输入中只有路径输入受文件边界守卫;
- `image_data` / `image_urls`:不是文件路径,**不走路径守卫**,走上述新的协议/IP/体积/mime 校验;
  二者与 workspaceGuard 无冲突(guard 是路径语义,新校验是"外部资源摄取"语义),各自独立;
- 上传路由写入 `<workspace>/.wf-uploads/` 时,目标路径本身在工作区内,天然满足 `isAllowedTargetPath`,
  无需额外放行;文件名用 `randomUUID()` 生成,不信任客户端文件名。

### 3.3 C9:现有单测结构与增强后的测试点

**现有范式**(两个可仿模板):
- `apps/api/src/pi/visionTools.test.ts`(19 用例):`fetchImpl` mock(`makeFetchMock` 记录 url/init)+
  `mkdtempSync` 临时工作区 + 1×1 PNG base64 fixture + `vi.stubEnv('XIAOMI_API_KEY', ...)`;断言请求构造
  (端点/Bearer/model/stream/data URL 序列化/question 透传)、key 优先级、成功、50KB 截断、HTTP 错误分层、
  结构缺失、文件不存在、超限、不支持格式、越界(不发请求)、skills 放行根、预置/执行中 abort、超时、工厂形状。
- `apps/api/src/agent/visionRoutes.test.ts`(6 用例):`mkdtempSync` fake store + `PiAgentService` 私有构造
  (runtime stub `{ getModels:()=>[], getModel:()=>undefined }`)+ `registerAgentRoutes` 组装 Hono app,
  断言保存落盘/400 零写入/空串清空/响应无 key 明文/翻转重建接线。

**增强后新增测试点(v1.1)**:
1. 多图请求构造:`image_paths: ['a.png','b.jpg']` → content 恰好 2 个 image_url 项(顺序一致)+ 1 个 text 项;question 缺省/透传;
2. `image_data` data URL:正确 mime 透传、解码后 base64 与源一致;非法 data URL / 非白名单 mime / 超限 → 明确错误零请求;
3. 裸 base64 魔数嗅探:png/jpeg/webp 各一;无法嗅探 → 报错;
4. `image_urls`:https 通过(mock fetch 下载 → 转 data URL 进请求体);http 拒绝;`127.0.0.1`/`10.x`/`192.168.x`/`169.254.x`/`::1` 拒绝(注入 `dns.lookup` stub 或抽 `isBlockedIp(ip)` 纯函数直测);下载超时(AbortSignal.timeout 生效);下载超限(流式计数 abort);Content-Type 非白名单 → 报错;
5. 混合模式:三路混用顺序正确;
6. 守卫回归:`image_paths` 含越界路径 → 工作区边界拦截(零请求);
7. 总字节上限:多图合计超限报错;
8. 上传路由(新):成功返回相对路径(`.wf-uploads/<uuid>.png`)、体积超限 400、mime 不支持 400、空 body 400、文件名不信任(响应只含服务端生成路径)、只读工作区行为(§6 决策);
9. 前端:`ChatPane` paste 事件(mock ClipboardEvent + File)、缩略图渲染/删除、`useAgent.uploadImage` 请求体与错误处理。

---

## 4. D. 其他

### 4.1 D10:HistoryBlock / 会话历史持久化(评估:会话内展示 vs 历史回放)

- **持久化机制**:会话 JSONL 由 pi SDK `SessionManager` 管理(`.workflows/agent/sessions/<workspaceId>/*.jsonl`);
  user 消息 content 为**字符串**(方案 A 路径拼在文本里)→ 原样落盘、零改动;
  `apps/api/src/pi/history.ts` `renderHistory()` 对 user 消息 `extractText(content)` → `{ type:'text', text }` 块;
  `packages/shared` `HistoryBlock` 联合类型无 image 成员(现状)。
- **评估结论**:
  - **会话内(实时)**:缩略图必须展示(粘贴预览 + 发送后气泡内可见可选);
  - **历史回放(切换会话/重开工作区)**:v1 **不持久化缩略图**——文本路径已可读(用户消息显示
    `[图片: .wf-uploads/xxx.png] 请分析…`),图片文件也在工作区内可随时打开;持久化缩略图需要
    `HistoryBlock` 增加 `{ type:'image', ... }` 成员 + `renderHistory` 分支 + `applySessionData`/`MessageBubble` 渲染,
    且上传目录清理后缩略图会 404(与路径文本的「引用失效可感知」不同,是「静默坏图」)——收益低、引入失效态,不建议 v1 做;
  - 可选结构化升级(v2):`HistoryBlock` 增加 `images?: Array<{ path: string; thumbnail?: string }>`(thumb 用小尺寸 base64
    或 data URL),SSE 增加 `user_message` 事件携带,前端历史恢复时渲染。仅当产品要求「历史中看图」时再做。
- **messages JSONL 中的表示**(方案 A):user 消息 content 仍是纯字符串(路径嵌入),无任何新结构;
  agent 的 `toolCall` 块 `arguments` 中会含 `{"image_paths": [...]}`,经 `HistoryBlock.tool.args` 已有暴露,回放可查证调用。

### 4.2 D11:竞品式交互的最小改动集(方案 A 落地清单)

竞品参考(Claude/ChatGPT 桌面与 Web):粘贴(Ctrl+V)剪贴板图片 → 输入框上方出现缩略图(带删除 ×)→
Enter 发送 → 图片随消息发出 → agent 收到图片并处理。

| # | 层 | 文件 | 改动 |
| --- | --- | --- | --- |
| 1 | 后端路由 | `apps/api/src/agent/routes.ts` | 新增 `POST /api/agent/workspaces/:id/uploads`:body `{ data: string(base64), mimeType: string }`;
   mime 白名单 + 解码 ≤10MB(前端已压缩,后端仍兜底);写 `<workspace>/.wf-uploads/<uuid>.<ext>`;返回 `{ path }`(相对路径);超限/非法 400 |
| 2 | 后端存储 | `apps/api/src/config.ts`(或 routes 内常量) | 上传目录常量 `.wf-uploads`(点前缀隐藏,工作区内,git 可见性由 workspace 自身 .gitignore 决定——与 `.wf-runs` 同语义) |
| 3 | 后端工具 | `apps/api/src/pi/visionTools.ts` | §3.1 增强:schema 三路输入 + 归并循环 + content 数组组装 + mime/体积校验 + (URL 时)SSRF 防护 |
| 4 | 后端注册 | `apps/api/src/pi/piService.ts` / `subAgent.ts` | **零改动**(createVisionTools 参数 workspacePath/getApiKey/extraAllowedRoots 已就位;新参数如 maxTotalBytes 走工厂 options 注入即可) |
| 5 | 前端输入 | `apps/web/src/components/ChatPane.vue` | textarea `@paste`(ClipboardEvent → `clipboardData.items` → File(image 类型)→ `URL.createObjectURL` 即时预览 → canvas 压缩 → base64);`@drop`/`@dragover` 可选;预览条组件(输入行上方,缩略图 grid + 每张删除按钮);发送时若带图且 draft 为空也允许发送 |
| 6 | 前端压缩 | `ChatPane.vue` 内工具函数(或 `apps/web/src/utils/`) | canvas `drawImage` → `toBlob('image/jpeg'|'image/webp', 0.85)`,最大边 ≤2048px(截图 2-5MB → ~200-500KB);生成 data URL/base64 供上传 |
| 7 | 前端 API | `apps/web/src/composables/useAgent.ts` | 新增 `uploadImage(dataUrl: string): Promise<string>`(POST /uploads,返回路径);`sendMessage(text)` 不变,带图时先 `Promise.all(uploadImage)` 再拼 `[图片: <path>] <text>` 发送(路径拼接格式需与工具 description 呼应,让 agent 知道图片在工作区、可用 vision-understand) |
| 8 | 前端状态 | `useAgent.ts` | `UiMessage` 可增加可选 `images?: { path: string }[]`(仅会话内展示用,不持久化);或 v1 只展示文本路径(更小) |
| 9 | 测试 | 见 §3.3 第 8/9 组 | upload 路由 + visionTools 增强 + ChatPane paste + useAgent.uploadImage |

**只读工作区交互决策**(planner 需拍板):
- 方案 A1(推荐):只读工作区**禁用粘贴图片**(上传 = 写盘,违反只读语义;前端按 `agent.activeWorkspace.readOnly` 置灰/提示);
- 方案 A2:上传到系统临时目录(`os.tmpdir()/workflows-uploads/`)——`isAllowedTargetPath` 对临时目录天然放行,
  vision-understand 可读;但跨重启不持久(历史回放路径失效),只读工作区语义上「只读」仍是软件层约束,可接受;
- 建议 A1 为主(A2 作为 follow-up)。

**其他决策点**:
- 上传目录清理:孤儿图片无 TTL 机制,v1 可接受(与 `.wf-runs` 同哲学:删除工作区时由 `cleanupWorkspaceSessions` 之外的显式清理,或留给用户);planner 定是否加「上传时按 mtime 清理 >30 天」。
- 发送时图片未上传成功:预览条显示失败态,不发送。
- 多图上限:粘贴队列 ≤8 张;总字节(压缩后)≤20MB(与工具总上限一致)。

---

## 5. 关键发现与风险点

1. **vision-understand v1 已合入,本次是增强而非新建**:`visionTools.ts` 结构/纪律/测试范式齐备,
   增强应保持「错误返回文本不 throw、唯一透传 Operation aborted、key 脱敏、守卫先行」既有纪律。
2. **前端粘贴能力为零起点**:ChatPane 只有 keydown;paste/drop 处理、canvas 压缩、预览 UI、上传 API 全部新建;
   注意 IME 组合输入(`event.isComposing`)在 paste 场景无影响,但 Enter 发送逻辑需兼容「无文本纯图发送」。
3. **方案 A 全链路零类型改动**是最大优势:shared `SessionEvent`/`HistoryBlock`/`UiSegment` 均不动,
   JSONL 历史天然含图片路径;方案 B 的 base64 落盘是硬伤(会话文件膨胀 + 回放失效)。
4. **deepseek 纯文本已确证**(`input:["text"]` + convertMessages 行为),任何「直接传图给主模型」的路径都不可行;
   图片能力完全依赖 vision-understand 工具,即依赖 vision 开关与小米 key(`visionAvailable` 门)。
5. **URL 输入是安全面最大的增量**:SSRF 防护(协议白名单/DNS 解析后 IP 黑名单/下载超时/流式大小限制/魔数嗅探)
   与 workspaceGuard 的路径守卫是**正交**的两套校验,不能混用;若想控制 v1.1 范围,可先做
   `image_paths` + `image_data`,`image_urls` 列为 v2(本报告给出完整方案,planner 定取舍)。
6. **上传目录与只读工作区**:`.wf-uploads/` 写入 = 写操作;只读工作区禁用(推荐)或写临时目录(放行但易失效);
   目录命名与清理策略需在计划中明确,避免孤儿文件。
7. **测试范式已定型**:visionTools.test.ts(fetchImpl mock + tmpdir fixture)与 visionRoutes.test.ts(私有构造 hack)
   可直接沿用;新增 `dns.lookup`/IP 校验建议抽纯函数(`isBlockedIp`)以零网络直测。
8. **`.workflows/config.json` 已含 `visionEnabled: true` 与 `visionApiKey`(真实 key)**,说明 v1 已启用;
   冒烟验证时可直连小米 API(报告脱敏)。

---

## 6. 结论:可行性判断与建议

**可行性:高。** v1 工具已就位,SDK/守卫/注册机制全部验证过;本次增量 = 「1 个上传路由 + 1 个工具增强 + 1 段前端粘贴 UI」,
无架构性改动。

**推荐方案(供 planner 制定计划)**:
1. **传递路径 = 方案 A**(上传落盘 + 路径入文本),不做消息体/SSE/历史类型扩展;
2. **vision-understand v1.1 增强** = `image_paths[]` + `image_data[]`(data URL)两路先行,
   `image_urls[]`(含 SSRF 防护)建议同批实现(安全方案已完整给出)或显式列为 v2;
3. **上传接口** = `POST /api/agent/workspaces/:id/uploads` → `<workspace>/.wf-uploads/<uuid>.<ext>`,
   只读工作区禁用(前端置灰);
4. **前端** = ChatPane `@paste` + canvas 压缩(≤2048px/0.85)+ 输入行上方缩略图预览条(可删)+
   `useAgent.uploadImage` + 发送拼接 `[图片: <path>] <text>`;缩略图仅会话内展示,历史回放显示路径文本;
5. **测试** = 沿用两套既有范式补齐 §3.3 清单;验证脚本可扩展 `verify-vision.mjs` 支持多图参数形状。

**给 planner 的决策清单**:上传目录名/位置(默认 `.wf-uploads/`)、只读工作区行为(默认禁用)、
`image_urls` 是否进 v1.1(默认进,若压缩范围则列 v2)、多图上限(默认 8 张/20MB)、
v1 `image_path` 单数键去留(默认移除换 `image_paths`)、历史缩略图(v1 不做,路径文本已可读)。
