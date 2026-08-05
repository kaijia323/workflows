# 02 实施计划(v2):vision-understand 工具增强 + 前端粘贴图片缩略图(压缩改用 compressorjs)

> 基于 `.wf-runs/72dc5d3b/01-exploration-1.md`(探索报告,已核实)与 `.wf-runs/72dc5d3b/02-plan-1.md`(v1 计划)。
> **v2 变更原因**:用户驳回 v1 计划 Phase 3 中「自己实现 canvas 压缩」,要求**使用三方库压缩**。
> v2 仅重写 Phase 3 的压缩实现方式与依赖/测试策略;Phase 1/2/4 内容与其余决策点保持不变,
> 同步更新受影响的决策 6、决策 9,新增决策 11(压缩库选型)。
> 02-plan-1.md 保留为历史版本。

---

## 0. 变更摘要(v1 → v2)

| # | 改动点 | v1(被驳回) | v2(本版) |
| --- | --- | --- | --- |
| 1 | 压缩实现 | ChatPane/utils 内自实现 `canvas.drawImage → toBlob` | **compressorjs 三方库**(Promise 包装在 `utils/image.ts`) |
| 2 | 缩略图生成 | 自实现 canvas 另画一份 ≤160px | **同一库第二次调用**(maxWidth/Height 160) |
| 3 | 依赖 | 无 | `apps/web/package.json` dependencies 新增 `compressorjs@^1.3.0`(自带 TS 类型,无需 @types) |
| 4 | 测试策略 | vi.mock 自实现 compressImage | **vi.mock('compressorjs')**(utils 单测)+ **vi.mock utils 模块**(ChatPane 接线测试);stub `URL.createObjectURL`(jsdom 未实现) |
| 5 | 决策 6(缩略图内存形态) | 内存 data URL | 内存 objectURL(`URL.createObjectURL`),删除/发送成功/切工作区时 revoke |
| 6 | 决策 9(输出格式) | WebP(不支持降级 JPEG) | 输出格式跟随原图 mime;**PNG > 1MB 经 convertSize 自动转 JPEG**;不强制 WebP |
| 7 | 决策 11(新增) | — | 压缩库选型 = **compressorjs**,备选 browser-image-compression(切换只动 utils/image.ts 单文件) |
| 8 | 其余 | Phase 1/2/4、决策 1-5/7/8/10、风险与验收(除压缩相关条目) | **保持不变** |

---

## 1. 目标与范围

### 做什么

1. **vision-understand 工具增强(v1.1)**:`image_paths[]`(工作区路径,沿用守卫)+ `image_data[]`
   (base64/data URL)+ `image_urls[]`(HTTPS URL,SSRF 防护)三路输入,多图一次调用小米 API。
2. **新增上传路由**:`POST /api/agent/workspaces/:id/uploads`,前端压缩后的图片写入
   `<workspace>/.wf-uploads/`,返回相对路径。
3. **前端粘贴图片**:ChatPane textarea 支持 Ctrl+V 粘贴剪贴板图片 → **compressorjs 压缩** → 输入框上方
   缩略图条(可删除、数量/体积提示)→ 发送时先上传、图片路径随消息文本走(方案 A)→ 用户消息气泡内展示缩略图。
4. **测试与验证**:后端 9 组新增单测 + 前端单测(压缩库 mock 策略)+ mock 服务器扩展 + 浏览器冒烟清单。

### 不做什么(明确排除,与 v1 相同)

- **不改 shared 类型 / SSE 事件 / HistoryBlock / JSONL 持久化**(方案 A 核心优势,路径在文本里天然持久化)。
- **不做** `sendMessage({ text, images })` 消息体扩展(方案 B 否决)。
- **不做** 历史回放时的缩略图恢复(v1 仅会话内展示;历史中图片以文本路径 `[图片: .wf-uploads/x.jpeg]` 呈现)。
- **不做** 拖拽(drop)上传(v1 仅 paste;`@drop` 标记为 follow-up)。
- **不做** 上传目录的定时清理任务(仅做上传时惰性清理,见 §2 决策 7)。
- **不做** 自实现任何 canvas 绘制/缩放逻辑(压缩与缩略图缩放全部走 compressorjs)。

