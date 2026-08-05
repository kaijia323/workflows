# 04 审查报告:小米视觉理解工具(vision-understand)

> 审查范围:commit `20703ca`(Phase 1 后端)、`71ab29c`(Phase 2 前端)、`a1fff8c`(Phase 3 验证)及后续提交
> (已核对 `.git/logs/HEAD`:三 commit 顺序与提交信息一致,后接 `56625fe` 仅提交 .wf-runs 记录)。
> 对照产物:`.wf-runs/4f531a21/02-plan-2.md`(实施计划)、`.wf-runs/4f531a21/03-execution-1.md`(执行报告)。

## 结论:pass

---

## 1. 计划符合性

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 无 provider 泛化 / 模型切换 / 用户传图链路 | 通过 | 全库 grep 无 `SUPPORTED_PROVIDERS` / `parseModelRef` / `prompt(images)` 残留;deepseek 模型路径、`setModel`、`hasApiKey` 语义零改动;`config.model`、模型按钮保持原样 |
| 内置工具路线 `vision-understand` | 通过 | 仿 anySearchTools 内置 HTTP 工具工厂,无 MCP server 子进程、无新 SSE 事件、无 ImageContent 回传 |
| 只做声明范围 | 通过 | 改动文件与计划 §8 清单一致,无超出文件(文档、测试、脚本均在清单内) |
| 偏差 1:`MAX_OUTPUT_BYTES` 未声明 | 合理 | 截断常量归 `anySearchTools.truncateOutput` 所有(计划已定「不做重复实现」),声明未用常量会触发 eslint error,取舍正确 |
| 偏差 2:路由测试放 `visionRoutes.test.ts` | 合理 | 避开 `app.test.ts` 绑定真实 store 会污染仓库 `.workflows/config.json` 的问题,且计划允许「或 routes 层既有测试」;用例质量不低于计划要求 |
| 偏差 3:超限错误文案带实际字节数 | 合理 | 比计划示例更精确,且支撑注入小上限的测试 |

## 2. 核心逻辑正确性(逐文件)

### visionTools.ts(新建)
- **参数 schema**:`image_path`(必填)+ `question`(可选,缺省文案正确)✓
- **路径守卫**:execute 内 `isAllowedTargetPath(imagePath, workspacePath, extraAllowedRoots)`(workspaceGuard 单一事实源),且**先于 stat/readFile**(越界路径不触盘);`extraAllowedRoots` 传 skills 放行根,与 read 工具同语义 ✓
- **10MB 限制**:先 `stat` 后 `readFile`(超限文件不读入内存);TOCTOU 窗口极小,可接受 ✓
- **mime 白名单**:jpeg/jpg/png/gif/webp 按扩展名判定,不支持格式报明确错误 ✓
- **60s 超时**:`AbortSignal.any([AbortSignal.timeout(60s), signal])`,与 anySearchTools 完全同构;用户中止透传 `Operation aborted`(唯一透传异常),超时区分 `TimeoutError` 报「请求超时」✓
- **50KB 截断**:复用 `anySearchTools.ts` 导出的 `truncateOutput`(字节安全截断,不重复实现)✓
- **错误分层**:400(透出 API message)/401·403/402/429/≥500/非 JSON/`choices[0].message` 缺失/空 content/网络异常/无 key 全部落可读中文文本,不 throw ✓
- **小米 API 请求格式**:`POST https://api.xiaomimimo.com/v1/chat/completions`、`model: 'mimo-v2.5'`、`stream: false`、`content: [{type:'image_url', image_url:{url:'data:<mime>;base64,...'}}, {type:'text'}]`、`Authorization: Bearer <key>` — 与计划 D3/D10 及执行报告中 mock 实测序列化一致 ✓
- **key 优先级**:env `XIAOMI_API_KEY` > `getApiKey()`(动态读 config.json);无 key 防御性报错不 throw ✓
- 文件头注释写明协议事实来源(探索报告引用)✓

### config.ts
- `visionEnabled`/`visionApiKey` 持久化、空串删除(走 saveConfig 既有语义)、默认关 ✓
- `hasVisionApiKey` 含 env 优先;`visionAvailable()` = 开关开 && (env || config key)——注册门单一事实源,主/子代理共用 ✓
- key 不回传:getConfig 只返回 `hasVisionApiKey: boolean` ✓

