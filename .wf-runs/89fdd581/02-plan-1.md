# 实施计划:workflows 打包为 Node.js bin 模式 CLI(`wf` 命令)

> 基于 `.wf-runs/89fdd581/01-exploration-1.md` 及关键文件复核(`index.ts` / `app.ts` / `config.ts` / `copy-agents.mjs` / 两个 package.json / tsconfig)。
> 约束:本计划只读,实施阶段按步骤改代码;所有改动集中在 `apps/api` + 根 package.json + 文档。

---

## 0. 关键决策(先回答任务中的权衡)

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| CLI 框架 | **Node 内置 `util.parseArgs`,不引入 commander** | 仓库零 CLI 依赖、现有辅助脚本均为零依赖手写解析风格;命令面小(4 子命令、每命令 ≤4 个 flag),`util.parseArgs`(Node ≥20.19 稳定)完全够用;避免新增运行时依赖。解析逻辑抽成纯函数 `cliArgs.ts`,未来命令变多(>8 个/嵌套子命令)时换 commander 的迁移成本仅限这一个文件 |
| CLI 入口位置 | `apps/api/src/cli.ts`,bin 指向 `dist/cli.js`;**不新建独立 cli 包** | CLI 全部复用 api 包内部模块(`app.ts`/`config.ts`/`piService.ts`),独立包会引入包间依赖与 turbo 构建顺序复杂度,收益为零 |
| `upgrade` 方案 | **git pull --ff-only + pnpm install + pnpm build**(本地 monorepo 场景) | 仓库 `private: true`、非 npm 发布场景,"升级"= 拉最新代码 + 重建本地产物;npm 包自更新(`npm update -g` 语义)在此不适用 |
| bin 注册 | **双注册**:`apps/api/package.json`(主)+ 根 `package.json`(仓库内便利) | api 包 bin 支持 `pnpm link` 全局/未来发布;根 bin 让 `pnpm install` 在仓库根生成 `node_modules/.bin/wf`,仓库内任意目录 `pnpm exec wf` 可用 |
| NODE_ENV 语义 | `wf start` **无条件**设 `NODE_ENV=production`(存储根 `~/.workflows`,端口默认 5200);`--dev` 强制 `development`(存储根 `<repo>/.workflows`,端口默认 3000) | 可预测、与 README 既有生产语义一致;启动日志打印存储根,用户可见数据写入位置 |
| 端口优先级 | `--port` > `PORT` env > 默认(`--dev`?3000 : 5200),严格校验 1–65535 | 沿用现有 `PORT` 覆盖机制,`--port` 显式优先 |

---

## 1. 目标与范围

### 做
1. 新增 `wf` CLI 入口(help / version / start / upgrade 四个命令),bin 模式可从任意目录运行。
2. 提取 `startServer` 与优雅退出逻辑,`wf start` 与现有 `pnpm start` 共用同一套启动代码。
3. 明确 CLI 下 NODE_ENV / 存储根 / 端口语义,保证不意外写入用户 home。
4. 构建链路确认:tsc 产出 `dist/cli.js` + 既有 `copy-agents.mjs` 复制 agents .md;运行时兜底校验。
5. README / AGENTS.md 文档更新。
6. 单元测试(cliArgs)+ 冒烟验证。

### 不做
- 不新建独立 cli npm 包;不改 `packages/shared`、`apps/web`、`turbo.json`、tsconfig。
- 不做 npm 发布(publish)相关配置(`files`/`prepublishOnly` 等)——仓库 private,发布是未来话题。
- 不做 `wf run`/`wf status` 等业务命令(未来扩展)。
- 不改 `pnpm dev`(vite + watch)体验;`--dev` 只是 CLI 的"数据不落 home"模式。
- 不做守护进程/自重启/开机自启。
- 不把 agents .md 复制改为运行时执行(构建时复制已覆盖;运行时兜底只校验不复制)。

---

## 2. 实施步骤(按序执行,每步可独立验证)

### 步骤 1:提取 `startServer` 与优雅退出(纯重构,行为零变化)

