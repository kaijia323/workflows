# 审查报告:design 工具 preview 探测逻辑回退

> 审查对象:任务说明「改动范围」 vs 执行报告 `.wf-runs/521aca6a/03-execution-2.md`(基准:`.wf-runs/521aca6a/04-review-1.md` 通过后的代码)
> 审查方式:逐文件直接读取 `apps/api/src/pi/designTools.ts` / `designTools.test.ts` / 4 处文档 / `apps/api/dist/pi/designTools.js` 与 3 份 dist agents md(dist 为 gitignore 目录,索引 grep 不覆盖,已直接读文件逐段核实)+ 冒烟产物目录核对;测试数字与源码用例逐一计数比对

## 结论:pass

---

## 一、逐条核对结果

### 1. 回退是否干净(designTools.ts)— 通过
- `PREVIEW_FILES` 常量、`PreviewProbe` 接口、`probePreview()` helper 全部删除:全文件 grep `probe|PREVIEW|Preview`(忽略大小写)零命中。✅
- download 分支无 preview 探测/下载循环、无 preview「目标已存在跳过」分支;返回格式恢复单行 `已下载 ${data.bytes} 字节到 ${relPath}(来源:${url})`(executeDesign download 末尾),无 preview 字段/清单/说明。✅
- 无死代码、无半残留逻辑:模块注释、schema download action 描述、工具 description 均无 preview 句。✅
- `apps/api/src` 与 `docs` 全量 grep `preview`(忽略大小写)零命中。✅
- dist 产物同步核实:直接读 `apps/api/dist/pi/designTools.js` 全文,与源码逐段一致(无 preview、单行返回、各源原因保留);dist 三份 agents md(executor/planner/orchestrator)与 src 一致(planner「文件清单(DESIGN.md)」、orchestrator design 行无 preview)。✅
- 冒烟产物 `.wf-runs/521aca6a/smoke-designs/designs/{claude,mintlify,stripe}/` 均仅含 DESIGN.md,无 preview.html / preview-dark.html。✅
- 临时冒烟脚本已清理(`apps/api/src` 无 tmp 残留)。✅

### 2. 护栏未受损 — 通过
- **三源回退**:`sourceUrls` 仍返回 jsDelivr@main → raw@main → raw@master 三源,首次 2xx 即停(`fetchFile` 循环结构未变)。✅
- **5MB 硬上限**:content-length 预检 + 实际字节双查仍在(与 review-1 时同位置),超限抛错拒绝落盘。✅
- **工作区边界**:`validateTargetDir` → `isPathWithinWorkspace` 拦截不变。✅
- **只读检查**:`opts.workspace.readOnly` 早退、不发请求,不变。✅
- **overwrite=false 整体跳过**:`existsSync(target) && !overwrite` 在任何 fetch 之前 return;回退后仅针对 DESIGN.md,语义与「只下载 DESIGN.md」一致。✅
- **Operation aborted 唯一透传**:`abortIfSignaled` + `fetchFile` catch 中 `name==='AbortError' && signal?.aborted` 判断 + executeDesign 外层 catch 重新抛,全部保留;超时(TimeoutError)不误判。✅

### 3. fetchFile「各源原因」增强保留后正确性 — 通过
- 聚合错误格式:`文件获取失败:已尝试 <三源 URL 列表>;各源原因:<per-source>;请检查路径/站点名是否与 README 一致,或稍后重试(+限流指引)`,层次清晰、可读性好。✅
- 不影响既有错误处理:错误仍统一走 executeDesign catch → toolError,无 preview 分类逻辑依赖该文案(404 分类仅存在于测试断言)。✅
- 既有测试不受影响:三源全失败、404、403/429 用例均用 `toContain` 断言,与增强格式兼容;回退后无 probePreview 使用该消息做 includes('404') 分类,review-1 的问题 #1 随 probePreview 删除而消失。✅

### 4. 测试(designTools.test.ts)— 通过
- 用例计数逐一核对:URL/回退 8 + read 10(含 it.each×3)+ download 10 + 工厂 1 = **29**,与报告 29/29 吻合。✅
- 4 个 preview 用例(存在三文件落盘 / 404 只落盘 DESIGN.md / 网络错误静默跳过 / overwrite=false 整体跳过含 preview)已删,无 preview 相关断言残留。✅
- overwrite 用例 `c3` 断言恢复为 1:overwrite=true 时 mock 全 200 → 仅 DESIGN.md 1 次请求(首源 2xx 即停),无 preview 探测,断言 1 合理;注释已恢复为「DESIGN.md 1 次,首源 2xx 即停」。✅
- 其余断言与回退后行为一致:下载成功用例断言单行格式 `已下载 X 字节到 designs/claude/DESIGN.md` + `来源:` + 不含文件正文;只读/边界/5MB/404 用例均断言 `calls` 0 或 1,与无 preview 探测一致。✅

### 5. 文档(4 处)— 通过
- `docs/dag-workflow.md`:§4.1(L90 工具描述、L98 download 行为)无 preview 句,「自动带上存在的 preview 文件」已删。✅
- `apps/api/src/pi/agents/executor.md`:下载小节无 preview 句,仅保留 download 落盘/校验/只读提示。✅
- `apps/api/src/pi/agents/planner.md`:恢复「文件清单(DESIGN.md)」。✅
- `apps/api/src/pi/agents/orchestrator.md`:design 工具行无 preview 句。✅
- dist 三份 md 与 src 同步核实无误。✅

### 6. 产物与越界检查 — 通过
- 改动文件均属任务范围(1 源码 + 1 测试 + 4 文档),无越界;`apps/` 下无 `.wf-runs/` 残留,临时脚本已删。✅
- 产物目录内无 `02-plan-*.md`(与执行报告说明一致,本任务按任务说明直接实施),以任务说明改动范围为核对基准。✅

---

## 二、问题清单(均低严重度,不阻塞)

| # | 级别 | 文件/位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| 1 | 低 | `designTools.test.ts` 三源全失败用例 | 「各源原因:」增强文案无直接断言覆盖(用例仅断言 URL 列表与「检查路径/站点名」提示,未断言 `各源原因:` 子串);功能正确,属测试覆盖缺口 | 可选在该用例补一行 `expect(result.text).toContain('各源原因:')` |
| 2 | 信息 | `docs/dag-workflow.md` L90 | 工具描述未提及「各源原因」错误可读性增强,与实现不冲突,纯表述差异 | 无需改动;如愿意可一句话带过 |

---

## 三、最终建议

**通过**。回退干净彻底(src/dist/docs 三处 preview 零残留,dist 经直接读取核实而非依赖索引 grep);download 语义恢复为「只下载 DESIGN.md」单行返回,无半残留逻辑与死代码;全部护栏(三源回退、5MB 双查、工作区边界、只读、overwrite=false、Operation aborted 透传)原样保留;「各源原因」增强独立保留且不与既有错误处理/测试冲突;29 用例计数吻合、overwrite 断言 1 合理;4 处文档与 dist 同步恢复。2 条问题均低严重度(1 条断言覆盖缺口、1 条信息级),不阻塞合入。
