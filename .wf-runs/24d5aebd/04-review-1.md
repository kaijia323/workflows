# 代码审查报告:AnySearch 网络搜索工具 + 前端 API key 设置弹窗

> 审查对象:`.wf-runs/24d5aebd/02-plan-2.md`(修订版计划)+ `03-execution-1.md`(后端)+ `03-execution-2.md`(前端)+ 全部 12 个改动文件实读。
> 审查方式:静态逐文件核对(本环境无 shell,typecheck/lint/test 的"全绿"结论以两份执行报告为准,静态审查未发现类型/风格问题)。

## 结论:pass

后端工具实现、注册链路、配置/路由、shared 类型、前端四件套与测试均符合计划与已实测 API 契约;安全红线(key 不进返回文本/日志/错误、前端不落存储、只回显布尔)全部守住。发现 1 个中危健壮性问题(50KB 截断按 UTF-16 code unit 而非字节,多字节内容可到 ~153KB)与若干低危建议,不阻塞合入,建议后续修复。

---

## 一、逐条核对(按计划验收标准 1-17)

| # | 计划项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | anySearchTools.ts 导出工厂/工具/ANYSEARCH_DOMAINS(17),无新依赖 | ✅ 通过 | `apps/api/src/pi/anySearchTools.ts` L20-31 恰 17 个 domain;仅依赖已有 typebox/pi-coding-agent |
| 2 | 工具恰 1 个 `anysearch-search`;schema 全参数与 API 一致 | ✅ 通过 | L59-97:query 必填、max_results 1-20 默认 10、tag/zone(cn\|intl)/language/params/format(json\|markdown) |
| 3 | execute 调 POST /v1/search;AbortSignal.any(30s+用户 signal);分层错误映射;50KB 截断;query 空校验 | ⚠️ 基本通过 | 端点/超时/错误映射/空校验均正确;**50KB 截断为 code-unit 切片,多字节内容实际可达 ~153KB**(见问题 1) |
| 4 | key 解析 env 优先→getApiKey→匿名;无 key 不带 Authorization;key 不出现在描述/日志/错误 | ✅ 通过 | `resolveApiKey` L93-97;错误文案全脱敏;verify 脚本不打印 key |
| 5 | 描述含何时用/全参数/17 domain/general.general/匿名与 key 配置/可信度提示;promptSnippet 英文一行 | ✅ 通过 | L311-325 |
| 6 | piService:customTools 与 tools 白名单两分支同步注册;getApiKey 注入 loadConfig | ✅ 通过 | `piService.ts` L253-270:guardedTools 两分支均含 `...webTools`,activeTools 两分支均含 `...webToolNames`;L311 customTools=[...guardedTools,...],L313 tools=[...activeTools,...] |
| 7 | setAnySearchApiKey 存在;getConfig 只回 hasAnySearchApiKey 布尔 | ✅ 通过 | `piService.ts` L139-141、L152 |
| 8 | config.ts:StoredConfig.anySearchApiKey? + set/has helper;旧配置兼容 | ✅ 通过 | `config.ts` L27-28、L117-128;readJson 宽松读取,旧 config.json 无字段正常 |
| 9 | routes.ts:PUT /api/agent/config/anysearch-key | ✅ 通过(偏离) | `routes.ts` L40-45;空串=清空而非计划的 400(见问题 4,文档化偏离,前后端一致) |
| 10 | PipelineHeader ⚙ + App.vue 绑定 | ✅ 通过 | `PipelineHeader.vue` L15 defineEmits、L104-110 按钮;`App.vue` L35 `@open-settings="showSettings = true"`,L64-70 模态窗 v-if |
| 11 | ApiKeyModal 双 section 独立交互 | ✅ 通过 | DeepSeek 段原样保留;AnySearch 段(password+autocomplete off、独立保存/状态点/错误提示、env 优先与不返回前端文案)L71-175 |
| 12 | useAgent:saveAnySearchApiKey + hasAnySearchApiKey | ✅ 通过 | `useAgent.ts` L171、L200-207、return L701/L706;路径与后端路由一致 |
| 13 | 单测 ≥8 用例 | ✅ 通过 | `anySearchTools.test.ts` 实读 28 例(9 行 it.each + 3 行业务错误 it.each 展开),覆盖请求构造/key 三态/渲染/截断/8 种 HTTP 映射/业务错误/非 JSON/结构异常/网络异常/abort×2/超时/空 query/常量 |
| 14 | typecheck/lint/test 全绿 | ✅ 通过(依赖报告) | 执行报告:api 152/152、web 15/15、lint 0 error;静态核对无类型问题 |
| 15 | verify 脚本真实调用 | ✅ 通过 | `verify-anysearch.mjs` 逻辑正确;报告实测 code=0、results=3、2506ms、首条 title/url 正常 |
| 16 | web build | ✅ 通过(依赖报告) | 报告 built in 1.24s |
| 17 | 改动面仅计划内文件 | ✅ 通过 | 实读全部 12 个文件,无意外改动;shared dist/index.d.ts 已含 hasAnySearchApiKey(构建产物已更新) |

## 二、重点核查项结论

