# 实施计划(全局发布版):workflows → `pnpm i -g workflows` + `wf start`

> 基于 `.wf-runs/89fdd581/01-exploration-1.md` 与 `02-plan-2.md` 重写。核心场景变更:**CLI 不再只是仓库内一体化工具,而是发布为 npm 全局包(`workflows`),用户 `pnpm i -g workflows` 后终端直接 `wf start`**。
> 保留 02-plan-2 全部有效决策:ncc 单文件、agents .md 旁路复制、startServer 提取、cliArgs 纯函数、NODE_ENV/端口语义、tsc build 保留为回归基线。
> 本计划只读;实施阶段按步骤改代码,改动集中在:新增 `packages/cli` 发布包 + `apps/api/src` 少量文件 + 根 package.json + 文档。

---

## 0. 调研新增事实(本版独有,已逐一实证)

| # | 事实 | 来源 | 对计划的影响 |
| --- | --- | --- | --- |
| F1 | **npm 公共 registry 上 `workflows` 包名已被占用**:`workflows@1.0.1`,deprecated,10 年前发布,0 dependents,作者留言 "Did you mean `workflow`?"(即废弃占位包) | npmjs.com/package/workflows(搜索结果实证) | **GATE-0**:公共 npm 无法直接发布该名;需用户决策(见 §1 Q7 / 步骤 0) |
| F2 | `@ff-labs/fff-node@0.10.1` 的 `binary.js`:`getPackageDir()` 从自身模块位置**向上找 `name==="@ff-labs/fff-node"` 的 package.json**(≤5 级),再 `createRequire(...).resolve('@ff-labs/fff-bin-<platform>/package.json')` 定位平台 dll;`ffi.js` **静态 import `ffi-rs`** | 已读 `apps/api/node_modules/@ff-labs/fff-node/dist/src/binary.js`、`ffi.js` | **ncc 必须 `externals: ['@ff-labs/fff-node']`** 且发布包必须声明 `dependencies: {"@ff-labs/fff-node": "0.10.1"}`;否则 bundle 内 getPackageDir 找不到自身包名 → fff 静默降级 |
| F3 | `ffi-rs@1.3.4` **无 install/postinstall 脚本**(napi-rs 模式:平台二进制走 `@yuuang/ffi-rs-*` optionalDependencies,运行时解析);`@ff-labs/fff-bin-*` 同理为纯二进制包 | 已读 `node_modules/.pnpm/ffi-rs@1.3.4/.../package.json` | **pnpm 10 的 onlyBuiltDependencies 拦截不影响全局安装**;externals fff-node 后其转依赖自行解析 ✓ |
| F4 | `@earendil-works/pi-coding-agent@0.83.0` `engines.node >=22.19.0`;依赖 `@silvia-odwyer/photon-node@0.3.4`(wasm,经 `@napi-rs/wasm-runtime` 运行时加载) | 已读 pi-coding-agent/package.json | 发布包 engines 应声明 `>=22.19.0`(根包 20.19 是仓库开发基线,不一致需在步骤 0 确认);photon-node wasm 是否可被 ncc asset-relocator 处理 → **spike 检查点**,失败则加入 externals + dependencies |
| F5 | pnpm 官方(pnpm 维护者 zkochan)**确认支持 workspace 内重名包**("multiple projects with the same name are supported by pnpm") | pnpm#5957 | 根包(私有)与 `packages/cli`(发布)可同名 `workflows`;脚本用 `--filter ./packages/cli` 路径形式避免歧义 |
| F6 | `packages/*` 已覆盖新包目录(pnpm-workspace.yaml 无需改动);`.gitignore` 的 `dist/` 全局匹配已覆盖 `packages/cli/dist`;npm pack 的 `files` 白名单**优先于 gitignore**(dist 可被 gitignore 同时被打包) | 已读 pnpm-workspace.yaml / .gitignore;npm pack 语义 | 发布包零配置进 workspace;dist 不入 git 但进 tarball ✓ |
| F7 | `apps/web/vite.config.ts` 未设 `build.outDir` → 产物默认 `apps/web/dist`(现状即生产托管目录);`app.ts` 的 `webDist` 现为模块相对路径(两级上跳) | 已读 vite.config.ts / app.ts | 发布包内 web 资源统一复制到 `packages/cli/dist/web`(见 Q2) |
| F8 | 根 package.json `name: "workflows"` 无任何代码/脚本引用(grep 仅命中 .wf-runs 元数据)→ 同名发布包可行,无需改名根包 | fff-grep 实证 | 见 F5 决策 |

---

## 1. 十个问题的决策(逐条)

### Q1 发布包形态:选 **C — 新建独立发布包 `packages/cli`**(name=`workflows`)

| 选项 | 结论 | 理由 |
| --- | --- | --- |
| A:根 package.json 去 private 作载体 | ✗ | ① 根包是 pnpm/turbo 工作区根,`prepare: husky` 会在 pack 时执行、发布元数据混入 dev 工具链;② 版本/依赖/engines 与开发工具耦合;③ tarball 需深路径白名单(`apps/api/dist/cli`、`apps/web/dist`),路径语义别扭;④ 一旦发布元数据改坏影响全仓安装 |
| B:apps/api 改名作载体 | ✗ | ① `@workflows/api` 改名 `workflows` 需改根 scripts 的 `--filter @workflows/api` 及文档;② 发布面与源码包纠缠(web dist 须复制进 apps/api);③ 与根包同名同 A 的耦合问题 |
| **C:新独立包 `packages/cli`** | **✓ 选定** | ① 发布面显式、最小(`files: ["dist"]`),不泄漏工作区配置/源码/测试;② 版本、dependencies、engines、bin 独立于开发工具链;③ `packages/*` glob 自动纳入 workspace,零配置;④ 根包与发布包同名受 pnpm 支持(F5),`--filter ./packages/cli` 无歧义;⑤ prepack 自足构建,`pnpm pack`/`publish` 语义干净 |

**包内必须包含**(用户确认的三类内容):CLI 单文件(`dist/cli/index.js` + sourcemap)、agents .md(`dist/cli/agents/`)、web 静态资源(`dist/web/`,生产单端口托管)。

