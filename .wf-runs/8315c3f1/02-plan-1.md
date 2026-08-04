# 实施计划:给 agent 添加 skills 读取能力

> 依据探索报告 `.wf-runs/8315c3f1/01-exploration-1.md`,并已复核以下关键文件与 SDK 源码:
> `promptLoader.ts` / `piService.ts` / `subAgent.ts` / `agent/routes.ts` / `config.ts` / `ChatPane.vue` / `useAgent.ts` / `packages/shared/src/index.ts` / SDK `skills.d.ts`+`skills.js` / `resource-loader.d.ts` / `source-info.js` / 测试与 package.json 脚本。

---

## 1. 目标与范围

### 做什么

1. **后端加载 skills**(`apps/api`):
   - 用 SDK `loadSkills()` 替换 `promptLoader.ts` 中硬编码空数组的 `getSkills()`,加载三个来源:
     - pi SDK 默认路径(经 `includeDefaults: true` 由 SDK 自动扫描,均不触碰 `~/.pi/agent`):
       - `<agentDir>/skills` = `.workflows/agent/skills`(SDK 语义:user 级,隔离在 .workflows 内)
       - `<workspace.path>/.pi/skills`(SDK 语义:project 级,工作区目录内)
     - `.workflows/skills`(仓库自定义约定,经 `skillPaths` 显式传入;dev = 仓库根 `.workflows/skills`,prod = `~/.workflows/skills`)
   - 主代理(`piService.ts openSession`)与子代理(`subAgent.ts runSubAgent`)共用同一 skills 加载逻辑,避免割裂。
2. **新增端点**:`GET /api/agent/workspaces/:id/skills`,返回 `SkillInfo[]`(名称 + 描述 + 来源路径 + 来源标签)。
3. **shared 类型**:`packages/shared` 新增并导出 `SkillInfo`。
4. **前端 `/` 搜索下拉**(`ChatPane.vue`):输入 `/` 弹出下拉,按名称/描述模糊匹配,键盘上下 + Enter/点击选中,选中后填入 `/skill:<name> ` 文本(由用户再回车发送,可追加参数),Esc 关闭。
5. **测试**:后端 `skillsLoader.test.ts`(加载逻辑)+ 前端 `ChatPane.test.ts`(下拉交互);同步修正因 `WorkflowsStore` 增加 `skillsDir` 字段而受影响的测试 store。

### 不做什么

- **不**手写 skills 扫描/解析:一律复用 SDK `loadSkills`(已处理 frontmatter 校验、name 回退、忽略规则、碰撞诊断、symlink 去重),避免与 SDK 行为分叉。
- **不**引入 `DefaultResourceLoader`(其 reload 走 `packageManager.resolve()` 触碰全局扩展包,违反隔离约定)。
- **不**读取 `~/.pi/agent`、`~/.agents/skills` 等 pi CLI 全局路径(SDK `loadSkills` 本身也不扫 `~/.agents/skills`,无需额外排除)。
- **不**改 `POST /prompt` 端点:SDK `session.prompt()` 已内置 `/skill:<name>` 展开与 system prompt 注入(`<available_skills>`),后端无需解析命令。
- **不**实现前端"直接发送"模式(选择后仅填入文本,按需求给的两种方案取"填入文本"以便追加参数)。
- **不**改 `getSubAgentHistory`(piService.ts:773 的历史回放会话,`tools: []`,无 read 工具,skills 不生效也无意义)。
- **不**做运行时热重载:skills 在会话创建时读入 system prompt;新增/修改 skill 需重开会话(见 §5 验证注意事项)。`reload()` 顺手实现为重新加载,但应用当前不调用它。

---

## 2. 实施步骤

### Step 1:shared 包新增 `SkillInfo` 类型

**文件**:`packages/shared/src/index.ts`

在 `AgentConfig` 附近新增并导出:

```ts
/**
 * 前端可用的 skill 摘要(供输入框 / 搜索调用)
 */
export interface SkillInfo {
  /** skill 名(/skill:<name> 调用时的名字) */
  name: string
  /** 描述(frontmatter description 必填,缺失不加载) */
  description: string
  /** skill 文件绝对路径(SKILL.md 或根目录散落 .md) */
  filePath: string
  /** skill 所在目录绝对路径 */
  baseDir: string
  /** 来源标签:user(.workflows/agent/skills)/ project(工作区 .pi/skills)/ workflows(.workflows/skills)/ path(其他) */
  source: string
  /** 来源目录绝对路径(即 baseDir,前端展示用) */
  sourcePath: string
  /** true 时不注入 system prompt,只能 /skill:name 显式调用 */
  disableModelInvocation: boolean
}
```

