# 03 执行报告(1):为 workflows 接入小米视觉识图能力(内置视觉理解工具)

> 依据:`.wf-runs/4f531a21/02-plan-2.md`。三个 Phase 全部完成:Phase 0 基线 → Phase 1 后端 → Phase 2 前端 → Phase 3 验证。
> 每 Phase 一个独立 commit(c1 / c2 / c3),全部通过 pre-commit 钩子(lint-staged eslint + turbo typecheck + test)。
> 真实小米 API key 冒烟(计划 §3.2)因用户未提供 key 而跳过,已在「遗留事项」标注。

---

## 0. Phase 0 基线(commit 前)

- `git status`:工作区仅 `.wf-runs/4f531a21/` 未跟踪,其余干净;无需 `pnpm install`(node_modules 就绪)。
- 基线全绿(turbo 缓存命中):build 3/3、typecheck 3/3、test api 293 / web 68。

## 1. 改动文件清单

### Phase 1 后端(commit `20703ca`)

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/visionTools.ts` | **新建**:`createVisionTools` 工厂(工具名 `vision-understand`)。守卫内置于 execute(`isAllowedTargetPath` + skills 放行根);env `XIAOMI_API_KEY` > `getApiKey()`;60s 超时(`AbortSignal.any`)、10MB 单图上限、mime 白名单 jpeg/png/gif/webp、50KB 截断(复用 `truncateOutput`);错误分层返回文本不 throw,唯一透传 `Operation aborted` | 计划 §4.1.1(D2/D3/D8/D10) |
| `apps/api/src/pi/anySearchTools.ts` | `truncateOutput` 由模块私有改为 **export**(visionTools 复用,不做重复实现) | 计划 §4.1.1 |
| `apps/api/src/config.ts` | `StoredConfig` 增加 `visionEnabled`/`visionApiKey`(注释:env 优先/明文/不回传);新增 `setVisionConfig`(业务键 enabled/apiKey → 存储键映射,空串删除)、`getVisionEnabled`、`hasVisionApiKey`、`visionAvailable`(注册门单一事实源) | 计划 §4.1.3 |
| `apps/api/src/pi/piService.ts` | openSession 在 webTools 块后构建 visionTools(门 `visionAvailable`),guardedTools 与 activeTools **读写/只读双分支**均追加工具与白名单;getConfig 返回 `visionEnabled`/`hasVisionApiKey`(无 key 明文);新增 `setVisionConfig`(开关翻转 → `refreshOpenSessions`,key-only 不重建);`mcpRebuildPending` 改名 `rebuildPending`,抽出私有 `rebuildAllHandles(skipReadOnly)`;`refreshMcpForOpenSessions()` → `rebuildAllHandles(true)`,新增 `refreshOpenSessions()` → `rebuildAllHandles(false)`;prompt() 挂起引用同步改名 | 计划 §4.1.4(D4/D7) |
| `apps/api/src/pi/subAgent.ts` | `buildSubAgentTools` options 增加 `visionTools?: ToolDefinition[]`(push + activeNames 白名单);`runSubAgent` 按 `visionAvailable` 构建 visionTools(skills 放行根 + 动态 key)并传入 | 计划 §4.1.5 |
| `apps/api/src/agent/routes.ts` | 新增 `PUT /api/agent/config/vision`:enabled 非布尔 400 / apiKey 非字符串 400 / 空串清空;返回 `pi.getConfig()`(key 不回传) | 计划 §4.1.6 |
| `packages/shared/src/index.ts` | `AgentConfig` 增加 `visionEnabled: boolean`、`hasVisionApiKey: boolean` | 计划 §4.1.2 |
| `AGENTS.md` | 新增「内置视觉工具 vision-understand」条目:双点注册、注册门 `visionAvailable`、只读工作区也注册、守卫内置于工具、开关翻转重建 | 计划 §4.1.7 |
| `docs/mcp.md` | §3 命名冲突清单:仓库工具列表追加 `vision-understand` | 计划 §4.1.7 |
| `docs/dag-workflow.md` | §子代理工具集补充:追加 `vision-understand`(开关开启且配置 key 时注册) | 计划 §4.1.7 |
| `apps/api/src/pi/visionTools.test.ts` | **新建** 19 用例:请求构造(data URL/mime/model/stream)/key 解析(env>getApiKey>无 key 错误)/成功/50KB 截断/HTTP 错误分层/非 JSON/结构缺失/空 content/网络异常/空参数/越界路径/skills 放行根/文件不存在/超限/不支持格式/预置与执行中 abort 透传/超时/工厂 | 计划 §4.1.8 |
| `apps/api/src/config.test.ts` | +4 用例:持久化与默认关 / 空串删除 / `visionAvailable` 门组合 / env `XIAOMI_API_KEY` 优先与卸载回退 | 计划 §4.1.3 |
| `apps/api/src/pi/subAgent.test.ts` | +8 用例(四角色 × 传入恰一次 / 缺省不含,仿 mcpTools 组) | 计划 §4.1.5 |
| `apps/api/src/pi/mcpRefresh.test.ts` | `mcpRebuildPending` → `rebuildPending` 全量改名;新增 `refreshOpenSessions` 组(只读工作区也重建 / 忙碌挂起共用机制) | 计划 §4.1.4 改名波及 + 验收 |
| `apps/api/src/pi/piService.test.ts` | +1 用例:`setVisionConfig` 开关翻转 → refreshOpenSessions,key-only 不重建,落盘断言 | 计划 §4.1.4 |
| `apps/api/src/agent/visionRoutes.test.ts` | **新建** 6 用例:保存落盘 + 响应无 key 明文 / enabled 非布尔 400 零写入 / apiKey 非字符串 400 / 空串清空 / 关闭仅提交 enabled / 翻转触发重建接线(仿 mcpRoutes.test.ts 私有构造范式;runtime stub 提供 getModels/getModel) | 计划 §4.1.6 |

### Phase 2 前端(commit `71ab29c`)

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/web/src/components/VisionPanel.vue` | **新建**:「视觉模型 · VISION」段标题 + 说明(按量付费/key 仅存后端/env 优先/工具形态/默认关);`role="switch"` 开关(默认取 `agent.visionEnabled`,关闭时 key 输入 disabled);密码输入 `sk-…`;保存(开启提交 `{enabled, apiKey}`,关闭仅提交 `{enabled:false}` 保留 key;成功后清空输入);三态状态行(已开启·已配置 key / 已开启·未配置 key / 已关闭);样式仿 ApiKeysPanel | 计划 §4.2.2 |
| `apps/web/src/components/ApiKeyModal.vue` | `TabId` 增加 `'vision'`;左侧导航新增「视觉模型」(副标题「识图工具」);右内容区 `v-show` 挂 `VisionPanel`(:agent + :meta);对话框 aria-label 更新为「设置:API Keys、MCP 与视觉模型配置」 | 计划 §4.2.3 |
| `apps/web/src/composables/useAgent.ts` | computed `visionEnabled`/`hasVisionApiKey`;`saveVisionConfig(patch)` → `PUT /api/agent/config/vision` + `refreshConfig`;AgentStore 暴露三项 | 计划 §4.2.1 |
| `apps/web/src/composables/useAgent.test.ts` | +2 用例:saveVisionConfig 请求体 + config 刷新(含 computed);关闭仅提交 enabled、未加载默认 false | 计划 §4.2.4 |
| `apps/web/src/components/VisionPanel.test.ts` | **新建** 6 用例:默认关 + 输入禁用 / 开启保存请求体 + 清空输入 / 关闭仅提交 enabled / 开启态空串清 key / 三态文案 / 失败保留输入 | 计划 §4.2.4 |

