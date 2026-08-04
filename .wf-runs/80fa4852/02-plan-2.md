# 实施计划 v2:anysearch 下沉子代理 + 内置 design 工具(查/读/下载 DESIGN.md 到当前工作区)

> 依据探索报告 `.wf-runs/80fa4852/01-exploration-1.md`;本计划为 v2,按用户驳回意见重写。
> **与 v1 的关键差异**(用户新方向,必须严格遵守):
> 1. **不新增 fetch-url 给子代理**——子代理联网复用现有 `anysearch-search`;
> 2. **内置 `design` 工具**(单工具、action 子命令),像 `wait_for_approval` 一样注册到**所有代理**(主代理 + 4 个子代理);
> 3. 交互流程:design 工具查/读(仓库清单 + DESIGN.md 内容)→ 闸门/对话与用户确认 → design 工具把选中的 DESIGN.md 下载到**当前打开的工作区**(用户工作目录,不是 `.wf-runs` 产物目录)。

---

## 0. 目标与范围

### 做什么
1. `anysearch-search` 注册进子代理工具集(`subAgent.ts buildSubAgentTools`),explorer/planner/executor/reviewer 均可联网查外部资料。
2. 新增内置 `design` 工具(`apps/api/src/pi/designTools.ts`),封装"查 design"与"下载 design"两个能力:
   - `list`:列出 awesome-design-md 仓库全部设计(站点目录/文件/大小);
   - `read`:读取指定站点的 DESIGN.md(或 preview.html / preview-dark.html)内容;
   - `download`:把选中的 DESIGN.md(+ 同目录 preview 文件)下载到**当前打开的工作区**(默认 `<workspace>/designs/<site>/`,路径经闸门与用户确认)。
   - 工具内部封装 http(拉取 GitHub trees API + raw 文件),**不暴露任何 fetch-url 给 agent**。
3. 注册到所有代理:主代理(`piService.ts openSession`,只读/读写两分支)+ 全部子代理(`subAgent.ts buildSubAgentTools`)。
4. 更新提示词(orchestrator / explorer / planner / executor)与 `docs/dag-workflow.md`,让流程被编排出来。
5. 单测 + 端到端手动验证。

### 不做什么(边界)
- **不新增 fetch-url / download-url 工具**(v1 方案整体废弃);子代理联网只靠 anysearch-search;抓取仓库内容只走 design 工具内部实现。
- **不改前端**:闸门 UI(ChatPane 批准/驳回)、SSE 事件、DAG 图、模态窗全部复用,零改动。
- **不改 shared 包**:无新事件/新状态/新类型(`ToolDefinition` 来自 pi-coding-agent SDK),避免"shared 需先 build"的构建顺序问题。
- **不改 config.ts / routes.ts / runManager.ts / agentDefs.ts**:不新增配置端点;frontmatter 的 `tools` 字段代码中未被消费,无需任何 frontmatter 改动。
- **不开放 bash / git clone 给子代理**;不实现 SSRF 硬防护(与 workspaceGuard"护栏而非安全边界"哲学一致;design 工具仅能访问固定仓库的固定文件集合,风险面远小于任意 URL 抓取)。

---

## 1. 设计决策(逐条回答用户问题)

### D1. anysearch 注册到子代理:改哪个文件、如何复用、是否去重
- **改 `apps/api/src/pi/subAgent.ts` 的 `buildSubAgentTools`**。复用 `anySearchTools.ts` 导出的 `createAnySearchTools` 工厂,零复制。
- `buildSubAgentTools` 目前拿不到 store/config,需新增可选参数 `getAnySearchApiKey?: () => string | undefined`;`runSubAgent` 调用处传入 `() => loadConfig(store).anySearchApiKey ?? undefined`(env `ANYSEARCH_API_KEY` 优先的逻辑在 anySearchTools 内部已处理,与主代理一致)。
- **去重:无需额外处理**。主代理与每个子代理都是独立 `AgentSession`(各自 `createAgentSession` 调用构建自己的 customTools 注册表),`buildSubAgentTools` 内只 push 一次即天然不重复。单测断言 activeNames 中 `anysearch-search` 恰出现一次,防未来误加。
- **验证**:`subAgent.test.ts` 新增断言(4 个内置角色工具集均含 `anysearch-search`,tools 与 activeNames 同步);`pnpm --filter @workflows/api test / typecheck / lint`;手动冒烟见 Phase 5。

