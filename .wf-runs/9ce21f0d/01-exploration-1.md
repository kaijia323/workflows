# 探索报告:design 工具全部引用点清单(为彻底移除做准备)

## 仓库概览

- **形态**:Turborepo + pnpm monorepo(`apps/api` Hono + pi SDK / `apps/web` Vue3+Vite+Tailwind / `packages/shared` 纯类型包)
- **构建**:根 `pnpm build` → turbo → api 包 `tsc -p tsconfig.build.json && node scripts/copy-agents.mjs`(tsc 只编译 .ts;copy-agents.mjs 把 `src/pi/agents/*.md` 整目录 rmSync 后复制到 `dist/pi/agents`)
- **测试**:`vitest run`(api 包无独立 vitest.config,默认发现 `*.test.ts`;仅 apps/web 有 vitest.config.ts)
- **类型检查**:`tsc --noEmit`(tsconfig 整目录 include src,无显式文件清单);eslint.config.mjs 亦无文件级配置
- **gitignore**:`dist/`、`.turbo/`、`node_modules/`、`.workflows/` 被忽略;**designs/ 未被忽略**(已跟踪)

---

## 一、实现文件与测试(整文件删除)

### 1. `apps/api/src/pi/designTools.ts`(约 320 行)— 删除
- 导出:`createDesignTool(opts)`(单工具,`name/label = 'design'`、description、`promptSnippet: 'Read or download design files from awesome-design-md'`、parameters=designSchema)、`createDesignTools(options)`(工厂,返回 `[createDesignTool(options)]`)、接口 `DesignToolOptions`
- schema:`action: 'read' | 'download'` 枚举 + 可选 `path`/`dir`/`overwrite`
- 依赖:仅标准库(node:fs/node:path)+ typebox + pi SDK 类型 + `./workspaceGuard.js` 的 `isPathWithinWorkspace`(该函数被其他工具共用,**不能删**)
- 唯一 env 读取:`DESIGN_CDN_BASE`(L51 注释、L136 `process.env.DESIGN_CDN_BASE`)

### 2. `apps/api/src/pi/designTools.test.ts`(约 440 行,29 个用例)— 删除
- 从 `./designTools.js` import `createDesignTool, createDesignTools`(L11);含 `DESIGN_CDN_BASE` env stub(L135-136、L152)

---

## 二、代码注册点(修改)

### 3. `apps/api/src/pi/piService.ts`(主代理注册)— 5 处
| 位置 | 内容 | 处理 |
|---|---|---|
| L20 | `import { createDesignTools } from './designTools.js'` | 删 |
| L258 | 注释 `// 内置 design 工具:读/下载设计库文件(与 wait_for_approval 同类基础设施工具;download 有独立安全护栏)` | 删 |
| L259-260 | `const designTools = createDesignTools({ workspace })` + `const designToolNames = designTools.map((tool) => tool.name)` | 删 |
| L262 / L267 | guardedTools 只读分支 `...designTools` / 读写分支 `...designTools` | 删 |
| L271-272 | activeTools 只读分支 `...designToolNames` / 读写分支 `...designToolNames` | 删 |

> ⚠️ 注册与白名单必须同步删:SDK 的 allowedToolNames 会过滤 customTools,只删一处会导致工具暴露但白名单无、或白名单残留(均不报错,但语义脏)。

### 4. `apps/api/src/pi/subAgent.ts`(子代理注册)— 3 处
| 位置 | 内容 | 处理 |
|---|---|---|
| L31 | `import { createDesignTools } from './designTools.js'` | 删 |
| L116-117 | 注释 `// 内置 design 工具:读/下载设计(与 wait_for_approval 同类,注册到所有代理;download 有独立安全护栏)` + `tools.push(...createDesignTools({ workspace }))` | 删 |
| L123 | activeNames 数组中的 `'design',` 元素 | 删 |

