# 实施计划(修订版):给 agent 添加 skills 读取能力 —— 四来源(含工作区外)

> 基于 `.wf-runs/8315c3f1/02-plan-1.md` 修订。修订动因:用户明确要求 agent 必须能读取**工作区之外**的 skills —— `~/.pi/agent/skills` 与 `~/.agents/skills`,以及 `.workflows/skills`(共四来源)。
>
> 已复核:探索报告 `01-exploration-1.md`、原计划 `02-plan-1.md`、SDK 源码(`dist/core/skills.js`、`dist/config.js`、`dist/utils/paths.js`、`dist/core/source-info.js`、`dist/index.d.ts`)、仓库文件(`promptLoader.ts`、`config.ts`、`piService.ts:293`、`subAgent.ts:346`、`routes.ts`、`packages/shared/src/index.ts`、`useAgent.ts`、`ChatPane.vue`)。
>
> **SDK 事实(已逐条源码核实,直接采用)**:
> - `loadSkills({ cwd, agentDir, skillPaths, includeDefaults })`:`agentDir` 运行时缺省(`agentDir ?? getAgentDir()`,`skills.js`),**类型声明为必填**(`skills.d.ts`),调用时省略需窄化断言。
> - `getAgentDir()`(`config.js`):**优先读 `process.env.PI_CODING_AGENT_DIR`**(`ENV_AGENT_DIR = PI_CODING_AGENT_DIR`),未设置时 `join(homedir(), '.pi', 'agent')`。该环境变量是 SDK 官方覆盖机制,**同时是测试隔离的关键钩子**。`getAgentDir` 从包根导出(`index.d.ts` 已确认)。
> - `includeDefaults: true` 扫描:`<agentDir>/skills`(source="user",sourceInfo.scope=`"user"`)+ `<cwd>/.pi/skills`(source="project",scope=`"project"`)。
> - `skillPaths`:`resolvePath(rawPath, resolvedCwd, { trim: true })` 解析,相对路径以 cwd 为基,`~` 经 `homedir()` 展开(Windows 兼容 `~/` 与 `~\`);显式路径 source 恒为 `"path"` → `sourceInfo = { source: "local", scope: "temporary", baseDir }`(scope 无 user/project);目录不存在 → warning 诊断("skill path does not exist")不抛错;同文件 symlink 去重(realpathSet)、同名冲突先到先得 + collision 诊断。
> - 发现规则与忽略:目录含 `SKILL.md` 即整目录一个 skill(不递归);否则根下散落 `.md`;递归子目录找 `SKILL.md`;跳过 `node_modules` 与 `.` 开头项;每个被扫目录读取自身 `.gitignore/.ignore/.fdignore`(ignore 包,规则按扫描根前缀化)。非 git 目录无 ignore 文件则不过滤。
> - `Skill = { name, description, filePath, baseDir, sourceInfo, disableModelInvocation }`;frontmatter `description` 缺失不加载;`name` 缺省回退父目录名。
> - `session.prompt()` 内置 `/skill:<name>` 展开;`_rebuildSystemPrompt()` 自动注入 `<available_skills>`(active tools 含 `read` 时;`disableModelInvocation` 除外)。

---

## 1. 目标与范围

### 做什么

1. **后端加载 skills**(`apps/api`):用 SDK `loadSkills()` 替换 `promptLoader.ts` 中硬编码空数组的 `getSkills()`,加载**四个来源**:

   | 来源 | 目录 | 加载方式 | SDK scope | SkillInfo.source |
   | --- | --- | --- | --- | --- |
   | (a) pi 全局 | `~/.pi/agent/skills`(Windows:`C:\Users\<user>\.pi\agent\skills`) | `includeDefaults: true` 且**不传 agentDir**(SDK 默认 `getAgentDir()`),SDK 自动扫描 | user | `pi-agent` |
   | (b) 项目 | `<工作区>/.pi/skills` | `includeDefaults: true` 附带(`cwd = workspace.path`) | project | `pi-project` |
   | (c) 工作台 | `<root>/.workflows/skills`(dev=仓库根,prod=`~/.workflows`) | `skillPaths` 显式传 `store.skillsDir`(绝对路径) | temporary | `workspace` |
   | (d) 全局 agents | `~/.agents/skills` | `skillPaths` 显式传(自行用 `os.homedir()` 展开为绝对路径;SDK `resolvePath` 同样支持 `~` 展开,两者等价,显式展开便于测试注入) | temporary | `global-agents` |

   - 主代理(`piService.ts openSession`)与子代理(`subAgent.ts runSubAgent`)共用同一加载逻辑。
2. **新增端点**:`GET /api/agent/workspaces/:id/skills`,返回 `SkillInfo[]`(名称/描述/来源分类/来源路径)。
3. **shared 类型**:`packages/shared` 新增并导出 `SkillInfo` 与 `SkillSource`(含来源分类字段)。
4. **前端 `/` 搜索下拉**(`ChatPane.vue`):输入 `/` 弹出下拉,按名称/描述模糊匹配,键盘上下 + Enter/点击选中,选中后填入 `/skill:<name> ` 文本(用户再回车发送,可追加参数),Esc 关闭;下拉项显示来源标签。
5. **测试**:后端 `skillsLoader.test.ts`(**四来源全覆盖**,用 `PI_CODING_AGENT_DIR` 环境变量 + 注入 `homeDir` 隔离真实用户目录)+ 前端 `ChatPane.test.ts`;同步修正因 `WorkflowsStore` 增加 `skillsDir` 受影响的测试 store。

### 不做什么

- **不**手写 skills 扫描/解析:一律复用 SDK `loadSkills`。
- **不**引入 `DefaultResourceLoader`(其 reload 走 `packageManager.resolve()` 触碰全局扩展包)。
- **不**读 pi 的其他全局来源:settings `skills` 数组、包级 `package.json pi.skills`、`<cwd>/.agents/skills`(项目级 agents 约定)、CLI `--skill` —— SDK `loadSkills` 本身不覆盖,保持现状。
- **不**写任何全局路径:`~/.pi/agent`、`~/.agents/skills` 仅**只读**;本应用自身运行数据仍全部存 `.workflows/`。
- **不**改 `POST /prompt` 端点:SDK `session.prompt()` 已内置 `/skill:<name>` 展开与 `<available_skills>` 注入。
- **不**实现前端"直接发送"模式(选择后仅填入文本)。
- **不**改 `getSubAgentHistory`(piService.ts 的历史回放会话,`tools: []`,无 read 工具)。
- **不**做运行时热重载:skills 在会话创建时读入 system prompt;新增/修改 skill 需重开会话(§4 验证注意事项)。
- **`.workflows/agent/skills` 不再作为来源**(原计划 Step 3 的三来源之一)——建议**去掉**,理由见 §2.4。

---

## 2. 关键设计决策(修订点)

### 2.1 `loadSkills` 调用方式(四来源核心)

```ts
// promptLoader.ts 内部(loadWorkspaceSkills)
const result = loadSkills({
  cwd: ctx.cwd,                       // 工作区路径 → <cwd>/.pi/skills(来源 b)
  skillPaths: [
    ctx.skillsDir,                    // .workflows/skills(来源 c,绝对路径)
    path.join(homeDir(ctx), '.agents', 'skills'),  // ~/.agents/skills(来源 d,显式展开)
  ],
  includeDefaults: true,              // 来源 a(~/.pi/agent/skills)+ 来源 b(<cwd>/.pi/skills)
  // 注意:agentDir 有意不传 → SDK 内部 agentDir ?? getAgentDir() 取默认 ~/.pi/agent
  // LoadSkillsOptions 类型声明 agentDir 为必填,但运行时支持缺省(skills.js 已核实),故窄化断言
} as Parameters<typeof loadSkills>[0])
```

- `LoadSkillsOptions` 未从包根导出(已核实 `index.d.ts` 只导出 `loadSkills` 本体),用 `Parameters<typeof loadSkills>[0]` 做断言,避免深路径 import。
- 生产环境 `getAgentDir()` = `~/.pi/agent`;若用户设置 `PI_CODING_AGENT_DIR`,SDK 自动重定向(与 pi CLI 同机制),文档中注明。

### 2.2 `SkillLoadContext`(原计划含 agentDir,现改为)

```ts
export interface SkillLoadContext {
  /** 工作区目录(来源 b 的 cwd,同时是 skillPaths 相对解析基准) */
  cwd: string
  /** store.skillsDir = <root>/.workflows/skills(来源 c) */
  skillsDir: string
  /** 用户主目录(缺省 os.homedir();测试注入临时 home 以隔离 ~/.agents/skills) */
  homeDir?: string
}
// homeDir(ctx) = ctx.homeDir ?? os.homedir()
```

- **不再有 agentDir 字段**:SDK 默认路径交给 SDK 自己解析(不传 agentDir)。
- `store.agentDir`(`.workflows/agent`)仍用于会话 JSONL 等既有用途,不受影响。

### 2.3 SkillInfo 来源分类(来源分类字段)

`sourceInfo.scope` 事实:`user` 仅来自 includeDefaults 的 `<agentDir>/skills`(来源 a);`project` 仅来自 `<cwd>/.pi/skills`(来源 b);`skillPaths` 显式来源 scope 恒为 `"temporary"`(来源 c/d 无法靠 scope 区分,需路径判断)。据此分类:

```ts
export type SkillSource = 'pi-agent' | 'pi-project' | 'workspace' | 'global-agents' | 'path'

export function classifySkillSource(skill: Skill, ctx: SkillLoadContext): SkillSource {
  const scope = skill.sourceInfo.scope
  if (scope === 'user') return 'pi-agent'          // 唯一 user 来源 = ~/.pi/agent/skills
  if (scope === 'project') return 'pi-project'     // 唯一 project 来源 = <cwd>/.pi/skills
  // 显式 skillPaths(scope='temporary'):按我们传入的根做路径归属
  const base = path.resolve(skill.baseDir)
  if (isUnder(base, path.resolve(ctx.skillsDir))) return 'workspace'
  if (isUnder(base, path.resolve(homeDir(ctx), '.agents', 'skills'))) return 'global-agents'
  return 'path'                                    // 兜底(理论上不应出现)
}
```

- 默认来源(user/project)用 SDK 自己的 scope(单一事实源),显式来源用路径判断(只比较我们**自己传入**的根,无 SDK 逻辑复制风险)。
- `isUnder(target, root)`:本地小工具,`path.resolve` 后做分隔符边界前缀比较;Windows 上折叠大小写(参照 `config.ts` 已有 `samePath` 的大小写策略;SDK 自身 `isUnderPath` 不折叠,但我们的 baseDir 与根都由同一次 join 产生,大小写一致,折叠仅为防御)。
- 前端标签映射:`pi-agent` → `全局(pi)`;`pi-project` → `项目`;`workspace` → `工作台`;`global-agents` → `全局(agents)`;`path` → `其他`。

### 2.4 `.workflows/agent/skills` 去留建议 —— **去掉**

原计划把它当"user 级全局 skills 在 .workflows 内的隔离替身"(当时约定不触碰 `~/.pi/agent`)。现在真实全局路径已明确纳入,建议不再作为来源:

1. 用户给出的四来源清单不含它;保留则 SkillSource 需第五个值 `workflows-agent`,分类、前端标签、文档全部变复杂。
2. 原"隔离"动机已不存在(读取 `~/.pi/agent` 是明确需求);读取是只读的,不违反"运行数据仍存 .workflows"。
3. 恢复成本极低:`skillPaths` 加一行 + 分类加一个分支;若 `.workflows/agent/skills` 已有存量内容,迁移方式:复制到 `.workflows/skills` 或 `~/.pi/agent/skills`(该目录此前从未被加载,无兼容性负担)。

### 2.5 工作区外路径的权限/沙箱确认(需求 3)

- **无沙箱问题**:Hono 服务端是普通 Node 进程,直接 `fs` 同步读;读用户主目录子目录与读仓库内目录无权限差异(同一 OS 用户)。`~/.pi/agent`、`~/.agents/skills` 位于 `C:\Users\kaijia\` 下,当前用户可读。
- **异常兜底**:SDK `loadSkillsFromDirInternal` 整体 try/catch(返回空 + 无诊断),`loadSkills` 对 skillPaths 也有 try/catch → warning 不抛错。权限异常最多表现为列表为空,不会崩会话。
- **ignore 规则**:SDK 尊重每个被扫目录自身的 `.gitignore/.ignore/.fdignore`;`~/.pi/agent/skills` 与 `~/.agents/skills` 若含 ignore 文件同样生效;非 git 目录无 ignore 文件则不过滤。
- **路径注入面**:四个来源根全部硬编码在代码里(store.skillsDir 来自 createStore、cwd 来自已登记工作区、homeDir 来自 os.homedir()/测试注入),不随用户输入变化;`listSkills` 端点只读、不改任何状态、不落盘。

### 2.6 诊断噪音处理

`~/.agents/skills` 在多数机器上不存在 → 每次会话创建 SDK 都会产生 "skill path does not exist" warning。处理:`logSkillDiagnostics()` 把该消息过滤为 `console.debug`,其余诊断保持 `console.warn`(坏 skill 跳过、不阻断)。

### 2.7 测试隔离具体做法(需求 5)

两个可控点,无需 mock、不触碰真实用户目录:

1. **来源 a(`~/.pi/agent/skills`)**:SDK `getAgentDir()` 优先读 `process.env.PI_CODING_AGENT_DIR`(官方机制,已核实 `config.js`)。测试用 `vi.stubEnv('PI_CODING_AGENT_DIR', path.join(tmpHome, 'pi-agent'))` 重定向到临时目录;`loadSkills` 每次调用时才读 env,per-test 设置即可生效。
2. **来源 d(`~/.agents/skills`)**:我们的代码 `homeDir(ctx) = ctx.homeDir ?? os.homedir()`,测试传 `homeDir: tmpHome` 即可。
3. 临时目录:`mkdtemp` 建 `tmpHome`(含 `pi-agent/skills/<n>/SKILL.md` 与 `.agents/skills/<n>/SKILL.md`)+ 临时 store 根(含 `skills`)+ 临时 workspace(含 `.pi/skills/<n>/SKILL.md`);`afterEach` 恢复 env + `rmSync(tmpHome, { recursive: true, force: true })`。
4. 备选方案(不推荐,仅记录):`vi.mock('@earendil-works/pi-coding-agent', (orig) => ({ ...orig, getAgentDir: () => fakeAgentDir }))` —— env 方案零 mock 且顺带验证 SDK 官方覆盖机制,优先。
5. 注意:vitest 默认每个测试文件独立 worker;单文件内测试串行,`vi.stubEnv` 自动恢复,无串扰。测试内只调用 `loadSkills`/`loadWorkspaceSkills`,不触发 SDK 其他读 `~/.pi/agent` 的路径(如 sessions),无副作用。

---

## 3. 实施步骤

> 执行顺序不变:shared 先 build(api/web 消费 dist)。每步独立提交,便于回滚。

### Step 1:shared 包新增 `SkillInfo` + `SkillSource`

**文件**:`packages/shared/src/index.ts`(在 `AgentConfig` 附近)

```ts
/** skill 来源分类(前端下拉展示) */
export type SkillSource = 'pi-agent' | 'pi-project' | 'workspace' | 'global-agents' | 'path'

/** 前端可用的 skill 摘要(供输入框 / 搜索调用) */
export interface SkillInfo {
  /** skill 名(/skill:<name> 调用时的名字) */
  name: string
  /** 描述(frontmatter description 必填,缺失不加载) */
  description: string
  /** skill 文件绝对路径(SKILL.md 或根目录散落 .md) */
  filePath: string
  /** skill 所在目录绝对路径 */
  baseDir: string
  /** 来源分类:pi-agent(~/.pi/agent/skills)/ pi-project(<cwd>/.pi/skills)/ workspace(.workflows/skills)/ global-agents(~/.agents/skills)/ path(其他) */
  source: SkillSource
  /** 来源目录绝对路径(= baseDir,前端展示用) */
  sourcePath: string
  /** true 时不注入 system prompt,只能 /skill:name 显式调用 */
  disableModelInvocation: boolean
}
```

**预期结果**:`pnpm --filter @workflows/shared build` 后 `dist/index.d.ts` 导出 `SkillInfo`/`SkillSource`(api/web 消费 dist,**必须先 build 再继续**)。

### Step 2:`WorkflowsStore` 增加 `skillsDir`

**文件**:`apps/api/src/config.ts`

- `WorkflowsStore` 接口新增 `skillsDir: string`。
- `createStore()` 中:`const skillsDir = path.join(root, 'skills'); ensureDir(skillsDir)`,写入返回对象(与 `agentsDir` 对称;`.workflows/` 已在 .gitignore)。

**连带修改**(编译期强制,已定位):
- `apps/api/src/config.test.ts` 的 `createTestStore()`:补 `skillsDir: path.join(root, 'skills')`。
- `apps/api/src/pi/piService.test.ts`(约 49 行 store 构造):补 `skillsDir`。
- `apps/api/src/pi/agentDefs.test.ts`(用 `as never` 构造)无需改。

**验证**:`pnpm --filter @workflows/api typecheck` 通过。

### Step 3:扩展 `promptLoader.ts`(核心逻辑)

**文件**:`apps/api/src/pi/promptLoader.ts`

1. import:`loadSkills`、`type Skill`、`type LoadSkillsResult`、`type ResourceDiagnostic`(来自 `@earendil-works/pi-coding-agent`);`SkillInfo`、`SkillSource`(来自 `@workflows/shared`);`os.homedir`、`node:path`。
2. 新增上下文与加载/分类/映射函数(端点与 loader 共用,单一事实源):

```ts
/** skills 加载上下文(四个来源的根;agentDir 不传,SDK 默认 ~/.pi/agent) */
export interface SkillLoadContext {
  cwd: string          // 工作区目录
  skillsDir: string    // store.skillsDir = <root>/.workflows/skills
  homeDir?: string     // 缺省 os.homedir();测试注入
}

function homeDirOf(ctx: SkillLoadContext): string {
  return ctx.homeDir ?? os.homedir()
}

/** 用 SDK loadSkills 加载四来源;diagnostics 记日志但不抛错(坏 skill 跳过,不阻断会话) */
export function loadWorkspaceSkills(ctx: SkillLoadContext): LoadSkillsResult {
  const result = loadSkills({
    cwd: ctx.cwd,
    skillPaths: [ctx.skillsDir, path.join(homeDirOf(ctx), '.agents', 'skills')],
    includeDefaults: true,
    // agentDir 有意不传 → SDK 默认 getAgentDir() = ~/.pi/agent(或 PI_CODING_AGENT_DIR 覆盖)
    // LoadSkillsOptions 类型声明 agentDir 必填但运行时缺省(skills.js),窄化断言
  } as Parameters<typeof loadSkills>[0])
  logSkillDiagnostics(result.diagnostics)
  return result
}

/** 可选目录缺失是常态,降噪为 debug;其余诊断 warn */
function logSkillDiagnostics(diags: ResourceDiagnostic[]): void {
  for (const d of diags) {
    if (d.type === 'warning' && d.message === 'skill path does not exist') {
      console.debug(`[skills] 可选目录不存在(忽略): ${d.path}`)
      continue
    }
    console.warn(`[skills] ${d.type}: ${d.message} (${d.path})`)
  }
}

/** Skill → SkillInfo:scope 判断默认来源,路径判断显式来源(见 §2.3) */
export function toSkillInfo(skill: Skill, ctx: SkillLoadContext): SkillInfo {
  const source = classifySkillSource(skill, ctx)
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    source,
    sourcePath: skill.baseDir,
    disableModelInvocation: skill.disableModelInvocation,
  }
}
```

(`classifySkillSource` 见 §2.3;`isUnder` 小工具放文件底部,含 `root` 自身与分隔符边界、win32 大小写折叠。)

3. 改造 `createPromptOnlyLoader`:签名从 `(systemPrompt?, appendSystemPrompt?)` 改为 options 对象(仅 2 个调用方,一并迁移):

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

**预期结果**:`getSkills()` 返回四来源真实 skills;`/skill:<name>` 展开与 `<available_skills>` 注入由 SDK 会话层自动完成。

### Step 4:`piService.ts` 换用新 loader + 新增 `listSkills()`

**文件**:`apps/api/src/pi/piService.ts`

1. 第 293 行主代理 loader 改为:

```ts
const mainResourceLoader = createPromptOnlyLoader({
  appendSystemPrompt: orchestrator ? [orchestrator.body] : undefined,
  skills: { cwd: workspace.path, skillsDir: this.store.skillsDir },
})
```

2. 新增公开方法(路由调用;每次现扫现返回,前端列表始终最新):

```ts
/** 工作区可用 skills(前端输入框 / 搜索;每次现扫,新增 skill 立即可见) */
listSkills(workspace: Workspace): SkillInfo[] {
  const ctx = { cwd: workspace.path, skillsDir: this.store.skillsDir }
  return loadWorkspaceSkills(ctx).skills.map((s) => toSkillInfo(s, ctx))
}
```

3. import 更新:`createPromptOnlyLoader` 改为 options 调用;新增 `loadWorkspaceSkills`/`toSkillInfo`/`SkillLoadContext` import;`SkillInfo` 加入 `@workflows/shared` 类型 import。

**预期结果**:主代理会话创建时 `_rebuildSystemPrompt()` 读到四来源 skills;`listSkills()` 可被路由调用。

### Step 5:`subAgent.ts` 共用同一 skills 加载

**文件**:`apps/api/src/pi/subAgent.ts`

第 346 行改为:

```ts
const resourceLoader = createPromptOnlyLoader({
  systemPrompt: definition.body,
  skills: { cwd: workspace.path, skillsDir: store.skillsDir },
})
```

**预期结果**:子代理(explorer/planner/executor/reviewer/自定义)同样获得 skills,主/子代理一致。

### Step 6:新增 `GET /api/agent/workspaces/:id/skills`

**文件**:`apps/api/src/agent/routes.ts`(「会话」区块附近,`requireWorkspace` 模式与现有端点一致)

```ts
// 工作区可用 skills 列表(输入框 / 搜索数据源)
app.get('/api/agent/workspaces/:id/skills', (c) => {
  const workspace = requireWorkspace(store, c.req.param('id'))
  return c.json({ code: 0, message: 'ok', data: pi.listSkills(workspace) })
})
```

**预期结果**:`curl http://localhost:3000/api/agent/workspaces/<id>/skills` 返回 `{code:0,message:'ok',data:SkillInfo[]}`;未知工作区 404。

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

