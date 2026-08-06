# 执行报告:会话列表排序改为降序(最新在前)

- 运行 ID:6ba25936
- 执行时间:2026-08-06

## 计划文件说明

产物目录 `.wf-runs/6ba25936/` 下无 `02-plan-*.md`(run.json 状态为 planning,planFile 为 null)。任务说明中已包含完整调研结论与改动要求(背景 + 3 条改动要求),据此作为唯一执行依据实施。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/api/src/config.ts` | `listSessions()` 排序由 `sort((a, b) => a.createdAt - b.createdAt)` 改为 `sort((a, b) => b.createdAt - a.createdAt)`(第 352 行) | 需求「会话历史降序,最新在最前」:createdAt 最大(最新)的会话排第一 |
| `apps/api/src/config.ts` | 函数上方注释由「工作区会话列表(按创建时间升序)」改为「工作区会话列表(按创建时间降序,最新在前)」 | 注释与实现保持一致 |

未改动任何其他文件、其他逻辑、字段名与类型(最小改动)。

### 有意保留的关联逻辑(未改动)

- `removeSession()`(第 438 行)内的升序排序:其用途是删除激活会话后取 `at(-1)` 选「最新」会话重新激活,与列表渲染顺序无关,不在本次需求范围内,保持不变。
- 前端 `SessionSwitcher.vue`、`routes.ts`、`piService.ts` 的 `listSessionMetas` 均透传列表且不依赖顺序,无需改动(已核实 `sessions.find(...)` 只查不排)。

## 自检结果

1. **类型检查**:`cd apps/api && npx tsc --noEmit` → 通过(exit 0,无错误)。
2. **Lint**:`npx eslint src/config.ts` → 通过(exit 0,无告警)。
3. **单测**:全仓无 `listSessions`/会话排序相关单测(`*.test.ts`/`*.spec.ts` 中 grep `listSessions|listSessionMetas|按创建时间` 无匹配),故无现成测试可跑;上述静态验证 + 变更仅一处比较器符号的核对即为验证方式。
4. **逻辑复核**:`b.createdAt - a.createdAt` 为正时 `b` 在前,即 createdAt 大者(更新会话)排前,满足「最新在最前」;`Object.values` + `sort` 原地排序不影响持久化数据。

## 未完成项

无。
