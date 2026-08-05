# 复审报告:6 项遗留问题修复(run a68540af)

> 审查对象:`.wf-runs/09f3129e/04-review-1.md` 问题清单 1-6 vs `a68540af/03-execution-1.md` 声称的修复。
> 方法:逐文件阅读 9 个改动文件(routes.ts / mcpRoutes.test.ts / mcpTools.ts / mcpTools.test.ts / index.ts / shared/src/index.ts / McpPanel.vue / README.md / docs/mcp.md)+ 交叉核对两个调用点(piService.ts / subAgent.ts)与既有测试。无 shell 环境,typecheck/lint/test 数字以报告为准,用测试计数算术 + 代码证据佐证。

## 结论:pass

6 项问题全部按建议修复,修复本身未引入新问题;测试计数与基线算术自洽(255 + 3 = 258);冒烟未执行项如实申报,覆盖矩阵逐项可核实。

---

## 一、逐项核对

| # | 问题 | 状态 | 核对说明 |
| --- | --- | --- | --- |
| 1 | 路由校验绕过 | **通过** | `routes.ts:96-101` PUT 处理器 `args: raw?.args as string[] \| undefined`、`enabled: raw?.enabled as boolean \| undefined` 透传原始值(仅类型断言,无运行时收窄),注释明确「由存储层 validateMcpServers 统一校验」。`mcpConfig.ts:61-63` 校验:非数组 args → 「args 必须是字符串数组」、非布尔 enabled → 「enabled 必须是布尔值」,`saveMcpServers` 先全量校验后 `writeMcpConfig`,失败零写入。新增 2 用例非空壳:`mcpRoutes.test.ts:186-213`,断言 400 + 中文文案 + `existsSync(mcpConfigPath) === false`(零写入实锤)。既有 8 个用例全部保留未改。UI 发送方(useAgent.ts saveMcpServer)恒发数组/布尔,无回归 |
| 2 | 文档声明过度 | **通过** | README L43(数据存储条目)与 L124-125(安全模型)两处均加限定「**仅当工作区不包含 `.workflows` 目录时成立**」+ 穿透场景说明(bash/write/edit 均可写)+ 信任模型(agent 与 OS 用户同权限,护栏防误操作而非防恶意,与 config.json 同一既有局限)。docs/mcp.md §6.1(L83-90)同样限定 + 标注「非本次引入」。两处表述一致、准确,未再出现绝对命题 |
| 3 | 串行连接并行化 | **通过** | `mcpTools.ts:479-497`:`Promise.allSettled(enabled servers → buildServerTools)`;`buildServerTools`(L491-510)内部 try/catch `manager.listTools`,失败 warn + 返回 `[]`,隔离语义保持;allSettled 兜底吞掉任何意外 rejection。返回顺序经 `flatMap` 保持输入序(与原串行序一致,无工具序回归)。单 server 失败时 manager 状态落 error(listTools catch 已置)。两个调用点 `piService.ts:275` 与 `subAgent.ts:358-359` 均 `await createMcpTools(...)`,同时受益。单 server 隔离测试(mcpTools.test.ts:481-499)仍有效(并行下 A 失败 B 正常注册) |
| 4 | connecting 态 | **通过** | 共享类型 `packages/shared/src/index.ts:100-102` `state: 'disabled' \| 'connecting' \| 'connected' \| 'error'`;`mcpTools.ts:335` McpEntry.state 为子集 `'connected' \| 'connecting' \| 'error'`,类型兼容;`ensureEntry`(L449-456)初始 `'connecting'`;`McpPanel.vue:35-50` 显式 `case 'connecting'` → 「连接中…」/ `text-mute`(default 分支仍为「未启用」,disabled 语义不受影响)。status() 各阶段语义:连接前(未 ensureEntry,不在 status 内,前端由配置推导)→ 连接中 'connecting' → 成功 'connected' → 失败 'error'(listTools catch 置)。新增用例(mcpTools.test.ts:432-451)用挂起 connect promise 实测两态转换,非空壳。全仓仅 McpPanel.vue 消费该联合类型,无遗漏分支 |
| 5 | SIGINT 兜底超时 | **通过** | `index.ts:19-33`:dispose 挂 5s `setTimeout` → warn + `process.exit(0)`,`timer.unref?.()`;`cleanup.finally` 中 `clearTimeout(timer)` + `process.exit(0)`。成功/失败两分支(dispose resolve 或 reject → .catch 已吞)→ 均收敛到 finally 的 clearTimeout + exit(0)。无双重 exit:两路径 exit code 相同(0),竞态下先到者胜,无副作用;无计时器泄漏(finally 必 clearTimeout,计时器触发则进程已退出)。unref 后若 dispose 挂起但 loop 无句柄,进程自然退出(等价兜底)。`process.once` 使二次信号走默认处理器,可接受。index.ts 无任何测试引用(信号处理器不在测试中执行) |
| 6 | 冒烟补验 | **通过** | 如实申报:缺 DeepSeek key + 浏览器,4 项 LLM 会话级/UI 级冒烟明确标注「待人工补验」,未造假。覆盖矩阵逐项核实:**注册命名/清洗/跳过**(mcpTools.test.ts 过滤与命名 3 组用例 ✅)、**子代理 tools/activeNames 恰一次**(subAgent.test.ts:177-204,4 角色 × 2 用例 ✅)、**连接缓存只 connect 一次**(mcpTools.test.ts 「连续两次 createMcpTools」✅)、**只读排除无单测**(如实申报 ✅,双点代码 `workspace.readOnly ? [] :` 已在 piService.ts:274-275 / subAgent.ts:358-359 复核)、**UI composable 4 用例 + init 静默**(useAgent.test.ts:314-363 ✅)、**McpPanel.vue 无组件测试**(如实申报 ✅)。API 级实机冒烟 5 项(400 端到端 / 真实 stdio 往返 / SIGINT 退出 / 护栏拦截)与代码逻辑一致,可信 |

