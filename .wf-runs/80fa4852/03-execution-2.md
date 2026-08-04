# 执行报告 v2:P1~P4(anysearch 下沉 + design 工具 + 注册 + 提示词/文档)

> 依据实施计划 `.wf-runs/80fa4852/02-plan-3.md`(v3)。范围:P1~P4,共 4 个阶段,全部完成。
> Phase 5(端到端手动验证,含 dev 冒烟)不在本次任务范围(任务说明限定 P1~P4 代码改动 + 提示词/文档更新),见"未完成项"。

## 一、改动文件清单

### P1:anysearch-search 注册到子代理
| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/subAgent.ts` | ① 导入 `createAnySearchTools`;`WorkflowsStore` 导入改为混合导入并加 `loadConfig`;② `buildSubAgentTools` options 新增可选 `getAnySearchApiKey?: () => string | undefined`;③ fff 工具之后追加 `tools.push(...createAnySearchTools({ getApiKey: getAnySearchApiKey }))`;④ `activeNames` 追加 `'anysearch-search'`;⑤ `runSubAgent` 调用处传入 `getAnySearchApiKey: () => loadConfig(store).anySearchApiKey ?? undefined` | 4 个子代理获得联网能力,key 解析(env > config)逻辑复用 anySearchTools 内部;独立 AgentSession 注册表,无去重问题 |

### P2:design 工具实现 + 单测(新文件,本阶段未注册)
| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/designTools.ts`(新增) | 常量 `DESIGN_OWNER=VoltAgent` / `DESIGN_REPO=awesome-design-md` / `DESIGN_BRANCH=main` / `FALLBACK_BRANCH=master` / `MAX_OUTPUT_BYTES=50KB` / `MAX_DOWNLOAD_BYTES=5MB` / `ATTEMPT_TIMEOUT_MS=20s`;schema 仅 `action: read|download` + 可选 `path`/`dir`/`overwrite`;helper:`sourceUrls`(jsDelivr@main → raw@main → raw@master 三源,path 逐段 encodeURIComponent)、`fetchFile`(首次 2xx 即停、`AbortSignal.any([timeout, signal])`、`redirect: 'follow'`、`User-Agent: workflows-agent`、不发送 Authorization、聚合错误含尝试列表 + 404/403/429 可读指引、用户中止唯一透传 `Operation aborted`)、`truncateOutput`(从 anySearchTools 复制的字节安全二分截断,含代理对保护)、`validateRepoPath`(拒绝 `/` 开头/反斜杠/`..` 段)、`validateTargetDir`(resolve 后 `isPathWithinWorkspace`);execute 按 action 分派:read(默认 README.md,来源头 + 正文整体 50KB 截断进上下文)、download(只读拒绝 → 路径校验 → 默认 `designs/<site>` → 边界校验 → existsSync/overwrite 检查 → fetchFile(buffer,content-length 预检 + 实际字节双查 ≤5MB)→ mkdir/writeFile → 仅返回路径与字节数,正文不进上下文);工厂 `createDesignTools(opts)` 返回单元素数组;`cdnBase` 解析优先级 `options.cdnBase > env DESIGN_CDN_BASE > https://cdn.jsdelivr.net/gh` | 内置基础设施工具,内部封装 http 不暴露任意 fetch-url;完全不走 GitHub API(无 60 次/小时限流、不读 GITHUB_TOKEN);`DESIGN_CDN_BASE` 为端到端 fallback 验证钩子 |
| `apps/api/src/pi/designTools.test.ts`(新增) | 29 个用例:URL 构造与三源回退(jsDelivr 500/网络异常 → raw 成功、三源全败聚合错误、403/429 限流指引、`DESIGN_CDN_BASE` env 覆盖、options.cdnBase 优先)、read(来源头+正文、50KB 截断英文/中文无乱码、非法 path 3 例、404 提示、用户中止透传、超时回退下一源)、download(落盘+自动建父目录+输出不含正文、默认目录推导、自定义 dir、README.md 拒绝、`..` 逃逸边界拦截、只读拒绝、overwrite 默认 false/true 覆盖、content-length 与实字节超 5MB 拒绝、404 不落盘)、工厂形态(name/label=design) | 确定性覆盖 jsDelivr 失效 → fallback raw 的同一路径(端到端靠 `DESIGN_CDN_BASE` 钩子);mock fetch 记录所有尝试(含抛出/悬挂),便于断言回退顺序 |