**发布包最终布局**:
```
packages/cli/
├── package.json          # name: workflows(发布载体)
├── README.md             # 简短包说明(npm 自动携带)
├── scripts/build-cli.mjs # ncc 打包 + agents/web 复制 + 校验(prepack 调用)
└── dist/                 # gitignored;prepack 生成,`files: ["dist"]` 全量进包
    ├── cli/
    │   ├── index.js      # ncc 单文件(ESM,shebang)
    │   ├── index.js.map
    │   └── agents/*.md   # apps/api/src/pi/agents 旁路复制
    └── web/**            # apps/web/dist 整体复制
```
> 与 02-plan-2 差异:发布物从 `apps/api/dist/cli` 迁移到 `packages/cli/dist/cli`(仓库内运行 bundle 也走此路径,全局/仓库两种布局统一,见 Q4);apps/api 不再承担 bin/ncc。

### Q2 files 字段与 web 资源纳入

- `packages/cli/package.json`:`"files": ["dist"]`——一切都在 `dist/` 内(bundle + agents + web),白名单优先于 gitignore(F6),`dist/` 不入 git 但完整进 tarball。
- web 纳入方式:**prepack 构建时复制**,不直接引用 `apps/web/dist`(npm pack 只能打包包内路径):
  - `build-cli.mjs` 第 5 步:`cpSync('apps/web/dist', 'packages/cli/dist/web', {recursive: true})`,前置校验 `apps/web/dist/index.html` 存在,缺失报「请先运行 pnpm -w build」exit 1。
- npm 自动携带:package.json + README.md(包内自建,根 README 不会被自动带入)。

### Q3 prepack 生命周期(发布前构建链路)

```jsonc
// packages/cli/package.json scripts
"build:cli": "node scripts/build-cli.mjs",          // ncc + 复制 + 校验
"prepack":  "pnpm -w build && pnpm build:cli"       // 自足:全仓构建 → 打包 CLI
```
- `pnpm -w build` = 根 turbo build(shared → api tsc → web vite;packages/cli 无 `build` 脚本,turbo 自动跳过,无递归);`pnpm build:cli` = ncc + agents + web 复制。
- `prepack` 在 `pnpm pack` **和** `pnpm publish` 时都会执行 → 本地验证与真实发布走同一条链路,杜绝「本地能跑、发布物过期」。
- 产物路径关系:build-cli.mjs 以仓库根为基准(脚本内 `fileURLToPath` 定位 `packages/cli/scripts/` 上溯 3 级),ncc 输入 `apps/api/src/cli.ts`(跨包入口,绝对路径),输出 `packages/cli/dist/cli`,`filterAssetBase: <repoRoot>`。
- 发布根目录 = `packages/cli`;发布命令:`cd packages/cli && pnpm publish`(见 Q7)。

### Q4 全局安装后的运行时路径(核心重设计)

**02-plan-2 的 `findRepoRoot()`(找 pnpm-workspace.yaml)在全局安装下必然失败兜底 cwd——废弃。** 新原语 `findPkgRoot()`:**从模块位置向上 ≤8 级,找第一个 `package.json` 且 `name === 'workflows'` 的目录**(F1/F5 使根包与发布包同名,单一标记覆盖全部布局):

| 运行布局 | 模块位置 | pkgRoot 命中 | webDist 候选命中 |
| --- | --- | --- | --- |
| dev(tsx) | `apps/api/src/` | 仓库根(root name=workflows) | `<root>/apps/web/dist`(vite 场景下不存在也不影响,app.ts 照旧降级) |
| tsc(`pnpm start`) | `apps/api/dist/` | 仓库根 | `<root>/apps/web/dist` ✓(回归基线不变) |
| 仓库内 bundle | `packages/cli/dist/cli/` | `packages/cli` | `<pkg>/dist/web` ✓ |
| **全局安装** | `node_modules/workflows/dist/cli/` | `workflows` 包根 | `<pkg>/dist/web` ✓ |

**`apps/api/src/paths.ts` 设计**(替换 02-plan-2 的 repoRoot 版,纯函数可单测):
```ts
export function findPkgRoot(startDir?: string): string | undefined
// 缺省 startDir = 本模块目录;向上 ≤8 级找 name==='workflows' 的 package.json;找不到返回 undefined
export function pkgRoot(): string                 // findPkgRoot() ?? process.cwd()
export function readPkgVersion(): string          // 读 pkgRoot()/package.json 的 version,失败回退 '0.0.0'
export function resolveWebDist(): string | undefined
// 候选按序:[pkgRoot()/dist/web, pkgRoot()/apps/web/dist],首个 existsSync 命中即返回;全无 → undefined
```
- **app.ts 改动**:`webDist` 模块级常量 → `resolveWebDist()`(候选列表统一了「仓库内 tsc/tsx 布局」与「包内布局」两种约定;仓库内 `dist/web` 不存在,不会误命中)。
- **config.ts 改动**:`workflowsRoot()` 增加 `WF_DATA_ROOT` 环境变量优先级(见 Q8);dev 分支 `path.join(pkgRoot(), '.workflows')`。
- **agentDefs.ts 不动**:`BUILTIN_AGENTS_DIR = dirname(import.meta.url)/agents` 在四种布局下天然正确(agents 始终与 bundle/模块同层,发布包内即 `dist/cli/agents`)。
- **存储根 `~/.workflows` 仍然合理**:与现有生产语义一致(homedir() 在 Windows 解析 USERPROFILE);启动日志打印存储根。CLI 无仓库概念后,`--dev` 的存储根改为 `~/.workflows-dev`(见 Q8),避免写进全局包目录或任意 cwd。

### Q5 bin 注册

- **发布包**:`packages/cli/package.json` → `"bin": { "wf": "dist/cli/index.js" }`。全局安装时 npm/pnpm 自动创建 `wf` shim(Windows 生成 .cmd/.ps1,Unix 生成 shell 脚本 + 保留可执行位)。**一个 bin 注册即可,不需要「双注册」**。
- **仓库开发便利**(可选保留):根 package.json → `"bin": { "wf": "packages/cli/dist/cli/index.js" }`,`pnpm install` 生成根 `.bin/wf`,仓库内 `pnpm exec wf` 可用。与发布 bin 指向**同一文件**;文档注明「先 `pnpm install && pnpm -w build && pnpm build:cli`」,否则 symlink 悬空。
- apps/api **不加** bin(不再是发布面)。
- ncc 保留输入 shebang(`#!/usr/bin/env node`);`packages/cli` 声明 `"type": "module"`,ESM bundle 直接执行;若 ncc 输出 CJS 或 ESM 翻车 → 兜底 `dist/cli/index.cjs` + 手工写 `{"type":"commonjs"}`,bin 指向 .cjs(02-plan-2 R2 保留)。