**改动文件**:
- **新增 `apps/api/src/startServer.ts`**
  ```ts
  import { serve, type ServerType } from '@hono/node-server'
  import { app, initAgentRoutes } from './app.js'
  import type { WorkflowsStore } from './config.js'
  import type { PiAgentService } from './pi/piService.js'

  export interface StartServerOptions { port: number; host?: string }
  export interface StartedServer {
    pi: PiAgentService
    store: WorkflowsStore
    server: ServerType
    port: number
  }
  export async function startServer(options: StartServerOptions): Promise<StartedServer>
  // 实现:const { pi, store } = await initAgentRoutes(); serve({ fetch: app.fetch, port, hostname: host }); 等 listening;
  // 打印启动日志:端口、模式(production/development)、存储根(store.root)、web 是否托管(hasWebDist 由 app.ts 内部处理,日志只提示 API-only 时访问 /api)
  export function installShutdownHandlers(pi: PiAgentService): void
  // 现 index.ts 的 SIGINT/SIGTERM → pi.dispose() + 5s 兜底强制退出逻辑原样搬入
  ```
- **修改 `apps/api/src/app.ts`**:`initAgentRoutes()` 返回类型 `Promise<PiAgentService>` → `Promise<{ pi: PiAgentService; store: WorkflowsStore }>`(内部 `const store = createStore()` 后返回 `{ pi, store }`)。已确认全仓仅 `index.ts` 调用它,`app.test.ts` 不调用,无测试破坏。
- **修改 `apps/api/src/index.ts`**:瘦身为
  ```ts
  const isProduction = process.env.NODE_ENV === 'production'
  const port = Number(process.env.PORT ?? (isProduction ? 5200 : 3000))
  const { pi } = await startServer({ port })
  installShutdownHandlers(pi)
  ```
  行为与现状完全一致(`pnpm start` 不受影响)。

**预期结果**:`pnpm --filter @workflows/api typecheck && pnpm --filter @workflows/api test && pnpm --filter @workflows/api build` 全绿;`pnpm start` 启动/退出行为与改造前一致。

---

### 步骤 2:CLI 参数解析纯函数 + 单测

**改动文件**:
- **新增 `apps/api/src/cliArgs.ts`**(纯函数,无 IO,可单测):
  ```ts
  export type CliCommand =
    | { kind: 'help' } | { kind: 'version' }
    | { kind: 'start'; port?: number; host?: string; dev: boolean }
    | { kind: 'upgrade'; force: boolean }
  export function parseCliArgs(argv: string[]): CliCommand
  // 实现:argv[0] 为子命令(缺省 → help);--help/-h、--version/-v 在任何位置生效;
  // start 用 util.parseArgs({ options: { port: { type: 'string' }, host: { type: 'string' }, dev: { type: 'boolean' } }, allowPositionals: false, strict: true });
  // port 严格校验 /^\d+$/ 且 1–65535,非法 → 抛 CliError(带友好消息);
  // upgrade 用 parseArgs({ options: { force: { type: 'boolean' } } });
  // 未知命令/未知 flag → 抛 CliError(消息 + 提示用 wf help)
  export class CliError extends Error {}
  export function defaultPort(dev: boolean): number  // dev ? 3000 : 5200
  export function resolvePort(dev: boolean, portFlag?: number, portEnv?: string): number
  // 优先级:--port > PORT env > defaultPort;PORT env 非法时也报 CliError
  ```
- **新增 `apps/api/src/cliArgs.test.ts`**(vitest,自动被 `vitest run` 收集;tsconfig.build 的 `exclude: *.test.ts` 保证不进 dist):
  - 用例:无参数 → help;`start` 缺省 port/dev;`--port 8080`;`--port abc`/`--port 0`/`--port 70000` 抛错;`--dev` 时默认端口 3000;`PORT=6000` 环境回退;`--port` 优先于 `PORT`;`upgrade` 默认 force=false;未知子命令/未知 flag 抛错;`--help`/`-v` 短路。

**预期结果**:`pnpm --filter @workflows/api test` 通过新增用例。

---

### 步骤 3:CLI 入口 `apps/api/src/cli.ts`

