# 实施计划:workflows MCP server 配置支持 env 字段

> 依据:.wf-runs/6238693e/01-exploration-1.md(调研结论已逐一对照源码复核,行号以复核时为准)
> 性质:只读规划,不修改代码。SDK 语义已确认:`@modelcontextprotocol/sdk@1.30.0` `dist/esm/client/stdio.js:67-73`
> spawn 时 `env: { ...getDefaultEnvironment(), ...this._serverParams.env }` —— env 与白名单
> (非 Win:`HOME/LOGNAME/PATH/SHELL/TERM/USER`)合并,直接传 `config.env` 即可,不会导致子进程缺 PATH/HOME。
> 重要前置:`@workflows/shared` 以 `dist/index.d.ts` 被 api/web 消费(见 packages/shared/package.json
> `exports.types → ./dist/index.d.ts`),**改 shared 源码后必须先重建 shared 才能过 api/web typecheck**。

---

## 1. 目标与范围

### 做什么

让 MCP server 配置支持 `env` 字段,全链路(类型 → 校验 → 存储透传 → 连接注入 → 前端防抹掉)打通:

1. `packages/shared/src/index.ts`:`McpServerConfig` 增加 `env?: Record<string, string>`
2. `apps/api/src/mcpConfig.ts`:`validateMcpServers` 增加 env 校验(undefined 或字符串键值对对象,非法抛中文错误)
3. `apps/api/src/agent/routes.ts`:PUT 路由组装字段时透传 env(与现有 args/enabled 透传同模式)
4. `apps/api/src/pi/mcpTools.ts`:`connect()` 构造 `StdioClientTransport` 时传 `env: this.config.env`
   (保守方案:只传 config.env,不展开 process.env;`testMcpServer` 走同一 `StdioMcpConnection`,自动生效)
5. `apps/web/src/composables/useAgent.ts`:PUT 请求体加 env(防 toggleEnabled 等前端操作把手写 env 抹掉)
6. 测试:三个后端测试文件补充 env 正向/负向用例(见 §4)
7. (可选,低成本)docs/mcp.md 同步 env 字段说明

### 不做什么(控制范围)

- **McpPanel.vue 不加 env 输入框**:用户手动编辑 `~/.workflows/mcp.json` 即可(loadMcpServers 原样透传,后端修复后即生效)
- **不展开 `{ ...process.env, ...config.env }`**:保守方案不改变子进程 env 继承面(现状:子进程只有 SDK 白名单 6 项);
  若将来需要全量继承,是单独的产品/安全决策,且集成测试会锁定当前语义
- 不加 `cwd` / `timeoutMs` / 每工具级 enable(超出本任务)
- 不改 GET /status 语义(env 随 servers 原样返回是既有 passthrough 行为,不新增逻辑)
- 不改 `upsertMcpServer` / `removeMcpServer` / `loadMcpServers`(它们天然透传整个对象)

---

## 2. 实施步骤(按依赖顺序)

### 步骤 1:shared 类型层

**文件:`packages/shared/src/index.ts`(McpServerConfig,第 80-92 行)**

在 `enabled?: boolean` 之后追加:

```ts
/** 传给 MCP server 子进程的环境变量(键值均为字符串);SDK 与白名单(HOME/PATH/SHELL 等)合并后传入,同键覆盖白名单 */
env?: Record<string, string>
```

**预期结果**:api/web 类型层面支持 env;不影响其他字段。改完**立即重建**:
`pnpm --filter @workflows/shared build`(api/web 消费 dist 类型与产物,不重建则后续 typecheck/测试看不到新字段)。

### 步骤 2:存储层校验 + mcpConfig.test.ts

**文件:`apps/api/src/mcpConfig.ts`(`validateMcpServers`,第 48-62 行)**

在现有 `enabled` 校验之后追加(仿 args 模式,只校验结构,不逐键收窄):

```ts
if (
  s.env !== undefined &&
  (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env) || Object.values(s.env).some((v) => typeof v !== 'string'))
) {
  throw new Error(`MCP server「${s.name}」的 env 必须是字符串键值对对象(值必须为字符串)`)
}
```

要点:JSON.parse 来源的键必为字符串(符号键 JSON 无法表达,无需特判);`typeof null === 'object'` 需显式排除 null;数组也是 object 需排除。

**预期结果**:`saveMcpServers` / `upsertMcpServer` 对非法 env 抛中文错误且零写入(与 args/enabled 同路径)。

### 步骤 3:PUT 路由透传 + mcpRoutes.test.ts

**文件:`apps/api/src/agent/routes.ts`(PUT handler,第 91-101 行)**

两处改动:
1. 第 93 行 `readJson` 泛型加 env:
   `readJson<{ command?: unknown; args?: unknown; enabled?: unknown; env?: unknown }>(c)`
