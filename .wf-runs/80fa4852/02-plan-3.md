# 实施计划 v3:内置 design 工具(read/download,jsDelivr 优先)+ 子代理 anysearch 下沉

> 依据探索报告 `.wf-runs/80fa4852/01-exploration-1.md`;本计划为 v3,按用户最新意见重写(去掉 list、走 jsDelivr CDN 规避 GitHub 限流)。
> **与 v1/v2 的关键差异**(必须严格遵守):
> 1. **去掉 `list` 动作**:awesome-design-md 的 README.md 本身就介绍了全部设计(每个站点 = 站点名 + 一句话风格描述),agent 先读 README、自行判断场景,再直接拉对应 DESIGN.md,不列目录、不枚举文件树;
> 2. **完全不走 GitHub API**:design 工具内部抓取一律 `jsDelivr CDN 优先 → raw.githubusercontent.com 兜底`,从源头规避 60 次/小时限流;`GITHUB_TOKEN` 仅作可选 env 配置项保留(当前实现不读取,仅供将来接 GitHub API 时启用)。

---

## 0. 状态与背景

### 0.1 已完成的改动(本计划不重复规划,仅提及)
- **planner 重做上限已移除**:`apps/api/src/config.ts` `StoredConfig` 新增 `plannerMaxRetries?: number`(缺省 = 无上限);`piService.ts` L389-400 动态读取;`orchestrator.md:26` 已同步;已 `pnpm build` 同步 dist;服务已重启。**无需再动。**

### 0.2 保持的部分(v2 已确认)
1. `anysearch-search` 注册进子代理工具集(`subAgent.ts buildSubAgentTools`),explorer/planner/executor/reviewer 均可联网。
2. 内置 `design` 工具注册到**所有代理**(主代理 `piService.ts openSession` + 子代理 `subAgent.ts`),与 `wait_for_approval` 同类基础设施工具。
3. 下载到**当前打开的工作区**(会话所属 `Workspace.path`,`openSession`/`runSubAgent` 创建时均可捕获):默认 `<workspace>/designs/<site>/`,受**工作区边界 + 只读检查**保护,`overwrite` 默认 false。
4. 交互流程:查 design(读 README/DESIGN.md)→ 和用户讨论(闸门)→ 用户确认 → download 到工作区。

### 0.3 目标与范围

**做什么**
1. `anysearch-search` 下沉到子代理(1 个注册点 + 测试)。
2. 新增内置 `design` 工具(`apps/api/src/pi/designTools.ts`),**仅两个 action**:
   - `read`:读仓库 `README.md`(默认)或指定站点的 `DESIGN.md`(任意仓库内路径),经 jsDelivr/raw 获取,**50KB 字节截断,内容进 LLM 上下文**供 agent 判断;
   - `download`:把选中的 `DESIGN.md` 经 jsDelivr/raw **流式落盘到当前工作区**,**内容不进上下文**,5MB 硬上限。
   - 工具内部封装 http(jsDelivr → raw 回退),**不暴露任意 fetch-url 给 agent**。
3. 注册到所有代理(主代理两分支 + 全部子代理),像 wait_for_approval 一样。
4. 更新提示词(`orchestrator.md` / `explorer.md` / `planner.md` / `executor.md`)与 `docs/dag-workflow.md`。
5. 单测 + 端到端手动验证(含 jsDelivr 不可用 → fallback raw 的测试)。

**不做什么(边界)**
- **不新增 `list` 动作、不调 GitHub API(trees/contents)、不枚举仓库目录**——README 即目录,agent 读 README 自行判断。
- 不新增 fetch-url / download-url 通用工具(v1 方案整体废弃);子代理联网只靠 anysearch-search,抓仓库内容只走 design 工具内部。
- 不改前端(闸门 UI/SSE/DAG/模态窗全复用)、不改 shared 包(无新事件/状态/类型,`ToolDefinition` 来自 pi SDK)、不改 `config.ts` / `routes.ts` / `runManager.ts` / `agentDefs.ts`(除 `subAgent.ts`/`piService.ts` 两处注册外零核心改动)。
- 不开放 bash / git clone 给子代理;不做 SSRF 硬防护(design 工具只能访问固定仓库的固定路径集合,风险面极小)。
- `GITHUB_TOKEN`:当前**不读取、不发送**(jsDelivr/raw 无需鉴权);仅作为 env 配置项在文档中保留说明(将来接 GitHub API 时启用)。

