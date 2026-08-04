# 实施计划:为特定 skills 目录放开工作区边界拦截(仅只读工具)

> 依据探索报告 `.wf-runs/3f8ddee2/01-exploration-1.md`;已复核 workspaceGuard.ts / promptLoader.ts / piService.ts / subAgent.ts / workspaceGuard.test.ts / skillsLoader.test.ts / subAgent.test.ts / AGENTS.md / README.md,计划可直接落地。

---

## 1. 目标与范围

### 做什么

1. `workspaceGuard.ts` 为「工具层路径守卫」增加**可选**只读放行根参数 `extraAllowedRoots`,使 read/ls/fff-find/fff-grep 能读取工作区之外的 skills 目录(`~/.pi/agent/skills`、`~/.agents/skills`、prod 下 `~/.workflows/skills`)。
2. `promptLoader.ts` 导出 `skillReadRoots(ctx)`:放行根单一事实源,与 `loadWorkspaceSkills` 四来源解析保持一致;主代理与子代理共用。
3. 主代理(`piService.ts openSession`)与子代理(`subAgent.ts buildSubAgentTools`/`runSubAgent`)两处调用点同步接入,避免主/子代理能力割裂。
4. 补测试(workspaceGuard.test.ts / skillsLoader.test.ts)与文档(AGENTS.md / README.md)。

### 不做什么(明确边界)

- **bash 完全不放行**:`createWorkspaceBashHook` / `auditBashCommand` **一行不改、不传 extraAllowedRoots**。`cat ~/.agents/skills/.../SKILL.md` 仍被拦截(见 §2 决策 D2)。
- **write / edit / guardWriteTool 不放行**:白名单写仍只限工作区产物目录。
- **fff 索引范围不扩**:fff-find/fff-grep 的参数校验放行,但常驻索引仍以工作区为根(见 §2 决策 D3)。
- 不改 SDK、不改 config.ts、不改 skill 加载逻辑本身(`loadWorkspaceSkills`/`classifySkillSource` 语义不变)。

---

## 2. 关键设计决策(先读,后改)

### D1:可选参数,向后兼容
`isAllowedTargetPath` / `guardPathTool` 增加第三个可选参数 `extraAllowedRoots: string[] = []`。缺省空数组 ⇒ 现有行为逐字节不变,现有测试与调用方零破坏。放行判定顺序:设备白名单 → 临时目录 → 工作区内 → **任一放行根内**(复用 `isPathWithinWorkspace(root, resolved)` 语义)→ 拒绝。

### D2:bash 完全不放行(推荐,采纳用户建议)
理由:
- bash 静态审计无法可靠区分只读与写:`cat x > ~/.agents/skills/.../evil` 是重定向写;`cp ~/.agents/x /tmp/y` 读+写;`sed -i` 就地写;放行「读类命令」必须同时处理重定向/管道/命令替换,审计面急剧扩大,与「护栏定位」冲突。
- 专用 read 工具 path 参数单一、校验精确,已完全覆盖「读 SKILL.md 及 skill 目录内 scripts/references/assets」的需求。
- 若未来确需 bash 执行 skill 内脚本,单独议题另议(可考虑只放行纯读命令且拒绝一切写重定向,成本高,默认不做)。
- 因此:bash 层不加任何参数、不做任何放宽;补一条回归测试固化「bash 读 skills 仍拦」。

### D3:fff 放行的是「参数校验」,不是「索引范围」
fff-find/fff-grep 已确认经 `guardPathTool` 包装(piService.ts L246 / subAgent.ts L109),且 schema 含 `path` 参数。按任务要求对 fff 也传 extraAllowedRoots,但索引仍以工作区为根(`FileFinder.create({ basePath: workspacePath })`):`path` 指向工作区外时 `normalizeSubPath` 会退化为 `''`(整仓检索),结果可能误导。文档明示「skills 目录的读取主路径是 read/ls」;备选方案(fff 参数不放行、保持报错)已评估,不采纳。

### D4:放行根 = 子树语义,隔离只扩到 skills 根之下
放行判断是「target 位于放行根**之下**」(含根自身),因此:
- `~/.workflows/skills/...` 放行,**`~/.workflows/config.json` / sessions / agents 不放行**(兄弟路径仍在工作区外)。
- `~/.agents/skills/...` 放行,`~/.agents/...` 其他内容不放行。
这是本次护栏放宽的安全性质,必须有用例固化。

