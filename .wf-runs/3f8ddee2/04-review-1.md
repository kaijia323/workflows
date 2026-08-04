# 审查报告:为特定 skills 目录放开工作区边界只读拦截

> 审查对象:计划 `.wf-runs/3f8ddee2/02-plan-1.md` vs 执行 `.wf-runs/3f8ddee2/03-execution-1.md`(6 个提交)
> 审查方式:静态核对全部改动文件 + SDK 工具注册语义(重复同名工具后者覆盖)+ 测试逐条核对;无 shell 工具,未能复跑 test/typecheck/lint(执行报告自述全绿,测试数量与静态核对一致)

## 结论:fail

计划大部分条目落地且质量良好(guard 判定链、skillReadRoots、文档、测试隔离均符合要求),但存在 **1 个阻断级安全边界违规**(主代理 write/edit 被放行根放开,直接违反计划「write/edit 不放行」核心边界与文档声明)与 1 个功能不一致(executor 子代理 read 丢失放行根),须打回修复。

---

## 逐条核对

### 1. workspaceGuard.ts — 通过(部分)

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| `isAllowedTargetPath` / `guardPathTool` 可选参 `extraAllowedRoots: string[] = []` | 通过 | workspaceGuard.ts L129 / L533,缺省空 ⇒ 向后兼容 |
| 判定链顺序 设备→临时→工作区→放行根→拒绝 | 通过 | L125-142:DEVICE_WHITELIST → /dev/fd → normalize → isTempPath → isPathWithinWorkspace → 放行根循环 → false |
| 子树语义 | 通过 | L139 复用 `isPathWithinWorkspace(path.resolve(root), resolved)`;根之兄弟路径拦(测试 5.1-2 固化) |
| `..` 逃逸防护 | 通过 | 词法 resolve 后 `path.relative` 前缀判定;`root/../secret` → rel=`..\secret` → 拦;测试 5.1-3 固化 |
| win32 大小写折叠 | 通过 | `isPathWithinWorkspace` 内置 toLowerCase;测试 5.1-6 固化 |
| root 防御性 resolve | 通过 | L139 `path.resolve(root)` |
| bash 层零改动 | 通过 | `auditBashCommand` / `createWorkspaceBashHook` / `auditCommand` / `auditRedirect` 签名与调用均为 2 参 `isAllowedTargetPath(candidate, workspacePath)`,无任何放行根透传;错误文案不变 |

### 2. promptLoader.ts skillReadRoots — 通过

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 来源 a:env `PI_CODING_AGENT_DIR` 优先,否则 `homeDirOf(ctx)/.pi/agent/skills` | 通过 | promptLoader.ts L135-138,与 `loadWorkspaceSkills` 的 SDK `getAgentDir()` 规则一致 |
| 来源 d:`homeDirOf(ctx)/.agents/skills` | 通过 | L139(homeDir 注入保留测试隔离) |
| 来源 c:`ctx.skillsDir` 仅当不在 cwd 内 | 通过 | L140-141 `isUnder` 判定 |
| 来源 b 恒在工作区不加入 | 通过 | 实现层面天然满足 |
| 去重 + 过滤工作区内冗余根(win32/darwin 折叠) | 通过 | L144-152,与 `isUnder` 折叠策略一致 |
| 返回绝对路径、无 `~` 形式 | 通过 | 全部 `path.resolve` |

### 3. piService.ts 主代理 — 未完成(阻断项,见问题 P1)

- 构造 `skillCtx` + `extraReadRoots`、fff/回退 grep-find 传第三参、bash 不传、resourceLoader 复用 skillCtx:**通过**
- **`edit`/`write` 不放行:未完成**。L244-246 `nonSearchTools` 对读写工作区 = `createCodingTools` 过滤后的 `[read, edit, write]`,**全部**带 `extraReadRoots`。SDK write/edit 的参数名恰为 `path`(dist/core/tools/write.d.ts / edit.d.ts),`guardPathTool` 会拦截并通过放行根 → 主代理 write/edit 可写 `~/.pi/agent/skills`、`~/.agents/skills`、prod `~/.workflows/skills` 下任意文件。违反计划「不做什么」、决策 D2、README L71 / AGENTS.md L22 的「write/edit/bash 一律不放行」声明;执行报告验收清单「bash/write/edit 仍拦」与代码事实不符(手动冒烟第 3 项自认未验证)。

### 4. subAgent.ts 子代理 — 未完成(功能不一致,见问题 P2)

- options 可选 `extraAllowedRoots`(缺省 [])、runSubAgent 构造传入、guardWriteTool/bash 不传:**通过**
- executor(fullWrite)分支:L130-133 `createCodingTools` 过滤后 `[read, edit, write]` 以 2 参 guard 再 push,与 L107 已注册的 `read`(带放行根)重名。SDK `_refreshToolRegistry`(dist/core/agent-session.js)按 `definitionRegistry.set(name, …)` 保序注册、**后者覆盖前者** ⇒ executor 生效的 read = 不带放行根的版本。executor 无法 read 工作区外 skills,而 explorer/planner/reviewer(只读分支)可以,违背计划「主/子代理放行面一致」。ls 不受影响(createCodingTools 无 ls)。