### 传递路径(方案 A,已定案;压缩环节为 v2 变更点)

```
粘贴 → compressorjs 压缩(≤2048px / quality 0.85 / PNG>1MB 转 JPEG)→ Blob
→ FileReader 序列化 data URL(纯字节序列化,非压缩)
→ POST /uploads(后端嗅探 mime → 写 .wf-uploads/<uuid>.<ext>)
→ 返回相对路径 → 文本拼接 [图片: <path>] 原文本
→ sendMessage(文本)→ deepseek 看到路径 → 调 vision-understand(image_paths)
→ 工具读文件 → 小米 mimo-v2.5 识图 → 文字回传
```

---

## 2. 关键决策(决策 1-5/7/8/10 与 v1 相同;6/9 已更新;11 为新增)

| # | 决策项 | 拍板值 | 理由 |
| --- | --- | --- | --- |
| 1 | 上传目录名/位置 | `<workspace>/.wf-uploads/`(点前缀隐藏,与 `.wf-runs` 同语义) | 工作区内天然满足 `isAllowedTargetPath`;不挂 runId 下(发送消息时 run 可能不存在) |
| 2 | 只读工作区行为 | **禁用上传**:后端 403 + 前端粘贴时提示并拒绝 | 上传=写盘,违反只读语义;双保险 |
| 3 | `image_urls` 是否进本次 | **进**(完整实现 SSRF 防护,单列测试组) | 方案已完备;若压缩范围可退化为仅 `image_paths`+`image_data`(§5 风险 5 有回滚说明) |
| 4 | 多图上限 | **8 张 / 单张 ≤10MB / 总量 ≤20MB** | 与探索报告建议一致;总量按字节在请求前累加校验 |
| 5 | v1 `image_path` 单数键去留 | **保留为兼容别名**(内部归一化进 `image_paths`;description 标注 deprecated) | 成本 3 行;避免破坏已落盘 JSONL 中 toolCall 参数回看语义与任何潜在外部调用 |
| 6 | 历史缩略图持久化 | v1 不做;用户消息气泡内缩略图用**前端内存 objectURL**(`URL.createObjectURL(thumbBlob)`,切会话/刷新即释放,不落盘;删除/发送成功/切工作区时 `revokeObjectURL`) | **v2 更新**:压缩产物为 Blob,objectURL 免去二次 base64 序列化且内存更省;零持久化改动;坏图失效态规避 |
| 7 | 上传目录清理 | 上传时惰性清理:同目录 mtime > 30 天的文件删除(每次上传触发,~10 行) | 防孤儿堆积;不做独立定时任务 |
| 8 | 上传请求形态 | JSON body `{ data: string, mimeType?: string }`,**单张/请求**,前端 `Promise.all` 并行 | 不引入 multipart 依赖;单张请求失败语义清晰;Hono 无默认 body 上限,应用层校验 |
| 9 | 图片格式 | **输出格式跟随原图 mime;PNG > 1MB 自动转 JPEG(compressorjs `convertSize: 1MB`,convertTypes 默认 `['image/png']`);不强制 WebP** | **v2 更新**(compressorjs 行为):小 PNG 截图(≤1MB)保持 PNG 无损清晰(文本截图可读性最好);大 PNG 超阈值自动转 JPEG 控体积;JPEG/WebP 输入按原格式重压(quality 0.85)。输出 mime 均在工具/上传路由白名单(JPEG/PNG/GIF/WebP)内 |
| 10 | 消息中图片标记文本 | `[图片: .wf-uploads/<uuid>.<ext>]`(多图重复前缀)+ 原文本 | 与工具 description 呼应,agent 可见路径即可调工具 |
| 11 | **压缩库选型(新增)** | **compressorjs@^1.3.0**;备选 browser-image-compression | 见 §3.1 选型论证 |

---

## 3. 实施步骤(4 个 Phase,4 个可独立回滚 commit)

### Phase 1:后端工具增强(visionTools.ts)——Commit 1(与 v1 相同,不变)

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