**改动文件**:
- **新增 `apps/api/src/cli.ts`**(首行 `#!/usr/bin/env node`,tsc 会保留 shebang 到 dist/cli.js):
  - 顶层顺序:① shebang;② 静态 import(Node 内置模块 + `parseCliArgs`/`CliError` + `startServer`/`installShutdownHandlers`);③ 主体 `main()`(async IIFE,错误统一 catch → `console.error` + 退出码 1)。
  - `main()` 流程:
    1. `const cmd = parseCliArgs(process.argv.slice(2))`;catch `CliError` → 打印错误 + help 摘要,`process.exit(1)`。
    2. `help` → 打印 `HELP_TEXT`,exit 0;`version` → 读 `new URL('../package.json', import.meta.url)` 的 version 字段,打印,exit 0。
    3. `start` → **先** `process.env.NODE_ENV = cmd.dev ? 'development' : 'production'`(无条件覆盖,在任何业务模块运行前;已确认 config.ts/routes.ts 对 NODE_ENV 均为运行时惰性读取,无模块顶层读取,无时序问题);再 `const port = resolvePort(cmd.dev, cmd.port, process.env.PORT)`;兜底校验 `dist/pi/agents/orchestrator.md` 存在(用 `existsSync(new URL('./pi/agents/orchestrator.md', import.meta.url))`),缺失 → 打印"请先运行 pnpm build"退出 1;`const { pi } = await startServer({ port, host: cmd.host })`;`installShutdownHandlers(pi)`(阻塞在 server 上,由信号退出)。
    4. `upgrade` → 见下方升级流程,stdio inherit。
  - `HELP_TEXT` 完整内容(见 §4)。
  - 升级流程(本地 monorepo 场景,用 `node:child_process` `spawn` + `execFileSync` 组合,Windows 下 `shell: true` 以解析 pnpm.cmd):
    1. `git rev-parse --is-inside-work-tree` 失败 → "不是 git 仓库,无法 upgrade",exit 1。
    2. `git status --porcelain` 非空且非 `--force` → "有未提交改动,请先提交或使用 --force",exit 1。
    3. `git pull --ff-only`(inherit);失败 → 中止,不再装依赖/构建,exit 1。
    4. `pnpm install`(inherit)。
    5. `pnpm build`(inherit;turbo 依赖序 shared→api→web,内含 copy-agents)。
    6. 打印"升级完成,重启 wf start 生效"。

**预期结果**:`pnpm --filter @workflows/api build` 产出 `dist/cli.js`(含 shebang);`node apps/api/dist/cli.js help/version` 正常输出;`node apps/api/dist/cli.js start --port 5299 --dev` 可启动、Ctrl+C 优雅退出。

---

### 步骤 4:bin 注册与构建链路确认

**改动文件**:
- **修改 `apps/api/package.json`**:加 `"bin": { "wf": "dist/cli.js" }`(其余不动;build 脚本已是 `tsc -p tsconfig.build.json && node scripts/copy-agents.mjs`,cli.ts 在 include 内,自动进 dist,agents .md 复制已覆盖——构建链路无需改动)。
- **修改根 `package.json`**:加 `"bin": { "wf": "apps/api/dist/cli.js" }`(private 包加 bin 合法,`pnpm install` 会在根 `node_modules/.bin` 生成 wf symlink)。

**全局任意目录可用(文档化,不动代码)**:
- 仓库内任意目录:`pnpm exec wf ...`(走根 node_modules/.bin)。
- 全局任意目录:`cd apps/api && pnpm link`(symlink 到包本体,依赖经 `apps/api/node_modules` 解析,`@workflows/shared`(workspace:*)可用;前提是已 `pnpm build`)。
- 注意:bin 指向 dist 产物,`pnpm install` 时 dist 尚不存在则 symlink 悬空 → 文档与验收均要求"先 `pnpm install && pnpm build`"。

**预期结果**:`pnpm install` 后 `pnpm exec wf help` 从仓库根/任意子目录可用。

---

### 步骤 5:文档更新