### 5. 测试 — 部分通过

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| guard 8 用例(放行/根外/`..`逃逸/缺省回归/`~`展开/win32折叠/bash不放行/真实 AgentSession 集成) | 通过 | workspaceGuard.test.ts L280-448,逐条对应计划 5.1;`..` 逃逸经词法 resolve 语义成立 |
| skillReadRoots 5 用例(四来源/dev过滤/env回落/去重/guard联动) | 通过 | skillsLoader.test.ts L160-213,与计划 5.2 一一对应 |
| 测试隔离(不触碰真实 ~/.pi/agent 与真实 home) | 通过 | skillsLoader 用 `vi.stubEnv(PI_CODING_AGENT_DIR)` + tmpHome 注入;guard 纯路径用例只用真实 HOME 做字符串比较(无 I/O),集成用例用 tmpdir |
| 误删既有用例 | 通过 | 42 个 guard 用例全在(含「只读工作区工具集带守卫」L423);skillsLoader 既有 9 用例 + 新增 5 = 14 |
| **write/edit 不放行的自动化断言** | 未完成 | 现有用例全部用 read 类 def 验证守卫通用行为,无任何用例断言「放行根下 write/edit 仍拦」——该断言在调用点层面当前是**失败的**(即 P1);计划验收清单此条无测试支撑 |

### 6. 文档 — 部分通过

AGENTS.md L22/L49、README.md L71 均已注明 skills 只读放行边界与 fff 索引盲区,内容与计划 Step 6 一致;但文档声明的「write/edit/bash 一律不放行」与 P1 的实际行为不符(文档描述了目标状态,代码未达)。

### 7. 安全审计 — 见问题清单

---

## 问题清单

### P1(阻断,安全边界违规)— apps/api/src/pi/piService.ts L244-246
**问题**:读写工作区下 `nonSearchTools` 将 `edit`/`write` 一并 `guardPathTool(..., extraReadRoots)`,主代理可经 write/edit 写入 `~/.pi/agent/skills`、`~/.agents/skills`(及 prod `~/.workflows/skills`)任意文件。`guardPathTool` 是通用守卫,不区分工具读写性,放行根对 write/edit 同样生效。后果:模型(或被注入的 prompt)可篡改/种植 SKILL.md——来源 a/d 的技能内容会注入**所有未来会话**的 system prompt(持久性提示注入面),或破坏用户技能文件。这直接违反计划「不做什么」、D2 及 README/AGENTS 声明。
**建议**:拆分只读与非只读工具,放行根只传给只读工具:
```ts
.map((tool) =>
  tool.name === 'read' || tool.name === 'ls'
    ? guardPathTool(toToolDefinition(tool), workspace.path, extraReadRoots)
    : guardPathTool(toToolDefinition(tool), workspace.path),
)
```
(fff/grep-find 分支保持传参不变;readOnly 工作区无 write/edit,不受影响。)并补回归用例:在调用点层面(或给 guard 增加只读语义)断言「带 extraReadRoots 时 write/edit 对放行根路径仍拦」。

### P2(功能不一致)— apps/api/src/pi/subAgent.ts L130-133
**问题**:executor(fullWrite)分支 `tools.push(...coding)` 中 `read` 与 L107 已注册的 `read`(带放行根)重名;SDK 注册表同名后者覆盖(dist/core/agent-session.js `_refreshToolRegistry` 的 `definitionRegistry.set`)⇒ executor 的 read 实际为不带放行根的版本,读不了工作区外 skills,与计划「主/子代理放行面一致」矛盾(planner/explorer/reviewer 可读)。
**建议**:fullWrite 分支过滤掉 read(及 ls,防御性):
```ts
.filter((tool) =>
  tool.name !== 'grep' && tool.name !== 'find' && tool.name !== 'bash' && tool.name !== 'read',
)
```
并补用例:`buildSubAgentTools({ extraAllowedRoots })` 后断言 executor 的 read 对放行根路径放行(计划 5.3 中「低价值可跳过」的用例实际有捕获价值)。

### P3(测试缺口)— apps/api/src/pi/workspaceGuard.test.ts / subAgent.test.ts
**问题**:计划验收清单「write/edit 不放行」无自动化断言;guard 测试只覆盖 read 类工具,未覆盖「放行根 + 写工具」的组合(该组合在 P1 修复前是放行的);executor 工具集无 extraRoots 生效性断言(P2)。
**建议**:P1/P2 修复时同步补上述用例;手动冒烟第 3 项(write 写 `~/.agents/evil.txt` 拦截)在修复后补验。

### P4(中低,既有信任模型,建议记录)— apps/api/src/pi/workspaceGuard.ts L110-118
**问题**:判定为词法 resolve,不解析符号链接(注释明示「符号链接不解析」)。放行根引入后,技能目录内容不可信(计划 R1 自认 SKILL.md 不可信):第三方技能目录若含指向工作区外敏感文件(如 `~/.ssh/id_rsa`)的符号链接,read 会跟随链接读出。工作区内同类问题已存在(文件由用户自控),但技能目录由外部安装,属本次放行新增的逃逸面。
**建议**:对 extraAllowedRoots 的匹配改为 realpath 规范化后比较(至少对放行根生效),或在文档中明示该风险;win32 junction 同理。非阻断。

---

## 最终建议:**打回执行**

- 阻断项 P1 必须修复(主代理 write/edit 被放行,与计划核心边界冲突),修复后补 P3 对应断言;
- P2 一并修复(executor read 丢放行根),成本一行;
- P4 建议处理或至少文档化;
- 修复后复跑 `pnpm --filter @workflows/api test` / typecheck / lint 并补手动冒烟第 3 项,再行复审。
- 另注:计划 Step 3 第 3 条「nonSearchTools 全部补第三参」本身未排除 edit/write,与计划「不做什么」自相矛盾;复审时建议同步修正计划表述,避免后续照抄。
