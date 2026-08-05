# 03 执行报告(v2):vision-understand 工具增强 + 前端粘贴图片缩略图(compressorjs)

> 依据 `.wf-runs/72dc5d3b/02-plan-2.md` 分 4 个 Phase 完整实施;所有决策点按计划默认值执行
> (compressorjs 压缩、.wf-uploads 目录、只读 403、image_urls 进本次、8 张/10MB/20MB 上限、
> 保留 image_path 兼容、缩略图不落历史、JSON base64 上传、[图片: 路径] 标记、30 天惰性清理)。

---

## 1. Commit 列表(每个 Phase 一个,独立可回滚)

| # | Commit | 说明 |
| --- | --- | --- |
| 1 | `d80177b` `feat(api): vision-understand 多图/URL/base64 三路输入 + SSRF 防护` | Phase 1:imageMime.ts 新建 + visionTools.ts 三路增强 + 测试 9 组 |
| 2 | `4f1d6a2` `feat(api): 工作区图片上传路由 POST /uploads(.wf-uploads)` | Phase 2:routes.ts 上传路由 + uploadsRoutes.test.ts 10 用例 |
| 3 | `026c259` `feat(web): 输入框粘贴图片缩略图(compressorjs 压缩)+ 上传随消息发送` | Phase 3:compressorjs 依赖 + utils/image.ts + ChatPane/useAgent/MessageBubble + 测试 |
| 4 | `42e095f` `chore: 扩展 mock-xiaomi/verify-vision 多图验证` | Phase 4:mock 响应 N 张图文案 + verify-vision --images N + 离线验证通过 |

注:`.wf-runs/72dc5d3b/`(本 run 记录)未提交,等待编排层按仓库既有模式
(`chore: 提交工作流运行记录 .wf-runs`)统一提交;`.wf-runs/4f531a21/run.json` 的改动为上游遗留。

---

## 2. 改动文件清单

### Phase 1(Commit d80177b)

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/imageMime.ts`(**新建**) | `SUPPORTED_MIME`(值域不变)/ `MAX_IMAGE_BYTES=10MB` 从 visionTools 抽出;新增 `sniffMime`(PNG/JPEG/GIF/WebP 魔数)与 `extForMime` | 上传路由与工具共用 mime/嗅探,避免重复 |
| `apps/api/src/pi/visionTools.ts` | schema 三路可选数组(`image_paths`/`image_data`/`image_urls`)+ `image_path` 保留为 deprecated 别名;callVision 重构为归并循环(顺序 path→data→url,≤8 张,总量 ≤20MB 注入 option);`image_data` data URL/裸 base64(白名单 mime + 魔数嗅探 + 长度粗判/解码复检);`image_urls` 走新 helper `downloadImageUrl`(仅 https、`dns.lookup` 后 `isBlockedIp` 黑名单、10s 下载超时、流式限流 abort、Content-Type + 魔数双校验,下载转 data URL);导出纯函数 `isBlockedIp`(IPv4 6 段 + ::1/fc00::/7/fe80::/10 + IPv4-mapped IPv6 防绕过);description 更新(三路语义/上限/白名单/[图片: 路径] 提示);mapHttpError 400 文案扩为含「数量/体积」提示 | 多图一次调用小米 API;SSRF 护栏(与 workspaceGuard 同哲学「护栏,非安全边界」);单图请求体与 v1 逐字节一致 |
| `apps/api/src/pi/visionTools.test.ts` | 新增 9 组 30 用例(多图构造/别名一致性/空输入/守卫回归/9 张拒绝/总量超限/data URL 三态/裸 base64 嗅探 png-jpeg-webp 与失败/URL 全场景含 isBlockedIp 直测/混合三路顺序);修复两处实现问题:JS 位运算 int32 有符号比较 bug(掩码后 `>>>0`)、IPv4-mapped IPv6 绕过 | 覆盖计划 §3 Phase 1 测试清单;原 19 用例全部保留零改动 |

### Phase 2(Commit 4f1d6a2)

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/src/agent/routes.ts` | 新增常量 `UPLOADS_DIR='.wf-uploads'` / `UPLOAD_MAX_BYTES=10MB` / `UPLOAD_TTL_MS=30d`;`POST /api/agent/workspaces/:id/uploads`:requireWorkspace → 只读 403(先于一切解析)→ 缺 data 400 → 长度粗判/解码复检 ≤10MB → `sniffMime`+`extForMime` 定 mime(不信客户端)→ mkdir+`randomUUID()` 文件名写盘 → 惰性清理(同目录 mtime>30 天删除,失败静默)→ 返回 `{ code:0, data:{ path } }`;路由置于 prompt 附近 | 上传 = 写盘,只读语义 403 双保险(决策 2);文件名服务端生成(决策 1/8);防孤儿堆积(决策 7) |
| `apps/api/src/agent/uploadsRoutes.test.ts`(**新建**) | 10 用例:成功 PNG/JPEG 落盘内容一致、超限 400 零写盘、非法 mime 400 零写盘、空 body/缺 data 400、只读 403 零写盘、工作区不存在 404、fileName 不可信(uuid 服务端名)、惰性清理 31 天旧文件删/新文件留、30 天内不受影响 | 仿 visionRoutes.test.ts 私有构造范式;计划 §3 Phase 2 清单全覆盖 |

