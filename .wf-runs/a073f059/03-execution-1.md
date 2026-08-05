# 执行报告(03-execution-1)

## 目标
修复 10 个基线测试失败(Windows 路径硬编码在 Linux 下失准 + 时间断言),使 `pnpm test` 全绿(0 failed),为不走 `--no-verify` 的正常提交铺路。

## 改动文件清单

### 1. `apps/api/src/pi/agentDefs.test.ts`(1 个用例)
- **「绝对路径 / .. 逃逸一律拒绝」**:`isWriteAllowed('C:/Users/x/secret.md', m)` → 平台化变量
  `const absPath = process.platform === 'win32' ? 'C:/Users/x/secret.md' : '/etc/secret.md'`。
- 原因:L145-147 实现 `path.isAbsolute(normalized) || normalized.startsWith('..')` → false 才拒绝;
  Linux 下 `C:/...` 是相对路径,`**` glob 命中 → 误放行。POSIX 绝对路径保留「绝对路径一律拒绝」语义。

### 2. `apps/api/src/pi/runManager.test.ts`(1 个用例)
- **「非 done → done 的首次写盘不被冻结误伤」**:选 **mock 时间**方案(二选一,未用 toBeGreaterThanOrEqual):
  ```ts
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(before.updatedAt + 1000)
  try { run.status = 'done'; run.gate.pending = false; saveRun(dir, run) }
  finally { nowSpy.mockRestore() }
  ```
  同时把 `vi` 加入 vitest import。
- 理由:实现中 `saveRun` 内部写 `run.updatedAt = Date.now()`(runManager.ts:79),mock 时钟确定性推进 1000ms,
  保留严格 `toBeGreaterThan` 语义(冻结回归仍能被抓到),零 flake;sleep 方案有 flake 风险,
  toBeGreaterThanOrEqual 会弱化「必须严格递增」的语义。

### 3. `apps/api/src/pi/workspaceGuard.test.ts`(8 个用例;核心病根 = L24 模块级 WS 硬编码 Windows 路径)
- **根因修复(L24 WS 平台化)**:`const WS = process.platform === 'win32' ? path.resolve('C:\\Users\\kaijia\\...') : '/home/dev/workflows/apps/demo'`。
  Linux 下原 WS 被解析为 cwd 内相对路径(反斜杠是普通字符),`path.join(WS,'..','demo','x.txt')` 无法正确归位,
  所有判定失准。平台化后一举修复:
  - 「工作区内路径全部放行」:`path.join(WS,'..','demo','x.txt')` 重新解析回工作区内 ✓(无需额外改动)
- **「工作区外路径全部拦截」**:第三断言 `'C:\\Users\\kaijia\\secret.txt'` → 平台化
  `process.platform === 'win32' ? 'C:\\Users\\kaijia\\secret.txt' : '/etc/secret.txt'`。
  (Linux 下反斜杠路径是相对路径,`path.resolve(root, target)` 落在工作区内 → 被放行)
- **「Windows 路径大小写不敏感」**:`it.skipIf(process.platform !== 'win32')`(**skip 而非平台化**)。
  理由:大小写不敏感是 Windows/NTFS 语义,Linux/macOS 路径本就大小写敏感,不存在等价覆盖;
  平台化(如用小写 POSIX 路径)会变成恒真空测试,改变断言语义。win32 上原断言原样保留执行。
- **「绝对路径越界(msys 根 / 盘符 / Windows 路径)」**:win32 分支保留 `cat /c/Users/...`、`cat C:/Users/...`、
  `cat C:\Users\...`(msys/盘符/反斜杠均为 win32 专属语义);非 win32 分支用等价绝对越界路径
  `/etc/hosts`、`/root/secret.txt`、`/var/log/syslog` 保持 3 条覆盖强度(盘符路径在 Linux 下是相对路径,
  会被解析进工作区而放行,无法触发拦截)。
- **「工作区外路径拦截,原 execute 不执行」**:path 平台化 → win32 ? `'C:\\Users\\kaijia\\secret.txt'` : `'/etc/passwd'`。
  断言 `rejects.toThrow(/工作区边界拦截/)` 在 Linux 下必须用 POSIX 绝对路径才能触发拦截。
- **「bash 不放行回归」**:第二命令平台化 → win32 ? `cat C:\Users\kaijia\.agents\skills\grill-me\SKILL.md` :
  `cat /etc/agents/skills/grill-me/SKILL.md`(保持「放行根不作用于 bash 层」回归意图)。
- **「customTools 同名覆盖内置工具,守卫生效」**:read 越界参数平台化 → win32 ? `'C:\\Users\\kaijia\\secret.txt'` : `'/etc/passwd'`。
- **「只读工作区工具集带守卫」**:同上平台化。

**未改动**:workspaceGuard.ts / runManager.ts / agentDefs.ts 源码零改动,只改测试。

## 自检结果
| 步骤 | 结果 |
|---|---|
| `pnpm typecheck` | 3/3 successful(api 为 cache miss 实际执行,通过) |
| `pnpm lint` | 3/3 successful(eslint 通过) |
| `pnpm test` | **0 failed**。api:**267 passed | 1 skipped**(268 total);web:34 passed |
| `pnpm build` | 3/3 successful |

- 跳过项唯一确认:`workspaceGuard.test.ts > isPathWithinWorkspace > Windows 路径大小写不敏感`
  (win32 专属语义,Linux 按任务约定 skip;win32 上仍执行)。
- 原 258 个通过用例一个不少(全部仍通过);10 个失败用例中 9 个转绿,1 个按约定在非 win32 跳过。
- 说明:任务预期「268 passed」在 win32 上成立(该用例会执行);当前 Linux 为 267 passed + 1 skipped = 268 total,
  全绿目标达成。

## 未完成项
无。