### D5:skillReadRoots 与 loadWorkspaceSkills 解析一致
- 来源 a:`PI_CODING_AGENT_DIR` env 优先(与 SDK `getAgentDir()` 一致,测试依赖此机制),否则 `<homeDir>/.pi/agent/skills`(`homeDirOf(ctx)` = `ctx.homeDir ?? os.homedir()`,保留测试注入)。
- 来源 d:`<homeDir>/.agents/skills`。
- 来源 c:`ctx.skillsDir` **仅当不在 `ctx.cwd` 内时**加入(prod 场景;dev 下在工作区内,冗余且无必要)。
- 来源 b(`<cwd>/.pi/skills`)恒在工作区内,不加入。
- 去重(win32/darwin 折叠大小写),全部 `path.resolve` 为绝对路径,不产生 `~` 形式(guard 侧对 root 再做一次防御性 `path.resolve`)。

---

## 3. 实施步骤(文件级)

### Step 1 — `apps/api/src/pi/workspaceGuard.ts`

1. `isAllowedTargetPath` 签名与判定(约 L118):
   ```ts
   export function isAllowedTargetPath(
     candidate: string,
     workspacePath: string,
     extraAllowedRoots: string[] = [],
   ): boolean {
     if (DEVICE_WHITELIST.has(candidate)) return true
     if (candidate === '/dev/fd' || candidate.startsWith('/dev/fd/')) return true
     const normalized = normalizeBashPath(candidate)
     if (normalized === null) return false
     const resolved = path.resolve(workspacePath, normalized)
     if (isTempPath(resolved)) return true
     if (isPathWithinWorkspace(workspacePath, resolved)) return true
     // 新增:任一放行根内(子树语义;root 防御性 resolve;win32 折叠由 isPathWithinWorkspace 内置)
     for (const root of extraAllowedRoots) {
       if (isPathWithinWorkspace(path.resolve(root), resolved)) return true
     }
     return false
   }
   ```
   说明:`isPathWithinWorkspace(root, target)` 内部 `path.resolve(root, target)`——target 已是绝对路径,resolve 后不变;win32 大小写折叠复用现有逻辑;`~` 展开由 `normalizeBashPath` 在 candidate 侧完成,root 由调用方保证为绝对路径(skillReadRoots 契约)。
2. `guardPathTool` 签名与透传(约 L513):
   ```ts
   export function guardPathTool<T extends ToolDefinition>(
     definition: T,
     workspacePath: string,
     extraAllowedRoots: string[] = [],
   ): T
   ```
   execute 内 `isAllowedTargetPath(rawPath, workspacePath, extraAllowedRoots)`。错误文案不变(现有测试匹配 `/工作区边界拦截/` 即可,避免测试扰动)。
3. `createWorkspaceBashHook` / `auditBashCommand` / `auditCommand` / `auditRedirect`:**零改动**(D2)。

预期结果:guard 层支持可选放行根;不传时行为与现状完全一致。

### Step 2 — `apps/api/src/pi/promptLoader.ts` 新增 `skillReadRoots`

在 `homeDirOf` / `isUnder` 附近新增导出(复用现有 `isUnder` 的 win32/darwin 折叠):

```ts
/**
 * 工作区外 skills 的只读放行根(单一事实源,主/子代理共用)。
 * 与 loadWorkspaceSkills 四来源对应:
 * - (a) <agentDir>/skills:PI_CODING_AGENT_DIR 重定向优先,否则 <homeDir>/.pi/agent/skills
 * - (c) ctx.skillsDir:仅当不在 ctx.cwd 内时加入(prod 场景;dev 在工作区内无需放行)
 * - (d) <homeDir>/.agents/skills
 * 来源 b(<cwd>/.pi/skills)恒在工作区内,不加入。
 * 返回去重后的绝对路径列表(不含 ~ 形式);主代理与子代理必须使用同一结果。
 */
export function skillReadRoots(ctx: SkillLoadContext): string[] {
  const roots: string[] = []
  const agentDir = process.env.PI_CODING_AGENT_DIR
  roots.push(agentDir ? path.resolve(agentDir, 'skills') : path.resolve(homeDirOf(ctx), '.pi', 'agent', 'skills'))
  roots.push(path.resolve(homeDirOf(ctx), '.agents', 'skills'))
  const skillsDir = path.resolve(ctx.skillsDir)
  if (!isUnder(skillsDir, path.resolve(ctx.cwd))) roots.push(skillsDir)
  // 去重 + 过滤工作区内冗余根(win32/darwin 折叠大小写,与 isUnder 一致)
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of roots) {
    if (isUnder(r, path.resolve(ctx.cwd))) continue
    const key = process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}
```