### Phase 3(Commit 026c259)

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/web/package.json` / `pnpm-lock.yaml` | dependencies 增加 `"compressorjs": "^1.3.0"`(自带 TS 类型,无 @types) | 决策 11:三方库压缩;`pnpm --filter @workflows/web add compressorjs` 安装,包名与版本已确认 |
| `apps/web/src/utils/image.ts`(**新建**) | `compressImage(file, options): Promise<Blob>` 为 compressorjs 的 Promise 包装(库唯一入口);`PASTE_COMPRESS_OPTS`(2048/0.85/1MB convertSize)/ `THUMB_COMPRESS_OPTS`(160/0.75);`preparePastedImage` 双趟压缩(第一趟上传图、第二趟同一库 160px 缩略图)+ `blobToDataUrl`(FileReader 纯字节序列化);非图片 File 拒绝 | 仓库内零自实现 canvas(可 grep 验证,唯一 canvas 消费方为 compressorjs 内部);决策 9(输出格式跟随原图 mime,PNG>1MB 转 JPEG) |
| `apps/web/src/composables/useAgent.ts` | `UiMessage.images?: Array<{path,thumb}>`(仅会话内,不持久化);`pushUserMessage(text, images?)`;`sendMessage(text, images?)` 透传;新增 `uploadImage(dataUrl): Promise<string>`(POST /uploads,body 纯 base64 无 data: 前缀,复用 request<T>) | 决策 6(缩略图内存 objectURL);方案 A 全链路零 shared 类型改动 |
| `apps/web/src/components/ChatPane.vue` | `pendingImages` 队列(thumb/uploadDataUrl/path/status);textarea `@paste="onPaste"`(剪贴板 image 项 → preparePastedImage,>8 张拒绝,只读工作区提示并拒绝,非图片走默认,压缩失败 error 态入列);输入框正上方缩略图预览条(删除 ×、`n/8 张,共 N KB` 提示、上传中/错误角标);`handleSend`:纯图可发送 → 并行上传(任一张失败 sendError 且不发送)→ 拼接 `[图片: path]` + 原文本 → `sendMessage(fullText, images)` → 成功后清空并 revoke;`removeImage`/切工作区 watch 清空并 revoke;发送按钮 disabled 条件 `(!draft.trim() && pendingImages.length===0)` | 计划 §3.5 全部要点;无图时文本原样发送(保持 v1 行为,不引入多余空格) |
| `apps/web/src/components/MessageBubble.vue` | user 消息分支 markdown 前插入缩略图网格(64px,h-16 w-16,title=path) | 用户气泡内展示已发图片 |
| `apps/web/src/utils/image.test.ts`(**新建**) | vi.mock('compressorjs')(成功/失败回调直通,记录实例化参数);stub URL.createObjectURL;7 用例:resolve/参数透传/缺省空对象/error 透出、blobToDataUrl 真实 FileReader、双趟参数(2048/0.85/1MB 与 160/0.75)、非图片拒绝 | 双层 mock 第一层(jsdom 无 canvas,风险 6) |
| `apps/web/src/components/ChatPane.test.ts` | 顶部 vi.mock('@/utils/image' 相对路径)+ URL stub;mountPane 增加 `uploadImage` mock 与 `readOnly` 选项;新增 9 用例(a-f 全覆盖:paste 接线/非图片/删除 revoke/>8 拒绝/纯图发送/带文本发送/上传失败保留/只读拒绝/切工作区清空);既有「无匹配查询」断言更新为 `('/skill:nope', undefined)` | 双层 mock 第二层;接口新增可选第二参数导致调用形状变化(计划内接口变更,非行为回退) |
| `apps/web/src/composables/useAgent.test.ts` | 新增 5 用例:uploadImage 请求形状(路径/纯 base64 payload/返回 path)、无工作区抛错、400 文案透出、sendMessage 透传 images 到 UiMessage、无 images 时字段为 undefined | 计划 §3.7 第 3 组 |

### Phase 4(Commit 42e095f)

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/scripts/mock-xiaomi-server.mjs` | 响应文案固定「1 张图」→ 动态「N 张图」(`images.length`) | mock 多图验证可断言 |
| `apps/api/scripts/verify-vision.mjs` | 新增 `--images N`(默认 1,≤8);构造 N 个 image_url 项 + text 项;离线模式断言响应含「(N 张图)」;线上模式行为不变 | 计划 §3 Phase 4 第 2 条 |