### Q6 upgrade 在全局场景的语义(自更新)

**git pull + pnpm build 全部废弃**(全局安装无仓库)。新语义:**registry 自更新**。

```
wf upgrade [--pm <pnpm|npm|yarn|bun>] [--force] [--registry <url>] [--yes]
```
1. **安装器探测**(务实优先级):
   - `--pm` 显式指定 > `WF_INSTALL_CMD` 环境变量 > `npm_config_user_agent` 前缀(pnpm/npm/yarn/bun)> PATH 顺序探测(pnpm → npm → yarn → bun;Windows 试 `pnpm.cmd` 等)。
2. **registry**:`--registry` > `npm config get registry`(spawn 读取,失败默认 `https://registry.npmjs.org`)。安装与更新同 registry,保证一致。
3. **最新版本探测**:Node 内置 `fetch('<registry>/workflows/latest')`(公共 registry 免认证;私有 registry 401/失败 → 打印提示让用户手动 `npm view workflows version`)。与 `readPkgVersion()` 做简易 semver 比较(数值段比较,不引依赖)。
4. **执行安装命令**:
   - pnpm → `pnpm i -g workflows@latest --registry=<url>`
   - npm → `npm i -g workflows@latest --registry=<url>`
   - yarn → `yarn global add workflows@latest --registry=<url>`(语法以实际 CLI 为准)
   - bun → `bun add -g workflows@latest --registry=<url>`
   - Windows 一律 `spawn(cmd, args, { shell: true })` 走 `.cmd` shim(02-plan-2 既有决策)。
5. **权限问题(务实方案)**:先直接尝试执行;失败时**捕获退出码 + stderr 中的 EACCES/EPERM/权限字样** → 打印手动命令:
   - POSIX:提示 `sudo <安装命令>`(nvm/fnm/volta 用户前缀可写时无需 sudo,说明两种情形);
   - Windows:说明 npm/pnpm 全局 prefix(如 `%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`)为用户可写,一般无需管理员;若 EPERM,提示检查目录写权限。
6. **成功后**:重新 spawn `wf version`(新 shim)打印新版本,提示「当前进程仍为旧版本,请重启 wf 会话」。
7. `--force`:版本相同也重装;`--yes`:跳过确认(默认交互确认)。
8. 数据安全:upgrade 不触碰 `~/.workflows`;全局包目录替换是原子的,失败时旧版本仍可用(回滚天然)。

### Q7 版本与发布流程

- **版本号管理:手动 `pnpm version`(在 packages/cli 目录内执行)+ git tag `vX.Y.Z`**。changesets 对单人项目过重,列为后续可选。版本只存在于 `packages/cli`(根包保持 private 0.0.0 不再与发布相关);`wf version` 读 `pkgRoot()/package.json` → 仓库内 bundle 与全局安装读到同一版本语义 ✓。
- **registry 选择(GATE-0,需用户决策,证据见 F1)**:
  - 公共 npm:`workflows` 名被 deprecated 占位包占用,**不能直接发布**。路径:① 向 npm 支持申请转让废弃包名(0 dependents + 10 年 + 作者自标废弃,成功率尚可但周期不可控);② 改名/加 scope(违背用户需求,备选)。
  - **推荐默认:私有 registry 先行**(GitHub Packages 的 npm registry 支持 unscoped 名;或 Verdaccio/Cloudsmith):`pnpm i -g workflows --registry=<私有>` 即可满足「wf start 即用」;日后名号转让成功,切公共 npm 只改一行 publishConfig/命令。
  - 本计划代码层面对 registry **完全无关**(upgrade 已按 registry 配置驱动);步骤 0 定 registry,步骤 8 发布。
- **元数据**:`description`、`keywords`、`license`(**根包现无 license 字段,步骤 0 需确认,默认 MIT**)、`homepage`/`repository`(指向本仓库)、`engines: { "node": ">=22.19.0" }`(**对齐 pi-coding-agent F4**;若 spike 证明 20.19 可运行可放宽,但发布声明以实际依赖要求为准)。
- **不需要 .npmignore**(`files` 白名单优先,F6);需要包内 README.md。

### Q8 NODE_ENV 语义

- **`wf start`(默认)= production:存储根 `~/.workflows` + 端口 5200 —— 合理,与现有生产语义一致,保留。**
- `--dev` 保留:development NODE_ENV + 默认端口 3000;存储根改为 **`~/.workflows-dev`**(全局安装下无仓库概念,02-plan-2 的「仓库内 .workflows」不适用;`~/.workflows-dev` 可预测、不污染生产数据、不写 cwd)。
- 实现:`workflowsRoot()` 优先级:**`WF_DATA_ROOT` env > production → `~/.workflows` > dev → `pkgRoot()/.workflows`**;`wf start --dev` 在 cli.ts 中设置 `process.env.WF_DATA_ROOT = path.join(homedir(), '.workflows-dev')`(在一切业务模块执行前,与 NODE_ENV 同批设置)。
- 兜底语义:全局安装下若用户手动 `export NODE_ENV=development` 且未设 WF_DATA_ROOT,dev 分支会落到全局包目录——文档明确警告「CLI 请用 --dev,勿手动设 NODE_ENV」(cli.ts 自身总是二选一设置,不会触发)。

### Q9 Windows 兼容

- **shebang + shim**:npm/pnpm 全局安装生成 `wf.cmd`/`wf.ps1`(Windows)与 shell 脚本(Unix),直接以 `node <bundle>` 方式调用,**不依赖 shebang 执行**(shebang 仅 Unix 直接执行 `./index.js` 时生效;ncc 保留之)。✓ 无需额外处理,验收在 Windows 跑 `wf help/start`。
- **fff dll 路径**:externals 方案下(F2),`@ff-labs/fff-node` 作为真实依赖装入全局 node_modules(pnpm 全局隔离布局 `.../global/5/node_modules/workflows/node_modules/@ff-labs/fff-node`),其 `binary.js` 的 createRequire 解析、`@ff-labs/fff-bin-win32-x64`(optionalDependencies)均按其自身模块位置解析 → **Windows 全局布局下 dll 可解析** ✓。若未 externals 而内联,getPackageDir 向上找不到自身包名 → 直接失效(验收必须覆盖)。
- **upgrade**:`shell: true` + `.cmd`(见 Q6)。
- 路径/大小写/junction:现有 `samePath()`/`listDirectory()` 已处理,不涉及。