预期结果:四来源映射、env 重定向、homeDir 注入、dev/prod 差异全部由这一处表达;主/子代理天然一致。

### Step 3 — `apps/api/src/pi/piService.ts`(主代理)

`openSession`(L242-264 区域):
1. import 增加 `skillReadRoots`(promptLoader 已有 import 行)。
2. 在工具构建前构造共享上下文(同时服务 guard 与 resourceLoader,单一事实源):
   ```ts
   const skillCtx: SkillLoadContext = { cwd: workspace.path, skillsDir: this.store.skillsDir }
   const extraReadRoots = skillReadRoots(skillCtx)
   ```
3. 三处 `guardPathTool` 调用全部补第三参:
   - `nonSearchTools` 的 `.map((tool) => guardPathTool(toToolDefinition(tool), workspace.path, extraReadRoots))`
   - `finder` 分支的 fff-find / fff-grep 两个 `guardPathTool(..., extraReadRoots)`
   - 回退分支的内置 grep/find 两个 `guardPathTool(..., extraReadRoots)`
4. `createBashTool(workspace.path, { spawnHook: createWorkspaceBashHook(workspace.path) })` **不改**(D2)。
5. L297 `mainResourceLoader` 的 `skills:` 改为复用 `skillCtx`(顺带消除内联重复,低风险)。
6. L666 `listSkills` 的 ctx 保持原样(只读扫描,不涉及 guard)。

预期结果:主代理 read/ls/fff 可读工作区外 skills;bash/write/edit 仍拦。

### Step 4 — `apps/api/src/pi/subAgent.ts`(子代理)

1. `buildSubAgentTools` options 增加可选字段:
   ```ts
   /** 工作区外只读放行根(见 promptLoader.skillReadRoots);缺省 [] 保持现有行为 */
   extraAllowedRoots?: string[]
   ```
   destructure 时 `extraAllowedRoots = []`;只读基础工具与 fff 工具的 `guardPathTool` 补第三参;`createWorkspaceBashHook`(executor 分支)与 `guardWriteTool` **不传**。
2. `runSubAgent`(L333-349):
   ```ts
   const skillCtx: SkillLoadContext = { cwd: workspace.path, skillsDir: store.skillsDir }
   const { tools, activeNames } = buildSubAgentTools({
     workspace, definition, fff, matcher,
     getAnySearchApiKey: ...,
     extraAllowedRoots: skillReadRoots(skillCtx),
   })
   ...
   const resourceLoader = createPromptOnlyLoader({ systemPrompt: definition.body, skills: skillCtx })
   ```
3. import 增加 `skillReadRoots`、`type SkillLoadContext`。

预期结果:子代理与主代理放行面一致;现有测试不传新参,向后兼容。

### Step 5 — 测试

#### 5.1 `apps/api/src/pi/workspaceGuard.test.ts`(新增用例,AGENTS.md 约定必改)

在现有 `guardPathTool` describe 后新增 describe `extraAllowedRoots 只读放行根`:

1. **放行根内路径放行**:`const root = path.join('C:\\Users\\kaijia', '.agents', 'skills')`;`guardPathTool(def, WS, [root])` 后执行 `{ path: path.join(root, 'grill-me', 'SKILL.md') }` → 原 execute 执行、不抛错。
2. **放行根外仍拦**:同 root,`{ path: path.join('C:\\Users\\kaijia', '.agents', 'config.json') }`(根之兄弟)→ reject `/工作区边界拦截/`,原 execute 不执行。
3. **`..` 逃逸出放行根仍拦**:`{ path: path.join(root, '..', 'secret.txt') }` → reject。
4. **缺省行为不变(回归)**:不传 extraAllowedRoots,`{ path: path.join(root, 'grill-me', 'SKILL.md') }` → reject(即现状:无放行根时 skills 路径仍拦)。
5. **`~` 形式经 normalizeBashPath 展开后放行**:`isAllowedTargetPath('~/.agents/skills/grill-me/SKILL.md', WS, [path.join(home, '.agents', 'skills')])` → true(home 取 `process.env.HOME ?? process.env.USERPROFILE`,与 normalizeBashPath 一致)。
6. **win32 大小写折叠**:`process.platform === 'win32'` 时,root 用小写、path 用原大小写 → 放行。
7. **bash 不放行回归(D2)**:`auditBashCommand('cat ~/.agents/skills/grill-me/SKILL.md', WS)` 违规数 > 0(固化「bash 读 skills 仍拦」)。
8. **(可选)真实 AgentSession 集成**:临时 ws + 临时 extraRoot(ws 之外),`writeFileSync` 在 extraRoot 下建 `SKILL.md`,`customTools` 中 read 用 `guardPathTool(def, ws, [extraRoot])` → read 成功;`path` 指向 extraRoot 兄弟路径 → 拦。现有两段集成测试不传 extraRoots,断言不变。