### Phase 2:后端上传路由(新)——Commit 2(与 v1 相同,不变)

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

### Phase 3:前端粘贴缩略图(compressorjs 压缩)——Commit 3(**v2 重写,压缩实现全部走三方库**)

#### 3.1 选型论证:compressorjs(已核实)

| 维度 | compressorjs(选定) | browser-image-compression(备选) | image-conversion(否决) |
| --- | --- | --- | --- |
| 体积 | gzip ~12KB(2 依赖:blueimp-canvas-to-blob / is-blob) | ~19KB+(依赖 uzip) | — |
| 维护状态 | **活跃**:v1.3.0 发布于 2026-04(近 3 个月有更新);5.7k stars | **3 年未更新**(v2.0.2 停在 2023-03-06,已核实);3.2k stars | 冷门 |
| API | 回调式(`new Compressor(file, options)` success/error),**需 Promise 包装** | Promise API,开箱即用 | — |
| Web Worker | 不支持(基于 `HTMLCanvasElement.toBlob()`) | 支持(`useWebWorker` 默认 true) | — |
| 压缩速度 | **快**:8MB 手机照片约 **0.4s**(已核实) | **慢约 5 倍**:约 **2.2s**(已核实) | — |
| 关键能力 | maxWidth/maxHeight/quality/**convertSize(PNG 超阈值自动转 JPEG,convertTypes 默认 ['image/png'])**/checkOrientation(EXIF 方向自动修正)/strict | maxSizeMB 自动迭代压缩、alwaysKeepResolution | — |
| TypeScript | **自带类型**(types/index.d.ts,default export class + `Compressor.Options`),无需 @types | 自带类型 | — |

**选定理由(compressorjs)**:
1. **粘贴场景追求快速响应**:一次最多 8 张,0.4s/张的即时压缩体验远好于 2.2s/张;视觉识别对画质非极致要求,响应优先;
2. **体积小、维护活跃**:12KB gzip 对 web bundle 影响可忽略;1.3.0 刚发布,风险低;
3. **参数完全覆盖需求**:maxWidth 2048 / quality 0.85 / convertSize 1MB(PNG→JPEG)三参数即可实现目标压缩策略;
4. **EXIF 方向自动修正**(checkOrientation 默认 true):手机截图/照片粘贴后方向正确,免去自实现;
5. **自带 TS 类型**:零 @types 依赖,`import Compressor from 'compressorjs'` 直接可用(tsconfig `moduleResolution: bundler` 兼容)。
6. 缺点(Web Worker 缺失)的影响评估:压缩在主线程,但每张 <0.5s 且逐张异步回调,缩略图逐个浮现,8 张总时长可接受;若后续批量需求变硬,可切换备选(§3.1 备选)。

**备选(不选的理由)**:browser-image-compression 的 Promise API 与 Web Worker 不阻塞 UI 是真实优势,但
3 年未维护(依赖生态停更风险)+ 压缩慢 5 倍 + 包更大,与「粘贴快速响应」需求冲突;image-conversion 冷门不推荐。
**切换成本控制**:库被封装在 `apps/web/src/utils/image.ts` 单文件内,ChatPane/useAgent 只依赖
`compressImage(file, options): Promise<Blob>` 等自有签名,未来切换备选库仅需重写该文件,接口不变。

#### 3.2 依赖安装

```bash
pnpm --filter @workflows/web add compressorjs
```

- **变更文件**:`apps/web/package.json`(dependencies 增加 `"compressorjs": "^1.3.0"`)、`pnpm-lock.yaml`(自动更新);
- **类型声明**:compressorjs **自带 TypeScript 类型**(`types/index.d.ts`),**无需安装 @types/compressorjs**;
  默认导出 `class Compressor` + `Compressor.Options` 接口,与 `verbatimModuleSyntax`/`moduleResolution: bundler` 兼容;
- **打包影响**:ESM 构建,minzip ~12KB,Vite 直接消费,对 web bundle 影响可忽略;
- 安装后验证:`pnpm typecheck` 通过(类型解析正常)。

