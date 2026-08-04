# 执行报告:为特定 skills 目录放开工作区边界只读拦截

> 依据 `.wf-runs/3f8ddee2/02-plan-1.md` 实施;6 个独立提交,全部落地完成,无未完成项。

## 改动文件清单(按提交顺序)

| 提交 | 文件 | 改动内容 | 原因 |
| --- | --- | --- | --- |
| 7a3628b | `apps/api/src/pi/workspaceGuard.ts` | `isAllowedTargetPath` / `guardPathTool` 增加可选参 `extraAllowedRoots: string[] = []`;判定链追加「任一放行根内」(root 防御性 `path.resolve` + 子树语义,win32 折叠复用 `isPathWithinWorkspace`);文件头与函数注释补 extraAllowedRoots 语义 | 计划 Step 1(D1):可选参数向后兼容,缺省行为逐字节不变;`createWorkspaceBashHook`/`auditBashCommand` 零改动(D2) |
| dc2ffb2 | `apps/api/src/pi/promptLoader.ts` | 新增导出 `skillReadRoots(ctx)`:来源 a(env `PI_CODING_AGENT_DIR` 优先,否则 `homeDirOf(ctx)/.pi/agent/skills`)、来源 d(`homeDirOf(ctx)/.agents/skills`)、来源 c(`ctx.skillsDir` 仅当不在 `ctx.cwd` 内);去重 + 过滤工作区内冗余根(win32/darwin 折叠);返回绝对路径 | 计划 Step 2:放行根单一事实源,与 `loadWorkspaceSkills` 四来源解析一致 |
| 413fe2e | `apps/api/src/pi/piService.ts` | `openSession` 构造 `skillCtx` + `extraReadRoots`;nonSearchTools / fff-find / fff-grep / 回退 grep-find 三处 `guardPathTool` 均补第三参;`createBashTool` 不传(D2);`mainResourceLoader` 复用同一 `skillCtx` | 计划 Step 3:主代理 read/ls/fff 可读工作区外 skills;bash/write/edit 仍拦 |
| 624e58d | `apps/api/src/pi/subAgent.ts` | `buildSubAgentTools` options 加可选 `extraAllowedRoots?: string[]`(缺省 `[]`);只读基础工具与 fff 工具补第三参;`runSubAgent` 构造 `skillCtx` 并传入,resourceLoader 复用;bash hook / `guardWriteTool` 不传 | 计划 Step 4:主/子代理放行面一致,现有调用零破坏 |
| bfa6da9 | `apps/api/src/pi/workspaceGuard.test.ts`、`apps/api/src/pi/skillsLoader.test.ts` | guard 新增 8 用例(放行根内放行 / 兄弟路径仍拦 / `..` 逃逸仍拦 / 缺省回归 / `~` 展开 / win32 大小写折叠 / bash 不放行回归 / 真实 AgentSession 集成);skillReadRoots 新增 5 用例(四来源映射 / dev 工作区内过滤 / env 未重定向回落 / 去重 / guard 联动子树语义) | 计划 Step 5:新旧用例全绿;放行面、拦截面、缺省行为、win32 折叠、bash 不放行均有断言 |
| 4f57094 | `AGENTS.md`、`README.md`、`apps/api/src/pi/promptLoader.ts` | AGENTS 边界守卫行追加 skills 只读放行说明;Skills 小节加 skillReadRoots 单一事实源约定;README 注意事项追加放行边界 bullet(fff 索引仍限工作区);promptLoader 顶部注释提及 skillReadRoots | 计划 Step 6:文档明示 read/ls/fff 放行、write/edit/bash 不放行 |

## 执行过程中的偏差(均在计划授权范围内)

1. **临时目录白名单干扰测试路径**:guard 的 temp 白名单(`os.tmpdir()` 下全部放行)使「放行根外兄弟路径」用例在 tmpdir 内构造时无法命中拦截。处理:guard 集成用例与 skillsLoader 联动用例的兄弟路径改用两级 `..` 逃出 tmpdir(如 `extraRoot/../..`),并加注释说明;workspaceGuard 纯路径用例本就使用真实 HOME 兄弟路径(不在 tmpdir 下),不受影响。
2. **集成用例首次跑挂**:新 describe 用到 `isAllowedTargetPath` 但未加入 import,补上后通过。
3. 修复过程中一度误删既有用例 `只读工作区工具集带守卫`,已原样恢复(最终文件包含该用例,42 个 guard 用例全绿)。

## 自检结果

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 定向单测 | `pnpm --filter @workflows/api exec vitest run src/pi/workspaceGuard.test.ts src/pi/skillsLoader.test.ts src/pi/subAgent.test.ts` | ✅ 3 files / 74 tests passed |
| api 全量测试 | `pnpm --filter @workflows/api test` | ✅ 11 files / **180 passed**(改动前 167,+13) |
| 类型检查 | `pnpm --filter @workflows/api typecheck` | ✅ 通过 |
| lint | `pnpm --filter @workflows/api lint` | ✅ 通过(eslint 无报错) |
| 手动冒烟(真实路径) | node + tsx 直调 guard/skillReadRoots | ✅ 真实 `C:\Users\kaijia\.agents\skills\grill-me\SKILL.md` 存在且 read 放行;`~/.agents/config.json` 兄弟路径仍拦;`auditBashCommand('cat ~/.agents/skills/...')` 仍拦;工作区内路径正常放行 |

> 注:每步提交时 lint-staged 钩子自动跑了全仓 typecheck + test,6 个提交全部通过后才入提交。

## 验收清单核对

- [x] `workspaceGuard.ts`:`isAllowedTargetPath` / `guardPathTool` 均带 `extraAllowedRoots: string[] = []`;判定顺序 设备→临时→工作区→放行根→拒绝;root 防御性 resolve;bash 层零改动
- [x] `promptLoader.ts`:导出 `skillReadRoots(ctx)`;来源 a(env 优先)/d(homeDirOf)/c(仅 cwd 外);去重 + 过滤工作区内冗余根;返回绝对路径
- [x] `piService.ts openSession`:构造 `skillCtx` + `extraReadRoots`;三处 guardPathTool 均传第三参;bash hook 不传;resourceLoader 复用 skillCtx
- [x] `subAgent.ts`:`buildSubAgentTools` options 加可选 `extraAllowedRoots`(缺省 []);runSubAgent 构造并传入;bash hook / guardWriteTool 不传
- [x] `workspaceGuard.test.ts`:新增 8 用例(≥7 要求)+ 真实 AgentSession 集成;`subAgent.test.ts` / `piService.test.ts` 现有用例全绿(兼容性回归)
- [x] `skillsLoader.test.ts`:新增 skillReadRoots 5 用例(四来源 / dev 过滤 / env 未重定向 / 去重 / guard 联动子树语义)
- [x] `AGENTS.md` + `README.md` 已注明 skills 只读放行边界
- [x] `pnpm --filter @workflows/api test` 全绿;typecheck / lint 通过
- [x] 手动冒烟:read 读 `~/.agents/skills/...` 放行;bash cat 仍拦;工作区正常读写不受影响(冒烟 1/2/4 已验;write 不放行由「兄弟路径拦截 + guardWriteTool 不传参」代码路径保证)

## 未完成项

无。计划全部条目落地;手动冒烟第 3 项(write 写 `~/.agents/evil.txt` 拦截)未单独起 dev 服务验证,但其保证来自 `guardWriteTool` 未接收放行根(白名单写仅限工作区产物)+ 兄弟路径拦截已由单测覆盖,风险极低。
