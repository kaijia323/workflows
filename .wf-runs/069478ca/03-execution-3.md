# 执行报告:修复 ChatPane.vue 输入框 textarea 垂直视觉偏移

> 任务:在 `apps/web/src/components/ChatPane.vue` 的 textarea class 中添加 `block`,消除 inline 元素基线空隙(baseline 空隙约 6.7px)导致的 textarea 视觉重心偏上、与发送按钮不垂直居中的问题。
> 说明:产物目录中无 `02-plan-*.md`,以任务说明要求为准执行。

## 1. 改动文件清单

| 文件 | 改动内容 | 原因 |
|---|---|---|
| `apps/web/src/components/ChatPane.vue`(textarea,约 L410) | textarea class 列表开头添加 `block`:`max-h-40 ...` → `block max-h-40 ...` | textarea 是 inline 元素,默认 `vertical-align: baseline`,在其父容器 `div.relative.flex-1`(display:block)内部底部产生约 6.7px 基线空隙,导致 textarea 视觉重心偏上;添加 `block` 使其 display:block,消除基线空隙,与发送按钮(`items-center` 已生效)垂直居中对齐。唯一改动。 |

**未改动**:容器行(L378)`<div class="flex items-center gap-2">` 保持原样;按钮、skill 下拉、其他所有样式一概未动。

## 2. 改动 diff

```diff
--- a/apps/web/src/components/ChatPane.vue
+++ b/apps/web/src/components/ChatPane.vue
@@ -410,7 +410,7 @@
           <textarea
             ref="textareaRef"
             v-model="draft"
             :disabled="!agent.activeWorkspaceId.value"
             rows="1"
             spellcheck="false"
             :placeholder="agent.activeWorkspaceId.value ? '输入消息,输入 / 可搜索 skills,Enter 发送,Shift+Enter 换行…' : '先在左侧选择一个工作区'"
-            class="max-h-40 min-h-[40px] w-full resize-none rounded-sm border border-hairline bg-canvas-soft px-4 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-mute focus:border-primary disabled:opacity-50"
+            class="block max-h-40 min-h-[40px] w-full resize-none rounded-sm border border-hairline bg-canvas-soft px-4 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-mute focus:border-primary disabled:opacity-50"
             @keydown="onKeydown"
             @blur="skillMenuOpen = false"
           />
```

## 3. 兼容性检查

- **容器对齐**:L378 `flex items-center gap-2` 未动,`items-center` 交叉轴居中逻辑不变;textarea 改 `block` 后不再贡献基线空隙,其盒模型自身(40px min-h)与发送按钮(约 36.5px)在中线对齐,视觉一致。
- **宽度**:textarea 已有 `w-full`,`block` 不影响宽度与 `flex-1` 容器占满逻辑。
- **多行增长**:`block` 不影响 `max-h-40` / `min-h-[40px]` / `resize-none` / `rows="1"` 的自动增高行为。
- **skill 搜索下拉**:绝对定位浮层(`absolute bottom-full`)不参与 flex 对齐,不受影响。
- **流式「停止」按钮分支**:同容器 `v-if/v-else`,不受影响。

## 4. 自检结果

- **构建**:`apps/web` 下 `pnpm build`(`vue-tsc -b && vite build`)— **通过**(`✓ built in 519ms`),类型检查与产物构建均无错误。
- 改动前后 diff 仅为 textarea class 添加 `block` 一处,无其他副作用。

## 5. 未完成项

无。所有要求项已完成。