4. `openWorkspace()` 中 `applySessionData(data)` 之后 `await refreshSkills()`(可与现有 `refreshRun()` 并行)。
5. return 中导出 `skills` 与 `refreshSkills`。

**预期结果**:`agent.skills.value` 打开工作区后填充;未选工作区为空数组。

### Step 8:`ChatPane.vue` 增加 `/` 搜索下拉

**文件**:`apps/web/src/components/ChatPane.vue`

**状态与计算**(沿用原计划,仅来源标签按四值映射):

```ts
const skillMenuOpen = ref(false)
const skillIndex = ref(0)
const skillQuery = computed(() => (draft.value.startsWith('/') ? draft.value.slice(1) : ''))
const allSkills = computed(() => props.agent.skills.value)

const SOURCE_LABEL: Record<SkillSource, string> = {
  'pi-agent': '全局(pi)', 'pi-project': '项目', workspace: '工作台', 'global-agents': '全局(agents)', path: '其他',
}

const filteredSkills = computed(() => { /* 名称前缀 > 名称包含 > 描述包含,取前 8 条;逻辑同原计划 */ })
```

**打开/关闭**:`watch(skillQuery)` 在 draft 以 `/` 开头、非流式、有匹配(或 query 空=全量)时打开;`watch(activeWorkspaceId)` 切工作区关闭;textarea `@blur` 关闭(下拉项 `@mousedown.prevent` 保持焦点)。

