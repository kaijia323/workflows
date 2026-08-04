# 执行报告:移除 planner 重做上限(方案 B:可配置 + 默认无上限)

计划文件:.wf-runs/80fa4852/02-plan-*.md / 探索报告 01-exploration-2.md
执行日期:2026-XX-XX

## 改动文件清单

| 文件 | 改动内容 | 原因 |
|---|---|---|
| `apps/api/src/config.ts` | `StoredConfig` 接口新增可选字段 `plannerMaxRetries?: number`,注释说明语义:缺省/0/负数 = 无上限;≥1 = 同一 run 内 planner 最多调用 N 次 | 方案 B 的配置落点;与 anySearchApiKey 同机制,`loadConfig` 每次工具调用即时读文件、保存后立即生效,无需重启 |
| `apps/api/src/pi/piService.ts` | `createSubAgentTool` 的 execute 内(L389-400):planner 分支由硬编码 `plannerCalls >= 2` 改为动态读取 `loadConfig(this.store).plannerMaxRetries`;仅当配置为 `typeof number && >= 1` 时才检查上限,报错文案动态拼 `${plannerMaxRetries}` 次;注释同步更新为「planner 重做上限可配置(缺省 = 无上限)」。executor⇄reviewer 的 3 轮上限(L395-397)保持不动 | 移除硬编码 2 次上限,改为可配置;缺省(未配置)即无上限,符合用户要求 |
| `apps/api/src/pi/agents/orchestrator.md` | 第 26 行:「仍 fail 可回 planner 重做(最多 2 次)」→「仍 fail 可回 planner 重做(无硬性次数限制,但注意收敛与成本)」 | 软限制与代码行为同步,避免模型预期与系统行为割裂 |
| `.workflows/config.json` | **未改动** | 默认不配置 = 无上限;无需显式初始化该字段(可选字段,`loadConfig` 缺省返回 undefined 即跳过检查),故不写入任何值(尤其不写 2) |

## 其他引用核查

- grep `plannerCalls`(apps/api/src):仅 piService.ts 一处,已改。
- grep 「2 次」「最多 2」「planner 重做」(apps/api/src,含 agents/*.md):改后已无残留。
- 联动点(探索报告已核查,本次确认无需改动):`subAgent.ts:63` 产物序号天然支持任意次数;`detectPlanFile`(piService.ts:850)前缀扫描天然兼容;前端 DagPanel 纯渲染;shared 类型无上限字段;无相关测试断言。

## 改动后行为

- **未配置 `plannerMaxRetries`(缺省)**:planner 无上限,可无限重做(不再抛「重做计划已达上限」错误)。
- **配置 N(≥1 的数字,如 `.workflows/config.json` 加 `"plannerMaxRetries": 5`)**:同一 run 内 planner 调用次数达到 N 时抛「重做计划已达 N 次上限。立即收尾……」(与旧代码 `plannerCalls >= 2` 的判定公式一致,配置 2 即等价旧行为)。
- 0 / 负数 / 非数字:视为无上限。
- executor⇄reviewer 的 3 轮上限不变。

## 自检结果

- `pnpm typecheck`(apps/api,tsc --noEmit):通过,无错误。
- `pnpm test`(apps/api,vitest run):10 个测试文件、153 个测试全部通过。
- 未做完整 `pnpm build`(含 copy-agents 复制 md 到 dist,与本改动无直接关联;typecheck 已覆盖类型正确性)。

## 未完成项

无。所有计划项已按方案 B 完成。
