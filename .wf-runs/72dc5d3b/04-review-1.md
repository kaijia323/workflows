# 04 代码审查报告:vision-understand 工具增强 + 粘贴图片缩略图(compressorjs)

> 审查对象:commit d80177b(Phase 1)/ 4f1d6a2(Phase 2)/ 026c259(Phase 3)/ 42e095f(Phase 4),
> 对照 `.wf-runs/72dc5d3b/02-plan-2.md`(v2 计划)与 `03-execution-1.md`(执行报告)。
> 已核对 `.git/logs/HEAD`:4 个 commit 均存在、顺序正确,HEAD 停在 42e095f(工作流记录未提交,与报告声明一致)。
> 验证方式:静态审查全部改动文件 + 单测/流水线结果采信执行报告(审查环境无测试运行器)。

## 结论

**pass**

计划符合性完整(11 项决策全部按拍板值落地,无范围蔓延);安全关键点(SSRF 时序、流式限流、
魔数嗅探、uuid 防路径穿越、只读 403 优先、错误脱敏)全部落实且有对应单测;核心逻辑逐条核对通过;
回归面(原 19 用例、deepseek 链路、单图协议)未见破坏。发现的问题均为低危加固/边界项,不违反计划验收标准。

---

## 1. 逐条核对(计划项 → 状态 → 说明)

### Phase 1(visionTools.ts / imageMime.ts)