**键盘**(`onKeydown` 开头,菜单打开且有匹配项时优先拦截;保留 `event.isComposing` 守卫):
- `ArrowDown/ArrowUp`:`preventDefault`,高亮循环 ±1。
- `Enter`:`preventDefault`,选中高亮项(不发送)。
- `Escape`:关闭菜单,`preventDefault`。
- 菜单打开但无匹配:Enter/Esc 走原逻辑。

**选中动作**:

```ts
function selectSkill(skill: SkillInfo) {
  draft.value = `/skill:${skill.name} `
  skillMenuOpen.value = false
  nextTick(() => textareaRef.value?.focus())
}
```

**模板**:textarea 外包 `<div class="relative flex-1">`,下拉容器 `absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-64 overflow-y-auto rounded-md border border-hairline bg-canvas shadow-lg`;每项 `<button>` 展示 `name`(mono)+ `description`(单行截断)+ 来源标签 `SOURCE_LABEL[s.source]`,`:class` 高亮 `skillIndex === i`;无匹配显示空态一行。

**预期结果**:输入 `/` 弹出下拉,方向键/回车/Esc/点击行为符合需求;选中的 `/skill:name ` 作为普通文本发送(后端 SDK 自动展开)。

### Step 9:测试

**新增 `apps/api/src/pi/skillsLoader.test.ts`**(核心逻辑单测,临时目录模式仿 `agentDefs.test.ts`):

