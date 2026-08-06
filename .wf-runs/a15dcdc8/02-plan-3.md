# 实施计划:发布 `@kaijia/workflows` CLI(`wf`)

> 依据探索报告 `.wf-runs/89fdd581/01-exploration-1.md`,已复核 `app.ts`/`index.ts`/`config.ts`/`agentDefs.ts`/`turbo.json`/各 package.json。
> 关键结论(已验证):全仓库 `@workflows/shared` 均为 `import type`(编译擦除)→ CLI 包零运行时依赖 shared;turbo `build` 任务已有 `dependsOn: ["^build"]` + `outputs: ["dist/**"]`,新包自动纳入依赖序。

## 0. 决策(对应"必须回答"1-2)

- **承载包:新建 `packages/cli`**(独立 npm 包,`name: "@kaijia/workflows"`)。否决根包发布:根 `private: true`、devDeps 重、`@workflows/api` 等 private 包无法成为 npm 依赖。
- **组装方式**:`packages/cli` 不手写 api 源码,用 `scripts/prepare.mjs` 从 `apps/api/src` **整树复制**到 `packages/cli/src/api/`(排除 `*.test.ts`),相对导入原样保留;web 产物与 agents .md 通过 `copy-assets.mjs` 复制进 `dist/`。**发布产物 = 单个自包含目录 `dist/`**。
- **版本读取**:`dist/cli.js` 运行时 `readFileSync(new URL('../package.json', import.meta.url))`(files 白名单天然含 package.json)。

## 1. 包骨架与根配置

**新建/修改文件**:
- `packages/cli/package.json`:
  - `name: "@kaijia/workflows"`、`version: "0.1.0"`、`type: "module"`、`bin: { "wf": "./dist/cli.js" }`、`files: ["dist"]`、`engines: { "node": ">=20.19.0" }`、`publishConfig: { "access": "public" }`
  - dependencies(照抄 apps/api,全部 npm 可解析):`@earendil-works/pi-ai ^0.83.0`、`@earendil-works/pi-coding-agent ^0.83.0`、`@ff-labs/fff-node 0.10.1`、`@hono/node-server ^2.0.12`、`@modelcontextprotocol/sdk ^1.30.0`、`hono ^4.12.34`、`picomatch ^4.0.5`、`typebox 1.3.7`、`unbash ^4.0.5`
  - devDependencies:`typescript ^6.0.3`、`@types/node`、`@workflows/shared workspace:*`(仅编译期类型,运行时零依赖)
  - scripts:`"build": "node scripts/prepare.mjs && tsc -p tsconfig.json && node scripts/copy-assets.mjs"`、`"prepack": "node scripts/prepare.mjs && tsc -p tsconfig.json && node scripts/copy-assets.mjs"`、`"typecheck": "tsc --noEmit"`(**不写 lint/test**,避免拖入 turbo lint)
- `packages/cli/tsconfig.json`:照抄 `apps/api/tsconfig.json`(NodeNext / rootDir src / outDir dist / strict / types:["node"])
- `packages/cli/.gitignore`:`src/api/`、`dist/`(src/api 是生成物,不提交)
- 根 `.npmrc`(新建):`registry=https://registry.npmjs.org/`(authToken 走用户级 .npmrc,不入库)
- 根 `package.json` 增加 `"publish:cli": "pnpm build && pnpm --filter @kaijia/workflows publish"`(先全仓库 build 保证 web dist + shared 类型就绪)
- 根 eslint 配置:确认覆盖 `packages/cli/src/cli.ts`(lint-staged 会处理;若根配置有 include 白名单则补上),`src/api/` 因 gitignore 不会被 stage

**预期结果**:`pnpm install` 通过;`pnpm build` 时 turbo 按 shared → api/web → cli 顺序构建新包(首个 build 因 web 尚未构建会失败,属预期,步骤 2-4 完成后消除)。

## 2. api 源码两处最小改动(唯一被改的现有业务代码)