#### 3.3 `apps/web/src/utils/image.ts`(**新建,重写 v1 版:三方库封装 + Promise 包装**)

```ts
import Compressor from 'compressorjs'

export interface CompressOptions {
  maxWidth?: number
  maxHeight?: number
  quality?: number
  mimeType?: string
  convertSize?: number        // 源图超过该字节数时按 convertTypes 转换格式(PNG→JPEG)
}

/** compressorjs 回调式 API → Promise 封装(压缩库唯一入口,未来换库只改本文件) */
export function compressImage(file: File | Blob, options: CompressOptions = {}): Promise<Blob> {
  return new Promise((resolve, reject) => {
    new Compressor(file, { ...options, success: resolve, error: reject })
  })
}

/** 粘贴图压缩参数:最长边 ≤2048px / quality 0.85 / PNG >1MB 自动转 JPEG */
export const PASTE_COMPRESS_OPTS: CompressOptions = {
  maxWidth: 2048,
  quality: 0.85,
  convertSize: 1 * 1024 * 1024,
}

/** 缩略图参数:同一库第二次调用,最长边 ≤160px(预览条 56px / 气泡 64px 显示,2x 清晰度) */
export const THUMB_COMPRESS_OPTS: CompressOptions = {
  maxWidth: 160,
  maxHeight: 160,
  quality: 0.75,
}

/** 压缩 → 双趟产物:上传用 base64(data URL)与预览用 objectURL(内存驻留,调用方负责 revoke) */
export async function preparePastedImage(file: File): Promise<{ uploadBlob: Blob; uploadDataUrl: string; thumbUrl: string }> {
  const uploadBlob = await compressImage(file, PASTE_COMPRESS_OPTS)   // 第一趟:上传图(≤2048px)
  const thumbBlob = await compressImage(uploadBlob, THUMB_COMPRESS_OPTS) // 第二趟:缩略图(≤160px,走同一库,不自实现 canvas)
  return {
    uploadBlob,
    uploadDataUrl: await blobToDataUrl(uploadBlob),
    thumbUrl: URL.createObjectURL(thumbBlob),
  }
}

/** Blob → data URL(FileReader 纯字节序列化,非压缩逻辑,jsdom 可用) */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('读取图片数据失败'))
    reader.readAsDataURL(blob)
  })
}
```

**实现要点**:
- `compressImage` 是库的唯一入口:**success → resolve(Blob)、error → reject(Error)**,回调错误不丢失;
- compressorjs `strict: true` 为默认:压缩后比原图大时返回原图(小图不折腾);`checkOrientation` 默认 true 自动修 EXIF 方向;
- 输出格式跟随原图 mime(不强制 WebP):≤1MB PNG 截图保持 PNG 无损清晰;>1MB PNG 经 `convertSize` 自动转 JPEG;JPEG/WebP 原格式重压(quality 0.85);
- 缩略图第二趟输入是已压缩的 uploadBlob(≤2048px),160px 目标下必定缩小,耗时极小;
- `blobToDataUrl` 仅做字节序列化(上传接口需要 base64),**不属于压缩实现**,故不违反「压缩用三方库」约束;
- 非图片文件校验(`!file.type.startsWith('image/')` 拒绝)仍放本文件(与 v1 相同)。

#### 3.4 `apps/web/src/composables/useAgent.ts`(小改,与 v1 相同)

- `UiMessage` 增加可选字段 `images?: Array<{ path: string; thumb: string }>`(仅会话内展示,不持久化);
- `pushUserMessage(text: string, images?: UiMessage['images'])` 增加第二参数;
- `sendMessage(text: string, images?: UiMessage['images'])` 增加第二参数并透传给 `pushUserMessage`;
- 新增 `uploadImage(dataUrl: string): Promise<string>`:POST `/api/agent/workspaces/${workspaceId}/uploads`,
  body `JSON.stringify({ data: dataUrl.split(',')[1] })`(纯 base64 payload,无 `data:` 前缀),复用 `request<T>` helper,
  返回 `data.path`(相对路径);无工作区时 throw。

#### 3.5 `apps/web/src/components/ChatPane.vue`(主要改动,与 v1 布局相同,压缩调用改为 preparePastedImage)

