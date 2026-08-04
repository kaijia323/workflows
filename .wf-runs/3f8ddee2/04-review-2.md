# 复审报告(第 2 轮):P1/P2/P3 修复核验

> 审查对象:首审 `.wf-runs/3f8ddee2/04-review-1.md`(fail,问题 P1-P4)vs 修复执行 `.wf-runs/3f8ddee2/03-execution-2.md` vs 当前代码。
> 审查方式:静态核对全部改动文件(workspaceGuard.ts / piService.ts / subAgent.ts / workspaceGuard.test.ts / subAgent.test.ts)+ SDK 源码核对(`createCodingTools`/`createReadOnlyTools` 构成、write/edit schema 的 `path` 参数、注册表同名覆盖语义)+ 测试逐条核对。审查环境无 shell,未能复跑测试,「全绿」依据执行报告自述 + 用例数静态对账。
> 审查对象代码状态:apps/api/src/pi 下 5 文件当前快照(2025 轮次 2 修复后)。

## 结论:pass

首审三个问题 P1(阻断)/P2/P3 全部修复到位,修复方向与建议一致;P4 按非阻断处理并已在文档/注释中记录。安全边界复核通过:全部生产调用点中仅只读工具(read/ls/fff/grep/find)接收放行根,write/edit/bash 零放行;bash 层零改动;无新增重名覆盖隐患。测试断言有效(修复前必失败),用例数与执行报告自述一致(44+19=63 定向)。

---

## 逐条核对(本轮核查清单)

### 1. P1 修复:放行根只对只读工具生效 — 通过

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| `guardToolSet` 只对 read/ls 传放行根 | 通过 | workspaceGuard.ts L560-569:`tool.name === 'read' \|\| tool.name === 'ls'` 传 `extraAllowedRoots`,其余一律 2 参 `guardPathTool`。JSDoc(L555-559)明确安全边界(写 skills = 持久性提示注入面)。白名单式判定,新增工具默认不放行,方向安全 |
| 主代理 write/edit 确认不传 | 通过 | piService.ts L244-251:`nonSearchTools` 改用 `guardToolSet(...)`。SDK 事实:`createCodingTools` = [read, bash, edit, write](dist/core/tools/index.js),故非只读工作区 nonSearchTools 恰为 [read, edit, write],write/edit 走 2 参守卫 |
| fff / grep-find 回退仍传第三参 | 通过 | piService.ts L255-256(fff-find/fff-grep)、L260(内置 grep/find)——均为只读工具,传放行根正确 |
| bash 不传 | 通过 | L257-258 `createBashTool(workspace.path, { spawnHook: createWorkspaceBashHook(workspace.path) })`,无第三参 |
| 拦截有效性(参数名) | 通过 | SDK write.d.ts / edit.d.ts schema 均为 `path: TString`,2 参 guard 对放行根路径仍会 reject「工作区边界拦截」(写盘前拦截) |
| 全仓调用点审计 | 通过 | 生产代码 `guardPathTool` 3 参调用仅 5 处:piService fff×2、grep/find 回退、subAgent 只读基础工具、subAgent fff×2——全部只读;`guardWriteTool`(subAgent.ts L153/161)2 参 + matcher,无放行根;无任何 write/edit 接收放行根的调用点 |

### 2. P2 修复:executor 分支 read 不丢放行根 — 通过

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| executor 分支排除 read/ls | 通过 | subAgent.ts L133-141 filter 在原有 grep/find/bash 之外新增 `tool.name !== 'read' && tool.name !== 'ls'`(ls 为防御性,createCodingTools 本无 ls)。SDK 事实:createCodingTools = [read, bash, edit, write] ⇒ 过滤后仅 [edit, write],均 2 参守卫 |
| 两分支 read 行为一致 | 通过 | read 仅由只读基础工具注册(subAgent.ts L104-107,带 extraAllowedRoots),executor 与 explorer/planner/reviewer 共用同一注册,放行面一致 |
| 无重名覆盖隐患 | 通过 | executor 工具集 = [read, ls, fff-find, fff-grep, anysearch-search, edit, write, bash],名称全唯一;read 仅注册一次,SDK 注册表同名后者覆盖问题不再触发 |
| write/edit 仍不放行 | 通过 | executor 分支 coding 工具 2 参 guard(L142);bash 经 createWorkspaceBashHook(L146)无放行根;白名单写分支 guardWriteTool 无放行根 |
| runSubAgent 传入放行根 | 通过 | subAgent.ts L353 `extraAllowedRoots: skillReadRoots(skillCtx)`(L345-346 与主代理共用同一 SkillLoadContext) |

### 3. P3 新增 3 用例有效性 — 通过