---

## 1. 设计决策

### D1. design 工具形态与 schema 草案
单工具 `design` + `action: 'read' | 'download'` 枚举(用户明确"精简为两个动作")。schema(TypeBox,与 anySearchTools 同风格):

```ts
const designSchema = Type.Object({
  action: Type.Union(
    [Type.Literal('read'), Type.Literal('download')],
    {
      description:
        'read:读取仓库文件内容(默认 README.md,或指定设计站点的 DESIGN.md),内容进入对话供判断;' +
        'download:把仓库文件直接下载到当前工作区(内容不进入对话),应在用户确认后调用',
    },
  ),
  path: Type.Optional(Type.String({
    description:
      '仓库内文件路径。read 默认 "README.md"(介绍全部设计:每行 站点名+一句话风格描述,相当于目录);' +
      '指定设计时用 README 中列出的路径模式,如 "design-md/<站点>/DESIGN.md"',
  })),
  dir: Type.Optional(Type.String({
    description:
      'download 目标目录(相对工作区根),默认 "designs/<站点>"(站点 = path 的父目录名,如 design-md/claude/DESIGN.md → designs/claude)',
  })),
  overwrite: Type.Optional(Type.Boolean({
    description: 'download 目标已存在时是否覆盖,默认 false',
  })),
})
```

工厂:`createDesignTools(opts: { workspace: Workspace; repoOwner?, repo?, branch?, fallbackBranch?, fetchImpl?, timeoutMs?, cdnBase? })` 返回 `ToolDefinition[]`(单元素),测试注入同 anySearchTools 模式。

### D2. 限流规避:jsDelivr URL 构造与 fallback 规则
**原则:完全不调 GitHub API → 不存在 60 次/小时限流问题 → 无需 GITHUB_TOKEN。**

- **URL 构造规则**:
  - jsDelivr:`https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}`(如 `https://cdn.jsdelivr.net/gh/VoltAgent/awesome-design-md@main/README.md`、`...@main/design-md/claude/DESIGN.md`);
  - raw 兜底:`https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`;
  - path 逐段 `encodeURIComponent`(仓库路径不含 `?`/`#`,jsDelivr 要求 path 不含这两字符,天然满足);
  - 支持 env 测试钩子 `DESIGN_CDN_BASE` 覆盖 jsDelivr 基址(端到端验证 fallback 用,默认 `https://cdn.jsdelivr.net/gh`)。
- **尝试序列(顺序即优先级,首次 2xx 即停)**:
  1. `jsDelivr@{branch=main}`
  2. `raw@{main}`(jsDelivr 不可用/限流/网络失败时兜底)
  3. `raw@{fallbackBranch=master}`(分支名兜底,仅当 main 全失败)
- **失败判定**:非 2xx 或网络异常/超时都视为该源失败,继续下一个;全部失败 → 抛出聚合错误:`文件获取失败:已尝试 <url 列表>;请检查路径/站点名是否与 README 一致,或稍后重试`(404 时额外提示"检查路径/站点名";403/429 提示"jsDelivr/raw 一般不限流,若持续出现请检查网络/代理")。
- **超时/重试策略**:每次尝试 `AbortSignal.any([AbortSignal.timeout(20_000), signal])`(单次 20s,三源合计最坏 60s,正常首源即成功);同一源不重试(避免翻倍延迟);用户中止唯一透传 `Operation aborted`(与 anySearchTools 语义一致)。
- **GITHUB_TOKEN**:不读取、不发送、不进任何返回文本/日志;文档注明"保留 env 配置项,当前 design 工具不依赖 GitHub API,仅在未来需要 API 时启用"。