### D2. design 工具的形态与注册方式
- **形态:单个工具 `design`,参数含 `action: 'list' | 'read' | 'download'` 枚举**(见 §3 Phase 2 的 schema 草案)。用户明确"一个 design 工具封装查与下载两个能力",单工具 + 子命令最贴合,且 agent 提示词只需记一个工具名。
- **注册到"所有代理"的代码实现 = 两处注册点**(不存在更优的单一入口,因为主代理与子代理各自独立建会话):
  1. 主代理:`piService.ts openSession`——`designTools` 加入 `guardedTools`(customTools)与 `activeTools`(SDK 的 allowedToolNames 白名单),**只读/读写两分支都要加**(与 webTools 并列);
  2. 子代理:`subAgent.ts buildSubAgentTools`——tools 数组 + activeNames 各加 `design`。
- **shared 类型:不需要改**。工具定义复用 SDK 的 `ToolDefinition`;两处注册点同步靠单测断言兜底(与 anySearch 落地时的"三处同步"风险同类,本次只涉及两处且均有测试)。
- 工具工厂 `createDesignTools({ workspace, repo?, branch?, fetchImpl?, timeoutMs? })` 返回 `[ToolDefinition]`,与 `createAnySearchTools` 工厂风格对称;`workspace` 在创建时捕获(见 D3)。

### D3. "当前打开的工作区"如何确定
- **已确认可拿到,无需降级方案**:工作区概念完全在服务端。前端的所有操作都绑定 `POST /api/agent/workspaces/:id/prompt`,服务端经 `requireWorkspace` 解析出 `Workspace`(含 `path`),传给 `pi.prompt(workspace, ...)`;会话按工作区隔离(一个工作区一个 handle),所以 **"当前打开的工作区" = 该会话所属 `Workspace.path`**。
- 两个注册点都在创建会话时持有 workspace 对象:`piService.openSession(workspace)`、`runSubAgent({ workspace })`(子代理 `cwd` 也是 `workspace.path`)。design 工具在创建时捕获 `workspace.path`,download 即写该目录。
- 兜底(防御性):若工具被以无 workspace 的方式创建(当前不可能),download 直接报错拒绝,不猜测路径。

### D4. design 工具查 design 的数据来源
- **选型:design 工具内部封装 http 抓取,不暴露给 agent**(用户给出的推荐选项,采纳):
  - `list`:`GET https://api.github.com/repos/<repo>/git/trees/<branch>?recursive=1` 一次拿全量文件树,过滤 `*/DESIGN.md`,并检测同目录 `preview.html` / `preview-dark.html` 存在性与 blob 大小;
  - `read` / `download`:`GET https://raw.githubusercontent.com/<repo>/<branch>/<site>/<file>`(raw 不限流);
  - 分支回退:`main` → `master`;GitHub API 未认证 60 次/小时,故 `list` 每进程缓存 60s(key = repo@branch,防同一流程内重复调用),`read`/`download` 全走 raw 不占 API 额度;403 时返回可读指引(设 `GITHUB_TOKEN` env,仅进 Authorization 头,绝不入返回文本)。
- agent 侧**完全不需要**知道 URL 构造——只调 `design` 工具;子代理也没有 fetch-url(用户明确禁止)。
- 工具内部沿用 `anySearchTools.ts` 的成熟模式:Node fetch + `AbortSignal.any([timeout(30s), signal])`、错误分层映射、50KB 字节安全截断(复制其 `truncateOutput` 小工具到 designTools.ts,刻意不重构原文件)。

