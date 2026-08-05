# 代码审查报告:MCP 配置模态窗新增 env 字段编辑

> 审查对象:计划 `.wf-runs/daca693f/02-plan-1.md`(验收 A1–A9)、探索 `.wf-runs/daca693f/01-exploration-1.md`、执行报告 `.wf-runs/daca693f/03-execution-1.md`
> 审查范围:`apps/web/src/components/McpPanel.vue`、`apps/web/src/components/McpPanel.test.ts`(新增)、`apps/web/src/composables/useAgent.test.ts`(补强)

## 结论:pass

---

## 一、验收清单逐条核对

| 项 | 状态 | 说明 |
|---|---|---|
| **A1** env textarea 位置/属性/样式 | ✅ 通过 | McpPanel.vue 模板 args 输入框之后、`mt-3 flex items-center justify-between` 提交行之前;`rows="3"`、`spellcheck="false"`;placeholder 含「每行一个 KEY=VALUE」「按第一个 = 切分」;class 与现有输入框逐字一致(`mt-2 w-full resize-y rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary`) |
| **A2** parseEnvText / envSummary 语义 | ✅ 通过 | L13–29 按第一个 `=` 切分(`indexOf`)、key trim、value 原样保留、空行 trim 后跳过;L32–34 `envSummary` 存在。详见下方边界专项核对 |
| **A3** 非法行拦截 + 错误清除 | ✅ 通过 | L116–119:`parsed.error` 时写 `envError` 并 return,不发起请求;文案含行号(`第 ${i+1} 行`)、「缺少「=」」与格式示例;textarea `@input="envError = null"` 一改即消 |
| **A4** handleAdd 透传 / 空 env → undefined / 清空 / handleTest | ✅ 通过 | 保存对象 `{ name, command, args, enabled: false, env }`;`Object.keys(parsed.env).length > 0 ? parsed.env : undefined`(L127–128);成功后清空 4 个输入(L130–133);`void handleTest(name)` 自动测试逻辑保留 |
| **A5** toggleEnabled 零改动 + 列表 env 摘要 | ✅ 通过 | `toggleEnabled` 仍为 `{ ...server, enabled: ... }` spread(L105–107),配合 useAgent.ts L237 `env: server.env` 透传,env 不被抹掉;列表 command 行下新增 `env: ` 行,`v-if="server.env && Object.keys(server.env).length > 0"`、`truncate` + `:title="envSummary(server.env)"` |
| **A6** McpPanel.test.ts 6 用例 | ✅ 通过 | 6 用例全部落实且为真实断言(详见第二节);mock 模式(`Partial<AgentStore>` + `as unknown as AgentStore` + mount + flushPromises + 全 vi.fn stub)与 WorkspacePickerModal.test.ts / ChatPane.test.ts 惯例一致 |
| **A7** useAgent.test.ts 补强 | ✅ 通过 | PUT stub 回写 `env: body.env`;新增「透传 env(含空格与 = 的值)」「无 env 时请求体省略该键」两用例。第二用例经 `JSON.parse(String(init?.body))` 实际解析请求体,真实覆盖 JSON.stringify 省略行为(若实现误传 `null` 会被 `toBeUndefined` 拦下) |
| **A8** 测试/类型全绿 | ✅ 通过(受限) | 执行报告称 5 files / 42 tests 全绿 + `vue-tsc -b` 通过;本审查环境无 shell 工具无法独立重跑,已对 6+2 新用例逐一静态推演(元素定位、事件链、断言语义均成立),与报告一致 |
| **A9** 未改动清单 | ✅ 通过(受限) | McpPanel.vue 为唯一生产改动;packages/shared 的 `McpServerConfig.env?: Record<string,string>`(index.ts L88)、useAgent.ts L223–237 env 透传、mcpConfig.ts L62–65 后端 env 校验均与探索基线一致,未见改动痕迹(无 git 工具,未能 diff 复核) |