隔离骨架(§2.7):

```ts
let tmpHome: string; let tmpStore: string; let tmpWs: string
let ctx: SkillLoadContext
beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'wf-skills-home-'))
  tmpStore = mkdtempSync(path.join(os.tmpdir(), 'wf-skills-store-'))
  tmpWs = mkdtempSync(path.join(os.tmpdir(), 'wf-skills-ws-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', path.join(tmpHome, 'pi-agent'))   // 来源 a 重定向
  ctx = { cwd: tmpWs, skillsDir: path.join(tmpStore, 'skills'), homeDir: tmpHome }
  // 建四来源目录 + SKILL.md(helper:writeSkill(dir, name, desc))
  //   tmpHome/pi-agent/skills/greet/SKILL.md        → 期望 source 'pi-agent'
  //   tmpWs/.pi/skills/refactor/SKILL.md            → 'pi-project'
  //   tmpStore/skills/summarize/SKILL.md            → 'workspace'
  //   tmpHome/.agents/skills/translate/SKILL.md     → 'global-agents'
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(tmpHome, { recursive: true, force: true }); rmSync(tmpStore, ...); rmSync(tmpWs, ...) })
```

用例(在原计划 9 条基础上扩展来源覆盖):
1. **四来源各放一个 SKILL.md,`loadWorkspaceSkills(ctx)` 全部加载**,`toSkillInfo` 的 `source` 分别为 `pi-agent`/`pi-project`/`workspace`/`global-agents`(四来源验收主用例)。
2. 根目录散落 `.md`(frontmatter 有 name)→ 加载;无 name → 回退目录名(文档化该行为)。
3. 缺 description → 不加载 + diagnostics 警告;同名冲突 → 先到者胜(collision 诊断,不抛错)。
4. 目录不存在(如清空 `~/.agents/skills`)→ 空结果不抛错 + "skill path does not exist" 诊断被降噪为 debug(`logSkillDiagnostics` 可单独断言)。
5. `toSkillInfo` 字段完整(name/description/filePath/baseDir/source/sourcePath/disableModelInvocation)。
6. `createPromptOnlyLoader({ skills: ctx }).getSkills()` 返回加载结果;不带 skills 时仍返回空(回归)。
7. (可选)`.workflows/agent/skills` 内容**不**被加载(确认已从来源清单移除)。

