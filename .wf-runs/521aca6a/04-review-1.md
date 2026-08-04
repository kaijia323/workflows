# 审查报告:design 工具 download 增加 preview 自动探测(增量)

> 审查对象:任务说明「改动范围」 vs 执行报告 `.wf-runs/521aca6a/03-execution-1.md`(产物目录内无 02-plan-*,run.json 状态 planning/planFile null,执行按任务说明直接实施,以任务说明改动范围为准核对)
> 审查方式:逐文件读源码 `apps/api/src/pi/designTools.ts` / `designTools.test.ts` / 4 处文档 + dist 编译产物 + 冒烟证据目录核对;本环境无 shell,测试结果采信执行报告自检数字(33/33 与源码用例逐一计数吻合)

## 结论:pass

---

## 一、逐条核对结果

### 1. download 增加 preview 自动探测(`designTools.ts`)— 通过
- `PREVIEW_FILES = ['preview.html', 'preview-dark.html']`(L37-38)与 `PreviewProbe` 接口、`probePreview()` helper(L255-271)存在;探测复用 `fetchFile` buffer 模式,跟随 jsDelivr@main → raw@main → raw@master 三源回退。✅
- **不阻塞主流程**:DESIGN.md `writeFileSync` 在 preview 循环之前(L305-306);`probePreview` 捕获 fetchFile 全部错误仅返回 `{ok:false,reason}`,循环不抛错;`Operation aborted` 唯一透传(probePreview L263 + executeDesign 外层 catch L329-330)。✅
- **overwrite=false 整体跳过**:`existsSync(target) && !overwrite` 在任何 fetch 之前 return(L296-298),DESIGN.md 与 preview 均不发请求;preview 循环内另有 `existsSync(previewTarget) && !overwrite` 单文件跳过(L310-313,部分残留场景语义自洽)。✅
- **返回格式**:首行 `已下载 X 字节到 …(来源:…)` + `preview 文件:` 清单(路径+字节+来源)+ `preview 不存在:(上游缺失),已跳过` / `preview 探测失败:(网络错误/超时/超限),已跳过` / `preview 跳过:`(L316-326),与计划一致。✅
- **fetchFile 聚合错误增加 `各源原因:`**(L220-222):原 errors 数组从"只收集不使用"变为拼入错误消息,preview 404 分类依赖其中 `HTTP 404` 文本,同时提升用户侧可读性。✅
- 工具 description 与 schema action 描述同步补充 preview 一句(L57-60、L339-341)。✅

### 2. 测试(`designTools.test.ts`)— 通过
- 既有 overwrite 用例 `c3` 断言 1→3:mock 全 200 时 overwrite=true 路径 = DESIGN.md 1 次 + 两个 preview 探测各 1 次,断言合理并附注释。✅
- 新增 4 用例均有效:
  - preview 存在 → 3 文件全落盘 + 3 次请求断言 + 落盘内容逐字校验 ✅
  - preview 404 → 只落盘 DESIGN.md、无错误、返回含 `preview 不存在` + `上游缺失` ✅(覆盖 404→上游缺失分类与不阻塞)
  - preview 网络错误(ECONNREFUSED)→ 静默跳过、DESIGN.md 正常落盘 ✅(覆盖网络错误→探测失败分类)
  - overwrite=false 且 DESIGN.md 已存在 → `calls` 0 请求、既有 preview 不被触碰 ✅(覆盖整体跳过语义)
- 用例计数:8(URL/回退)+ 10(read,含 it.each×3)+ 14(download,含新 4)+ 1(工厂)= 33,与报告 33/33 吻合。✅

### 3. 安全 — 通过
- preview 落盘路径 `path.join(targetDir, previewName)`:previewName 为常量(非用户输入),`targetDir` 经 `validateTargetDir` + `isPathWithinWorkspace` 校验(L292-293),无目录穿越面;探测 URL 的 repoPath 亦经 `validateRepoPath`(无 `..`/`/` 前缀/反斜杠)。✅
- 5MB 上限应用于 preview:`probePreview` 走 `fetchFile` buffer 模式,content-length 预检 + 实际字节双查(L195-213),超限抛错 → 分类为 `探测失败`(返回文案含"超限",与代码一致)。✅

