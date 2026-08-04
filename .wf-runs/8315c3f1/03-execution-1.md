# 执行报告:agent skills 读取能力(四来源)

> 依据 `.wf-runs/8315c3f1/02-plan-2.md` 实施,6 个独立提交,纯增量改动。

## 改动文件清单

| 步骤 | 文件 | 改动内容 | 原因 |
| --- | --- | --- | --- |
| 1 | `packages/shared/src/index.ts` | 新增并导出 `SkillInfo`(name/description/filePath/baseDir/source/sourcePath/disableModelInvocation)与 `SkillSource` 五值联合类型 | shared 先 build,api/web 消费 dist |
| 2 | `apps/api/src/config.ts` | `WorkflowsStore` 增加 `skillsDir`;`createStore()` 创建 `.workflows/skills`(与 agentsDir 对称) | 工作台来源目录 |
| 2 | `apps/api/src/config.test.ts`、`apps/api/src/pi/piService.test.ts` | 测试 store 补 `skillsDir` | 编译期强制同步 |
| 3 | `apps/api/src/pi/promptLoader.ts` | **核心**:`createPromptOnlyLoader` 改 options 签名(`PromptOnlyLoaderOptions`);新增 `SkillLoadContext{cwd,skillsDir,homeDir?}`、`loadWorkspaceSkills()`(loadSkills + includeDefaults:true + skillPaths=[skillsDir, homeDir/.agents/skills],**不传 agentDir**,`as Parameters<typeof loadSkills>[0]` 窄化)、`toSkillInfo()`/`classifySkillSource()`(scope=user→pi-agent、project→pi-project、temporary 按路径判断 workspace/global-agents,兜底 path)、`isUnder` 路径工具(win32/darwin 大小写折叠)、`logSkillDiagnostics()`("skill path does not exist" 降噪为 debug,其余 warn);`getSkills()` 返回真实结果,`reload()` 重载 | 四来源加载单一事实源 |
| 4 | `apps/api/src/pi/piService.ts` | 主代理 loader 改 options 调用(带 skills ctx);新增 `listSkills()`(现扫现返回);import 更新 | 端点数据源 + 主代理注入 |
| 5 | `apps/api/src/pi/subAgent.ts` | 子代理 loader 改 options 调用(同一 SkillLoadContext 结构) | 主/子代理 skills 一致 |
| 6 | `apps/api/src/agent/routes.ts` | 新增 `GET /api/agent/workspaces/:id/skills`,返回 `{code:0,message:'ok',data:SkillInfo[]}`;未知工作区 404 | 前端数据源 |
| 7 | `apps/web/src/composables/useAgent.ts` | `skills` ref + `refreshSkills()`(失败静默置空);`openWorkspace()` 与 `refreshRun()` 并行刷新;导出 | 前端状态 |
| 8 | `apps/web/src/components/ChatPane.vue` | `/` 搜索下拉:名称前缀>包含>描述匹配取前 8;方向键循环高亮、Enter 填入 `/skill:<name> ` 不发送、Esc 关闭、`@mousedown.prevent` + blur 关闭、`isComposing` 守卫、流式不弹出、切工作区关闭;下拉项显示来源标签(`全局(pi)`/`项目`/`工作台`/`全局(agents)`/`其他`);textarea 外包 `relative flex-1`,下拉 `absolute bottom-full` | 交互需求 |
| 9 | `apps/api/src/pi/skillsLoader.test.ts`(新增) | 9 条用例:四来源主用例(PI_CODING_AGENT_DIR env stub + homeDir 注入,不触碰真实目录)、扫描根散落 .md(name 回退父目录名)、缺 description 不加载+warning、同名冲突先到先得+collision、目录缺失不抛错+缺失诊断、toSkillInfo 字段完整、disable-model-invocation 透传、`.workflows/agent/skills` 不加载兜底、loader 集成(带/不带 skills 上下文) | 四来源验收 |
| 9 | `apps/web/src/components/ChatPane.test.ts`(新增) | 10 条用例:弹出+来源标签、名称过滤、描述匹配、ArrowDown×2+Enter 填入不发送、Esc、点击选中+blur 关闭、空态、切工作区关闭、流式不弹出、无匹配查询走原逻辑(Enter 发送) | 下拉交互验收 |
| 10 | `README.md` | 新增「Skills」小节:SKILL.md 格式(description 必填、name 回退目录名、disable-model-invocation)、四来源目录表(含 Windows 路径)、`PI_CODING_AGENT_DIR` 重定向、**新增需重开会话**、安全提示(review before use、只读);功能清单与数据存储节、API 表同步 | 文档 |
| 10 | `AGENTS.md` | "绝不读写 `~/.pi/agent`"约定修订为:**只读例外**(skills 来源 `~/.pi/agent/skills` + `~/.agents/skills`),运行数据仍只写 `.workflows/`;新增「Skills(只读来源)」小节(含 `.workflows/agent/skills` 非来源提示) | 约定同步 |

## 关键实现说明(与计划的差异)

- **无代码级偏差**:SDK 事实(agentDir 运行时缺省、`PI_CODING_AGENT_DIR` 覆盖、scope=user/project、显式 path scope=temporary)与计划 §2 逐条核实一致。
- **测试中发现并修正 2 个行为认知**:
  1. SDK 散落 `.md` **只在扫描根**加载(子目录仅递归找 `SKILL.md`)→ 测试用例按真实行为写(无 name 回退父目录名 = 扫描根 basename)。
  2. 前端 watch 依赖 `skillQuery` 时,draft `'' → '/'` 的查询词不变(`slice(1)` 仍为 `''`),watch 不触发 → 改为 watch `draft.value` 本身,打开/关闭逻辑在回调内计算。
- 测试隔离:四来源测试用 `vi.stubEnv('PI_CODING_AGENT_DIR', tmp)` + `ctx.homeDir` 注入,afterEach 清理,全程未触碰真实 `~/.pi/agent`。
- 主/子代理 loader 共用 `SkillLoadContext` 结构,保持一致。

## 自检结果(全部通过)

```bash
pnpm --filter @workflows/shared build   # ✓ tsc 通过
pnpm typecheck                          # ✓ 3/3 packages
pnpm lint                               # ✓ 3/3 packages(eslint,无 error/warning)
pnpm --filter @workflows/api test       # ✓ 11 files / 167 tests
pnpm --filter @workflows/web test       # ✓ 4 files / 25 tests
pnpm build                              # ✓ 3/3(shared/api/web,含 copy-agents.mjs)
```

## 提交历史(每步独立提交)

1. `59631d7` feat(shared): SkillInfo / SkillSource 类型
2. `45f7a10` feat(api): WorkflowsStore 新增 skillsDir
3. `6f48def` feat(api): skills 四来源加载(promptLoader/主代理/子代理)+ listSkills 端点
4. `0fb8cb6` feat(web): useAgent skills 状态 + ChatPane / 搜索下拉
5. `ef76bd4` test: skillsLoader 四来源单测 + ChatPane 下拉交互测试
6. `01417fa` docs: Skills 说明 + AGENTS.md 约定修订

## 未完成项

- 无。计划全部步骤(1–10)与验收标准逐条达成;§4 手动验证清单(需起 `pnpm dev` + 真实四来源目录)留待运行环境人工执行,单测已覆盖等价行为。