**新增 `apps/web/src/components/ChatPane.test.ts`**(仿 `WorkspacePickerModal.test.ts`):
- stub `AgentStore`(含 `skills` ref 等;`as unknown as AgentStore` 强转),用例 7 条同原计划(输入 `/` 弹出、`/plan` 过滤、ArrowDown+Enter 填入不发送、Esc 关闭、点击选中、无匹配空态、切工作区关闭),另加 1 条:**下拉项渲染来源标签**(如 `全局(pi)`/`工作台`)。

**修改受影响测试**:`apps/api/src/config.test.ts`、`apps/api/src/pi/piService.test.ts` 的 store 构造补 `skillsDir`(Step 2 已列)。

**验证**:`pnpm --filter @workflows/api test`、`pnpm --filter @workflows/web test` 全绿。

### Step 10(可选):文档与约定同步

- `README.md` 或 `docs/` 的 skills 小节:SKILL.md 格式(frontmatter 必填 `description`、可选 `name`/`disable-model-invocation`)、**四来源目录表**(含 Windows 路径)、`PI_CODING_AGENT_DIR` 可重定向全局目录、新增后需重开会话、安全提示(skills 是任意指令,review before use)。
- **AGENTS.md 约定同步修订**:原约定"绝不读写 pi 全局配置 `~/.pi/agent`"改为"**只读** `~/.pi/agent/skills` 与 `~/.agents/skills`(skills 来源),运行数据仍只写 `.workflows/`"。

