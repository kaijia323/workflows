# 执行报告:审查建议清理(图标精确断言 + 死桩清理)

> 依据:任务说明指定的两处清理(对应 `04-review-1.md` 问题清单中两条「低(非阻塞)」建议)。产物目录无 `02-plan-*.md`(run.json 状态为 planning),以审查报告建议为计划基准。

## 改动文件清单

### 1. `apps/web/src/components/InfoPanel.test.ts`

- **新增导入**:`import { Lock, Unlock } from '@lucide/vue'`(与 `InfoPanel.vue` 的导入来源一致,按字母序置于 `@vue/test-utils` 之前)。
- **读写用例(原 `find('svg')` 断言)**:`expect(toggle.find('svg')).toBeTruthy()` → `expect(toggle.findComponent(Unlock).exists()).toBe(true)`,精确校验 Unlock 图标。
- **只读用例**:用例名声称「Lock 图标」但原先无图标断言,新增 `expect(toggle.findComponent(Lock).exists()).toBe(true)`。
- 原因:若 Lock/Unlock 图标逻辑被反装,原断言不会失败;精确断言使测试与用例名/组件实现一致。

### 2. `apps/web/src/components/WorkspaceRail.test.ts`

- **删除 `toggleReadOnly` 死桩**,共 3 处:
  - `const toggleReadOnly = vi.fn(async () => {})`(stub 声明)
  - store 对象中的 `toggleReadOnly,` 字段
  - 返回值 `return { wrapper, removeWorkspace, toggleReadOnly, openWorkspace }` → `{ wrapper, removeWorkspace, openWorkspace }`
- 原因:`WorkspaceRail.vue` 动作行删除后已不再调用 `agent.toggleReadOnly`(grep 确认仅 `InfoPanel.vue` 使用),残留 stub 属死代码。`InfoPanel.test.ts` 中的 `toggleReadOnly` stub 仍被点击用例使用,保留不动。

## 自检结果

- `pnpm --filter @workflows/web test`(vitest run):**11 files passed / 109 tests passed**,全绿(3.05s)。
- 无类型检查受影响(纯测试文件改动;stub 删除后 WorkspaceRail 各用例均未引用 `toggleReadOnly`,编译无碍)。

## 未完成项

无。两条建议均已落实,`WorkspaceRail.vue:70` 的 `px-3`/`pr-9` 排序依赖属「提示」级且审查建议无操作必要,未动。
