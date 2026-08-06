# 探索报告:DAG 图现状核实 + LICENSE 情况

> 任务:`核实 DAG 图是否已删除(代码/文档残留)` 与 `LICENSE 现状(补 MIT 的位置)`
> 方式:只读调研(未修改任何代码文件);产物写入 `.wf-runs/f612b4e5/01-exploration-1.md`

---

## 问题 1:DAG 图现状 —— 结论:已删除 ✅(用户反馈属实),但存在多处残留

**右侧 DAG 图(前端 DagPanel 组件)确认已删除**;残留项仅剩:后端 `/api/dag` 示例端点、shared 中的 `DagGraph/DagNode/DagEdge` 类型、3 处过时注释、以及 README/package.json/设计文档中的过时描述。

### 1.1 删除证据(决定性)

| 证据 | 内容 |
| --- | --- |
| git reflog(`.git/logs/HEAD`) | 提交 **`53544ed7` "refactor(web): 移除右侧 DAG 流程面板(DagPanel)"**(记录行:`e43230bc… 53544ed7… commit: refactor(web): 移除右侧 DAG 流程面板(DagPanel)`,时间戳 1786030683,约 2026-08;其后仓库继续演进,属最近一次改动) |
| 工作流产物 `.wf-runs/530c2a8c/run.json`(executor 摘要) | 「完成 DagPanel 删除,共 3 个文件:`apps/web/src/components/DagPanel.vue` 整文件 `rm` 删除;`InfoPanel.vue` 删除 DagPanel 导入、`defineEmits` 声明、模板中 DAG 块(`<!-- 上方:工作流 DAG 图 -->` + `<DagPanel>`);`App.vue` 删除 `<InfoPanel>` 上的 `@open-sub`」 |
| `.wf-runs/530c2a8c/03-execution-1.md` / `04-review-1.md` | 删除细节 + 验收:「`DagPanel` 引用归零(全仓仅 `.wf-runs/` 历史报告提及);`apps/web/src` 中 `DagPanel` 0 命中」 |
| 删除前状态佐证 | `.wf-runs/6fc39738/`(UI 重构运行记录)中 DagPanel.vue 仍存在:`01-exploration-1.md:36`「DagPanel.vue — DAG 图:探索/计划/⏸闸门/执行/审查节点,运行/完成/错误/空闲状态色,点击节点打开子代理模态窗」 |

### 1.2 当前代码残留(未清理,与"已删除"并存)

**后端——`/api/dag` 示例端点仍在线**(前端已无调用方,属于死端点):

- `apps/api/src/app.ts:8` `import type { DagGraph, DagNode } from '@workflows/shared'`
- `apps/api/src/app.ts:66-81`:
  ```ts
  // 示例:返回一个 DAG 骨架数据
  app.get('/api/dag', (c) => {
    const nodes: DagNode[] = [ { id: 'node-1', label: '数据采集' }, … ]
    …
  })
  ```
- 对应测试:`apps/api/src/app.test.ts:22-24` `describe('GET /api/dag')`
- `packages/cli/src/api/app.ts` 同内容——CLI 包由 `scripts/prepare.mjs` 在构建时从 `apps/api/src` **整树复制**(排除 `*.test.ts`),故发布包内也带 `/api/dag`

**共享类型(仍在 shared 中,实际已无消费方):**

- `packages/shared/src/index.ts:1-27`:`DagNode`(注释「工作流运行状态(前端 DAG 图渲染用)」)、`DagEdge`、`DagGraph`
- 现状:前端 run 展示已改用 `RunSnapshot`(同文件 `RunSnapshot` 接口,「run 快照(恢复 / 断连重建 UI 用)」);`DagGraph/DagNode` 仅被 `/api/dag` 示例端点引用

**注释残留(过时注释,功能已换实现):**

- `apps/web/src/composables/useAgent.ts:160`:`/** run 快照(右侧 DAG 图 / 恢复用) */`(实际类型已是 `RunSnapshot | null`)
- `apps/api/src/agent/routes.ts:329`:`// 当前(或最近)run 快照:前端 / 断连恢复重建 DAG 图与闸门状态`(实际返回 `pi.getRunSnapshot(...)`)
- `AGENTS.md:7`:「Turborepo monorepo — 基于 **pi SDK** 的 Web Agent 工作台(聊天 + 工作区 + 工具调用),附带 DAG 骨架示例接口。」

**前端现状(已无任何 DAG 可视化):**

- `apps/web/src/components/` 共 18 个组件,无 `DagPanel.vue`;全前端 grep `dag|graph|mermaid|diagram|flow|可视化|流程图` 仅命中 `useAgent.ts:160` 注释
- 布局(`apps/web/src/App.vue`):左 `WorkspaceRail` + 中 `ChatPane` + 右 `InfoPanel`(观测面板:工作区/会话/用量/工具流/系统 5 个 section,见 `InfoPanel.vue`);顶部 `PipelineHeader.vue` 为「源 → 处理 → 观测」流水线(非 DAG 图)
- run 快照仍被使用,只是不再画图:`useAgent.ts:656` 拉取 `/run` 快照;`ChatPane.vue:346` 用 `run.agents` 判断子代理块;`SubAgentModal.vue` 为子代理对话模态窗

### 1.3 README 与文档中的 DAG 描述(全部过期,需更新)

**`packages/cli/README.md`(共 1 处):**

- 第 11 行(核心特性·工作流编排):「…planner 产出计划后需**人工批准**才进入执行,**右侧 DAG 图实时展示各节点状态,点击可回看子代理完整对话**」

**`packages/cli/package.json`(2 处):**

