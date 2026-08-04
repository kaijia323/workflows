# 审查报告:P1~P4(anysearch 下沉 + design 工具 + 注册 + 提示词/文档)

> 审查对象:计划 `.wf-runs/80fa4852/02-plan-3.md` vs 执行 `.wf-runs/80fa4852/03-execution-2.md`
> 审查方式:逐文件读源码 + 单测 + 提示词/文档 + dist 产物核对(本环境无 shell,未重跑测试/构建,见"验证"节)

## 结论:pass

---

## 一、逐条核对结果

### P1:anysearch-search 注册到子代理 — 通过
- `subAgent.ts`:导入 `createAnySearchTools`(L23 附近);`buildSubAgentTools` options 新增可选 `getAnySearchApiKey`;fff 工具之后 `tools.push(...createAnySearchTools({ getApiKey: getAnySearchApiKey }))`;`activeNames` 含 `'anysearch-search'`;`runSubAgent` 调用处传入 `getAnySearchApiKey: () => loadConfig(store).anySearchApiKey ?? undefined` — 全部与计划一致。
- 测试:`subAgent.test.ts` 新增 describe,`it.each` 4 角色(explorer/planner/executor/reviewer)断言 tools 与 activeNames 均含 `anysearch-search` 恰一次;无 write 白名单角色同样注册。✅

### P2:design 工具实现 + 单测 — 通过
- **schema 与草案 D1 一致**:单工具 `design` + `action: read|download` 枚举 + 可选 `path`/`dir`/`overwrite`(`designTools.ts` L55-76);工厂 `createDesignTools` 返回单元素数组(L317-319)。
- **三源回退**:`fetchFile`(L158-221)顺序 jsDelivr@main → raw@main → raw@master,首次 2xx 即停;非 2xx/网络异常/超时记录后继续;全失败聚合错误含尝试 URL 列表 + 404("检查路径/站点名")/403/429(限流指引)文案;`AbortSignal.any([AbortSignal.timeout(20_000), signal])`;用户中止唯一透传 `Operation aborted`。✅
- **read 语义**:默认 `README.md`;返回"来源: url(bytes 字节)"+ 正文,整体 50KB 字节安全截断(`truncateOutput` L224-241,含代理对保护,标记 `[50KB limit reached]`);路径校验(L113-119)拒绝 `/` 开头、反斜杠、`..` 段。✅
- **download 语义与护栏**:只读拒绝 → repoPath 校验 → 默认 `designs/<site>`(README.md 拒绝,site 为空拒绝)→ `validateTargetDir`(L122-129,`isPathWithinWorkspace` 边界拦截)→ overwrite 默认 false → content-length 预检(L199-202)+ 实际字节双查 5MB 硬上限 → mkdir/writeFile → 返回仅路径+字节数,正文不进上下文。✅
- **安全**:请求仅 `User-Agent: workflows-agent`,无 Authorization 头;`GITHUB_TOKEN` 在源码中只出现在注释,无读取/发送;全程无 api.github.com 域名。✅
- **测试**:`designTools.test.ts` 29 用例,覆盖回退顺序(500/网络异常/403/429/三源全败/env `DESIGN_CDN_BASE`/options.cdnBase 优先)、read(来源头/50KB 截断英文与中文无乱码/非法 path 3 例/404/用户中止×2/超时回退)、download(落盘+自动建目录+输出不含正文/默认目录推导/自定义 dir/README 拒绝/`..` 逃逸/只读/overwrite false-true/超 5MB 两路/404 不落盘)、工厂形态。**非 happy-path-only**,负路径覆盖充分。✅

### P3:design 注册到所有代理 — 通过
- `piService.ts` L259-275:`designTools`/`designToolNames` 创建;`guardedTools` 只读/读写两分支均含 `...designTools`;`activeTools` 两分支均含 `...designToolNames`(SDK allowedToolNames 白名单同步)。✅
- `subAgent.ts`:anysearch 之后 `tools.push(...createDesignTools({ workspace }))`;`activeNames` 含 `'design'`。✅
- 测试:`subAgent.test.ts` 4 角色 `design` 恰一次断言 + executor/explorer 差异仅限写工具(bash/edit/write)、design/anysearch/read/ls 一致的对比用例。✅