**预期结果**:`pnpm --filter @workflows/shared build` 后 `dist/index.d.ts` 导出 `SkillInfo`(api/web 消费的是 dist,**必须先 build 再继续**)。

### Step 2:`WorkflowsStore` 增加 `skillsDir`

**文件**:`apps/api/src/config.ts`

- `WorkflowsStore` 接口新增 `skillsDir: string`。
- `createStore()` 中:`const skillsDir = path.join(root, 'skills'); ensureDir(skillsDir)`,并写入返回对象(与 `agentsDir` 对称;`.workflows/` 已在 .gitignore,建空目录无 git 噪音)。

**连带修改**(手动构造 store 的测试,编译期强制):
- `apps/api/src/config.test.ts` 的 `createTestStore()`:补 `skillsDir: path.join(root, 'skills')`。
- `apps/api/src/pi/piService.test.ts`(约 49 行处 store 构造):补 `skillsDir`。
- `apps/api/src/pi/agentDefs.test.ts`(89/102 行用 `as never` 构造)无需改。

**预期结果**:`pnpm --filter @workflows/api typecheck` 通过。

### Step 3:扩展 `promptLoader.ts` 的 `getSkills()`

**文件**:`apps/api/src/pi/promptLoader.ts`

1. 新增 import:从 `@earendil-works/pi-coding-agent` 导入 `loadSkills`、`type Skill`、`type LoadSkillsResult`;从 `@workflows/shared` 导入 `SkillInfo`。

2. 新增上下文与加载函数(核心逻辑,端点与 loader 共用,保证单一事实源):

```ts
/** skills 加载上下文(三个来源的根) */
export interface SkillLoadContext {
  /** 工作区目录(用于 cwd/.pi/skills) */
  cwd: string
  /** store.agentDir(.workflows/agent,用于 agentDir/skills) */
  agentDir: string
  /** store.skillsDir(.workflows/skills) */
  skillsDir: string
}

/** 用 SDK loadSkills 加载全部来源;diagnostics 记日志但不抛错(坏 skill 跳过,不阻断会话) */
export function loadWorkspaceSkills(ctx: SkillLoadContext): LoadSkillsResult {
  const result = loadSkills({
    cwd: ctx.cwd,
    agentDir: ctx.agentDir,
    skillPaths: [ctx.skillsDir],
    includeDefaults: true, // SDK 默认路径:agentDir/skills + cwd/.pi/skills
  })
  for (const d of result.diagnostics) {
    console.warn(`[skills] ${d.type}: ${d.message} (${d.path})`)
  }
  return result
}

/** Skill → SkillInfo:按 baseDir 归属分类来源标签 */
export function toSkillInfo(skill: Skill, ctx: SkillLoadContext): SkillInfo {
  const baseDir = skill.baseDir
  const source = isUnder(baseDir, path.join(ctx.agentDir, 'skills'))
    ? 'user'
    : isUnder(baseDir, path.join(ctx.cwd, '.pi', 'skills'))
      ? 'project'
      : isUnder(baseDir, ctx.skillsDir)
        ? 'workflows'
        : 'path'
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir,
    source,
    sourcePath: baseDir,
    disableModelInvocation: skill.disableModelInvocation,
  }
}
```

(`isUnder(target, root)` 为本地小工具:绝对路径前缀比较,参照 SDK skills.js 中 `isUnderPath` 的写法,含 `root` 自身与分隔符边界;放本文件底部。)

3. 改造 `createPromptOnlyLoader`:签名从 `(systemPrompt?, appendSystemPrompt?)` 改为 options 对象(仅 2 个调用方,一并迁移,无兼容负担):

