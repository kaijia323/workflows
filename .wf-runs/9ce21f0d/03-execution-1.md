# 执行报告:彻底移除 design 工具

> 计划:`.wf-runs/9ce21f0d/02-plan-1.md`;按 Step 1-8 顺序实施,单次改动集(未提交)。

## 一、改动文件清单

### 删除(2 个源文件 + 2 个 dist 残留)
| 文件 | 说明 |
| --- | --- |
| `apps/api/src/pi/designTools.ts` | 整文件删除(321 行,createDesignTool / createDesignTools / DesignToolOptions / designSchema) |
| `apps/api/src/pi/designTools.test.ts` | 整文件删除(436 行,29 用例) |
| `apps/api/dist/pi/designTools.js` / `.js.map` | rm 清理(tsc 不清理死产物;dist 为 gitignore,无 git diff) |

### 修改(8 个文件)
| 文件 | 改动内容 |
| --- | --- |
| `apps/api/src/pi/piService.ts` | 删 import `createDesignTools`(L20);删注释 + `designTools`/`designToolNames` 创建(L258-260);guardedTools 只读/读写两分支删 `...designTools`(L262/L267);activeTools 两分支删 `...designToolNames`(L271-272)——注册+白名单同步删,webTools/webToolNames 保留原样 |
| `apps/api/src/pi/subAgent.ts` | 删 import(L31);删注释 + `tools.push(...createDesignTools({ workspace }))`(L116-117);activeNames 删 `'design'`(L123) |
| `apps/api/src/pi/subAgent.test.ts` | ① describe 标题改 `'buildSubAgentTools 子代理工具集(anysearch-search)'`;② 删除 design it.each 用例整块(4 角色);③ 探索报告补遗:「executor 与 explorer 工具集差异」用例标题「联网/设计工具一致」→「联网工具一致」;④ 工具列表 `['anysearch-search', 'design', 'read', 'ls']` → 移除 'design' |
| `apps/api/src/pi/agents/explorer.md` | 删整节 `## 外部设计库调研(awesome-design-md)`(L24-31);「执行要求」末尾追加通用指引:`4. 需要工作区之外的外部补充信息(第三方文档/最新动态/公开 API 变更)时,用 anysearch-search 联网调研` |
| `apps/api/src/pi/agents/executor.md` | 删整节 `## 下载外部文件(如设计下载)`(L24-28) |
| `apps/api/src/pi/agents/planner.md` | 删整节 `## 下载类计划(如设计下载)`(L25-28) |
| `apps/api/src/pi/agents/orchestrator.md` | 删可用子代理列表 design 行(L19);删调度策略第 8 条整条(L31-36,5 行),1-7 编号连续 |
| `docs/dag-workflow.md` | 删「子代理工具集补充」design bullet + 注册点说明(L90-92);删 §4.1 外部抓取约定整节(L94-99),其后直接 `## 5. 数据模型` 无断号 |

### 未改动(计划外不碰)
`designs/` 目录、`AGENTS.md`、`README.md`、根 package.json / tsconfig / eslint、`workspaceGuard.ts`(isPathWithinWorkspace 保留)、`anySearchTools.ts`(truncateOutput 副本保留)、`.wf-runs/` 历史记录。

## 二、验收结果(逐项)

1. **文件删除** ✅ `apps/api/src/pi/designTools.ts`、`designTools.test.ts`、`apps/api/dist/pi/designTools.js`、`designTools.js.map` 均不存在(`ls` 确认 No such file or directory)。
2. **grep 清零** ✅
   - `designTools|createDesignTool|design 工具` 全仓检索:命中仅限 `.wf-runs/`(历史 run 记录)、`02-plan-1.md`/`01-exploration-1.md`(本 run 产物),排除后 **0 命中**。
   - `\bdesign\b`(忽略大小写)复核:`apps/api/src` 与 `docs/` **0 命中**;全仓其余命中仅 `AGENTS.md` L11-12(`designs/voltagent/DESIGN.md`、`designs/warp/DESIGN.md` 目录路径引用,允许保留)、`designs/` 资产文件、`.wf-runs/` 历史——均属豁免范围。
3. **typecheck** ✅ `pnpm --filter @workflows/api typecheck` 通过(tsc --noEmit 无错误,证明无残留 import / 未定义符号)。
4. **测试** ✅ `pnpm --filter @workflows/api test`:Test Files 10 passed / Tests **158 passed**。数字核对:基线 191(153 + designTools.test.ts 29 + subAgent design it.each 4)− 29 − 4 = **158** ✓;designTools.test.ts 不再出现在测试发现列表(10 个文件);subAgent.test.ts 用例数 24 → 20(减 4)。
5. **构建** ✅ `pnpm --filter @workflows/api build` 通过(tsc -p tsconfig.build.json + copy-agents.mjs);dist 复核:`dist/pi/designTools*` 不存在;`grep -il design dist/pi/agents/*.md` 0 命中(4 份 agents md 已同步为无 design 内容)。
6. **文档一致性** ✅ explorer.md 执行要求含第 4 条通用 anysearch 调研指引;orchestrator.md 调度策略 1-7 连续、子代理列表无 design;executor.md / planner.md 末尾约束节衔接自然;dag-workflow.md §4.1 删除后直接 `## 5. 数据模型`,无断号、无 4.2。
7. **范围确认** ✅ `git diff --stat` = 10 个文件(8 修改 + 2 删除,7 insertions / 825 deletions),与计划清单一一对应;`git status` 未跟踪仅 `.wf-runs/9ce21f0d/`(本 run 产物);`AGENTS.md`、`designs/`、`workspaceGuard.ts`、`anySearchTools.ts`、README/package.json/tsconfig 均未出现在 diff 中。

## 三、未完成项

无。全部计划项完成,无越界改动。