2. server 组装对象加 env 透传(保持现有注释风格「透传原始值,由存储层统一校验」):

```ts
env: raw?.env as Record<string, string> | undefined,
```

**预期结果**:PUT 带 env 时落盘保留;env 非法时存储层校验抛错 → 路由 400 零写入(与 args/enabled 完全同模式)。GET 经 `mcpOverview` 原样返回 env,无需改动。

### 步骤 4:连接层注入 env + mcpTools.test.ts

**文件:`apps/api/src/pi/mcpTools.ts`(`connect()`,第 225-229 行)**

`StdioClientTransport` 构造参数追加一行(保守方案):

```ts
const transport = new StdioClientTransport({
  command: this.config.command,
  args: this.config.args ?? [],
  stderr: 'pipe',
  // 保守语义:只传 config.env,不展开 process.env;SDK 内部与白名单(HOME/PATH/...)合并,
  // undefined 时展开为 no-op,行为与现状(仅白名单)一致
  env: this.config.env,
})
```

**预期结果**:`connect()` 与 `testMcpServer()`(走同一 `StdioMcpConnection`)均把 config.env 注入子进程;未配 env 的 server 行为与现状逐字节一致。

### 步骤 5:前端 PUT body 带 env

**文件:`apps/web/src/composables/useAgent.ts`(`saveMcpServer`,第 223-233 行)**

请求体追加一行:

```ts
body: JSON.stringify({
  name: server.name,
  command: server.command,
  args: server.args ?? [],
  enabled: server.enabled ?? false,
  // 透传 env:有值保留(防 toggleEnabled 等 spread 保存把手写 env 抹掉);
  // undefined 时 JSON.stringify 自动省略该键,磁盘不写出 "env": {}
  env: server.env,
}),
```

说明:选 `env: server.env`(而非 `?? {}`)是为了避免 UI 每次保存都在 mcp.json 写出 `"env": {}`
(与代码库「enabled 缺省不补写」的磁盘最小 diff 哲学一致);env 存在时随 GET 原样回前端,
toggleEnabled 的 `{ ...server, enabled }` spread 会携带 env,PUT 再透传,链路闭合。

### 步骤 6:(可选)文档

**文件:`docs/mcp.md`**

- 第 16 行(§1 v1 范围):「配置面:最小四字段 `name / command / args / enabled`;无每工具级 enable、无 `env`/`cwd`/`timeoutMs` 字段」
  →「配置面:`name / command / args / enabled / env`;无每工具级 enable、无 `cwd`/`timeoutMs` 字段」
- §5 表格「写校验」行:`(名 / 重名 / command / args / enabled)` → `(名 / 重名 / command / args / enabled / env)`
- §6 安全模型第 2 条(spawn 不经 shell):补一句「`env` 仅取配置显式声明值(与 SDK 白名单合并),不继承完整父进程环境」;
  env 由用户显式配置,与命令同属信任模型

---

## 3. 步骤间依赖

```
步骤 1(shared 类型)+ 重建 shared
  ├─▶ 步骤 2(mcpConfig 校验)← 编译依赖 shared 类型
  ├─▶ 步骤 3(routes 透传)   ← 依赖步骤 2 的校验兜底
  ├─▶ 步骤 4(mcpTools 注入) ← 依赖步骤 1 类型
  └─▶ 步骤 5(useAgent)      ← 依赖步骤 1 类型
步骤 6(文档)独立,可最后做
```

测试用例随对应步骤同批编写(步骤 2/3/4 各带自己的测试文件改动),全部改完统一跑验证(§5)。

---

## 4. 测试用例清单

### 4.1 `apps/api/src/mcpConfig.test.ts`

**新增正向用例**(放「saveMcpServers 存取往返」describe,第 86-91 行附近):

| 用例 | 断言 |
| --- | --- |
| `env 合法对象:存取往返一致,磁盘保留 env` | `saveMcpServers(store, [{ name: 'browser', command: 'npx', env: { DISPLAY: ':0', XAUTHORITY: '/tmp/x' } }])` → `loadMcpServers` toEqual 一致;`JSON.parse(diskContent(store)).mcpServers[0].env` toEqual 原对象 |

**新增负向用例**(追加进「校验失败零写入」it.each,第 96-108 行;each 已断言 `/MCP server/` 抛错 + 文件内容未变):

| label | bad 值 |
| --- | --- |
| `env 非对象(字符串)` | `{ ...validServer, env: 'x' }` |
| `env 为数组` | `{ ...validServer, env: ['A=1'] }` |
| `env 为 null` | `{ ...validServer, env: null }` |
| `env 值非字符串` | `{ ...validServer, env: { A: 1 } }` |
| `env 值为布尔` | `{ ...validServer, env: { A: true } }` |