### 5. `apps/api/src/pi/subAgent.test.ts`(测试断言)— 3 处
| 位置 | 内容 | 处理 |
|---|---|---|
| L59 | describe 标题 `'buildSubAgentTools 子代理工具集(anysearch-search / design)'` | 改为只提 anysearch-search |
| L80-93 | 用例 `it.each(ROLES)('%s:tools 与 activeNames 均含 design(恰一次;download 不受 write 白名单影响)', ...)`(断言 activeNames/tools 各恰一次含 'design') | 整用例删除 |
| L111 | `for (const name of ['anysearch-search', 'design', 'read', 'ls'])` | 移除 `'design'` 元素 |

> `piService.test.ts` 经全文检索**无** design 断言,无需改动。

---

## 三、子代理提示词 md(删除段落;reviewer.md 无 design 提及)

### 6. `apps/api/src/pi/agents/explorer.md` — L24-31(至文件末尾)
- 整节 `## 外部设计库调研(awesome-design-md)` 删除:
  - L24 节标题
  - L25-26「用 design 工具 action=read 读取仓库 README.md…」
  - L27-28「用 action=read path=design-md/<站点>/DESIGN.md 精读候选正文」
  - L29「用 anysearch-search 补充外部信息」、L30-31「报告要求(站点名/风格要点/匹配度/Top N)」
- ⚠️ 该节是 explorer 中**唯一**提及 anysearch-search 与外部信息调研指引的地方;删除后 explorer 将失去联网调研指引。建议:整节删除(该节主题即设计库调研,与工具强绑定),或在报告格式里保留一句通用「需要外部信息时用 anysearch-search」。需决策。

### 7. `apps/api/src/pi/agents/executor.md` — L24-28(至文件末尾)
- 整节 `## 下载外部文件(如设计下载)` 删除(3 条 bullet,全部围绕 design download 落盘/校验/只读拒绝)

### 8. `apps/api/src/pi/agents/planner.md` — L25-28(至文件末尾)
- 整节 `## 下载类计划(如设计下载)` 删除(2 条 bullet:落盘路径/文件清单/校验方式 +「下载动作由 executor 执行 design 工具」)

### 9. `apps/api/src/pi/agents/orchestrator.md` — 2 处
- **L19**:「可用子代理」列表中的 `- design(设计库工具,主代理与子代理均可用):…` 整行删除
- **L31-36**:调度策略第 8 条「设计挑选类需求(调研 awesome-design-md…下载)」整条删除(含 32-36 共 5 行流程:`explorer design read → planner → wait_for_approval → executor design download → reviewer → complete_task` 与「用户驳回时按意见调整」)
  - ⚠️ 第 8 条删除后,调度策略编号 1-7 无跳号问题;该条是 orchestrator 里唯一设计流程指引

---

## 四、文档(修改)

