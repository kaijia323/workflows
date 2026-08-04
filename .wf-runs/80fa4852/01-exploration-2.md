# 探索报告:planner 重做上限(最多 2 次)定位与修改建议

任务:定位「重做计划已达 2 次上限」限制的代码/配置位置,给出最小改动方案。
仓库:workflows(主代理编排式工作流 explorer→planner→闸门→executor⇄reviewer)
日期:2026-02-XX(只读调研,未改任何代码)

---

## 1. 仓库概览

- 技术栈:pnpm workspace monorepo;`apps/api`(Node/TS 服务,基于 @earendil-works/pi-coding-agent SDK)+ `apps/web`(Vue 3 前端);`packages/shared` 共享类型。
- 工作流编排:`apps/api/src/pi/piService.ts` 注册 orchestrator 主代理与 4 个子代理工具(explorer/planner/executor/reviewer);run 生命周期在 `apps/api/src/pi/runManager.ts`;子代理执行在 `apps/api/src/pi/subAgent.ts`;提示词在 `apps/api/src/pi/agents/*.md`(构建时由 copy-agents.mjs 复制到 dist)。
- 配置机制:`apps/api/src/config.ts` 的 `loadConfig`/`saveConfig` 读写 `.workflows/config.json`(开发环境;生产为 `~/.workflows/config.json`),现仅含 apiKey/thinkingLevel。
- 测试:vitest(`apps/api/src/**/*.test.ts`),`pnpm test` 运行。

## 2. 需求相关模块清单

| 文件 | 说明 |
|---|---|
| `apps/api/src/pi/piService.ts` | 主代理/子代理工具注册与编排,**上限硬编码在此** |
| `apps/api/src/pi/agents/orchestrator.md` | 主代理提示词,含「最多 3 轮 / 最多 2 次」软性引导 |
| `apps/api/src/pi/runManager.ts` | run 生命周期;`run.agents` 记录每次子代理调用(计数来源) |
| `apps/api/src/pi/subAgent.ts` | 子代理执行;`nextArtifactName` 按同角色调用次数生成产物序号 |
| `apps/api/src/config.ts` | `.workflows/config.json` 读写(可配置方案的落点) |
| `packages/shared/src/index.ts` | `RunAgentCall`/`RunSnapshot` 类型 |
| `apps/web/src/components/DagPanel.vue` | 前端按 `run.agents` 渲染子代理 DAG(纯展示) |

## 3. 定位结果:两处,一硬一软

### 3.1 硬限制(真正拦截并报错的):代码硬编码

**文件:`apps/api/src/pi/piService.ts`,第 389–400 行**(`createSubAgentTool` 的 `execute` 内,调用子代理前的兜底检查):

```
391:        // 循环上限兜底(代码级,不依赖模型自觉):
392:        // 审查⇄执行最多 3 轮;全流程回到 planner 最多 2 次,超限强制收尾
393:        const reviewerCalls = run.agents.filter((a) => a.agent === 'reviewer').length
394:        const plannerCalls = run.agents.filter((a) => a.agent === 'planner').length
395:        if (name === 'executor' && reviewerCalls >= 3) {
396:          throw new Error('执行⇄审查循环已达 3 轮上限。立即收尾:总结仍未解决的问题清单,向用户交付,不要再调用任何子代理。')
397:        }
398:        if (name === 'planner' && plannerCalls >= 2) {
399:          throw new Error('重做计划已达 2 次上限。立即收尾:总结仍未解决的问题清单,向用户交付,不要再调用任何子代理。')
400:        }
```

- 计数来源:`run.agents`(RunFile 数组,`appendRunAgentCall` 追加,**失败调用也计数**,见 piService.ts 第 405–419 行 catch 分支)。
- 判定:第 3 次调 executor 且已审 3 次、第 3 次调 planner(前 2 次已计入)时 throw。throw 后错误信息经 catch 分支写入 run.agents(summary=报错文案),前端模态窗收到 sub_end(isError)。

### 3.2 软限制(提示词引导):markdown

**文件:`apps/api/src/pi/agents/orchestrator.md`,第 26 行**:

```
4. 执行完成后调用 reviewer 审查:fail 则带问题清单再调 executor(最多 3 轮);仍 fail 可回 planner 重做(最多 2 次)
```

- 这是给模型的软引导(模型「自觉」),**不是**真正拦住调用的机制;真正拦截是 piService.ts 的 throw。两处数字(2 次/3 轮)必须同步改,否则模型以为还能重做、被代码抛错,体验割裂。

## 4. 联动点核查(改动前必须知道)

