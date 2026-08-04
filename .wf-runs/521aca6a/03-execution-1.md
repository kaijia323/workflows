# 执行报告:design 工具 download 增加 preview 自动探测下载

> 产物目录内无 `02-plan-*.md`(仅 run.json),按任务说明直接实施。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/designTools.ts` | ① 模块注释补充 preview 自动探测说明;② 新增常量 `PREVIEW_FILES = ['preview.html', 'preview-dark.html']`;③ schema 的 `download` action 描述补一句 preview 说明;④ 新增 `PreviewProbe` 接口与 `probePreview()` helper(复用 `fetchFile` buffer 模式,跟随 jsDelivr→raw@main→raw@master 三源回退;错误消息含 `404` → `上游缺失`,其余(超时/网络错/超 5MB)→ `探测失败`;用户中止 `Operation aborted` 唯一透传);⑤ download 分支:DESIGN.md 落盘成功后逐个探测两个 preview——`overwrite=false` 且 preview 已存在 → `preview 跳过:...(目标已存在,overwrite=false 不覆盖)`;2xx → 同目录落盘并计入清单;失败 → 静默跳过不阻塞;⑥ 返回格式:`已下载 X 字节到 ...(来源:...)` + `preview 文件:` 清单(路径+字节+来源)+ `preview 不存在:...(上游缺失),已跳过` / `preview 探测失败:...(网络错误/超时/超限),已跳过`;⑦ `fetchFile` 聚合错误消息补充 `各源原因:<per-source>`(原 errors 数组收集后未使用;preview 分类依赖其中的 404 信息,同时提升用户侧错误可读性);⑧ 工具 description 补"自动带上存在的 preview 文件,上游缺失则跳过" | 任务 1/2:探测、落盘、护栏、返回格式 |
| `apps/api/src/pi/designTools.test.ts` | 既有 overwrite 用例 `c3` 断言 1→3(DESIGN.md 1 次 + 两个 preview 探测各 1 次,附注释);新增 4 用例:preview 存在 → 3 文件全落盘(含 3 次请求断言);preview 404 → 只落盘 DESIGN.md、不报错、返回含 `preview 不存在`+`上游缺失`;preview 网络错误(ECONNREFUSED)→ 静默跳过不阻塞;overwrite=false 且 DESIGN.md 已存在 → 整体跳过、不发任何请求、既有 preview 不被触碰 | 任务 3:新增用例 + 既有 29 例保持全过 |
| `docs/dag-workflow.md` | §4.1 `download` 一行追加:"download 会自动带上存在的 preview 文件(`designs/<站点>/preview.html` / `preview-dark.html`),上游缺失则跳过" | 任务 4:文档同步一句 |
| `apps/api/src/pi/agents/executor.md` | 下载小节追加一句:"download 会自动带上存在的 preview 文件(preview.html/preview-dark.html),上游缺失则跳过" | 任务 4 |
| `apps/api/src/pi/agents/planner.md` | 文件清单一行补:"download 会自动带上存在的 preview 文件,上游缺失则跳过" | 任务 4 |
| `apps/api/src/pi/agents/orchestrator.md` | design 工具行补:"自动带上存在的 preview 文件,上游缺失则跳过" | 任务 4 |

## 关键代码摘要

```ts
/** DESIGN.md 下载成功后自动探测的同站点 preview 文件(上游缺失则静默跳过) */
const PREVIEW_FILES = ['preview.html', 'preview-dark.html']

async function probePreview(opts, repoPath, signal): Promise<PreviewProbe> {
  try {
    const data = await fetchFile(opts, repoPath, 'buffer', signal) // 三源回退
    return { ok: true, data }
  } catch (error) {
    if (error instanceof Error && error.message === 'Operation aborted') throw error
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: message.includes('404') ? '上游缺失' : '探测失败' }
  }
}

