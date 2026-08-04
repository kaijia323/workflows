# 实施计划:彻底移除 design 工具

## 一、目标与范围

### 做什么
彻底移除 design 工具的全部痕迹,包括:
1. 实现文件与单测:`designTools.ts`、`designTools.test.ts`(整文件删除)
2. 代码注册点:`piService.ts`(主代理)、`subAgent.ts`(子代理)的 import / 注册 / 白名单
3. 测试断言:`subAgent.test.ts` 中的 design 用例与工具列表断言
4. 子代理提示词:explorer.md / executor.md / planner.md / orchestrator.md 中的 design 相关段落
5. 文档:`docs/dag-workflow.md` 中 design 工具条目与 §4.1 整节
6. 构建产物残留:`apps/api/dist/pi/designTools.js`、`designTools.js.map`(已确认存在)

### 不做什么
- **不删除 `designs/` 目录**(voltagent / warp 两个设计文件):是已跟踪的项目资产,被 AGENTS.md L11-12 引用为前端 UI 规范,与工具本身无耦合
- **不修改 AGENTS.md**(经复核:仅引用 `designs/<站点>/DESIGN.md` 目录路径,不提及 design 工具)
- **不修改 README.md / 根 package.json / tsconfig / eslint 配置**(经复核无 design 引用)
- **不删除 `workspaceGuard.ts` 的 `isPathWithinWorkspace`**(被其他工具共用)
- **不动 `anySearchTools.ts` 及其 truncateOutput 副本**(独立实现,无共享依赖)
- **不清理 `.wf-runs/` 历史记录**(任务范围外)
- **不新增/重构任何功能**,纯删除型改动,单次提交

---

## 二、关键决策(探索报告遗留问题)

### 决策 1:explorer.md 整节删除的取舍 → **整节删除 + 补一句通用调研指引**
- 现状:`## 外部设计库调研(awesome-design-md)` 一节(至文件末尾)是 explorer.md 中**唯一**提及 anysearch-search 的地方;该节主题即设计库调研,与 design 工具强绑定,必须整节删除
- 但 explorer 代理注册表中仍保留 anysearch-search 工具(subAgent.ts 不删),若指引全删,模型将失去联网调研的认知
- **方案**:整节删除后,在「执行要求」末尾追加一条通用指引:
  `4. 需要工作区之外的外部补充信息(第三方文档/最新动态/公开 API 变更)时,用 anysearch-search 联网调研`
- 此方案与任何具体站点解耦,保留外部调研能力描述,且不留任何 design 字样

### 决策 2:dist 产物 → **顺手清理**
- `apps/api/dist/` 是 gitignore 构建产物,`designTools.js*` 残留无害但属死文件,tsc 不会自动清理
- 方案:`rm apps/api/dist/pi/designTools.js apps/api/dist/pi/designTools.js.map`(已确认两个文件存在)
- `dist/pi/agents/*.md` 由 build 时 `copy-agents.mjs` 先 rmSync 再整目录复制,自动同步,无需手动处理

### 决策 3:改动顺序 → **先删实现,后清引用,一次提交**
- 中间态编译失败无碍(单次提交,不产生中间提交);采用「删文件 → 清引用 → 改测试 → 改 md → 改 docs → 清 dist → 验收」顺序,每步后用 grep 自检,便于定位遗漏

---

## 三、实施步骤

> 行号以当前文件为准;所有操作完成后统一在 Step 8 验收。每步给出内容锚点(唯一字符串),执行时按锚点定位,行号作参考。

### Step 1:删除实现文件与单测
| 操作 | 文件 | 说明 |
| --- | --- | --- |
| 删除 | `apps/api/src/pi/designTools.ts`(约 320 行) | 实现文件,含 createDesignTool / createDesignTools / DesignToolOptions / designSchema |
| 删除 | `apps/api/src/pi/designTools.test.ts`(约 440 行,29 用例) | 单测,依赖 designTools.ts 的 import |

预期结果:两个文件从工作区消失;此时代码仍 import 它们,typecheck 会报错(中间态,可接受)。

### Step 2:修改 `apps/api/src/pi/piService.ts`(5 处)
| 锚点 | 操作 |
| --- | --- |
| L20 `import { createDesignTools } from './designTools.js'` | 删除该 import 行 |
| L258 注释 `// 内置 design 工具:读/下载设计库文件(与 wait_for_approval 同类基础设施工具;download 有独立安全护栏)` | 删除 |
| L259-260 `const designTools = createDesignTools({ workspace })` + `const designToolNames = designTools.map((tool) => tool.name)` | 删除这两行 |
| L262 只读分支 guardedTools 中的 `...designTools,` | 删除该展开项(保留 `...webTools,` 结尾) |
| L267 读写分支 guardedTools 中的 `...designTools,` | 删除该展开项 |
| L271-272 activeTools 只读/读写分支中的 `...designToolNames,` | 两处各删除该展开项 |