### piService.ts
- openSession:visionTools 在 webTools 块后构建(门 `visionAvailable`);guardedTools **读写/只读双分支**均追加 `...visionTools`;activeTools 双分支均追加 `...visionToolNames`(白名单显式列入,SDK 过滤纪律)✓
- `setVisionConfig`:before/after 翻转检测 → `refreshOpenSessions()`;key-only 不重建(getApiKey 动态读取)✓
- `mcpRebuildPending` → `rebuildPending` 全量改名(piService 内 3 处 + mcpRefresh.test.ts 全部引用),grep 无残留 ✓
- `rebuildAllHandles(skipReadOnly)` 抽取;`refreshMcpForOpenSessions()` → `rebuildAllHandles(true)`(只读跳过,既有行为保留);`refreshOpenSessions()` → `rebuildAllHandles(false)`(只读也重建)✓
- prompt() 消费 `rebuildPending`:busy 检查先行(绝不 dispose 运行中会话),顺序正确 ✓

### subAgent.ts
- `buildSubAgentTools` options 增加 `visionTools?: ToolDefinition[]`(缺省 `[]` 保持既有行为);tools push + activeNames 白名单 ✓
- `runSubAgent` 按 `visionAvailable(store)` 构建(mcpTools 块之后),传入 `skillReadRoots(skillCtx)` 与动态 key ✓

### routes.ts
- `PUT /api/agent/config/vision`:`enabled` 非 boolean → 400「缺少 enabled(布尔)」;apiKey 非 string → 400;空串 trim 后清空;返回 `pi.getConfig()`(无 key 明文)✓

### shared / 前端
- `AgentConfig.visionEnabled`/`hasVisionApiKey` 类型就位 ✓
- VisionPanel.vue:开关(`role="switch"`)、密码输入(关闭时 disabled)、三态状态行、保存成功清输入 ✓
- ApiKeyModal.vue:vision tab + aria-label 更新 ✓
- useAgent.ts:`visionEnabled`/`hasVisionApiKey` computed + `saveVisionConfig`(PUT + refreshConfig)✓

## 3. 安全性

| 检查项 | 结果 |
| --- | --- |
| key 明文存储位置 | `.workflows/config.json`(开发)/ `~/.workflows`(生产),与既有 `apiKey`/`anySearchApiKey` 同设计,计划 D6 明示 |
| 路由泄漏 key | 无:`GET /api/agent/config` 与 `PUT /api/agent/config/vision` 响应均只含 `hasVisionApiKey`,grep 确认 `visionApiKey` 明文只出现在存储层/注入回调/测试 |
| 错误文案脱敏 | `mapHttpError` 不回显 key;400 透出的是 API message(与 anysearch 同纪律) |
| 路径守卫可绕过性 | 复用既有 `isAllowedTargetPath`:绝对路径 resolve 后边界检查、`..` 逃逸拦截、临时目录/设备白名单与 read 工具同语义;符号链接不解析是 workspaceGuard 既有信任模型(注释明示),非本次引入缺口;守卫先于文件读取,越界零 IO |
| fetch 注入方式 | `fetchImpl`/`endpoint`/`timeoutMs` 注入 + 组合信号,与 anySearchTools 完全同构 |

## 4. 回归风险

- `rebuildPending` 改名全量替换,`mcpRefresh.test.ts` 覆盖 MCP 刷新全路径(空闲重建/忙碌挂起/只读跳过/失败隔离/prompt 挂起消费),MCP 保存/删除路由仍走 `refreshMcpForOpenSessions`(只读跳过语义未变)✓
- 开关默认关 = 零注册,既有 deepseek 会话/MCP 功能零行为变化(灰度天然)✓
- 基线 293(+48)→ 341 / 68(+8)→ 76 全绿(执行报告 §3.1,`--force` 无缓存)✓
- mock-xiaomi-server.mjs + verify-vision.mjs 已实际跑通(执行报告 §3.2 有输出证据):image_url data URL 序列化(前缀 + 总长)与协议形状验证充分 ✓
- 局限:主代理 openSession 完整工具集注册无端到端单测(依赖 fff 原生进程 + ModelRuntime,仓库既有范式),已在执行报告遗留事项 3 诚实标注,依赖真实 key 冒烟人工确认

