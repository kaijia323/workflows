# 02 实施计划:vision-understand 工具增强 + 前端粘贴图片缩略图

> 基于 `.wf-runs/72dc5d3b/01-exploration-1.md`(探索报告,已核实全部架构事实)。
> 本次实施仅做调研与规划补充验证,已直接阅读 `visionTools.ts` / `routes.ts` / `ChatPane.vue` /
> `useAgent.ts` / `MessageBubble.vue` / `visionTools.test.ts` / `ChatPane.test.ts` /
> `mock-xiaomi-server.mjs` / `verify-vision.mjs` / 根 `package.json`,计划全部文件级可执行。

---

## 1. 目标与范围

### 做什么

1. **vision-understand 工具增强(v1.1)**:`image_paths[]`(工作区路径,沿用守卫)+ `image_data[]`
   (base64/data URL)+ `image_urls[]`(HTTPS URL,SSRF 防护)三路输入,多图一次调用小米 API。
2. **新增上传路由**:`POST /api/agent/workspaces/:id/uploads`,前端压缩后的图片写入
   `<workspace>/.wf-uploads/`,返回相对路径。
3. **前端粘贴图片**:ChatPane textarea 支持 Ctrl+V 粘贴剪贴板图片 → 压缩 → 输入框上方缩略图条
   (可删除、数量/体积提示)→ 发送时先上传、图片路径随消息文本走(方案 A)→ 用户消息气泡内展示缩略图。
4. **测试与验证**:后端 9 组新增单测 + 前端单测 + mock 服务器扩展 + 浏览器冒烟清单。

### 不做什么(明确排除)

- **不改 shared 类型 / SSE 事件 / HistoryBlock / JSONL 持久化**(方案 A 核心优势,路径在文本里天然持久化)。
- **不做** `sendMessage({ text, images })` 消息体扩展(方案 B 否决)。
- **不做** 历史回放时的缩略图恢复(v1 仅会话内展示;历史中图片以文本路径 `[图片: .wf-uploads/x.webp]` 呈现)。
- **不做** 拖拽(drop)上传(v1 仅 paste;`@drop` 标记为 follow-up)。
- **不做** 上传目录的定时清理任务(仅做上传时惰性清理,见 §2 决策 7)。
- **不做** 图片 OCR 独立工具、图片尺寸/EXIF 元数据提取等增值功能。

### 传递路径(方案 A,已定案)

```
粘贴 → canvas 压缩(≤2048px / webp 0.85)→ data URL
→ POST /uploads(后端嗅探 mime → 写 .wf-uploads/<uuid>.<ext>)
→ 返回相对路径 → 文本拼接 [图片: <path>] 原文本
→ sendMessage(文本)→ deepseek 看到路径 → 调 vision-understand(image_paths)
→ 工具读文件 → 小米 mimo-v2.5 识图 → 文字回传
```

---

## 2. 关键决策(已按探索报告默认值拍板,实施前请用户确认)

| # | 决策项 | 拍板值 | 理由 |
| --- | --- | --- | --- |
| 1 | 上传目录名/位置 | `<workspace>/.wf-uploads/`(点前缀隐藏,与 `.wf-runs` 同语义) | 工作区内天然满足 `isAllowedTargetPath`;不挂 runId 下(发送消息时 run 可能不存在) |
| 2 | 只读工作区行为 | **禁用上传**:后端 403 + 前端粘贴时提示并拒绝 | 上传=写盘,违反只读语义;双保险 |
| 3 | `image_urls` 是否进本次 | **进**(完整实现 SSRF 防护,单列测试组) | 方案已完备;若压缩范围可退化为仅 `image_paths`+`image_data`(§5 风险 5 有回滚说明) |
| 4 | 多图上限 | **8 张 / 单张 ≤10MB / 总量 ≤20MB** | 与探索报告建议一致;总量按字节在请求前累加校验 |
| 5 | v1 `image_path` 单数键去留 | **保留为兼容别名**(内部归一化进 `image_paths`;description 标注 deprecated) | 成本 3 行;避免破坏已落盘 JSONL 中 toolCall 参数回看语义与任何潜在外部调用 |
| 6 | 历史缩略图持久化 | v1 不做;用户消息气泡内缩略图用**前端内存 data URL**(切会话/刷新即释放,不落盘) | 零持久化改动;坏图失效态规避 |
| 7 | 上传目录清理 | 上传时惰性清理:同目录 mtime > 30 天的文件删除(每次上传触发,~10 行) | 防孤儿堆积;不做独立定时任务 |
| 8 | 上传请求形态 | JSON body `{ data: string, mimeType?: string }`,**单张/请求**,前端 `Promise.all` 并行 | 不引入 multipart 依赖;单张请求失败语义清晰(哪张失败返回哪个错误);Hono 无默认 body 上限,应用层校验 |
| 9 | 图片格式 | 压缩输出 **WebP**(不支持时降级 JPEG);接受 JPEG/PNG/GIF/WebP | 与工具 mime 白名单一致 |
| 10 | 消息中图片标记文本 | `[图片: .wf-uploads/<uuid>.<ext>]`(多图重复前缀)+ 原文本 | 与工具 description 呼应,agent 可见路径即可调工具 |

