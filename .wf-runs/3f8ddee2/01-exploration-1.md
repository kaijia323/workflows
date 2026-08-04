# 探索报告:工作区边界拦截定位与 skills 目录读取放行方案

任务:定位「工作区边界拦截」实现,找出为特定 skills 目录(四来源中位于工作区外者)放开读取的方案。

---

## 1. 仓库概览

- **技术栈**:Turborepo pnpm monorepo;`apps/api` = Hono + pi SDK(`@earendil-works/pi-coding-agent@0.83.0`,已确认 node_modules/.pnpm 下版本);`apps/web` = Vue 3 + Vite + Tailwind v4;`packages/shared` = 纯类型包
- **测试**:Vitest(api 侧 `*.test.ts`);构建 `pnpm build`(shared → api/web);`pnpm test` / `pnpm typecheck`
- **关键约定**(AGENTS.md):数据隔离——运行数据只写 `.workflows/`(dev 在仓库根、prod 在 `~/.workflows`);只读例外:加载 skills 时读取 `~/.pi/agent/skills` 与 `~/.agents/skills`;改动守卫需同步更新 `workspaceGuard.test.ts`

## 2. 拦截实现位置与机制(纯自研,SDK 无内置路径拦截)

### 2.1 报错文本出处

| 报错文本 | 位置 |
| --- | --- |
| `工作区边界拦截:read 尝试访问工作区之外的路径「…」(解析为 …)` | `apps/api/src/pi/workspaceGuard.ts:520`(`guardPathTool`) |
| `工作区边界拦截:命令尝试访问工作区之外,已拒绝执行。` | `apps/api/src/pi/workspaceGuard.ts:470`(`createWorkspaceBashHook`) |

### 2.2 机制(两层,全部在 apps/api 自研代码)

1. **工具层 `guardPathTool(def, workspacePath)`**(workspaceGuard.ts:513):包装 ToolDefinition 的 execute,执行前取 `params.path`,经 `isAllowedTargetPath(candidate, workspacePath)` 校验,失败抛「工作区边界拦截」错误。覆盖 read/write/edit/grep/find/ls 与自研 fff-find/fff-grep。
2. **bash 层 `createWorkspaceBashHook(workspacePath)`**(workspaceGuard.ts:464):注入 `createBashTool` 的 spawnHook,用 unbash 解析 AST 静态审计(参数路径/重定向/cd/嵌套命令替换;解析失败或含未知动态展开一律拒绝)。

**放行判定链 `isAllowedTargetPath`**(workspaceGuard.ts:118):设备白名单(`/dev/null`、`/dev/fd` 等)→ 临时目录(`/tmp`、`$TEMP` 等,resolve 后判定)→ **`isPathWithinWorkspace`**(workspaceGuard.ts:129:`path.resolve` 后 `path.relative` 前缀比较,win32 大小写折叠)→ 否则拒绝。相对路径一律基于工作区 resolve(与 SDK 内置工具 `resolveToCwd` 语义一致)。

### 2.3 SDK 是否有可用的放行配置?——没有

- SDK `security.md` 明确「No Built-in Sandbox」:内置工具以进程权限读写任意路径,**不存在** allowedPaths / deniedPaths / 目录白名单 / 资源 allowlist 类配置。
- `CreateAgentSessionOptions`(dist/core/sdk.d.ts)仅有 `tools`(工具名 allowlist)、`excludeTools`、`customTools`、`noTools`、`cwd`/`agentDir`/`resourceLoader`/`sessionManager` 等,**无任何路径级权限项**。
- `Project Trust`(security.md)只控制「是否加载项目本地资源(.pi/settings、.pi/skills 等)」,**不限制工具对文件的访问**,与本问题无关。
- 结论:路径拦截 100% 是 apps/api 自研,SDK 无需也无法配置放行;放行只能在 workspaceGuard 层做。

## 3. 拦截的使用点(主/子代理 read 工具创建处)

| 会话 | 位置 | 细节 |
| --- | --- | --- |
| 主代理 | `piService.ts` `openSession` L242-264 | `createReadOnlyTools`/`createCodingTools` 过滤 bash/grep/find 后逐个 `guardPathTool(toToolDefinition(tool), workspace.path)`;fff 工具同样 guard;bash 用 `createBashTool(workspace.path, { spawnHook: createWorkspaceBashHook(workspace.path) })` |
| 子代理 | `subAgent.ts` `buildSubAgentTools` L105-133 | 只读基础(read/ls/fff)逐个 `guardPathTool`;executor 全量写时 coding 工具 + bash 同样 guard;白名单写走独立 `guardWriteTool`(agentDefs 的 write 白名单,与边界无关) |

