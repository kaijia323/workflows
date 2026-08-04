# 探索报告:为 agent 添加 skills 读取能力

> 任务:调研 workflows 仓库,为「读取 pi 默认路径 + .workflows/skills 路径的 skills,输入框输入 `/` 可搜索调用」做准备。
> 结论先行:**完全可行,且 SDK 已内置所需全部能力**——当前缺口仅在自定义 ResourceLoader 返回空 skills,以及前端无 `/` 解析。

---

## 1. 仓库概览

- **定位**:Turborepo + pnpm monorepo 的 Web Agent 工作台(独立应用,不是 pi 扩展)。基于 **pi SDK**(`@earendil-works/pi-coding-agent@0.83.0`)封装 Web 聊天界面 + 工作区管理 + DAG 工作流编排,模型走 DeepSeek。
- **技术栈**:
  - `apps/api`:**Hono** + pi SDK(ESM,tsx dev / tsc build),Vitest 测试
  - `apps/web`:Vue 3 + Vite + Tailwind v4,SSE 接入在 `src/composables/useAgent.ts`,Vitest 测试
  - `packages/shared`:纯类型包(改动后必须 `pnpm build` 才会被 api/web 消费)
  - `apps/api/scripts/copy-agents.mjs`:build 时复制 `src/pi/agents/*.md` → `dist/pi/agents`
- **入口**:`apps/api/src/index.ts` → `app.ts`(`initAgentRoutes` 创建 `PiAgentService` + 注册路由)→ `apps/api/src/pi/piService.ts`(服务层)。
- **关键约定**(AGENTS.md):统一响应 `{code,message,data}`;所有运行数据存 `.workflows/`(dev 在仓库根、prod 在 `~/.workflows`),**绝不读写 pi 全局配置 `~/.pi/agent`**;每工作区一个持久化会话(JSONL),上下文限定工作区目录;工作区边界守卫 `workspaceGuard.ts`。
- **构建/测试**:`pnpm dev`(web 15200 + api 3000)/ `pnpm build` / `pnpm start`(生产 5200 单端口)/ `pnpm typecheck | lint | test`。

## 2. 需求相关模块清单

| 文件 | 说明 |
| --- | --- |
| `apps/api/src/pi/piService.ts` | 核心服务层。`openSession()` 中 `createAgentSession({ resourceLoader: mainResourceLoader, ... })` 创建主代理会话;`mainResourceLoader = createPromptOnlyLoader(undefined, [orchestrator.body])` |
| `apps/api/src/pi/promptLoader.ts` | **当前 skills 断点**。自定义极简 ResourceLoader,`getSkills: () => ({ skills: [], diagnostics: [] })`(第 20 行)返回空——skills 完全未加载。注释说明不用 `DefaultResourceLoader` 的原因(其 `reload()` 走 `packageManager.resolve()` 触碰全局扩展包,违反隔离约定) |
| `apps/api/src/pi/agentDefs.ts` | 代理定义加载器(内置 `src/pi/agents/*.md` + 用户 `store.agentsDir` 覆盖),与 skills 机制平行可参考(都是"目录扫描 + frontmatter 解析 + 同名覆盖"模式) |
| `apps/api/src/pi/subAgent.ts` | 子代理运行器,同样用 `createPromptOnlyLoader(definition.body)` 创建会话——子代理也拿不到 skills |
| `apps/api/src/config.ts` | `.workflows` 存储:`createStore()` 定义 `root/agentDir/agentsDir/configPath` 等;`agentDir = <root>/agent` |
| `apps/api/src/agent/routes.ts` | Hono 路由。`POST /api/agent/workspaces/:id/prompt` 接收 `{text}` 直接送 `pi.prompt()`;**无 skills 相关端点** |
| `apps/web/src/components/ChatPane.vue` | **输入框所在**。底部 `<textarea v-model="draft">`,`handleSend()` 仅 `trim()` 后发送;**无任何 `/` 命令解析**(无 slash command、无补全逻辑) |
| `apps/web/src/composables/useAgent.ts` | 前端状态中心,`sendMessage(text)` POST `/prompt` + SSE 消费;`request<T>()` 统一 API 封装 |
| `packages/shared/src/index.ts` | 共享类型(`SessionEvent`/`AgentConfig` 等)。新增 `SkillInfo` 类型需在此定义并 rebuild |

## 3. skills 在 pi 中的路径规则(SDK 0.83.0 实测)

**文档**(`node_modules/.../pi-coding-agent/docs/skills.md`)声明的 pi CLI 全局路径:
- 全局:`~/.pi/agent/skills/`、`~/.agents/skills/`
- 项目(trusted 后):`.pi/skills/`、`.agents/skills/`(cwd 及祖先,至 git 根)
- 包:`skills/` 目录或 `package.json` 的 `pi.skills`;settings `skills` 数组;CLI `--skill`