---

## 4. 验证方式

### 命令(顺序执行)

```bash
# 1. shared 先构建(api/web 消费 dist)
pnpm --filter @workflows/shared build
# 2. 类型检查 / lint / 单测 / 全量构建
pnpm typecheck
pnpm lint
pnpm --filter @workflows/api test
pnpm --filter @workflows/web test
pnpm build
# 3. 本地手动验证
pnpm dev   # web 15200 / api 3000
```

### 手动验证清单(四来源)

1. **准备 skills(四来源各一个)**:
   - `~/.pi/agent/skills/greet/SKILL.md`(`---\nname: greet\ndescription: 用中文打招呼\n---\n<正文指令>`)
   - `~/.agents/skills/summarize/SKILL.md`(同上格式)
   - `.workflows/skills/refactor/SKILL.md`(仓库根 .workflows,dev 环境)
   - 在某工作区目录建 `.pi/skills/translate/SKILL.md`
2. 打开 web → 选择该工作区 → 输入 `/` → 下拉出现**四个** skill,标签分别为 `全局(pi)`/`全局(agents)`/`工作台`/`项目`;输入 `/gre` 过滤到 `greet`。
3. `ArrowDown` 高亮 → `Enter` → 输入框变为 `/skill:greet `(未发送);追加文字回车发送 → 模型按 skill 执行。
4. 直接输入 `/skill:summarize` 发送 → 生效;`/skill:不存在的` → 原样透传不报错。
5. 子代理可用性:主代理调用 explorer/planner,其 system prompt 同样含 `<available_skills>`。
6. **注意事项**:新增/修改 skill 后,下拉列表重开工作区(或刷新页面)即更新(端点现扫);模型要感知 skill 需重开会话(新建会话或重启 api);`/skill:name` 展开始终即时可用。
7. **权限确认**:在 `~/.pi/agent` 与 `~/.agents/skills` 无任何内容(或目录不存在)时,应用启动与聊天不受影响(仅 debug 日志),下拉为空。
8. 回归:不输入 `/` 时聊天、闸门、子代理模态窗行为不变。