### D5. 下载落盘:位置、是否受 write 白名单约束、路径安全
- **默认位置:`<workspace>/designs/<site>/`**,文件 = 仓库中该站点实际存在的 `DESIGN.md` + `preview.html` + `preview-dark.html`(download 前用树缓存过滤,只下存在的)。用户可在闸门讨论时改路径(如项目根或 `docs/designs/`),仍须在工作区内。
- **不受逐代理 write 白名单约束**(设计决策,与 v1 不同):design 是**内置基础设施工具**,与 `wait_for_approval` / `complete_task` / `anysearch-search` 同类——注册对所有代理、与代理 frontmatter `write` 无关(explorer/planner 白名单只允许自身产物,若不豁免则"所有代理都能下载"无法成立)。**授权依据 = 用户在闸门处对"站点 + 落盘路径"的确认**。
- 但**安全护栏齐全**,弥补白名单豁免:
  1. 只读工作区(`workspace.readOnly`)→ download 直接报错提示"切回读写模式"(与 executor `**` 降级只读的意图一致);
  2. 路径守卫:`path.resolve(workspace.path, rel)` 后必须 `isPathWithinWorkspace`(复用 workspaceGuard 导出),绝对路径 / `..` 逃逸 / 盘符一律拒绝;
  3. **无任意 URL 参数**:download 只能从固定仓库的固定文件集合拉取(site/file 必须先通过树缓存校验,site 拒绝 `/`、`\`、`..`),不存在 SSRF 式任意 URL 写入;
  4. `overwrite` 默认 false;单文件硬上限 5MB(content-length 预检 + 实际字节双查,超限拒绝不静默截断);
  5. 返回文本只含路径与字节数,**文件内容不进 LLM 上下文**。
- **路径安全总结**:工作区边界(isPathWithinWorkspace)+ 文件名集合白名单 + 只读拦截 + overwrite=false。

### D6. 提示词更新
- `orchestrator.md`:工具清单补 `design` 说明;调度策略新增"设计挑选类需求"条目(explorer 调研 → planner 出下载计划 → 闸门(摘要必含推荐清单与落盘路径)→ executor 下载 → reviewer 校验 → complete_task;驳回回 planner)。
- `explorer.md`:新增"外部资料调研"小节——用 `design` 工具 list/read 查设计库、用 `anysearch-search` 查外部资料;报告要求(候选 site/规模/要点/匹配度 + 推荐 Top N + 来源与可信度提示)。
- `planner.md`:新增小节——下载计划须写明选中 site、落盘路径(默认 `designs/<site>/`)、文件清单与校验方式,供闸门确认。
- `executor.md`:新增小节——批准后用 `design` 工具 `action=download` 落盘,校验文件存在与字节数,写进执行报告。
- 不改 `reviewer.md`(只读校验,提示词无需变)。

### D7. 测试验证
- 单测:新增 `designTools.test.ts`(mock fetch 全覆盖 list/read/download);`subAgent.test.ts` 补"anysearch-search + design 注册到全部子代理"断言;既有测试零回归。
- 端到端:Phase 5 给出"查 design → 闸门确认 → 下载到工作区"完整手动验证步骤(含批准/驳回/只读工作区三个分支)。

---

## 2. 端到端交互流程

```
用户:「调研 awesome-design-md,结合本项目挑选 3 个设计系统,列出推荐,确认后下载 DESIGN.md 到当前工作区」
  │
  ▼ orchestrator(读 orchestrator.md 新调度条目,判为复杂需求)
explorer(子代理,带 anysearch-search + design)
  ├─ design action=list                              → 全量设计清单(站点/文件/大小)
  ├─ design action=read site=<候选>                  → 候选 DESIGN.md 内容(50KB 截断)
  ├─ anysearch-search query=...                      → 外部补充资料(可选)
  ├─ fff-find/read 阅读用户项目 → 确定匹配标准
  └─ 写 01-exploration-*.md:候选清单 + 匹配度 + 推荐 Top N
  │
  ▼ planner
  └─ 读探索报告 → 写 02-plan-*.md:选中站点、落盘路径(默认 designs/<site>/)、
     文件清单(DESIGN.md + preview.html/preview-dark.html)、校验方式、风险、验收标准
  │
  ▼ orchestrator → wait_for_approval(summary 必含:推荐清单 + 落盘路径)
  │   → run 置 awaiting_approval,发 gate_required,回合结束(现有机制,零改动)
  │
  ▼ 用户:【批准】/【驳回+意见】(ChatPane 现有按钮)
  │   批准 → 发「用户已批准计划,继续执行」续跑;驳回 → 回 planner 重做(上限 2 次)
  │
  ▼ executor(带 design)
  ├─ 读 02-plan-*.md
  ├─ design action=download site=<选中> path=<计划路径>(内容不进上下文)
  ├─ 校验:文件存在、字节数与 list 报告一致、可读
  └─ 写 03-execution-*.md
  │
  ▼ reviewer(校验落盘文件与计划一致性)→ 04-review-*.md
  ▼ orchestrator → complete_task(交付总结:下载了哪些、路径、来源)→ run 置 done
```

产物:黑板 `.wf-runs/<runId>/{01-exploration,02-plan,03-execution,04-review}-*.md`(现有机制零改动)+ **用户工作区 `designs/<site>/{DESIGN.md,preview*.html}`**(design 工具落盘,非黑板)。

---

## 3. 分阶段实施计划

### Phase 1:anysearch 注册到子代理(独立可验证)

**目标**:explorer/planner/executor/reviewer 全部获得 `anysearch-search` 联网能力,主代理不受影响。

**文件清单与改动**:

1. **`apps/api/src/pi/subAgent.ts`**
   - 导入:`import { createAnySearchTools } from './anySearchTools.js'`;`import { loadConfig, type WorkflowsStore } from '../config.js'`(现为 `import type { WorkflowsStore }` 单行,改为值 + 类型混合导入)。
   - `buildSubAgentTools` options 增加字段:
     ```ts
     export function buildSubAgentTools(options: {
       workspace: Workspace
       definition: AgentDefinition
       fff: FffIndexManager
       matcher: WriteMatcher | undefined
       /** anysearch API key 回调(env ANYSEARCH_API_KEY 优先逻辑在 anySearchTools 内部) */
       getAnySearchApiKey?: () => string | undefined
     }): { tools: ToolDefinition[]; activeNames: string[] }
     ```
   - 在 fff 工具之后追加(与只读工具并列,无 path 参数,不需 guardPathTool):
     ```ts
     // 网络搜索:子代理联网(与主代理同一工厂,独立会话注册表,无去重问题)
     tools.push(...createAnySearchTools({ getApiKey: options.getAnySearchApiKey }))
     ...
     const activeNames = [
       'read', 'ls',
       ...tools.filter((t) => t.name.startsWith('fff-')).map((t) => t.name),
       'anysearch-search',
     ]
     ```
   - `runSubAgent` 调用处:
     ```ts
     const { tools, activeNames } = buildSubAgentTools({
       workspace, definition, fff, matcher,
       getAnySearchApiKey: () => loadConfig(store).anySearchApiKey ?? undefined,
     })
     ```
2. **`apps/api/src/pi/subAgent.test.ts`**(新增 describe)
   - 构造 stub:`const fff = { get: () => undefined } as unknown as FffIndexManager`;对 4 个内置角色(explorer/planner/executor/reviewer,`makeDef` 复用)分别调 `buildSubAgentTools`。
   - 断言:`activeNames` 含 `anysearch-search` 且**恰好一次**;`tools` 中存在 name 为 `anysearch-search` 的工具;无 write 白名单角色(如 explorer)同样注册(anysearch 是只读内置工具,不受 write 影响)。

**验证方式**:`pnpm --filter @workflows/api test`(新断言全绿、旧测试零回归)、`typecheck`、`lint`。手动冒烟:dev 下让 explorer 调研外部主题,模态窗可见 `anysearch-search` 调用。

---

### Phase 2:design 工具实现 + 单测(新文件,暂不注册)

**目标**:`design` 工具本体(list/read/download 三 action,内部 http 封装)落地,单测全覆盖;本阶段不注册任何代理,独立可验证、零行为影响。

**文件清单与改动**:

1. **新增 `apps/api/src/pi/designTools.ts`**:
   - 常量:`DESIGN_REPO = 'VoltAgent/awesome-design-md'`、`DESIGN_BRANCH = 'main'`、`FALLBACK_BRANCH = 'master'`、`MAX_OUTPUT_BYTES = 50 * 1024`(read 截断)、`MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024`、`DEFAULT_TIMEOUT_MS = 30_000`、`LIST_CACHE_TTL_MS = 60_000`。
   - 工厂与 schema:
     ```ts
     export interface DesignToolOptions {
       workspace: Workspace
       repo?: string          // 测试注入,默认 DESIGN_REPO
       branch?: string        // 测试注入,默认 DESIGN_BRANCH
       fetchImpl?: typeof fetch
       timeoutMs?: number
     }
     const designSchema = Type.Object({
       action: Type.Union(
         [Type.Literal('list'), Type.Literal('read'), Type.Literal('download')],
         { description: 'list:列出 awesome-design-md 全部设计(站点/文件/大小);read:读取某站点的 DESIGN.md 或预览文件内容;download:把选中的设计下载到当前工作区(应在用户确认后调用)' },
       ),
       site: Type.Optional(Type.String({ description: '站点目录名(list 输出的 site 字段),如 linear' })),
       file: Type.Optional(Type.String({ description: 'read 的文件名,默认 DESIGN.md;可选 preview.html / preview-dark.html' })),
       path: Type.Optional(Type.String({ description: 'download 目标目录(相对工作区根),默认 designs/<site>' })),
       files: Type.Optional(Type.Array(Type.String(), { description: 'download 文件列表,默认 [DESIGN.md, preview.html, preview-dark.html](仅下载仓库中实际存在的)' })),
       overwrite: Type.Optional(Type.Boolean({ description: 'download 目标已存在是否覆盖,默认 false' })),
     })
     export function createDesignTools(opts: DesignToolOptions): ToolDefinition[] {
       return [{ name: 'design', label: 'design', description: '...', promptSnippet: 'Query/download design systems from awesome-design-md', parameters: designSchema, execute: ... }]
     }
     ```
   - 内部私有 helper(仿 anySearchTools 模式):
     - `fetchJson(url, signal)` / `fetchRaw(url, signal)`:Node fetch + `AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])`;`redirect: 'follow'`;`User-Agent: workflows-agent`;若 `process.env.GITHUB_TOKEN` 存在加 `Authorization: Bearer <token>`(仅头,绝不入返回文本/错误文案);超时/用户中止语义与 anySearchTools 完全一致(用户中止唯一透传 `Operation aborted`)。
     - `mapHttpError(status)`:404 → "未找到(检查站点名/文件或仓库分支)";403 → "GitHub API 限流或禁止访问(未认证 60 次/小时),可设置环境变量 GITHUB_TOKEN 提升至 5000 次/小时;read/download 走 raw.githubusercontent.com 不限流";429/5xx → 通用文案;其余 → 通用。
     - `truncateOutput(text)`:从 anySearchTools 复制(字节安全二分截断 + 代理对保护 + `[50KB limit reached]` 标记,不重构原文件)。
     - `getTreeCache()`:进程内 `Map<repo@branch, { ts, sites }>` TTL 60s;`listSites()` 优先树 API(`main` → 404/失败回退 `master`),解析 `tree[]`,收集 `*/DESIGN.md` 站点及其 `preview.html`/`preview-dark.html` 存在性与 blob 大小,返回 `{ site, files: Array<{name,size}> }[]`。
     - `validateSite(site)`:非空、不含 `/` `\` `..`;`validateFile(site, file)`:file ∈ 树缓存中该站点文件集合。
   - `execute` 按 action 分派(abort 预检在前;所有非 abort 异常落为 `design 工具错误:<可读文案>`):
     - **list**:`listSites()` → 渲染 `共 N 个设计:` + 每站点一行 `site | DESIGN.md(12345 B) | preview.html | preview-dark.html`;截断 50KB。
     - **read**:校验 site/file → `fetchRaw(rawUrl)` → 返回 `来源: <finalUrl>(<bytes> 字节)\n\n<content>`(截断)。
     - **download**:校验顺序——`workspace.readOnly` → 报错"工作区为只读,请切换为读写后再下载";validateSite;目标路径 `path ?? 'designs/'+site` 经 `path.resolve(workspace.path, rel)` + `isPathWithinWorkspace`(从 workspaceGuard 导入)校验,逃逸/绝对路径 → "工作区边界拦截"文案;`files ?? ['DESIGN.md','preview.html','preview-dark.html']` 与树缓存求交集(不存在则跳过,全空报错);逐个 `fetchRaw`(先 content-length 预检 ≤ MAX_DOWNLOAD_BYTES,再实读字节硬上限);`existsSync(target) && !overwrite` → "目标已存在,如需覆盖请传 overwrite=true";`mkdirSync(dirname, { recursive: true })` + `writeFileSync`;返回 `已下载 N 个文件到 <relDir>:DESIGN.md(12345 字节),preview.html(…)(来源:<repo>)`——**不含文件内容**。
   - 工具描述要点:适用"调研 awesome-design-md 设计库并挑选/下载 DESIGN.md";list 先看全量、read 精读候选、download 在用户确认后落盘到工作区(默认 designs/<site>/);内容来自外部仓库,可信度自行判断。
2. **新增 `apps/api/src/pi/designTools.test.ts`**(mock fetch,模式照抄 anySearchTools.test.ts 的 `makeFetchMock`):
   - list:正常树响应 → 输出含站点与文件/大小;main 404 → 自动回退 master;403 → 限流指引文案;树缺 `tree` → 结构错误;列表缓存(同 repo 只发一次请求,TTL 内第二次命中缓存)。
   - read:raw 成功 → 内容 + 来源头;50KB 截断(英文大文本 + 中文多字节无乱码,断言 ≤50KB 且含标记);未知 site/file → 可读错误;404/5xx 映射;超时(AbortSignal.timeout 生效)与用户中止(透传 Operation aborted)。
   - download:成功(建目录、字节数正确、输出不含正文);`../` 逃逸与绝对路径拒绝;site 含 `/` 或 `..` 拒绝;只读工作区 → 拒绝文案;overwrite=false 已存在 → 报错、true → 覆盖;content-length 超上限 → 拒绝;files 过滤(仓库不存在的文件跳过);非 2xx 映射。
   - 工厂:返回 1 个工具,name/label 均为 `design`;`createDesignTools` 不传 fetchImpl 时用全局 fetch(仅断言工厂形态,不实际请求)。

**验证方式**:`pnpm --filter @workflows/api test`(新测试全绿)、`typecheck`、`lint`。本阶段未注册,运行行为零变化。

---

### Phase 3:design 工具注册到所有代理

**目标**:主代理与全部子代理都能调用 `design`(含 download)。

**文件清单与改动**:

1. **`apps/api/src/pi/piService.ts`**(主代理注册点,`openSession` 内,与 webTools 并列):
   - 导入:`import { createDesignTools } from './designTools.js'`。
   - 在 `const webToolNames = ...` 之后追加:
     ```ts
     // 内置 design 工具:查/读/下载 awesome-design-md 设计;内部封装 http,无 path 参数
     const designTools = createDesignTools({ workspace })
     const designToolNames = designTools.map((tool) => tool.name)
     ```
   - 只读/读写两分支的 `guardedTools` 与 `activeTools` 均追加(**注意 SDK allowedToolNames 会过滤 customTools,必须同时列白名单**):
     ```ts
     const guardedTools: ToolDefinition[] = workspace.readOnly
       ? [...nonSearchTools, ...searchTools, ...webTools, ...designTools]
       : [...nonSearchTools, ...searchTools, ...webTools, ...designTools,
          toToolDefinition(createBashTool(workspace.path, { spawnHook: createWorkspaceBashHook(workspace.path) }))]
     const activeTools = workspace.readOnly
       ? ['read', 'ls', ...searchNames, ...webToolNames, ...designToolNames]
       : ['read', 'bash', 'edit', 'write', ...searchNames, ...webToolNames, ...designToolNames]
     ```
2. **`apps/api/src/pi/subAgent.ts`**(子代理注册点,`buildSubAgentTools`):
   - 导入:`import { createDesignTools } from './designTools.js'`。
   - 与 Phase 1 的 anysearch 并列追加:
     ```ts
     // 内置 design 工具:查/读/下载设计(与 wait_for_approval 同类,注册到所有代理;download 有独立安全护栏)
     tools.push(...createDesignTools({ workspace }))
     ...
     const activeNames = [
       'read', 'ls',
       ...tools.filter((t) => t.name.startsWith('fff-')).map((t) => t.name),
       'anysearch-search', 'design',
     ]
     ```
3. **`apps/api/src/pi/subAgent.test.ts`**(扩展 Phase 1 的断言):4 个角色 activeNames 均含 `design`(且恰一次);tools 中存在 `design` 工具;executor 与 explorer 无差异(design 是内置工具,不受 write 白名单影响——断言 explorer 也含 download 能力,固化 D5 决策)。

**验证方式**:单测 + typecheck + lint;手动冒烟:dev 下主代理会话直接发「用 design 工具 list 一下 awesome-design-md 有哪些设计」,主代理与子代理模态窗均可见 `design` 调用。

---

### Phase 4:提示词与文档

**目标**:流程被编排出来。全部为 md 文本改动,零代码;均**追加小节**,不改动既有约束。

**文件清单与改动**:

1. **`apps/api/src/pi/agents/orchestrator.md`**
   - "可用子代理"工具清单追加一行:
     ```markdown
     - design(设计库工具,主代理与子代理均可用):list 列出 awesome-design-md 全部设计 / read 读取某站点 DESIGN.md 或预览文件 / download 把选中的设计下载到当前工作区(默认 designs/<site>/,应在用户确认后调用)
     ```
   - 调度策略追加一条(与现有条目并列):
     ```markdown
     - 设计挑选类需求(如「调研 awesome-design-md,结合本项目挑选设计系统并下载」):
       explorer(用 design 工具 list/read 调研设计库,可配 anysearch-search 查外部资料,结合项目给出候选清单与匹配分析)
       → planner(下载计划:选中站点、落盘路径(默认 designs/<site>/)、文件清单、校验方式)
       → wait_for_approval(摘要必须包含推荐清单与落盘路径,请用户确认或指出调整)
       → 批准后 executor(用 design 工具 download 落盘并校验)→ reviewer(校验)→ complete_task
       用户驳回时按意见调整选择(回 planner)
     ```
2. **`apps/api/src/pi/agents/explorer.md`** 追加"外部资料调研"小节:
   ```markdown
   ## 外部资料调研(设计库 / 网络)
   - 设计库调研:用 design 工具——action=list 先拿全量清单(站点/文件/大小),再 action=read site=<站点> 精读候选 DESIGN.md(大文件会截断,以列表中的大小为参考)
   - 网络补充:需要工作区之外的外部信息(第三方文档/最新动态)时用 anysearch-search
   - 报告要求:每个候选给出 站点名 / 文件规模 / 要点 / 与当前项目的匹配度与理由;最后给出推荐 Top N;
     注明内容来自外部仓库/网络、可信度自行判断
   ```
3. **`apps/api/src/pi/agents/planner.md`** 追加"下载类计划"小节:
   ```markdown
   ## 下载类计划(如设计下载)
   - 计划须写明:选中站点、落盘路径(默认 designs/<site>/,相对工作区根;用户可在闸门讨论时指定其他位置)、
     文件清单(DESIGN.md + preview.html/preview-dark.html,以 design list 结果为准)、校验方式(文件存在/字节数一致)
   - 下载动作由 executor 在用户批准后执行(design 工具 action=download)
   ```
4. **`apps/api/src/pi/agents/executor.md`** 追加"下载外部文件"小节:
   ```markdown
   ## 下载外部文件(如设计下载)
   - 用户批准后,用 design 工具 action=download site=<站点> path=<计划路径> 落盘(内容不进对话上下文)
   - 校验:目标文件存在、字节数与计划/list 报告一致、可读;写进执行报告
   - 只读工作区下载会被工具拒绝:提示用户切换为读写后重试
   ```
5. **`docs/dag-workflow.md`**(权威语义文档,与实现对齐):
   - 权限模型一节补充:子代理工具集新增 `anysearch-search`(网络搜索,所有子代理可用,与主代理同工厂)与内置 `design` 工具(查/读/下载 awesome-design-md 设计,注册到主代理与所有子代理,与 wait_for_approval 同类基础设施工具,download 不受逐代理 write 白名单约束,但受:工作区边界 + 只读拦截 + 固定文件集合 + overwrite 默认 false 约束);注册点 `piService.openSession` 与 `subAgent.buildSubAgentTools`。
   - 补充外部抓取约定:design 工具内部封装 http(list 走 GitHub trees API、read/download 走 raw,main→master 回退,GITHUB_TOKEN env 可选、限流 60 次/小时与 60s 列表缓存、50KB 读截断 / 5MB 下载硬上限)。

**验证方式**:`pnpm build` 成功(scripts/copy-agents.mjs 把 agents/*.md 复制进 dist,生产生效;dev 直接读 src);人工 review md diff 确认只增不改。

---

### Phase 5:端到端验证

**目标**:完整跑通"查 design → 闸门确认 → 下载到当前工作区"。

**验证步骤**:
1. `pnpm dev`(或 `pnpm build && pnpm dev`),把本仓库(或任一测试目录)添加为工作区(读写)。
2. 发消息:「用 design 工具调研 awesome-design-md 的全部设计,结合本项目(Vue 3 + Hono + TypeScript 的 Web Agent 工作台)挑选 3 个最合适的设计系统,列出推荐理由,确认后把选中的 DESIGN.md 下载到当前工作区」。
3. 核对:
   - explorer 模态窗出现 `design` 调用(list → 多次 read)与 `anysearch-search` 调用(如有外部补充);`01-exploration-1.md` 含候选清单(站点/规模/匹配度/推荐 Top 3)。
   - planner 产物 `02-plan-1.md` 含选中站点 + 落盘路径(`designs/<site>/`)+ 文件清单 + 校验方式。
   - 前端出现闸门按钮(`gate_required`,摘要含推荐清单与落盘路径);DagPanel 显示 ⏸ 闸门节点。
   - 点【批准】→ executor 出现 `design` 工具 `action=download` 调用 → `<工作区>/designs/<site>/DESIGN.md`(及 preview 文件,若仓库中存在)真实落盘且字节数 > 0;`03-execution-1.md` 记录校验结果。
   - reviewer(如走)→ `04-review-1.md` pass;最终 complete_task;`run.json` 状态经历 planning → awaiting_approval → executing → (reviewing) → done。
   - **产物目录非下载目标**:`.wf-runs/<runId>/` 只有 4 类角色报告与 run.json,`designs/` 位于工作区根。
4. **驳回分支**:再跑一次,【驳回】输入「只保留前两个」→ 回 planner 重做、闸门再次弹出、最终只下载 2 个站点。
5. **只读工作区分支**:工作区切只读再跑 → list/read/调研/闸门全流程可完成;executor 的 download 被工具拒绝并给出"切换读写"提示(符合 D5)。
6. **限流分支(可选)**:不设 GITHUB_TOKEN、反复触发 list,验证 403 指引文案后流程可继续(重试或走 raw)。

**验收标准(逐条核对清单)**:
- [ ] Phase 1:`anysearch-search` 出现在全部 4 个内置子代理的 tools 与 activeNames(单测断言,恰一次);旧测试零回归;typecheck/lint 通过。
- [ ] Phase 2:designTools.test.ts 全绿(list/read/download 的 mock 覆盖:成功、截断、分支回退、限流文案、路径逃逸、只读拦截、覆盖语义、大小上限、超时/中止);`design` 工具名与 schema 符合 §1 D2/D4/D5 设计。
- [ ] Phase 3:piService.openSession 只读/读写两分支的 customTools 与 tools 白名单均含 `design`(代码 review + 单测覆盖子代理侧);subAgent 侧断言含 `design`。
- [ ] Phase 4:`pnpm build` 成功;dist/pi/agents/*.md 含新小节;docs/dag-workflow.md 已补充工具注册与抓取约定。
- [ ] Phase 5:上述 6 步场景全部通过;`designs/<site>/` 落盘、`.wf-runs` 仅含角色报告;run.json 状态机符合预期。
- [ ] 全程无 shared 类型改动、无前端改动、无 config/routes/runManager/agentDefs 改动、**无 fetch-url/download-url 工具**。

---

## 4. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| GitHub API 限流(未认证 60 次/小时) | list 失败 | list 每进程 60s 缓存(一次流程只调一次树 API);read/download 全走 raw(不限流);main→master 回退;403 返回指引文案(设 GITHUB_TOKEN env,仅进头不落文本) |
| DESIGN.md 超 50KB | read 分析不完整 | read 截断 + 标记,list 报告文件大小供 agent 预判;download 直接落盘(≤5MB 硬上限,内容不进上下文) |
| 工具注册不同步(tools 数组 vs activeNames 白名单,两处注册点) | 工具不可见 | 单测断言 tools/activeNames 同步(子代理侧);主代理侧代码 review + Phase 5 冒烟;与 anySearch 落地同套路 |
| design download 不受逐代理 write 白名单约束 | 越权写工作区 | 授权 = 闸门用户确认;护栏:工作区边界(isPathWithinWorkspace)+ 只读工作区拒绝 + 固定文件集合(无任意 URL)+ overwrite 默认 false + 单文件 5MB 上限;单测全覆盖 |
| 子代理联网 = 行为变更 | 上下文污染/可信度 | anysearch 输出 50KB 硬截断(既有);提示词要求注明"外部内容可信度自行判断" |
| 只读工作区下载被拒 | 流程中断 | 工具错误文案明确指引"切换读写";Phase 5 分支 5 验证 |
| md 改动后生产未重建 | 生产行为不变 | Phase 4 明确 `pnpm build`(copy-agents.mjs);dev 直接读 src 不受影响 |
| GITHUB_TOKEN 泄入日志/上下文 | 密钥泄露 | 仅 env 读取、只进 Authorization 头,绝不写入返回文本/错误文案(与 anysearch key 同策略);单测断言响应不含 token |

**回滚方案**:全部改动为**增量**(1 个新工具文件 + 1 个新测试文件 + `subAgent.ts` 两处注册 diff + `piService.ts` 一处注册 diff + 4 个 md 追加 + 1 个文档追加),无类型/结构变更。回滚 = 删除新文件 + `git checkout` 上述既有文件。Phase 1/2 可独立回滚;Phase 3 依赖 Phase 2(建议同批次);Phase 4 的 md 引用了工具,与 Phase 3 同批次回滚。`pnpm build` 产物随源码重建。

---

## 5. 备选方案(记录备查,不采用)

- **B1:design 工具 download 受逐代理 write 白名单约束**——更"严格",但 explorer/planner 白名单只允许自身产物,将导致"注册到所有代理"的 download 能力形同虚设,与用户意图冲突;若要收紧,后续可在 frontmatter 加 `designDownload: true` 能力位(零代码即可扩展,当前不做)。
- **B2:拆成 design-list / design-read / design-download 三个工具**——注册点与提示词更啰嗦;用户明确"一个 design 工具封装查与下载",不采用。
- **B3:design 工具数据源依赖 anysearch 搜索而非直接抓仓库**——搜索结果拿不到仓库内精确文件清单与原始 DESIGN.md 内容,无法满足"查看该仓库所有设计"的精确需求;仅作 list 失败时的补充手段(由 agent 自行决定),不内置。