#### 5.2 `apps/api/src/pi/skillsLoader.test.ts`(新增 `skillReadRoots` describe)

沿用现有隔离设施(beforeEach 已 stub `PI_CODING_AGENT_DIR` + 注入 `homeDir`):

1. **四来源映射**:`ctx = { cwd: tmpWs, skillsDir: tmpStore/skills, homeDir: tmpHome }` + env 重定向 → 返回 `[tmpHome/pi-agent/skills, tmpHome/.agents/skills, tmpStore/skills]`(skillsDir 在 cwd 外 ⇒ 含 c)。
2. **dev 场景过滤**:`skillsDir = tmpWs/.workflows/skills`(在 cwd 内)→ 返回 `[tmpHome/pi-agent/skills, tmpHome/.agents/skills]`(不含 c)。
3. **env 未重定向**:用例内 `vi.stubEnv('PI_CODING_AGENT_DIR', '')`(覆盖 beforeEach)→ 来源 a = `tmpHome/.pi/agent/skills`。
4. **去重**:`ctx.skillsDir = tmpHome/.agents/skills`(= 来源 d 根,且不在 cwd 内)→ 结果仍 2 项、无重复。
5. **与 guard 联动(语义闭环)**:`import { isAllowedTargetPath } from './workspaceGuard.js'`;用 `skillReadRoots(ctx)` 结果调用 `isAllowedTargetPath(skillPath, tmpWs, roots)` → true;`isAllowedTargetPath(path.join(tmpHome, '.agents', 'config.json'), tmpWs, roots)` → false(子树语义)。

#### 5.3 `subAgent.test.ts` / `piService.test.ts`
- 现有调用均不传新参 → 向后兼容,无需改动;跑通即回归。
- 可选补一条:传 `extraAllowedRoots` 后 `buildSubAgentTools` 工具集结构不变(read/ls/fff 仍在、bash 不进只读角色)。低价值,可跳过。

预期结果:新旧用例全绿;放行面、拦截面、缺省行为、win32 折叠、bash 不放行均有断言。

### Step 6 — 文档

1. `AGENTS.md`「关键约定 → 工作区边界守卫」行:追加「工作区外的 skills 只读来源(`~/.pi/agent/skills`、`~/.agents/skills`、prod 下 `~/.workflows/skills`)对 read/ls/fff-find/fff-grep 参数校验放行(放行根见 `promptLoader.skillReadRoots`);write/edit/bash 一律不放行」。
2. `AGENTS.md`「Skills(只读来源)」小节:加一行「`skillReadRoots(ctx)` 为工作区外放行根单一事实源,主/子代理共用;改动需同步 workspaceGuard 测试」。
3. `README.md`「Skills → 注意事项」:追加 bullet:「工作区外的 skills 目录(`~/.pi/agent/skills`、`~/.agents/skills`、生产 `~/.workflows/skills`)对 read/ls 只读放行;fff-find/fff-grep 索引仍限工作区(搜不到工作区外 skills);write/edit/bash 不放行」。
4. 注释同步:`workspaceGuard.ts` 文件头注释补一句 extraAllowedRoots 语义;`promptLoader.ts` 顶部注释提及 skillReadRoots。

---

## 4. 验证

```bash
# 1. 定向单测(先跑改动相关)
pnpm --filter @workflows/api exec vitest run src/pi/workspaceGuard.test.ts src/pi/skillsLoader.test.ts src/pi/subAgent.test.ts

# 2. api 全量测试
pnpm --filter @workflows/api test

# 3. 类型检查
pnpm --filter @workflows/api typecheck

# 4.(可选)lint
pnpm --filter @workflows/api lint
```