| # | 计划项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1.1 | imageMime.ts 新建:SUPPORTED_MIME / MAX_IMAGE_BYTES / sniffMime | 通过 | 值域 jpg/jpeg/png/gif/webp 与 v1 一致;魔数 PNG/JPEG/GIF87a/89a/RIFF+WEBP 正确;另增 extForMime(计划外小增量,用途明确) |
| 1.2 | schema 三路可选数组 + image_path 别名 + question | 通过 | TypeBox schema 三路均 maxItems=8;image_path 标 deprecated |
| 1.3 | 归并顺序 path→data→url、总数 ≤8、总量 ≤20MB 前置校验 | 通过 | callVision 中 pathList/dataList/urlList 归并,imageCount>8 拒绝;pushImage 累加 `base64.length*3/4` 在请求前抛错;maxTotalBytes/maxImageBytes 均可注入 |
| 1.4 | image_paths 沿用 v1 守卫 + stat 体积 + mimeFor + readFile | 通过 | 逐张循环,守卫先行,超限在 readFile 前拦截 |
| 1.5 | image_data:data URL 正则 + mime 白名单 + 长度粗判/解码复检 + 裸 base64 嗅探 | 通过 | DATA_URL_RE 限定 image/*+base64;非白名单 mime 明确报错;裸 base64 嗅探失败报「无法识别图片格式」;零请求 |
| 1.6 | image_urls SSRF:仅 https、dns.lookup 后 isBlockedIp、10s 超时、流式 ≤10MB、Content-Type+魔数双校验、转 data URL | 通过 | 解析→协议校验→lookup→IP 校验→fetch 顺序正确;AbortSignal.any(timeout+size+调用方);流式计数超限即 abort,无整包读入;下载结果转 data URL 进请求体 |
| 1.7 | isBlockedIp 纯函数(计划 6 段 + ::1/fc00::/7/fe80::/10) | 通过 | 覆盖计划全部段;额外处理 IPv4-mapped IPv6(::ffff:a.b.c.d 与 ::ffff:hex 均拦截)与不可解析 IP 默认拦截;int32 掩码后 `>>>0` 无符号比较正确(修复了实现 bug);IPv4 简写/八进制形态被兜底拦截 |
| 1.8 | 请求体组装:多图 image_url 项 + text 项;单图与 v1 逐字节一致 | 通过 | 多图测试断言 content 恰 N+1 项、顺序 path→data→url;别名一致性测试断言逐字节相同;原「请求构造」测试断言单图形状与 v1 相同 |
| 1.9 | 错误分层:abort 唯一透传、key 脱敏、守卫先行 | 通过 | key 仅进 Authorization 头,错误文本不含 key;Operation aborted 唯一 throw;400 文案扩为含数量/体积提示 |
| 1.10 | 测试 ≥9 组 | 通过 | 4 个新 describe(多图 6 / image_data 5 / image_urls 9 / 混合 1)+ 原 6 组保留;覆盖 SSRF 各地址段直测、下载成功/超时/超限/非 https/内网 DNS、9 张拒绝、总量超限、魔数不符、守卫回归 |

### Phase 2(上传路由)

| # | 计划项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 2.1 | POST /uploads:requireWorkspace → 只读 403(先于解析)→ 缺 data 400 → 粗判/复检 ≤10MB → sniffMime 定 mime → uuid 文件名落盘 | 通过 | 顺序与计划一致;扩展名由魔数决定,不信任客户端;目录 mkdir recursive |
| 2.2 | 惰性清理 mtime>30 天,失败静默 | 通过 | cleanupOldUploads 仅删 isFile()(不删符号链接,安全方向);单文件失败跳过 |
| 2.3 | 响应 `{ code:0, message:'ok', data:{ path } }`;路由在 prompt 附近 | 通过 | 注册位置正确;shared 类型零改动 |
| 2.4 | 测试 ≥8 组 | 通过 | 10 用例:成功落盘字节一致(PNG/JPEG)、超限 400 零写盘、非法 mime 400 零写盘、空 body 400、只读 403 零写盘、404、fileName 不可信(uuid 名,无 evil 文件)、31 天清理、30 天内保留 |

### Phase 3(前端)

| # | 计划项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 3.1 | compressorjs@^1.3.0 依赖 + lockfile | 通过 | package.json `^1.3.0`;pnpm-lock 含 compressorjs@1.3.0(自带类型,无 @types) |
| 3.2 | utils/image.ts:compressImage Promise 包装、PASTE/THUMB 参数、双趟、blobToDataUrl、非图片拒绝 | 通过 | 包装 success→resolve/error→reject;PASTE(2048/0.85/1MB)、THUMB(160/0.75);仓库内无自实现 canvas(grep 仅命中测试注释);blobToDataUrl 纯 FileReader 序列化 |
| 3.3 | useAgent:UiMessage.images、pushUserMessage/sendMessage 第二参数、uploadImage(纯 base64 payload) | 通过 | uploadImage 去 data: 前缀发 `{ data }`;无工作区 throw;错误文案透出 |
| 3.4 | ChatPane:@paste 读取剪贴板、只读拒绝、>8 张拒绝、缩略图条、删除 revoke、纯图发送、并行上传、[图片: path] 拼接、失败保留重试、切工作区清空 revoke | 通过 | 全部落实;非图片粘贴走默认;压缩失败 error 态入列;发送按钮 disabled 条件 `(!draft.trim() && pendingImages.length===0)`;watch activeWorkspaceId 清空 |
| 3.5 | MessageBubble:user 分支 markdown 前缩略图网格 | 通过 | h-16 w-16 + title=path;历史消息无 images 字段 → 不恢复缩略图(决策 6) |
| 3.6 | 测试:双层 mock + URL stub + 接线用例 a-f + useAgent 5 用例 | 通过 | image.test.ts 7 用例(参数透传/error 透出/双趟参数/非图片拒绝);ChatPane 9 用例(a-f 全覆盖);useAgent 5 用例;断言更新 `('/skill:nope', undefined)` 为接口变更正确结果 |

### Phase 4(验证)

| # | 计划项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 4.1 | mock 响应动态「N 张图」 | 通过 | `mock 识图成功(${images.length} 张图)` |
| 4.2 | verify-vision --images N(≤8)离线断言 | 通过 | 默认 1;离线断言含「(N 张图)」;报告 §3.3 给出 --images 3 与单图实际运行通过(端口 3998,历史实例占用 3999) |
| 4.3 | 浏览器冒烟 10 项 | 未完成(合理) | 计划明确为「需用户配合的人工勾选」,执行报告 §4 已如实列为遗留;非执行缺陷 |

### 声明偏差(执行报告)

| 偏差 | 判定 | 说明 |
| --- | --- | --- |
| visionTools.test.ts 修复 int32 位运算 bug(掩码后 `>>>0`) | 合理 | 实现缺陷在测试中暴露并修复,isBlockedIp 行为符合计划语义 |
| 新增 IPv4-mapped IPv6 防绕过 | 合理 | 超出计划规格但属于任务审查重点明确提示项,方向正确(::ffff:127.0.0.1 / ::ffff:7f00:1 均拦截) |
| `.wf-runs/72dc5d3b` 未提交 + `.wf-runs/4f531a21/run.json` 上游遗留 | 合理 | 与仓库既有「chore: 提交工作流运行记录」模式一致,编排层统一提交;run.json 改动非本次功能范围 |
| mock 端口 3998(3999 被历史实例占用) | 合理 | 环境因素,不影响验证有效性 |
| ChatPane 既有断言更新为 `('/skill:nope', undefined)` | 合理 | sendMessage 新增可选第二参数,无图时传 undefined,语义保持 |

### 回归风险

| 项 | 判定 | 说明 |
| --- | --- | --- |
| 原 vision 19 单测 | 通过 | 原 6 组 describe 全部保留零改动;单图请求体形状断言与 v1 一致 |
| deepseek 会话链路 | 通过 | VisionToolOptions 全部为新增可选字段,piService/subAgent 调用点兼容;sendMessage 第二参数可选;shared 类型零改动 |
| mock/verify 单图回归 | 通过 | 报告 §3.3 单图模式实际运行通过 |

---

## 2. 问题清单(均不构成 fail;按严重度排序)

1. **[P2] ChatPane.vue `handleSend`(约 L223-256)缺发送中并发防护**
   上传期间 `agent.streaming` 仍为 false、无 sending 锁,连按发送按钮/回车可并发触发两次 handleSend →
   每张图重复上传(磁盘重复文件,30 天清理兜底)+ 用户消息与 agent 回复重复。
   建议:新增 `sending` ref 或在 handleSend 入口 `if (pendingImages.some(i => i.status === 'uploading')) return`,
   发送按钮 disabled 条件同步加入。

2. **[P3] ChatPane.vue onPaste 压缩失败项(thumb='' / uploadDataUrl='')仍参与发送**
   含 error 项时点发送 → `uploadImage('')` → 400「缺少图片数据(data)」,提示与「图片压缩失败」语义不符。
   建议:发送前过滤 error 项或任一 error 项时阻止发送并提示。

3. **[P3] ChatPane.vue handleSend 在 sendMessage 前清空 draft**
   sendMessage 失败(如网络断)时:文本已丢失、pendingImages 保留(path 已置),
   重试会对已上传图片再次 uploadImage(重复落盘)。
   建议:sendMessage 成功后再清 draft;重试时跳过已含 path 的项(或直接复用 img.path)。

4. **[P3] visionTools.ts downloadImageUrl `redirect: 'follow'` 残余窗口比注释描述更宽**
   重定向目标 host **不重新做 DNS/IP 校验**,公共 https URL 302 到 `http://<内网IP>/…` 会被跟随下载
   (响应 Content-Type/魔数校验在重定向之后,仅能拦非图片响应)。计划风险 5 已声明接受该窗口,
   但代码注释仅提「DNS rebinding」。建议:`redirect: 'error'`(304 提示重试)或手动跟随循环中对
   每跳重新 lookup+isBlockedIp;至少注释补全实际窗口。

5. **[P3] isBlockedIp 未覆盖部分保留段(与计划规格一致,仅加固建议)**
   100.64.0.0/10(CGNAT)、224.0.0.0/4、240.0.0.0/4、192.0.0.0/24、198.18.0.0/15、IPv6 `::`(未指定)未拦截;
   `::127.0.0.1`(已废弃 IPv4-compatible 形态)可绕过映射检查。均为「护栏」级残余,dns.lookup 实际不会返回
   多数形态;如需加固可扩展掩码表。

6. **[P4] routes.ts 上传路由 body 在 readJson 全量解析后才做长度粗判**
   超大请求体(数百 MB)先完整进内存再拒绝(Hono 无默认 body 上限,计划风险 3 已声明接受)。
   建议:加 `hono/body-limit` 中间件(如 12MB)纵深防御,粗判保留为第二道。

7. **[P4] 测试缺口(计划未要求,提示性)**
   ChatPane「压缩失败 error 态入列」分支、MessageBubble images 网格渲染、uploads 路由 500 分支
   无直接测试;「上传中」角标无断言。建议后续补充。

---

## 3. 最终建议

**通过。** 4 个 commit 与 v2 计划逐项吻合(含 compressorjs 双趟压缩、.wf-uploads、只读 403、
8/10/20MB 上限、image_path 兼容、[图片: 路径] 标记、30 天惰性清理),安全关键点实现正确且有测试锚定,
声明偏差均合理,无范围蔓延。问题 1-3 建议作为 follow-up 小修(纯前端防御);4-7 为已知接受窗口的
加固选项,可择机处理。浏览器冒烟 10 项与真实环境验证按计划留待用户配合。