**改动文件**:
- **修改 `README.md`**:「命令」区新增「CLI(wf 命令)」小节:
  - 安装/启用:先 `pnpm install && pnpm build`,然后仓库内 `pnpm exec wf ...` 或全局 `cd apps/api && pnpm link`。
  - 命令速查表:start(--port/--host/--dev)/ help / version / upgrade(--force)。
  - 端口与存储根语义表:生产 `wf start` → 5200 + `~/.workflows`;`--dev` → 3000 + `<repo>/.workflows`;优先级 `--port` > `PORT` > 默认;`wf start` 与 `pnpm dev` 的关系(dev 仍是完整开发体验:web 15200 + api watch;CLI 的 --dev 只切换数据根与端口)。
  - upgrade 说明:git pull --ff-only + pnpm install + pnpm build;要求干净工作区(或 --force)。
  - 数据安全提示:`wf start` 生产模式数据落在 `~/.workflows`,启动日志会打印存储根。
- **修改 `AGENTS.md`**:命令列表追加 `wf` 条目(一句话:bin CLI,见 README)。

**预期结果**:文档与实际行为一致,可照着文档从零跑通。

---

### 步骤 6:验证(构建 + 冒烟)

见 §5 验收标准逐条执行;关键冒烟命令:
```bash
pnpm typecheck && pnpm test && pnpm build
node apps/api/dist/cli.js version
node apps/api/dist/cli.js help
pnpm exec wf help                     # bin symlink 生效
HOME=$(mktemp -d) pnpm exec wf start --port 5299 &   # 隔离 home,验证生产存储根落在临时 HOME
curl -s http://localhost:5299/api/health
kill -INT %1                           # 验证优雅退出(dispose,无 MCP 子进程残留)
pnpm exec wf start --dev --port 5298 & # 验证 <repo>/.workflows 存储根 + 端口默认逻辑
pnpm exec wf start --port abc          # 验证非法端口报错退出 1
pnpm exec wf upgrade                   # 干净工作区下干跑(预期 Already up to date + 重装 + 重建)
```

---

## 3. 文件清单总表

| 文件 | 操作 | 内容 |
| --- | --- | --- |
| `apps/api/src/startServer.ts` | 新增 | startServer + installShutdownHandlers(自 index.ts 提取) |
| `apps/api/src/cliArgs.ts` | 新增 | 纯函数参数解析 + CliError + resolvePort |
| `apps/api/src/cli.ts` | 新增 | bin 入口:help/version/start/upgrade |
| `apps/api/src/cliArgs.test.ts` | 新增 | 解析逻辑单测 |
| `apps/api/src/app.ts` | 修改 | `initAgentRoutes()` 返回 `{ pi, store }` |
| `apps/api/src/index.ts` | 修改 | 改用 startServer + installShutdownHandlers,行为不变 |
| `apps/api/package.json` | 修改 | 加 `bin.wf = dist/cli.js` |
| `package.json`(根) | 修改 | 加 `bin.wf = apps/api/dist/cli.js` |
| `README.md` / `AGENTS.md` | 修改 | CLI 文档 |
| `apps/api/scripts/copy-agents.mjs` 等 | 不动 | 构建复制 agents .md 已就位 |
| `packages/shared` / `apps/web` / `turbo.json` / tsconfig | 不动 | — |

---

## 4. help 输出设计(`HELP_TEXT`)

```
wf — workflows 本地一体化服务器 CLI

用法:
  wf <command> [options]

命令:
  start       启动 API + Web 服务器(生产模式默认)
  upgrade     拉取最新代码并重建(本地 monorepo:git pull + pnpm install + pnpm build)
  help        显示本帮助
  version     显示版本号

全局选项:
  -h, --help     显示帮助
  -v, --version  显示版本

start 选项:
  -p, --port <port>   监听端口;优先级 --port > PORT 环境变量 > 默认(--dev 下 3000,否则 5200)
      --host <host>   监听地址(缺省为 Node 默认)
      --dev           开发语义:数据存储根 <仓库>/.workflows,端口默认 3000
                      (不指定时以生产语义运行:数据存储根 ~/.workflows)

upgrade 选项:
      --force         工作区有未提交改动时仍然继续(默认拒绝)

示例:
  wf start                  # 生产模式,http://localhost:5200,数据 ~/.workflows
  wf start --port 8080      # 自定义端口
  wf start --host 127.0.0.1 # 仅本机访问
  wf start --dev            # 数据写 <仓库>/.workflows,端口 3000
  wf upgrade                # git pull --ff-only + pnpm install + pnpm build
```