### P4:提示词与文档 — 通过
- `orchestrator.md` L19:design 一行;L31-33:调度策略第 8 条"设计挑选类需求"完整链路(explorer 读 README 判断→候选→planner 计划→闸门→executor download→reviewer→complete_task,驳回回 planner),未覆盖第 3 条 wait_for_approval 规则。✅
- `explorer.md` L24+:"外部设计库调研"小节,README 即目录、不枚举目录/文件树、50KB 截断说明、anysearch 补充、报告要求(站点名/风格要点/匹配度/推荐 Top N + 可信度声明)。✅
- `planner.md` L25+ / `executor.md` L24+:下载计划与执行小节,与代码行为一致(默认 `designs/<站点>/`、校验方式、只读被拒提示)。✅
- `docs/dag-workflow.md` L89-97:§4 子代理工具集补充(anysearch-search + design 注册点、download 五重护栏)+ §4.1 外部抓取约定(jsDelivr→raw→master、20s 超时、GITHUB_TOKEN 不读取、50KB/5MB、jsDelivr 缓存延迟)。与实现一致。✅

### 验证(报告自检结果)
- typecheck/lint/test/build 的"通过"结论**无法在本环境重跑**(无 shell),但:报告数字内部自洽(153 基线 + designTools 29 + subAgent 9 = 191,与源码用例逐一计数吻合);测试代码形态有效(vitest 默认发现 `*.test.ts`);dist 同步**已直接读文件核实**:`dist/pi/designTools.js` 存在且为编译产物、`dist/pi/subAgent.js` 与 `dist/pi/piService.js` 均 import `createDesignTools`、`dist/pi/agents/orchestrator.md`/`explorer.md` 含新小节。✅

### 越界改动检查
- 改动文件均属计划范围:subAgent.ts / piService.ts / designTools.ts(+test) / subAgent.test.ts / 4 个 agents md / docs/dag-workflow.md。`config.ts` 的 `plannerMaxRetries` 为计划 §0.1 记载的既有改动。无 list 动作、无 fetch-url/download-url 工具、无 shared/前端改动(受限于无 git,未能以 diff 全量核验,但源码审读未发现越界痕迹)。✅

---

## 二、问题清单(均低严重度,不阻塞)

| # | 级别 | 文件/位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| 1 | 低 | `designTools.ts` L113-119(`validateRepoPath`) | 未拒绝以 `/` 结尾的 path:`path='design-md/claude/'` 时 `site='claude'`、`basename='claude'`,会落盘为无扩展名文件 `designs/claude/claude`(仍在工作区内,无逃逸风险,但产物语义异常) | `validateRepoPath` 拒绝空段或结尾 `/`(如 `repoPath.endsWith('/')` 或 `.split('/').some(s => s === '')` 报错),并补一条单测 |
| 2 | 低 | `designTools.ts` L195 / L203 | read 先 `res.text()` 全量入内存再截断;download 在 `arrayBuffer()` 后才做实际字节上限检查(content-length 预检仅在有头时生效)。超大文件(如 100MB+)会先完整缓冲再处理 | 如需更强健壮性,read/download 改流式读取并中途 abort;当前固定小仓库文件场景可接受,与计划实现一致 |
| 3 | 低(文档) | `orchestrator.md` L19 | `design` 被列在"可用子代理"清单中,但它与 wait_for_approval 一样是工具而非子代理,条目语义易混淆 | 计划明确要求此放置,非偏离;如后续优化可改为单独"内置工具"小节 |
| 4 | 信息 | 计划 Phase 5 | 端到端手动验证未执行(任务范围限定 P1~P4,执行报告已声明);jsDelivr 失效 → fallback raw 已由 `DESIGN_CDN_BASE`/options 注入在单测侧确定性覆盖 | 建议后续单独执行 Phase 5(含驳回/只读/真实抓取),并确认全程无 api.github.com 请求 |

---

## 三、最终建议

**通过**。P1~P4 四项全部完成且与计划一致:注册点、schema、三源回退、护栏(read 50KB / download 5MB / 边界 / 只读 / overwrite)、提示词与文档、dist 同步均核实无误;测试 38 个新增用例覆盖关键路径与负路径。3 条低严重度问题(尾斜杠 path、全量缓冲、文档语义)不影响功能与安全,建议后续迭代顺手修复;Phase 5 端到端验证留待单独执行。