- 新增状态:`pendingImages = ref<Array<{ thumb: string /* objectURL */; uploadDataUrl: string; path?: string; status: 'ready'|'uploading'|'error'; error?: string }>>([])`;
- **textarea `@paste="onPaste"`**:`e.clipboardData.items` → `item.type.startsWith('image/')` 的 File →
  `preparePastedImage(file)` → push 进 pendingImages(>8 张拒绝并提示);`e.preventDefault()` 阻止默认粘贴图片进文本;
  `getAsFile()` 失败静默跳过(非图片粘贴走浏览器默认);只读工作区时提示「只读工作区不支持粘贴图片」并直接 return;
  压缩失败(库 error 回调)→ 该项以 error 态入列并显示「图片压缩失败」;
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
  (样式全部 Tailwind,与 gateRequest 块 border-hairline/bg-canvas-soft 同一语言;`img.thumb` 为 objectURL);
- `handleSend()` 改造:发送条件从 `!text` 改为 `(!text && pendingImages.length === 0)`(纯图可发送);
  流程:置 `status='uploading'` → `Promise.all(pendingImages.map(img => agent.uploadImage(img.uploadDataUrl)))`
  → 全部成功后拼接 `fullText = pendingImages.map(p => `[图片: ${p.path}]`).join(' ') + (text ? ' ' + text : '')`
  → `images = pendingImages.map((p, i) => ({ path: paths[i], thumb: p.thumb }))`
  → `await agent.sendMessage(fullText, images)` → 成功后清空 pendingImages(清空时逐张 `revokeObjectURL(img.thumb)`);
  任一张失败 → `sendError = '图片上传失败:…'`,pendingImages 保留(状态标 error,用户可删除重试),不发送;
- 删除:removeImage(i) 从数组移除并 `revokeObjectURL` 该 thumb;发送成功 / 切工作区(`watch` activeWorkspaceId)时清空并全部 revoke;
- 上传失败/错误态在缩略图角标显示(红色边框 + 悬停 title=错误信息)。

#### 3.6 `apps/web/src/components/MessageBubble.vue`(小改,与 v1 相同)

user 消息分支(`v-if="message.role === 'user'"`,正文 markdown div 之前)插入缩略图网格:
```html
<div v-if="message.images?.length" class="mb-2 flex flex-wrap gap-1.5">
  <img v-for="img in message.images" :key="img.path" :src="img.thumb"
       class="h-16 w-16 rounded-sm border border-hairline object-cover" :title="img.path" />
</div>
```

#### 3.7 测试策略(压缩库 mock,规避 jsdom 无 canvas)

**核心问题**:jsdom 不实现 canvas/`HTMLCanvasElement.toBlob()`,compressorjs 在单测环境不可用;
且 jsdom 的 `URL.createObjectURL` 未实现。策略 = **在库边界与工具边界双层 mock**:

1. **`apps/web/src/utils/image.test.ts`(新建)——mock compressorjs 本体,测封装逻辑**:
   ```ts
   vi.mock('compressorjs', () => {
     class FakeCompressor {
       constructor(file: Blob, options: Compressor.Options) {
         queueMicrotask(() => options.success?.(file)) // 模拟成功:原样返回
       }
     }
     return { default: FakeCompressor }
   })
   // 测试文件顶部 stub jsdom 缺失 API:
   // URL.createObjectURL = vi.fn(() => 'blob:mock-thumb')
   // URL.revokeObjectURL = vi.fn()
   ```
   用例:
   a. `compressImage(file, opts)` resolve 为 Blob;options 原样透传给 Compressor(maxWidth/quality/convertSize 断言);
   b. 错误路径:mock 的 error 回调被调用 → reject 且错误信息透出;
   c. `blobToDataUrl`:jsdom 的 FileReader 真实可用(支持 readAsDataURL)→ 断言 `data:image/png;base64,` 前缀与内容一致(不 mock FileReader);
   d. `preparePastedImage`:断言两次 Compressor 调用参数分别为 `PASTE_COMPRESS_OPTS`(2048/0.85/1MB)与 `THUMB_COMPRESS_OPTS`(160/0.75)、返回 uploadDataUrl/thumbUrl(`blob:mock-thumb`)形状正确;
   e. 非图片 File 拒绝(类型校验)。
   (真实压缩行为/画质/速度由 Phase 4 浏览器冒烟覆盖——与 v1 同哲学。)
