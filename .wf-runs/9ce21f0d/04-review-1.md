# 审查报告:design 工具移除改动(对照 02-plan-1.md / 03-execution-1.md)

## 结论:pass

design 工具移除彻底、干净,与计划清单一致;仅执行报告存在 2 处数字口径小误差(见问题清单,不影响代码正确性)。

---

## 逐条核对结果

### 1. 删除完整性 ✅
- `apps/api/src/pi/designTools.ts`、`designTools.test.ts`:`ls apps/api/src/pi` 确认不存在 ✓
- `apps/api/dist/pi/designTools.js` / `.js.map`:`ls apps/api/dist/pi` 确认不存在 ✓
- 残留引用检索(`designTools|createDesignTool`,全仓含 docs/scripts):
  - `apps/api/src`:**0 命中**
  - `apps/api/dist`:**0 命中**
  - `docs/`:**0 命中**
  - `apps/web`、`packages/`、`apps/api/scripts`、README.md、package.json、turbo.json、.gitignore、pnpm-workspace.yaml、eslint.config.mjs、.husky:**均 0 命中**
  - 全仓宽口径 `design`(忽略大小写):命中仅限 `.wf-runs/`(历史 + 本 run 产物,豁免)、`designs/` 资产文件、AGENTS.md L11-12(designs/ 目录引用,豁免)——**无一处越界残留**
- subAgent.test.ts 探索报告补遗第 4 处(用例标题「联网/设计工具一致」):当前标题为「联网工具一致」,已修改 ✓

### 2. 注册点同步 ✅
- **piService.ts**(逐行核对 openSession):
  - 无 `createDesignTools` import(头部 import 区已核)
  - 无 designTools/designToolNames 创建语句
  - guardedTools 只读分支 = `[...nonSearchTools, ...searchTools, ...webTools]`;读写分支 = 上述 + bash——无 `...designTools` 展开
  - activeTools 只读 = `['read','ls',...searchNames,...webToolNames]`;读写 = `['read','bash','edit','write',...]`——无 `...designToolNames`
  - 注册(customTools: [...guardedTools, ...subAgentTools])与白名单(tools: [...activeTools, ...])均无 design,无半残留 ✓
- **subAgent.ts**(buildSubAgentTools 全文核对):
  - 无 import;无 `tools.push(...createDesignTools(...))`
  - activeNames = `['read','ls',...fff-...,'anysearch-search']` 结尾,无 `'design'` ✓

### 3. 子代理文档 ✅
- **explorer.md**:末尾「外部设计库调研」整节已删;「执行要求」第 4 条 = 通用 anysearch-search 调研指引(不依赖 design 工具),编号 1-4 连续,无悬空引用 ✓
- **executor.md** / **planner.md**:末尾下载类整节已删,约束节衔接自然,无 design 字样 ✓
- **orchestrator.md**:可用子代理列表仅 explorer/planner/executor/reviewer + wait_for_approval + complete_task;调度策略编号 1-7 连续(无第 8 条残留)✓

### 4. docs/dag-workflow.md ✅
- 「子代理工具集补充」仅剩 anysearch-search 一条 bullet,注册点说明已删;§4.1 整节已删,其后直接 `## 5. 数据模型`,无断号、无 4.2;全文 0 处 design 命中 ✓

### 5. 保护项未误伤 ✅
- AGENTS.md 完好,仅保留 L11-12 `designs/voltagent/DESIGN.md`、`designs/warp/DESIGN.md` 目录引用(允许保留项)
- `designs/` 目录完整(voltagent / warp 两个 DESIGN.md 均在)
- `workspaceGuard.ts`(含 isPathWithinWorkspace)、`anySearchTools.ts`(含 truncateOutput 副本)均在,内容未被触碰(grep 无 design 命中)
- 改动范围与计划清单一致:8 修改 + 2 删除(源文件)+ 2 dist 残留清理(dist 为 gitignore,无 git diff)。注:审查环境无 shell,无法直接执行 `git diff` 复核,但全仓 grep 零残留 + 保护文件原样,与报告自述范围吻合

### 6. 构建产物 ✅
- `dist/pi/` 无 designTools.js* 残留
- `dist/pi/agents/*.md` 与 src 同步:逐字核对 explorer.md(含第 4 条 anysearch 指引)与 orchestrator.md(1-7 连续、无 design),与 src 完全一致;`grep -i design dist/pi/agents` 0 命中 ✓

### 7. 验收可复现(数字核对)✅(附 2 处报告口径误差)
- 独立统计当前测试总数:**158 例** = pi/ 145(agentDefs 20 + anySearchTools 29(17 it + it.each 9 + 3)+ fffTools 20 + history 3 + piService 6 + runManager 15 + subAgent 18 + workspaceGuard 34)+ app.test 6 + config.test 7,与执行报告「158 passed」**完全吻合**
- 删除量核对:designTools.test.ts 29 例 + subAgent design it.each 4 例 = 33,基线 191 − 33 = 158 ✓(与报告「基线 191 → 158」一致)
- typecheck/build:审查环境无 shell 无法重跑;但 src 全仓 0 处 designTools 引用(无悬空 import/未定义符号),dist 已重建且 agents md 同步——编译/构建通过为高置信推断

---

## 问题清单(均为执行报告数字口径,非代码缺陷,不阻塞)

1. **03-execution-1.md 验收项 4**:「subAgent.test.ts 用例数 24 → 20(减 4)」与实际不符。逐文件核对当前 subAgent.test.ts = **18 例**(it.each × 4 角色 + 14 个 it),改动前应为 22(减 4 正确,绝对值差 2)。建议改为「22 → 18(减 4)」。
2. **03-execution-1.md 验收项 4**:「基线 191(153 + designTools.test.ts 29 + subAgent design it.each 4)」括号内算术错误:153+29+4=186 ≠ 191;基础数应为 158(158+29+4=191)。建议括号改为「(158 + 29 + 4)」。

---

## 最终建议

**通过。** 改动与计划逐条吻合,删除彻底无残留,保护项未误伤,测试总数 158 例经独立统计验证一致;仅建议修正执行报告中 2 处数字口径(不影响本次改动正确性,可随下次提交顺手修订)。
