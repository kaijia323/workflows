# 实施计划(修订版 ncc):workflows 打包为 `wf` CLI——@vercel/ncc 单文件方案

> 基于 `.wf-runs/89fdd581/01-exploration-1.md`、`02-plan-1.md`,并按用户要求把「tsc 多文件产物」改为「@vercel/ncc 单文件产物」重写。
> 本计划只读;实施阶段按步骤改代码,全部改动集中在 `apps/api` + 根 package.json + 文档。
> 关键复核:index.ts / app.ts / config.ts / agentDefs.ts / copy-agents.mjs / 两个 package.json / tsconfig、ncc 0.38.4 文档与已知 issue、pi-ai/pi-coding-agent/fff-node/ffi-rs 依赖加载方式。

---

## 0. 相对 02-plan-1 的改动摘要

| 项 | 02-plan-1(tsc) | 02-plan-2(ncc) |
| --- | --- | --- |
| CLI 产物 | `dist/cli.js`(tsc 编译,与 server 共用 dist 树) | `dist/cli/index.js` 单文件(ncc 全依赖内联)+ 旁路 `dist/cli/agents/` |
| 构建链路 | 复用 `build`(tsc + copy-agents) | 新增 `apps/api/scripts/build-cli.mjs` + `build:cli` 脚本;`build`(tsc)原样保留 |
| 依赖内联 | 运行期走 node_modules | JS 依赖全部内联(pi-ai / pi-coding-agent / hono / mcp-sdk / fff-node JS 层);native/wasm 无法内联,见 §5-R4 |
| 路径适配 | `import.meta.url` 三级上跳在 dist/ 与 dist/cli/ 两种布局下不一致 | 新增 `src/paths.ts` 的 `findRepoRoot()`(向上找 `pnpm-workspace.yaml`),统一所有布局 |
| agents .md | `copy-agents.mjs` → `dist/pi/agents` | 保留原复制;另由 build-cli.mjs 复制到 `dist/cli/agents`(bundle 同目录旁路) |
| version 实现 | `new URL('../package.json', import.meta.url)` | `paths.ts#readApiVersion()`(经 repoRoot 读文件,规避 webpack 对 `new URL` 的静态处理) |
| 验证 | `node dist/cli.js help` | `node dist/cli/index.js help`(见 §7) |
| 新增步骤 | — | 步骤 1:ncc 可行性门禁(spike);步骤 5:build-cli.mjs 与 ncc 参数 |

保留 02-plan-1 的全部决策:CLI 入口 `apps/api/src/cli.ts`;命令集 help/version/start/upgrade;`wf start` 默认端口 5200、`--dev` 切 development;upgrade = git pull + pnpm install + pnpm build;bin 双注册;拆 `startServer.ts`;`cliArgs.ts` 纯函数 + 单测;NODE_ENV/端口语义、HELP_TEXT 文本。

---

## 1. 十个问题的决策(逐条)

### Q1 构建链路:ncc 构建脚本与 tsc build 的关系

**决策:新增 `build:cli`(`apps/api/scripts/build-cli.mjs`),tsc build 原样保留,两者并存;ncc 产物即 CLI 的发布物。**

- `build:cli` 逻辑:`ncc build src/cli.ts -o dist/cli`(程序化 API,便于后处理)→ 产物 `dist/cli/index.js`(单文件,含 shebang)+ `index.js.map` + ncc 生成的旁路资产 → 复制 `src/pi/agents/*.md` 到 `dist/cli/agents/`。
- **tsc build 保留的理由**(`apps/api/package.json` 的 `build` 不动):
  1. `pnpm start`(生产入口)仍由 `dist/index.js` 驱动,是回归基线,不能断;
  2. `apps/web/dist` 静态托管由 `app.ts` 运行时判定,与 CLI 共用同一份代码,tsc 产物仍在;
  3. `wf upgrade` 内部执行 `pnpm build`,turbo 依赖序 shared→api→web 的语义不变;
  4. 测试/类型检查不依赖打包。
- 发布物 = `dist/cli/` 整个目录(单 JS + agents 副本 + 可能的 native/wasm 旁路文件,见 Q10);不涉及 npm publish(仓库 private)。

### Q2 workspace 依赖 @workflows/shared

**决策:无需特殊处理,但要求 shared 先 build。**

- 现状:`config.ts`/`app.ts` 对 `@workflows/shared` 全部是 `import type`(纯类型包)→ TS loader 在 ncc 解析前擦除,**不产生运行时依赖,不进 bundle**。
- 若未来出现运行时导出:webpack 5(`resolve.symlinks: true` 默认)沿 pnpm 的 `apps/api/node_modules/@workflows/shared` 符号链接跟随到 `packages/shared` 真实路径,读其 `exports` → `dist/index.js` 内联,可行。
- **注意点**(pnpm 特有):`packages/shared/dist` 不存在时解析即失败(其 exports 指向 dist)。`build-cli.mjs` 开头做显式校验:`existsSync('<repo>/packages/shared/dist/index.js')`,缺失则报「请先运行 pnpm build」退出 1——比让 webpack 报晦涩的 Module not found 可读。
- 已知 pnpm+webpack 坑主要是「未声明的幻影依赖」与 loader 解析;apps/api 的全部依赖都声明在自身 package.json,不在此列。

