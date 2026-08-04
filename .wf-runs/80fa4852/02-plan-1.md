# 实施计划:子代理联网调研 GitHub 仓库并挑选/下载 DESIGN.md(awesome-design-md)

> 依据探索报告 `.wf-runs/80fa4852/01-exploration-1.md`(本计划为其产物,同 run)。
> 目标场景:用户不想手动去 GitHub 拉取 awesome-design-md(https://github.com/VoltAgent/awesome-design-md)的 DESIGN.md,希望工作台 AI 自动:①查看仓库全部设计 → ②结合当前项目挑选 1 个或多个 → ③经 wait_for_approval 闸门与用户确认 → ④确认后把选中的 DESIGN.md 落到工作区。

---

## 0. 目标与范围

### 做什么
1. 新增**通用网络抓取工具** `fetch-url`(只读,GET 任意 http(s) URL,支持字节偏移分段、输出上限),注册进**子代理工具集**(`subAgent.ts buildSubAgentTools`),让 explorer/planner/executor/reviewer 都能直接抓取 GitHub raw 文件与 GitHub API 内容。
2. 新增**直接落盘工具** `download-url`(可写,受 write 白名单约束),让 executor 能把选中的 DESIGN.md 以"流式落盘"方式下载到工作区,**不经过 LLM 上下文**(规避 50KB 截断与 token 开销)。
3. 更新 3 个内置代理提示词(`explorer.md` / `executor.md` / `orchestrator.md`),让编排者与子代理知道"外部设计调研 → 推荐清单 → 闸门确认 → 下载落盘"的完整流程与抓取手法。
4. 补充单测与文档(`docs/dag-workflow.md`),并给出端到端手动验证方案。

### 不做什么(边界)
- **不改前端**:闸门 UI(ChatPane 批准/驳回)、SSE 事件、DAG 图全部复用,零改动。
- **不改 shared 包 / 不改任何共享类型**:无新事件、无新状态,避免"shared 需先 build"的构建顺序问题。
- **不改 piService.ts / runManager.ts / agentDefs.ts / config.ts / routes.ts**:主代理工具集保持现状(只调度不亲自抓取);不新增配置端点。
- **不开放 git clone / bash 给子代理**:子代理仍无 bash;下载统一走 `download-url`(受白名单约束),不依赖"bash 未显式禁止 curl"的隐式通道。
- **不新增 agent 角色**(design-picker 代理仅作为备选方案 B,见 §5):复用 explorer → planner → executor 现有角色与产物命名,零 ROLE_ARTIFACT / 白名单改动。
- **不实现 SSRF 硬防护、不做私有 IP 黑名单**:与 workspaceGuard"护栏而非安全边界"哲学一致,仅在工具描述中提示(工具运行在用户本机、以用户网络身份访问,信任级别与主代理 bash 相同)。可作后续加固项。

### 方案选型(网络能力给子代理的最佳方式)
| 方案 | 说明 | 取舍 |
| --- | --- | --- |
| **A(采用):新增 `fetch-url` + `download-url` 专用工具** | 仿 `anySearchTools.ts` 模式(Node fetch + AbortSignal + 截断);`fetch-url` 只读浏览,`download-url` 受 write 白名单约束直接落盘 | ✅ 精确按需抓取、天然受工作区边界约束、不污染用户工作区;✅ 只改 1 个注册点(`buildSubAgentTools`),避开"主代理/子代理/buildSubAgentTools 三处同步"风险;✅ 可单测(mock fetch) |
| B:给子代理开放 bash(git clone / curl) | executor 已有 bash 且守卫未拦 git/curl | ❌ 需克隆整个仓库(70+ 站点)到用户工作区,污染大;❌ 只读工作区与 explorer/planner/reviewer 无 bash,能力不均;❌ 依赖隐式放行,不可控 |
| C:给子代理开放 anysearch-search | 已有工具,注册 1 行即可 | 搜索返回的是网页摘要,拿不到仓库内文件的**精确原始内容**,无法满足"查看该仓库所有设计"的精确需求;可作为 fetch-url 的补充(后续可选) |

结论:方案 A。`fetch-url` 负责"看"(浏览 README / git trees API / DESIGN.md 正文,可分页),`download-url` 负责"落盘"(确认后把选中的文件直接写进工作区)。

---

## 1. 交互流程设计(端到端)

```
用户:「调研 awesome-design-md,为我的项目挑选合适的设计系统,列出推荐等我确认,确认后下载 DESIGN.md」
  │
  ▼ orchestrator(读 orchestrator.md 新调度条目,判为复杂需求)
explorer(带网络工具 fetch-url)
  ├─ fetch-url raw.githubusercontent.com/VoltAgent/awesome-design-md/main/README.md   → 全量设计清单
  ├─ fetch-url api.github.com/repos/VoltAgent/awesome-design-md/git/trees/main?recursive=1  → 精确文件树(1 次 API 调用)
  ├─ fff-find/read 阅读用户当前项目(技术栈/风格/需求)确定匹配标准
  ├─ fetch-url raw.githubusercontent.com/.../<site>/DESIGN.md(候选,大文件用 max_bytes+offset 分段)
  └─ 写 01-exploration-*.md:候选清单(来源 URL/规模/要点/匹配度评分与理由)+ 推荐 Top N
  │
  ▼ planner
  └─ 读探索报告 → 写 02-plan-*.md:选中的设计、落盘路径(默认 .wf-runs/<runId>/designs/<site>/DESIGN.md)、
     下载步骤(fetch-url 预览 → download-url 落盘 → 校验)、风险、验收标准
  │
  ▼ orchestrator → wait_for_approval(summary = 推荐清单 + 落盘路径 + 步骤摘要)
  │   → run 置 awaiting_approval,发 gate_required,回合结束
  │
  ▼ 用户:【批准】或【驳回+意见】(如「只保留 A、C,不要 B」;ChatPane 现有按钮,零改动)
  │   批准 → 用户发消息「用户已批准计划,继续执行」续跑(现有机制)
  │   驳回 → 回 planner 重做(现有机制,上限 2 次),新推荐清单再走闸门
  │
  ▼ executor(带 fetch-url + download-url)
  ├─ 读 02-plan-*.md
  ├─ 对每个选中设计:download-url(https://raw.githubusercontent.com/VoltAgent/awesome-design-md/<branch>/<site>/DESIGN.md
  │     → .wf-runs/<runId>/designs/<site>/DESIGN.md)(无需回显内容进上下文)
  ├─ 校验:文件存在、字节数符合预期、可读
  └─ 写 03-execution-*.md
  │
  ▼ reviewer(可选,复杂时):校验文件完整性 → 04-review-*.md(pass/fail)
  ▼ orchestrator → complete_task(交付总结:下载了哪些、路径、来源 URL)→ run 置 done
```

产物落盘:`<workspace>/.wf-runs/<runId>/` 下 `01-exploration-*.md`、`02-plan-*.md`、`03-execution-*.md`、`04-review-*.md`(现有命名机制,零改动)+ 新增 `designs/<site>/DESIGN.md`(download-url 产物,不占角色序号)。

**下载目标位置约定**:默认 `.wf-runs/<runId>/designs/<site>/DESIGN.md`(黑板目录,只读/读写工作区均可写,git 可追踪);若用户希望放项目根(如 `docs/designs/`),在闸门讨论时说明,executor 按计划落盘(仅读写工作区可行)。

---

## 2. 分阶段实施计划

### 阶段 1:fetch-url 工具(子代理"能看 GitHub")

**目标**:子代理可抓取任意 http(s) URL,支持分段与输出上限;单测覆盖;不引入任何行为回归。

**文件清单与改动**:

1. **新增 `apps/api/src/pi/httpFetch.ts`**(公共 HTTP 辅助,供 fetch-url / download-url 共用;`anySearchTools.ts` 保持不动,零回归):
   - `isHttpUrl(url)`:仅允许 `http://` / `https://`(拒绝 `file://`、`ftp://` 等)。
   - `fetchWithTimeout(url, opts)`:Node 原生 fetch + `AbortSignal.any([AbortSignal.timeout(30_000), signal])`;`redirect: 'follow'`(raw.githubusercontent.com 会 302 到 objects.githubusercontent.com);`User-Agent: workflows-agent` 头;若 `process.env.GITHUB_TOKEN` 存在则加 `Authorization: Bearer <token>`(env-only,不进 config.json;未认证 GitHub API 限流 60 次/小时,设 token 提升到 5000 次/小时);超时/中止语义与 anySearchTools 一致(用户中止透传 `Operation aborted`,超时报"请求超时(30000ms)" )。
   - `mapHttpError(status)`:404 → "404 Not Found:检查 URL / 分支名 / 路径";403 → "GitHub API 限流或禁止访问(未认证 60 次/小时),建议改用 raw.githubusercontent.com 或设置 GITHUB_TOKEN";429 → "请求过于频繁,请稍后重试";5xx → "服务端错误";其余 → 通用文案。
   - `truncateBytes(text, limitBytes)`:与 anySearchTools 的 `truncateOutput` 相同实现(按字节二分截断 + 代理对保护 + `[N bytes limit reached]` 标记),从 anySearchTools 复制(刻意不重构原文件)。

2. **新增 `apps/api/src/pi/fetchUrlTools.ts`**:
   - 工具名 `fetch-url`(kebab-case,与 anysearch-search 一致);工厂 `createFetchUrlTools(opts?)` 返回 `[tool]`(opts 支持 `fetchImpl` / `timeoutMs` 测试注入,仿 anySearchTools)。
   - 参数 schema(TypeBox,与 anySearchTools 同风格):
     ```ts
     const fetchSchema = Type.Object({
       url: Type.String({ description: '要抓取的 http(s) URL(如 GitHub raw 文件、GitHub API、任意网页)' }),
       max_bytes: Type.Optional(Type.Number({
         description: '输出上限(字节),默认 50000,最大 200000(目录清单/API JSON 可调大)', minimum: 1024, maximum: 200000 })),
       offset: Type.Optional(Type.Number({
         description: '字节偏移,配合分段抓取大文件(发 Range: bytes=<offset>-);默认 0', minimum: 0 })),
     })
     ```
   - execute 逻辑:
     - 校验 `isHttpUrl` + `offset >= 0`;预置 aborted signal 直接抛 `Operation aborted`。
     - `offset > 0` 时发 `Range: bytes=<offset>-` 头;若服务器忽略 Range 返回 200 全量,客户端按 offset 自行切片(保证分段语义)。
     - 读取完整 body → 按 offset 切片 → `truncateBytes(text, max_bytes)`。
     - 返回文本:`已获取 <finalUrl>(<实际字节数> 字节):\n\n<content>`(finalUrl 让模型知道重定向后的真实来源);截断时附标记提示"可用 offset 继续分段读取"。
     - 非 2xx → `mapHttpError` 转可读错误;所有异常落为 `fetch-url 错误:<可读文案>`(abort 除外)。
   - 描述文本要点:适用"工作区之外的外部内容,尤其 GitHub 仓库的 raw 文件与 API";**优先 raw.githubusercontent.com(不限流),少用 api.github.com(未认证 60 次/小时)**;大文件用 max_bytes + offset 分段;结果来自外部,可信度自行判断。

3. **编辑 `apps/api/src/pi/subAgent.ts`**(唯一注册点):
   - 顶部 import:`createFetchUrlTools` from `./fetchUrlTools.js`。
   - `buildSubAgentTools` 中,在 fff 工具之后追加:
     ```ts
     // 网络抓取工具:只读、无 path 参数,不需 guardPathTool;所有子代理可用
     tools.push(...createFetchUrlTools())
     ...
     const activeNames = ['read', 'ls', ...tools.filter((t) => t.name.startsWith('fff-')).map((t) => t.name), 'fetch-url']
     ```
     (注意:SDK 的 `tools`(allowedToolNames)会过滤 customTools,`fetch-url` 必须列入 activeNames,否则不可用——这是本项目"工具注册两处同步"(tools 数组 + activeNames)的关键点,新增测试断言覆盖。)

4. **新增 `apps/api/src/pi/fetchUrlTools.test.ts`**(仿 anySearchTools.test.ts,mock fetch):
   - GET 方法 + URL 透传 + UA 头;无 GITHUB_TOKEN 不带 Authorization,stubEnv 后有 Bearer。
   - `offset` → 发 `Range: bytes=<offset>-`;服务器忽略 Range 返回 200 时客户端自行切片。
   - 截断:超 max_bytes 输出 ≤ 上限 + 标记;中文多字节无乱码;`max_bytes` 参数生效(如 1024)。
   - 错误映射:404 / 403(含限流文案)/ 429 / 5xx / 网络异常。
   - 超时(AbortSignal.timeout)与用户中止(透传 Operation aborted)。
   - 参数校验:非 http(s) URL(ftp://、file://)拒绝;offset 负数拒绝。

5. **编辑 `apps/api/src/pi/subAgent.test.ts`**:新增断言——任意子代理(explorer/executor 等)`buildSubAgentTools` 返回的 activeNames 含 `fetch-url`,tools 中含名为 `fetch-url` 的工具。

**验证方式**:
- `pnpm --filter @workflows/api test`(新测试全绿,旧测试零回归);`pnpm --filter @workflows/api typecheck`、`lint`。
- 手动冒烟:`pnpm dev`,对任意工作区发消息「用 fetch-url 抓取 https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/README.md 并总结有哪些设计」→ 模态窗可见子代理 fetch-url 调用与结果,主代理能汇报清单。

---

### 阶段 2:download-url 工具(子代理"能落盘")

**目标**:executor 能把选中的 DESIGN.md 直接下载到工作区,内容不进 LLM 上下文,受 write 白名单与工作区边界约束。

**文件清单与改动**:

1. **新增 `apps/api/src/pi/downloadUrlTools.ts`**:
   - 工具名 `download-url`;工厂 `createDownloadUrlTool(opts: { workspace: Workspace; matcher: WriteMatcher | undefined; fetchImpl?: typeof fetch; timeoutMs?: number })`(matcher 由调用方从 `definition.frontmatter.write` 编译传入,与 `guardWriteTool` 同一套)。
   - 参数 schema:
     ```ts
     const downloadSchema = Type.Object({
       url: Type.String({ description: '要下载的 http(s) URL(建议 raw.githubusercontent.com)' }),
       path: Type.String({ description: '落盘路径(相对工作区根),如 .wf-runs/<runId>/designs/linear/DESIGN.md' }),
       overwrite: Type.Optional(Type.Boolean({ description: '目标已存在时是否覆盖,默认 false' })),
       max_bytes: Type.Optional(Type.Number({
         description: '下载大小上限(字节),默认 1_000_000,最大 5_000_000', minimum: 1024, maximum: 5_000_000 })),
     })
     ```
   - execute 逻辑:
     - 校验 `isHttpUrl`;解析目标路径:`path.resolve(workspacePath, rawPath)` 后 `path.relative` 归一化;绝对路径 / `..` 逃逸 / 白名单未命中 → 抛与 `guardWriteTool` 同风格的"写权限拦截"错误(含白名单原文)。
     - `existsSync(target) && !overwrite` → 抛"目标已存在,如需覆盖请传 overwrite=true"。
     - fetch(30s 超时 + abort 透传,复用 httpFetch);先读 `content-length` 头,若 > max_bytes 直接抛"超过 max_bytes 上限,可调大重试";再读 body,实际字节 > max_bytes 同样抛错(硬上限,不静默截断)。
     - `mkdirSync(path.dirname(target), { recursive: true })` + `writeFileSync(target, buffer)`。
     - 返回文本(不含正文内容,保护上下文):`已保存 <byteLen> 字节到 <relPath>(来源:<finalUrl>)`。
   - 描述文本要点:"把外部文件直接下载到工作区(内容不进入对话)。path 必须命中当前代理的 write 白名单;文件较大时调大 max_bytes"。

2. **编辑 `apps/api/src/pi/subAgent.ts`**:
   - import `createDownloadUrlTool`;在现有两个写分支内追加(与 write 工具同条件,保持权限一致):
     ```ts
     if (fullWrite) {
       ...
       tools.push(toToolDefinition(createBashTool(...)))
       tools.push(createDownloadUrlTool({ workspace, matcher }))
       activeNames.push('bash', 'edit', 'write', 'download-url')
     } else if (matcher && matcher.patterns.length > 0) {
       ...
       tools.push(guardWriteTool(...))
       tools.push(createDownloadUrlTool({ workspace, matcher }))
       activeNames.push('write', 'download-url')
     }
     ```
     - executor(读写)`**` → download-url 可写任意白名单内路径;executor(只读工作区)matcher 为 `**`(恒 true)→ 同样可写(与现有 write 工具行为一致,`.wf-runs` 落盘不受影响);explorer/planner/reviewer(matcher 仅限自身产物)→ download-url 存在但非白名单路径一律拦截(正确降级)。
     - 纯只读代理(无 write 字段)不加 download-url。

3. **新增 `apps/api/src/pi/downloadUrlTools.test.ts`**:
   - 成功:写入工作区相对路径、自动建父目录、返回路径与字节数、不回显内容。
   - 白名单:matcher 允许 `.wf-runs/*/designs/**` → 命中放行;未命中 → "写权限拦截";`../` 逃逸与绝对路径 → 拒绝。
   - overwrite:已存在且 false → 错误;true → 覆盖成功。
   - 上限:content-length > max_bytes 提前拒绝;body 实际超限拒绝;不静默截断。
   - 超时 / abort / 非 2xx 错误映射。

4. **编辑 `apps/api/src/pi/subAgent.test.ts`**:断言 executor 的 activeNames 含 `download-url`;explorer(matcher 存在)也含;纯只读代理(无 write)不含;tools 中工具存在。

**验证方式**:同上——`pnpm --filter @workflows/api test` / typecheck / lint;手动冒烟可在 dev 下让 executor 直接 `download-url` 一个 raw 文件到 `.wf-runs/` 临时目录验证落盘。

---

### 阶段 3:代理提示词与文档(让流程被"编排出来")

**目标**:orchestrator 遇到此类需求知道怎么调度,explorer/executor 知道抓取手法与报告要求。全部是 md 文本改动,零代码。

**文件清单与改动**(均为追加小节,不改动现有行为约束):

1. **编辑 `apps/api/src/pi/agents/explorer.md`** — 追加"外部资源调研(GitHub 仓库等)"小节:
   ```markdown
   ## 外部资源调研(GitHub 仓库等)
   工具:fetch-url(抓取任意 http(s) URL,支持 max_bytes / offset 分段)。
   推荐顺序:
   1. 用 raw.githubusercontent.com 抓 README(如 https://raw.githubusercontent.com/<owner>/<repo>/main/README.md),先拿全量清单;
      分支不确定时先抓 main,404 再试 master
   2. 需要精确文件树时用 api.github.com 的 git trees API 一次调用拿全部路径
      (如 /repos/<owner>/<repo>/git/trees/main?recursive=1);注意未认证限流 60 次/小时,优先 raw、少用 API
   3. 候选文件用 raw 抓正文;超过 50KB 用 max_bytes + offset 分段读完
   4. 结合用户当前项目(fff-find / read)确定匹配标准并评估
   报告要求:每个候选给出 来源 URL / 规模(字节)/ 要点 / 与项目匹配度与理由;最后给出推荐 Top N;
   注明截断未读部分与"内容来自外部网络、可信度自行判断"提示。
   ```

2. **编辑 `apps/api/src/pi/agents/executor.md`** — 追加"下载外部文件到工作区"小节:
   ```markdown
   ## 下载外部文件到工作区
   - 涉及"把外部文件(如 DESIGN.md)落到工作区"时:先按计划用 fetch-url 预览(可选),再用 download-url 直接落盘
   - download-url 的 path 为相对工作区根的路径;默认落 .wf-runs/<runId>/designs/<站点目录>/DESIGN.md
     (runId 与产物目录见任务说明);用户指定了其他位置(如 docs/designs/)时按计划执行
   - 校验:文件存在、字节数与来源一致、可读;文件较大时调大 max_bytes 重试
   ```

3. **编辑 `apps/api/src/pi/agents/orchestrator.md`** — 在"调度策略"中追加一条(与现有条目并列):
   ```markdown
   - 外部资源挑选类需求(如「调研 awesome-design-md,为我的项目挑选合适的设计系统并下载」):
     explorer(联网调研:抓仓库清单与候选 DESIGN.md,结合用户项目给出候选清单与匹配分析)
     → planner(下载计划:选中的设计、落盘路径、校验方式)
     → wait_for_approval(摘要**必须包含推荐清单与落盘路径**,请用户确认或指出要调整的选择)
     → 批准后 executor(用 download-url 落盘)→ reviewer(校验完整性)→ complete_task
     用户驳回时按意见调整选择(回 planner)
   ```

4. **编辑 `docs/dag-workflow.md`**(权威语义文档,与实现对齐):
   - 在"权限模型 / 子代理工具集"处补充:子代理工具集新增 `fetch-url`(只读网络抓取,所有子代理可用)与 `download-url`(网络下载落盘,**受 write 白名单与工作区边界约束**,与 write 工具同条件注册);注册点 `subAgent.ts buildSubAgentTools`,主代理不注册(只调度不亲自抓取)。
   - 补充一段:外部抓取的限流与截断约定(raw 优先、GitHub API 60 次/小时、GITHUB_TOKEN env 可选、max_bytes/offset 分段)。

**验证方式**:
- `pnpm build` 成功(scripts/copy-agents.mjs 把更新后的 agents/*.md 复制进 dist,生产生效;dev 直接读 src 不受影响)。
- 人工 review md diff:确认只增不改,现有约束(只读调研、严格按计划、不擅自扩大范围)完整保留。

---

### 阶段 4:端到端验证(真实场景)

**目标**:完整跑通"查看 → 挑选 → 闸门确认 → 下载落盘"。

**验证步骤**:
1. `pnpm build && pnpm dev`(或直接 `pnpm dev`),把本仓库添加为工作区(读写)。
2. 发消息:「调研 https://github.com/VoltAgent/awesome-design-md 的全部设计,结合本项目(Vue 3 + Hono + TypeScript 的 Web Agent 工作台)挑选 3 个最合适的设计系统,列出推荐理由,等我确认后把 DESIGN.md 下载到工作区」。
3. 观察并核对:
   - explorer 模态窗出现多次 `fetch-url` 调用(README → trees API → 候选 DESIGN.md),产物 `01-exploration-1.md` 含候选清单(来源 URL/规模/匹配度/推荐 Top 3)。
   - planner 产物 `02-plan-1.md` 含"选中的设计 + 落盘路径(.wf-runs/<runId>/designs/...)"。
   - 前端出现闸门按钮(gate_required),摘要含推荐清单;DagPanel 显示 ⏸ 闸门节点。
   - 点【批准】→ executor 出现 `download-url` 调用 → `.wf-runs/<runId>/designs/<site>/DESIGN.md` 真实落盘且字节数 > 0;`03-execution-1.md` 记录校验结果。
   - reviewer(如走)→ `04-review-1.md` pass;最终 complete_task;`run.json` status 经历 planning → awaiting_approval → executing → (reviewing) → done。
4. **驳回分支**:再跑一次,点【驳回】输入「只保留前两个」→ 观察回 planner 重做、闸门再次弹出、最终只下载 2 个。
5. **只读工作区分支**:把工作区切为只读再跑 → 探索/计划/闸门/下载到 `.wf-runs/<runId>/designs/` 全流程仍可完成(下载产物不受只读限制)。
6. **限流分支(可选)**:临时把 `GITHUB_TOKEN` 设为空、只走 api.github.com 重复触发,验证 403 文案提示改用 raw 后流程可继续。

**验收标准(逐条核对清单)**:
- [ ] 阶段 1:fetchUrlTools.test.ts 全绿;subAgent.test.ts 断言 fetch-url 在全部子代理 activeNames;typecheck/lint 通过;旧测试零回归。
- [ ] 阶段 2:downloadUrlTools.test.ts 全绿(落盘/白名单/逃逸/覆盖/上限/超时);subAgent.test.ts 断言 download-url 仅在有写能力的子代理出现。
- [ ] 阶段 3:`pnpm build` 成功;dist/pi/agents/*.md 含新小节;docs/dag-workflow.md 已补充网络工具说明。
- [ ] 阶段 4:上述 5 个端到端场景全部通过;产物文件与 run.json 状态机符合预期。
- [ ] 全程无 shared 类型改动、无前端改动、无 piService/runManager 改动(除 subAgent.ts 注册外)。

---

## 3. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| GitHub API 限流(未认证 60 次/小时) | 探索中断 | 提示词强制"raw 优先、API 最少(树一次调用)";403 错误文案指导改用 raw 或设 `GITHUB_TOKEN`(env,5000 次/小时);工具返回可读错误,agent 可降级继续 |
| DESIGN.md 超过 50KB 被截断 | 分析不完整 | fetch-url 支持 `max_bytes`(≤200KB)+ `offset` 分段;download-url 直接落盘(默认 1MB/最大 5MB,内容不进上下文),从根上规避截断 |
| 工具注册不同步(漏 activeNames) | 工具不可见/不可用 | 只改一个注册点(`buildSubAgentTools`);单测断言 activeNames 含新工具名(SDK allowedToolNames 过滤 customTools 的机制已写入测试) |
| 子代理联网 = 行为变更 | 上下文污染 / 输出可信度 | 输出硬截断 + 截断标记;工具描述与 explorer.md 提示"外部内容可信度自行判断";download-url 不回显正文 |
| download-url 越权写 | 破坏工作区 | 复用 `isWriteAllowed` + 工作区边界检查,与 write 工具同条件注册、同文案报错;单测覆盖逃逸/白名单 |
| md 改动后生产未重建 | 生产行为不变 | 阶段 3 明确 `pnpm build`(copy-agents.mjs);dev 直接读 src 不受影响 |
| GITHUB_TOKEN 泄入日志/上下文 | 密钥泄露 | 仅 env 读取、只进 Authorization 头,绝不写入返回文本/错误文案(与 anysearch key 同策略);单测断言响应不含 token |

**回滚方案**:全部改动为**增量**(2 个新工具文件 + 2 个新测试文件 + `subAgent.ts` 一处注册 diff + 3 个 md 追加 + 1 个文档追加),无类型/结构变更;回滚 = 删除新文件 + `git checkout` 上述既有文件即可。阶段 1/2 可独立回滚(阶段 3 的 md 提示词引用了工具,建议同批次回滚)。`pnpm build` 产物随源码重建。

---

## 4. 备选方案 B(不采用,记录备查)

若未来希望"选择清单"作为**独立产物**(如 `05-selection-*.md`,与探索报告分离、闸门直接引用),可新增 `design-picker` 代理:
- 新增 `apps/api/src/pi/agents/design-picker.md`(frontmatter:`name: design-picker`、`write: [".wf-runs/*/05-selection-*.md"]`、正文含上述 explorer 外部调研指引 + 选择报告格式);
- `orchestrator.md` frontmatter `agents` 追加 `design-picker` + 调度条目;
- `subAgent.ts` `ROLE_ARTIFACT` 追加 `design-picker: '05-selection.md'`(否则产物命名走自定义代理白名单推导,也能工作但容错弱)。
成本:3 处改动;收益:选择清单独立成档、闸门 planFile 语义更清晰。**当前需求下探索报告已承载候选清单,方案 A 足够,故不采用。**