错误文案 `MCP server「echo」的 env 必须是字符串键值对对象(值必须为字符串)` 匹配既有 `/MCP server/` 断言,无需改 it.each 结构。

### 4.2 `apps/api/src/agent/mcpRoutes.test.ts`

参考现有「PUT 新增」(第 85-101 行)与 400 系列结构,新增:

| 用例 | 请求 | 断言 |
| --- | --- | --- |
| `PUT 新增:env 透传落盘并返回` | body `{ command: 'node', args: ['-e','x'], enabled: true, env: { DISPLAY: ':0' } }` | 200 / code 0;`data.servers[0]` toMatchObject 含 `env: { DISPLAY: ':0' }`;`diskServers(store)` toMatchObject 含 env |
| `PUT env 非对象(字符串)→ 400 且 mcp.json 未变` | body `env: 'x'`(先写合法数据) | 400;message 含 `env`;`readFileSync(mcpConfigPath)` 与 before 相同(零写入) |
| `PUT env 值非字符串 → 400 且 mcp.json 未变` | body `env: { A: 1 }` | 同上 |
| (可选,记录语义)`PUT 覆盖不带 env → env 被清空(字段级替换语义)` | 先 PUT 带 env,再 PUT 不带 env | 第二次响应 `servers[0].env` 为 undefined;磁盘无 env(与既有 args 覆盖清空用例同构,记录行为而非缺陷——前端修复后总是携带 env) |

### 4.3 `apps/api/src/pi/mcpTools.test.ts`(真实 stdio 集成,首选方案)

不改 `serverConfig()` helper(第 25 行 `Partial<McpServerConfig>` spread 已天然支持 env)。

**新增脚本常量**(放在 `ECHO_SERVER_SCRIPT` 旁,独立常量避免触碰既有 `toEqual(['echo'])` 断言):

```ts
/** 最小 stdio MCP server:env 工具回传自身环境变量(验证 env 注入) */
const ENV_SERVER_SCRIPT = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'env-server', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'env', description: 'echo env', inputSchema: { type: 'object', properties: {} } }]
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'env') throw new McpError(ErrorCode.MethodNotFound, 'Unknown tool: ' + req.params.name);
  return { content: [{ type: 'text', text: JSON.stringify({
    MCP_TEST_ENV: process.env.MCP_TEST_ENV ?? null,
    MCP_ABSENT_KEY: process.env.MCP_ABSENT_KEY ?? null,
  }) }] };
});
await server.connect(new StdioServerTransport());
`
```

**新增集成用例**(放「真实 stdio 集成」describe 末尾):

```ts
it('env 注入:config.env 传入子进程;白名单外父进程变量不透传(保守语义锁定)', async () => {
  // 父进程显式设置但不在 SDK 白名单:保守语义下不得到达子进程(若将来改成 {...process.env, ...config.env} 此断言变红)
  const prev = process.env.MCP_ABSENT_KEY
  process.env.MCP_ABSENT_KEY = 'should-not-leak'
  const conn = new StdioMcpConnection(
    serverConfig('env', { args: ['-e', ENV_SERVER_SCRIPT], env: { MCP_TEST_ENV: 'injected' } }),
  )
  try {
    await conn.connect()
    const result = await conn.callTool('env', {})
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toContain('"MCP_TEST_ENV":"injected"')
    expect(text).toContain('"MCP_ABSENT_KEY":null')
  } finally {
    await conn.close()
    if (prev === undefined) delete process.env.MCP_ABSENT_KEY
    else process.env.MCP_ABSENT_KEY = prev
  }
})
```

选型说明:
- **首选真实 stdio 集成**:项目已有成熟先例(ECHO_SERVER_SCRIPT),成本低、最贴近真实链路(从 config → spawn → 子进程 env),且能同时锁定「白名单 + config.env」的保守语义(父进程设置 `MCP_ABSENT_KEY` → 子进程必须为 null),防止将来被改成全量 process.env 而不知。
- **降级方案**(若集成测试在 CI 环境出现不稳定,如 spawn 权限问题):对 `@modelcontextprotocol/sdk/client/stdio.js` 用 `vi.doMock` + 动态 `import` 捕获 `new StdioClientTransport(params)` 的构造参数,断言 `params.env` toEqual `{ MCP_TEST_ENV: 'injected' }`。注意:vi.mock 是文件级 hoisted,不能按 describe 隔离;`vi.doMock` 需配合动态 import,且会影响同文件其他用例的模块解析——**仅作降级,不优先**。

---

## 5. 验证命令

```bash
# 0. 改完 shared 后必须先重建(api/web 消费 dist 类型与产物)
pnpm --filter @workflows/shared build