### Q10 验收清单(全局发布场景)

核心验证路径:**本地 `pnpm pack`(触发 prepack 全链路)→ 全局安装 tarball → 冒烟 → 卸载**;完整清单见 §6。

---

## 2. 目标与范围

### 做
1. 新增发布包 `packages/cli`(name=`workflows`):bin `wf` → `dist/cli/index.js`;`files: ["dist"]`;prepack 自足构建;包内含 CLI 单文件 + agents .md + web 静态资源。
2. `wf` 命令集:help / version / start(--port、--host、--dev)/ upgrade(--pm、--force、--registry、--yes);**upgrade 改为 registry 自更新**。
3. 路径体系重构:`paths.ts` 以 `findPkgRoot()`(name 标记)统一四种布局;`resolveWebDist()` 候选列表;`WF_DATA_ROOT` 存储根覆盖;`--dev` 存储根 `~/.workflows-dev`。
4. ncc 打包 + externals(F2 确定 `@ff-labs/fff-node`;spike 确定 photon-node/wasm 链是否追加)+ agents/web 复制,全部收敛到 `packages/cli/scripts/build-cli.mjs`。
5. 单测(cliArgs / paths / upgrade 纯函数)+ tsc build 与 `pnpm start` 回归基线 + 全局安装冒烟(§6)。
6. 文档:README 全局安装章节、AGENTS.md、packages/cli/README.md。

### 不做
- 不改 pnpm-workspace.yaml、turbo.json、tsconfig、packages/shared、apps/web 构建配置。
- 不把 build:cli 并入 turbo build(保持日常构建速度;prepack 内部显式编排)。
- 不做 changesets / CI 发布流水线(列为后续);不做 `--minify`(留作一行开关);不做守护进程/自重启;不新增业务命令。
- 不向 npm 公共 registry 强推(名称被占,GATE-0 定夺);不处理「全局安装后 cwd 内运行时的仓库语义」(CLI 与仓库解耦,仓库开发仍走 pnpm dev/start)。
- 不保证 bundle 内联 photon-node wasm(spike 决定 externals 与否,两者都有路径)。

---

## 3. 实施步骤(按序执行,每步可独立验证与回滚)

### 步骤 0:两个门禁 + 元数据确认(不写业务代码)

**0a. 包名/registry 决策(GATE-0,证据 F1)**
- 事实已实证:`npm view workflows` 将返回 deprecated v1.0.1(公共 registry 名被占)。
- 决策点(需用户拍板,二选一后继续):
  - **路径甲(推荐)**:私有 registry(GitHub Packages 或 Verdaccio)发布 unscoped `workflows`;README 写明 `pnpm i -g workflows --registry=<url>`(或用户 npmrc 配置);并行向 npm support 申请转让废弃名,成功后再切公共 npm(只改发布命令与 README)。
  - **路径乙**:公共 npm 发布 scoped 名(如 `@<user>/workflows`)——安装命令变为 `pnpm i -g @<user>/workflows`,与用户原需求不符,需确认。
- 无论甲乙,本计划代码与步骤 1–7 全部不变;步骤 8 按所选 registry 执行。
- 产出:在 `.wf-runs/89fdd581/run.json` 或本计划追加「决策记录」;若甲,创建/确认私有 registry 账号与 npmrc 认证。

**0b. pnpm 重名安装验证(GATE-0b,证据 F5)**
- 临时创建 `packages/cli/package.json`(仅 name/version/type,无脚本)→ `pnpm install` → 确认无错误、`pnpm --filter ./packages/cli` 可用、turbo 不受影响。
- Go:`pnpm --filter ./packages/cli run` 正常;No-Go(任何工具报重名):回退方案 = 根包改名 `workflows-monorepo` + `findPkgRoot()` 接受 `workflows`/`workflows-monorepo` 双标记(改动点:根 package.json 一行 + paths.ts 一行,不阻塞)。

**0c. 元数据确认**
- license(默认 MIT)、author、repository/homepage、`engines.node >=22.19.0`(F4,若 spike 证明可放宽则记录)。

**预期结果**:GATE-0/0b/0c 全部落定,进入步骤 1。

---

### 步骤 1:ncc 可行性 spike(含 externals 决策,不提交业务代码)

**目的**:回答 02-plan-2 Q10 全部检查点 + 本版新增的 externals 决策(F2/F4)。

**临时执行**(不改仓库):
```bash
pnpm install   # 确保全仓依赖
pnpm -w build  # 确保 shared/api/web dist 存在
# 在 packages/cli 内临时安装 ncc 并直接打实际入口:
cd packages/cli && pnpm add -D @vercel/ncc@^0.38.4   # 正式步骤 6 会再次声明,此处先行
node -e "
const ncc = require('@vercel/ncc');
ncc('../../apps/api/src/cli.ts', { externals: ['@ff-labs/fff-node'], minify: false, sourceMap: true, target: 'es2022', cache: false, filterAssetBase: process.cwd() + '/../..' })
  .then(({ code, map, assets }) => { console.log('OK', code.length, Object.keys(assets)); })
  .catch(e => { console.error(e); process.exit(1); })"
```
(cli.ts 尚不存在,spike 期间以临时最小入口 `import { app } from '../../apps/api/src/app.js'; console.log('loaded')` 代替,验证依赖图;正式 cli.ts 在步骤 5 落地后由步骤 6 复验。)