### P3:design 注册到所有代理
| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/piService.ts` | 导入 `createDesignTools`;`openSession` 内 webTools 之后:`const designTools = createDesignTools({ workspace })` + `designToolNames`;`guardedTools` 只读/读写两分支均追加 `...designTools`;`activeTools` 两分支均追加 `...designToolNames` | 主代理两分支注册,与 webTools/wait_for_approval 并列;SDK allowedToolNames 过滤 customTools,白名单必须同步 |
| `apps/api/src/pi/subAgent.ts` | 导入 `createDesignTools`;anysearch 之后追加 `tools.push(...createDesignTools({ workspace }))`;`activeNames` 追加 `'design'` | 子代理注册点,与 anysearch-search 并列 |
| `apps/api/src/pi/subAgent.test.ts` | 新增 describe:`it.each` 4 角色(explorer/planner/executor/reviewer)断言 tools 与 activeNames 均含 `anysearch-search` 恰一次、含 `design` 恰一次;executor 与 explorer 差异仅限写工具(bash/edit/write),anysearch/design/read/ls 一致 | 固化 tools/activeNames 同步与"download 不受 write 白名单影响"决策(D4) |

### P4:提示词与文档(全部追加,未改既有约束)
| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/agents/orchestrator.md` | "可用子代理"清单追加 design 一行;调度策略追加第 8 条"设计挑选类需求"完整链路(explorer 读 README 判断→候选→planner 下载计划→闸门→executor download→reviewer→complete_task,驳回回 planner) | 流程被编排出来;不覆盖第 3 条 wait_for_approval 规则 |
| `apps/api/src/pi/agents/explorer.md` | 追加"外部设计库调研"小节:先 read README.md(相当于目录)、不要枚举目录/文件树、read 候选 DESIGN.md 精读(50KB 截断)、外部补充信息用 anysearch-search、报告要求(站点名/风格要点/匹配度/推荐 Top N + 可信度声明) | README 即目录;判断场景而非列目录 |
| `apps/api/src/pi/agents/planner.md` | 追加"下载类计划"小节:计划须写明选中站点、落盘路径(默认 designs/<站点>/)、文件清单(DESIGN.md)、校验方式;下载由 executor 批准后执行 | 下载计划约定 |
| `apps/api/src/pi/agents/executor.md` | 追加"下载外部文件"小节:design download 参数用法、校验(存在/字节数/可读)写进执行报告、只读工作区被拒提示切换读写 | 下载执行约定 |
| `docs/dag-workflow.md` | §4 追加"子代理工具集补充"(anysearch-search 与 design 注册到所有子代理,design download 不受 write 白名单约束但受五重护栏)+ 注册点说明;新增 §4.1"外部抓取约定"(jsDelivr 优先→raw 兜底→master 兜底、20s 超时、GITHUB_TOKEN 不读取、read 50KB/download 5MB、jsDelivr 分钟级缓存延迟说明) | 权威语义文档与实现对齐 |

## 二、自检结果

| 检查 | 结果 |
| --- | --- |
| `pnpm --filter @workflows/api typecheck`(tsc --noEmit) | ✅ 通过,零错误 |
| `pnpm --filter @workflows/api lint`(eslint) | ✅ 通过,零告警 |
| `pnpm --filter @workflows/api test`(vitest run) | ✅ **11 个测试文件 / 191 个测试全部通过**(较上轮基线 153 新增 38 个:designTools.test.ts 29 + subAgent.test.ts 9) |
| `pnpm --filter @workflows/api build`(tsc + copy-agents.mjs) | ✅ 构建成功;`dist/pi/agents/*.md` 已含全部新小节(explorer/planner/executor/orchestrator 均 grep 命中),`dist/pi/designTools.js` 已生成 |

## 三、关键实现决策(与计划对齐)

- **三源抓取**:`https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}` → `raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}` → `master` 分支兜底;首次 2xx 即停;单次 20s 超时(三源最坏 60s);同一源不重试。
- **无 GitHub API**:不调 api.github.com、不读不发送 GITHUB_TOKEN(请求头断言无 Authorization);`GITHUB_TOKEN` 仅在文档中保留为 env 配置项说明。
- **read 截断**:来源头 + 正文**整体** 50KB 字节安全截断(含头,保证输出总量 ≤50KB;中文多字节/代理对不切半),内容进上下文。
- **download 护栏**:只读拒绝 → 仓库路径校验 → 默认 `designs/<site>`(README.md 非可下载设计,拒绝)→ 工作区边界(isPathWithinWorkspace)→ overwrite 默认 false → content-length 预检 + 实际字节双查 5MB 硬上限(超限拒绝不静默截断)→ 落盘后仅返回相对路径与字节数(正文不进上下文)。
- **无 list 动作**、无 fetch-url/download-url 通用工具、无 shared 类型/前端/闸门机制改动。

## 四、未完成项与原因

1. **Phase 5(端到端手动验证)** 未执行:任务说明限定本次范围为 P1~P4(代码改动 + 提示词/文档更新);端到端冒烟(dev 会话、闸门交互、真实 jsDelivr/raw 抓取、驳回/只读分支)需运行环境与人工操作,留待后续单独执行。单测侧已用 `DESIGN_CDN_BASE`/options 注入确定性覆盖了 jsDelivr 失效 → fallback raw 的同一路径。
2. `apps/api/src/config.ts` 的 `plannerMaxRetries` 改动为计划 §0.1 中已完成的既有改动(不属于本次范围),git diff 中可见但非本次实施;未触碰。
