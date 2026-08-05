# 复审报告(04-review-1)

**结论:pass**

审查对象:`.wf-runs/a073f059`(runId a073f059,执行报告 `03-execution-1.md`;产物目录无 `02-plan-*.md`,`run.json` 中 `planFile: null`,以执行报告 + run.json 为审查基线)。

改动范围(与报告一致):`apps/api/src/pi/agentDefs.test.ts`、`runManager.test.ts`、`workspaceGuard.test.ts` 三个测试文件,源码零改动。审查方法:三份测试文件 + 三份源码全量阅读、逐断言语义推演、模式扫描交叉验证(本环境无 shell,未能独立复跑 `pnpm test` / `git diff`,见问题清单 3)。

## 逐条核对

| # | 计划/核对项 | 状态 | 说明 |
|---|---|---|---|
| 1a | agentDefs 平台化正确性 | 通过 | `agentDefs.test.ts:155`:win32 分支原样保留 `'C:/Users/x/secret.md'`(win32 下 `path.isAbsolute` 为 true → 拒绝,语义不变);非 win32 用 `/etc/secret.md`,`isWriteAllowed`(agentDefs.ts:219-224)先判 `path.isAbsolute` → true → 拒绝。两分支均非空断言:去掉守卫后 `**` matcher 会放行,断言仍真实验证「绝对路径一律拒绝」。 |
| 1b | workspaceGuard WS 平台化 | 通过 | `workspaceGuard.test.ts:28-30`:win32 分支 = 原 `path.resolve('C:\\Users\\kaijia\\...')` 原样;非 win32 用 POSIX 绝对根 `/home/dev/workflows/apps/demo`。WS 仅作词法根(path.resolve/join/relative 纯计算,无真实目录访问),逐断言推演:放行(含 `join(WS,'..','demo','x.txt')` 归一落回 WS 内)、拦截(`join(WS,'..')`、`join(WS,'..','other',...)`、`/etc/secret.txt` 相对 WS 均以 `..` 开头)全部成立。 |
| 1c | 越界路径平台化等价性 | 通过 | `workspaceGuard.test.ts:44,281,480,548,381`:`/etc/secret.txt`、`/etc/passwd`、`/etc/agents/skills/...` 在非 win32 均解析为绝对越界 → 拦截/拒绝成立;win32 分支(`C:\\Users\\kaijia\\secret.txt` 等)原样保留。「绝对路径越界」测试(150-164):win32 分支保留 msys/盘符/反斜杠 3 条原断言,非 win32 用 `/etc/hosts`、`/root/secret.txt`、`/var/log/syslog` 3 条等价覆盖(盘符路径在 Linux 是相对路径、会解析进工作区,无法触发拦截,替换正确)。 |
| 1d | 断言改空隐患 | 通过 | 所有平台化断言在两个分支均真实验证守卫行为(经 agentDefs.ts / workspaceGuard.ts 源码逐行推演),无恒真/恒空断言。 |
| 2a | skipIf 合理性 | 通过 | `workspaceGuard.test.ts:50`:`it.skipIf(process.platform !== 'win32')`。大小写不敏感是 NTFS/win32 语义(win32 下 `path.win32.relative` 大小写折叠,两断言均 true),Linux/macOS 路径大小写敏感、该语义不存在,平台化(用小写 POSIX 路径)只会产生恒空测试、改变语义——skip 而非平台化是正确取舍;win32 上原断言原样执行。 |
| 2b | skip 计数一致性 | 通过 | 全 `apps/api/src/pi` 目录仅此 1 处 skip;268 = 267 passed + 1 skipped 与执行报告一致(258 原有通过 + 9 转绿 = 267;该用例在 win32 上计入 268 passed)。 |
| 3a | Date.now mock 恢复 | 通过 | `runManager.test.ts:242-249`:`nowSpy` 在 `finally` 中 `mockRestore()`,即使 `saveRun` 抛错也恢复。 |
| 3b | mock 影响范围 | 通过 | mock 窗口仅覆盖一次 `saveRun` 调用:`createRun`/`appendRunAgentCall`/`before = loadRun(...)` 均在 mock 之前(纯 JSON 读,不涉 Date.now);mockRestore 后 `after = loadRun(...)` 亦不涉 Date.now。不影响同文件其他用例与并发用例。 |
| 3c | toBeGreaterThan 严格语义 | 通过 | mock 值 = `before.updatedAt + 1000` 确定性严格大于,`saveRun`(runManager.ts:79)写 `run.updatedAt = Date.now()` → 断言必然通过;未改用 toBeGreaterThanOrEqual、未引入 sleep flake。`vi` 已加入 vitest import(runManager.test.ts:1)。 |
| 4a | 无夹带(测试文件) | 通过 | 三份测试文件全量阅读:改动仅为报告所列目标断言 + 必要注释 + `vi` import,其余断言(含各 describe 其余用例)未触碰。残留 Windows 路径扫描(`C:\Users`/`C:/Users`)仅出现在 win32 分支或平台无关断言(workspaceGuard.test.ts:84 断言的正是「原样返回」语义,Linux 下同样成立)。 |
| 4b | 无夹带(源码零改动) | 通过* | 本环境无 shell 无法执行 `git diff` 独立证实;佐证:①三份源码(workspaceGuard.ts / runManager.ts / agentDefs.ts)全量阅读,逻辑与测试自洽、无需任何改动即可满足新断言;②平台化模式扫描显示 `process.platform === 'win32'` 仅存在于三个测试文件与源码既有逻辑(promptLoader.ts:111,144、workspaceGuard.ts:113,155,171、agentDefs.ts:224、fffTools.ts:167,249),无新增源码痕迹。 |
| 5a | 原有通过用例不回归 | 通过 | 文件内未改动断言逐条阅读确认未被波及;258 + 9 = 267 与报告 `267 passed | 1 skipped(268 total)` 算术一致。 |
| 5b | pre-commit 预期 | 通过 | `.husky/pre-commit` = lint-staged(eslint --fix 三个 ts 文件)+ `pnpm typecheck` + `pnpm test`。静态检查:无未使用 import、无 lint 阻塞项;vitest ^4.1.10(root package.json devDependencies)支持 `it.skipIf` 与 `vi.spyOn(Date,'now')` 类型;报告自检 typecheck/lint/test/build 全绿。 |