### D3. read 语义(内容进上下文)
- `path` 缺省 → `README.md`(相当于"目录":站点名 + 一句话风格描述,通常远小于 50KB);
- 任意仓库内路径均可读(`design-md/<site>/DESIGN.md`、preview 等);
- 路径校验:拒绝以 `/` 开头、含 `..` 段、含反斜杠(防路径技巧);
- 返回:`来源: <最终URL>(<bytes> 字节)\n\n<content>`;50KB 字节安全截断(复用 anySearchTools 的 `truncateOutput` 二分截断实现,复制到 designTools.ts,刻意不重构原文件),截断标记 `[50KB limit reached]`;
- 内容进上下文 → 供 agent 判断匹配度(与 download 形成对照)。

### D4. download 语义(不进上下文,受护栏保护)
- 校验顺序:① `workspace.readOnly` → 拒绝,文案"工作区为只读,请切换为读写后再下载";② repoPath 校验(同 D3);③ 目标 `dir`(默认 `designs/<site>`)经 `path.resolve(workspace.path, dir)` + `isPathWithinWorkspace`(workspaceGuard 已导出)校验,绝对路径 / `..` 逃逸 → "工作区边界拦截"文案;④ `existsSync(target) && !overwrite` → "目标已存在,如需覆盖请传 overwrite=true";⑤ 单文件 5MB 硬上限(content-length 头预检 + 实际字节双查,超限拒绝不静默截断);
- 落盘:文件名 = repoPath 的 basename(如 `DESIGN.md`);`mkdirSync(dirname, { recursive: true })` + `writeFileSync`;
- 返回文本仅含路径与字节数:`已下载 <bytes> 字节到 <relPath>(来源:<finalUrl>)`——**文件内容不进 LLM 上下文**;
- 授权依据 = 用户在闸门处对"站点 + 落盘路径"的确认(与 v2 D5 一致,不受逐代理 write 白名单约束,但护栏齐全)。

### D5. 注册点(两处,与 v2 一致)
1. 主代理:`piService.ts openSession`——`designTools` 加入 `guardedTools` 与 `activeTools`,**只读/读写两分支都要加**(与 webTools 并列;SDK allowedToolNames 过滤 customTools,必须同时列白名单);
2. 子代理:`subAgent.ts buildSubAgentTools`——tools 数组 + activeNames 各加 `design`(与 anysearch-search 并列);
3. 同步兜底:单测断言 tools/activeNames 同步。

### D6. 提示词要点(读 README 判断,而非列目录)
- `orchestrator.md`:工具清单补 design 说明 + "设计挑选类需求"调度条目(explorer 读 README 判断 → 候选 → planner 计划 → 闸门 → executor 下载 → reviewer → complete_task);
- `explorer.md`:新增"外部设计库调研"小节——**先 read README.md(相当于目录),判断适合当前项目的场景,再 read 候选 DESIGN.md 精读,不要枚举目录**;
- `planner.md` / `executor.md`:下载计划/执行小节(与 v2 相同,文件清单简化为 DESIGN.md);
- `reviewer.md` 不改。

---

## 2. 分阶段实施计划

### Phase 1:anysearch-search 注册到子代理(独立可验证)

**目标**:4 个子代理全部获得 `anysearch-search` 联网能力,主代理不受影响,零回归。

**文件清单与改动**:

1. **`apps/api/src/pi/subAgent.ts`**
   - 导入:`import { createAnySearchTools } from './anySearchTools.js'`;把 `import type { WorkflowsStore } from '../config.js'` 改为混合导入并加 `loadConfig`:`import { loadConfig, type WorkflowsStore } from '../config.js'`。
   - `buildSubAgentTools` options 增加可选字段:
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
   - 在 fff 工具之后追加(只读工具,无 path 参数,不需 guardPathTool):
     ```ts
     // 网络搜索:子代理联网(与主代理同一工厂;独立会话注册表,无去重问题)
     tools.push(...createAnySearchTools({ getApiKey: options.getAnySearchApiKey }))
     ...
     const activeNames = ['read', 'ls',
       ...tools.filter((t) => t.name.startsWith('fff-')).map((t) => t.name),
       'anysearch-search']
     ```
   - `runSubAgent` 调用处传入:
     ```ts
     const { tools, activeNames } = buildSubAgentTools({
       workspace, definition, fff, matcher,
       getAnySearchApiKey: () => loadConfig(store).anySearchApiKey ?? undefined,
     })
     ```