## 二、parseEnvText 边界专项核对(按计划语义「按第一个 = 切分,key trim 后非空才合法」)

| 输入 | 行为 | 符合计划 |
|---|---|---|
| 空行 / 全空白行 | `trim()` 后 `''` → continue | ✅ |
| `\r\n` 行尾 | `split('\n')` 后行尾残留 `\r`,`trim()` 吞掉 | ✅(计划风险表已声明) |
| 值含空格 `GREETING=hello world` | 第一个 `=` 后原样保留 `hello world` | ✅ |
| 值含 `=` `URL=https://x?a=1` | `indexOf('=')` 取首个,value 保留 `https://x?a=1` | ✅ |
| `=xxx` 行 | 整行 trim 后 `eq === 0`,`eq <= 0` 命中 → 报错拦截 | ✅(语义上判非法,与「key trim 后非空」一致) |
| 无 `=` 行 `BADLINE` | `eq === -1` → 报错,含行号与原文 | ✅ |
| 超长 key | 无长度限制,key 非空即接受 | ✅(计划明确不做 key 格式/长度校验,与后端现状对齐) |
| `KEY = value` | key trim 为 `KEY`,value 保留前导空格 | ✅(计划「key trim、值原样保留」) |
| 重复 key | 后者覆盖前者 | 计划未规定,可接受 |

## 三、问题清单(均非阻断,不构成 fail)

1. **McpPanel.vue L116–119(handleAdd env 校验提前 return)** — 低优先级 UX 瑕疵:校验失败 return 发生在 `error.value = null` / `saved.value = false` 重置之前。若上次保存成功,此时「已保存到 mcp.json」绿色提示会与 env 红色错误同屏。与计划指定代码逐字一致(计划即此顺序),属计划内取舍;建议后续在 return 前补 `saved.value = false`。
2. **McpPanel.vue L23 错误文案** — `=xxx`(以 `=` 开头)行实际是「空 key」而非「缺少 =」,与无 `=` 行共用「缺少「=」」文案,提示略不准确。行为正确(均拦截),建议文案区分「第 N 行缺少 KEY(以 = 开头则 key 为空)」。
3. **测试覆盖缺口(计划内已声明的除外,不追责)** — `\r\n` 行尾、`=xxx` 行、重复 key 未直接断言(前两者与已验证路径同分支);toggleEnabled 保留 env 无组件级用例(计划明确「不覆盖 toggle 的保留」,useAgent 层已保证)。如后续要补,可在用例 2 中追加 `A=1\r\nB=2` 输入。
4. **审查环境限制** — 无 shell 工具,`pnpm test` / `pnpm typecheck` 未能独立重跑(A8/A9 的 git 层面复核受限),以上基于执行报告自证 + 逐行静态推演,两者一致。

## 四、其他检查(无异常)

- 无未使用变量/导入(McpPanel.vue 与两个测试文件逐一核对);`testMcpServer`/`deleteMcpServer` 的 stub 均为必要(保存成功后 `handleTest` 会调用)。
- 测试元素定位可靠:表单中唯一 textarea;`fillBasic` 取 `findAll('input')[0]/[1]`,而带 server 列表的用例 1 不调用 `fillBasic`,无 checkbox 干扰。
- 用例 3 `objectContaining({ env: undefined })` 是真实断言:Vitest objectContaining 先查 key 存在性再比 undefined,实现若漏传 env 键会失败。
- 样式/文案与仓库既有范式一致(纯 Tailwind v4 语义色、中文错误文案对齐后端 400 风格)。
- 空 env 转 undefined → useAgent `JSON.stringify` 省略键不写盘「env: {}」的链路在组件层(用例 3)+ composable 层(useAgent 用例 B)双层覆盖,成立。

## 五、最终建议

**通过**。实现与计划零偏差,验收 A1–A9 全部满足;问题清单 1–3 为可选打磨项,建议(非必须)在后续迭代处理。