**检查项**:
1. `.js` 后缀导入、pnpm symlink、pi-ai JSON import attributes 均解析成功(无 `Module not found`);
2. 无 `Top-level-await` 报错;产物为 ESM;
3. `import.meta.url` 在 bundle 内有效(app.ts 顶层 webDist 计算不抛错);
4. **fff-node 链**:bundle 内 `import '@ff-labs/fff-node'` 保留为外部 require(检查产物含 `from"@ff-labs/fff-node"` 字样),运行期在仓库内可 `FileFinder.create` 成功(用临时探针脚本);
5. **photon-node/wasm 链**:bundle 加载 `pi-coding-agent` 不抛错;若报 wasm 加载错 → 追加 `externals: ['@silvia-odwyer/photon-node']`(并在正式 dependencies 声明)复测;记录结论;
6. 记录产物大小与构建时长(预估 10–40MB / 数十秒)。

**Go/No-Go**:
- Go:1–4 全过(5 有明确结论)→ 继续。
- No-Go:按 02-plan-2 §5 R1/R2 缓解(externals 调整、CJS 兜底);仍失败 → 回滚 A(esbuild --bundle)或回滚 B(tsc 多文件 + 发布包只做复制打包,见 §5)。
- 清理临时产物;`pnpm remove -D @vercel/ncc`(步骤 6 正式安装)。

**预期结果**:拿到 externals 终稿清单(预期 `['@ff-labs/fff-node']`,photon-node 视检查项 5)与产物规模数据。

---

### 步骤 2:路径体系重构 `paths.ts`(纯重构,独立 commit)

**改动文件**:
- **新增 `apps/api/src/paths.ts`**:`findPkgRoot(startDir?)`(向上 ≤8 级,`name==='workflows'` 命中;缺省 startDir = 本模块目录;实现时用 `readFileSync` 读 package.json 而非 require,规避 webpack 静态处理)、`pkgRoot()`(兜底 `process.cwd()`)、`readPkgVersion()`(读 `pkgRoot()/package.json` version,异常回退 `'0.0.0'`)、`resolveWebDist()`(候选 `[pkgRoot()/dist/web, pkgRoot()/apps/web/dist]` 首个存在;注释四布局上溯路径表,同 Q4)。
- **修改 `apps/api/src/config.ts`**:`workflowsRoot()` 增加 `WF_DATA_ROOT` 分支;dev 分支 → `path.join(pkgRoot(), '.workflows')`;删除 `fileURLToPath` import(如无其他用途)。
- **修改 `apps/api/src/app.ts`**:`webDist` 常量 → `resolveWebDist()`(删除模块级 `fileURLToPath`);`hasWebDist` 语义不变(undefined → 不托管,API-only)。
- **新增 `apps/api/src/paths.test.ts`**:临时目录造 `package.json {name:'workflows'}` 验证上溯命中/未命中兜底 cwd/版本读取/`resolveWebDist` 候选顺序(两个候选都存在时取 dist/web)。

**预期结果**:`pnpm --filter @workflows/api typecheck && pnpm --filter @workflows/api test` 全绿;`pnpm start` 行为与改造前一致(回归基线 A12)。

---

### 步骤 3:提取 `startServer.ts`(同 02-plan-2 步骤 3,零行为变化)

**改动文件**:
- **新增 `apps/api/src/startServer.ts`**:`StartServerOptions { port; host? }`、`StartedServer { pi; store; server; port }`、`startServer()`(initAgentRoutes → serve → listening → 打印端口/模式/存储根/是否托管 web)、`installShutdownHandlers(pi)`(SIGINT/SIGTERM → dispose + 5s 兜底,自 index.ts 原样搬入)。
- **修改 `apps/api/src/app.ts`**:`initAgentRoutes(): Promise<{ pi: PiAgentService; store: WorkflowsStore }>`(内部 `createStore()` 后返回;全仓仅 index.ts 调用,app.test.ts 不调用)。
- **修改 `apps/api/src/index.ts`**:瘦身为 `startServer({ port })` + `installShutdownHandlers(pi)`,端口逻辑原样。

**预期结果**:typecheck/test/build 全绿;`pnpm start` 启动/退出与改造前一致。

---

### 步骤 4:CLI 参数解析纯函数 + 单测(同 02-plan-2 步骤 4,upgrade 参数更新)

**改动文件**:
- **新增 `apps/api/src/cliArgs.ts`**:`CliCommand`(help/version/start{port,host,dev}/upgrade{pm?,force,registry?,yes})、`parseCliArgs(argv)`(Node `util.parseArgs`,strict;未知命令/flag → `CliError`)、`CliError`、`defaultPort(dev)`、`resolvePort(dev, portFlag?, portEnv?)`(`--port` > `PORT` > 默认;1–65535 校验)。
- **新增 `apps/api/src/cliArgs.test.ts`**:缺省 help、port 非法值、--dev 默认 3000、PORT 回退、--port 优先、upgrade 各参数解析、未知命令/flag、-h/-v 短路。

**预期结果**:`pnpm --filter @workflows/api test` 新增用例全绿。

---

### 步骤 5:CLI 入口 `src/cli.ts`(全局语义版)+ `upgrade.ts`

**改动文件**:
- **新增 `apps/api/src/upgrade.ts`**(纯函数与 spawn 分离,纯函数可单测):
  - `detectInstaller(env, argvPm): 'pnpm'|'npm'|'yarn'|'bun'`(Q6 探测链);
  - `compareVersions(a, b): number`(数值段 semver 比较);
  - `resolveRegistry(flag?, env): string`(`--registry` > `npm config get registry` spawn > 默认 `https://registry.npmjs.org`);
  - `fetchLatestVersion(registry): Promise<string | null>`(Node fetch `<registry>/workflows/latest`;非 2xx/网络错 → null);
  - `installCommand(pm, registry): { cmd, args }`(Q6 表);
  - `runUpgrade(opts)`:编排 版本比较 → 确认 → spawn(Windows `shell:true` + `.cmd`)→ 失败识别 EACCES/EPERM 打印手动命令(含 sudo/Elevated 提示)→ 成功重跑 `wf version` 验证 + 重启提示;数据安全注释(不触碰 ~/.workflows)。