> ⚠️ 注册与白名单必须同步删(共 5 处展开项):SDK 的 allowedToolNames 会过滤 customTools,漏删任一处都会留下「工具注册但白名单无 / 白名单残留」的脏状态,且不报错。

预期结果:piService.ts 无任何 design 字样;`webTools`/`webToolNames` 及前后注释保留原样。

### Step 3:修改 `apps/api/src/pi/subAgent.ts`(3 处)
| 锚点 | 操作 |
| --- | --- |
| L31 `import { createDesignTools } from './designTools.js'` | 删除该 import 行 |
| L116-117 注释 `// 内置 design 工具:读/下载设计(与 wait_for_approval 同类,注册到所有代理;download 有独立安全护栏)` + `tools.push(...createDesignTools({ workspace }))` | 删除这两行 |
| L123 activeNames 数组中的 `'design',` | 删除该元素(数组变为 `'anysearch-search',` 结尾) |

预期结果:buildSubAgentTools 只注册只读基础 + fff + anysearch-search(+ 按白名单的写工具)。

### Step 4:修改 `apps/api/src/pi/subAgent.test.ts`(4 处)
| 锚点 | 操作 |
| --- | --- |
| L59 describe 标题 `'buildSubAgentTools 子代理工具集(anysearch-search / design)'` | 改为 `'buildSubAgentTools 子代理工具集(anysearch-search)'` |
| L79-87(探索报告标 L80-93)用例 `it.each(ROLES)('%s:tools 与 activeNames 均含 design(恰一次;download 不受 write 白名单影响)', ...)` 整块(含 try/finally 结构) | 整用例删除 |
| L89 用例标题 `'executor(全量写)与 explorer(纯只读)的工具集差异仅限写工具,联网/设计工具一致'` | 改为 `'executor(全量写)与 explorer(纯只读)的工具集差异仅限写工具,联网工具一致'`(探索报告遗漏处,含「设计」字样必须改) |
| L111 `for (const name of ['anysearch-search', 'design', 'read', 'ls'])` | 移除 `'design',`,变为 `['anysearch-search', 'read', 'ls']` |

> 探索报告补遗:原报告只列了 3 处,实际第 4 处(L89 用例标题中的「/设计」)也会命中 grep `design`,必须一并修改。

预期结果:design 用例删除后剩余用例数减少 4(it.each × 4 角色);anysearch-search 断言保留。

### Step 5:修改子代理提示词 md(4 个文件)
| 文件 | 操作 |
| --- | --- |
| `apps/api/src/pi/agents/explorer.md` | 删除文件末尾整节 `## 外部设计库调研(awesome-design-md)`(L24-31,含 4 条 bullet);随后在「执行要求」末尾追加:`4. 需要工作区之外的外部补充信息(第三方文档/最新动态/公开 API 变更)时,用 anysearch-search 联网调研` |
| `apps/api/src/pi/agents/executor.md` | 删除文件末尾整节 `## 下载外部文件(如设计下载)`(L24-28,3 条 bullet) |
| `apps/api/src/pi/agents/planner.md` | 删除文件末尾整节 `## 下载类计划(如设计下载)`(L25-28,2 条 bullet) |
| `apps/api/src/pi/agents/orchestrator.md` | ① L19 删除可用子代理列表中的 design 行(整行);② L31-36 删除调度策略第 8 条整条(5 行);编号 1-7 保持连续,无需重排 |

预期结果:四个 md 均无 design 字样;explorer 保留通用 anysearch 调研指引;orchestrator 调度策略 1-7 连续。

### Step 6:修改 `docs/dag-workflow.md`(2 处)
| 锚点 | 操作 |
| --- | --- |
| L90-92「子代理工具集补充」列表中的 design bullet(L90)+ 注册点说明(L92) | 删除;该列表只剩 anysearch-search 一条,保留其 bullet 与「与实现对齐」引导句 |
| L94-99 `### 4.1 外部抓取约定(design 工具)` 整节(4 条 bullet) | 删除整节;其后直接是 `## 5. 数据模型`,无需重编号(无 4.2) |

预期结果:docs/dag-workflow.md 无 design 字样;章节编号无断裂。

### Step 7:清理 dist 构建产物
| 操作 | 文件 |
| --- | --- |
| 删除 | `apps/api/dist/pi/designTools.js` |
| 删除 | `apps/api/dist/pi/designTools.js.map` |

