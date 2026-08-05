# 执行报告:移除子代理详情模态窗 footer 摘要渲染

## 任务

修复子代理详情模态窗 footer 重复渲染摘要的问题(摘要已作为最后一条 assistant 消息流式进入 `sub.messages` 并由 MessageBubble markdown 渲染,footer 纯文本 `{{ summary }}` 为重复展示)。仅修改 `apps/web/src/components/SubAgentModal.vue`。

> 注:产物目录中暂无 `02-plan-*.md`,以任务说明为执行依据;`01-exploration-1.md` 第 5 节的移除方案与任务说明完全一致。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
|---|---|---|
| `apps/web/src/components/SubAgentModal.vue` | 1. 删除脚本中 `const summary = computed(() => live.value?.summary ?? '')`;2. 删除模板 footer 中整个摘要 `<p v-if="summary">…{{ summary }}</p>` 块;3. 将 footer 注释 `<!-- 底部:摘要 + 产物 -->` 同步改为 `<!-- 底部:产物 -->` | 摘要文本已由 body 消息流中 MessageBubble 以 markdown 渲染,footer 纯文本重复展示;删除模板引用后 `summary` computed 无引用(项目 `vue-tsc -b` 开启 noUnusedLocals),一并删除避免编译报错;artifact 块原样保留 |

## Diff 摘要

```diff
@@ script
-const summary = computed(() => live.value?.summary ?? '')
 const artifact = computed(() => live.value?.artifact ?? null)

@@ template(footer)
-      <!-- 底部:摘要 + 产物 -->
+      <!-- 底部:产物 -->
       <div class="shrink-0 border-t border-hairline px-5 py-3">
-        <p
-          v-if="summary"
-          class="text-xs leading-relaxed text-body"
-        >
-          <span class="font-display text-[10px] tracking-[0.2em] text-mute">摘要 </span>
-          {{ summary }}
-        </p>
         <p
           v-if="artifact"
           class="mt-1.5 font-mono text-[10px] text-mute"
```

净效果:-7 行 / +0 行。footer 现仅保留产物(artifact)展示。

## 自检结果

- **类型检查**:`cd apps/web && pnpm typecheck`(`vue-tsc -b`)通过,无错误(0 error)。
- **残留引用**:`fff-grep summary apps/web/src/components/SubAgentModal.vue` → 无匹配,`summary` 变量及模板引用已全部清除,不会触发 noUnusedLocals。

## 未改动项(按约束)

- `apps/web/src/composables/useAgent.ts`(`sub.summary` 状态仍由 sub_end 写入,供 DAG/run 快照使用)
- 后端 `extractSummary`、`piService.ts` 的 `sub_end` 事件
- `DagPanel.vue` 等其它文件
- footer 的 artifact 展示
- 历史回看路径行为不受影响(live 为 null 时 summary 本为空,footer 原本就不显示摘要)

## 未完成项

无。探索报告提及的「失败调用场景下 footer 不再展示错误摘要文本」(isError 时 summary 不在消息流中)属产品取舍,超出本任务最小改动范围,未处理。