---

## 5. 风险与回滚方案

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 读取用户主目录 skills 属行为变化,与 AGENTS.md 原约定冲突 | 低 | 需求明确要求;只读、来源根硬编码、无写入;Step 10 同步修订文档与 AGENTS.md |
| `~/.agents/skills` 缺失导致每次会话创建一条 warning | 低 | §2.6 降噪为 `console.debug` |
| `LoadSkillsOptions.agentDir` 类型声明必填、运行时可选 | 低 | `Parameters<typeof loadSkills>[0]` 窄化断言 + 注释;SDK 升级时复核该类型是否已改可选 |
| skills 注入膨胀 system prompt、模型行为变化 | 低 | SDK 仅在 active tools 含 `read` 时注入;`disable-model-invocation` 可排除;增量功能 |
| 用户主目录 skills 含不可信内容 | 中(安全提示) | 只读展示不进 git;文档沿用 "review before use";`disable-model-invocation` 可让 skill 不进 prompt |
| `createPromptOnlyLoader` 签名变更 | 低 | 全仓仅 2 个调用方(已 grep 确认),编译期强制迁移 |
| `WorkflowsStore` 加字段破坏手工构造的测试 store | 低 | 仅 `config.test.ts` / `piService.test.ts` 两处,tsc 兜底 |
| 前端下拉与 IME 输入冲突 | 低 | 保留 `event.isComposing` 守卫;`@mousedown.prevent` 避免 blur 先于点击 |
| 新增 skill 后旧会话感知不到 | 已知行为 | 文档化 + 手动验证第 6 条;`reload()` 已实现(应用当前不调用,预留) |
| 测试误触真实 `~/.pi/agent` | 低 | §2.7 隔离:PI_CODING_AGENT_DIR 重定向 + homeDir 注入,双保险;不 mock、不动真实目录 |

**回滚方案**:
- 每个 Step 独立提交;回滚按提交逐个 revert,无数据迁移、无 schema 变更。
- 最坏情况:仅 revert Step 3–6(后端)即回到"skills 全空"现状(前端下拉因列表为空自然不出现);shared 的 `SkillInfo`/`SkillSource` 为纯新增类型,保留无害。
- 唯一"行为反转"是读取用户主目录:回滚后即恢复不读取,无残留状态。

---

## 6. 验收标准(逐条核对)

