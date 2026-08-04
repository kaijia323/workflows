# 执行报告:AnySearch 搜索工具(后端部分)

> 依据:`.wf-runs/24d5aebd/02-plan-2.md`(修订版实施计划)+ 任务说明(后端范围,前端由后续批次负责)。
> 结论:后端全部完成,验证全部通过(shared build / api typecheck / api lint / api test 152 通过 / 真实匿名调用成功)。

## 1. 改动文件清单

| # | 文件 | 操作 | 改动内容 | 原因 |
| --- | --- | --- | --- | --- |
| 1 | `packages/shared/src/index.ts` | 修改 | `AgentConfig` 增加 `hasAnySearchApiKey: boolean`(含注释:env 优先于配置文件) | 前端/后端配置回显只出布尔,不出 key 明文 |
| 2 | `apps/api/src/config.ts` | 修改 | `StoredConfig` 增加可选 `anySearchApiKey?: string`;新增 `setAnySearchApiKey(store, key)`(空串由 saveConfig 删除语义清空)与 `hasAnySearchApiKey(store)` | 配置持久化层,与现有 apiKey 同模式 |
| 3 | `apps/api/src/pi/anySearchTools.ts` | 新建 | 核心工具文件:导出 `ANYSEARCH_DOMAINS`(17 个 domain 常量)、`createAnySearchTools(options?)` 工厂、`createAnySearchSearchTool`;1 个工具 `anysearch-search`(kebab-case) | 网络搜索工具,REST `POST https://api.anysearch.com/v1/search` |
| 4 | `apps/api/src/pi/piService.ts` | 修改 | import `createAnySearchTools` + config 的 `hasAnySearchApiKey/setAnySearchApiKey`;新增 `setAnySearchApiKey(key)` 方法;`getConfig()` 回显 `hasAnySearchApiKey`;`openSession` 中构建 `webTools`(注入 `getApiKey: () => loadConfig(this.store).anySearchApiKey`),`guardedTools` 只读/非只读两分支追加 `...webTools`,`activeTools` 两分支追加 `...webToolNames` | customTools 与 tools 白名单同步注册(SDK allowedToolNames 过滤机制) |
| 5 | `apps/api/src/agent/routes.ts` | 修改 | 新增 `PUT /api/agent/config/anysearch-key`:body 解析(非字符串视为空)、`pi.setAnySearchApiKey(key)`、响应 `{code:0, message:'已保存', data: pi.getConfig()}`(仅回显 `hasAnySearchApiKey` 布尔);**空串=清空**(saveConfig 删除字段) | 前端保存 AnySearch key 的 HTTP 入口;key 明文不出后端 |
| 6 | `apps/api/src/pi/anySearchTools.test.ts` | 新建 | vitest mock fetch,28 个用例(≥8 要求),见下 | 单测 |
| 7 | `apps/api/scripts/verify-anysearch.mjs` | 新建 | 无依赖 Node 脚本:真实匿名调用 `/v1/search` 一次(断言 HTTP 200/code=0/results 非空,打印首条 title/url/content 前 500 字符与耗时);检测到 `ANYSEARCH_API_KEY` 时带 key 再调一次(不打印 key);失败非零退出 | 真实调用验证 |
| 8 | `apps/api/eslint.config.mjs` | 修改 | `scripts/**/*.mjs` globals 增加 `fetch: 'readonly'` | 新 verify 脚本用全局 fetch,否则 lint no-undef(该 config 本就为 Node 脚本声明 globals) |

