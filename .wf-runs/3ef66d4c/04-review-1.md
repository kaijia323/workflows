# 审查报告:修复 MCP 状态显示异常 & 设置模态窗高度超出可视区

> 审查对象:计划 `.wf-runs/3ef66d4c/02-plan-1.md` ↔ 执行 `.wf-runs/3ef66d4c/03-execution-1.md` ↔ 实际代码(git 工作区)
> 审查方式:逐文件阅读实际代码 + 全仓 grep 消费方排查 + 与探索报告中的原始代码对照

## 结论:pass

---

## 逐条核对结果

### 1. `apps/web/src/components/McpPanel.vue` — 通过

| 计划项 | 状态 | 说明 |
|---|---|---|
| import 增加 `onMounted` | ✅ | L1:`import { computed, onMounted, ref } from 'vue'` |
| onMounted 打开即刷新,失败静默 | ✅ | L24-25:`void props.agent.refreshMcp().catch(() => {})`,与 init() 一致;App.vue L65 确认 `<ApiKeyModal v-if="showSettings">`,模态窗每次打开都重新 mount McpPanel → 刷新行为每次打开均触发,设计生效 |
| 刷新按钮(防重复点击) | ✅ | L27-38 `handleRefresh`:`refreshing` 互斥 + finally 复位;模板按钮 `:disabled="refreshing"`、文案「刷新中…/刷新」,样式复用现有小按钮 class |
| statusLabel 增加 not_connected | ✅ | L60-61:`case 'not_connected': return '未连接 · 新建会话后自动连接'` |
| statusClass 增加 not_connected → text-mute | ✅ | L72:`if (state === 'not_connected') return 'text-mute'`(中性灰,非 text-err) |
| 标题行 flex + 右侧刷新按钮 | ✅ | 结构与计划一致(实现把 `mt-6 border-t pt-4` 保留在外层 wrapper、flex 放在内层 div,视觉效果与计划等价,属微调非偏离) |

### 2. `packages/shared/src/index.ts` — 通过

| 计划项 | 状态 | 说明 |
|---|---|---|
| `state` 联合类型增加 `'not_connected'` | ✅ | L100:`state: 'disabled' \| 'connecting' \| 'connected' \| 'error' \| 'not_connected'`,注释同步说明语义 |
| 消费方全仓兼容 | ✅ | 全仓 grep `McpServerStatus` 消费方:routes.ts(写,已改)、mcpTools.ts(写;`McpEntry.state` L335 为 `'connected'\|'connecting'\|'error'` 子集,类型兼容,无需改)、piService.ts(仅透传)、useAgent.ts(仅类型引用)、McpPanel.vue(渲染,已改)。DagPanel 的 `state` 为独立类型(`'idle'\|'running'\|'done'\|'error'`,L21),不受影响。无遗漏消费方、无穷尽 switch 破坏 |

### 3. `apps/api/src/agent/routes.ts` — 通过

| 计划项 | 状态 | 说明 |
|---|---|---|
| 未连接 enabled server 不再推导 error | ✅ | L80:`state: server.enabled === true ? 'not_connected' : 'disabled'`,`error: undefined`,`toolCount: 0`,`lastCheckedAt: null` |
| 误导性文案删除 | ✅ | 「尚未连接(配置变更后…)」已删除(全仓 grep 无残留) |
| disabled 仍为 disabled | ✅ | 同上三元分支 |
| manager 已有记录原样透传 | ✅ | L76-77:`const existing = statusByName.get(server.name); if (existing) return existing` — 真正的连接失败(manager error 态 + 具体 error 文案)路径未动 |
| 注释同步更新 | ✅ | L68 注释改为「disabled 或 not_connected(已启用但从未尝试连接,中性提示,非错误态)」 |

### 4. `apps/api/src/agent/mcpRoutes.test.ts` — 通过

| 计划项 | 状态 | 说明 |
|---|---|---|
| PUT 新增用例 status 断言加强 | ✅ | L102-105:`toMatchObject({ name: 'echo', state: 'not_connected', toolCount: 0 })` + `expect(data.status[0].error).toBeUndefined()`(routes.ts 显式 `error: undefined` 序列化后无该键,断言语义正确) |
| 其余用例不受影响 | ✅ | PUT 覆盖/DELETE/400/test 用例未动;`data.status[0].error` 类型注解放宽为 `error?: string`(执行报告已说明,tsc 必需,属测试本地类型,合理) |

### 5. `apps/web/src/components/ApiKeyModal.vue` — 通过

| 计划项 | 状态 | 说明 |
|---|---|---|
| 内层 `max-h-[85vh] overflow-y-auto` | ✅ | L61,与 SubAgentModal 模式一致,max-h 与 overflow 成对出现 |
| 外层 `overflow-y-auto p-6` | ✅ | L58,兜底极端小屏;`@click.self` 关闭逻辑不受影响(内层滚动不冒泡为自身 click) |
| 零逻辑改动 | ✅ | 仅模板 class,script 区未动 |

### 6. 范围控制 / 回归风险 — 通过

- 改动仅 5 个源码文件,与计划清单一致;mcpTools.ts / piService.ts / subAgent.ts / useAgent.ts / App.vue / SubAgentModal.vue 均未触碰(grep 确认)。
- `packages/shared/dist` 重建属构建产物(gitignored),monorepo 既有约定,非源码改动。
- 自检报告:api typecheck/lint/test(267 passed)、web typecheck/lint/test(34 passed)全绿;测试结果无法在本审查中独立复跑(只读环境),但代码层面断言与实现一致、类型安全。

### 7. 状态语义总核对 — 通过

- 配置后未连接(enabled 且 manager 无记录)→ `not_connected` → 灰 `text-mute`「未连接 · 新建会话后自动连接」✅
- 连接失败(manager error)→ `error` → 红 `text-err`「异常:<真实错误>」✅(路径未动)
- 连接成功 → `connected` → `text-primary`「已连接 · N 工具」✅
- 未启用 → `disabled` → 「未启用」默认分支 ✅

---

## 问题清单

无阻断性问题。以下为非阻断观察(不构成打回理由):

1. **(低)** `apps/web/src/components/McpPanel.vue` L31 `handleRefresh` 开头 `error.value = null` 会清掉面板中未完成的保存/删除错误提示;刷新按钮与 onMounted 刷新可并发(互斥仅覆盖按钮)。均为计划原文指定行为,GET 幂等无害,不修。
2. **(低)** 刷新按钮位于可滚动盒内,内容较长时按钮随内容滚出视野,需滚动回顶部才能点击。计划明确选择最小改动(不做 header 常驻),可接受。
3. **(提示)** 计划 §4.2 手动验证场景未在执行报告中体现(仅自动化验证)。建议在 dev 环境补跑场景 2/5(not_connected 灰 vs error 红)确认渲染效果,但非验收必要条件。

---

## 最终建议:**通过**

改动严格贴合计划,状态语义(not_connected 中性 / error 异常 / connected 成功)三态区分正确,类型改动全仓兼容,测试断言与实现一致,无计划外改动。可合入。