- [ ] `packages/shared` 导出 `SkillInfo`(name/description/filePath/baseDir/source/sourcePath/disableModelInvocation)与 `SkillSource`,rebuild 后 api/web 可引用。
- [ ] `WorkflowsStore` 含 `skillsDir`,`createStore()` 创建 `.workflows/skills`;`config.test.ts`/`piService.test.ts` 测试 store 已同步。
- [ ] `promptLoader.ts`:`loadWorkspaceSkills(ctx)` 调 `loadSkills({ cwd, skillPaths: [skillsDir, ~/.agents/skills], includeDefaults: true })` 且**不传 agentDir**(SDK 默认 `~/.pi/agent`);缺省(无 skills ctx)仍返回空;`reload()` 重载;诊断降噪(warn 中仅保留真实问题)。
- [ ] 四来源分类正确:`pi-agent`(scope=user)/ `pi-project`(scope=project)/ `workspace`(路径=skillsDir)/ `global-agents`(路径=~/.agents/skills),兜底 `path`。
- [ ] 主代理(`piService.ts openSession`)与子代理(`subAgent.ts runSubAgent`)均传入同一 `SkillLoadContext` 结构,主/子代理 skills 一致。
- [ ] `GET /api/agent/workspaces/:id/skills` 返回 `{code:0,message:'ok',data:SkillInfo[]}`;未知工作区 404。
- [ ] `useAgent.ts`:`skills` ref + `refreshSkills()`;`openWorkspace()` 时刷新;失败静默置空。
- [ ] `ChatPane.vue`:输入 `/` 弹出下拉(名称/描述模糊匹配,前缀优先,最多 8 条,显示来源标签);`ArrowDown/Up` 循环高亮;`Enter` 选中填入 `/skill:<name> ` 且不发送;`Esc`/`blur`/切工作区关闭;流式中不弹出;IME 组合输入不误触。
- [ ] 发送 `/skill:<name>` 后,后端 SDK 自动展开为 `<skill>` 块;不存在的 skill 原样透传。
- [ ] **四来源验证通过**(`skillsLoader.test.ts` 主用例 + 手动清单):`~/.pi/agent/skills`、`~/.agents/skills`、`.workflows/skills`、`<workspace>/.pi/skills` 均被加载,source 分别为 pi-agent/global-agents/workspace/pi-project。
- [ ] 测试全程不触碰真实用户目录(仅临时 HOME/PI_CODING_AGENT_DIR,`afterEach` 清理)。
- [ ] `.workflows/agent/skills` 不再被加载(来源清单已移除,有测试用例兜底)。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm --filter @workflows/api test`、`pnpm --filter @workflows/web test`、`pnpm build` 全部通过。
- [ ] 文档/AGENTS.md 已同步:四来源目录、`PI_CODING_AGENT_DIR`、只读边界、review before use、重开会话说明。

---

## 7. 与原计划(02-plan-1.md)的差异说明

| # | 原计划 | 修订后 | 原因/依据 |
| --- | --- | --- | --- |
| 1 | 三来源:`.workflows/agent/skills`(agentDir 传入)+ `<cwd>/.pi/skills` + `.workflows/skills` | **四来源**:`~/.pi/agent/skills`(不传 agentDir,SDK 默认)+ `<cwd>/.pi/skills` + `.workflows/skills` + `~/.agents/skills`(显式 skillPaths) | 用户明确要求读取工作区外 skills;SDK `agentDir ?? getAgentDir()` 事实 |
| 2 | `SkillLoadContext { cwd, agentDir, skillsDir }` | `{ cwd, skillsDir, homeDir? }`;**去掉 agentDir**,新增 `homeDir`(测试注入) | agentDir 不再传给 SDK;homeDir 用于展开 `~/.agents/skills` 并隔离测试 |
| 3 | `loadSkills({ cwd, agentDir: store.agentDir, skillPaths: [skillsDir], includeDefaults: true })` | `loadSkills({ cwd, skillPaths: [skillsDir, <home>/.agents/skills], includeDefaults: true })`,不传 agentDir,`as Parameters<typeof loadSkills>[0]` 断言 | SDK 类型声明 agentDir 必填但运行时缺省(源码核实) |
| 4 | `SkillInfo.source: string`(user/project/workflows/path) | `SkillInfo.source: SkillSource` = `'pi-agent' \| 'pi-project' \| 'workspace' \| 'global-agents' \| 'path'`,分类 = sourceInfo.scope + 路径判断 | 四来源需要区分两个"全局"路径;scope 仅能区分 user/project(源码核实 skillPaths 恒为 temporary) |
| 5 | `.workflows/agent/skills` 为必需来源 | **移除**(建议,含测试兜底);恢复成本一行 | 用户四来源清单不含;隔离动机消失;避免第五分类 |
| 6 | diagnostics 一律 `console.warn` | "skill path does not exist" 降噪为 `console.debug` | `~/.agents/skills` 缺失是常态,避免每次会话创建刷警告 |
| 7 | 测试覆盖三来源(临时 store + 临时 workspace) | **四来源全覆盖**;隔离 = `vi.stubEnv('PI_CODING_AGENT_DIR', tmp)` 重定向 SDK `getAgentDir()` + `homeDir` 注入;不 mock、不触碰真实 `C:\Users\kaijia\.pi\agent` | SDK 官方 env 覆盖机制(源码核实 `config.js`) |
| 8 | 手动验证三来源 | 手动验证四来源(含 `~/.pi/agent`、`~/.agents/skills`);新增"全局目录为空时应用无感"回归项 | 工作区外读取的权限/空目录行为确认 |
| 9 | 文档:三来源目录 | 文档:四来源目录表 + `PI_CODING_AGENT_DIR` 说明 + **AGENTS.md"绝不读写 ~/.pi/agent"约定修订为只读例外** | 行为反转需文档同步 |
| 10 | 风险表无"读取主目录"项 | 新增:约定冲突、不可信内容、env 覆盖相关风险与缓解 | 范围扩展带来的新风险 |
| 11 | 未变部分 | shared 类型、`WorkflowsStore.skillsDir`、端点、`useAgent.ts`、`ChatPane.vue` 下拉、`createPromptOnlyLoader` options 化、主/子代理共用、Step 顺序与验证命令 | 仅同步 SkillInfo 字段与来源说明 |