**`apps/api/src/app.ts`** — webDist 弹性解析(打包后目录层级变化,现 `../../web/dist` 会解析到 `packages/web/dist` 而失效):
```ts
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
function resolveWebDist(): string {
  if (process.env.WF_WEB_DIST) return process.env.WF_WEB_DIST
  for (const rel of ['../../web/dist', 'web-dist']) {
    const p = path.resolve(moduleDir, rel)
    if (existsSync(p)) return p
  }
  return path.resolve(moduleDir, '../../web/dist')
}
const webDist = resolveWebDist()
```
仓库内行为不变(`src/` 与 `dist/` 下均命中 `../../web/dist`);CLI 包内 `dist/app.js` → 命中 `dist/web-dist`。

**`apps/api/src/index.ts`** — 抽出可复用启动函数(CLI 复用,避免复制 40 行 serve/信号逻辑):
```ts
export async function startServer(port: number): Promise<void> {
  const pi = await initAgentRoutes()
  // 现有 serve + 监听日志 + SIGINT/SIGTERM dispose + 5s 兜底逻辑,原样搬入
}
// 直接运行守卫(保持 node dist/index.js 行为不变):
const main = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (main) {
  const isProduction = process.env.NODE_ENV === 'production'
  await startServer(Number(process.env.PORT ?? (isProduction ? 5200 : 3000)))
}
```
`config.ts` 的 `workflowsRoot()` 无需改(prod → `~/.workflows` ✓;`--dev` → `packages/cli/.workflows`,gitignored,可接受)。

**预期结果**:`pnpm --filter @workflows/api build && pnpm start` 回归正常(/health + 前端页面)。

## 3. `packages/cli/src/cli.ts` 命令实现

单文件、零 CLI 依赖,`util.parseArgs`:

- 首行 `#!/usr/bin/env node`(tsc 保留 shebang;npm 自动生成 .cmd shim,Windows 可用)
- 顶层 `parseArgs({ options: { help: {type:'boolean',short:'h'}, version: {type:'boolean',short:'V'} }, allowPositionals: true })`;`parseArgs` 抛错(未知 flag)→ 打印 help 退出 1
- `--version/-V`:`readFileSync(new URL('../package.json', import.meta.url))` 取 version 打印
- `--help/-h` / 无参数:打印固定 help 文本(用法、子命令、端口优先级、存储根说明),退出 0
- `start [--port <port>] [--dev]`:
  1. 端口优先级:`--port`(parseArgs 字符串,校验整数 1-65535)→ `process.env.PORT` → **5200**
  2. `process.env.NODE_ENV = dev ? 'development' : 'production'`(**在动态 import 之前设置**)
  3. `const { startServer } = await import('./api/index.js')` → `await startServer(port)`
- `upgrade [--dry-run]`:
  - 探测安装器:`process.env.npm_config_user_agent` 首段(`pnpm/10.33.0 npm/...` → pnpm/npm/yarn/bun),映射命令:pnpm → `pnpm add -g @kaijia/workflows@latest`;npm → `npm install -g ...`;yarn → `yarn global add ...`;bun → `bun add -g ...`;未知 → npm
  - `--dry-run`:打印检测到的安装器与命令,退出 0(验收用)
  - 实跑:`spawn(cmd, { shell: true, stdio: 'inherit' })`;ENOENT 或非零退出 → 打印「请手动执行:<命令>」,退出 1(权限不足场景)

**预期结果**:`node packages/cli/src/cli.ts --help`(tsx 验证)与 `tsc` 编译通过。

## 4. 构建脚本与接线

**`packages/cli/scripts/prepare.mjs`**:`rmSync(src/api, recursive)` → `cpSync('../../apps/api/src', 'src/api', { recursive: true, filter: (s) => !s.endsWith('.test.ts') })`(含 `pi/agents/*.md`)。硬性前置校验:`apps/web/dist` 不存在则报错退出「先运行 pnpm build」(prepack 自身不触发 web 构建)。

**`packages/cli/scripts/copy-assets.mjs`**(tsc 之后):
- `rmSync('dist/api/pi/agents', recursive)` + `cpSync('src/api/pi/agents', ...)` → `dist/api/pi/agents`(agentDefs.ts 的 `BUILTIN_AGENTS_DIR = dirname/agents` 在 dist 层级自然命中)
- `rmSync('dist/web-dist', recursive)` + `cpSync('../../apps/web/dist', 'dist/web-dist')` → 前端产物