- 第 4 行 description:「workflows — 一键在浏览器中启动的 Web Agent 工作台:工作区管理、持久化会话、SSE 流式对话与 **DAG 工作流编排**(wfs 命令)」
- 第 5 行 keywords:含 `"dag"`

**根 `README.md`(4 处):**

- 第 3 行:「Turborepo monorepo — 基于 pi SDK 的 Web Agent 工作台(**DAG 可视化骨架**)。」
- 第 11 行(工作流编排):「…计划需人工闸门批准;**右侧 DAG 图实时展示节点状态,点击查看子代理完整对话**(模态窗)」
- 第 178 行(API 一览):「| GET | `/dag` | **DAG 骨架示例数据** |」
- 第 189 行(API 一览):「| GET | `/agent/workspaces/:id/run` | 当前 run 快照(**DAG 图** / 闸门状态 / 恢复) |」

**`docs/dag-workflow.md`(整篇为 DAG 设计文档):**

- 标题「DAG 工作流设计文档(主代理编排模式)」,头部状态「设计定稿,待实现」
- §8 恢复:「重建聊天流 / **DAG 图** / 模态窗 / 闸门按钮」;§9 前端交互:「布局:右侧上下结构——上方 **DAG 流程图**(节点状态实时流转)…」;§11 实现顺序第 6 步「前端:**DAG 图**(右侧上下结构)…」;§12 决策记录含「**DAG 图放右侧上下结构**;粗粒度节点 + 模态窗」
- 注意:根 README 全文**未引用** `docs/dag-workflow.md`(无 "dag-workflow" 字样),该文档与现状已部分脱节(§9 布局描述与 App.vue 实际布局不符)

### 1.4 小结(问题 1)

- 前端 DAG 图:**已删除**(提交 `53544ed7`,运行记录 `.wf-runs/530c2a8c/` 可查)
- 未清理残留:**`/api/dag` 示例端点**(apps/api 与 packages/cli 双份)、shared 的 `DagGraph/DagNode/DagEdge` 类型、2 处源码注释 + AGENTS.md 1 处、README(cli 1 处 + 根 4 处 + cli package.json 2 处)、docs/dag-workflow.md 设计文档
- 若目标是"彻底清除 DAG 痕迹":删 `/api/dag` 端点 + `app.test.ts` 用例 + shared 类型(确认无其他消费方)+ 更新 3 处注释 + 更新两处 README 与 package.json 描述(关键词 `dag` 可选保留)+ 决定 `docs/dag-workflow.md` 去留

---

## 问题 2:LICENSE 情况 —— 结论:全仓库无 LICENSE、无 license 字段;补 MIT 应放 `packages/cli/LICENSE` + package.json 加 `"license": "MIT"`

### 2.1 现状盘点(全部无 LICENSE)

| 位置 | LICENSE 文件 | package.json `license` 字段 | 是否发布包 |
| --- | --- | --- | --- |
| 仓库根 | ❌(ls 无 LICENSE;有 README.md/AGENTS.md/.npmrc 等) | ❌(根 package.json 无 license;`private: true`) | 否 |
| `packages/cli`(发布包) | ❌(仅 README.md/package.json/src/scripts;`dist/` 内亦无) | ❌(无 license 字段;无 private,`publishConfig.access: public`,`bin: wfs`) | **是(唯一)** |
| `packages/shared` | ❌ | ❌(`private: true`) | 否 |
| `apps/api` | ❌ | ❌(`private: true`) | 否 |
| `apps/web` | ❌ | ❌(`private: true`) | 否 |

- `.npmrc` 仅 `registry=https://registry.npmjs.org/`,无 license 相关配置
- 仓库 5 个 package.json(根 / cli / shared / api / web)**全部没有 `license` 字段**,也没有任何子包自带 LICENSE 的先例可循

### 2.2 补 MIT 的位置建议(npm 官方行为依据)

- **必须放 `packages/cli/LICENSE`**:该包是唯一发布到 npm 的包(`@kaijia/workflows`);npm 官方文档明确「Certain files that are relevant to package installation and distribution are always included. For example, `package.json`, `README.md`, `LICENSE`」——即 `files: ["dist"]` 不影响,包目录下的 LICENSE 会**自动进入 tarball**(`npm pack --dry-run` 可验证)
- **仓库根 LICENSE 不会自动进 CLI 包的 tarball**(发布目录是 `packages/cli`),仅对 monorepo 私有部分有意义,可选放
- **`packages/cli/package.json` 加 `"license": "MIT"`**:当前缺失,`npm publish` 会警告「No license field」并默认按 UNLICENSED 处理;SPDX 表达式 `"license": "MIT"` 即可
- 惯例参考:pnpm workspace 中发布子包通常"包目录 LICENSE + 包内 package.json license 字段"双份;若想让整个仓库(含私有包/文档)也有授权声明,可根目录再放一份

---

## 结论与建议

1. **DAG 图**:确认已删除(提交 `53544ed7` "refactor(web): 移除右侧 DAG 流程面板(DagPanel)",运行记录 `.wf-runs/530c2a8c/`);残余:`/api/dag` 死端点(双份)、shared 死类型、3 处过时注释、6 处文档描述(cli README L11、根 README L3/L11/L178/L189、cli package.json L4/L5、docs/dag-workflow.md 整篇)——如需"文档与实际一致",这些都应清理或改写。
2. **LICENSE**:全仓库零 LICENSE;补 MIT 的正确位置 = **`packages/cli/LICENSE`(MIT 文本)+ `packages/cli/package.json` 增加 `"license": "MIT"`**;根目录 LICENSE 可选(不进发布包)。
3. 两项改动相互独立,可分别进行。