- **新增 `apps/api/src/upgrade.test.ts`**:探测链(env/argv 各分支)、版本比较、installCommand 表。
- **新增 `apps/api/src/cli.ts`**(首行 `#!/usr/bin/env node`;`async main()` + 顶层 catch → 友好错误 + 退出码 1;**不用顶层 await**):
  - `help` → 打印 HELP_TEXT(命令集含 upgrade 新参数),exit 0;
  - `version` → `console.log(readPkgVersion())`(paths.ts),exit 0;
  - `start` → ① 无条件设置 `process.env.NODE_ENV = cmd.dev ? 'development' : 'production'`;② `--dev` 时同批设置 `process.env.WF_DATA_ROOT = path.join(homedir(), '.workflows-dev')`;③ `resolvePort(...)`;④ 预检 `existsSync(path.join(BUILTIN_AGENTS_DIR, 'orchestrator.md'))`(import 自 `./pi/agentDefs.js`),缺失 → 「wf 安装不完整,请重新安装(pnpm i -g workflows)」exit 1;⑤ `startServer({ port, host: cmd.host })` + `installShutdownHandlers(pi)`(startServer 返回 { pi })。
  - `upgrade` → `runUpgrade(cmd)`。
- 不改 `agentDefs.ts` / `copy-agents.mjs`(copy-agents 继续服务 tsc 产物)。

**预期结果**:typecheck/test 全绿;tsc 产物 `dist/cli.js` 可手动冒烟(非发布物)。

---

### 步骤 6:发布包 `packages/cli` + build-cli.mjs + bin 注册

**改动文件**:
- **新增 `packages/cli/package.json`**:
  ```jsonc
  {
    "name": "workflows",
    "version": "0.1.0",                       // 发布唯一版本源;步骤 8 起手动 pnpm version 递增
    "description": "Workflows CLI — one-command local AI agent server (wf start)",
    "type": "module",
    "license": "MIT",                          // 步骤 0c 确认
    "keywords": ["workflows", "agent", "cli"],
    "repository": { "type": "git", "url": "<本仓库>" },
    "bin": { "wf": "dist/cli/index.js" },
    "files": ["dist"],
    "engines": { "node": ">=22.19.0" },        // F4:对齐 pi-coding-agent;spike 证明可放宽则记录
    "scripts": {
      "build:cli": "node scripts/build-cli.mjs",
      "prepack": "pnpm -w build && pnpm build:cli"
    },
    "dependencies": { "@ff-labs/fff-node": "0.10.1" /* + spike 确定的 externals(如 photon-node) */ },
    "devDependencies": { "@vercel/ncc": "^0.38.4" }
  }
  ```
- **新增 `packages/cli/scripts/build-cli.mjs`**(node 内置 fs;脚本内以 `fileURLToPath` 定位仓库根):
  1. 校验 `apps/web/dist/index.html` 存在(否则报「请先运行 pnpm -w build」exit 1);校验 `packages/shared/dist/index.js`(仅提示性,shared 为 type-only);
  2. `rmSync('dist', { recursive: true, force: true })`;`mkdir dist/cli`;
  3. 程序化 ncc:`await ncc(path.resolve('apps/api/src/cli.ts'), { externals: <spike 终稿>, minify: false, sourceMap: true, target: 'es2022', cache: false, filterAssetBase: <repoRoot> })`;
  4. 写 `dist/cli/index.js`(+ `index.js.map`),遍历 `assets` 写旁路资产(保留 permissions);
  5. 复制 `apps/api/src/pi/agents` → `dist/cli/agents`(先清旧);
  6. 复制 `apps/web/dist` → `dist/web`(先清旧;校验 index.html);
  7. `chmodSync('dist/cli/index.js', 0o755)`;校验首行为 shebang;打印产物清单与大小;
  8. 若 ncc 未在输出目录生成 package.json,补写 `dist/cli/package.json {"type":"module"}`(兜底)。
- **修改根 `package.json`**:scripts 加 `"build:cli": "pnpm --filter ./packages/cli build:cli"`(路径形式 filter,规避重名歧义 F5);加 `"bin": { "wf": "packages/cli/dist/cli/index.js" }`(仓库内 dev 便利,Q5)。
- **新增 `packages/cli/README.md`**:简短说明 + 安装/命令速查(指向根 README 全文)。

**预期结果**:
- `pnpm install`(步骤 0b 已装)后 `pnpm build:cli` 成功;`node packages/cli/dist/cli/index.js help/version` 正常;`dist/cli/agents/orchestrator.md` 与 `dist/web/index.html` 存在;bundle 首行 shebang;bundle 含外部引用 `@ff-labs/fff-node`(验证 externals 生效);
- `pnpm exec wf help` 从仓库根可用;
- `pnpm --filter ./packages/cli pack --dry-run` 预览 tarball 内容 = `dist/cli/index.js` + map + agents + web + package.json + README(无泄漏)。

---

### 步骤 7:文档更新

**改动文件**:
- **修改 `README.md`**:
  - 新增「全局安装」章节:`pnpm i -g workflows`(私有 registry 场景附 `--registry` 与 npmrc 配置说明);`wf help/version/start/upgrade` 速查;端口与存储根语义表(`--port` > `PORT` > 默认;production → `~/.workflows` 5200;`--dev` → `~/.workflows-dev` 3000);upgrade 说明(自更新、--pm/--registry/--force、权限提示);数据安全提示;
  - 「命令」区保留仓库开发命令(pnpm dev/start/build)并注明与 wf 的关系;
  - 「维护者发布指南」:版本递增(`cd packages/cli && pnpm version patch` + git tag)→ `pnpm -w build && pnpm build:cli` → `pnpm pack` 验证 → `pnpm publish`(或私有 registry 命令);注明「先 pnpm install 再发布,prepack 会全量构建」。
- **修改 `AGENTS.md`**:命令列表追加 wf 命令 + 发布包结构说明。
- 若 GATE-0 选路径甲:README 写明私有 registry 安装方式与切换公共 npm 的条件。

**预期结果**:照文档可从零跑通「仓库开发」与「全局安装」两条路径。

---

### 步骤 8:发布演练与全局冒烟(验收 §6 全项)

**改动文件**:无代码改动;执行验证:
1. `pnpm -w build && pnpm build:cli && pnpm test && pnpm typecheck`;
2. `cd packages/cli && pnpm pack` → 生成 `workflows-<v>.tgz`(prepack 自动触发全链路);
3. **全局安装模拟(核心验收)**:`pnpm i -g ./packages/cli/workflows-<v>.tgz` → `which wf` / `pnpm bin -g` 确认 shim;隔离 HOME 冒烟(见 §6 B 组);
4. `pnpm rm -g workflows` 卸载;
5. 按 GATE-0 所选 registry 执行真实发布(私有 registry 先试;公共 npm 需名号转让完成),发布后 `pnpm i -g workflows@<v> --registry=<url>` 复验;
6. 可选:Windows 机器重复 B 组核心项。