```ts
export interface PromptOnlyLoaderOptions {
  systemPrompt?: string
  appendSystemPrompt?: string[]
  /** 提供则 getSkills 返回真实加载结果;缺省保持空(现状) */
  skills?: SkillLoadContext
}

export function createPromptOnlyLoader(options: PromptOnlyLoaderOptions = {}): ResourceLoader {
  let skillsResult: LoadSkillsResult = options.skills
    ? loadWorkspaceSkills(options.skills)
    : { skills: [], diagnostics: [] }
  return {
    // ……其余方法保持现状……
    getSkills: () => skillsResult,
    reload: async () => {
      if (options.skills) skillsResult = loadWorkspaceSkills(options.skills)
    },
  } as unknown as ResourceLoader
}
```

**预期结果**:`getSkills()` 返回真实 skills;`/skill:<name>` 展开与 `<available_skills>` system prompt 注入由 SDK 会话层自动完成(主/子代理 active tools 均含 `read`,满足注入条件)。

### Step 4:`piService.ts` 换用新 loader + 新增 `listSkills()`

**文件**:`apps/api/src/pi/piService.ts`

1. 第 293 行主代理 loader 改为:

```ts
const mainResourceLoader = createPromptOnlyLoader({
  appendSystemPrompt: orchestrator ? [orchestrator.body] : undefined,
  skills: { cwd: workspace.path, agentDir: this.store.agentDir, skillsDir: this.store.skillsDir },
})
```

2. 新增公开方法(供路由调用;每次请求现扫现返回,保证前端列表始终最新):

```ts
/** 工作区可用 skills(前端输入框 / 搜索;每次现扫,新增 skill 立即可见) */
listSkills(workspace: Workspace): SkillInfo[] {
  const ctx = { cwd: workspace.path, agentDir: this.store.agentDir, skillsDir: this.store.skillsDir }
  return loadWorkspaceSkills(ctx).skills.map((s) => toSkillInfo(s, ctx))
}
```

- import 相应更新:`createPromptOnlyLoader` 改为 options 调用;新增 `loadWorkspaceSkills`/`toSkillInfo` import;`SkillInfo` 加入 `@workflows/shared` 类型 import。

**预期结果**:主代理会话创建时 `_rebuildSystemPrompt()` 读到的 `getSkills()` 含三来源 skills;`listSkills()` 可被路由调用。

### Step 5:`subAgent.ts` 共用同一 skills 加载

**文件**:`apps/api/src/pi/subAgent.ts`

第 346 行改为:

```ts
const resourceLoader = createPromptOnlyLoader({
  systemPrompt: definition.body,
  skills: { cwd: workspace.path, agentDir: store.agentDir, skillsDir: store.skillsDir },
})
```

**预期结果**:子代理(explorer/planner/executor/reviewer/自定义)同样获得 skills,主/子代理不再割裂。

### Step 6:新增 `GET /api/agent/workspaces/:id/skills`

**文件**:`apps/api/src/agent/routes.ts`

在「会话」区块(`open` 附近)新增:

```ts
// 工作区可用 skills 列表(输入框 / 搜索数据源)
app.get('/api/agent/workspaces/:id/skills', (c) => {
  const workspace = requireWorkspace(store, c.req.param('id'))
  return c.json({ code: 0, message: 'ok', data: pi.listSkills(workspace) })
})
```

统一响应结构 `{code, message, data}` 与现有端点一致;404 语义由 `requireWorkspace` 保证。

**预期结果**:`curl http://localhost:3000/api/agent/workspaces/<id>/skills` 返回 `SkillInfo[]`。

### Step 7:前端 store 增加 skills 状态

**文件**:`apps/web/src/composables/useAgent.ts`

1. `import type { ..., SkillInfo } from '@workflows/shared'`。
2. 新增 `const skills = ref<SkillInfo[]>([])`。
3. 新增:

```ts
/** 拉取当前工作区 skills(输入框 / 搜索);失败静默置空,不阻塞聊天 */
async function refreshSkills(): Promise<void> {
  const workspaceId = activeWorkspaceId.value
  if (!workspaceId) { skills.value = []; return }
  try {
    skills.value = await request<SkillInfo[]>(`/api/agent/workspaces/${workspaceId}/skills`)
  } catch {
    skills.value = []
  }
}
```

4. `openWorkspace()` 中,`applySessionData(data)` 之后调用 `await refreshSkills()`(可并入现有 `await refreshRun()` 的 Promise.all)。
5. return 中导出 `skills` 与 `refreshSkills`。