### Phase 3 验证(commit `a1fff8c`)

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/api/scripts/mock-xiaomi-server.mjs` | **新建**:无依赖 node:http;`POST /v1/chat/completions` 打印 model/stream/image_url 数量与 data URL 前 80 字符(确认 base64 前缀/mime 序列化),返回固定 choices 文本;支持 `--port`(默认 3999) | 计划 §3.1 |
| `apps/api/scripts/verify-vision.mjs` | **新建**:内置 1×1 PNG base64 常量;构造 text+image_url 请求,断言 200 + `choices[0].message.content` 非空;`--base-url`/`--model` 参数;不打印 key;线上无 `XIAOMI_API_KEY` 提示跳过(exit 0);失败非零退出 | 计划 §3.1 |

## 2. Commit 列表

| commit | 说明 |
| --- | --- |
| `20703ca` | feat(api): 内置视觉理解工具 vision-understand(开关门 + 双点注册 + 配置路由) |
| `71ab29c` | feat(web): 设置新增「视觉模型」tab(开关 + 小米 key + 状态行) |
| `a1fff8c` | chore(api): 视觉接口离线 mock 服务器 + 协议验证脚本 |
| (待) | chore: 提交工作流运行记录 .wf-runs(本报告随运行产物提交,遵循 AGENTS.md 约定) |

## 3. 验证结果

### 3.1 自动化(全部通过,`--force` 无缓存重跑)

| 项 | 结果 |
| --- | --- |
| `pnpm build` | 3/3 任务成功 |
| `pnpm typecheck` | 3/3 任务成功 |
| `pnpm lint` | api + web 均 0 error |
| `pnpm test` | api **17 文件 341 用例**(基线 293,+48);web **9 文件 76 用例**(基线 68,+8) |

### 3.2 离线 mock + 验证脚本(已实际运行)

```
$ node apps/api/scripts/mock-xiaomi-server.mjs --port 3999 &
$ node apps/api/scripts/verify-vision.mjs --base-url http://127.0.0.1:3999/v1
[verify-vision] POST http://127.0.0.1:3999/v1/chat/completions (model=mimo-v2.5, 无 key(离线 mock))
[verify-vision] OK: HTTP 200, choices[0].message.content 非空,耗时 32ms
[verify-vision] content: mock 识图成功(1 张图)
[mock-xiaomi] model=mimo-v2.5 stream=false images=1 text=请描述这张图片
[mock-xiaomi] image_url 前 80 字符:data:image/png;base64,iVBORw0KGgoAAAA...(总长 118)
```

- image_url 序列化确认:`data:image/png;base64,` 前缀 + 70 字节 PNG 的 base64(总长 118 与理论值一致)。
- 线上模式无 key:打印跳过提示,exit 0(已验证);带 key 指向 mock 的 Authorization 路径:通过(已验证)。

### 3.3 注册点核查(计划 §7 前端验收)

`vision-understand` 双点注册 + 白名单 + 文档登记齐全:piService `openSession`(读写/只读双分支 guardedTools + activeTools)、subAgent `buildSubAgentTools`(visionTools + activeNames)/ `runSubAgent`(构建传入)、AGENTS.md / docs/mcp.md / docs/dag-workflow.md 登记。

### 3.4 🔑 真实 key 冒烟(计划 §3.2 清单 1-8)——**跳过**

用户未提供小米 API key(`XIAOMI_API_KEY` 未设置),按任务要求跳过并在交付说明标注「待用户提供 key 后执行」。

## 4. 与计划的偏差(均为小项,已在 commit 内说明)

1. `visionTools.ts` 未声明 `MAX_OUTPUT_BYTES` 常量:截断常量归 `anySearchTools.truncateOutput` 所有(导出复用,计划 §4.1.1 已定「不做重复实现」),声明未使用常量会触发 `no-unused-vars`(error 级),故不保留。
2. 路由层测试落在**新建文件** `apps/api/src/agent/visionRoutes.test.ts`(仿 mcpRoutes.test.ts 的私有构造 + fake store 范式),而非 `app.test.ts`(后者绑定真实 store,写入会污染仓库 `.workflows/config.json`)——计划 §4.1.6 允许「或 routes 层既有测试」。
3. 超限错误文案为「图片文件超过大小上限(N 字节,实际 M 字节)」:比计划示例文案更精确且适配测试注入的小上限值。

## 5. 遗留事项

1. **🔑 真实 key 冒烟(计划 §3.2 清单 1-8)**:待用户提供小米 API key 后执行——
   - `XIAOMI_API_KEY=sk-... node apps/api/scripts/verify-vision.mjs`(线上 baseUrl);
   - `pnpm dev` 冒烟:设置 → 视觉模型开关默认关;开启 + 保存 key → `.workflows/config.json` 出现 `visionEnabled: true` 与 `visionApiKey`(明文,既有设计),`/api/agent/config` 响应**不含** key 明文;
   - 主代理工具卡片出现 `vision-understand` 调用并返回描述;子代理(如 explorer)模态窗 sub_* 事件出现该工具;
   - 开关关闭 + 保存 → 已打开会话重建,agent 不再列出该工具;仅清空 key(开关仍开)→ 工具调用报「未配置小米视觉 API key…」;
   - 超限图片 / 不支持格式 / 越界路径 → 对应错误;流式期间停止不崩溃;deepseek 全流程回归。
2. **需用户决策的默认值**(计划 §5):工具名 `vision-understand`、单图参数形态、开关关闭时不注册(不做 prompt 兜底)、纯文本返回(ImageContent 后续迭代)、env `XIAOMI_API_KEY` 通道——本次均按计划默认值实施,如要变更需后续小改。
3. `visionRoutes.test.ts` 与 `piService.test.ts` 中的 `refreshOpenSessions` 通过私有构造 hack 直测;主代理 openSession 的完整工具集注册建议在真实 key 冒烟(§3.2-2/3)中人工确认(与仓库既有测试范式一致,openSession 依赖 fff 原生进程与 ModelRuntime,不在单测范围)。