### 10. `docs/dag-workflow.md` — 2 处
| 位置 | 内容 | 处理 |
|---|---|---|
| L90-92 | 「子代理工具集补充」列表中的 design bullet(L90)+ 注册点说明(L92,含 piService/subAgent 双注册点描述) | 删(该列表只剩 anysearch-search 一条) |
| L94-99 | `### 4.1 外部抓取约定(design 工具)` 整节(4 条 bullet:jsDelivr 三源回退 / GITHUB_TOKEN 不读取 / read 50KB+download 5MB / jsDelivr 缓存延迟) | 删;4.1 之后无 4.2(下一节是 ## 5 数据模型),无需重编号 |

---

## 五、已确认无引用(无需改动)

- **README.md(根)**:无任何 design 提及
- **AGENTS.md**:仅 L11-12 引用 `designs/voltagent/DESIGN.md`、`designs/warp/DESIGN.md`(下载产物,非工具)——**保留**
- **package.json(根 + apps/api)**:scripts 无 design 相关条目;无显式文件清单(build/test 均按目录/默认发现)
- **tsconfig.json / tsconfig.build.json / eslint.config.mjs**:无显式列举 designTools
- **apps/api/scripts/copy-agents.mjs**:整目录复制 agents/*.md,无文件级清单;md 改动后 build 自动同步
- **apps/api/scripts/verify-anysearch.mjs**:无 design
- **packages/、apps/web/src**:无任何 design 工具引用
- **`.env.example`**:不存在;`DESIGN_CDN_BASE` 仅存在于 designTools.ts/test 内部,无外部文档引用
- **agentDefs.ts / promptLoader.ts / runManager.ts / history.ts / workspaceGuard.ts / anySearchTools.ts / fffTools.ts**:无 design 引用
- **`.wf-runs/`**:历史 run 记录含 design 工具描述(80fa4852/521aca6a 等),属任务范围外忽略目录,不清理

---

## 六、dist 产物目录(说明,不需列清单)

- `apps/api/dist/` 是 **gitignore 构建产物**(tsc + copy-agents.mjs 生成),含 `dist/pi/designTools.js`、`designTools.js.map`、`dist/pi/agents/*.md`
- 删除源码后:**agents md 会自动同步**(copy-agents.mjs 先 rmSync 再复制);**designTools.js 不会被 tsc 清理**(tsc 不删已删除源文件的旧产物),下次 build 后残留为死文件——建议 `rm apps/api/dist/pi/designTools.js*` 或干净构建(删除后无人 import,残留也无害)
- dev 模式跑 src 不受影响;生产 `pnpm start` 跑 dist,若未清理残留文件亦无功能影响

---

## 七、designs/ 目录(确认用途与关联)

- 内容:`designs/voltagent/DESIGN.md`、`designs/warp/DESIGN.md` 两个文件
- 用途:**design 工具历史 download 产物**(默认落盘目录即 `designs/<站点>/`),当前被 AGENTS.md L11-12 引用为前端 UI 设计规范(voltagent 主规范 + warp 辅助)
- 与工具移除的关联:移除工具**不需要、也不应**删除 designs/(是项目资产,非工具代码);工具移除后该目录失去自动下载入口,未来更新设计需手动获取/提交

---

## 八、关键发现与风险点

1. **引用闭环干净**:designTools 仅被 piService.ts / subAgent.ts / designTools.test.ts 三处 import;工具通过返回数组注入 SDK 注册表,无全局/隐式注册
2. **双注册点必须同步删**(主代理 + 子代理):漏删白名单或注册任一处都会留下脏状态;subAgent.test.ts 的断言若保留会直接测试失败(可作为移除的回归哨兵,建议同步删)
3. **truncateOutput 无共享依赖**:anySearchTools.ts 有独立副本(历史实现刻意复制不重构),删除 designTools.ts 不影响
4. **workspaceGuard.isPathWithinWorkspace 不能删**:被其他工具(fff/read/write 等)共用
5. **explorer.md 整节删除的副作用**:该节是 explorer 唯一的外部信息调研指引(含 anysearch-search),也是当前这类「外部设计库调研」任务的提示模板;需用户决策整节删除还是保留通用调研指引
6. **文档编号**:dag-workflow.md 的 4.1 删除后无 4.2 无需重编号;orchestrator.md 第 8 条删除后编号 1-7 连续
7. **dist 死文件**:tsc 不清理,建议手动删除或干净构建(低风险)
8. **AGENTS.md / designs/ 联动**:两者是产物依赖关系,移除工具时**不要**顺手删除 designs/ 或 AGENTS.md 引用

---

## 结论

**可行性:高,纯删除型改动,无功能交叉。**

改动汇总:
- **删除 2 个文件**:`designTools.ts`、`designTools.test.ts`
- **修改 6 个文件**:piService.ts(5 处)、subAgent.ts(3 处)、subAgent.test.ts(3 处)、explorer.md(整节)、executor.md(整节)、planner.md(整节)、orchestrator.md(2 处)、docs/dag-workflow.md(2 处)——共 8 个修改文件

验收建议:
1. `pnpm --filter @workflows/api test`(设计断言用例删净后全绿;subAgent.test.ts 剩余用例数减少 4)
2. `pnpm --filter @workflows/api typecheck`(确认无残留 import)
3. `pnpm --filter @workflows/api build` 后 grep `design` 复查 src/dist/docs 清零(排除 .wf-runs/designs)
4. 顺手清理 `apps/api/dist/pi/designTools.js*` 残留