1. **API 契约符合性** ✅:端点/字段/默认值/响应解析(data.results/data.metadata)/错误映射(HTTP 状态 + code!=0 + message)全部与实测契约一致;undefined 字段剔除不发送(`anySearchTools.ts` L155-163)。
2. **安全红线** ✅:key 仅进 `Authorization` 头(L150-151);错误文案脱敏(401/403「API key 无效或未授权」、402「额度已用完」等,不含 key);400 仅透出 API message(可能含用户 query/tag,不含 key);`getConfig()`/PUT 路由响应均无 key 明文;前端无 localStorage/sessionStorage(全 src grep 零命中);输入框 password + autocomplete off;verify 脚本不打印 key。
3. **健壮性** ⚠️:30s 超时 + AbortSignal.any 透传正确(Node engines `>=20.19.0` 已确认支持);AbortError/TimeoutError 区分;非 JSON/结构异常/网络异常全防御;429/402 限流提示到位。**唯一缺口:50KB 截断按 code unit 切(问题 1)**。
4. **注册链路** ✅:customTools/tools 只读与非只读两分支同步;`anysearch-search` 在 SDK allowedToolNames 过滤下可见;与 fff-find/fff-grep 同模式。
5. **前端链路** ✅:⚙ 按钮 → emit('open-settings') → App.vue showSettings=true → ApiKeyModal;AnySearch section 独立保存/清空/状态点/错误提示;saveAnySearchApiKey PUT 路径与后端路由完全匹配。
6. **测试质量** ✅:28 用例覆盖计划 Step 7 全部 11 项(超量);verify 脚本真实匿名调用有效(报告实测成功)。
7. **回归与一致性** ✅:改动全为纯追加;命名 kebab-case、工厂模式、错误处理、截断提示均与 fffTools 一致;shared dist 已含新字段;前后端 AgentConfig 类型契约一致。

---

## 三、问题清单(按严重程度排序)

### [中] 1. 50KB 截断按 UTF-16 code unit 切片,多字节内容实际输出可超 50KB 约 3 倍
- **位置**:`apps/api/src/pi/anySearchTools.ts` L258-262 `truncateOutput`
- **问题**:判定用 `Buffer.byteLength(text)`(字节),但截断用 `text.slice(0, MAX_OUTPUT_BYTES)`(UTF-16 code unit)。全中文内容 1 code unit ≈ 3 字节,最坏输出 ≈ 51200×3 = 153KB,与"50KB 字节截断保护上下文"的目标(计划 §7 风险 4)不符。测试仅用 ASCII('x'.repeat)故未暴露;AnySearch 检索内容(尤其中文文档)常见多字节。
- **影响**:上下文膨胀至预期的 ~3 倍(有界 ~153KB,非灾难,但违背设计意图)。
- **修复建议**:按字节安全截断,例如:`while (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) text = text.slice(0, Math.floor(text.length * MAX_OUTPUT_BYTES / Buffer.byteLength(text)))`,再追加提示;测试补充中文超长 content 用例(断言 `Buffer.byteLength <= 50*1024+64`)。

### [低] 2. format 未显式发送,工具"默认 markdown"与 API 默认可能不一致
- **位置**:`anySearchTools.ts` L155-163(body 构建)与 L269(`params.format ?? 'markdown'`)
- **问题**:模型未传 format 时 body 不含 format 字段,API 按其自身默认(契约未声明默认)返回;工具渲染却按 markdown 假设 content 为 Markdown 文本。若 API 默认为 json,content 为纯文本,渲染仍原样透出(视觉影响小,不破坏功能)。
- **修复建议**:执行期恒发送 `format: params.format ?? 'markdown'`,使描述、渲染与 API 行为三方一致。

### [低] 3. hasAnySearchApiKey 布尔不反映 env ANYSEARCH_API_KEY
- **位置**:`config.ts` L125-128;`packages/shared/src/index.ts` L68 注释
- **问题**:仅配置 env 时工具实际可用(env 优先),但 `getConfig().hasAnySearchApiKey` 为 false,前端状态点显示「未配置(匿名可用)」。属计划 §7 风险 7 的**文档化取舍**(模态窗文案已明示「环境变量优先于此处配置」),但 shared 类型注释「env ANYSEARCH_API_KEY 优先于配置文件」易被误读为布尔也反映 env。
- **修复建议**:不改行为;可将 shared 注释改为「布尔仅反映配置文件,env 优先且不回显」,避免歧义。

### [低] 4. 路由空串=清空与计划 Step 5 的 400 语义偏离(文档化)
- **位置**:`apps/api/src/agent/routes.ts` L40-45
- **问题**:计划写「空 key 返回 400」,实现改为「空串/缺失=清空」。执行报告说明系任务要求(空串清空),且前端按钮空输入可提交、文案「输入为空保存将清空已配置的 key」,前后端语义自洽,不构成缺陷。
- **修复建议**:无需修复;仅记录偏离。

### [低] 5. max_results 越界无执行期防御
- **位置**:`anySearchTools.ts` L62-69(schema 仅声明 minimum/maximum)
- **问题**:若 SDK 不做 TypeBox 运行时校验,越界值(如 0/99)直发 API 得 400 → 映射为可读错误(已有兜底,计划亦明确「非法 tag 由 API 400 映射」)。可选加固:execute 内 clamp 1-20。
- **修复建议**:可选;不阻塞。

### [提示] 6. 其他观察(无需处理)
- `useAgent.ts` L209 后存在多余空行(双空行,cosmetic,lint 已过)。
- AnySearch 段清空 key 后成功提示仍为「已保存到后端配置」,状态点随即变「未配置(匿名可用)」,语义可接受。
- `mapHttpError(400)` 透出 API message 可能含用户 query/tag(非 key),属计划要求(帮助修正 tag),可接受。

---

## 四、最终建议

**通过**(可合入)。核心功能、契约符合性、注册链路、安全红线、测试覆盖全部达标;中危截断问题有界(~153KB)不阻塞,建议作为后续小修(问题 1、2)尽快处理。如需严格执行"50KB 字节截断"目标,可在合入前先修问题 1。
