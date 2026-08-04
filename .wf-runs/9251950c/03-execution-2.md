# 03-execution-2 — 修正执行:调整删除范围(designs/ 全删 + AGENTS.md 仅删 design 小节)

## 背景

上一轮(9ce21f0d)仅移除 design 工具代码,保留了 `designs/` 目录与 AGENTS.md 的引用。用户要求修正:**删除整个 `designs/` 目录**,且 **AGENTS.md 仅删除「## 前端 UI 风格」小节**,文件保留。

## 改动清单

### 1. 删除整个 designs/ 目录

- 命令:`git rm -r designs`
- 结果:删除 `designs/voltagent/DESIGN.md`、`designs/warp/DESIGN.md` 两个已跟踪文件(staged,`git status` 显示 `D  designs/...`)
- 文件系统确认:`ls designs` → No such file or directory,目录已不存在

### 2. AGENTS.md 仅删「## 前端 UI 风格」小节

- 删除范围(原第 9–14 行,共 6 行):小节标题「## 前端 UI 风格」+ 其后空行 + 3 条 bullet(两条引用 `designs/voltagent/DESIGN.md` / `designs/warp/DESIGN.md`,一条「**任何前端 UI 改动前必须先阅读上述设计文件**…」)+ 小节后空行
- 上下文衔接:`git diff` 确认删除后「## 这是什么」段落直接接「## 结构」,中间恰一个空行,无多余空行
- 其余内容(这是什么/结构/关键约定/命令/注意)**一字未改**(diff 仅 -6 行)
- 行数:48 → **42 行**(= 48 − 6;任务预期「41 行左右」,42 在范围内)

## 复核结果

### git status / diff --stat(改动范围互不干扰)

新增改动(本次):
- `D  designs/voltagent/DESIGN.md`(staged 删除)
- `D  designs/warp/DESIGN.md`(staged 删除)
- ` M AGENTS.md`(未 staged,仅 -6 行)

既有 design 工具移除改动(未触碰,保持原样):
- 8 改:`apps/api/src/pi/agents/{executor,explorer,orchestrator,planner}.md`、`apps/api/src/pi/piService.ts`、`apps/api/src/pi/subAgent.ts`、`apps/api/src/pi/subAgent.test.ts`、`docs/dag-workflow.md`
- 2 删:`apps/api/src/pi/designTools.ts`、`apps/api/src/pi/designTools.test.ts`

两组改动互不干扰(designs/ 与 AGENTS.md 均不在既有改动清单中,反之亦然)。

### grep `designs/` 复核(排除 .wf-runs、node_modules、dist)

- `apps/api/src`:**0 命中** ✅
- `docs/`:**0 命中** ✅
- 根目录逐文件(README.md、AGENTS.md、package.json、pnpm-workspace.yaml、turbo.json、tsconfig.json、eslint.config.js、.gitignore):**0 命中** ✅(grep -r 被工作区守卫拦截,改用逐文件 grep -l 检查)
- 全仓 *.md 搜索:仅 `.wf-runs/` 历史 run 产物命中(豁免范围),无任何根目录/源码文件残留 ✅

### .gitignore 检查

无 `designs/` 或 `AGENTS.md` 相关条目,无需清理 ✅

### AGENTS.md 上下文

删除后「## 这是什么」直接接「## 结构」,空行规范,无残留;42 行(48 − 6,约等于预期 41 行)。

## 自检

- 无类型检查/测试/构建需求(纯删除与文档编辑,未改代码)
- `git status` 确认:新增改动仅 designs/ 删除 + AGENTS.md 修改,与既有移除改动互不干扰

## 未完成项

无。