2. **`apps/web/src/components/ChatPane.test.ts`(扩展)——mock utils 模块,测组件接线**:
   ```ts
   vi.mock('@/utils/image', () => ({
     preparePastedImage: vi.fn(async () => ({
       uploadBlob: new Blob(), uploadDataUrl: 'data:image/jpeg;base64,AAAA', thumbUrl: 'blob:mock-thumb',
     })),
   }))
   ```
   用例(与 v1 相同 a-f,压缩调用替换为 mock):
   a. paste 事件:mock `ClipboardEvent`(items 含 image File + 非图片项)→ `preparePastedImage` 被调用、缩略图条出现、数量正确;
   b. 删除按钮 → 缩略图移除(并断言 `revokeObjectURL` 被调);>8 张拒绝;
   c. 纯图发送(空 draft + 1 张图):`sendMessage` 被调用且参数含 `[图片:` 前缀文本与 images 数组;
   d. 上传失败:mock `uploadImage` reject → sendError 显示、pendingImages 保留、sendMessage 未被调用;
   e. 只读工作区 paste → 无缩略图、sendError 提示;
   f. 发送成功清空 pendingImages(并 revoke)。
3. **`apps/web/src/composables/useAgent.test.ts`(扩展,与 v1 相同,不涉及压缩)**:
   a. `uploadImage` 请求体形状(POST 路径、body 无 `data:` 前缀)与返回 path;
   b. `sendMessage(text, images)` → pushUserMessage 产生的 UiMessage 含 images 字段;
   c. 上传 401/400 错误文案透出。

**预期结果**:`pnpm --filter @workflows/web test` 全绿(含既有用例无回归);`pnpm typecheck` 通过;浏览器冒烟见 Phase 4。

---

### Phase 4:验证——Commit 4(与 v1 相同,冒烟清单同步压缩行为)

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
   - [ ] 任意截图 → Ctrl+V 粘贴 → 输入框上方出现缩略图 + 数量/体积提示(缩略图 src 为 `blob:` objectURL);
   - [ ] 点 × 删除 → 缩略图消失;粘贴 9 张 → 拒绝并提示;
   - [ ] 空文本 + 1 张图 → 发送按钮可用 → 发送后用户气泡显示缩略图,文本含 `[图片: .wf-uploads/xxx.ext]`;
   - [ ] agent 回合内出现 `vision-understand` 工具调用(参数 `image_paths`),返回文字描述;
   - [ ] 2 张图一次发送 → mock 日志 `images=2`(一次调用两图);
   - [ ] 只读工作区粘贴 → 提示被拒;
   - [ ] **压缩行为验证(compressorjs)**:粘贴 >1MB 的 PNG 截图 → 上传后 `.wf-uploads/` 下文件为 `.jpeg`(convertSize 生效)且体积明显小于原图;粘贴 ≤1MB 小 PNG → 保持 `.png`;粘贴 JPEG 照片 → `.jpeg`;方向正确的手机照片(EXIF)→ 缩略图与上传图方向正常(checkOrientation 生效);
   - [ ] 发送后消息历史(刷新页面/切换会话)中图片以文本路径呈现(缩略图不恢复,符合决策 6);
   - [ ] 图片 URL 输入验证(临时用工具调用或后续手动 curl 模拟 `image_urls` 参数)→ mock fetch 下载成功;
   - [ ] base64 输入验证(`image_data` 参数)→ 成功。
4. 真实环境(需用户配合):打开浏览器复制一张真实截图粘贴走完整链路;`XIAOMI_API_KEY` 直连小米验证多图真实识别。

---

## 4. 风险与回滚方案(风险 1-5/7-9 与 v1 相同;风险 6 已更新;风险 10 为新增)