# 1. 定向跑三个受影响测试文件(vitest run 接受位置参数过滤;-- 让 pnpm 透传)
pnpm --filter @workflows/api test -- src/mcpConfig.test.ts src/agent/mcpRoutes.test.ts src/pi/mcpTools.test.ts

# 2. api 全量回归(防其他测试受 env 字段影响,如 GET 响应多出 env 字段的 toMatchObject 兼容性)
pnpm --filter @workflows/api test

# 3. 类型检查
pnpm --filter @workflows/api typecheck
pnpm --filter @workflows/web typecheck   # useAgent.ts 改动;vue-tsc -b
```

---

## 6. 风险与回滚

### 风险点

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| **shared 构建产物陈旧**:api/web 解析到 dist 类型,不改 shared 源码后不重建 → typecheck 报「env 不存在」 | 高(流程性) | 步骤 1 明确要求先 `pnpm --filter @workflows/shared build` 再继续 |
| **PUT 字段级替换抹掉 env**:前端若持有不含 env 的陈旧 server 对象并保存,env 被清空(与 args 现状同构) | 中 | 所有变更路径均 `refreshMcp()` 拉最新;env 随 GET 原样返回;步骤 5 保证有 env 时透传;routes 测试记录该语义 |
| **env 值类型限制**:手写 JSON 写数值(`{ "PORT": 8080 }`)被 400 拒绝 | 低 | 设计如此(SDK `Record<string,string>` 约束);错误文案中文明确,文档可提示写字符串 |
| **保守语义 vs 依赖父进程变量的 MCP server**:子进程只有白名单 + 用户 env | 低 | 这是**现状行为**(当前连 env 都没有,仅白名单 6 项),本次不扩大不缩小继承面;需要时用户可在 env 显式配置 |
| **集成测试改 process.env 串扰其他测试** | 低 | vitest 文件级隔离 + try/finally 恢复原值 |
| **SDK 升级改变 env 合并语义** | 低 | `^1.30.0` 已锁;集成测试 `MCP_ABSENT_KEY` 断言兜底 |
| **GET 响应新增 env 字段影响前端既有断言/渲染** | 低 | 前端类型即来源 shared,加字段非破坏;routes 测试用 toMatchObject 不敏感 |

### 回滚方案

- 改动为 5 个文件的纯增量小改动、无数据迁移;`git revert` 单 commit 即可整体回退。
- 已写盘带 env 的 mcp.json:回滚后 env 字段被存储层原样保留但连接层不再使用(loadMcpServers 原样透传、不报错),数据无破坏;删除字段即完全复原。
- 运行时行为兜底:env 非法时校验拒绝写入,不产生半截配置;连接失败仅影响该 server(单 server 隔离)。

---

## 7. 验收标准(逐条核对)

- [ ] **A1** `packages/shared/src/index.ts`:`McpServerConfig` 含 `env?: Record<string, string>` 及用途 JSDoc
- [ ] **A2** `apps/api/src/mcpConfig.ts`:非法 env(非对象/数组/null/值非字符串)抛中文错误 `MCP server「…」的 env 必须是字符串键值对对象(值必须为字符串)`,且零写入
- [ ] **A3** `apps/api/src/agent/routes.ts`:PUT 请求体 env 落盘保留;env 非法 → 400 且 mcp.json 未变
- [ ] **A4** `apps/api/src/pi/mcpTools.ts`:`StdioClientTransport` 构造含 `env: this.config.env`;未配 env 的 server 行为与改动前一致
- [ ] **A5** `apps/web/src/composables/useAgent.ts`:PUT body 含 `env: server.env`(undefined 时 JSON.stringify 省略)
- [ ] **T1** mcpConfig.test.ts:env 正向往返用例 + ≥4 负向用例(非对象/数组/null/值非字符串/布尔)全绿
- [ ] **T2** mcpRoutes.test.ts:PUT 带 env 落盘用例 + env 非法 400 零写入用例全绿
- [ ] **T3** mcpTools.test.ts:env 注入集成用例全绿(`MCP_TEST_ENV` 注入生效、`MCP_ABSENT_KEY` 不透传)
- [ ] **V1** `pnpm --filter @workflows/api test`(含定向三文件)全绿,既有用例零回归
- [ ] **V2** `pnpm --filter @workflows/api typecheck`、`pnpm --filter @workflows/web typecheck` 零错误
- [ ] **D1**(可选)docs/mcp.md:§1 字段清单、§5 写校验行、§6 spawn 安全说明已同步 env
- [ ] **S1** 范围控制:McpPanel.vue 未加 env 输入框;未展开 process.env;未引入 cwd/timeoutMs