// download 分支:DESIGN.md 写盘后
for (const previewName of PREVIEW_FILES) {
  const previewTarget = path.join(targetDir, previewName)
  if (existsSync(previewTarget) && !overwrite) { noteLines.push(`preview 跳过:${previewName}(目标已存在,overwrite=false 不覆盖)`); continue }
  const probe = await probePreview(opts, `${path.dirname(repoPath)}/${previewName}`, signal)
  if (probe.ok && probe.data) {
    writeFileSync(previewTarget, probe.data.buffer ?? Buffer.alloc(0))
    fileLines.push(`- ${relPath(opts.workspace, previewTarget)}(${probe.data.bytes} 字节,来源:${probe.data.url})`)
  } else if (probe.reason === '上游缺失') noteLines.push(`preview 不存在:${previewName}(上游缺失),已跳过`)
  else noteLines.push(`preview 探测失败:${previewName}(网络错误/超时/超限),已跳过`)
}
const message = [`已下载 ${data.bytes} 字节到 ${relPath(opts.workspace, target)}(来源:${data.url})`]
if (fileLines.length > 0) message.push('preview 文件:', ...fileLines)
if (noteLines.length > 0) message.push(...noteLines)
```

语义保持:overwrite=false 且 DESIGN.md 已存在 → 仍在任何请求前整体拒绝(既有行为,preview 不探测);preview 各自受 5MB 上限(复用 fetchFile buffer 双查)、工作区边界(targetDir 已校验)、overwrite 约束;任一 preview 失败不阻塞主流程。

## 自检结果

- `pnpm exec tsc --noEmit`(apps/api):✅ 通过
- `designTools.test.ts`:33/33 通过(既有 29 + 新增 4)
- 全包 `vitest run`:11 文件 195/195 通过
- `pnpm --filter @workflows/api build`:✅ dist/pi/designTools.js 已同步(PREVIEW_FILES / probePreview / 各源原因 均在);copy-agents 后 dist/pi/agents/{executor,planner,orchestrator}.md 均含 preview 一句

## 真实冒烟结果(临时脚本已删除,证据保留)

脚本方式:临时 `apps/api/src/pi/tmpPreviewSmoke.mts`(tsx 直跑源码导出,真实 fetch),用后已删;落盘证据保留在 `.wf-runs/521aca6a/smoke-designs/designs/`。

| 站点 | 返回 | 落盘 |
| --- | --- | --- |
| mintlify | DESIGN.md 44083 字节落盘(来源 jsDelivr@main);`preview 不存在:preview.html(上游缺失),已跳过`;`preview 不存在:preview-dark.html(上游缺失),已跳过` | designs/mintlify/DESIGN.md(44083 字节)✅ |
| claude | DESIGN.md 33586 字节落盘;两个 preview 均"上游缺失"跳过 | designs/claude/DESIGN.md(33586 字节)✅ |
| stripe | DESIGN.md 24606 字节落盘;两个 preview 均"上游缺失"跳过 | designs/stripe/DESIGN.md(24606 字节)✅ |

**上游 preview 实测记录**(README 声称每站点含 preview.html/preview-dark.html,实测普遍缺失):
- jsDelivr @main 全库扫描:README 声明 73 站点,`design-md/<site>/preview.html` 命中 **0/73**
- raw.githubusercontent @main 抽查 mintlify/claude/stripe 的 preview.html 与 preview-dark.html:全部 **HTTP 404**(排除 CDN 缓存误导,与任务背景"jsDelivr 数据 API 过期缓存"结论一致)

结论:mintlify 场景完全符合任务预期(DESIGN.md 正常落盘 + 返回明确"preview 缺失"说明);由于上游仓库各站点 preview 普遍缺失,真实下载均走"上游缺失静默跳过"路径;preview 存在路径由单测确定性覆盖(mock 2xx 三文件全落盘)。

## 未完成项与原因

- 无。备注:preview"超时"场景未单独设单测——超时与网络错误在 `probePreview` 走同一 catch 分支,由"网络错误静默跳过"用例覆盖同一代码路径;若需独立超时用例可后续补(现有超时回退用例模式可直接复用)。
- 冒烟工作区最初被脚本写到 `apps/.wf-runs/`(脚本路径推导偏差),已迁移至产物目录 `.wf-runs/521aca6a/smoke-designs/`,`apps/.wf-runs/` 已清理。