手动冒烟(dev 环境,本机 `C:\Users\kaijia\.agents\skills\grill-me\SKILL.md` 已确认存在):
1. 启动 dev api;打开工作区会话,提示「用 read 工具读取 ~/.agents/skills/grill-me/SKILL.md 的内容并总结」→ 应成功读到(不再报「工作区边界拦截」)。
2. 提示「用 bash 执行 cat ~/.agents/skills/grill-me/SKILL.md」→ 应报「工作区边界拦截」。
3. 提示「把该文件写入 ~/.agents/evil.txt」→ 应被拦(write 不放行)。
4. 回归:工作区内正常 read/write/edit/bash 行为与改动前一致。

---

## 5. 风险与回滚

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| R1 | 护栏放宽(信任边界):SKILL.md 内容不可信 | 中 | 放行面严格限定 read/ls/fff 参数校验 + 子树语义(仅 skills 根之下);bash/write/edit 完全不动;放行根是进程内配置,模型无法通过文件内容扩大白名单 |
| R2 | 来源 a 根解析漂移(PI_CODING_AGENT_DIR) | 低 | skillReadRoots 与 loadWorkspaceSkills 同规则(env 优先);单测覆盖 env 重定向/未重定向两态 |
| R3 | win32 Git Bash 下 `HOME` 与 `os.homedir()` 不一致时,`~` 形式路径可能仍被拦 | 低 | 与本仓库 `classifySkillSource` 现状一致(非本次引入);缓解:agent 可用绝对路径;可选增强(放行根同时加入 env HOME 展开变体)留作后续,不在本次范围 |
| R4 | fff 索引盲区:工作区外 skills 目录 fff 搜不到,`path` 指向外部时退化为整仓检索(结果可能误导) | 低 | 文档明示 read/ls 为 skills 读取主路径;fff 放行仅消除参数拦截 |
| R5 | prod 下放行 `~/.workflows/skills` 可能被误解为放行整个 `~/.workflows` | 低 | 子树语义保证 config.json/sessions/agents 仍拦;测试 5.1-2 / 5.2-5 固化 |
| R6 | 主/子代理不一致(漏改 subAgent) | 低 | 两处调用点同一 PR 修改;验收清单含子代理冒烟 |
| R7 | 测试环境 HOME 污染 skillsLoader 用例 | 低 | 沿用现有隔离设施(env stub + homeDir 注入),用例内显式覆盖 env |

**回滚方案**:全部改动为「可选参数 + 新增导出函数」,无破坏性变更;回滚 = 撤销对应提交(`git revert`),旧代码与新代码的测试均能通过;文档随提交一起回滚。若只想临时关停放行,把调用点第三参改回缺省(或传 `[]`)即可,无需动 guard 本体。

---

## 6. 验收清单(逐条核对)

- [ ] `workspaceGuard.ts`:`isAllowedTargetPath` / `guardPathTool` 均带 `extraAllowedRoots: string[] = []`;判定顺序 设备→临时→工作区→放行根→拒绝;root 防御性 resolve;`createWorkspaceBashHook` / `auditBashCommand` 未改动
- [ ] `promptLoader.ts`:导出 `skillReadRoots(ctx)`;来源 a(env 优先)/d(homeDirOf)/c(仅 cwd 外);去重 + 过滤工作区内冗余根;返回绝对路径
- [ ] `piService.ts openSession`:构造 `skillCtx` + `extraReadRoots`;nonSearchTools / fff / grep-find 回退三处 guardPathTool 均传第三参;bash hook 不传;resourceLoader 复用 skillCtx
- [ ] `subAgent.ts`:`buildSubAgentTools` options 加可选 `extraAllowedRoots`(缺省 []);runSubAgent 构造并传入;bash hook / guardWriteTool 不传
- [ ] `workspaceGuard.test.ts`:新增 ≥7 用例(放行 / 根外拦 / `..` 逃逸 / 缺省回归 / `~` 展开 / win32 折叠 / bash 不放行回归);可选集成用例
- [ ] `skillsLoader.test.ts`:新增 skillReadRoots 用例(四来源 / dev 过滤 / env 未重定向 / 去重 / guard 联动子树语义)
- [ ] `subAgent.test.ts` / `piService.test.ts` 现有用例全绿(兼容性回归)
- [ ] `AGENTS.md` + `README.md` 已注明 skills 只读放行边界
- [ ] `pnpm --filter @workflows/api test` 全绿;`typecheck` 通过
- [ ] 手动冒烟:read 读 `~/.agents/skills/...` 成功;bash cat / write 仍拦;工作区正常读写不受影响