### Q3 agents .md 资源

**决策:构建时复制旁路目录(`dist/cli/agents`),不用 `--asset-builds`,不做运行时兜底复制。**

- 理由:`agentDefs.ts` 的 `BUILTIN_AGENTS_DIR = path.resolve(dirname(import.meta.url), 'agents')` 是**运行时拼接**路径,ncc 的 asset-relocator 只对「静态可分析的 `__dirname` + 字面量 fs 调用」可靠,对 import.meta 动态拼接不可靠;`--asset-builds` 面向 wasm/native 资产构建,不解决 .md 目录复制。
- 方案落地:
  - `build-cli.mjs` 在 ncc 输出后 `cpSync('src/pi/agents', 'dist/cli/agents', { recursive: true })`(先 `rmSync` 清旧,与 copy-agents.mjs 同风格);
  - bundle 内 `BUILTIN_AGENTS_DIR` 自然解析为 `dist/cli/agents`(import.meta.url 指向产物文件)——**agentDefs.ts 零改动**;
  - `cli.ts` 的启动预检改为 `existsSync(path.join(BUILTIN_AGENTS_DIR, 'orchestrator.md'))`(import 自 `./pi/agentDefs.js`,单一事实源),缺失 → 「请先运行 pnpm build && pnpm build:cli」退出 1(只校验不复制,与 02-plan-1 一致);
  - 原 `copy-agents.mjs`(→ `dist/pi/agents`)继续服务 tsc 产物,不动。
- 三布局统一:dev(tsx)= `src/pi/agents`;tsc = `dist/pi/agents`;ncc = `dist/cli/agents`。

### Q4 运行时资源路径(单文件 __dirname 适配)

**决策:新增 `apps/api/src/paths.ts`,统一「仓库根」定位;三处模块相对路径收敛到它。**

- ncc ESM 产物位于 `apps/api/dist/cli/index.js`,`import.meta.url` 指向该文件。原代码三处基于模块位置的相对路径会错位:
  - `config.ts#workflowsRoot()` dev 分支:三级上跳 → 落在 `apps/api`(应为仓库根)✗;
  - `app.ts#webDist`:两级上跳 → `apps/api/web/dist`(应为 `apps/web/dist`)✗;
  - `agentDefs.ts#BUILTIN_AGENTS_DIR`:模块同目录 `agents` ✓(bundle 布局下正好是 `dist/cli/agents`,见 Q3)。
- `paths.ts` 设计(纯函数,可单测):
  ```ts
  export function findRepoRoot(startDir?: string): string | undefined
  // 自 startDir(缺省 = 本模块目录)向上最多 8 级找 pnpm-workspace.yaml,命中即返回;
  // 对 src/、dist/、dist/cli/ 三种布局都能上溯到仓库根(dev: src→api→root;tsc: dist→api→root;ncc: dist/cli→dist→api→root)
  export function repoRoot(): string            // findRepoRoot() ?? process.cwd()(产物被拷出仓库时兜底,功能降级为 cwd 相对)
  export function readApiVersion(): string      // 读 <repo>/apps/api/package.json 的 version,失败回退 '0.0.0'
  ```
- 改动点:
  - `config.ts#workflowsRoot()` dev 分支 → `path.join(repoRoot(), '.workflows')`(prod 分支 `~/.workflows` 不变);
  - `app.ts#webDist` → `path.join(repoRoot(), 'apps', 'web', 'dist')`(不存在时 hasWebDist=false,API-only,行为同现状);
  - `agentDefs.ts` 不动;
  - 新增 `paths.test.ts`(用临时目录造 pnpm-workspace.yaml 验证上溯/兜底/version 读取)。
- 存储根语义不变:prod = `~/.workflows`;dev = `<repo>/.workflows`;启动日志打印存储根。

### Q5 bin 字段

**决策:单文件直接作 bin 目标;双注册仍保留。**

- ncc 保留输入 shebang(`#!/usr/bin/env node`),产物 `dist/cli/index.js` 可直接执行。
- `apps/api/package.json`:`"bin": { "wf": "dist/cli/index.js" }`(支持 `pnpm link` 全局/未来发布);
- 根 `package.json`:`"bin": { "wf": "apps/api/dist/cli/index.js" }`(`pnpm install` 生成根 `node_modules/.bin/wf`,仓库内任意目录 `pnpm exec wf` 可用)。
- 模块格式:见 Q10,产物为 ESM(`apps/api` 是 `type: module`,ncc 自动输出 ESM 并在输出目录生成 `{"type":"module"}` package.json),bin 指向 ESM 文件由 Node 直接执行,无需 .cjs 改名(若 ESM 输出失败走 CJS 兜底,见 §5-R2)。