**SDK 函数 `loadSkills()`**(`dist/core/skills.js`)实际实现的默认路径(`includeDefaults: true` 时):
```js
join(resolvedAgentDir, "skills")              // = <agentDir>/skills(本应用传 store.agentDir = .workflows/agent/skills)
resolve(resolvedCwd, CONFIG_DIR_NAME, "skills") // = <cwd>/.pi/skills(CONFIG_DIR_NAME = ".pi")
+ skillPaths 数组(文件或目录,显式追加)
```
- 注意:SDK 的 `loadSkills` **不扫描 `~/.agents/skills`**(那是 CLI/packageManager 层行为);`DefaultResourceLoader` 经 `packageManager.resolve()` 才覆盖 settings/包等来源,但会触碰全局配置,与仓库隔离约定冲突。
- **发现规则**(`loadSkillsFromDir`):目录含 `SKILL.md` → 整个目录是一个 skill(不递归);否则根目录直接 `.md` 文件各自成 skill;子目录递归找 `SKILL.md`;跳过 `node_modules`;尊重 `.gitignore/.ignore/.fdignore`。
- **frontmatter**:`name`(可缺省,回退目录名)、`description`(必填,缺失不加载)、`disable-model-invocation`、`license`/`compatibility`/`metadata`/`allowed-tools` 等。name 规则:小写 a-z/0-9/连字符、≤64 字符。

## 4. 可复用的 SDK API(全部从包根导出,`dist/index.d.ts` 已确认)

```ts
import { loadSkills, loadSkillsFromDir, formatSkillsForPrompt,
         type Skill, type SkillFrontmatter, type LoadSkillsResult } from '@earendil-works/pi-coding-agent'
```
- `loadSkills({ cwd, agentDir, skillPaths, includeDefaults })` → `{ skills: Skill[], diagnostics }`;`Skill = { name, description, filePath, baseDir, sourceInfo, disableModelInvocation }`。同名校验/碰撞诊断已内置(碰撞取先到者)。
- `loadSkillsFromDir({ dir, source })` → 单目录扫描(发现规则同上)。
- `formatSkillsForPrompt(skills)` → Agent Skills 标准 XML(`<available_skills>` 块),SDK 内部 `buildSystemPrompt` 已调用。

**AgentSession 内置的 skills 行为**(`dist/core/agent-session.js` 实测,无需自研):
1. `_rebuildSystemPrompt()`(构造/换工具集时)读 `resourceLoader.getSkills().skills` → `buildSystemPrompt` 拼接 `<available_skills>`(仅当 active tools 含 `read`——主代理与子代理均有 read,满足)。
2. `prompt()` 默认 `expandPromptTemplates: true` → `_expandSkillCommand(text)`:**`/skill:<name> [args]` 自动展开为 `<skill name=... location=...>` 块(读取 filePath、剥 frontmatter、追加 `User: <args>`)**;skill 未找到时原样透传(不会报错)。展开后走正常模型回合 → 输入框天然支持 `/skill:xxx` 调用。
3. 扩展命令 `/_tryExecuteExtensionCommand` 优先于 skill 展开(当前应用无扩展命令,无冲突)。

## 5. 现状缺口(直接回答任务第 2/3/5 点)

- **agent 定义/注册**:有——`agentDefs.ts`(frontmatter:name/description/agents/tools/write)+ `src/pi/agents/*.md` + `.workflows/agents/` 用户覆盖。但**没有任何 skills 配置处**;`promptLoader.ts` 硬编码空 skills。
- **工具配置**:有——`piService.openSession()` 中 `customTools`/`tools` 白名单(含 fff-find/fff-grep/anysearch-search/子代理工具)。
- **输入框**:`apps/web/src/components/ChatPane.vue` 的 textarea;**无 `/` 命令解析、无补全**;后端 prompt 端点也不识别命令前缀(直接透传 session.prompt)。
- **`.workflows/skills`**:**不存在**(`.workflows/` 现有 `agent/、agents/、config.json、workspace-sessions.json、workspaces.json`);代码中无任何引用。

## 6. 可行方案要点

### 6.1 后端:让 ResourceLoader 提供 skills
在 `promptLoader.ts` 扩展(或新增 `createSkillsLoader` 包装):
1. 用 `loadSkills({ cwd: workspace.path, agentDir: store.agentDir, skillPaths: [<root>/.workflows/skills], includeDefaults: false })` 加载——`includeDefaults: false` 避免隐式扫 `<agentDir>/skills` 之外的东西,显式路径:
   - `<agentDir>/skills`(= `.workflows/agent/skills`,对应 pi 的"全局 skills"位置,隔离在 .workflows 内不触碰 `~/.pi/agent`)——若任务要求也读 pi 默认路径,可把它显式列入 `skillPaths`;
   - `<root>/.workflows/skills`(仓库自定义约定,开发环境 = 仓库根 `.workflows/skills`,生产 = `~/.workflows/skills`,与 store.root 一致);
   - 可选:`<workspace.path>/.pi/skills`(工作区项目级 skills,需按"项目 trusted"语义自行决定是否纳入)。
