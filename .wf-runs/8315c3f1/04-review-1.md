# 审查报告:agent skills 读取能力(四来源)

> 审查对象:`.wf-runs/8315c3f1/03-execution-1.md` vs 计划 `.wf-runs/8315c3f1/02-plan-2.md`
> 审查方式:逐文件通读改动(9 个源码/测试文件 + 2 个文档)、与 SDK 安装源码(`apps/api/node_modules/@earendil-works/pi-coding-agent/dist`)逐条交叉核实计划中的 SDK 事实、核对 git 提交历史(6 个提交与执行报告一致)。
> 说明:本审查环境无 shell 执行工具,**无法复跑** typecheck/lint/test/build;以下结论基于静态核对 + 执行报告自检结果。所有可静态验证的项均与报告一致,未发现可静态定位的失败项。

## 结论:pass

## 一、SDK 事实核实(计划 §2 的假设,逐条对照安装源码)

| 计划假设 | SDK 源码事实 | 结论 |
| --- | --- | --- |
| `agentDir` 类型必填、运行时缺省 `agentDir ?? getAgentDir()` | `dist/core/skills.js`:`const { agentDir, ... } = options; const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir())`;`dist/core/skills.d.ts` 声明 `agentDir: string`(必填) | 一致 |
| `getAgentDir()` 优先读 `PI_CODING_AGENT_DIR` | `dist/config.js`:`ENV_AGENT_DIR = ${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`(APP_NAME=pi)→ `PI_CODING_AGENT_DIR`;未设置时 `join(homedir(), '.pi', 'agent')`;从包根导出(`index.d.ts`) | 一致 |
| `includeDefaults` 扫 `<agentDir>/skills`(source=user)+ `<cwd>/.pi/skills`(source=project) | `skills.js`:`loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true)` + `resolve(resolvedCwd, CONFIG_DIR_NAME, "skills")`(CONFIG_DIR_NAME=".pi")source="project";`source-info.js` user/project 显式 scope | 一致 |
| 显式 skillPaths source 恒为 "path"、scope=temporary | `skills.js` getSource:includeDefaults=true 时恒返回 "path";`createSyntheticSourceInfo` 缺省 scope="temporary" | 一致 |
| "skill path does not exist" 诊断(缺失目录不抛错) | `skills.js` 精确消息 `{ type: "warning", message: "skill path does not exist" }` | 一致 |
| `LoadSkillsOptions` 未从包根导出 | `index.d.ts` 只导出 `loadSkills`/`LoadSkillsResult`/`Skill`/`LoadSkillsFromDirOptions`,无 `LoadSkillsOptions` → `Parameters<typeof loadSkills>[0]` 窄化断言必要且正确 | 一致 |
| 散落 `.md` 只在扫描根加载 | `skills.js`:子目录递归仅找 `SKILL.md`(includeRootFiles=false) | 一致(执行报告已按此修正测试认知) |

## 二、逐条核对(计划 §6 验收标准)

