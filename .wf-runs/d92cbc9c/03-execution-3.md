# 执行报告:「选择即关闭抽屉」交互(窄视口选中工作区自动关抽屉)

## 任务
窄视口(<1100px)下,点击左侧工作区行选中工作区后,抽屉应自动关闭(避免遮罩盖住聊天区)。

## 改动文件清单
| 文件 | 改动 | 原因 |
|---|---|---|
| `apps/web/src/components/WorkspaceRail.vue` | ① `defineEmits<{ openPicker: [] }>()` → `defineEmits<{ openPicker: []; selectWorkspace: [] }>()`;② 工作区行按钮 `@click="agent.openWorkspace(ws.id)"` → `@click="emit('selectWorkspace'); agent.openWorkspace(ws.id)"`(先 emit 后切换,两行都保留) | 行按钮点击时向父级广播选中事件,App.vue 据此关闭抽屉 |
| `apps/web/src/App.vue` | `<WorkspaceRail>` 组件标签上新增 `@select-workspace="railOpen = false"`(与 `@open-picker` 并列) | 窄视口下选中工作区即关抽屉;桌面 ≥1100px 无抽屉,事件无副作用,不改变桌面行为 |
| `apps/web/src/components/WorkspaceRail.test.ts` | 新增用例「点击工作区行:先 emit select-workspace,再调用 openWorkspace」:按行按钮文本(含 'alpha')定位工作区行按钮并 trigger('click'),断言 `emitted('selectWorkspace')` 长度 1 且 `openWorkspace` 被以 `'ws-1'` 调用 | 覆盖新事件行为,并验证「两行都保留」(emit 与 openWorkspace 均生效) |

### 实现要点(踩坑记录)
- Vue 编译器通过 `exp.content.includes(';')` 判定事件处理器是否为多语句:`hasMultipleStatements` 为 false 时包装为 `$event => (expr)`(括号表达式),多语句换行无分号会编译为语法错误。故模板内两语句必须用分号连接:`@click="emit('selectWorkspace'); agent.openWorkspace(ws.id)"`。
- 未改动产物目录中不存在的计划文件(仅前次执行报告与 run.json;任务说明即计划)。

## Diff
```diff
diff --git a/apps/web/src/App.vue b/apps/web/src/App.vue
--- a/apps/web/src/App.vue
+++ b/apps/web/src/App.vue
@@
       <WorkspaceRail
         :agent="agent"
         :open="railOpen"
         @open-picker="showPicker = true"
+        @select-workspace="railOpen = false"
       />

diff --git a/apps/web/src/components/WorkspaceRail.vue b/apps/web/src/components/WorkspaceRail.vue
--- a/apps/web/src/components/WorkspaceRail.vue
+++ b/apps/web/src/components/WorkspaceRail.vue
@@
 const props = defineProps<{ agent: AgentStore; open: boolean }>()
-const emit = defineEmits<{ openPicker: [] }>()
+const emit = defineEmits<{ openPicker: []; selectWorkspace: [] }>()
@@
-          @click="agent.openWorkspace(ws.id)"
+          @click="emit('selectWorkspace'); agent.openWorkspace(ws.id)"

diff --git a/apps/web/src/components/WorkspaceRail.test.ts b/apps/web/src/components/WorkspaceRail.test.ts
--- a/apps/web/src/components/WorkspaceRail.test.ts
+++ b/apps/web/src/components/WorkspaceRail.test.ts
@@
+  it('点击工作区行:先 emit select-workspace,再调用 openWorkspace', async () => {
+    const { wrapper, openWorkspace } = mountRail()
+
+    const rowBtn = wrapper.findAll('button').find((b) => b.text().includes('alpha'))!
+    await rowBtn.trigger('click')
+
+    expect(wrapper.emitted('selectWorkspace')).toHaveLength(1)
+    expect(openWorkspace).toHaveBeenCalledWith('ws-1')
+  })
+
```

## 验证结果
| 检查 | 命令 | 结果 |
|---|---|---|
| test | `pnpm --filter @workflows/web test` | ✅ 8 files / **68** tests 全部通过(原 67 + 新增 1) |
| typecheck | `pnpm --filter @workflows/web typecheck` | ✅ vue-tsc -b 无错误 |
| lint | `pnpm --filter @workflows/web lint` | ✅ eslint 无错误 |
| pre-commit 钩子 | lint-staged + turbo typecheck/test | ✅ 提交时全仓校验通过(web 68 tests 通过),未产生额外改动 |

## Commit
- hash: `502d5b1898f2d8639a358ed2c22db596c5b9e013`(`502d5b1`)
- message: `feat(web): close drawer on workspace select`
- 变更:3 files changed, 13 insertions(+), 2 deletions(-)

## 未完成项
无。