| 联动点 | 位置 | 影响 |
|---|---|---|
| 产物序号 `nextArtifactName` | `subAgent.ts:63` | 同角色第 N 次调用 → `02-plan-N.md`(从 1 起)。**不受影响**:去掉上限后序号自然继续(02-plan-3.md、02-plan-4.md…),计数逻辑与上限解耦 |
| 计划文件检测 `detectPlanFile` | `piService.ts:850–868` | 前缀扫描 `02-plan*.md` 取最新 mtime,**天然支持任意重做次数**,无需改 |
| 前端 DAG 展示 | `apps/web/src/components/DagPanel.vue:37` | `run.agents.filter(a => a.agent === role.id)` 纯渲染计数,节点数随调用数增长,无需改 |
| 类型定义 | `packages/shared` `RunAgentCall`/`RunSnapshot` | 无上限字段,无需改 |
| 测试 | `piService.test.ts` | 未检索到针对该上限的断言,无测试要改 |
| 事件/状态机 | `RunStatus`(planning/awaiting_approval/executing/reviewing/done) | 上限检查在工具 execute 入口,throw 后 run 状态流转与失败调用一致,无新增状态 |
| 会话/上下文膨胀风险 | 无硬性机制 | ⚠️ 唯一真正的风险:无上限后,同一 run 内 planner 反复重做会持续追加子代理会话与产物,模型上下文/token 成本线性增长,且可能陷入死循环(计划永远不被批准)。建议保留一个很大的兜底值或让用户可中断 |

## 5. 修改建议(最小改动方案)

### 方案 A:彻底无上限(改动最小,2 行)

删除/注释 `piService.ts` 第 398–400 行(planner 分支),同步删除或改写第 391–392 行注释;同时改 `orchestrator.md:26` 去掉「仍 fail 可回 planner 重做(最多 2 次)」或改为「可回 planner 重做(必要时,注意收敛)」。

- 优点:2 处改动,零配置。
- 缺点:硬编码值没了但不可配置;executor⇄reviewer 的 3 轮上限仍在(建议一并处理或单独留用);有死循环/成本风险。

### 方案 B:可配置(推荐,改动约 10 行)

1. `apps/api/src/config.ts` 的 `StoredConfig` 接口增加可选字段:
   ```ts
   plannerMaxRetries?: number   // planner 重做上限;缺省/0/负数 = 无上限
   reviewerMaxRounds?: number   // reviewer⇄executor 轮数上限;缺省 3
   ```
2. `piService.ts` `createSubAgentTool` 内,把硬编码改为动态读取(loadConfig 已在文件导入):
   ```ts
   const cfg = loadConfig(this.store)
   const plannerLimit = cfg.plannerMaxRetries ?? 2   // 旧行为缺省 2;想默认无上限则 ?? Infinity/0
   const reviewerLimit = cfg.reviewerMaxRounds ?? 3
   if (name === 'executor' && reviewerCalls >= reviewerLimit) { ... }
   if (name === 'planner' && (plannerLimit > 0) && plannerCalls >= plannerLimit) { ... }
   ```
   (plannerLimit 为 0/undefined 且采用「无上限缺省」语义时,跳过检查;报错文案里的数字可动态拼 `重做计划已达 ${plannerLimit} 次上限`,或统一改为不带数字的通用文案)
3. `.workflows/config.json` 按需加字段,如 `"plannerMaxRetries": 5`;loadConfig 每次工具调用都读文件,保存后**即时生效,无需重启会话**(与 anySearchApiKey 同机制,见 anySearchTools.ts:10 注释)。
4. `orchestrator.md:26` 改为与配置一致或去掉具体数字(提示词是静态文件,无法读 config.json,只能写「按系统限制收敛」之类的通用表述,或维持一个比代码上限更保守的数字)。

### 注意

- **两处必须同步**:只改代码不改 orchestrator.md(或反之),模型预期与系统行为不一致。
- 默认值语义要明确:方案 B 建议保留「缺省 2 次」以不改变现有行为;若要「默认无上限」,把缺省改为 0 并调整判断,但需自行承担死循环风险。
- 前端无需改动;产物序号与计划文件扫描已天然兼容任意次数。

## 6. 结论

- 「重做计划已达 2 次上限」是**代码硬编码**(`piService.ts:399`),orchestrator.md:26 仅为提示词软引导;两处需同步修改。
- 可行性:高。最小改动为删掉 piService.ts:398–400 的 planner 分支(方案 A);推荐方案 B 走 `.workflows/config.json` 可配置(`loadConfig` 已就绪、动态读取即生效)。
- 主要风险不是技术而是流程:无上限后同 run 内 planner 重做不收敛会持续消耗上下文/成本,建议保留一个较大的兜底值或依赖用户中断机制。