2. **`apps/api/src/pi/subAgent.test.ts`**(新增 describe)
   - stub `fff = { get: () => undefined } as unknown as FffIndexManager`;对 4 个内置角色(explorer/planner/executor/reviewer,复用 `makeDef`)分别调 `buildSubAgentTools`(需传 `workspace`;`makeWorkspace` 已存在);
   - 断言:`activeNames` 含 `anysearch-search` 且**恰好一次**;`tools` 中存在名为 `anysearch-search` 的工具;无 write 白名单角色(explorer)同样注册。

**验证**:`pnpm --filter @workflows/api test`(新断言全绿、旧测试零回归)、`typecheck`、`lint`;手动冒烟:dev 下让 explorer 调研外部主题,模态窗可见 `anysearch-search` 调用。

---

### Phase 2:design 工具实现 + 单测(新文件,暂不注册)

**目标**:`design` 工具(read/download 两 action + jsDelivr/raw 内部封装)落地,单测全覆盖;本阶段不注册任何代理,独立可验证、零行为影响。

**文件清单与改动**:

1. **新增 `apps/api/src/pi/designTools.ts`**:
   - 常量:`DESIGN_OWNER = 'VoltAgent'`、`DESIGN_REPO = 'awesome-design-md'`、`DESIGN_BRANCH = 'main'`、`FALLBACK_BRANCH = 'master'`、`MAX_OUTPUT_BYTES = 50 * 1024`(read 截断)、`MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024`、`ATTEMPT_TIMEOUT_MS = 20_000`。
   - 私有 helper(仿 anySearchTools 模式):
     - `sourceUrls(repoPath)`:按 D2 生成 3 个候选 URL(jsDelivr@main → raw@main → raw@master),支持 `cdnBase`/`owner`/`repo`/`branch` 注入;
     - `fetchFile(repoPath, signal, mode: 'text'|'buffer')`:顺序尝试,首次 2xx 即停;`AbortSignal.any([AbortSignal.timeout(ATTEMPT_TIMEOUT_MS), signal])`、`redirect: 'follow'`、`User-Agent: workflows-agent`;**不发送 Authorization**(无 GITHUB_TOKEN 读取);非 2xx/网络/超时 → 记录并尝试下一源;全失败 → 聚合错误(含尝试列表 + 404/403/429 可读指引);用户中止唯一透传 `Operation aborted`;
     - `mapHttpError(status)`(404/403/429/5xx 文案,见 D2);
     - `truncateOutput(text)`:从 anySearchTools 复制(字节安全二分截断 + 代理对保护 + `[50KB limit reached]`,不重构原文件);
     - `validateRepoPath(path)`:非空、不以 `/` 开头、不含 `\`、不含 `..` 段;
     - `validateTargetDir(workspace, dir)`:resolve 后 `isPathWithinWorkspace`(从 `./workspaceGuard.js` 导入),失败抛"工作区边界拦截:design 下载目标超出工作区「<dir>」";
   - `execute` 按 action 分派(abort 预检在前;非 abort 异常落为 `design 工具错误:<可读文案>`):
     - **read**:`repoPath = params.path ?? 'README.md'` → validateRepoPath → `fetchFile(text)` → 返回 `来源: <finalUrl>(<bytes> 字节)\n\n<content>`(50KB 截断);
     - **download**:readOnly 拒绝 → validateRepoPath → 默认 `dir = params.dir ?? 'designs/' + basename(dirname(repoPath))`(site 为空时拒绝:README.md 不是可下载设计)→ validateTargetDir → `target = join(workspace.path, dir, basename(repoPath))` → existsSync/overwrite 检查 → `fetchFile(buffer)`(content-length 预检 ≤ MAX_DOWNLOAD_BYTES,实际字节硬上限)→ mkdir/writeFile → 返回 `已下载 <bytes> 字节到 <relPath>(来源:<finalUrl>)`;
   - 工具描述(要点):"design(设计库工具):从 awesome-design-md 读取/下载设计文件。先 read 默认 README.md 获取全部设计清单(站点名 + 一句话风格描述),判断哪个设计适合当前项目,再 read 对应 DESIGN.md 精读;与用户确认后 download 到当前工作区(默认 designs/<站点>/)。文件经 jsDelivr CDN 获取、自动回退 raw.githubusercontent.com,不受 GitHub API 限流。内容来自外部仓库,可信度请自行判断。"
2. **新增 `apps/api/src/pi/designTools.test.ts`**(mock fetch,复用 anySearchTools.test.ts 的 `makeFetchMock`/`exec` 模式;需临时目录工作区 `mkdtempSync`):
   - **URL 构造与回退**:read 默认 path → 首个请求为 `https://cdn.jsdelivr.net/gh/VoltAgent/awesome-design-md@main/README.md`;jsDelivr 返回 500 → 第二个请求为 raw@main;jsDelivr 网络异常 → raw 兜底成功;三者全失败 → 错误含尝试 URL 列表;`DESIGN_CDN_BASE` env 覆盖生效;
   - **read**:成功 → 内容 + 来源头;50KB 截断(英文大文本 + 中文多字节无乱码,断言 ≤50KB 且含标记);`path` 含 `..` / 以 `/` 开头 / 反斜杠 → 拒绝;404 提示"检查路径/站点名";超时与用户中止(透传 Operation aborted);
   - **download**:成功(自动建父目录、返回相对路径与字节数、**输出不含文件正文**);默认 dir 推导(`design-md/claude/DESIGN.md` → `designs/claude/DESIGN.md`);`..` 逃逸/绝对路径 dir → 工作区边界拦截;只读工作区 → 拒绝文案;overwrite=false 已存在 → 报错、true → 覆盖;content-length 超 5MB → 拒绝、实际字节超限 → 拒绝;404 映射;
   - **工厂形态**:`createDesignTools` 返回 1 个工具,name/label 均为 `design`。