---

## 二、抽查结论

- **测试计数自洽**:上轮基线 255 passed / 10 failed(mcpRoutes 8 + mcpTools 39 + web 34 等);本轮 258 = 255 + 3(路由 2 + connecting 1),10 个失败集合与上轮逐项一致(workspaceGuard×8 + runManager×1 + agentDefs×1),且本轮改动文件均不在这三个测试文件范围内,「无新增失败」声明与算术和文件证据吻合。web 34 不变(本轮无 web 测试改动,McpPanel.vue 无组件测试)。
- **typecheck/lint/build 全绿声明**:无法独立重跑(无 shell),但类型层面已人工复核——shared 联合类型扩展与 McpEntry 子集、McpPanel switch 分支、routes 断言转换均类型相容,声明无矛盾。
- **范围外改动**:9 个改动文件均属 6 项问题范畴,未发现夹带改动;安全模型未削弱——问题 1 修复反而收紧了「校验失败零写入」承诺,文档限定后声明不再过度。

## 三、问题清单(均非阻塞,供参考)

1. `apps/api/src/agent/routes.ts:99-100` — 透传后 `args: null` / `enabled: null` 也会被校验层 400(此前被静默归一为 undefined 接受)。属预期收紧,内置 UI 恒发数组/布尔不受影响;若担心第三方客户端,可在 README 校验语义处补一句「null 视为非法」。
2. `apps/api/src/index.ts:27,32` — 强制超时路径与优雅路径 exit code 均为 0;若需运维可区分(如超时路径 exit 1),纯风格问题。
3. `apps/api/src/agent/routes.ts:69-79` mcpOverview 对「已启用但从未连接」的 server 推导为 `'error'`(文案「尚未连接…」)——沿用既有行为,与问题 4 无关;后续若引入 connecting 推导态可再议,不阻塞。

## 四、最终建议

**通过(Pass)**。6 项问题全部正确修复,测试真实有效,文档准确,无新增失败、无范围外改动、无安全模型破坏。上述 3 条为可选打磨项。冒烟 2-6 的 LLM 会话级/UI 级验证仍建议在具备 dev 环境后补一轮(与上轮建议一致,非本次阻塞)。
