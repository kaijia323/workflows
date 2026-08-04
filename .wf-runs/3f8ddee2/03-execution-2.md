# 执行报告(第 2 轮修复):审查 P1/P2/P3 修复

> 依据审查报告 `.wf-runs/3f8ddee2/04-review-1.md`(打回)与计划 `.wf-runs/3f8ddee2/02-plan-1.md`。
> 修复范围:仅审查指出的 P1(阻断)、P2、P3;bash 层零改动、只读放行面不变。

---

## 一、改动文件清单

### 1. `apps/api/src/pi/workspaceGuard.ts` — 新增 `guardToolSet`(P1 修复载体 + 测试接缝)

新增导出函数 `guardToolSet(tools, workspacePath, extraAllowedRoots = [])`:对一组工具逐个做路径守卫,**只对只读工具(read/ls)传 extraAllowedRoots,write/edit 一律按 2 参守卫**(不传放行根)。JSDoc 明确安全边界:放行根若作用于 write/edit,模型可篡改/种植工作区外 skills(内容注入所有未来会话 system prompt,持久性提示注入面)。
原因:guardPathTool 是通用守卫、不区分工具读写性;必须把「只读才放行」的语义收敛到一处,并为主代理调用点提供可测试接缝。

### 2. `apps/api/src/pi/piService.ts` — 主代理 write/edit 不再带放行根(P1)

`openSession` 中 `nonSearchTools` 由「全部工具传 extraReadRoots」改为 `guardToolSet(...)`(read/ls 放行,edit/write 不放行)。fff-find/fff-grep 与回退内置 grep/find 分支保持传第三参不变(只读);bash hook 不传(不变)。新增 import `guardToolSet`。
原因:修复审查 P1——修复前 `nonSearchTools` 对 [read, edit, write] 全部传放行根,SDK write/edit 参数名恰为 `path`,guard 校验后放行根生效 ⇒ 主代理可写 `~/.pi/agent/skills`、`~/.agents/skills`、prod `~/.workflows/skills` 下任意文件。

### 3. `apps/api/src/pi/subAgent.ts` — executor 分支 read/ls 排除重名覆盖(P2)

`buildSubAgentTools` 的 `fullWrite`(executor)分支 filter 增加 `tool.name !== 'read'` 与 `tool.name !== 'ls'`(防御性,createCodingTools 现无 ls):read/ls 只由上方只读基础工具注册(带 extraAllowedRoots),避免 SDK 注册表同名后者覆盖导致 executor 的 read 丢失放行根。write/edit 仍以 2 参 guard 注册,不放行。附注释说明原因。
原因:修复审查 P2——修复前 executor 分支 `coding` 内的 read 与 L107 已注册的带放行根 read 重名,SDK `definitionRegistry.set` 后者覆盖前者 ⇒ executor 读不了工作区外 skills,与 explorer/planner/reviewer 放行面不一致。

### 4. `apps/api/src/pi/workspaceGuard.test.ts` — 新增 `guardToolSet` describe(P3:「write/edit 不放行」断言)

- **用例 1(write/edit 不放行)**:构造 read/write/edit/ls 四工具集,`guardToolSet(..., [skillsRoot])` 后:read/ls 对放行根内路径放行(原 execute 执行、记录参数);write/edit 对放行根内路径仍 reject `/工作区边界拦截/` 且原 execute 不执行。与主代理 piService 调用点同构(readOnly 与否两态覆盖:readOnly 无 write/edit,不受影响)。
- **用例 2(缺省回归)**:不传 extraAllowedRoots 时 read 对放行根路径仍拦(guardToolSet 缺省行为与现有一致)。

### 5. `apps/api/src/pi/subAgent.test.ts` — 新增 P2 回归用例

`executor 分支 read 与只读分支 read 放行行为一致(P2 回归:extraAllowedRoots 生效,write/edit 仍拦)`:
- 放行根用真实 HOME 下的 `~/.agents/skills` 路径(避开临时目录白名单,保证断言非空);
- explorer(只读分支)与 executor(fullWrite)两分支生成的 read 工具对放行根内路径均不抛「工作区边界拦截」;
- **控制组**:不传 extraAllowedRoots 的 executor read 对同一路径仍拦(证明放行根确实生效,修复前该用例必失败);
- 断言 executor 工具集中 read 唯一(无重复注册覆盖);
- 断言 executor 的 write/edit 对放行根内路径仍拦(P1 语义在子代理侧成立)。

---

## 二、自检结果

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 定向单测 | `pnpm exec vitest run src/pi/workspaceGuard.test.ts src/pi/subAgent.test.ts` | ✅ 63 passed(含新增 3 用例) |
| api 全量测试 | `pnpm exec vitest run`(apps/api) | ✅ 11 files / 183 passed |
| 类型检查 | `pnpm typecheck`(根,turbo 3 任务) | ✅ 全绿 |
| lint | `pnpm lint`(根,turbo 3 任务) | ✅ 全绿 |
| 手动冒烟第 3 项(代码级) | 临时 vitest 冒烟(验证后删除) | ✅ 真实路径 `C:\Users\kaijia\.agents\skills\grill-me\SKILL.md`(文件存在):read 实际读成功(isError=false);write/edit 在 guard 层即 reject `工作区边界拦截`(写盘前拦截,零 I/O) |

冒烟结论:修复后主代理同构工具集(read+write+edit,guardToolSet 包装,skillReadRoots 放行根)下,真实 `~/.agents/skills` 路径 read 放行、write/edit 拦截——与计划「write/edit/bash 一律不放行」及 README/AGENTS 声明一致。

## 三、未完成项与说明

- **P4(中低,符号链接逃逸)**:审查建议「放行根匹配改 realpath 规范化或文档明示」,标注非阻断。本轮按最小改动原则未改判定逻辑(词法 resolve 语义与本仓库既有 `isPathWithinWorkspace` 一致),风险已在 `workspaceGuard.ts` 注释与计划 R1 中记录,留作后续议题。
- bash 层零改动(未触碰 `auditBashCommand`/`createWorkspaceBashHook`);只读放行面(fff 参数校验、grep/find 回退)保持不变。
- 工作区外(web 端 ChatPane 等)的改动属于并行运行的其他任务,未触碰。
