# 03 执行报告(follow-up):审查 P2 三项修复(ChatPane 发送并发锁 / 压缩失败剔除 / 失败恢复草稿)

> 依据 `.wf-runs/72dc5d3b/04-review-1.md` 问题清单第 1-3 项(审查结论 pass,建议 follow-up 小修)。
> 范围严格限定:仅前端 `ChatPane.vue` / `useAgent.ts` 及相关测试;后端零改动。
> 三项问题均落在 ChatPane.vue(useAgent.ts 已具备所需原语:uploadImage / sendMessage / streaming),故 useAgent.ts 零改动。

---

## 1. Commit

| Commit | 说明 |
| --- | --- |
| `46cd3c2` `fix(web): ChatPane 发送并发锁 + 压缩失败剔除 + 发送失败恢复草稿(审查 P2)` | 三个 P2 修复 + 3 个新单测;husky 钩子(eslint --fix + 全仓 typecheck/test)通过 |

## 2. 改动文件清单

### `apps/web/src/components/ChatPane.vue`

| # | 改动 | 原因(对应审查项) |
| --- | --- | --- |
| 1 | 新增 `const sending = ref(false)` in-flight 锁;`handleSend` 入口 `if (sending.value) return`;整体包 try/finally(`finally { sending.value = false }`,上传失败提前 return 也释放);发送按钮 `:disabled` 增加 `sending` 条件 | **P2 #1 上传期间无并发锁**:上传阶段 `agent.streaming` 仍为 false,双击/连按回车可并发两次 handleSend → 重复上传 + 重复消息。锁覆盖「上传 + sendMessage」全程;按钮禁用与既有 `disabled:opacity-40` 风格一致(上传中显示「发送」但禁用,streaming 期间仍切换为「停止」,不改变现有交互) |
| 2 | `handleSend` 内新增守卫:`pendingImages.some(img => img.status === 'error' && !img.uploadDataUrl)` → `sendError = '存在压缩失败的图片,请删除后重试'` 并 return | **P2 #2 压缩失败项仍可触发发送**:压缩失败项(thumb='' / uploadDataUrl='')之前会走 `uploadImage('')` → 后端 400「缺少图片数据(data)」,提示与「图片压缩失败」语义不符。现整体阻止发送并提示;仅拦截**无上传数据**的项(压缩失败),上传失败项(有 uploadDataUrl)重试仍允许,保留原「上传失败可重试」行为 |
| 3 | 上传改为 `pendingImages.filter(img => !img.path)` 的 `toUpload` 并行上传;路径按队列顺序收集 `img.path ?? uploadedPaths[next++]`;发送前清空 draft 改为先存 `originalDraft`,`sendMessage` catch 中 `draft.value = originalDraft` 恢复 | **P2 #3 sendMessage 失败草稿丢失/重试重复上传**:失败时恢复输入草稿;待发图片本就保留(仅成功才 clearPendingImages);重试时已含 path 的项跳过 uploadImage(直接复用 path),不再重复落盘 |

### `apps/web/src/components/ChatPane.test.ts`

新增 3 用例(挂在既有「粘贴图片缩略图」describe 下,沿用双层 mock 与 paste() 工具函数):

| 用例 | 覆盖 |
| --- | --- |
| `双击锁:上传进行中再次触发发送(按钮 / 回车)不重复上传与发送` | uploadImage 返回受控 Promise(手动 resolve);上传中连点发送按钮 + textarea 回车 → uploadImage 恰 1 次、sendMessage 0 次、按钮 disabled;resolve 后只发送 1 次且参数正确 |
| `压缩失败项阻止发送并提示,不触发上传(避免误导性 400)` | `preparePastedImage` mockRejectedValueOnce → error 态入列(无缩略图 img、有删除按钮);点发送 → uploadImage/sendMessage 均不调用、提示「存在压缩失败的图片,请删除后重试」 |
| `sendMessage 失败:恢复输入草稿与待发图片;重试复用已上传 path 不重复上传` | sendMessage mockRejectedValueOnce → 草稿恢复为原文本、待发图片保留、uploadImage 恰 1 次;重试 → uploadImage 仍 1 次(跳过已上传项)、sendMessage 第 2 次成功、参数含 `[图片: up-1.png]` 前缀与 images |

### 未改动文件

- `apps/web/src/composables/useAgent.ts`:审查建议允许「handleSend 入口加锁 / 按钮禁用」二选一,选择 ChatPane 层锁(与现有 streaming/停止按钮交互同层),useAgent 原语(streaming/uploadImage/sendMessage)已满足,零改动。
- 后端全部文件、shared、MessageBubble.vue:不在范围。

## 3. 自检结果(全部通过)

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| web 单测 | `pnpm --filter @workflows/web test` | 10 文件 **101 用例**全绿(98 + 新增 3) |
| 全仓单测 | `pnpm test` | api 373 + web 101 全绿,3 tasks successful |
| typecheck | `pnpm --filter @workflows/web typecheck`(及 husky 全仓) | 0 error |
| build | `pnpm --filter @workflows/web build`(vue-tsc -b + vite) | 成功,dist 209.93 kB │ gzip 68.56 kB |
| lint | `pnpm --filter @workflows/web lint` | 0 error 0 warning(husky lint-staged eslint --fix 亦通过) |

## 4. 交互一致性核对

- 上传进行中:streaming=false → 仍显示「发送」按钮,但 `sending` 使其禁用(disabled:opacity-40,与既有无工作区/空输入禁用同一风格);streaming=true(消息已发出)后照旧切换为「停止」按钮 → 与现有「发送中」交互零冲突。
- 压缩失败项:仍以 error 态显示(红框 `!` 占位 + title=错误),用户可删除或先删除后重发;发送被整体阻止并给出明确提示,不再出现误导性 400。
- 失败恢复:草稿恢复为原始文本(trim 前原文),图片列表原样保留(含已上传成功的 path),重试零重复上传。

## 5. 未完成项

- 无(3 个 P2 全部落地;审查问题 4-7 为已知接受窗口/加固项,不在本次任务范围,未处理)。
- `.wf-runs/4f531a21/run.json` 的改动为上游遗留(与本次交付无关,未纳入 commit)。