| # | 风险 | 影响 | 缓解 / 回滚 |
| --- | --- | --- | --- |
| 1 | **schema 参数名变更**(image_path → image_paths)影响 agent 调用 | agent 若按旧 description 调用会失败 | 决策 5 保留 image_path 别名归一化;Commit 1 单独可回滚(git revert 即恢复 v1 行为,19 个旧测试兜底) |
| 2 | **deepseek 纯文本**(input:["text"])导致「传图给主模型」思路错误 | 功能不可用而非报错 | 已定案走工具;description 明确指引 agent 用 vision-understand;无 vision key 时工具不可用,前端粘贴仍可用但识别会失败(提示文案兜底) |
| 3 | **base64 大请求体**到达上传路由 | 内存峰值 | 粗判 `len*3/4 ≤ 10MB` 先于解码;单张/请求上限;Hono 无默认 body 上限属已知接受项 |
| 4 | **上传目录孤儿文件 / 敏感图片进 git** | 磁盘堆积、截图入库 | 决策 7 惰性清理(>30 天);`.wf-uploads` 不进 .gitignore(与 `.wf-runs` 同哲学,git 可见性由工作区自身 .gitignore 决定)——如需排除请用户在工作区 .gitignore 加 `.wf-uploads/`(计划默认不加) |
| 5 | **image_urls SSRF 残余窗口**(DNS rebinding / redirect 跟随) | 内网探测理论风险 | 解析后 IP 黑名单 + 仅 https + 10s 超时 + 流式限流 + mime 白名单;残余窗口代码注释明示(与 workspaceGuard 同哲学「护栏,非安全边界」);如用户不接受,回滚方案 = 从 schema 移除 image_urls 键(Commit 1 内单点删除,其余两路不受影响) |
| 6 | **压缩库在 jsdom 无 canvas 环境不可用**(compressorjs 依赖 `HTMLCanvasElement.toBlob()`) | 前端单测无法真实压缩 | **v2 更新**:双层 mock(utils 单测 mock 'compressorjs'、ChatPane 测试 mock utils 模块);jsdom 缺失的 `URL.createObjectURL` 在测试顶部 stub;真实压缩路径由 Phase 4 浏览器冒烟覆盖 |
| 7 | **纯图发送破坏现有「空文本不可发送」语义** | 误触发送 | 仅当 pendingImages 非空才放行;发送按钮 disabled 条件同步改为 `!draft.trim() && pendingImages.length === 0` |
| 8 | **切工作区残留 pendingImages** | 图发到错误工作区 | watch activeWorkspaceId 清空 pendingImages(含 revokeObjectURL)+ 上传前二次校验 workspaceId |
| 9 | **多图请求超小米单请求承受量** | 400/超时 | 总量 ≤20MB 前置校验;超时错误文案提示重试(现有 mapHttpError 400 文案扩展为含「请检查图片数量/体积」) |
| 10 | **三方库行为差异/升级风险(新增)** | 压缩结果与预期不符或库 API 变更 | 库封装在 `utils/image.ts` 单文件,自有签名 `compressImage(file, opts): Promise<Blob>` 不变;若 compressorjs 冒烟表现不达标(如大图内存、格式转换质量问题)→ 回滚/切换 = 仅重写该文件为 browser-image-compression(接口不变,ChatPane/useAgent 零改动);compressorjs 版本锁 `^1.3.0`,升级需过冒烟 |

**Commit 划分与回滚**(每个 commit 独立可逆,顺序执行):
1. `feat(api): vision-understand 多图/URL/base64 三路输入 + SSRF 防护`(Phase 1)
2. `feat(api): 工作区图片上传路由 POST /uploads(.wf-uploads)`(Phase 2)
3. `feat(web): 输入框粘贴图片缩略图(compressorjs 压缩)+ 上传随消息发送`(Phase 3)
4. `chore: 扩展 mock-xiaomi/verify-vision 多图验证`(Phase 4)

---

## 5. 验收标准(逐条可核对;Phase 3 为 v2 更新版)

**后端(Phase 1 + 2,与 v1 相同)**
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