**验证**:`pnpm --filter @workflows/api test`(新测试全绿)、`typecheck`、`lint`。本阶段未注册,运行行为零变化。

---

### Phase 3:design 工具注册到所有代理

**目标**:主代理与全部子代理都能调用 `design`(read/download)。

**文件清单与改动**:

1. **`apps/api/src/pi/piService.ts`**(主代理注册点,`openSession` 内,与 webTools 并列):
   - 导入:`import { createDesignTools } from './designTools.js'`;
   - 在 `const webToolNames = ...` 之后追加:
     ```ts
     // 内置 design 工具:读/下载设计库文件(与 wait_for_approval 同类基础设施工具;download 有独立安全护栏)
     const designTools = createDesignTools({ workspace })
     const designToolNames = designTools.map((tool) => tool.name)
     ```
   - 只读/读写两分支的 `guardedTools` 与 `activeTools` 均追加:
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
   - 导入:`import { createDesignTools } from './designTools.js'`;
   - 与 Phase 1 的 anysearch 并列追加:
     ```ts
     // 内置 design 工具:读/下载设计(与 wait_for_approval 同类,注册到所有代理;download 有独立安全护栏)
     tools.push(...createDesignTools({ workspace }))
     ...
     const activeNames = ['read', 'ls',
       ...tools.filter((t) => t.name.startsWith('fff-')).map((t) => t.name),
       'anysearch-search', 'design']
     ```
3. **`apps/api/src/pi/subAgent.test.ts`**(扩展 Phase 1 断言):4 个角色 `activeNames` 均含 `design`(且恰一次);`tools` 中存在 `design` 工具;executor 与 explorer 无差异(download 不受 write 白名单影响——断言 explorer 也含,固化 D4 决策)。

**验证**:单测 + typecheck + lint;手动冒烟:dev 下主代理会话发「用 design 工具读一下 awesome-design-md 的 README」,主代理与子代理模态窗均可见 `design` 调用。

---

### Phase 4:提示词与文档