### Q6 ncc 版本与参数

**决策:`@vercel/ncc@^0.38.4`(npm 最新,2024-11 发布);参数:`--target es2022` + `--source-map`,不开 `--minify`,禁用缓存。**

- 版本:0.38.4 为 latest;仓库处于维护模式(发布间隔长)但稳定,webpack 5.94 内嵌,已支持 CJS 构建中求值 `import.meta`(#1236)与 ESM 输出。devDependency 加在 `apps/api`。
- 参数(程序化 API 等价项):
  - `target: 'es2022'`(ncc 默认 es2015 会把现代语法降级、产物膨胀;Node ≥20.19 支持 ES2022);
  - `sourceMap: true`(单文件巨大,无 sourcemap 无法定位错误;`sourceMapBasePrefix` 默认即可);
  - `minify: false`(可读性优先;未来若做分发再开,一行改动);
  - `cache: false`(避免 ncc 缓存陈旧产物导致「改了代码不生效」的假象);
  - `filterAssetBase: <repoRoot>`(资产 relocator 只允许在仓库内发射资产,防止误带仓库外文件);
  - `externals: []`(初始为空;见 §5-R4 按需追加)。

### Q7 单测

**决策:不受影响,照常。**

- vitest 直接跑 `src/`(esbuild 转换),ncc 不参与测试链路;`cliArgs.test.ts` 按 02-plan-1 新增,`tsconfig.build.json` 的 exclude 保证它不进任何产物。
- 新增 `paths.test.ts`(Q4)。`agentDefs.test.ts` 继续命中 `src/pi/agents`,无需改。

### Q8 验证方式

- 冒烟:构建产物验证改为
  ```bash
  node apps/api/dist/cli/index.js version
  node apps/api/dist/cli/index.js help
  pnpm exec wf help
  node apps/api/dist/cli/index.js start --dev --port 5298   # + curl /api/health
  ```
- 额外校验:`dist/cli/index.js` 首行为 shebang、`dist/cli/agents/orchestrator.md` 存在、`dist/cli/package.json` 为 `{"type":"module"}`(ncc 生成)、bundle 内不含对 `node_modules` 的运行时 require(见 §7 列表)。
- 其余冒烟(端口优先级、--host、upgrade、HOME 隔离、A10 兜底)同 02-plan-1 §6,入口换成 bundle。

### Q9 权衡:ncc 单文件 vs tsc 多文件

| 维度 | ncc 单文件 | tsc 多文件 | 本项目结论 |
| --- | --- | --- | --- |
| 部署便捷 | 单个 JS 入口 + agents 旁路目录;bin 指一个文件,不依赖 dist 树完整性 | 整棵 dist 树 + node_modules 齐备才能跑 | **ncc 胜**:CLI 语义就是「一个入口」;但仍需仓库内安装(native 链,见 R4) |
| 依赖内联 | JS 依赖全内联,不随 node_modules 漂移;但 pi-ai 全家桶(openai/anthropic/bedrock SDK 等)全进单文件,产物预计 10–40MB | 依赖走 node_modules,产物小 | 半斤八两:内联换来自包含,代价是体积与构建时长 |
| 构建速度 | 明显慢:全依赖图解析 + sourcemap,预计数十秒级(首建更久) | 快(秒级) | **tsc 胜**,但 build:cli 独立于日常 build,只在出 CLI 时跑 |
| 调试友好 | 单文件巨大,必须 sourcemap;堆栈行号指向打包文件 | 逐文件可读,堆栈即源码 | **tsc 胜**,用 --source-map 补偿 |
| 启动速度 | 单文件一次加载,ESM 解析少 | 逐文件 import 链,略慢 | ncc 略优(非主要考量) |

**结论:ncc 适合本项目。** 本 CLI 是「仓库内一体化工具」(upgrade 语义即 git+pnpm,天然绑仓库),ncc 的核心收益——单一入口、JS 依赖自包含、bin 极简——恰好命中;代价(构建慢、体积大、排障靠 sourcemap)可接受,且 tsc build 保留作为逃生舱。native/wasm 无法内联是本方案唯一结构性限制,见 §5-R4(有现成缓解,不阻塞)。

### Q10 ncc 特有坑(已逐一核实,含本仓库实证)

1. **ESM 输入 → ESM 输出(ncc 自动检测)**:输入在 `"type": "module"` 包边界内时,ncc 输出 ESM 并生成 `dist/cli/package.json {"type":"module"}`——本项目正是此路径,产物直接可跑,**无需 .cjs 改名**。已知 issue #1163(ESM 输出内残留 createRequire 调 CJS 包)在纯 ESM 依赖树上影响面小;本仓库依赖链(pi-ai / pi-coding-agent / fff-node)均为 `type: module`。**若 ESM 输出翻车 → CJS 兜底**:产物改名 `index.cjs` + 手工写 `dist/cli/package.json {"type":"commonjs"}`,bin 指向 .cjs(见 §5-R2)。
2. **pnpm 符号链接**:webpack 默认跟随 symlink 到 `.pnpm` 真实路径,依赖全部声明在 apps/api(无幻影依赖),一般可解析;遇到 `Module not found` 时用 `externals: ['<pkg>']` 把该包留在运行时 require(仓库内 node_modules 可解析,与 fff 二进制同理)。`@workflows/shared` 必须先 build(Q2 已含校验)。
3. **NodeNext `.js` 后缀导入**:源码 `import './app.js'` 指向 `app.ts`。ncc 的 TS 管线对 ESM TS 项目的 `.js`→`.ts` 映射是常规场景;**在步骤 1 spike 中显式验证**(构建日志无 resolve 错误即可证明)。
4. **顶层 await(TLA)**:`cli.ts` 必须用 `async main()`(02-plan-1 已设计);依赖树中若有 TLA,ESM 输出且 target es2022 下 webpack 可承载,但列为 spike 检查点(构建报 `Top-level-await` 即命中)。
5. **native / wasm 无法内联(本仓库实证)**:`@ff-labs/fff-node` 通过 `ffi-rs`(N-API native)加载 `@ff-labs/fff-bin-*` 平台 dll,解析是**运行时 createRequire + existsSync 动态计算**(已读 binary.js 确认);`pi-coding-agent` 依赖 `@silvia-odwyer/photon-node`(wasm)。ncc 的 asset-relocator 会把 `.node/.wasm` 拷到输出目录并改写引用,但 fff 的平台 dll 走动态解析,打包后仍从产物目录向上找 `node_modules` → **仓库内运行 OK,拷出仓库则 fff 不可用**。缓解:`FffIndexManager` 是惰性创建(`FileFinder.create` 仅在代理实际搜索工作区时调用,失败返回 null,`wf start` 不阻塞);spike 与验收各做一次 `FileFinder.create` 实测;若 bundle 内 ffi-rs 加载失败 → `externals: ['@ff-labs/fff-node']` 让它走仓库 node_modules。
6. **JSON import attributes**:pi-ai 有 `import ... from "./data/.manifest.json" with { type: "json" }`(已读 all.js 确认)——webpack 5.94(0.38.3+ 内置)支持,列为 spike 检查点。
7. **维护状态**:0.38.4 后约半年无发布,属「稳定但慢」;若 spike 证明不可行,Plan B 是 `esbuild --bundle`(同思路,ESM 输出一等公民)或回退 02-plan-1 的 tsc 方案。

---

## 2. 目标与范围

### 做
1. 新增 `wf` CLI(help/version/start/upgrade),bin 模式任意目录可用;**发布物为 ncc 单文件 `dist/cli/`**。
2. 提取 `startServer` 与优雅退出;`wf start` 与 `pnpm start` 共用启动代码。
3. 明确 CLI 下 NODE_ENV/存储根/端口语义(prod = `~/.workflows` + 5200;`--dev` = `<repo>/.workflows` + 3000;`--port` > `PORT` > 默认)。
4. 构建链路:新增 `build:cli`(ncc + agents 复制);保留 tsc build 作为 `pnpm start` 基线。
5. 路径收敛:新增 `paths.ts`(`findRepoRoot`/`repoRoot`/`readApiVersion`),修正单文件布局下 `workflowsRoot`/`webDist` 的解析。
6. 单测(cliArgs + paths)+ 冒烟;README/AGENTS.md 文档更新。

### 不做
- 不新建独立 cli 包;不改 `packages/shared`、`apps/web`、`turbo.json`、`tsconfig*.json`。
- 不做 npm 发布配置;不把 `build:cli` 并入 turbo 的 `build`(保持日常构建速度;文档化顺序 `pnpm build && pnpm build:cli`)。
- 不做 `--minify`(留作未来一行开关);不做 `wf run`/`wf status` 等业务命令;不做守护进程/自重启。
- 不改 `pnpm dev` 体验;`--dev` 仅切换数据根与端口。
- 不把 agents .md 复制改为运行时执行(构建时复制已覆盖,运行时只校验)。
- 不保证「产物拷出仓库后 fff 原生索引可用」(结构性限制,见 §5-R4;文档注明)。

---

## 3. 实施步骤(按序执行,每步可独立验证)

### 步骤 1:ncc 可行性门禁(spike,不提交业务代码)

**目的**:在投入重构前证明「apps/api 全依赖图可被 ncc 0.38.4 打包并运行」,回答 Q10 中全部检查点。

**改动文件**:
- 临时执行(不改仓库):
  ```bash
  pnpm --filter @workflows/api exec ncc --version        # 临时验证 0.38.4(或先装 devDep 见步骤 5)
  pnpm build                                             # 确保 shared/dist 与 api dist 存在
  npx --no-install ncc build apps/api/src/app.ts -o apps/api/dist/.probe --target es2022 --source-map
  node apps/api/dist/.probe/index.js                     # 期望:模块初始化完成、进程正常退出(0),无异常
  ```
  (`app.ts` 即完整依赖图入口:routes → piService → pi-ai / pi-coding-agent / fff-node / hono / mcp-sdk / picomatch / typebox / unbash。)
- 检查项(对应 Q10 检查点):① `.js` 后缀导入解析无 `Module not found`;② pnpm symlink 下所有包解析成功;③ pi-ai JSON import attributes 通过;④ 无 `Top-level-await` 报错;⑤ 产物为 ESM(`dist/.probe/package.json` 含 `"type":"module"`)且能加载;⑥ `import.meta.url` 在 bundle 内有效(bundle 模块顶层 `webDist` 计算不抛错);⑦ 记录产物大小与构建时长(预估 10–40MB / 数十秒级)。

**Go/No-Go 判据**:
- Go:①–⑥ 全过 → 继续步骤 2。
- No-Go:按 §5 风险表逐项缓解(加 externals、CJS 兜底);缓解后仍失败 → **中止并回退**:
  - 回滚 A:改用 `esbuild --bundle --platform=node --format=esm` 替代 ncc(本计划步骤 5 的脚本结构不变);
  - 回滚 B:直接按 02-plan-1(tsc 多文件)实施,本修订仅保留 paths.ts/startServer 等与打包无关的改动。
- 无论结果,清理 `apps/api/dist/.probe`。

**预期结果**:拿到 Go 判定,记录产物尺寸/时长/ESM 输出形态,为步骤 5 定参。

---

### 步骤 2:新增 `src/paths.ts`(路径收敛,纯重构)

**改动文件**:
- **新增 `apps/api/src/paths.ts`**:`findRepoRoot(startDir?)`(向上 ≤8 级找 `pnpm-workspace.yaml`;startDir 缺省 = `dirname(fileURLToPath(import.meta.url))`)、`repoRoot()`(兜底 `process.cwd()`)、`readApiVersion()`(读 `<repo>/apps/api/package.json` 的 version,异常回退 `'0.0.0'`;注释说明三种布局下的上溯路径)。
- **修改 `apps/api/src/config.ts`**:`workflowsRoot()` dev 分支 `path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.workflows')` → `path.join(repoRoot(), '.workflows')`;删除不再用的 `fileURLToPath` import(如无其他用途)。
- **修改 `apps/api/src/app.ts`**:`webDist` → `path.join(repoRoot(), 'apps', 'web', 'dist')`;删除 `fileURLToPath` import。
- **新增 `apps/api/src/paths.test.ts`**:临时目录造 `pnpm-workspace.yaml` 验证上溯命中/未命中兜底 cwd;`readApiVersion` 命中与缺失回退。
- `agentDefs.ts` 的 `BUILTIN_AGENTS_DIR` **不动**(Q3 论证它在三种布局下均正确)。

**预期结果**:`pnpm --filter @workflows/api typecheck && pnpm --filter @workflows/api test` 全绿;`pnpm start` 启动日志/存储根行为与改造前一致(dev/prod 分支语义未变)。

---

### 步骤 3:提取 `startServer.ts`(同 02-plan-1 步骤 1,零行为变化)

**改动文件**:
- **新增 `apps/api/src/startServer.ts`**:`StartServerOptions { port; host? }`、`StartedServer { pi; store; server; port }`、`startServer()`(initAgentRoutes → serve → 等 listening → 打印端口/模式/存储根/是否托管 web)、`installShutdownHandlers(pi)`(SIGINT/SIGTERM → dispose + 5s 兜底,自 index.ts 原样搬入)。
- **修改 `apps/api/src/app.ts`**:`initAgentRoutes(): Promise<PiAgentService>` → `Promise<{ pi: PiAgentService; store: WorkflowsStore }>`(内部 `createStore()` 后返回 `{ pi, store }`;全仓仅 index.ts 调用,app.test.ts 不调用)。
- **修改 `apps/api/src/index.ts`**:瘦身为 `startServer({ port })` + `installShutdownHandlers(pi)`,端口逻辑原样。

**预期结果**:typecheck/test/build 全绿;`pnpm start` 启动/退出与改造前一致。

---

### 步骤 4:CLI 参数解析纯函数 + 单测(同 02-plan-1 步骤 2)

**改动文件**:
- **新增 `apps/api/src/cliArgs.ts`**:`CliCommand`(help/version/start{port,host,dev}/upgrade{force})、`parseCliArgs(argv)`(Node `util.parseArgs`,strict;未知命令/flag → `CliError`)、`CliError`、`defaultPort(dev)`、`resolvePort(dev, portFlag?, portEnv?)`(优先级 `--port` > `PORT` > 默认;1–65535 校验)。
- **新增 `apps/api/src/cliArgs.test.ts`**:用例同 02-plan-1(缺省 help、port 非法值、--dev 默认 3000、PORT 回退、--port 优先、upgrade force、未知命令/flag、-h/-v 短路)。

**预期结果**:`pnpm --filter @workflows/api test` 通过新增用例。

---

### 步骤 5:CLI 入口 `src/cli.ts` + 版本读取(基于 02-plan-1 步骤 3 调整)

**改动文件**:
- **新增 `apps/api/src/cli.ts`**(首行 `#!/usr/bin/env node`,ncc 保留 shebang;**不用顶层 await**,主体为 `async main()` + 顶层 catch → 友好错误 + 退出码 1):
  - `help` → 打印 HELP_TEXT(同 02-plan-1 §4),exit 0;
  - `version` → `console.log(readApiVersion())`(自 paths.ts,替代 plan-1 的 `new URL('../package.json', import.meta.url)`),exit 0;
  - `start` → ① `process.env.NODE_ENV = cmd.dev ? 'development' : 'production'`(无条件覆盖,在一切业务模块执行前;已确认各模块对 NODE_ENV 为运行时惰性读取);② `resolvePort(...)`;③ 预检 `existsSync(path.join(BUILTIN_AGENTS_DIR, 'orchestrator.md'))`(`import { BUILTIN_AGENTS_DIR } from './pi/agentDefs.js'`),缺失 → 「请先运行 pnpm build && pnpm build:cli」exit 1;④ `startServer({ port, host: cmd.host })` + `installShutdownHandlers(pi)`;
  - `upgrade` → 与 02-plan-1 相同(git 检查/--ff-only pull/pnpm install/pnpm build),**末尾追加 `pnpm build:cli`**(让 CLI 在升级后重建自身;spawn 用 `shell: true` 兼容 Windows pnpm.cmd)。
- **不改** `agentDefs.ts` / `copy-agents.mjs`。

**预期结果**:typecheck/test 全绿;tsc 产物 `dist/cli.js` 也可手动冒烟(非发布物)。

---

### 步骤 6:build-cli.mjs + ncc 参数 + 构建链路

**改动文件**:
- **新增 `apps/api/scripts/build-cli.mjs`**(node 内置 fs 即可):
  1. 校验 `packages/shared/dist/index.js` 存在(否则报「请先运行 pnpm build」exit 1);
  2. `rmSync('dist/cli', { recursive: true, force: true })`;
  3. 程序化调用 ncc:`import ncc from '@vercel/ncc'` → `await ncc('src/cli.ts', { minify: false, sourceMap: true, target: 'es2022', cache: false, filterAssetBase: <repoRoot>, externals: [] })`;
  4. 写 `dist/cli/index.js`(+ `index.js.map`),遍历返回的 `assets` 写旁路资产(保留 permissions;覆盖 relocated 的 `.node/.wasm`);
  5. 复制 `src/pi/agents` → `dist/cli/agents`(先 rmSync 清旧,仿 copy-agents.mjs);
  6. 打印产物清单与大小;校验 `dist/cli/index.js` 首行为 shebang。
- **修改 `apps/api/package.json`**:devDependencies 加 `"@vercel/ncc": "^0.38.4"`;scripts 加 `"build:cli": "node scripts/build-cli.mjs"`。
- **修改根 `package.json`**:scripts 加 `"build:cli": "pnpm --filter @workflows/api build:cli"`。
- 若步骤 1 spike 期间命中 externals 需求:把对应包名填入 `externals` 数组并注释原因(预期为 `@ff-labs/fff-node` 相关链,见 §5-R4)。

**预期结果**:`pnpm install` 后 `pnpm build:cli` 成功;`node apps/api/dist/cli/index.js help/version` 正常;`dist/cli/agents/orchestrator.md` 存在;`dist/cli/index.js` 首行 shebang;产物为 ESM(`dist/cli/package.json` 为 ncc 生成的 `{"type":"module"}`,若 ncc 未生成则由 build-cli.mjs 补写)。

---

### 步骤 7:bin 双注册(同 02-plan-1 步骤 4,目标文件变化)

**改动文件**:
- **修改 `apps/api/package.json`**:加 `"bin": { "wf": "dist/cli/index.js" }`。
- **修改根 `package.json`**:加 `"bin": { "wf": "apps/api/dist/cli/index.js" }`。

**预期结果**:`pnpm install` 后根 `node_modules/.bin/wf` 存在;`pnpm exec wf help` 从仓库根与任意子目录可用。文档注明「先 `pnpm install && pnpm build && pnpm build:cli`」,否则 symlink 悬空。

---

### 步骤 8:文档更新

**改动文件**:
- **修改 `README.md`**:「命令」区新增「CLI(wf 命令)」:安装/启用(install + build + build:cli)、命令速查(help/version/start --port --host --dev/upgrade --force)、端口与存储根语义表(`--port` > `PORT` > 默认)、upgrade 说明(含 build:cli 自重建)、数据安全提示(启动日志打印存储根)、**构建说明**:`build:cli` 产物结构(dist/cli/index.js 单文件 + agents 旁路),注明「fff 原生索引需在仓库内运行;产物拷出仓库仅 fff 功能降级」。
- **修改 `AGENTS.md`**:命令列表追加 `wf` 条目。

**预期结果**:可照文档从零跑通 wf。

---

## 4. 文件清单总表

| 文件 | 操作 | 内容 |
| --- | --- | --- |
| `apps/api/scripts/build-cli.mjs` | 新增 | ncc 程序化打包 + agents 复制 + 校验(步骤 6) |
| `apps/api/src/paths.ts` | 新增 | findRepoRoot / repoRoot / readApiVersion(步骤 2) |
| `apps/api/src/paths.test.ts` | 新增 | 上溯/兜底/version 单测(步骤 2) |
| `apps/api/src/startServer.ts` | 新增 | startServer + installShutdownHandlers(步骤 3) |
| `apps/api/src/cliArgs.ts` | 新增 | 纯函数解析 + CliError + resolvePort(步骤 4) |
| `apps/api/src/cliArgs.test.ts` | 新增 | 解析单测(步骤 4) |
| `apps/api/src/cli.ts` | 新增 | bin 入口;shebang;预检 BUILTIN_AGENTS_DIR;version 走 readApiVersion;upgrade 含 build:cli(步骤 5) |
| `apps/api/src/config.ts` | 修改 | workflowsRoot dev 分支 → repoRoot()(步骤 2) |
| `apps/api/src/app.ts` | 修改 | webDist → repoRoot();initAgentRoutes 返回 { pi, store }(步骤 2+3) |
| `apps/api/src/index.ts` | 修改 | 用 startServer + installShutdownHandlers(步骤 3) |
| `apps/api/package.json` | 修改 | devDep `@vercel/ncc@^0.38.4`;scripts.build:cli;bin.wf = dist/cli/index.js(步骤 6+7) |
| `package.json`(根) | 修改 | scripts.build:cli;bin.wf = apps/api/dist/cli/index.js(步骤 6+7) |
| `README.md` / `AGENTS.md` | 修改 | CLI 文档 + 构建说明(步骤 8) |
| `apps/api/src/pi/agentDefs.ts` | **不动** | BUILTIN_AGENTS_DIR 三布局天然正确(Q3) |
| `apps/api/scripts/copy-agents.mjs` | 不动 | 继续服务 tsc 产物 |
| `packages/shared` / `apps/web` / `turbo.json` / tsconfig | 不动 | — |
| `apps/api/dist/.probe` | 临时 | spike 产物,步骤 1 后删除 |

---

## 5. ncc 特有风险与回滚点

| 编号 | 风险 | 等级 | 缓解 | 回滚点 |
| --- | --- | --- | --- | --- |
| R1 | ncc 打包依赖图失败(`.js` 后缀解析 / pnpm symlink / JSON attributes / TLA) | 中 | 步骤 1 spike 先行判定;失败按具体报错:加 `externals`、检查 tsconfig;TLA 命中则排查具体依赖 | **门禁 No-Go 即中止**,回滚 A(esbuild)或回滚 B(02-plan-1 tsc 方案);spike 无代码提交 |
| R2 | ncc ESM 输出缺陷(issue #1163 类:ESM 内 createRequire 调 CJS) | 中 | 纯 ESM 依赖树影响面小;验收 A3 冒烟可当场暴露 | 切 CJS 兜底:产物改名 `dist/cli/index.cjs` + 写 `{"type":"commonjs"}` package.json,bin 指向 .cjs;改动仅限 build-cli.mjs |
| R3 | 单文件布局下路径错位(workflowsRoot / webDist) | 高(必现) | 步骤 2 paths.ts 先行收敛,paths.test.ts 覆盖三种布局 | 步骤 2 独立 commit,可单独 revert;tsc 布局在路径重构前后行为不变(验收 A12) |
| R4 | native/wasm 无法内联(ffi-rs .node、@ff-labs/fff-bin-* 平台 dll、photon-node wasm) | 中 | 已实证:fff 二进制为运行时 createRequire 动态解析 → 仓库内运行 OK;FffIndexManager 惰性创建,start 不阻塞;spike/验收各实测一次 FileFinder.create;仍失败 → `externals: ['@ff-labs/fff-node']` | 不阻塞主流程;文档注明「拷出仓库 fff 降级」;`pnpm start`(tsc)不受影响 |
| R5 | ncc 维护模式(0.38.4 后 ~半年无发布) | 低 | 功能稳定、webpack 5.94 固定;验收锁定 0.38.x | 回滚 A(esbuild) |
| R6 | `pnpm build:cli` 构建慢/产物大(10–40MB) | 低 | 独立脚本不进 turbo build;sourcemap 仅调试用;minify 留作开关 | 与功能无关,可随时调整参数 |
| R7 | build-cli 输出目录与 tsc dist 相互干扰 | 低 | 输出固定 `dist/cli/` 子目录;build-cli.mjs 开头 rmSync 该目录;copy-agents.mjs 只碰 dist/pi/agents | 步骤 6 独立 commit |
| R8 | bin symlink 悬空(install 时 dist/cli 不存在) | 低 | 文档与验收要求「先 build + build:cli」;`pnpm exec wf` 报错可读 | — |
| R9 | upgrade 重建自身失败(旧 bundle 跑新构建) | 低 | upgrade 末尾 `pnpm build:cli`,失败即中止退出非 0;git reflog 可回退 | — |

02-plan-1 中的既有风险(NODE_ENV 覆盖语义、upgrade 破坏性、Windows spawn、MCP 子进程残留)及缓解全部沿用,不重复列。

---

## 6. 验收标准(逐条核对;A1–A13 为 02-plan-1 对应项,标注改动的以本版为准)

- [ ] A1 `pnpm typecheck && pnpm test && pnpm build` 全绿(含新增 cliArgs.test.ts、paths.test.ts)。
- [ ] A2' `apps/api/dist/cli/index.js` 存在且首行为 `#!/usr/bin/env node`;`dist/cli/agents/orchestrator.md` 存在;`dist/cli/package.json` 为 `{"type":"module"}`(或 ncc 生成等效);bundle 无 `Module not found` 警告。
- [ ] A3' `node apps/api/dist/cli/index.js version` 输出 `0.0.0`;`... help` 输出 HELP_TEXT;`node apps/api/dist/cli/index.js`(无参数)打印帮助退出 0。
- [ ] A4 未知命令/未知 flag 报错 + 提示 help 退出 1;`--port abc` 退出 1 且消息友好(bundle 内运行)。
- [ ] A5' `pnpm install` 后根 `node_modules/.bin/wf` 存在;`pnpm exec wf help` 从仓库根与任意子目录可用。
- [ ] A6' `HOME=$(mktemp -d) pnpm exec wf start --port 5299`:`curl /api/health` 返回 `{code:0,...}`;日志含端口 5299、production、存储根 = `$HOME/.workflows`;Ctrl+C 优雅退出、无 MCP 子进程残留。
- [ ] A7' `pnpm exec wf start --dev --port 5298`:日志含 development、存储根 = `<repo>/.workflows`(目录被创建);**同时证明单文件布局下 workflowsRoot 路径正确**。
- [ ] A8 端口优先级:`--port 5297` 与 `PORT=5296 wf start --port 5297` 均监听 5297;`PORT=5296 wf start` 监听 5296。
- [ ] A9 `--host 127.0.0.1` 仅本机可访问;缺省 host 与 `pnpm start` 一致。
- [ ] A10' 删除/改名 `dist/cli/agents` 后 `wf start` → 报「请先运行 pnpm build && pnpm build:cli」退出 1。
- [ ] A11' `wf upgrade` 干净工作区执行成功(pull/install/build/build:cli 日志齐全),结束后 `wf version` 仍可用;dirty 工作区默认拒绝、`--force` 通过。
- [ ] A12 `pnpm start`(tsc 原入口)行为与改造前一致(路径重构回归)。
- [ ] A13 README/AGENTS.md 已更新,可照文档从零跑通 wf。
- [ ] A14 依赖链实测(风险项):bundle 内发起一次工作区会话并调用 fff-find 工具,或至少在 bundle 内执行 `FileFinder.create` 探针;若 fff 加载失败,确认错误被 FffIndexManager 捕获(返回 null 不崩溃)并记录为已知限制。
- [ ] A15 `dist/.probe` 已清理;`git status` 无意外文件。

---

## 7. 权衡总结(ncc vs tsc,结论段)

ncc 单文件方案在本项目的定位:CLI 作为「仓库内一体化工具」,收益集中在**单入口产物 + JS 依赖自包含 + bin 极简 + 启动快**;代价是**构建慢、产物大(10–40MB)、排障依赖 sourcemap、native 链无法内联**。tsc 多文件方案在调试与构建速度上占优,但产物是「整树 + node_modules 依赖」,与 CLI 的单一入口语义不符。**结论:ncc 适合本项目**,且 tsc build 全程保留为逃生舱与 `pnpm start` 基线;步骤 1 spike 门禁把主要不确定性前置消化,No-Go 时回滚路径明确(esbuild → 02-plan-1)。
