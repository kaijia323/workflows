# MCP server 配置 env 支持缺失 — 调研报告

> 任务:调研 workflows 仓库中 MCP server 配置 `env` 支持缺失问题,为修复做准备。
> 性质:只读调研,未修改任何代码。SDK 源码路径来自 pnpm store(`node_modules/.pnpm/...`,git 索引忽略,read 直读)。
> 日期:2026-02-XX

---

## 1. 仓库概览

| 项 | 内容 |
|---|---|
| 技术栈 | pnpm workspace + turbo;apps/api(Hono + Express 系,`"type": "module"`,vitest 单测);apps/web(Vue 3 + Vite + Tailwind v4);packages/shared(共享类型) |
| 构建/测试 | `turbo.json` 编排;apps/api:`pnpm --filter @workflows/api test`(vitest run)、`typecheck`(tsc --noEmit);MCP 相关测试:`apps/api/src/pi/mcpTools.test.ts`(单元+真实 stdio 集成)、`apps/api/src/mcpConfig.test.ts`(存储层)、`apps/api/src/agent/mcpRoutes.test.ts`(HTTP 路由层) |
| MCP 依赖 | `@modelcontextprotocol/sdk@^1.30.0`(apps/api/package.json:19),锁到 `1.30.0`(pnpm store:`@modelcontextprotocol+sdk@1.30.0_zod@4.4.3`) |
| 相关文档 | `docs/mcp.md`(设计决策记录,配置格式 `{ "mcpServers": [...] }`,需同步更新) |

---

## 2. MCP SDK env 语义(SDK v1.30.0)— 核心结论

### 2.1 源码位置

- 运行时文件(ESM;apps/api 为 `"type": "module"`,import 解析到 esm):
  `node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0_zod@4.4.3/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js`
- 类型声明:`dist/esm/client/stdio.d.ts`
- cjs 版本(`dist/cjs/client/stdio.js`)语义与 esm 完全一致(已核对)。

### 2.2 结论:env 是「与白名单合并」,不是与 process.env 合并

`StdioServerParameters` 接受 `env?: Record<string, string>`(stdio.d.ts:19,注释明确:"If not specified, the result of getDefaultEnvironment() will be used")。

`start()` 中 spawn 的 env 构造(stdio.js:67-73,关键片段):

```js
this._process = spawn(this._serverParams.command, this._serverParams.args ?? [], {
    // merge default env with server env because mcp server needs some env vars
    env: {
        ...getDefaultEnvironment(),
        ...this._serverParams.env
    },
    stdio: ['pipe', 'pipe', this._serverParams.stderr ?? 'inherit'],
    shell: false,
    ...
});
```

`getDefaultEnvironment()`(stdio.js:30-44)只继承**白名单**变量(stdio.js:9-25):
- 非 Windows:`HOME, LOGNAME, PATH, SHELL, TERM, USER`
- Windows:`APPDATA, HOMEDRIVE, HOMEPATH, LOCALAPPDATA, PATH, PROCESSOR_ARCHITECTURE, SYSTEMDRIVE, SYSTEMROOT, TEMP, USERNAME, USERPROFILE, PROGRAMFILES`

**语义推论(决定修复写法):**

| 传参方式 | spawn 收到的 env | 说明 |
|---|---|---|
| 不传 env(现状) | 仅白名单 6 项(非 Win) | **当前 MCP server 子进程本就不继承完整 process.env** |
| 直接传 `config.env` | 白名单 + 用户 env | SDK 保证白名单仍在;用户 env 同键覆盖白名单、新键追加。最小改动、不改变现状继承面 |
| 传 `{ ...process.env, ...config.env }` | 完整 process.env + 用户 env | 与 Claude Desktop 等主流客户端一致,但**扩大**了当前继承面(子进程可见全部父进程 env,含 API key 等) |

> 结论:直接传 `config.env` 是安全的(不会导致子进程缺 PATH/HOME 而无法启动),不是「完全替换 process.env」;只有需要"完整继承 process.env"语义时才必须用 `{ ...process.env, ...config.env }`。两者都可用,取决于产品语义与安全取舍(见 §5)。

---

## 3. 测试结构(env 断言现状)

### 3.1 `apps/api/src/pi/mcpTools.test.ts`