**预期结果**:`agent.skills.value` 在打开工作区后填充;未选工作区为空数组。

### Step 8:`ChatPane.vue` 增加 `/` 搜索下拉

**文件**:`apps/web/src/components/ChatPane.vue`

**状态与计算**:

```ts
const skillMenuOpen = ref(false)
const skillIndex = ref(0)                    // 高亮项下标(循环)
const skillQuery = computed(() => (draft.value.startsWith('/') ? draft.value.slice(1) : ''))
const allSkills = computed(() => props.agent.skills.value)

/** 模糊匹配:名称前缀 > 名称包含 > 描述包含;取前 8 条 */
const filteredSkills = computed(() => {
  if (!skillMenuOpen.value) return []
  const q = skillQuery.value.trim().toLowerCase()
  const scored: Array<{ s: SkillInfo; rank: number }> = []
  for (const s of allSkills.value) {
    const name = s.name.toLowerCase()
    const desc = s.description.toLowerCase()
    if (q && !name.includes(q) && !desc.includes(q)) continue
    const rank = q ? (name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2) : 0
    scored.push({ s, rank })
  }
  return scored.sort((a, b) => a.rank - b.rank || a.s.name.localeCompare(b.s.name)).slice(0, 8).map((x) => x.s)
})
```

**打开/关闭逻辑**:
- `watch(skillQuery)`:`draft` 以 `/` 开头、非流式(`!props.agent.streaming.value`)、有匹配(或 query 为空=全量)时打开,否则关闭;打开时 `skillIndex.value = 0`。
- `watch(() => props.agent.activeWorkspaceId.value)`:切工作区时关闭菜单。
- textarea `@blur`:关闭菜单(点击下拉项用 `@mousedown.prevent` 保持 textarea 焦点,不触发 blur)。

**键盘扩展**(在现有 `onKeydown` 开头,菜单打开且有匹配项时优先拦截;保留 `event.isComposing` 守卫):
- `ArrowDown` / `ArrowUp`:`preventDefault`,`skillIndex` 循环 +1 / -1。
- `Enter`:`preventDefault`,选中高亮项(不发送),不落入原有"回车即发送"分支。
- `Escape`:关闭菜单,`preventDefault`。
- 菜单打开但无匹配项:Enter/Esc 走原有逻辑(关闭菜单后正常发送/忽略)。

**选中动作**:

```ts
function selectSkill(skill: SkillInfo) {
  draft.value = `/skill:${skill.name} `
  skillMenuOpen.value = false
  nextTick(() => textareaRef.value?.focus())   // 保持焦点,用户可追加参数后回车
}
```

**模板**:
- 给 textarea 包一层 `<div class="relative flex-1">`(替换原 textarea 上的 `flex-1`),textarea 加 `ref="textareaRef"`。
- 下拉容器:`absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-64 overflow-y-auto rounded-md border border-hairline bg-canvas shadow-lg`(输入区在底部,下拉向上弹;z 高于闸门面板)。
- 每项:`<button>` 展示 `name`(mono 字体)+ `description`(单行截断)+ 来源标签(`source` → 中文:user=全局、project=工作区、workflows=工作台、path=其他),`:class` 高亮 `skillIndex === i`;`@mousedown.prevent="selectSkill(s)"`。
- 无匹配时显示一行"无匹配 skill"(仍可 Esc/回车关闭)。

**预期结果**:输入 `/` 弹出列表,方向键/回车/Esc/点击行为符合需求;选中的 `/skill:name ` 作为普通文本走 `handleSend` 发送(后端 SDK 自动展开)。

### Step 9:测试

**新增 `apps/api/src/pi/skillsLoader.test.ts`**(核心逻辑单测,仿 `agentDefs.test.ts` 的临时目录模式):
- 用临时目录手工构造 `WorkflowsStore`(含 `skillsDir`,隔离仓库 `.workflows`)+ 临时 workspace 目录;`afterEach` 清理。
- 用例:
  1. `.workflows/skills/<name>/SKILL.md`(带 frontmatter name/description)→ 被加载,`source === 'workflows'`;
  2. `.workflows/agent/skills/<name>/SKILL.md` → `source === 'user'`;
  3. `<workspace>/.pi/skills/<name>/SKILL.md` → `source === 'project'`;
  4. 根目录散落 `.md`(frontmatter 有 name)→ 加载;无 name → 回退目录名(即父目录名,注意散落文件会回退为 `.workflows/skills` 的目录名,文档化该行为,建议用 SKILL.md 目录式或写 name);
  5. 缺 description → 不加载 + diagnostics 警告;
  6. 两个来源同名 → 先到者胜(碰撞诊断,不抛错);
  7. 目录不存在 → 空结果不抛错;
  8. `toSkillInfo` 映射字段完整(name/description/filePath/baseDir/source/sourcePath/disableModelInvocation);
  9. `createPromptOnlyLoader({ skills: ctx }).getSkills()` 返回加载结果;不带 skills 时仍返回空(回归)。