| # | 计划项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | shared 导出 `SkillInfo`(7 字段)+ `SkillSource` 五值联合 | 通过 | `packages/shared/src/index.ts:75-94`;`dist/index.d.ts` 已重建含两类型(api/web 消费 dist 成立) |
| 2 | `WorkflowsStore.skillsDir` + createStore 建 `.workflows/skills`;测试 store 同步 | 通过 | `config.ts:41,58-59,64`;`config.test.ts:23`、`piService.test.ts:51` 已补;`agentDefs.test.ts` 用 `as never` 无需改(已核实) |
| 3 | `loadWorkspaceSkills`:四来源、不传 agentDir、缺省空、reload 重载、诊断降噪 | 通过 | `promptLoader.ts:44-56`(skillPaths=[skillsDir, home/.agents/skills]、includeDefaults:true、不传 agentDir、`as Parameters<typeof loadSkills>[0]`);`createPromptOnlyLoader` options 化(`:123-151`),缺 skills 返回空、reload 重载;`logSkillDiagnostics`(`:63-71`)对 `'skill path does not exist'` 精确降噪为 debug,其余 warn |
| 4 | 四来源分类正确 + 兜底 path | 通过 | `classifySkillSource`(`:87-99`):scope=user→pi-agent、project→pi-project;temporary 按路径归属 workspace/global-agents,兜底 path;`isUnder`(`:105-114`)含 root 自身、分隔符边界、win32/darwin 大小写折叠 |
| 5 | 主/子代理共用同一 SkillLoadContext | 通过 | `piService.ts:295-298` 与 `subAgent.ts:347-350` 均 `{ cwd: workspace.path, skillsDir: ... }` 同构结构、同一 loader 工厂 |
| 6 | `GET /api/agent/workspaces/:id/skills` 返回 `{code:0,message:'ok',data:SkillInfo[]}`;未知工作区 404 | 通过 | `routes.ts:169-173`(requireWorkspace 404);`piService.ts:664-668` listSkills 现扫现返回 |
| 7 | useAgent `skills` ref + `refreshSkills`;openWorkspace 刷新;失败静默置空;导出 | 通过 | `useAgent.ts:165`、`280`(与 refreshRun 并行)、`585-597`、`716/737` |
| 8 | ChatPane `/` 下拉:前缀>包含>描述、前 8、键盘循环、Enter 填入不发送、Esc/blur/切工作区关闭、流式不弹出、IME 守卫、来源标签 | 通过 | `ChatPane.vue:33-77`(filteredSkills 排序+slice(0,8))、`79-99`(watch draft/streaming/workspaceId 三元打开/关闭)、`137-177`(onKeydown:isComposing 守卫、Arrow 循环、Enter 选中不发送、Esc 关闭)、`191-224`(模板:absolute bottom-full、@mousedown.prevent、来源标签、空态) |
| 9 | 发送 `/skill:<name>` 由 SDK 展开;不存在原样透传 | 通过 | 无需改动(SDK `_expandSkillCommand` 内置);未改 POST /prompt,符合"不做什么" |
| 10 | 四来源验证(skillsLoader.test.ts 主用例) | 通过 | `skillsLoader.test.ts:60-80`:四来源 source 断言 pi-agent/pi-project/workspace/global-agents 全部正确 |
| 11 | 测试隔离:不触碰真实用户目录 | 通过 | `skillsLoader.test.ts:38-46`:`vi.stubEnv('PI_CODING_AGENT_DIR', tmpHome/pi-agent)` + `homeDir: tmpHome` 注入,`afterEach` 恢复 env + rmSync 三个临时目录;全程不 mock、不触真实 `C:\Users\kaijia\.pi\agent` |
| 12 | `.workflows/agent/skills` 不再被加载 | 通过 | 来源清单已移除 + 测试兜底(`skillsLoader.test.ts:150-156`) |
| 13 | 测试覆盖与计划一致 | 通过 | skillsLoader.test.ts 9 条(计划 7+1 可选,全部覆盖,另加 disable-model-invocation 透传);ChatPane.test.ts 10 条(计划 7+1,全部覆盖,另加 blur/无匹配走原逻辑/流式不弹出);config.test.ts/piService.test.ts store 已同步 |
| 14 | 文档/AGENTS.md 同步 | 通过 | README「Skills」小节(四来源表/Windows 路径/PI_CODING_AGENT_DIR/重开会话/review before use/只读);AGENTS.md:20「只读例外」+ :44-49「Skills(只读来源)」(.workflows/agent/skills 非来源提示) |

## 三、与计划的偏差(均已披露,合理)

1. **ChatPane watch 实现**(`ChatPane.vue:79-99`):计划写 watch(skillQuery),实施改为 watch([draft, streaming, activeWorkspaceId])。原因(执行报告已说明):draft `'' → '/'` 时 skillQuery 不变(slice(1) 仍为 ''),watch 不触发。行为等价且更稳,方向正确。
2. **测试用例贴合 SDK 真实行为**(散落 `.md` 只在扫描根):`skillsLoader.test.ts:82-93` 按真实行为断言(无 name 回退 = 扫描根 basename)。合理。
3. **提交历史**:6 个提交(59631d7→01417fa)与执行报告逐一对应,无遗漏。

## 四、问题清单(均为非阻断性观察,不影响 pass)

| # | 文件/位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1 | 计划 §4 手动验证清单 | 四来源手动验证(需 pnpm dev + 真实 `~/.pi/agent` 等)未执行,执行报告"未完成项:无"的表述略超前(其正文已注明留待人工执行) | 在运行环境执行手动清单后再闭环;单测已覆盖等价行为 |
| 2 | `skillsLoader.test.ts:111-120` | "skill path does not exist" 诊断的**降噪为 debug** 未被直接断言(仅断言诊断存在;计划中该断言为可选"可单独断言") | 可加 `vi.spyOn(console, 'debug')` 断言降噪路径,属可选增强 |
| 3 | `AGENTS.md:40` | 测试文件清单("api: app.test.ts;web: App.test.ts、useAgent.test.ts")未列入新增的 skillsLoader.test.ts / ChatPane.test.ts | 顺手补一行,保持约定文档准确 |
| 4 | `useAgent.ts` removeWorkspace | 移除激活工作区后 `skills` 保留旧值(直到下次 openWorkspace 才刷新) | 无实际影响(textarea 在无工作区时禁用,下拉不会弹出);如需彻底可在 removeWorkspace 置空 |
| 5 | 验证命令 | 本审查环境无 shell,无法复跑 typecheck/lint/test/build | 执行报告自检(shared build/typecheck/lint/api 11 文件 167 测试/web 4 文件 25 测试/build)与静态核对一致,未见矛盾;建议 CI 或本地再跑一次全量确认 |

## 五、最终建议:**通过**

- 计划 1–10 全部步骤与 12+ 条验收标准逐条达成,无遗漏步骤、无实质性偏离;
- 四来源加载逻辑、agentDir 缺省行为、`~` 展开、source 分类均与 SDK 源码事实一致(本节开头逐条核实);
- 主/子代理共用同一 SkillLoadContext 结构;前端下拉交互完全符合计划描述;测试隔离有效(env 重定向 + homeDir 注入,不触碰真实目录);
- 问题清单 5 项均为非阻断性观察,不构成打回理由。
