# 执行报告:回退 design 工具 preview 探测逻辑

> 用户决策:实测全库 73 站点 preview 文件均为空,无需额外处理。回退至 download 只下载 DESIGN.md。
> 产物目录内无 `02-plan-*.md`,按任务说明直接实施。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/designTools.ts` | ① 删除 `PREVIEW_FILES` 常量与 `PreviewProbe` 接口、`probePreview()` helper;② download 分支删除 preview 探测/下载循环(含 overwrite=false 下 preview「目标已存在跳过」分支)与返回中的 `preview 文件:` 清单/`preview 不存在`/`preview 探测失败`/`preview 跳过` 说明字段;③ 返回格式恢复为单行简洁 `已下载 X 字节到 …(来源:…)`;④ 模块注释、schema `download` action 描述、工具 description 中删除 preview 相关句子 | 任务 1:回退 preview 探测,download 只下载 DESIGN.md |
| `apps/api/src/pi/designTools.test.ts` | 删除 4 个 preview 相关新用例(preview 存在三文件落盘 / preview 404 只落盘 DESIGN.md / preview 网络错误静默跳过 / overwrite=false 整体跳过含 preview);overwrite 用例请求数断言 `c3` 由 3 恢复为 1(注释同步恢复为「DESIGN.md 1 次,首源 2xx 即停」) | 任务 2:恢复 29 个用例 |
| `docs/dag-workflow.md` | §4.1 删除「download 会自动带上存在的 preview 文件(…),上游缺失则跳过」 | 任务 3:文档回退 |
| `apps/api/src/pi/agents/executor.md` | 下载小节删除「download 会自动带上存在的 preview 文件(preview.html/preview-dark.html),上游缺失则跳过」 | 任务 3 |
| `apps/api/src/pi/agents/planner.md` | 文件清单一行删除「download 会自动带上存在的 preview 文件,上游缺失则跳过」,恢复为「文件清单(DESIGN.md)」 | 任务 3 |
| `apps/api/src/pi/agents/orchestrator.md` | design 工具行删除「自动带上存在的 preview 文件,上游缺失则跳过」 | 任务 3 |

## 关键删除/保留摘要

**删除**(designTools.ts):
- `const PREVIEW_FILES = ['preview.html', 'preview-dark.html']`
- `interface PreviewProbe` + `probePreview()`(复用三源回退探测、404→上游缺失/其余→探测失败、静默跳过)
- download 分支 preview 循环(落盘 preview.html / preview-dark.html、preview 跳过/缺失/失败三类说明行)
- 返回格式:多行(首行+`preview 文件:`清单+说明)→ 单行 `已下载 ${bytes} 字节到 ${relPath}(来源:${url})`

**保留**(既有护栏与独立增强):
- `fetchFile` 聚合错误「各源原因:<per-source>」增强(独立价值:错误可读性,与 preview 无关)
- 三源回退(jsDelivr@main → raw@main → raw@master,首次 2xx 即停)、单次 20s 超时
- 5MB 硬上限(content-length 预检 + 实际字节双查)、工作区边界拦截、只读拒绝、overwrite 默认 false 整体跳过(仅针对 DESIGN.md)、`Operation aborted` 唯一透传

## 自检结果

- `pnpm typecheck`(全仓 3 任务):✅ 通过
- `designTools.test.ts`:`29/29` 通过(原 33 − 删 4 = 29)
- 全包 `vitest run`:11 文件 `191/191` 通过(原 195 − 4)
- `pnpm --filter @workflows/api build`:✅ dist/pi/designTools.js 与 dist/pi/agents/*.md 已同步
- grep 残留:`apps/api/src`、`apps/api/dist`(designTools.js + agents md)、`docs` 均无 preview 命中;dist/pi/designTools.js 与 3 个 agents md 各 0 处

## 冒烟结果(临时脚本已删)

临时 `apps/api/src/pi/tmpRevertSmoke.mts`(tsx 直跑源码,真实 fetch,真实临时工作区,用后已删):

```
已下载 44083 字节到 designs/mintlify/DESIGN.md(来源:https://cdn.jsdelivr.net/gh/VoltAgent/awesome-design-md@main/design-md/mintlify/DESIGN.md)
```

- 返回格式简洁单行、无任何 preview 字段 ✅
- DESIGN.md 44083 字节正常落盘 ✅;preview.html / preview-dark.html 均未落盘 ✅

## 未完成项与原因

- 无。
