# 执行报告:workflows MCP server 配置支持 env 字段

> 依据:.wf-runs/6238693e/02-plan-1.md 逐条实施,范围严格按计划(未做 McpPanel.vue 输入框、未展开 process.env、未加 cwd/timeoutMs)。
> 日期:2026-02-XX

## 改动文件清单

### 代码(5 处)

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `packages/shared/src/index.ts` | `McpServerConfig` 在 `enabled?: boolean` 后追加 `env?: Record<string, string>`,带 JSDoc(传给 MCP server 子进程的环境变量,SDK 与白名单合并,同键覆盖) | 类型层打通,api/web 消费方类型安全 |
| `apps/api/src/mcpConfig.ts` | `validateMcpServers` 在 enabled 校验后追加 env 校验:undefined 放行;null/非对象/数组/值非字符串 → 抛中文错误 `MCP server「${name}」的 env 必须是字符串键值对对象(值必须为字符串)` | 非法 env 校验失败零写入,与 args/enabled 同路径同风格 |
| `apps/api/src/agent/routes.ts` | PUT 路由:`readJson` 泛型加 `env?: unknown`;server 组装对象加 `env: raw?.env as Record<string, string> \| undefined`(注释同步更新为 args/enabled/env 三字段透传) | 透传原始值,校验由存储层统一做;env 可落盘保留 |
| `apps/api/src/pi/mcpTools.ts` | `connect()` 的 `StdioClientTransport` 构造参数追加 `env: this.config.env`,附保守语义注释(不展开 process.env;undefined 时 SDK no-op,行为与现状一致) | 功能缺失根因修复;testMcpServer 走同一 StdioMcpConnection 自动生效 |
| `apps/web/src/composables/useAgent.ts` | `saveMcpServer` PUT body 追加 `env: server.env`(裸透传,非 `?? {}`;undefined 时 JSON.stringify 自动省略该键) | 防 toggleEnabled 等 spread 保存把手写 env 抹掉,且磁盘不写出 `"env": {}` |

### 测试(3 个文件)

| 文件 | 新增用例 | 断言 |
| --- | --- | --- |
| `apps/api/src/mcpConfig.test.ts` | 正向:`env 合法对象:存取往返一致,磁盘保留 env`;负向追加进「校验失败零写入」it.each 5 条:env 非对象(字符串)/ 为数组 / 为 null / 值非字符串 / 值为布尔 | 正向:load 往返 toEqual + 磁盘 JSON env 保留;负向:`/MCP server/` 抛错 + 文件内容未变 |
| `apps/api/src/agent/mcpRoutes.test.ts` | 4 条:PATCH 前插入「PUT 新增:env 透传落盘并返回」「PUT env 非对象(字符串)→ 400 且 mcp.json 未变」「PUT env 值非字符串 → 400 且 mcp.json 未变」「PUT 覆盖不带 env → env 被清空(字段级替换语义)」 | 200 响应与磁盘 mcp.json 均含 env;400 时 message 含 env 文案且磁盘字节不变;覆盖后 env undefined |
| `apps/api/src/pi/mcpTools.test.ts` | 新增 `ENV_SERVER_SCRIPT` 常量(env 工具回传自身 `MCP_TEST_ENV`/`MCP_ABSENT_KEY`);真实 stdio 集成用例「env 注入:config.env 传入子进程;白名单外父进程变量不透传」 | `conn.callTool('env')` 文本含 `"MCP_TEST_ENV":"injected"` 与 `"MCP_ABSENT_KEY":null`;try/finally 恢复父进程 env |

### 文档(可选项,已做)

| 文件 | 改动内容 |
| --- | --- |
| `docs/mcp.md` | §1 配置面改为 `name / command / args / enabled / env`(移除"无 env"表述);§5 写校验行补 env;§6 安全模型第 2 条补「env 仅取配置显式声明值(与 SDK 白名单合并),不继承完整父进程环境」 |

## 自检结果

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| shared 重建(改类型后立即执行) | `pnpm --filter @workflows/shared build` | ✅ tsc 零错误 |
| api 测试(定向 + 全量;vitest 实跑全量 14 文件) | `pnpm --filter @workflows/api test -- src/mcpConfig.test.ts src/agent/mcpRoutes.test.ts src/pi/mcpTools.test.ts` | ✅ **14 files passed, 278 tests passed, 1 skipped**,零失败(既有用例零回归,含新 env 用例) |
| api 类型检查 | `pnpm --filter @workflows/api typecheck` | ✅ tsc --noEmit 零错误 |
| web 类型检查 | `pnpm --filter @workflows/web typecheck` | ✅ vue-tsc -b 零错误 |
| api lint | `pnpm --filter @workflows/api lint` | ✅ eslint 零问题 |
| web lint(useAgent.ts 改动) | `pnpm --filter @workflows/web lint` | ✅ eslint 零问题 |

## 验收标准核对(对应计划 §7)

- [x] A1 shared `McpServerConfig` 含 `env?: Record<string, string>` + JSDoc
- [x] A2 mcpConfig 非法 env 抛中文错误、零写入
- [x] A3 routes PUT env 落盘保留;非法 → 400 零写入
- [x] A4 mcpTools `StdioClientTransport` 含 `env: this.config.env`
- [x] A5 useAgent PUT body 含 `env: server.env`(裸透传)
- [x] T1 mcpConfig.test.ts 正向 1 + 负向 5 全绿
- [x] T2 mcpRoutes.test.ts PUT env 落盘 + 非法 400 零写入 + 覆盖清空语义 4 条全绿
- [x] T3 mcpTools.test.ts 真实 stdio env 注入集成用例全绿(注入生效 + 白名单外不透传)
- [x] V1 api 全量测试零回归
- [x] V2 api/web typecheck 零错误
- [x] D1 docs/mcp.md 三处同步
- [x] S1 范围控制:McpPanel.vue 未加 env 输入框;未展开 process.env;未引入 cwd/timeoutMs

## 未完成项

无。全部计划项(含可选文档项)已完成;真实 stdio 集成测试方案一次成功,无需降级为 mock 捕获。