---

## 3. 验证结果

### 3.1 全量流水线(全部通过)

```
pnpm test       → @workflows/api 18 文件 373 用例 / @workflows/web 10 文件 98 用例 全绿
pnpm typecheck  → 3 包全绿(0 error)
pnpm build      → 3 包全绿(web dist 209.65 kB │ gzip 68.48 kB)
pnpm lint       → 0 error 0 warning
```

### 3.2 vision 相关单测无回归

- `visionTools.test.ts`:原 19 用例全部保留零改动,现共 **49 用例**(42 `it` + 1 `it.each` 7 行),全绿。
- `uploadsRoutes.test.ts`:10 用例全绿(含只读 403 零写盘、非法 mime 400、超限 400)。
- 前端:ChatPane 93 用例(原 84 + 新 9)、useAgent 全量(原 +5)、image.test.ts 7 用例,全绿。

### 3.3 离线多图验证(实际运行通过)

```bash
node apps/api/scripts/mock-xiaomi-server.mjs --port 3998 &   # 3999 被历史实例占用,本次用 3998
node apps/api/scripts/verify-vision.mjs --base-url http://127.0.0.1:3998/v1 --images 3
# → OK: HTTP 200, content: mock 识图成功(3 张图);离线断言通过:mock 响应含「(3 张图)」;exit 0
node apps/api/scripts/verify-vision.mjs --base-url http://127.0.0.1:3998/v1        # 单图回归
# → OK: mock 识图成功(1 张图);exit 0
# mock 日志:model=mimo-v2.5 stream=false images=3 text=请描述这张图片 + 3 条 image_url 前 80 字符
```

### 3.4 上传路由手动分支(等价 curl)

上传路由的 200/400/403/404 分支由 `uploadsRoutes.test.ts` 经 Hono `app.request`(真实 HTTP 语义)覆盖,
与手动 curl 等价;成功落盘内容已按字节比对(base64 往返一致)。

### 3.5 仓库内无自实现 canvas(验收可 grep)

`apps/web/src` 中 `drawImage|createImageBitmap|.toBlob|getContext` 仅命中 image.test.ts 一处注释;
压缩与缩略图缩放全部走 compressorjs(utils/image.ts 单文件封装,换库只改此文件)。

---

## 4. 遗留事项(需用户配合的浏览器冒烟)

以下清单来自计划 §3 Phase 4 第 3 条,需在浏览器(dev server + mock 或真实 key)中人工勾选:

1. 任意截图 → Ctrl+V 粘贴 → 输入框上方出现缩略图 + 数量/体积提示(缩略图 src 为 `blob:` objectURL);
2. 点 × 删除 → 缩略图消失;粘贴 9 张 → 拒绝并提示;
3. 空文本 + 1 张图 → 发送按钮可用 → 发送后用户气泡显示缩略图,文本含 `[图片: .wf-uploads/xxx.ext]`;
4. agent 回合内出现 `vision-understand` 工具调用(参数 `image_paths`),返回文字描述;
5. 2 张图一次发送 → mock 日志 `images=2`(一次调用两图);
6. 只读工作区粘贴 → 提示被拒;
7. 压缩行为验证(compressorjs):粘贴 >1MB PNG 截图 → `.wf-uploads/` 下为 `.jpeg` 且体积显著下降;
   ≤1MB 小 PNG → 保持 `.png`;JPEG 照片 → `.jpeg`;带 EXIF 方向手机照片 → 方向正常(checkOrientation);
8. 发送后刷新页面/切换会话 → 图片以文本路径呈现(缩略图不恢复,符合决策 6);
9. 图片 URL 输入验证(`image_urls` 参数)→ mock fetch 下载成功;
10. base64 输入验证(`image_data` 参数)→ 成功。

真实环境(XIAOMI_API_KEY 直连小米多图真实识别)同样需用户配合,本次未执行(离线验证已覆盖协议形状)。

其他说明:
- `.wf-uploads` 未加入任何 .gitignore(与 `.wf-runs` 同哲学;如需排除请在用户工作区 .gitignore 加 `.wf-uploads/`,计划默认不加)。
- 上传路由的上传时惰性清理(>30 天)已实现并测试,无独立定时任务(决策 7)。
- 遗留:3999 端口有一历史 mock 实例占用(与本次交付无关),本次验证使用 3998。