| 用例 | 位置 | 有效性判定 |
| --- | --- | --- |
| write/edit 对放行根内路径仍拦 + read/ls 放行 | workspaceGuard.test.ts L386-405 | 与主代理调用点同构(read/write/edit/ls 四工具经 guardToolSet);断言原 execute 执行记录(read/ls 侧)与不执行(write/edit 侧),非空断言;修复前(全部带根)write/edit 会被放行 ⇒ 用例必失败 |
| 缺省回归(不传根仍拦) | workspaceGuard.test.ts L408-415 | guardToolSet 缺省行为与 guardPathTool 一致,read 对 skills 路径 reject;修复前此行为亦成立,属回归固化 |
| subAgent 两分支 read 均放行 + 控制组仍拦 + executor read 唯一 + write/edit 仍拦 | subAgent.test.ts L109-164 | 4 重断言:explorer/executor 的 read 对放行根路径均不抛边界拦截、不传根的 executor read 仍拦(证明放行根生效,修复前 executor read 被 2 参版本覆盖 ⇒ 此断言必失败)、`executor.tools.filter(read)` 长度 1(重名覆盖回归)、write/edit 对放行根路径仍 reject。放行根取真实 HOME 下 `~/.agents/skills`(不在临时目录白名单),保证断言非空 |

### 4. 回归 — 通过(静态对账;未能实跑)

- workspaceGuard.test.ts:44 个 it(首审 42 + 本轮 guardToolSet 2),无删减;首审「只读工作区工具集带守卫」集成用例(L508)仍在。
- skillsLoader.test.ts:14 个 it(既有 9 + skillReadRoots 5,L160-213)原样保留。
- subAgent.test.ts:19 个 it(既有 18 + P2 回归 1)。
- 定向对账:44 + 19 = 63,与执行报告「63 passed」一致;api 全量 11 files / 183 passed、typecheck、lint 全绿为执行报告自述,审查环境无 shell 未能复核(局限已注明)。
- piService.test.ts(6 个 it)/ 其他测试文件未见改动痕迹。

### 5. 安全面复查 — 通过

- 放行严格限定只读:全部生产调用点中带放行根的仅 read/ls/fff-find/fff-grep/grep/find;write/edit/bash 均 2 参/无根。guardToolSet 白名单方向保守。
- bash 零改动:`auditBashCommand` / `createWorkspaceBashHook` / `auditCommand` / `auditRedirect` 签名与调用均无放行根透传;extraAllowedRoots 在 bash 路径零出现。
- 无新绕过路径:executor read 唯一注册;guardToolSet 无「按名称以外的旁路」;L791 `getSubAgentHistory` 的 createAgentSession 无 customTools,无写面。
- P4(符号链接逃逸):按非阻断处理,词法 resolve 与本仓库既有 `isPathWithinWorkspace` 语义一致,已在 workspaceGuard.ts 文件头注释(「符号链接不解析」)与计划 R1 记录,留作后续议题——接受。

---

## 问题清单

| # | 级别 | 文件/位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | 低(不阻断) | workspaceGuard.test.ts L374-376 | `const home = process.env.HOME ?? process.env.USERPROFILE` 后 `path.join(home!, ...)`:两 env 均缺失时抛 TypeError 而非清晰断言失败(极罕见,CI 一般有 HOME) | 可加 `expect(home).toBeTruthy()`(subAgent.test.ts L116 已这么做) |
| 2 | 低(不阻断) | subAgent.test.ts L120-127 `readOutcome` | catch 吞掉所有错误,仅断言不含「工作区边界拦截」;若底层 read 对缺失文件抛非边界错误,断言仍过——断言方向正确但强度略弱 | 可改为断言 reject 消息恰为边界拦截或 isError=false;现有断言已满足回归捕获价值,非必需 |
| 3 | 提示 | subAgent.ts L107-112 | 子代理未复用 `guardToolSet`,而是内联等价逻辑(基础只读带根 + 写工具 2 参);当前无遗漏,但未来新增只读工具时两处需同步 | 可考虑子代理也改走 guardToolSet 收敛语义(非阻断,本轮不必) |
| 4 | 提示 | 执行报告 | 手动冒烟第 3 项为「代码级临时 vitest 冒烟(验证后删除)」,非真实会话级验证;第 1/2 项(真实会话 read 成功 / bash cat 拦截)未在本轮重跑 | 建议在下一轮全量验证时补真实会话冒烟 1/2 项 |

---

## 最终建议:**通过**

- P1(阻断):已修复——主代理 write/edit 不再带放行根,`guardToolSet` 收敛只读语义,调用点代码核对确认(非仅测试)。
- P2:已修复——executor 分支 read/ls 排除重名,read 唯一注册且带放行根,两分支放行面一致。
- P3:3 个新用例均为有效断言(修复前必失败),且未删减既有用例。
- 回归与安全面:静态对账通过;bash 零改动;无新绕过路径;P4 已文档化。
- 局限:审查环境无 shell,未能实跑 test/typecheck/lint,「全绿」采信执行报告自述(用例数与自述一致,代码层面未见会导致失败的改动)。