**新增 `apps/web/src/components/ChatPane.test.ts`**(仿 `WorkspacePickerModal.test.ts`):
- stub `AgentStore`:`ref()` 包住 `messages/streaming/activeWorkspaceId/activeWorkspace/status/gateRequest/hasApiKey/config/skills` 等模板用到的字段,方法用 `vi.fn()`(`sendMessage/abort/dismissGate/switchModel/switchThinking`),`subSessions` 用 `reactive(new Map())`,`as unknown as AgentStore` 强转。
- 用例:
  1. 输入 `/` → 下拉出现,列出全部 skills;
  2. 输入 `/plan` → 只显示名称/描述匹配的项;
  3. `ArrowDown` + `Enter` → `draft` 变为 `/skill:<选中名> ` 且**未**调用 `sendMessage`;
  4. `Escape` → 关闭下拉;
  5. 点击项 → `draft` 填入 `/skill:<名> `;
  6. 无匹配 → 显示空态且 Enter 走正常发送;
  7. 切工作区 → 菜单关闭(可选)。

**修改受影响测试**:`apps/api/src/config.test.ts`、`apps/api/src/pi/piService.test.ts` 的 store 构造补 `skillsDir`(Step 2 已列)。

**预期结果**:`pnpm --filter @workflows/api test`、`pnpm --filter @workflows/web test` 全绿。

### Step 10(可选):文档

- 在 `README.md` 或 `docs/` 的 skills 小节说明:`SKILL.md` 格式(frontmatter 必填 `description`、可选 `name`/`disable-model-invocation`)、三个来源目录、新增后需重开会话、安全提示(skills 是任意指令,沿用"review before use")。

---

## 3. 验证方式

### 命令

```bash
# 1. shared 先构建(api/web 消费 dist)
pnpm --filter @workflows/shared build

# 2. 类型检查 / lint / 单测 / 全量构建(建议按此顺序)
pnpm typecheck
pnpm lint
pnpm --filter @workflows/api test
pnpm --filter @workflows/web test
pnpm build        # 含 copy-agents.mjs 复制 agents/*.md 到 dist

# 3. 本地手动验证
pnpm dev          # web 15200 / api 3000
```

### 手动验证清单

1. **准备 skills**(三来源各一个):
   - `.workflows/skills/greet/SKILL.md`:`---\nname: greet\ndescription: 用中文打招呼\n---\n<正文指令>`
   - `.workflows/agent/skills/summarize/SKILL.md`(同上格式)
   - 在某工作区目录建 `.pi/skills/refactor/SKILL.md`
2. 打开 web → 选择该工作区 → 输入框输入 `/` → 下拉出现三个 skill(名称 + 描述 + 来源);输入 `/gre` 过滤到 `greet`。
3. `ArrowDown` 移动高亮 → `Enter` → 输入框变为 `/skill:greet `(未发送);追加文字后 `Enter` 发送 → 用户消息显示 `/skill:greet <追加>`(前端按原始文本渲染,后端实际展开为 `<skill>` 块,此为已知展示差异,非缺陷)。
4. 直接输入 `/skill:summarize` 发送 → 模型按 skill 指令执行;输入 `/skill:不存在的` → 原样透传不报错。
5. 子代理可用性:让主代理调用 explorer/planner,其 system prompt 同样含 `<available_skills>`(可在子代理会话历史中验证其按 skill 工作)。
6. **注意事项**:新增/修改 skill 后,**下拉列表**重开工作区(或刷新页面)即更新(端点现扫);但**模型要感知 skill 必须重开会话**(新建会话或重启 api)——skills 在 `createAgentSession` 时读入 system prompt,`/skill:name` 展开则始终即时可用(读文件不依赖会话)。
7. 回归:不输入 `/` 时聊天、闸门、子代理模态窗行为不变;无 skills 时下拉不出现,`getSkills()` 空结果路径与现状一致。

