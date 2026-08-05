# 审查报告:workflows MCP server 配置支持 env 字段

> 审查对象:`.wf-runs/6238693e/02-plan-1.md` / `03-execution-1.md` + 实际代码
> 审查方式:逐文件核对源码 + 对照 SDK 安装源码验证语义

## 结论:pass

全部 9 处计划改动(5 代码 + 3 测试 + 1 文档)与计划逐条吻合,SDK 语义理解正确,
保守方案贯彻,范围控制严格,未发现阻断性问题。

---

## 逐条核对结果

### 代码(5 处)

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 1. shared `McpServerConfig.env?: Record<string, string>` + JSDoc | ✅ 通过 | `packages/shared/src/index.ts` McpServerConfig `enabled` 之后追加 env 字段,JSDoc 与计划一致;`dist/index.d.ts` 已重建包含新字段(api/web 消费 dist,重建正确) |
| 2. mcpConfig.ts env 校验 | ✅ 通过 | `validateMcpServers`(mcpConfig.ts:60-63):undefined 放行;`typeof !== 'object'` / null / Array.isArray / 值非字符串四类非法形态全拦截,错误文案与计划逐字一致 `MCP server「${name}」的 env 必须是字符串键值对对象(值必须为字符串)`,中文风格与 args/enabled 同款;经 saveMcpServers/upsertMcpServer 路径零写入 |
| 3. routes.ts PUT env 透传 | ✅ 通过 | `readJson<{ command?; args?; enabled?; env? }>` 泛型已加 env;组装对象含 `env: raw?.env as Record<string, string> | undefined`;注释同步更新为 args/enabled/env 三字段 |
| 4. mcpTools.ts connect() 注入 env | ✅ 通过 | `StdioClientTransport({ command, args, stderr: 'pipe', env: this.config.env })`,保守注释到位;**未展开 process.env**;`testMcpServer` 走同一 StdioMcpConnection 自动生效 |
| 5. useAgent.ts PUT body env 裸透传 | ✅ 通过 | `env: server.env`(非 `?? {}`),注释说明 undefined 时 JSON.stringify 省略该键;toggleEnabled 的 `{ ...server, enabled }` spread 携带 env,链路闭合 |

### SDK 语义独立验证(重点项)

- 直接核对安装的 `@modelcontextprotocol/sdk@1.30.0` `dist/esm/client/stdio.js` `start()`:
  `env: { ...getDefaultEnvironment(), ...this._serverParams.env }` —— 计划声称的白名单合并语义**属实**;
  非 Win 白名单为 HOME/LOGNAME/PATH/SHELL/TERM/USER;`env: undefined` 时展开为 no-op,未配 env 行为与改动前逐字节一致
- 保守方案贯彻:全仓仅此一处 `StdioClientTransport` 构造,无任何 `{ ...process.env, ...config.env }` 写法

### 测试(3 文件)

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 6. mcpConfig.test.ts | ✅ 通过 | 正向 1 条(往返一致 + 磁盘保留 env);负向 5 条(字符串/数组/null/值非字符串/布尔)全部挂进「校验失败零写入」it.each,断言 `/MCP server/` 抛错 + 文件字节未变,结构与计划一致 |
| 7. mcpRoutes.test.ts | ✅ 通过 | 4 条:PUT env 落盘(响应 + 磁盘 toMatchObject 均含 env);env 非对象 400 零写入(字节级 before/after);env 值非字符串 400 零写入;覆盖不带 env → 字段级清空语义(记录行为,与 args 同构) |
| 8. mcpTools.test.ts | ✅ 通过 | 真实 stdio 集成(非 mock):ENV_SERVER_SCRIPT 子进程回传自身 env;断言 `"MCP_TEST_ENV":"injected"` 注入生效 + 父进程设置的白名单外变量 `"MCP_ABSENT_KEY":null` 不透传——**真实锁定保守语义**,将来若改成全量 process.env 此用例变红;try/finally 恢复父进程 env,无串扰 |

### 文档

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 9. docs/mcp.md | ✅ 通过 | §1 配置面改为 `name / command / args / enabled / env`(移除"无 env");§5 写校验行补 env;§6 安全模型第 2 条补「env 仅取配置显式声明值(与 SDK 白名单合并),不继承完整父进程环境」 |

### 数据链路完整性

- 手写 mcp.json → `loadMcpServers`(原样透传,零过滤)→ `createMcpTools` → `manager.listTools/callTool` 均传完整 server 对象 → `StdioMcpConnection(config)` → `env: this.config.env` ✅(piService.ts:274 确认真实传参,无重构丢字段)
- PUT 保存保留 env;非法 400 零写入 ✅
- 前端 toggleEnabled spread 不丢 env ✅

### 范围控制

- McpPanel.vue:**零 env 引用**,未加输入框 ✅
- 未展开 process.env ✅;未引入 cwd/timeoutMs/每工具 enable ✅
- GET /status 语义未动;upsertMcpServer/removeMcpServer/loadMcpServers 未动 ✅

### 类型安全

- shared 源码与 dist 均含 env 字段;useAgent.ts/routes.ts/mcpTools.ts 均消费新类型;执行报告称 api/web typecheck 与 lint 全零错误(本环境无 bash 无法复跑,代码层面未见类型问题)

---

## 问题清单(均为非阻断性观察,无需返工)

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1 | `apps/api/src/mcpConfig.ts:60-63` | 校验对"非纯对象"的边界:如 `new Date()` 类对象(typeof 'object'、非 null、非数组、Object.values 为空)会放行;但 mcp.json 与 PUT body 均经 JSON 解析,JSON 无法表达此类值,实际不可达 | 无需处理;若将来接非 JSON 输入源,可加 `Object.getPrototypeOf(s.env) === Object.prototype` 收窄(可选) |
| 2 | `apps/api/src/pi/mcpTools.test.ts` env 集成用例 | `MCP_ABSENT_KEY` 断言依赖 SDK 白名单不含该键——当前 1.30.0 成立(含 Win 白名单 13 项也不含);若 SDK 升级白名单变更,该用例可能误红 | 计划已列为低风险(SDK `^1.30.0` 已锁);升级 SDK 时留意即可 |
| 3 | `03-execution-1.md` 日期 | 报告日期为占位符 `2026-02-XX` | 记录惯例问题,不影响代码;建议执行报告写实际日期 |
| 4 | 验证复跑 | 278 tests / typecheck / lint 结果来自执行报告,本环境无 shell 工具无法独立复跑 | 关键用例(mcpTools 真实 spawn 集成)与既有 ECHO_SERVER_SCRIPT 同模式,CI 可行性有先例背书,风险低 |

## 最终建议:**通过**

改动严格按计划执行,SDK env 合并语义经源码核实无误,保守方案(不展开 process.env)与集成测试锁定一致,
校验/存储/连接/前端四层链路完整闭合,测试负向边界覆盖到位,范围零越界。可合入。