- `serverConfig()` 辅助函数:**第 25 行** `function serverConfig(name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig { return { name, command: 'node', args: ['-e', 'x'], enabled: true, ...extra } }` — `Partial` spread 模式,类型加了 `env` 后自动支持 `serverConfig('srv', { env: {...} })`,无需改 helper。
- `makeFakeConnection(overrides)`(第 38-60 行):注入式 fake,返回 `{ conn, connect, listTools, callTool, close }`,默认 `vi.fn(async () => {})`;`makeManager(fake)`(第 62-65 行)注入 `McpConnectionFactory`。
- **断言方式**:manager 层只断言 `fake.connect` 的**调用次数**(如第 6 节 `toHaveBeenCalledTimes(1/2)`),**没有断言 StdioClientTransport 构造参数**(command/args/env 均无)——因为测试注入的是 `McpConnection` 接口,看不到 transport 构造。
- **真实 stdio 集成测试**(第 458-520 行):`ECHO_SERVER_SCRIPT` 起真实最小 MCP server,`new StdioMcpConnection(serverConfig('echo', { args: ['-e', ECHO_SERVER_SCRIPT] }))` 直接连。**可在此加 env 断言**:让 ECHO_SERVER_SCRIPT 读 `process.env.XXX` 并经 echo 工具回传,断言注入生效(最贴近真实,推荐)。
- 备选:对 `@modelcontextprotocol/sdk/client/stdio.js` 做 `vi.mock` 捕获 `new StdioClientTransport(params)` 的参数 —— 现有测试**无任何 SDK mock 先例**,引入需注意(该文件同时被集成测试真实使用,建议只在单个 describe 内 mock)。
- **全文 `env` 出现次数:0**(大小写不敏感 grep 零命中)。

### 3.2 `apps/api/src/mcpConfig.test.ts` — validateMcpServers 测试列表

「校验失败零写入」`it.each`(第 96-108 行):空 name / 含空格 name / 含点 name / 中文 name / 超 40 字符 name / 空 command / args 含非字符串 / enabled 非布尔;另有重名、文件不存在零写入、原子写(tmp 无残留)、存取往返(`enabled` 缺省原样不补写,第 86-91 行)等。**无任何 env 用例**。
→ 需新增:`env 非对象`、`env 值非字符串`(仿 args 用例),以及 env 存取往返用例。

### 3.3 `apps/api/src/agent/mcpRoutes.test.ts`(HTTP 层)

- PUT 新增(第 85-101 行)、PUT 重名覆盖(第 108-123 行,断言**字段级替换**:第二次 PUT 不带 args → `args` 变为 `undefined`)、400 零写入系列(非法 name / 空 command / args 含非字符串 / args 非数组 / enabled 非布尔)。
- **无 env 用例**。PUT 覆盖语义测试(第 108-123 行)证明:**PUT 是字段级替换,缺省字段被清空** —— 这是 env 修复的关键风险(见 §4.3)。

---

## 4. 消费方盘点(全仓 `McpServerConfig` 使用者)

