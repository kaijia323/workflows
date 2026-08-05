# 03 执行报告(1):按用户反馈修复 3 个问题(缩略图关闭 icon 居中 / 发送后清空待发缩略图 / image_urls 去 DNS 内网拦截)

> 依据:用户反馈(3 个问题,基于当前仓库,vision-understand 工具增强已上线)。本 run 无独立计划文件
> (`02-plan-*.md` 缺失,`run.json` status=planning),任务说明即计划,按任务逐条实施。
> 两个 commit:web 一个 + api 一个(任务允许「一个 commit 或按问题分 2 个:api + web」),另按仓库惯例
> 单独 chore commit 提交 `.wf-runs` 运行记录。

---

## 1. 改动文件清单

### 问题 1 + 2(web,commit `fix(web)`)

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/web/src/components/ChatPane.vue` | **问题 1 删除按钮**:`grid size-4 place-items-center` + 文本 `×` → `flex size-4 items-center justify-center` + lucide `<X class="size-3" />`(新增 `X` import)。保留 `aria-label="删除图片"` | 文本 × 的居中依赖字体度量:实测(canvas `measureText`,真实 Chrome)Inter/Noto Sans SC × 的 `actualBoundingBoxAscent/Descent = 12/0`(字形中心在基线上方 6px),Segoe UI/YaHei 为 8/-1、9/-2 等,各字体偏移 0.5~1px 且方向不一;CJK 回退字体下更不可控。SVG icon 是几何盒,flex 居中精确无字体依赖,且与库内既有 lucide 用法(Pause/ArrowUpDown)一致 |
| `apps/web/src/components/ChatPane.vue` | **问题 2 handleSend**:上传全部成功后,构造 `images` 后**立即** `pendingImages.value = []`(消息发出即清空输入区待发图片,不再等 `sendMessage` 流式回合结束);快照 `sentImages`;`sendMessage` resolve 后统一 `revokeObjectURL`(此时会话气泡 `<img>` 早已加载完成,释放安全);失败分支恢复草稿 + `pendingImages.value = [...sentImages, ...pendingImages.value]`(与发送期间新粘贴的图片合并,不覆盖用户新操作;URL 未 revoke 仍有效,复用已上传 path 不重复上传,P2 语义不回退) | 原实现在 `await sendMessage(...)` 之后才清空,而 `sendMessage` 在整段 SSE 流结束后才 resolve → 点击发送后缩略图在输入框上方悬挂整个 agent 回合,用户感知为「发送后仍显示」。objectURL 不在派发时 revoke 的原因:同一 URL 正被会话气泡 `<img>` 引用,浏览器实测「src 设置前 revoke → 裂图;加载已开始后 revoke → 正常」,故延后到发送成功后释放 |

### 问题 3(api,commit `fix(api)`)

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/visionTools.ts` | `image_urls` 下载流程移除 DNS 内网拦截:删除 `node:dns/promises` import、`VisionToolOptions.lookupImpl` 注入点、`ipv4ToInt`/`ipv6ToBytes`/`isBlockedIp`/`defaultLookup` 整段、`downloadImageUrl` 中「解析 → isBlockedIp 黑名单拒绝」逻辑;`downloadImageUrl` 签名去掉 `lookupImpl`;保留仅 https 协议校验、10s 下载超时、流式 ≤10MB abort、Content-Type + 魔数双校验、转 data URL | 用户明确:无需判断 DNS 是否内网,小米模型访问不了自然会报错。SSRF 黑名单(含 IPv4-mapped IPv6 防绕过、int32 `>>>0` 修复等)整体移除,删除 `isBlockedIp` 导出 |
| `apps/api/src/pi/visionTools.ts` | 同步文案:文件头设计注释、schema `image_urls` description、工具 description 全部移除「内网/保留地址拒绝」「SSRF 防护」表述,新注释说明「不做 DNS 解析与内网 IP 拦截:小米模型访问不了自然会报错,无需 SSRF 黑名单」 | 代码注释与行为同步(任务要求;`.wf-runs` 历史文档不改) |
| `apps/api/src/pi/visionTools.test.ts` | 删除 `isBlockedIp` import、`LOOKUP_PUBLIC` stub、3 个用例(`dns.lookup 解析到内网 IP → 拒绝`、`域名解析失败`、`isBlockedIp 纯函数直测`);describe 改名 `image_urls(SSRF 防护)` → `image_urls(https 下载)`;其余 URL 用例(https 下载成功 / 非 https 拒绝 / 下载超时 / 流式超限 abort / Content-Type 非白名单 / 魔数嗅探失败)保留并移除 `lookupImpl` 传参;`http 协议拒绝` 用例移除 lookup 断言 | URL 场景测试改为任务要求的集合(不包含内网 IP 拦截断言) |

### 未改动

- `piService.ts` / `subAgent.ts`:`createVisionTools` 调用点本就只传 `workspacePath`/`extraAllowedRoots`/`getApiKey`,不受 `lookupImpl` 移除影响。
- `.wf-runs/*` 历史文档:按任务要求不改。

## 2. 自检结果(全量四门)

| 门 | 命令 | 结果 |
| --- | --- | --- |
| 测试 | `pnpm test` | api **18 文件 / 370 用例通过**(visionTools.test.ts 46 用例);web **10 文件 / 101 用例通过**(ChatPane.test.ts 28 用例,含 P2 失败恢复、双击锁、revoke 断言全部保留绿) |
| 类型 | `pnpm typecheck` | 3/3 通过(shared/api/web) |
| Lint | `pnpm lint` | 3/3 通过 |
| 构建 | `pnpm build` | 3/3 通过(api tsc + web vue-tsc/vite) |

### 针对问题 1 的实际渲染核查(任务要求「检查实际渲染后修复」)

- 浏览器实测(canvas `measureText`,应用字体栈 Inter→Noto Sans SC→PingFang→YaHei):`×` 字形中心位于基线上方 +3.5~6px(随字体/字号不同),在 16px 圆形按钮内残余偏移 0.5~1px 且方向因字体而异,CJK 回退下更不可控 → 纯 CSS(line-height/padding)无法跨字体精确居中。
- 浏览器实测 blob URL 生命周期:`img.src` 设置前 `revokeObjectURL` → 图片加载失败(BROKEN);`src` 设置后 revoke → 正常加载(LOADED)。据此确定问题 2 的 revoke 时机(派发时清空列表、发送成功后 revoke),避免会话气泡缩略图裂图。

## 3. Commit 列表

| commit | 说明 |
| --- | --- |
| `fix(api)` | fix(api): vision-understand image_urls 移除 DNS 内网 IP 拦截(SSRF 黑名单) |
| `fix(web)` | fix(web): ChatPane 发送后立即清空待发缩略图 + 删除按钮图标居中 |
| `chore` | chore: 提交工作流运行记录 .wf-runs |

## 4. 遗留事项

- 真实小米 API key 冒烟(内网/公网 URL 下载)未做:用户未提供 key;行为变化已由单测覆盖(下载直接 fetch,不再查 DNS)。
- 无未完成项。