---

## 4. 风险与回滚方案

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| skills 注入膨胀 system prompt、模型行为变化 | 低 | SDK 仅在 active tools 含 `read` 时注入 `<available_skills>`;`disable-model-invocation` 可完全排除;功能整体是增量的 |
| 工作区 `.pi/skills` 纳入不可信内容 | 低 | 这正是需求 1 的 SDK 默认语义;如不想要可一行改为 `includeDefaults: false` + 显式 `skillPaths: [agentDir/skills, skillsDir]`(计划中留此开关) |
| `createPromptOnlyLoader` 签名变更 | 低 | 全仓仅 2 个调用方(已 grep 确认),编译期强制迁移 |
| `WorkflowsStore` 加字段破坏手工构造的测试 store | 低 | 仅 `config.test.ts` / `piService.test.ts` 两处(已定位行号),tsc 兜底 |
| 前端下拉与 IME 输入冲突 | 低 | 键盘处理保留 `event.isComposing` 守卫(现有 Enter 已如此);`@mousedown.prevent` 避免 blur 先于点击 |
| 新增 skill 后旧会话感知不到 | 已知行为 | 文档化 + 手动验证清单第 6 条;`reload()` 已实现重载(应用当前不调用,预留) |

**回滚方案**:
- 每个 Step 独立提交;回滚时按提交逐个 revert,无数据迁移、无 schema 变更。
- 最坏情况:仅 revert Step 3–6(后端)即回到"skills 全空"现状(前端下拉因列表为空自然不出现,`ChatPane` 改动无需回滚也不会报错);shared 的 `SkillInfo` 为纯新增类型,保留无害。

---

## 5. 验收标准(逐条核对)

- [ ] `packages/shared` 导出 `SkillInfo`(name/description/filePath/baseDir/source/sourcePath/disableModelInvocation),rebuild 后 api/web 可引用。
- [ ] `WorkflowsStore` 含 `skillsDir`,`createStore()` 创建 `.workflows/skills`;`config.test.ts`/`piService.test.ts` 测试 store 已同步。
- [ ] `promptLoader.ts`:`createPromptOnlyLoader({ skills: ctx })` 的 `getSkills()` 返回 `loadSkills({ cwd, agentDir, skillPaths:[skillsDir], includeDefaults:true })` 结果;缺省(无 skills ctx)仍返回空;`reload()` 重载 skills;diagnostics 记 `console.warn` 不抛错。
- [ ] 主代理(`piService.ts openSession`)与子代理(`subAgent.ts runSubAgent`)均传入同一 `SkillLoadContext` 结构,主/子代理 skills 一致。
- [ ] `GET /api/agent/workspaces/:id/skills` 返回 `{code:0,message:'ok',data:SkillInfo[]}`;未知工作区返回 404 统一结构。
- [ ] `useAgent.ts`:`skills` ref + `refreshSkills()`;`openWorkspace()` 时刷新;失败静默置空。
- [ ] `ChatPane.vue`:输入 `/` 弹出下拉(名称/描述模糊匹配,前缀优先,最多 8 条);`ArrowDown/Up` 循环高亮;`Enter` 选中填入 `/skill:<name> ` 且不发送;`Esc` 关闭;点击选中;`@blur`/切工作区关闭;流式中不弹出;IME 组合输入不误触。
- [ ] 发送 `/skill:<name>` 后,后端 SDK 自动展开为 `<skill>` 块(会话内模型可读到 SKILL.md 内容),不存在的 skill 原样透传。
- [ ] 三来源验证通过:`.workflows/skills`、`.workflows/agent/skills`、`<workspace>/.pi/skills` 均被加载,`source` 标签分别为 workflows / user / project。
- [ ] 新增 skill 后:下拉刷新即见;模型感知需重开会话(已文档化)。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm --filter @workflows/api test`、`pnpm --filter @workflows/web test`、`pnpm build` 全部通过;新增 `skillsLoader.test.ts` 与 `ChatPane.test.ts` 覆盖上述核心行为。