| 文件:行号 | 读取字段 | 说明 |
|---|---|---|
| `packages/shared/src/index.ts:80-92` | — | **类型定义**:`{ name, command, args?, enabled? }`,无 `env`。修复第 1 处 |
| `apps/api/src/mcpConfig.ts:48-62` | name/command/args/enabled | `validateMcpServers` 校验(名称正则/command 非空/args 字符串数组/enabled 布尔)。修复第 2 处(加 env 校验) |
| `apps/api/src/mcpConfig.ts:42` `loadMcpServers` | 整个对象 | **不做字段过滤,原样返回** —— 手写 mcp.json 加 `env` 字段,读出来就在(类型上需加字段才能类型安全) |
| `apps/api/src/agent/routes.ts:91-110` | — | **PUT 路由只挑已知字段组装**:`readJson<{command?, args?, enabled?}>`(第 93 行)→ `server = { name, command, args, enabled }`(第 94-101 行)。**未知字段(含 env)被丢弃,不会持久化**。修复第 3 处 |
| `apps/api/src/agent/routes.ts:70-85` `mcpOverview` | `server.enabled` | GET 状态推导(`enabled===true → not_connected`,否则 disabled);servers 原样返回 |
| `apps/api/src/agent/routes.ts:113-131` | 整个对象 | DELETE / POST test:load 出的对象原样传 `testMcpServer(server)`,env 若存在会自然流到连接层 |
| `apps/api/src/pi/mcpTools.ts:225-229` | `command` / `args` | **`connect()` 构造 `StdioClientTransport({ command, args: args ?? [], stderr: 'pipe' })` —— 不传 env,这是功能缺失的根因**。修复第 4 处 |
| `apps/api/src/pi/mcpTools.ts:566-578` `testMcpServer` | 整个 config | 走 `StdioMcpConnection`,与 connect 同路径,随第 4 处自动修复 |
| `apps/web/src/composables/useAgent.ts:223-233` `saveMcpServer` | name/command/args/enabled | **PUT 请求体写死这四个字段**(`args: server.args ?? []`),**不发送 env** |
| `apps/web/src/components/McpPanel.vue` | — | 添加表单仅 name/command/**args** 三个输入框(handleAdd 第 93-112 行按空白 split args);已有 server 仅 toggleEnabled/test/delete,**无编辑表单**;toggleEnabled(第 78-80 行)用 `{ ...server, enabled: !... }` spread 整个对象(env 若在对象里会保留,但 useAgent.saveMcpServer 会把它丢掉) |

### 4.1 args/enabled 的消费方式(现状参照)

- `args`:只在 `mcpTools.ts:226` 传给 transport(`?? []`);前端 split 空白输入。
- `enabled`:`createMcpTools`(mcpTools.ts:485)过滤 `server.enabled === true`(opt-in);`mcpOverview` 状态推导;McpPanel toggle。

### 4.2 前端是否也要加 env 输入?

- **后端 4 处是必须**;前端是否加 env 输入取决于产品范围:
  - **不加前端**:用户可手写/编辑 `.workflows/mcp.json` 添加 `env`(loadMcpServers 原样透传,后端修复后即生效)。但注意 §4.3 的 UI 保存会抹掉 env。
  - **加前端(完整闭环)**:McpPanel.vue 表单加 `KEY=VALUE` 输入(每行一个,类似 args 的 split 模式)+ `useAgent.ts:229-233` 的 PUT 请求体加 `env: server.env ?? {}`。同时 toggleEnabled 后 env 才能保住。
- 建议:至少后端 4 处 + useAgent.ts 发送 env(防止 UI 操作抹掉 env 的数据丢失);McpPanel.vue 的 env 输入框为可选增强。

### 4.3 关键风险:PUT 字段级替换会抹掉 env

`mcpRoutes.test.ts:108-123` 已断言 PUT 覆盖时缺省字段被清(`args` → undefined)。因此:
- 若只修 routes.ts 透传 env、不修 useAgent.ts,前端任何一次 `toggleEnabled`/保存都会把已手写的 env 清空(静默数据丢失)。
- 修复必须**同时**覆盖 routes.ts(接受 env)+ useAgent.ts(发送 env),或至少在前端文档/UI 中提示。

---

## 5. 回归风险

1. **mcpTools.test.ts 无 env 断言**:全文 `env` 零命中,不存在"断言 env 为 undefined"的测试会被打破。现有 `connect()` 行为(不传 env)无任何测试锁定 → 修复无直接回归。
2. **真实 stdio 集成测试**(ECHO_SERVER_SCRIPT)不依赖环境变量(只需 `node` 可执行,白名单已含 PATH)→ 修复后不受影响。
3. **行为变化点(需决策)**:若采用 `{ ...process.env, ...config.env }`,MCP 子进程从"仅白名单 6 项"变为"继承完整 process.env"(含 API key 等敏感值)。这与现有安全姿态(docs/mcp.md §6:命令只从 mcp.json 读取、spawn 不经 shell;McpPanel 安全警告:MCP server 以当前用户权限运行)并非冲突——同一用户权限本就可达 /proc——但属于继承面扩大,建议在 docs/mcp.md 决策记录中明示;若想保守,直接传 `config.env`(白名单+用户 env)即可满足"env 支持"需求。
4. `mcpConfig.test.ts` 校验列表、`mcpRoutes.test.ts` PUT 系列均需补 env 正向/负向用例(见 §6),否则新校验逻辑无覆盖。

---

## 6. 建议修复点清单(含测试改动)

### 后端(必须,4 处)

1. **`packages/shared/src/index.ts:80-92`** — `McpServerConfig` 增加 `env?: Record<string, string>`,JSDoc 说明"传给 MCP server 子进程的环境变量,同键覆盖继承值"。
2. **`apps/api/src/mcpConfig.ts:48-62`** — `validateMcpServers` 增加 env 校验:undefined 或 `Record<string, string>`(仿 args 模式;值必须全为 string)。
3. **`apps/api/src/agent/routes.ts:93-101`** — PUT 路由:`readJson` 类型加 `env?: unknown`;server 组装加 `env: raw?.env as Record<string, string> | undefined`(透传原始值,校验交给存储层,与 args/enabled 同模式)。
4. **`apps/api/src/pi/mcpTools.ts:225-229`** — `connect()` 的 `StdioClientTransport` 参数加 env。两种写法:
   - 保守(推荐默认):`env: this.config.env`(SDK 自动合并白名单,子进程不丢 PATH/HOME)。
   - 完整继承:`env: { ...process.env, ...this.config.env }`(需在 docs/mcp.md 记录继承面扩大)。
   `testMcpServer` 走同一 `StdioMcpConnection`,自动生效。

### 前端(防数据丢失必须 1 处;输入框可选)

5. **`apps/web/src/composables/useAgent.ts:223-233`** — PUT 请求体增加 `env: server.env ?? {}`(否则 toggleEnabled/保存会抹掉 env)。
6. (可选)`apps/web/src/components/McpPanel.vue` — 添加表单加 env 输入(建议 `KEY=VALUE` 每行一个,仿 args 的空白 split 模式;注意 env 值可能含空格,建议按行 split 而非空白);列表项 title 展示 env。

### 文档

7. **`docs/mcp.md`** — 配置格式章节补充 `env` 字段说明与安全提示(env 会传给 MCP 子进程)。

### 测试改动建议

8. **`apps/api/src/pi/mcpTools.test.ts`**:
   - 真实 stdio 集成(推荐):`ECHO_SERVER_SCRIPT` 增加一个读取 `process.env.MCP_TEST_ENV` 并回传的 echo 变体,`serverConfig('env', { env: { MCP_TEST_ENV: 'injected' } })` 断言注入生效(可同时断言**未注入的 key 不存在**,锁定"白名单+用户 env"或"全量 process.env"的语义,防止将来被改坏)。
   - (可选)vi.mock StdioClientTransport 捕获构造参数,断言 `env` 字段;放在独立 describe,避免影响真实集成测试。
9. **`apps/api/src/mcpConfig.test.ts`** — `it.each` 增加 `['env 非对象', { ...validServer, env: 'x' }]`、`['env 值非字符串', { ...validServer, env: { A: 1 } }]`;存取往返用例补 env 字段(并断言 `env` 缺省时磁盘原样缺省,仿 enabled 用例)。
10. **`apps/api/src/agent/mcpRoutes.test.ts`** — PUT 新增用例 body 加 `env`,断言落盘与响应含 env;补 `env 非对象 → 400 零写入`;**补"PUT 覆盖不带 env → env 被清空"的既有语义断言**(若前端已修复为总是发送 env,此用例记录行为而非问题)。

---

## 7. 结论

- **可行性:高,改动面小而清晰**。功能缺失根因唯一:`mcpTools.ts:225` 构造 `StdioClientTransport` 未传 env;类型(shared)、校验(mcpConfig)、路由透传(routes.ts)三处配套缺失。
- **SDK 语义已确认**:`env` 与 `getDefaultEnvironment()` 白名单合并(非 process.env),直接传 `config.env` 不会导致子进程缺 PATH/HOME;是否要全量 process.env 是产品/安全决策,建议保守方案 + 文档记录。
- **必须同批修复的最小集合**:shared 类型 + mcpConfig 校验 + routes.ts PUT 透传 + mcpTools.ts 连接传参 + useAgent.ts 发送 env(防 PUT 字段级替换抹掉 env);McpPanel.vue 输入框与 docs/mcp.md 为配套增强。
- **回归风险低**:现有测试无任何 env 断言,集成测试不依赖环境变量;需新增 3 个测试文件的正向/负向用例以覆盖新逻辑。