**目标**:流程被编排出来。全部为 md 文本改动,零代码;均**追加小节**,不改动既有约束。

**文件清单与改动**:

1. **`apps/api/src/pi/agents/orchestrator.md`**
   - "可用子代理"清单追加一行:
     ```markdown
     - design(设计库工具,主代理与子代理均可用):read 读取 awesome-design-md 的 README.md(全部设计的站点名+一句话风格描述,相当于目录)或指定站点的 DESIGN.md;download 把选中的设计下载到当前工作区(默认 designs/<站点>/,应在用户确认后调用)
     ```
   - 调度策略追加一条(与现有条目并列,注意不覆盖第 3 条 wait_for_approval 规则):
     ```markdown
     - 设计挑选类需求(如「调研 awesome-design-md,结合本项目挑选设计系统并下载」):
       explorer(先 design read 读 README.md 判断哪些设计适合当前项目场景,再 read 候选 DESIGN.md 精读,结合项目给出候选清单与匹配分析)
       → planner(下载计划:选中站点、落盘路径(默认 designs/<站点>/)、校验方式)
       → wait_for_approval(摘要必须包含推荐清单与落盘路径,请用户确认或指出调整)
       → 批准后 executor(design download 落盘并校验)→ reviewer(校验)→ complete_task
       用户驳回时按意见调整选择(回 planner)
     ```
2. **`apps/api/src/pi/agents/explorer.md`** 追加"外部设计库调研"小节:
   ```markdown
   ## 外部设计库调研(awesome-design-md)
   - 用 design 工具 action=read 读取仓库 README.md(默认路径):README 以「站点名 + 一句话风格描述」介绍全部设计,
     相当于目录,先读它判断哪些设计适合当前项目的场景——不要尝试枚举目录/文件树
   - 判断出候选后,用 action=read path=<README 中给出的路径模式,如 design-md/<站点>/DESIGN.md> 精读候选正文
     (大文件 50KB 截断,以内容判断匹配度)
   - 需要工作区之外的外部补充信息(第三方文档/最新动态)时用 anysearch-search
   - 报告要求:每个候选给出 站点名 / 风格要点 / 与当前项目的匹配度与理由;最后给出推荐 Top N;
     注明内容来自外部仓库/网络,可信度自行判断
   ```
3. **`apps/api/src/pi/agents/planner.md`** 追加"下载类计划"小节:
   ```markdown
   ## 下载类计划(如设计下载)
   - 计划须写明:选中站点、落盘路径(默认 designs/<站点>/,相对工作区根;用户可在闸门讨论时指定其他位置)、
     文件清单(DESIGN.md)、校验方式(文件存在/字节数与 read 来源一致)
   - 下载动作由 executor 在用户批准后执行(design 工具 action=download)
   ```
4. **`apps/api/src/pi/agents/executor.md`** 追加"下载外部文件"小节:
   ```markdown
   ## 下载外部文件(如设计下载)
   - 用户批准后,用 design 工具 action=download path=<仓库内路径,如 design-md/<站点>/DESIGN.md> dir=<计划路径> 落盘
     (内容不进对话上下文)
   - 校验:目标文件存在、字节数与计划一致、可读;写进执行报告
   - 只读工作区下载会被工具拒绝:提示用户切换为读写后重试
   ```
5. **`docs/dag-workflow.md`**(权威语义文档,与实现对齐):
   - §4 权限模型补充:子代理工具集新增 `anysearch-search`(网络搜索,所有子代理可用,与主代理同工厂)与内置 `design` 工具(读/下载 awesome-design-md 设计,注册到主代理与所有子代理,与 wait_for_approval 同类基础设施工具;download 不受逐代理 write 白名单约束,但受:工作区边界 + 只读拦截 + 固定仓库路径集合 + overwrite 默认 false + 单文件 5MB 上限);注册点 `piService.openSession` 与 `subAgent.buildSubAgentTools`;
   - 补充"外部抓取约定"小节:design 工具**不调 GitHub API**,一律 jsDelivr CDN 优先(`https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}`)→ raw.githubusercontent.com 兜底 → master 分支兜底;单次尝试 20s 超时、首次 2xx 即停;`GITHUB_TOKEN` 保留为 env 配置项但当前不读取(仅未来接 GitHub API 时启用);read 50KB 截断 / download 5MB 硬上限;jsDelivr 有分钟级缓存延迟(设计库内容更新不频繁,可接受)。