### 4. 错误分类 — 基本通过(1 处低危边角)
- 404→`上游缺失`、网络错误/超时/超限→`探测失败` 主路径准确;jsDelivr 404(CDN 缓存未同步)后回退 raw 命中 → `ok:true` 正常落盘,回退兜底可靠;raw 404 为权威缺失证据。用户中止透传验证:catch 中 `name==='AbortError' && signal?.aborted` 才抛 Operation aborted,超时(TimeoutError)不误判为用户中止。✅
- 见问题 #1:分类基于全消息 `includes('404')`,repoPath 含 `404` 段 + 三源网络失败时会误报"上游缺失"。⚠️

### 5. 文档一致性 — 通过
- `docs/dag-workflow.md` L98、`agents/executor.md` L26、`agents/planner.md` L27、`agents/orchestrator.md` L19 均含"自动带上存在的 preview 文件,上游缺失则跳过",与代码主行为一致。✅
- 见问题 #3:文档只提"上游缺失则跳过",未提"探测失败(网络/超时/超限)同样静默跳过",为表述简化,不矛盾。

### 6. 产物与越界检查 — 通过
- `apps/api/dist/pi/designTools.js`:已含 PREVIEW_FILES / probePreview / 各源原因 / preview 清单文案,与源码一致(dist 为 gitignore 目录,索引搜不到,已直接读文件核实)。✅
- `apps/api/dist/pi/agents/{executor,planner}.md` 已含 preview 一句。✅
- 冒烟证据 `.wf-runs/521aca6a/smoke-designs/designs/{mintlify,claude,stripe}/DESIGN.md` 存在且仅 DESIGN.md(与报告"preview 普遍缺失、静默跳过"一致);`apps/` 下无 `.wf-runs/` 残留,临时脚本已清理。✅
- 改动文件均属任务范围,无越界。✅

---

## 二、问题清单(均低严重度,不阻塞)

| # | 级别 | 文件/位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| 1 | 低 | `designTools.ts` L270(`probePreview` 分类) | `message.includes('404')` 是对**整条聚合消息**匹配,而消息含三源 URL 列表(`已尝试 …`);若站点/路径名本身含 `404` 段(如 `design-md/404/DESIGN.md`)且三源均网络失败,URL 列表中的 `404` 会触发误判为"上游缺失"(实际是网络错误)。真实站点名目前无此形态,概率低 | 只对 `各源原因:` 之后的部分匹配,或精确匹配 `HTTP 404` 子串;补一条 path 含 `404` + 网络失败的用例 |
| 2 | 低 | `designTools.test.ts` | 三个分支无直接覆盖:`preview 跳过:(目标已存在,overwrite=false 不覆盖)`(需 DESIGN.md 缺失但 preview 残留的中间态)、preview 超 5MB(与网络错误同走 catch,但可独立断言"探测失败…超限"文案)、preview 探测期间用户中止(透传机制与 read 共享,未在 preview 阶段验证) | 可选补 2-3 条用例;报告已注明超时与网络错误同代码路径,缺口可接受 |
| 3 | 信息(文档) | `docs/dag-workflow.md` L98 及 3 个 agents md | 文档只写"上游缺失则跳过",未说明网络错误/超时/超限时也静默跳过(仅返回说明不同);与代码不矛盾,但"自动带上存在的 preview"可能让读者误以为失败会报错 | 可改为"上游缺失或探测失败则跳过",一行内即可 |
| 4 | 信息 | `designTools.ts` 探测路径整体 | CDN 陈旧缓存 200(已删除文件被缓存)时会落盘陈旧 preview 并列入清单——不误报"缺失",但存在陈旧数据;与 DESIGN.md 同一 CDN 来源、行为一致,raw 兜底此时不触发。任务重点核查项结论:探测路径**不受 jsDelivr 数据 API 过期缓存影响**(用的是 cdn.jsdelivr.net/gh 文件 CDN 而非数据 API),CDN 404-但-raw-有-文件场景由三源回退兜住,无功能性缺陷 | 无需改动;如需更强新鲜度保证可后续为 preview 增加 raw 优先选项 |

---

## 三、最终建议

**通过**。五项改动全部落地且与任务范围一致:preview 探测复用三源回退、失败/缺失静默不阻塞(DESIGN.md 先落盘后探测,顺序正确)、overwrite=false 整体跳过不发请求、5MB 与工作区边界防护完整覆盖 preview、返回清单/缺失/跳过说明齐全;4 个新用例覆盖存在/404/网络错误/整体跳过四条关键路径,既有断言 1→3 变更合理;dist 产物与 4 处文档同步核实无误。4 条问题均低严重度(1 条分类边角、1 条测试缺口、2 条信息级),不阻塞合入,建议后续迭代顺手修复 #1。