**前端(Phase 3,v2 更新版)**
- [ ] `apps/web/package.json` dependencies 含 `"compressorjs": "^1.3.0"`,`pnpm-lock.yaml` 同步更新;`pnpm typecheck` 通过(自带 TS 类型,无 @types 依赖);
- [ ] `apps/web/src/utils/image.ts`:`compressImage(file, options): Promise<Blob>` 为 compressorjs 的 Promise 包装(success→resolve / error→reject);`preparePastedImage` 双趟压缩均走 compressorjs——上传图 `PASTE_COMPRESS_OPTS`(maxWidth 2048 / quality 0.85 / convertSize 1MB)+ 缩略图 `THUMB_COMPRESS_OPTS`(maxWidth/maxHeight 160 / quality 0.75),**仓库内无自实现 canvas 绘制/缩放代码**(可 grep 验证:utils 与 ChatPane 无 `drawImage`/`toBlob`/`createImageBitmap` 调用,唯一 canvas 消费方为 compressorjs 内部);
- [ ] 粘贴图片(Ctrl+V)→ 输入框上方缩略图条出现,含缩略图(objectURL)、删除按钮、`n/8` 数量与总 KB 提示;样式与现有 UI 一致(Tailwind border-hairline/bg-canvas-soft);
- [ ] 删除按钮移除对应缩略图并 revoke;>8 张拒绝;非图片粘贴不影响正常输入;IME 输入不受影响;
- [ ] 纯图可发送(空 draft + 图);发送前并行上传,成功后消息文本为 `[图片: <path>]…` 且用户气泡渲染缩略图;
- [ ] 上传失败:sendError 提示、缩略图保留可删除重试、不发送;压缩失败(error 回调)→ error 态提示,不中断其他图片;
- [ ] 只读工作区粘贴被拒并提示;切工作区清空待发图片并 revoke;
- [ ] `useAgent.uploadImage` 请求体为纯 base64 payload(无 `data:` 前缀),返回路径;`sendMessage(text, images)` 透传 images 到 UiMessage;
- [ ] 测试全绿:utils/image.test.ts(mock compressorjs,含 wrapper resolve/reject、参数透传、blobToDataUrl、preparePastedImage 双趟参数、非图片拒绝)+ ChatPane.test.ts(mock utils,接线用例 a-f)+ useAgent.test.ts 扩展;既有用例无回归。

**全局(Phase 4,与 v1 相同 + 压缩行为一条)**
- [ ] `pnpm test && pnpm typecheck && pnpm build` 全绿;
- [ ] mock-xiaomi-server 输出 `images=N` 动态文案;verify-vision `--images 3` 离线验证通过,单图回归通过;
- [ ] 浏览器冒烟清单(§3 Phase 4 第 3 条)10 项全部手动勾选通过,含 **compressorjs 压缩行为**:>1MB PNG → `.jpeg` 落盘且体积显著下降、≤1MB PNG 保持 `.png`、手机照片 EXIF 方向正确;
- [ ] 真实环境(用户配合)粘贴截图完整链路成功:粘贴 → 缩略图 → 发送 → vision-understand 识图 → 文字回传。

---

## 6. 待用户确认的决策项(§2 表格 11 项,默认值已写入计划;第 11 项为 v2 新增)

1. 上传目录 `.wf-uploads/`(决策 1);
2. 只读工作区禁用上传(决策 2);
3. `image_urls` 进本次(决策 3);
4. 多图上限 8 张 / 单张 10MB / 总量 20MB(决策 4);
5. v1 `image_path` 保留兼容别名(决策 5);
6. 历史缩略图 v1 不持久化、气泡用内存 objectURL(**v2 更新**,决策 6);
7. 惰性清理 >30 天(决策 7);
8. 上传为 JSON base64 单张/请求(决策 8);
9. 压缩输出格式跟随原图 mime,PNG >1MB 自动转 JPEG(**v2 更新**,决策 9);
10. 消息标记文本 `[图片: <path>]`(决策 10);
11. **压缩库选型 compressorjs@^1.3.0,备选 browser-image-compression(切换仅重写 utils/image.ts)(v2 新增,决策 11)**。
