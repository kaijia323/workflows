# 执行报告:删除 DagPanel 组件

> 产物目录中无 `02-plan-*.md`(run.json 状态为 planning、planFile 为 null),任务说明内含完整已确认改动清单,以任务说明为执行依据。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/web/src/components/DagPanel.vue` | **整文件删除**(`rm`) | 用户明确要求移除右侧观测面板顶部的「流程 · PIPELINE」DAG 面板,组件不再需要 |
| `apps/web/src/components/InfoPanel.vue` | ① 删除 `import DagPanel from './DagPanel.vue'`;② 删除 `const emit = defineEmits<{ openSub: [...] }>()` 及其上方空行;③ 删除模板中 `<!-- 上方:工作流 DAG 图 -->` 注释 + `<DagPanel :agent="agent" @open="emit('openSub', $event[0], $event[1])" />` 整块 | DagPanel 是 InfoPanel 中唯一 emit `openSub` 的来源;删除后 `emit` 无使用,保留会触发 vue-tsc noUnusedLocals;`agent` prop 仍被 activeWorkspace/status/toolRuns 使用,保留未动 |
| `apps/web/src/App.vue` | 删除 `<InfoPanel>` 上的 `@open-sub="(callId, agentName) => (subModal = { callId, agentName })"` 属性 | InfoPanel 不再 emit openSub;`<ChatPane>` 上的 `@open-sub` 监听(第 112 行)保留未动 |

未改动其他文件(useAgent.ts、后端、shared、ChatPane.vue 等一律未动)。

## 自检结果

| 检查项 | 结果 |
| --- | --- |
| `rm` 后 DagPanel.vue 不存在 | ✅ `ls apps/web/src/components/` 无 DagPanel.vue |
| 全仓 grep `DagPanel` | ✅ apps/web/src 中 0 引用;仅 `.wf-runs/` 历史报告提及(非源码) |
| 全仓 grep `openSub` / `open-sub` | ✅ apps/web/src 中仅剩:ChatPane.vue 的 emit 声明(L21)与触发处(L348)、App.vue 中 ChatPane 的监听(L112);InfoPanel.vue 与 App.vue 中 InfoPanel 相关引用归零 |
| `pnpm typecheck`(`vue-tsc -b`,apps/web) | ✅ 通过,0 错误,无 noUnusedLocals / 未使用导入 |
| InfoPanel.vue 复查 | ✅ 脚本区无 DagPanel 导入、无 defineEmits;模板区 DAG 块已移除,`agent` prop、观测各 section 原样保留 |

## 未完成项

无。全部改动按清单完成并通过验收。