---

## 3. 实施步骤(4 个 Phase,4 个可独立回滚 commit)

### Phase 1:后端工具增强(visionTools.ts)——Commit 1

**改动文件**:
- `apps/api/src/pi/imageMime.ts`(**新建**):从 visionTools.ts 抽出并导出 `SUPPORTED_MIME`(值域不变)、
  `MAX_IMAGE_BYTES = 10MB`,新增纯函数 `sniffMime(buffer: Buffer): string | undefined`(魔数嗅探:
  PNG `89 50 4E 47` / JPEG `FF D8 FF` / GIF `47 49 46 38` / WebP `52 49 46 46 .... 57 45 42 50`);
  上传路由(Phase 2)与工具共用,避免重复。
- `apps/api/src/pi/visionTools.ts`(增强):
  1. **schema 扩展**:
     ```ts
     const visionSchema = Type.Object({
       image_path: Type.Optional(Type.String({ description: '…(deprecated,请用 image_paths)' })),
       image_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: '…' })),
       image_data:   Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: 'data URL 或裸 base64' })),
       image_urls:   Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: 'https URL' })),
       question:     Type.Optional(Type.String()),
     })
     ```
  2. **归并逻辑**(`callVision` 重构):入口先归一化 `image_paths = [...(params.image_path ? [params.image_path] : []), ...(params.image_paths ?? [])]`;
     三路全部为空 → 报「至少提供 image_paths / image_data / image_urls 之一」;逐张产出 `{ mime, base64 }`,顺序 = schema 声明序
     (path → data → url),总数 > 8 报错,字节累计 > 20MB 报错(新增工厂 option `maxTotalBytes` 可注入,默认 20MB)。
  3. **image_paths 路**:沿用 v1 现有流程(守卫 `isAllowedTargetPath` → stat 体积 → `mimeFor` → readFile),逐个提取为循环。
  4. **image_data 路**:data URL 正则 `/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/` → mime 必须在 SUPPORTED_MIME 值域;
     裸 base64(无 `data:` 前缀)→ `sniffMime` 推断,嗅探失败报「无法识别图片格式」;长度粗判(`len*3/4 ≤ maxImageBytes`)后再解码,解码后复检字节数。
  5. **image_urls 路**(SSRF 防护,新 helper `downloadImageUrl(url, opts)`):
     - 协议白名单:`new URL()` 解析,仅 `https:`;`http:`/`file:`/`data:` 拒绝;
     - DNS 校验:`dns.lookup(hostname, { all: true })` → 任一 IP 命中 `isBlockedIp` 即拒绝(不发起连接);
     - 新纯函数 `isBlockedIp(ip: string): boolean`(visionTools.ts 内导出,测试直测零网络):
       `127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`0.0.0.0/8`、`::1`、`fc00::/7`、`fe80::/10`;
     - 下载:`fetchImpl(url, { signal: AbortSignal.any([AbortSignal.timeout(10_000), signal]) })`,`redirect: 'follow'`
       (残余 DNS rebinding 窗口接受,与 workspaceGuard 符号链接不解析同级信任取舍,代码注释注明);
     - 流式读取 body(`res.body.getReader()`),累计 > maxImageBytes 即 abort,禁止整包读入;
     - 响应校验:`Content-Type` 白名单(SUPPORTED_MIME 值域)+ `sniffMime` 嗅探字节;
     - 下载的图**转 data URL** 进请求体,不直传 URL 给小米。
  6. **请求体组装**:content = 各图 `{ type:'image_url', image_url:{ url: dataUrl } }` 项 + 末尾 `{ type:'text', text: question }`;
     `stream:false` 不变;单图时与 v1 序列化结果逐字节一致(现有 19 测试须全绿)。
  7. **错误分层纪律保持**:任何异常落可读错误文本(abort 唯一透传 `Operation aborted`)、key 脱敏、守卫先行、
     先校验后请求;`mapHttpError` 复用。
  8. **description 更新**:写明三路输入语义、上限(8 张/10MB 单张/20MB 总量)、格式白名单、
     「本机图片用 image_paths(推荐),剪贴板/网页图片用 image_data/image_urls」、image_path 已弃用提示;
     同时提示 agent「用户消息中的 `[图片: …]` 路径在工作区 `.wf-uploads/` 下,可用本工具分析」。
- `apps/api/src/pi/visionTools.test.ts`(新增 ~9 组,沿用 makeFetchMock + mkdtemp 范式):
  1. 多图请求构造:`image_paths:['docs/a.png','docs/b.jpg']` → content 恰 2 个 image_url 项(顺序一致)+ 1 个 text 项;question 缺省默认/透传;
  2. image_path 兼容别名:仅传 `image_path` 与传 `image_paths:[同路径]` 请求体一致;
  3. image_data data URL:合法 mime 透传、解码 base64 与源一致;非法 data URL / 非白名单 mime / 解码超限 → 明确错误且零请求;
  4. 裸 base64 嗅探:png / jpeg 各一成功,webp 一例;嗅探失败 → 报「无法识别图片格式」;
  5. image_urls:https + 白名单 mime 通过(mock fetch 返回图片流 → 请求体为 data URL);http 拒绝;
     `isBlockedIp` 直测(`127.0.0.1`/`10.x`/`172.16.x`/`192.168.x`/`169.254.x`/`::1`/`fc00::`/`fe80::` 拒绝,公网 IP 放行);
     dns.lookup 返回内网 IP → 拒绝且零下载请求(vi.mock `node:dns` 或注入 `lookupImpl` 工厂 option);
     下载超时(10s 信号)与下载超限(流式计数 abort)→ 明确错误;
  6. 混合三路:顺序 = path → data → url,content 项数与顺序断言;
  7. 守卫回归:image_paths 含越界路径 → 工作区边界拦截(零请求);
  8. 上限:9 张拒绝;总量 > 20MB(注入小 maxTotalBytes 模拟)拒绝;
  9. 多图响应:mock 返回多图场景下仍成功;错误响应分层回归(400/401/429/5xx 文案不变)。

**预期结果**:`pnpm --filter @workflows/api test` 全绿(含原有 19 用例);`pnpm typecheck` 通过。

---

### Phase 2:后端上传路由(新)——Commit 2

**改动文件**:
- `apps/api/src/agent/routes.ts`(新增 1 个路由 + 常量):
  ```ts
  const UPLOADS_DIR = '.wf-uploads'
  const UPLOAD_MAX_BYTES = 10 * 1024 * 1024          // 单张(与工具单图上限一致)
  const UPLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000     // 惰性清理阈值(决策 7)

  // POST /api/agent/workspaces/:id/uploads
  app.post('/api/agent/workspaces/:id/uploads', async (c) => {
    const workspace = requireWorkspace(store, c.req.param('id'))
    if (workspace.readOnly) throw new HTTPException(403, { message: '只读工作区不支持上传图片' })
    const body = await readJson<{ data?: string }>(c)
    const data = body?.data?.trim()
    if (!data) throw new HTTPException(400, { message: '缺少图片数据(data)' })
    // 长度粗判(len*3/4 ≤ 10MB)防超大字符串分配 → Buffer.from(base64) → sniffMime 定 mime(不信客户端)
    // → 未识别 400「不支持的图片格式(支持 JPEG/PNG/GIF/WebP)」→ 写盘 <ws>/.wf-uploads/<randomUUID()>.<ext>
    // → 惰性清理同目录 mtime > 30 天文件 → 返回 { path: '.wf-uploads/<uuid>.<ext>' }
  })
  ```
  要点:
  - 文件名用 `randomUUID()`,**不信任客户端文件名/扩展名**;扩展名由 `sniffMime` 结果决定;
  - `mkdir(dirname, { recursive: true })`;写盘用 `writeFile`(先落临时名再 rename 可选,写盘失败 500);
  - 响应形状与全仓一致 `{ code: 0, message: 'ok', data: { path } }`;
  - mime 白名单/嗅探/体积常量从 `apps/api/src/pi/imageMime.ts` import(Phase 1 产物);
  - 只读校验放 requireWorkspace 之后、任何解析/写盘之前(403 优先);
  - 路由注册位置:放在 `prompt` 路由附近(会话区段内),与既有 `requireWorkspace` 模式一致。
- `apps/api/src/agent/uploadsRoutes.test.ts`(**新建**,仿 visionRoutes.test.ts 范式:
  私有构造 `PiAgentService` + `registerAgentRoutes` 组装 Hono app + mkdtemp 临时工作区/store):
  1. 成功:合法 PNG base64 → 200 + `data.path` 匹配 `/^\.wf-uploads\/[0-9a-f-]{36}\.png$/`,文件确实落盘且内容与源一致;
  2. 体积超限:>10MB base64(粗判阶段)→ 400,零写盘;
  3. mime 不支持:随机字节 → 400「不支持的图片格式」,零写盘;
  4. 空 body / 缺 data → 400;
  5. 只读工作区 → 403,零写盘;
  6. 工作区不存在 → 404;
  7. 文件名字段不可信:body 带 `fileName: '../../evil.png'` → 响应路径仍为服务端 uuid 名;
  8. 惰性清理:预置 31 天前 mtime 文件 + 本次上传 → 旧文件被删、新文件保留。
- **shared 类型:零改动**(前端局部定义 `{ path: string }` 响应类型即可)。

**预期结果**:新增测试 8 组全绿;`pnpm --filter @workflows/api test` 通过;手动 curl 验证 403/400/200 分支。

---

### Phase 3:前端粘贴缩略图(ChatPane.vue + useAgent.ts + MessageBubble.vue)——Commit 3

**改动文件**:
1. `apps/web/src/utils/image.ts`(**新建**):
   ```ts
   /** 压缩剪贴板图片:最长边 ≤2048px,WebP 0.85(不支持降级 JPEG);返回上传用 data URL 与缩略图 data URL */
   export async function compressImage(file: File | Blob): Promise<{ dataUrl: string; thumbUrl: string }>
   ```
   实现:createImageBitmap(或 Image + objectURL)→ canvas drawImage(等比缩放)→
   `canvas.toDataURL('image/webp', 0.85)` 兜底 jpeg;缩略图另画一份 ≤160px 的 `thumbUrl`;
   返回 `dataUrl`(上传用)与 `thumbUrl`(预览/气泡用,内存驻留)。文件类型校验(非 image/* 拒绝)也放这里。
2. `apps/web/src/composables/useAgent.ts`(小改):
   - `UiMessage` 增加可选字段 `images?: Array<{ path: string; thumb: string }>`(仅会话内展示,不持久化);
   - `pushUserMessage(text: string, images?: UiMessage['images'])` 增加第二参数;
   - `sendMessage(text: string, images?: UiMessage['images'])` 增加第二参数并透传给 `pushUserMessage`;
   - 新增 `uploadImage(dataUrl: string): Promise<string>`:POST `/api/agent/workspaces/${workspaceId}/uploads`,
     body `JSON.stringify({ data: dataUrl.split(',')[1] })`(纯 base64 payload),复用 `request<T>` helper,
     返回 `data.path`(相对路径);无工作区时 throw。
3. `apps/web/src/components/ChatPane.vue`(主要改动):
   - 新增状态:`pendingImages = ref<Array<{ thumb: string; dataUrl: string; path?: string; status: 'ready'|'uploading'|'error'; error?: string }>>([])`;
   - **textarea `@paste="onPaste"`**:`e.clipboardData.items` → `item.type.startsWith('image/')` 的 File →
     `compressImage` → push 进 pendingImages(>8 张拒绝并提示);`e.preventDefault()` 阻止默认粘贴图片进文本;
     `getAsFile()` 失败静默跳过(非图片粘贴走浏览器默认);只读工作区时提示「只读工作区不支持粘贴图片」并直接 return;
   - **缩略图预览条**(插入位 = 未配置 key 提示 `<p>` 与输入行 `<div class="flex items-center gap-2">` 之间,
     探索报告 §1.2 已确认的现成位置,恒在、位于输入框正上方):
     ```html
     <div v-if="pendingImages.length" class="mb-2.5 flex items-center gap-2 overflow-x-auto rounded-md border border-hairline bg-canvas-soft px-3 py-2">
       <div v-for="(img, i) in pendingImages" :key="i" class="relative shrink-0">
         <img :src="img.thumb" class="h-14 w-14 rounded-sm border border-hairline object-cover" />
         <button @click="removeImage(i)" aria-label="删除图片" class="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full border border-hairline bg-canvas text-mute hover:text-err">×</button>
       </div>
       <span class="ml-auto shrink-0 font-mono text-[10px] text-mute">{{ pendingImages.length }}/8 张,共 {{ totalSizeKB }} KB</span>
     </div>
     ```
     (样式全部 Tailwind,与 gateRequest 块 border-hairline/bg-canvas-soft 同一语言);
   - `handleSend()` 改造:发送条件从 `!text` 改为 `(!text && pendingImages.length === 0)`(纯图可发送);
     流程:置 `status='uploading'` → `Promise.all(pendingImages.map(img => agent.uploadImage(img.dataUrl)))`
     → 全部成功后拼接 `fullText = pendingImages.map(p => `[图片: ${p.path}]`).join(' ') + (text ? ' ' + text : '')`
     → `images = pendingImages.map((p, i) => ({ path: paths[i], thumb: p.thumb }))`
     → `await agent.sendMessage(fullText, images)` → 成功后清空 pendingImages;
     任一张失败 → `sendError = '图片上传失败:…'`,pendingImages 保留(状态标 error,用户可删除重试),不发送;
   - 删除:removeImage(i) 从数组移除;发送成功 / 切工作区(`watch` activeWorkspaceId)时清空;
   - 上传失败/错误态在缩略图角标显示(红色边框 + 悬停 title=错误信息)。
4. `apps/web/src/components/MessageBubble.vue`(小改):user 消息分支(`v-if="message.role === 'user'"`,
   正文 markdown div 之前)插入缩略图网格:
   ```html
   <div v-if="message.images?.length" class="mb-2 flex flex-wrap gap-1.5">
     <img v-for="img in message.images" :key="img.path" :src="img.thumb"
          class="h-16 w-16 rounded-sm border border-hairline object-cover" :title="img.path" />
   </div>
   ```
5. 测试:
   - `apps/web/src/components/ChatPane.test.ts`(扩展):
     a. paste 事件:mock `ClipboardEvent`(items 含 image File + 非图片项)→ 缩略图条出现、数量正确;
     b. 删除按钮 → 缩略图移除;>8 张拒绝;
     c. 纯图发送(空 draft + 1 张图):`sendMessage` 被调用且参数含 `[图片:` 前缀文本与 images 数组;
     d. 上传失败:mock `uploadImage` reject → sendError 显示、pendingImages 保留、sendMessage 未被调用;
     e. 只读工作区 paste → 无缩略图、sendError 提示;
     f. 发送成功清空 pendingImages。
   - `apps/web/src/composables/useAgent.test.ts`(扩展):
     a. `uploadImage` 请求体形状(POST 路径、body 无 data: 前缀)与返回 path;
     b. `sendMessage(text, images)` → pushUserMessage 产生的 UiMessage 含 images 字段;
     c. 上传 401/400 错误文案透出。
   - 注意:jsdom 无 canvas 实现 → `compressImage` 在测试中 vi.mock(返回固定 dataUrl/thumbUrl),paste 测试只验证接线。

**预期结果**:`pnpm --filter @workflows/web test` 全绿;`pnpm typecheck` 通过;浏览器冒烟见 Phase 4。

---

### Phase 4:验证——Commit 4

**改动文件**:
- `apps/api/scripts/mock-xiaomi-server.mjs`(微调):响应文案从固定「mock 识图成功(1 张图)」改为
  「mock 识图成功(N 张图)」(`N = images.length`);日志已打印 model/images/text,无需大改。
- `apps/api/scripts/verify-vision.mjs`(扩展):新增 `--images N` 参数(默认 1),构造 N 个 image_url 项 +
  text 项请求;断言 200 + content 非空 + mock 返回文案含 `(N 张图)`;离线/线上两模式行为不变。

**验证步骤**:
1. 全量:`pnpm test && pnpm typecheck && pnpm build`(api + web 全部通过);
2. 后端离线工具验证:
   ```bash
   node apps/api/scripts/mock-xiaomi-server.mjs &
   node apps/api/scripts/verify-vision.mjs --base-url http://127.0.0.1:3999/v1 --images 3
   ```
   预期输出 `images=3`、`mock 识图成功(3 张图)`;单图模式回归;
3. 浏览器冒烟清单(dev server + mock 或真实 key):
   - [ ] 任意截图 → Ctrl+V 粘贴 → 输入框上方出现缩略图 + 数量/体积提示;
   - [ ] 点 × 删除 → 缩略图消失;粘贴 9 张 → 拒绝并提示;
   - [ ] 空文本 + 1 张图 → 发送按钮可用 → 发送后用户气泡显示缩略图,文本含 `[图片: .wf-uploads/xxx.webp]`;
   - [ ] agent 回合内出现 `vision-understand` 工具调用(参数 `image_paths`),返回文字描述;
   - [ ] 2 张图一次发送 → mock 日志 `images=2`(一次调用两图);
   - [ ] 只读工作区粘贴 → 提示被拒;
   - [ ] 发送后 `.wf-uploads/` 下出现文件,消息历史(刷新页面/切换会话)中图片以文本路径呈现(缩略图不恢复,符合决策 6);
   - [ ] 图片 URL 输入验证(临时用工具调用或后续手动 curl 模拟 `image_urls` 参数)→ mock fetch 下载成功;
   - [ ] base64 输入验证(`image_data` 参数)→ 成功。
4. 真实环境(需用户配合):打开浏览器复制一张真实截图粘贴走完整链路;`XIAOMI_API_KEY` 直连小米验证多图真实识别。

---

## 4. 风险与回滚方案

| # | 风险 | 影响 | 缓解 / 回滚 |
| --- | --- | --- | --- |
| 1 | **schema 参数名变更**(image_path → image_paths)影响 agent 调用 | agent 若按旧 description 调用会失败 | 决策 5 保留 image_path 别名归一化;Commit 1 单独可回滚(git revert 即恢复 v1 行为,19 个旧测试兜底) |
| 2 | **deepseek 纯文本**(input:["text"])导致「传图给主模型」思路错误 | 功能不可用而非报错 | 已定案走工具;description 明确指引 agent 用 vision-understand;无 vision key 时工具不可用,前端粘贴仍可用但识别会失败(提示文案兜底) |
| 3 | **base64 大请求体**到达上传路由 | 内存峰值 | 粗判 `len*3/4 ≤ 10MB` 先于解码;单张/请求上限;Hono 无默认 body 上限属已知接受项 |
| 4 | **上传目录孤儿文件 / 敏感图片进 git** | 磁盘堆积、截图入库 | 决策 7 惰性清理(>30 天);`.wf-uploads` 不进 .gitignore(与 `.wf-runs` 同哲学,git 可见性由工作区自身 .gitignore 决定)——如需排除请用户在工作区 .gitignore 加 `.wf-uploads/`(计划默认不加) |
| 5 | **image_urls SSRF 残余窗口**(DNS rebinding / redirect 跟随) | 内网探测理论风险 | 解析后 IP 黑名单 + 仅 https + 10s 超时 + 流式限流 + mime 白名单;残余窗口代码注释明示(与 workspaceGuard 同哲学「护栏,非安全边界」);如用户不接受,回滚方案 = 从 schema 移除 image_urls 键(Commit 1 内单点删除,其余两路不受影响) |
| 6 | **前端 canvas 压缩在 jsdom 测试不可用** | 测试无法覆盖真实压缩 | 测试 vi.mock compressImage;真实压缩路径由浏览器冒烟(Phase 4)覆盖 |
| 7 | **纯图发送破坏现有「空文本不可发送」语义** | 误触发送 | 仅当 pendingImages 非空才放行;发送按钮 disabled 条件同步改为 `!draft.trim() && pendingImages.length === 0` |
| 8 | **切工作区残留 pendingImages** | 图发到错误工作区 | watch activeWorkspaceId 清空 pendingImages + 上传前二次校验 workspaceId |
| 9 | **多图请求超小米单请求承受量** | 400/超时 | 总量 ≤20MB 前置校验;超时错误文案提示重试(现有 mapHttpError 400 文案扩展为含「请检查图片数量/体积」) |

**Commit 划分与回滚**(每个 commit 独立可逆,顺序执行):
1. `feat(api): vision-understand 多图/URL/base64 三路输入 + SSRF 防护`(Phase 1)
2. `feat(api): 工作区图片上传路由 POST /uploads(.wf-uploads)`(Phase 2)
3. `feat(web): 输入框粘贴图片缩略图 + 上传随消息发送`(Phase 3)
4. `chore: 扩展 mock-xiaomi/verify-vision 多图验证`(Phase 4)

---

## 5. 验收标准(逐条可核对)

**后端(Phase 1 + 2)**
- [ ] `visionTools.ts` schema 含 `image_paths` / `image_data` / `image_urls` 三路可选数组 + `question`;`image_path` 兼容别名保留;
- [ ] 多图请求体 = N 个 `image_url` content 项(顺序 = path→data→url)+ 1 个 text 项;单图请求体与 v1 逐字节一致;
- [ ] 上限生效:>8 张拒绝、单张 >10MB 拒绝、总量 >20MB 拒绝,均在发起小米请求前;
- [ ] `image_paths` 越界仍被 `isAllowedTargetPath` 拦截(守卫回归);
- [ ] `image_urls`:非 https 拒绝、`isBlockedIp` 命中拒绝(含 dns.lookup 返回内网 IP 场景)、下载 >10MB abort、下载超时 10s、非白名单 mime/魔数拒绝;
- [ ] `image_data`:data URL 与裸 base64 均可;非法格式/非白名单 mime 明确报错且零请求;
- [ ] 错误纪律保持:key 不落文案、abort 唯一透传、错误返回文本不 throw;
- [ ] visionTools.test.ts 新增 ≥9 组用例全绿,原 19 用例无回归;
- [ ] `POST /api/agent/workspaces/:id/uploads`:成功返回 `{ path: '.wf-uploads/<uuid>.<ext>' }` 且文件落盘内容一致;400(空/超限/格式)/403(只读)/404(工作区不存在)分支正确、零写盘;文件名不信任(uuid 服务端生成);惰性清理 >30 天旧文件;
- [ ] uploadsRoutes.test.ts ≥8 组用例全绿。

**前端(Phase 3)**
- [ ] 粘贴图片(Ctrl+V)→ 输入框上方缩略图条出现,含缩略图、删除按钮、`n/8` 数量与总 KB 提示;样式与现有 UI 一致(Tailwind border-hairline/bg-canvas-soft);
- [ ] 删除按钮移除对应缩略图;>8 张拒绝;非图片粘贴不影响正常输入;IME 输入不受影响;
- [ ] 纯图可发送(空 draft + 图);发送前并行上传,成功后消息文本为 `[图片: <path>]…` 且用户气泡渲染缩略图;
- [ ] 上传失败:sendError 提示、缩略图保留可删除重试、不发送;
- [ ] 只读工作区粘贴被拒并提示;切工作区清空待发图片;
- [ ] `useAgent.uploadImage` 请求体为纯 base64 payload(无 `data:` 前缀),返回路径;`sendMessage(text, images)` 透传 images 到 UiMessage;
- [ ] ChatPane.test.ts / useAgent.test.ts 新增用例全绿,既有用例无回归。

**全局(Phase 4)**
- [ ] `pnpm test && pnpm typecheck && pnpm build` 全绿;
- [ ] mock-xiaomi-server 输出 `images=N` 动态文案;verify-vision `--images 3` 离线验证通过,单图回归通过;
- [ ] 浏览器冒烟清单(§3 Phase 4 第 3 条)9 项全部手动勾选通过;
- [ ] 真实环境(用户配合)粘贴截图完整链路成功:粘贴 → 缩略图 → 发送 → vision-understand 识图 → 文字回传。

---

## 6. 待用户确认的决策项(§2 表格 10 项,默认值已写入计划)

1. 上传目录 `.wf-uploads/`(决策 1);
2. 只读工作区禁用上传(决策 2);
3. `image_urls` 进本次(决策 3);
4. 多图上限 8 张 / 单张 10MB / 总量 20MB(决策 4);
5. v1 `image_path` 保留兼容别名(决策 5);
6. 历史缩略图 v1 不持久化、气泡用内存 data URL(决策 6);
7. 惰性清理 >30 天(决策 7);
8. 上传为 JSON base64 单张/请求(决策 8);
9. 压缩输出 WebP(决策 9);
10. 消息标记文本 `[图片: <path>]`(决策 10)。