**预期结果**:`pnpm --filter @kaijia/workflows build` 产出 `dist/cli.js`(含 shebang)、`dist/api/**`、`dist/api/pi/agents/*.md`、`dist/web-dist/index.html`。

## 5. 全仓库验证

- `pnpm build`(turbo 全量)零报错;`pnpm typecheck` 通过
- `pnpm start` 回归:api 生产模式端口/前端托管/优雅退出不受步骤 2 影响
- `node packages/cli/dist/cli.js --version` / `--help` 正常;`wf start` 冒烟(见步骤 6 命令)

## 6. 打包冒烟(tarball,不触网发布)

```bash
pnpm --filter @kaijia/workflows pack          # prepack 自动执行完整构建
tar -tf packages/cli/*.tgz                    # 校验:dist/cli.js(shebang)、dist/api/pi/agents/*.md、dist/web-dist/index.html、package.json
npm install -g --prefix /tmp/wf-test <tarball> # 隔离 prefix 全局安装
PATH=/tmp/wf-test/bin:$PATH wf --version && wf --help
wf start                                       # 默认 5200:curl /api/health + curl / 前端 HTML;Ctrl-C 优雅退出
wf start --port 5211                           # 端口覆盖;PORT=5212 wf start 验证 env 优先级
wf start --dev                                 # NODE_ENV=development 冒烟
wf upgrade --dry-run                           # 打印安装器与命令,不执行
rm -rf /tmp/wf-test                             # 清理
```

## 7. 正式发布与终验

- `pnpm publish:cli`(= 全仓库 build + `pnpm --filter @kaijia/workflows publish`);发布前核对用户级 .npmrc 已配置 authToken 与 registry
- 真实环境:`npm i -g @kaijia/workflows@latest` → 重复步骤 6 全部验收项
- 版本管理:后续迭代 `pnpm --filter @kaijia/workflows version patch`(或手动改 version)后重新 publish

## 8. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| `src/api` 同步漂移(api 源码改动未同步进包) | prepare.mjs 每次全量覆盖复制,确定性;`pnpm build` 在 CI/发布前强制编译校验 |
| shared 若未来引入运行时导入 | 发布前 grep 门禁:`fff-grep "from '@workflows/shared'"` 全仓必须全为 `import type`;若破坏则把 shared 源码并入 prepare 复制并改写 import 为相对路径 |
| prepack 时 web dist 缺失 | copy-assets 前置校验报错退出,`publish:cli` 已保证先 `pnpm build` |
| `wf start` 端口冲突 / 配置污染用户 `~/.workflows` | 端口可覆盖;`--dev` 用包内 .workflows 不碰用户 home;生产默认 `~/.workflows` 为需求指定 |
| lint-staged 对新包报错 | 根 eslint 配置覆盖 `packages/cli/src`(步骤 1 处理) |
| 发布损坏版本 | 本地 `git revert` + 重发 patch;线上 `npm unpublish`(72h 内);用户回滚 `npm i -g @kaijia/workflows@<上一版本>` |
| prepack 内嵌 `tsc` 依赖 shared 类型未构建 | `publish:cli` 先全仓库 build;直接 `npm pack` 时按错误提示先 build |

## 验收标准(逐条核对)

- [ ] `packages/cli/package.json` 含 `bin.wf`、`files:["dist"]`、engines、9 个运行时依赖且无任何 workspace:/私有依赖
- [ ] `pnpm build && pnpm typecheck` 全绿;`pnpm start` 回归正常
- [ ] `tar -tf` 产物含 shebang 的 `dist/cli.js`、`dist/api/pi/agents/*.md`、`dist/web-dist/index.html`
- [ ] tarball 隔离全局安装后:`wf --version`、`wf --help`、`wf start`(/api/health 200 + 前端页面 200 + Ctrl-C 退出无残留进程)、`--port`/`PORT`/默认 5200 优先级正确、`wf upgrade --dry-run` 输出正确安装器与命令
- [ ] 正式 `npm i -g @kaijia/workflows` 后同套验收通过