## 问题清单(轻微观察,均不构成缺陷)

1. **无计划文件**:产物目录无 `02-plan-*.md`(`planFile: null`),本次审查以执行报告为唯一基线,计划级对照无法执行——属流程观察,建议后续 run 补齐计划产物。
2. **报告计数口径模糊**(`03-execution-1.md`):「workspaceGuard.test.ts(8 个用例)」含「工作区内路径全部放行」,但该用例三个断言经推演在旧代码 Linux 下亦恒通过(`path.join(WS,'..','demo','x.txt')` 的 `..` 归一化必然落回 WS 内),应非原始 10 个失败之一;报告「10 失败 = 9 转绿 + 1 跳过」的原始基线无法独立复现。不影响结论:当前状态可验证为 267 passed + 1 skipped,且每个修复断言均静态验证成立。
3. **验证手段受限**:无 shell,未能独立复跑 `pnpm test` / `git diff`;「0 failed」与「源码零改动」依赖执行报告自检 + 静态推演交叉验证,建议在可执行环境补一次复跑确认。
4. **风格瑕疵**:`workspaceGuard.test.ts:272` `return (def.execute as unknown as Exec)( 'id', params)` 括号内多余空格(该文件另一处同函数为正常 `('id', params)`);eslint --fix 可自动规整,不阻塞提交,无语义影响。

## 最终建议

**通过**。10 个基线失败已按约定修复:9 个转绿(agentDefs 1 + runManager 1 + workspaceGuard 7 处越界断言),1 个(win32 大小写专属语义)按约定在非 win32 skip;win32 分支原断言语义全部原样保留;无断言改空、无夹带、无回归;267 passed + 1 skipped 与报告一致,pre-commit 预期全绿。无需打回。