**预期结果**:§6 验收清单全绿;发布物可被全新环境安装并 `wf start`。

---

## 4. 文件清单总表

| 文件 | 操作 | 内容 |
| --- | --- | --- |
| `packages/cli/package.json` | 新增 | 发布载体:name=workflows、bin、files、prepack、dependencies(externals 终稿)、engines、license(步骤 6) |
| `packages/cli/scripts/build-cli.mjs` | 新增 | ncc 打包 + agents/web 复制 + chmod/shebang/产物校验(步骤 6) |
| `packages/cli/README.md` | 新增 | 包说明 + 命令速查(步骤 6) |
| `apps/api/src/paths.ts` | 新增 | findPkgRoot / pkgRoot / readPkgVersion / resolveWebDist(步骤 2) |
| `apps/api/src/paths.test.ts` | 新增 | 上溯/兜底/版本/候选顺序单测(步骤 2) |
| `apps/api/src/startServer.ts` | 新增 | startServer + installShutdownHandlers(步骤 3) |
| `apps/api/src/cliArgs.ts` | 新增 | 纯函数解析 + CliError + resolvePort(步骤 4) |
| `apps/api/src/cliArgs.test.ts` | 新增 | 解析单测(步骤 4) |
| `apps/api/src/upgrade.ts` | 新增 | 探测/比较/registry/installCommand 纯函数 + runUpgrade 编排(步骤 5) |
| `apps/api/src/upgrade.test.ts` | 新增 | 纯函数单测(步骤 5) |
| `apps/api/src/cli.ts` | 新增 | bin 入口;shebang;NODE_ENV/WF_DATA_ROOT 设置;agents 预检;version 走 readPkgVersion;upgrade 走 runUpgrade(步骤 5) |
| `apps/api/src/config.ts` | 修改 | workflowsRoot:WF_DATA_ROOT 优先;dev → pkgRoot()/.workflows(步骤 2) |
| `apps/api/src/app.ts` | 修改 | webDist → resolveWebDist();initAgentRoutes → { pi, store }(步骤 2+3) |
| `apps/api/src/index.ts` | 修改 | 用 startServer + installShutdownHandlers(步骤 3) |
| `package.json`(根) | 修改 | scripts.build:cli(`--filter ./packages/cli`);bin.wf = packages/cli/dist/cli/index.js(步骤 6) |
| `apps/api/package.json` | **不动** | 无 bin、无 ncc(与 02-plan-2 差异:发布职责移至 packages/cli) |
| `README.md` / `AGENTS.md` | 修改 | 全局安装/命令/发布指南(步骤 7) |
| `apps/api/src/pi/agentDefs.ts`、`scripts/copy-agents.mjs`、`packages/shared`、`apps/web`、`turbo.json`、tsconfig | **不动** | — |

---

## 5. 全局发布特有风险与回滚点

| 编号 | 风险 | 等级 | 缓解 | 回滚点 |
| --- | --- | --- | --- | --- |
| R-PUB1 | **公共 npm 包名 `workflows` 被 deprecated 占位包占用**(F1) | 高(外部) | GATE-0 决策:私有 registry 先行 + 并行申请转让;代码 registry 无关,切换只改发布命令/README | 不阻塞代码;若用户改选 scoped 名,仅 packages/cli name 与 README 变更 |
| R-PUB2 | **externals 缺失导致 fff 全局失效**(F2:fff-node 必须 externals + dependencies 声明;photon wasm 待 spike) | 高 | 步骤 1 spike 实证;build-cli 校验 bundle 含外部引用;验收 B5 全局实测 FileFinder | externals 清单是 build-cli.mjs 一处数组;漏配只降级 fff,不影响 start(惰性创建) |
| R-PUB3 | **发布包体积**(bundle 10–40MB + map + web dist,预计 30–80MB tarball) | 中 | 记录基线;可选优化:发布时 `minify: true` + files 排除 map(一行改动);sourcemap 保留与否在步骤 6 记录决策 | 与功能无关,随时可调 |
| R-PUB4 | **web 资源路径解析**(dist/web vs apps/web/dist 双约定) | 高(必现风险,已设计) | resolveWebDist 候选列表 + paths.test 覆盖两候选;验收 B3 全局 start 必须能打开前端页面 | 步骤 2 独立 commit;tsc 布局回归 A12 |
| R-PUB5 | **prepack 自足性**(依赖 pnpm -w build 成功 → 需要全仓 dev 依赖已装) | 中 | prepack 显式编排;README 发布指南注明「先 pnpm install」;pack 失败即中止,无半成品发布 | 发布前本地 pack 全链路验证(步骤 8) |
| R-PUB6 | **engines 不一致**(根 20.19 vs pi-coding-agent 22.19,F4) | 低 | 发布包声明 >=22.19.0(步骤 0c 确认);spike 实测 | 一行字段 |
| R-PUB7 | **upgrade 权限**(sudo / Windows EPERM) | 中 | 先尝试后提示:捕获 EACCES/EPERM 打印手动命令(POSIX sudo 提示;Windows 用户级 prefix 说明);失败不影响现有安装(原子替换) | upgrade 是独立命令,失败零数据影响 |
| R-PUB8 | **workspace 重名**(根 vs packages/cli 同名 workflows,F5) | 低 | pnpm 官方支持;GATE-0b 安装验证;脚本统一 `--filter ./packages/cli` 路径形式 | 若工具异常:根改名 workflows-monorepo + findPkgRoot 双标记(2 处一行改动) |
| R-PUB9 | **bin shim 悬空**(install 时 dist 未构建) | 低 | 文档与验收要求先 build:cli;`pnpm exec wf` 报错可读 | — |
| R-PUB10 | **ncc ESM/资产链问题**(02-plan-2 Q10 全部保留) | 中 | 步骤 1 spike 门禁;externals 追加;ESM→CJS 兜底 | 门禁 No-Go 即中止;回滚 A(esbuild)/B(tsc 多文件发布包) |
| R-PUB11 | **私有 registry 下 upgrade 探测**(fetch 需认证) | 低 | fetch 失败 → 提示手动 `npm view workflows version`;安装命令带 `--registry` 一致驱动 | 仅影响 upgrade 便利性,不影响核心 |