> `dist/pi/agents/*.md` 不需要手动处理:build 时 copy-agents.mjs 先 rmSync 整目录再复制,自动同步。
> dist 为 gitignore 产物,此步非功能必需,但避免死文件残留。

### Step 8:验收(见第五节清单)

---

## 四、风险与回滚方案

| 风险 | 概率/影响 | 缓解 |
| --- | --- | --- |
| 双注册点(piService + subAgent)漏删其一,留下工具注册/白名单脏状态且不报错 | 中/低 | Step 2/3 按锚点逐处核对 + 验收 grep `design` 清零兜底 |
| explorer.md 删整节后失去外部调研指引 | 确定发生/中 | 已决策:补通用 anysearch 调研指引一条;用户如有异议可在闸门阶段提出,executor 按意见调整 |
| tsc 不清理 dist 死文件 | 确定发生/无 | Step 7 手动 rm 两个文件 |
| 删除设计用例后 subAgent.test.ts 断言语义变化 | 低/低 | 只删 design 相关断言,anysearch-search 断言保留,测试全绿即证明工具集注册逻辑未破坏 |
| 漏改含「设计」字样的注释/标题(grep `design 工具` 不命中) | 中/低 | 验收用宽口径 grep `design` 全词复核(排除 AGENTS.md 的 designs/ 目录引用) |

**回滚方案**:全部改动集中在一次提交,`git revert` 该提交即可完整还原;designs/ 目录与 AGENTS.md 未被触碰,无需恢复。提交前若发现意外扩大改动面,用 `git diff` 复核后按需丢弃。

---

## 五、验收标准(逐条核对)

1. **文件删除**:`apps/api/src/pi/designTools.ts`、`designTools.test.ts`、`apps/api/dist/pi/designTools.js`、`designTools.js.map` 均不存在
2. **grep 清零**:对 `apps/api/src` 与 `docs/` 执行 `designTools|createDesignTool|design 工具` 检索,0 命中;再对 `design` 全词复核,仅允许命中 `AGENTS.md`(designs/ 目录引用,不改),其余 0 命中
   - 排除目录:`.wf-runs/`、`node_modules/`、`designs/`、`dist/`(dist 已单独清理并复核)
3. **类型检查**:`pnpm --filter @workflows/api typecheck` 通过(证明无残留 import / 未定义符号)
4. **测试**:`pnpm --filter @workflows/api test` 全绿;subAgent.test.ts 用例数比改动前减少 4(design it.each 用例);designTools.test.ts 不再出现在测试发现列表
5. **构建**:`pnpm --filter @workflows/api build` 通过;`apps/api/dist/pi/agents/*.md` 已同步为无 design 内容的版本
6. **文档一致性**:explorer.md 含通用 anysearch 调研指引;orchestrator.md 调度策略编号 1-7 连续;dag-workflow.md §4.1 删除后无断号
7. **范围确认**:`git status` 改动文件 = 计划列出的 8 个修改文件 + 2 个删除文件(+ dist 清理不产生 git 差异);`designs/`、`AGENTS.md`、`workspaceGuard.ts`、`anySearchTools.ts` 均未出现在 diff 中

---

## 六、改动文件总清单

**删除(2)**:`apps/api/src/pi/designTools.ts`、`apps/api/src/pi/designTools.test.ts`

**修改(8)**:
1. `apps/api/src/pi/piService.ts` — 删 import + 删注释 + 删 2 处 designTools 展开 + 删 2 处 designToolNames 展开
2. `apps/api/src/pi/subAgent.ts` — 删 import + 删注册两行 + 删 activeNames 中 'design'
3. `apps/api/src/pi/subAgent.test.ts` — 改 describe 标题 + 删 design 用例 + 改用例标题 + 删工具列表 'design'
4. `apps/api/src/pi/agents/explorer.md` — 删整节 + 补通用 anysearch 指引
5. `apps/api/src/pi/agents/executor.md` — 删末尾整节
6. `apps/api/src/pi/agents/planner.md` — 删末尾整节
7. `apps/api/src/pi/agents/orchestrator.md` — 删子代理列表行 + 删调度策略第 8 条
8. `docs/dag-workflow.md` — 删 design bullet + 注册点说明 + 删 §4.1 整节

**dist 清理(2,gitignore 无 diff)**:`apps/api/dist/pi/designTools.js`、`designTools.js.map`

**不动**:`designs/`、`AGENTS.md`、`README.md`、`workspaceGuard.ts`、`anySearchTools.ts`、`.wf-runs/`