### 工具实现要点(anySearchTools.ts)
- **schema**:`query`(必填 string)/`max_results`(number,1-20 默认 10)/`tag`(string,描述内嵌 17 domain + general.general 引导)/`zone`(cn|intl 枚举)/`language`(string)/`params`(object 透传)/`format`(json|markdown 枚举,默认 markdown),参数名与 API 字段一一对应。
- **execute**:`abortIfSignaled` → query 空校验 → `callSearch`(`AbortSignal.any([AbortSignal.timeout(30s), userSignal])`,Node ≥20.19 原生支持)→ 分层错误映射 → `renderResults` → 50KB 字节截断(`[50KB limit reached]`,与 fff 工具同模式)。
- **错误映射**:HTTP 400(透出 API message,如非法 tag)/401/403/402/415/429(含「限流,请稍后重试或配置 API key 提升额度」)/5xx/其他;HTTP 200 但 `code !== 0`(rate_limit_exceeded/invalid_api_key/quota_exhausted 关键词映射);非 JSON 响应(`响应不是合法 JSON`);`data.results` 缺失(`响应结构异常`);网络异常(`网络请求失败:...`)。全部返回错误文本(不抛),仅用户中止抛 `Operation aborted`(唯一透传)。
- **key 解析**:`env ANYSEARCH_API_KEY` 优先 → `options.getApiKey()`(piService 注入 `loadConfig(store).anySearchApiKey`,动态读取,保存后下次调用即生效)→ 匿名(不带 Authorization 头)。key 只进 Authorization 头,不进描述/日志/错误文本。
- **description**:何时用(工作区外信息,区内用 fff-find/fff-grep/read)、全参数说明、17 domain 列表、general.general 引导、params 透传说明、匿名可用与 key 配置说明、外部内容可信度提示;`promptSnippet` 一行英文 `Search the web (AnySearch, anonymous OK)`。

### 与计划的偏差(均为必要微调,已标注原因)
1. **路由空串语义**:任务说明要求「空字符串视为清空」,故空串/缺失 body 走清空(`setAnySearchApiKey('')` → saveConfig 删除字段),而非计划中的 400 报错。
2. **错误文案前缀**:`mapHttpError/mapBusinessError` 返回不带 `AnySearch 错误:` 前缀的文案,由 `toolError` 统一加一次前缀(避免「AnySearch 错误:AnySearch 请求参数错误」双重前缀)。
3. **lint 修正**:catch 内 throw 补 `{ cause: error }`(项目 `preserve-caught-error` 规则,agentDefs.ts 同模式);eslint.config.mjs 为 scripts 补 `fetch` 全局(见文件 8)。
4. **超时文案**含实际 timeoutMs(便于测试断言稳定)。
5. 计划中可选的 `config.test.ts`/`useAgent.test.ts` 补测未做(后端 config helper 经全量测试间接覆盖;前端测试属后续批次)。

## 2. 自检结果(全部从仓库根执行)

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| shared 构建 | `pnpm --filter @workflows/shared build` | ✅ 通过 |
| API 类型检查 | `pnpm --filter @workflows/api typecheck` | ✅ 通过 |
| API lint | `pnpm --filter @workflows/api lint` | ✅ 通过(修复后) |
| API 单测(新文件) | `vitest run src/pi/anySearchTools.test.ts` | ✅ 28/28 通过 |
| API 全量单测 | `pnpm --filter @workflows/api test` | ✅ 10 文件 152/152 通过(含既有测试,无回归) |
| 真实调用验证 | `node apps/api/scripts/verify-anysearch.mjs` | ✅ code=0,results=3,耗时 2506ms,首条 title=Pi Coding Agent / url=https://pi.dev/docs/latest/sdk;未设 key,跳过 key 路径,退出码 0 |

**测试用例覆盖(28 个,满足 ≥8 要求)**:请求构造(POST+端点+content-type+全参数透传)、未传可选参数仅发 query、key 解析三态(getApiKey→Bearer / env 优先 / 匿名无头)、markdown 与 json 渲染、content 缺失降级、50KB 截断、HTTP 400/401/403/402/415/429/500/503/504 映射、400 透出 API message、业务错误三态映射、非 JSON 响应、结构异常、网络异常、预置 abort、执行中 abort、超时、query 空校验、ANYSEARCH_DOMAINS 数量与内容、工厂返回工具名。

## 3. 未完成项与原因

- **无**(本批次范围内全部完成)。前端链路(PipelineHeader ⚙ / ApiKeyModal / useAgent / App.vue)按任务说明留给后续批次;`subAgent.ts` 子代理工具集未启用搜索(计划明确 v1 不默认启用);batch/extract/get_sub_domains 未实现(计划明确排除)。

## 4. key 安全确认

- key 仅写入 `.workflows/config.json`(gitignored);`getConfig()` 只回 `hasAnySearchApiKey` 布尔;PUT 路由响应不含 key;错误文案脱敏(「API key 无效或未授权」「限流」等,不回显 key);verify 脚本不打印 key;无 localStorage 涉及(前端未动)。