## 5. 测试质量

- **visionTools.test.ts(19 用例)**:请求构造(端点/Bearer/model/stream/data URL mime/question 透传)、key 优先级(env > getApiKey > 无 key 报错零请求)、成功、50KB 截断(字节边界断言)、HTTP 分层 400/401/403/402/429/5xx、非 JSON、结构缺失、空 content、网络异常、空参数、越界(不发请求)、skills 放行根、文件不存在、超限(注入 10 字节上限)、不支持格式、预置/执行中 abort 透传、超时、工厂 —— 覆盖计划 §7 全部后端验收分支 ✓
- **config.test.ts(+4)**:持久化/默认关、空串删除、门组合(开关关+key / 开+无 key / 开+key)、env 注入与卸载回退 ✓
- **subAgent.test.ts(+8)**:四角色 × (传入恰一次 / 缺省不含)✓
- **piService.test.ts(+1)**:开关翻转重建 / key-only 不重建 / 落盘断言 ✓
- **visionRoutes.test.ts(6)**:保存落盘+响应无 key / enabled 非布尔 400 零写入 / apiKey 非字符串 400 / 空串清空 / 关闭仅提交 enabled / 翻转触发重建接线 ✓
- **mcpRefresh.test.ts**:refreshOpenSessions 组(只读也重建 / 忙碌挂起共用机制)✓
- **web(+8)**:useAgent.saveVisionConfig 请求体+config 刷新;VisionPanel 6 用例(默认关+禁用、开启请求体+清输入、关闭仅提交 enabled、三态文案、失败保留输入)✓
- 关键分支「开关关闭不注册」「key 缺失」「路径越界」「超限文件」均有对应用例 ✓

## 6. 问题清单(非阻塞,建议下轮修复)

| # | 文件:位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1(medium) | `apps/web/src/components/VisionPanel.vue` handleSave(~L40-52)+ `VisionPanel.test.ts`「开启态空串清 key」用例 | **交互矛盾**:已配置 key → 关闭开关(仅提交 enabled,key 保留)→ 重新打开开关时密码框为空,保存提交 `{ enabled: true, apiKey: '' }` → 后端清空 key,「重新开启即恢复可用」的计划意图落空。实现忠实于计划 2.2 字面(「提交 { enabled, apiKey: keyInput }」),但计划两处意图(保留 key 可恢复 vs 空串清空)相互冲突 | 开启态且 keyInput 为空时**不提交 apiKey 字段**(后端 `setVisionConfig` 已支持 undefined 不触碰);清空 key 改为显式动作(如独立「清除 key」按钮或明确文案);同步调整对应测试 |
| 2(minor) | `apps/web/src/components/VisionPanel.vue` 开关绑定 | 开关本地态 `visionOn` 与后端 `agent.visionEnabled` 在保存失败/外部变更时不同步:开关视觉位置与状态行文案可能矛盾(开关开但状态行「已关闭」) | 保存失败时回滚 `visionOn` 为 `agent.visionEnabled.value`,或开关直接绑定 computed 并仅在保存成功刷新 |
| 3(info) | 计划 §3.2 / 验收 §7 | 🔑 真实 key 冒烟(清单 1-8)未执行(用户未提供 key),已在执行报告「遗留事项 1」如实标注;主代理 openSession 注册链端到端确认也依赖该冒烟 | 用户提供小米 key 后补做冒烟清单 1-8,记录到 run 产物;在此之前「主代理工具卡片出现 vision-understand」仅为代码审查结论 |

## 7. 最终建议

**通过(pass)**。三个 commit 严格按计划实施,无范围蔓延;核心逻辑(工具/配置/双点注册/开关门/重建机制/路由/前端)正确;安全性(key 不回传、守卫先行、错误脱敏)与既有纪律一致;48+8 个新增用例覆盖全部关键分支;3 处偏差均合理且有正当理由。问题 1、2 为前端交互细节,建议随后续迭代修复,不阻塞本次合入;问题 3 为外部依赖(需用户 key),按遗留事项跟踪。