两处均硬编码传 `workspace.path` 作为唯一边界参数——这就是需要改动的点。

## 4. skills 四来源现状(可复用的路径常量)

实现:`apps/api/src/pi/promptLoader.ts` `loadWorkspaceSkills(ctx)` → SDK `loadSkills({ cwd, skillPaths: [ctx.skillsDir, homeDir/.agents/skills], includeDefaults: true })`:

| 来源 | 根路径 | 是否工作区内(dev/prod) | 现状 |
| --- | --- | --- | --- |
| (a) pi-agent | `~/.pi/agent/skills`(SDK `getAgentDir()` 默认;`PI_CODING_AGENT_DIR` 可重定向,测试依赖此机制) | 否 | **被拦**(本次问题) |
| (b) pi-project | `<workspace>/.pi/skills` | 是 | 放行 |
| (c) workspace | `store.skillsDir` = `<root>/.workflows/skills`(config.ts:58;dev=`<repo>/.workflows/skills`,prod=`~/.workflows/skills`) | dev 是 / **prod 否** | dev 放行;prod 会被拦;且 `.workflows/` 在 .gitignore 中 → fff 索引(遵循 .gitignore)搜不到其中内容(read 工具不受索引影响,可直接读) |
| (d) global-agents | `~/.agents/skills` | 否 | **被拦**(本次问题,如 `C:\Users\kaijia\.agents\skills\grill-me\SKILL.md`) |

**现有可复用结构**:
- `SkillLoadContext { cwd, skillsDir, homeDir? }`(promptLoader.ts:26)——主代理(piService L297)与子代理(subAgent L349)共用同一 ctx,保证一致性
- `classifySkillSource` / `isUnder`(promptLoader.ts)——已实现「路径是否在某个根之下」的判定(分隔符边界 + win32 折叠),可直接复用为放行判定
- `homeDirOf(ctx)`、`store.skillsDir`、`store.agentDir`

## 5. 推荐改动方案

### 方案 A(推荐):guard 增加「额外只读放行根」参数

1. **workspaceGuard.ts**:给 `isAllowedTargetPath`、`guardPathTool`、`createWorkspaceBashHook` 增加可选参数 `extraAllowedRoots: string[]`(缺省 `[]`,向后兼容);判定顺序:现有放行(设备/临时/工作区)→ **target 经 resolve 后位于任一 extra root 之下**(复用 `isPathWithinWorkspace(root, target)` 语义,注意先 `normalizeBashPath` 展开 `~`)→ 拒绝。**只对只读工具(read/ls/fff-find/fff-grep)传 extraAllowedRoots**;write/edit/bash 不放行(守住写面;bash 面大,`cat ~/.agents/.../SKILL.md` 若也要放开需另议,见风险)。
2. **promptLoader.ts**:新增 `skillReadRoots(ctx: SkillLoadContext): string[]` 导出,返回去重后的放行根:
   - 来源 a:`path.join(homeDirOf(ctx), '.pi', 'agent', 'skills')`(若 SDK agentDir 被 `PI_CODING_AGENT_DIR` 重定向,优先取该 env,与 loadWorkspaceSkills 的默认解析保持一致)
   - 来源 d:`path.join(homeDirOf(ctx), '.agents', 'skills')`
   - 来源 c:`ctx.skillsDir` **仅当其不在 `ctx.cwd` 内时**加入(prod 场景;dev 下在工作区内,重复无妨但建议过滤)
   - 与 `loadWorkspaceSkills` 同处维护,主/子代理天然一致。
3. **piService.ts** `openSession`:构造 `const extraRoots = skillReadRoots({ cwd: workspace.path, skillsDir: this.store.skillsDir })`,传入所有 `guardPathTool` 调用(read/ls/fff);**不**传给 bash hook。
4. **subAgent.ts** `buildSubAgentTools`(签名加可选 `extraAllowedRoots?: string[]`)与 `runSubAgent`:同样构造并传入只读工具;bash 不传。

### 方案 B(不推荐):只精确放行 `…/skills/<name>/SKILL.md`

skill 目录内通常还有 scripts/references/assets,代理按相对路径读取这些资源同样需要放开;精确到文件会反复误拦,且需感知 skill 列表,维护面大。放行整个 skills 根更符合「skills 目录是只读可信资源区」的定位。