02-plan-2 既有风险(NODE_ENV 覆盖时序、Windows spawn、MCP 子进程清理、agents 缺失预检)及其缓解全部沿用。

---

## 6. 验收标准(逐条核对)

### A 组:仓库内回归(与发布无关)
- [ ] A1 `pnpm -w build && pnpm typecheck && pnpm test` 全绿(含 cliArgs/paths/upgrade 新增用例)。
- [ ] A2 `pnpm start`(tsc 原入口)启动/退出行为与改造前一致(路径重构回归;dev/prod 存储根、端口、web 托管均不变)。
- [ ] A3 `pnpm dev` 开发链路不受影响。

### B 组:全局发布核心验收(步骤 8)
- [ ] B1 `cd packages/cli && pnpm pack` 成功(prepack 自动完成 `pnpm -w build` + ncc + 复制);tarball 内容 = `dist/cli/index.js`(+map)+ `dist/cli/agents/*.md` + `dist/web/**` + package.json + README,无工作区配置/源码/测试泄漏(`pnpm pack --dry-run` 核对)。
- [ ] B2 `pnpm i -g ./packages/cli/workflows-<v>.tgz` 成功;`which wf` 存在;`wf version` 输出与 packages/cli 版本一致。
- [ ] B3 `HOME=$(mktemp -d) wf start --port 5299`(Windows 用隔离 USERPROFILE):
  - 日志含 production、存储根 = `$HOME/.workflows`(目录被创建)、端口 5299;
  - `curl http://localhost:5299/api/health` 返回 `{code:0,...}`;
  - **`curl http://localhost:5299/` 返回前端 index.html(证明 dist/web 路径在全局布局下解析正确,R-PUB4)**;
  - Ctrl+C 优雅退出、无 MCP 子进程残留。
- [ ] B4 `wf start --dev --port 5298`:日志含 development、存储根 = `$HOME/.workflows-dev`(隔离 HOME 验证)。
- [ ] B5 **fff 全局实测**:全局安装环境下触发一次 `FileFinder.create`(经 API 会话或临时探针脚本),确认 fff-find 工具可用(证明 externals 生效,R-PUB2);若失败需能捕获为降级而非崩溃,并记录为已知限制。
- [ ] B6 `wf upgrade`(安装 tarball 版本 == 最新时):提示「已是最新」退出 0;`--force` 走安装器重装流程;`--pm npm` 显式指定生效;模拟 EACCES(如指向只读 prefix)时打印含手动命令的可读错误。
- [ ] B7 `pnpm rm -g workflows` 干净卸载(无残留 shim 报错)。
- [ ] B8 按 GATE-0 选定 registry 真实发布一版,并在全新环境 `pnpm i -g workflows@<v> --registry=<url>` 复验 B2–B3。
- [ ] B9(Windows,若可执行)重复 B2/B3/B5 核心项,确认 .cmd shim 与 dll 解析。

### C 组:构建产物静态校验
- [ ] C1 `packages/cli/dist/cli/index.js` 首行为 `#!/usr/bin/env node`;`dist/cli/agents/orchestrator.md` 存在;`dist/web/index.html` 存在。
- [ ] C2 bundle 内存在对 `@ff-labs/fff-node` 的外部引用(ncc externals 生效),且 `packages/cli/package.json#dependencies` 含其版本。
- [ ] C3 `node packages/cli/dist/cli/index.js help/version` 正常;`pnpm exec wf help` 仓库根可用(先 build:cli)。
- [ ] C4 删除/改名 `packages/cli/dist/cli/agents` 后 `wf start` 报「安装不完整,请重新安装」退出 1。
- [ ] C5 `git status` 无意外文件(dist 被 gitignore 正确排除);`dist/.probe` 等 spike 产物已清理。

---

## 7. 与 02-plan-2 的关键差异摘要

| 维度 | 02-plan-2(仓库内工具) | 02-plan-3(全局发布) |
| --- | --- | --- |
| 发布形态 | 无(私有仓库,dist/cli 即产物) | **packages/cli 独立发布包**,name=workflows,`files:["dist"]` |
| 路径原语 | `findRepoRoot()`(pnpm-workspace.yaml 标记) | `findPkgRoot()`(package.json name=workflows 标记),兼容全局 node_modules 布局 |
| web 资源 | `<repo>/apps/web/dist`(模块相对) | `resolveWebDist()` 候选列表:包内 `dist/web` / 仓库 `apps/web/dist` |
| 版本 | `readApiVersion()` 读 apps/api | `readPkgVersion()` 读 pkgRoot()/package.json(发布包唯一版本源) |
| bin | 根 + apps/api 双注册 | **packages/cli 单注册**(发布);根 bin 仅为仓库 dev 便利 |
| upgrade | git pull + pnpm install + build | **registry 自更新**(安装器探测 + --registry + 权限提示) |
| --dev 存储根 | `<repo>/.workflows` | **`~/.workflows-dev`**(WF_DATA_ROOT 机制) |
| ncc 归属 | apps/api(devDep + build:cli) | **packages/cli**(devDep + scripts/build-cli.mjs) |
| externals | 可选(仓库内可跑) | **必选 `@ff-labs/fff-node`**(+spike 决定 photon 链),并声明 dependencies |
| 硬门槛 | 无 | **GATE-0:公共 npm 包名被占**(私有 registry 先行 / 申请转让) |

---

## 8. 结论

全局发布场景把 CLI 从「仓库内一体化工具」升级为「自包含分发产物」:发布包 `packages/cli` 承载全部三类内容(CLI 单文件、agents .md、web 静态资源),`prepack` 保证发布物永远由最新构建生成;`findPkgRoot` + `resolveWebDist` 让同一份代码在仓库开发与全局安装两种布局下正确解析资源;`externals` 保住了 fff 原生索引这条唯一不能内联的链。最大的外部不确定性是 **npm 公共 registry 的包名占用**(GATE-0),代码层面已做到 registry 无关,私有 registry 可立即落地,公共 npm 待名号转让后一行切换。