2. `getSkills()` 返回 `{ skills, diagnostics }`;`getSystemPrompt()`/`getAppendSystemPrompt()` 保持现状(orchestrator 正文)。返回的 `Skill` 需补 `sourceInfo`(用 `createSyntheticSourceInfo` 或复用 `loadSkills` 自带 sourceInfo)。
3. 主代理与子代理(piService.ts 的 `mainResourceLoader`、subAgent.ts 的 loader)统一走同一 loader 工厂;新增 `GET /api/agent/skills`(或挂工作区下)返回 `[{name, description, source}]` 供前端搜索,`SkillInfo` 类型加进 `packages/shared` 后 rebuild。
4. 会话创建时机:skills 在 `createAgentSession` 构造时经 `_rebuildSystemPrompt` 读一次,进程内缓存即可;skills 文件变更需重建会话或实现 reload(可与 `invalidateAgentDefinitions` 同思路)。

### 6.2 前端:输入框 `/` 搜索调用
在 `ChatPane.vue` 的 textarea 增加:
- 输入以 `/` 开头时弹出下拉(匹配 `name`/`description`),Enter/点击后把 `draft` 替换为 `/skill:<name> ` 或直接发送;
- 直接发送即可——后端 `session.prompt` 已内置 `/skill:name` 展开(见 §4);也可额外提供 `/skills` 列表命令。
- 数据源:`GET /api/agent/skills`(也可挂到现有 config 接口)。

### 6.3 可选增强
- `formatSkillsForPrompt` 已自动把 skills 描述注入 system prompt(渐进式披露:模型按描述用 `read` 加载 SKILL.md),无需手工拼 prompt。
- 安全:skills 是任意指令/可执行代码,建议沿用仓库"review before use"哲学;`.workflows/` 已在 `.gitignore`。
- 测试:仿照 `agentDefs.test.ts` 为 skills 加载写单测;`promptLoader` 现无测试,新增 `skillsLoader.test.ts`。

## 7. 关键发现与风险点

1. **最大风险:绕过 DefaultResourceLoader 是对的,但别手写扫描**——用 SDK 导出的 `loadSkills`/`loadSkillsFromDir`(已处理 frontmatter 校验、name 回退、忽略规则、碰撞诊断、symlink 去重),避免与 SDK 行为分叉。
2. `createPromptOnlyLoader` 返回的 runtime 是空壳(`pendingProviderRegistrations` 等),若 skills 依赖扩展注册会失败——纯 skills 不受影响,但不要顺带引入扩展。
3. `_expandSkillCommand` 的展开文本以 `<skill ...>` 块发送,用户消息可见性:前端 pushUserMessage 显示的是原始 `/skill:xxx`(sendMessage 用原始 text),与后端实际发送的展开文本不一致——若追求 WYSIWYG,可让后端在展开后回传(或前端自行调展开逻辑),属可选优化。
4. skills 只在会话创建时读入 system prompt;运行时新增/修改 skills 需重开会话(或 `session.reload()` 走 resourceLoader.reload——promptOnlyLoader 的 reload 是 no-op,需实现)。
5. 子代理会话(explorer/planner/executor/reviewer)也应获得 skills,否则出现主代理知道 skills、子代理不知道的割裂;建议共用 loader。
6. `disableModelInvocation: true` 的 skill 不进 system prompt、只能 `/skill:name` 显式调用——与"输入框 `/` 调用"的需求天然契合,搜索列表应全量展示、prompt 注入按 SDK 语义即可。

## 8. 结论

**可行性:高,改动面小且都在现有结构内。**
- SDK 0.83.0 已导出 `loadSkills`/`loadSkillsFromDir`/`formatSkillsForPrompt`/`Skill`,并内置 `/skill:name` 展开与 system prompt 注入——后端只需把 `promptLoader.ts` 的 `getSkills()` 从空数组改为加载结果(显式 skillPaths = pi 默认位置 `.workflows/agent/skills` + 自定义 `.workflows/skills`),前端只需在 ChatPane 输入框加 `/` 搜索下拉 + 一个 skills 列表端点。
- 建议实施顺序:(1) shared 加 `SkillInfo` 类型;(2) `promptLoader.ts` 加 skills 加载 + `routes.ts` 加 `GET /api/agent/skills`;(3) piService/subAgent 换用新 loader;(4) ChatPane `/` 下拉;(5) 单测。