### 涉及文件清单

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/pi/workspaceGuard.ts` | `isAllowedTargetPath` / `guardPathTool` / `createWorkspaceBashHook` 加 `extraAllowedRoots` 可选参数 + 判定 |
| `apps/api/src/pi/promptLoader.ts` | 新增 `skillReadRoots(ctx)` 导出(放行根单一事实源) |
| `apps/api/src/pi/piService.ts` | `openSession` 构造并传入 extraRoots(只读工具) |
| `apps/api/src/pi/subAgent.ts` | `buildSubAgentTools` 签名 + `runSubAgent` 传入 |
| `apps/api/src/pi/workspaceGuard.test.ts` | 新增:extraAllowedRoots 放行用例(~/.agents/skills 下路径、大小写、`..` 逃逸仍拦) |

### 受影响测试评估

- `workspaceGuard.test.ts`:现有用例全部用 `C:\Users\kaijia\secret.txt`、`../outside.txt`、`/etc/passwd` 等路径,不在任何放行根下,**不受影响**;需新增 extraAllowedRoots 的放行/仍拦截用例(AGENTS.md 约定:改守卫同步更新本文件)。
- `skillsLoader.test.ts`:只测 skills 加载与分类,不触 guard,不受影响。
- `subAgent.test.ts` / `piService.test.ts`:分别测 buildSubAgentTools 工具集构成与 complete_task/wait_for_approval,**不触 guard**;buildSubAgentTools 加可选参数向后兼容,现有调用不破。
- SDK 集成测试(workspaceGuard.test.ts「真实 AgentSession 集成」):若只读工具放行根新增,该段用临时目录且未传 extraRoots,断言不变。

## 6. 风险点

1. **护栏放宽(信任边界)**:SKILL.md 内容不可信(可能含 prompt 注入/恶意指令,SDK security.md 亦警告)。放行面应严格限定**只读工具**;write/edit/bash 保持拦截。bash 如需读 skill(如执行 skill 内脚本)属另一议题,建议单独评估(可考虑仅放行 cat/head/tail 等只读命令参数,成本高,默认不做)。
2. **路径语义**:guardPathTool 收到的 `~/.agents/...` 形式先经 `normalizeBashPath` 展开 `~` 再判定;extraRoots 判定必须同样先 normalize(否则 `~` 形式误拦)。win32 大小写折叠沿用现有逻辑;符号链接不解析(与现有信任模型一致,skills 目录含链接时行为与工作区一致)。
3. **主/子代理一致性**:两处调用点都要改,漏改子代理则「子代理能看 skill 元数据但读不了 SKILL.md」。
4. **fff 索引盲区**:fff-find/fff-grep 索引以工作区为根(fffTools.ts `FileFinder.create({ basePath: workspacePath })`),工作区外的 skills 目录即使 guard 放行 path 参数,fff 也搜不到(索引范围外);`.workflows/skills` 在 dev 下在工作区内但被 .gitignore 忽略,fff 同样不索引。**read/ls 不受影响**;若需 fff 可搜需额外方案(改索引配置),不在本次 read 放行范围。
5. **来源 a 的根解析漂移**:`~/.pi/agent/skills` 实际根受 `PI_CODING_AGENT_DIR` 影响,放行根计算需与 loadWorkspaceSkills 的解析保持一致(promptLoader 注释已说明 agentDir 有意不传、依赖 SDK 默认)。
6. **生产环境**:prod 下 `~/.workflows/skills` 在工作区外,方案 A 已覆盖(仅当 skillsDir 不在 cwd 内时加入放行根);如未来 .workflows 根迁移,放行根随 `skillReadRoots` 单点更新即可。

## 7. 结论

- **可行性:高**。拦截是 apps/api 自研(`workspaceGuard.ts`),SDK(0.83.0)无路径级放行配置可用,放行只能在自研层实现;改动集中在 4 个源文件 + 1 个测试文件,向后兼容(可选参数),现有测试不受影响。
- **建议**:采用方案 A——guard 加 `extraAllowedRoots` 可选参数,promptLoader 导出 `skillReadRoots(ctx)` 作为放行根单一事实源(来源 a `~/.pi/agent/skills`、来源 d `~/.agents/skills`、来源 c 的 skillsDir 仅当在工作区外),仅对 read/ls/fff 只读工具放开,主代理(piService.ts)与子代理(subAgent.ts)同步接入,并补 workspaceGuard.test.ts 用例。
