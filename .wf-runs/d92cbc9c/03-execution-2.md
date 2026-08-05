# 执行报告:修复 flex 布局滚动 bug(ChatPane min-h-0)

## 任务
修复 apps/web/src/components/ChatPane.vue 中消息列表无法滚动的问题。

## 根因(来自任务说明)
T3 抽屉改动在 App.vue 引入中栏 wrapper(`flex min-w-0 flex-1 flex-col`),ChatPane 的 `<section>` 成为 flex-col 容器的主轴子项。flex 子项默认 `min-height:auto`,消息多时 section 被内容撑开而不收缩,内部滚动容器(`min-h-0 flex-1 overflow-y-auto`)的 clientHeight 被撑到等于内容高度 → `scrollHeight == clientHeight`,无法滚动。

## 改动文件清单
| 文件 | 改动 | 原因 |
|---|---|---|
| `apps/web/src/components/ChatPane.vue`(第 235 行) | `<section class="flex min-w-0 flex-1 flex-col bg-canvas">` → `<section class="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">`(仅加 `min-h-0`) | 允许 section 在 flex 容器主轴方向收缩,内部滚动容器才能获得受限的 clientHeight,使 scrollHeight > clientHeight 从而可滚动。未改动其他任何布局/逻辑。 |

## Diff
```diff
diff --git a/apps/web/src/components/ChatPane.vue b/apps/web/src/components/ChatPane.vue
index 096a5f9..7c0784d 100644
--- a/apps/web/src/components/ChatPane.vue
+++ b/apps/web/src/components/ChatPane.vue
@@ -232,7 +232,7 @@ async function rejectPlan(): Promise<void> {
 </script>
 
 <template>
-  <section class="flex min-w-0 flex-1 flex-col bg-canvas">
+  <section class="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
     <!-- 工作区头部:处理节点标签 -->
     <div class="flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-5">
       <template v-if="agent.activeWorkspace.value">
```

## 验证结果
| 检查 | 命令 | 结果 |
|---|---|---|
| test | `pnpm --filter @workflows/web test` | ✅ 8 files / 67 tests 全部通过 |
| typecheck | `pnpm --filter @workflows/web typecheck` | ✅ vue-tsc -b 无错误 |
| lint | `pnpm --filter @workflows/web lint` | ✅ eslint 无错误 |
| pre-commit 钩子 | lint-staged(eslint --fix)+ turbo typecheck/test | ✅ 全仓 3 packages typecheck、test(web 67 + api 293 + shared)全部通过,且未对提交内容产生额外改动 |

纯 class 改动未触及任何测试覆盖的行为,现有测试不受影响。

## Commit
- hash: `54fc9c2dce2356170f309e6683f390fd923160a0`(`54fc9c2`)
- message: `fix(web): chat column min-h-0 so message list can scroll`
- 变更:1 file changed, 1 insertion(+), 1 deletion(-),仅 ChatPane.vue

## 未完成项
无。