---

## 5. 验收标准(逐条核对)

- [ ] A1 `pnpm typecheck && pnpm test && pnpm build` 全绿(turbo 全包;新增 cliArgs.test.ts 通过)。
- [ ] A2 `apps/api/dist/cli.js` 存在且首行为 `#!/usr/bin/env node`;`apps/api/dist/pi/agents/orchestrator.md` 存在(copy-agents 已执行)。
- [ ] A3 `node apps/api/dist/cli.js version` 输出 `0.0.0`;`... help` 输出 §4 帮助文本。
- [ ] A4 裸 `wf`(无参数)打印帮助退出 0;未知命令/未知 flag 报错 + 提示 help,退出 1;`--port abc` 退出 1 且消息友好。
- [ ] A5 `pnpm install` 后仓库根存在 `node_modules/.bin/wf`,`pnpm exec wf help` 从仓库根与任意子目录可用。
- [ ] A6 `HOME=$(mktemp -d) pnpm exec wf start --port 5299`:`curl /api/health` 返回 `{code:0,...}`;启动日志含端口 5299、模式 production、存储根 = `$HOME/.workflows`;Ctrl+C 后进程退出且无残留 MCP 子进程(dispose 生效)。
- [ ] A7 `pnpm exec wf start --dev --port 5298`:日志含 development、存储根 = `<仓库>/.workflows`(目录被创建)。
- [ ] A8 端口优先级:`--port 5297` 与 `PORT=5296 wf start --port 5297` 均监听 5297;`PORT=5296 wf start` 监听 5296;均验证 /api/health。
- [ ] A9 `--host 127.0.0.1` 下仅本机可访问;缺省 host 行为与改造前 `pnpm start` 一致。
- [ ] A10 `wf start` 前删除/改名 `dist/pi/agents` 目录 → 启动报"请先运行 pnpm build"并退出 1(兜底校验)。
- [ ] A11 `wf upgrade` 在干净工作区执行成功(输出 Already up to date / 安装 / 构建日志),结束后 `wf version` 仍可用;在 dirty 工作区默认拒绝、`--force` 通过。
- [ ] A12 `pnpm start`(原入口)行为与改造前一致(回归)。
- [ ] A13 README/AGENTS.md 已更新,可照着文档从零跑通 wf。

---

## 6. 风险与回滚

| 风险 | 等级 | 缓解 | 回滚 |
| --- | --- | --- | --- |
| `initAgentRoutes()` 返回类型变更波及调用方 | 低 | 全仓仅 index.ts 调用,编译期兜底,app.test.ts 不调用 | `git revert` 该步骤 commit |
| NODE_ENV 无条件覆盖:用户 shell 已 export NODE_ENV 时被 `wf start` 覆盖 | 低 | 与既有 `pnpm start`(cross-env production)行为一致;启动日志打印存储根;文档说明;冒烟用 `HOME=$(mktemp -d)` 隔离,不污染真实 `~/.workflows` | 无代码回滚,属语义决策,可后续加 `--data-dir` 扩展 |
| `wf upgrade` 是仓库破坏性命令(git pull/重装/重建) | 中 | 仅干净工作区执行(默认拒绝 dirty)、`--ff-only`、任一步失败即中止;不影响本机数据(`~/.workflows` 与仓库无关) | `git reflog` 找回;数据无涉 |
| util.parseArgs 严格模式误伤(未知 flag 直接抛) | 低 | 顶层 catch 转友好错误 + help;单测覆盖 | — |
| bin symlink 悬空(install 时 dist 不存在) | 低 | 文档与验收要求"先 build";`pnpm exec wf` 报错信息可读(提示先 build) | — |
| MCP 子进程/fff 索引残留 | 低 | dispose + 5s 兜底逻辑原样搬迁,验收 A6 显式检查 | — |
| Windows 兼容(pnpm link、spawn pnpm.cmd) | 低 | upgrade 的 spawn 在 win32 用 `shell: true`;bin 由 npm/pnpm shim 生成,无需 +x | — |