**验证**:`pnpm build` 成功(scripts/copy-agents.mjs 把 agents/*.md 复制进 dist,生产生效;dev 直接读 src);人工 review md diff 确认只增不改。

---

### Phase 5:端到端验证

**目标**:完整跑通"读 README → 判断场景 → 推荐候选 → 闸门确认 → 下载 DESIGN.md 到工作区",含 jsDelivr 不可用 fallback raw。

**验证步骤**:
1. `pnpm build && pnpm dev`,把本仓库(或任一测试目录)添加为工作区(读写)。
2. 发消息:「用 design 工具调研 awesome-design-md 的设计,结合本项目(Vue 3 + Hono + TypeScript 的 Web Agent 工作台)挑选 3 个最合适的设计系统,列出推荐理由,确认后把选中的 DESIGN.md 下载到当前工作区」。
3. 核对:
   - explorer 模态窗出现 `design` 调用:先 read(README.md,全量清单)→ 若干次 read(候选 `design-md/<site>/DESIGN.md`);`01-exploration-1.md` 含候选清单(站点/风格要点/匹配度/推荐 Top 3);
   - planner 产物 `02-plan-1.md` 含选中站点 + 落盘路径(`designs/<site>/`)+ 校验方式;
   - 前端出现闸门按钮(`gate_required`,摘要含推荐清单与落盘路径);DagPanel 显示 ⏸ 闸门节点;
   - 点【批准】→ executor 出现 `design` `action=download` 调用 → `<工作区>/designs/<site>/DESIGN.md` 真实落盘且字节数 > 0;`03-execution-1.md` 记录校验结果;
   - reviewer(如走)→ `04-review-1.md` pass;最终 complete_task;`run.json` 状态经历 planning → awaiting_approval → executing → (reviewing) → done;
   - `.wf-runs/<runId>/` 只有 4 类角色报告与 run.json,`designs/` 位于工作区根。
4. **驳回分支**:再跑一次,【驳回】输入「只保留前两个」→ 回 planner 重做、闸门再次弹出、最终只下载 2 个站点。
5. **只读工作区分支**:工作区切只读再跑 → read/调研/闸门全流程可完成;executor 的 download 被工具拒绝并给出"切换读写"提示。
6. **jsDelivr 不可用 → fallback raw**:dev 启动时设 `DESIGN_CDN_BASE=https://cdn.invalid`(Phase 2 的测试钩子)→ 发消息让 explorer read README → 模态窗可见首次请求失败后自动走 raw.githubusercontent.com 成功返回内容;单测侧由 designTools.test.ts 确定性覆盖同一路径(jsDelivr 500/网络异常 → raw 成功)。
7. **限流确认(可选)**:全程不设 GITHUB_TOKEN、不调任何 api.github.com 域名——在浏览器/服务端日志确认无 api.github.com 请求(即从源头规避 60 次/小时)。

**验收标准(逐条核对清单)**:
- [ ] Phase 1:`anysearch-search` 出现在全部 4 个内置子代理的 tools 与 activeNames(单测断言,恰一次);旧测试零回归;typecheck/lint 通过。
- [ ] Phase 2:designTools.test.ts 全绿(URL 构造/回退顺序/聚合错误/read 截断/路径校验/download 落盘与护栏/只读/overwrite/5MB/超时中止);工具名与 schema 符合 §1 D1-D4;`DESIGN_CDN_BASE` 钩子生效。
- [ ] Phase 3:piService.openSession 只读/读写两分支的 customTools 与 tools 白名单均含 `design`(代码 review);subAgent 侧单测断言 4 角色含 `design`。
- [ ] Phase 4:`pnpm build` 成功;dist/pi/agents/*.md 含新小节(README 即目录、不枚举目录);docs/dag-workflow.md 已补充注册点与 jsDelivr/raw 抓取约定。
- [ ] Phase 5:上述 7 步场景全部通过(核心 4 步 + 驳回 + 只读 + jsDelivr 失效 fallback);`designs/<site>/` 落盘、`.wf-runs` 仅含角色报告;全程无 api.github.com 请求;run.json 状态机符合预期。
- [ ] 全程无 shared 类型改动、无前端改动、无 config/routes/runManager/agentDefs 改动、无 fetch-url/download-url 工具、**无 design list 动作**。

---

## 3. 风险与回滚

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| jsDelivr 不可用(国内网络/CDN 故障) | 读/下载失败 | 三源序列回退(raw@main → raw@master);聚合错误含尝试列表与可读指引;`DESIGN_CDN_BASE` 钩子可换镜像;单测 + 端到端覆盖回退路径 |
| README 路径模式与真实仓库结构不一致(如 design-md/ 前缀变化) | read 404,判断中断 | 404 文案提示"检查路径/站点名是否与 README 一致";agent 可回读 README 自纠;read 接受任意仓库内路径,天然适配结构变化 |
| DESIGN.md 超 50KB | read 分析不完整 | read 截断 + 标记;download 直接落盘(≤5MB 硬上限,内容不进上下文),从根上规避截断 |
| 工具注册不同步(tools 数组 vs activeNames 白名单,两处注册点) | 工具不可见 | 单测断言 tools/activeNames 同步(子代理侧);主代理侧代码 review + Phase 5 冒烟;与 anySearch 落地同套路 |
| design download 不受逐代理 write 白名单约束 | 越权写工作区 | 授权 = 闸门用户确认;护栏:工作区边界(isPathWithinWorkspace)+ 只读工作区拒绝 + 固定仓库路径集合(无任意 URL)+ overwrite 默认 false + 单文件 5MB 上限;单测全覆盖 |
| jsDelivr 缓存延迟(分钟级) | 读到旧版 DESIGN.md | 设计库内容更新不频繁,可接受;文档注明;必要时 raw 兜底即为最新 |
| 子代理联网 = 行为变更 | 上下文污染/可信度 | anysearch 与 design read 均 50KB 硬截断(既有/新增);提示词要求注明"外部内容可信度自行判断";download 不回显正文 |
| md 改动后生产未重建 | 生产行为不变 | Phase 4 明确 `pnpm build`(copy-agents.mjs);dev 直接读 src 不受影响 |
| 密钥/凭据泄入上下文 | 无凭据风险 | design 工具不读取、不发送任何 token(jsDelivr/raw 无需鉴权);单测断言请求头无 Authorization |

**回滚方案**:全部改动为**增量**(2 个新文件(designTools.ts/test)+ `subAgent.ts` 两处注册 diff + `piService.ts` 一处注册 diff + 4 个 md 追加 + 1 个文档追加),无类型/结构变更。回滚 = 删除新文件 + `git checkout` 上述既有文件。Phase 1/2 可独立回滚;Phase 3 依赖 Phase 2(建议同批次);Phase 4 的 md 引用了工具,与 Phase 3 同批次回滚。`pnpm build` 产物随源码重建。已完成的 plannerMaxRetries 改动独立于本计划,不在回滚范围。

---

## 4. 备选方案(记录备查,不采用)

- **B1:design read 支持 offset 分段**——README/DESIGN.md 通常 < 50KB,截断标记已够 agent 判断;如遇超大文件,agent 可改 download 落盘后 read 本地文件(工作区内),无需工具内分段。当前不做。
- **B2:download 同时抓 preview.html / preview-dark.html**——需要枚举文件(v2 靠 trees API 实现),与"不调 GitHub API、不列目录"冲突;README 若给出 preview 路径,agent 可多次 read/download 按需获取。当前不做。
- **B3:design 工具数据源依赖 anysearch 搜索而非直接抓仓库**——搜索结果拿不到仓库内精确原始内容,无法满足"读 README 全量清单 + 精读 DESIGN.md"的精确需求;仅作 read 全失败时的补充手段(由 agent 自行决定),不内置。
