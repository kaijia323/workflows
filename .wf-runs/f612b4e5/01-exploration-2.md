# 探索报告 2:发布打包流程 + 根 README 现状(为「根维护用户向 README + LICENSE(MIT),发布时复制进 packages/cli」做准备)

> 任务:调研发布打包流程与根 README 现状,只读调研,未修改任何文件。
> 方式:读 package.json / scripts / 索引 / reflog;产物写入 `.wf-runs/f612b4e5/01-exploration-2.md`。

---

## 1. 发布流程

### 1.1 相关 scripts(原文引用)

**根 `package.json`**(`scripts` 字段,仅列 publish 相关与全部脚本):

```json
"scripts": {
  "dev": "turbo run dev",
  "build": "turbo run build",
  "typecheck": "turbo run typecheck",
  "lint": "turbo run lint",
  "test": "turbo run test",
  "start": "pnpm --filter @workflows/api start",
  "preview": "pnpm build && pnpm start",
  "publish:cli": "pnpm build && pnpm --filter @kaijia/workflows publish",
  "prepare": "husky"
}
```

- 根目录 **publish 相关只有 `publish:cli` 一条**;根 `prepare: husky` 只装 git hooks,与发布无关。
- 根 package.json:`"private": true`、无 `license` 字段。

**`packages/cli/package.json`**(`scripts` 字段全文):

```json
"scripts": {
  "build": "node scripts/prepare.mjs && tsc -p tsconfig.json && node scripts/copy-assets.mjs",
  "prepack": "node scripts/prepare.mjs && tsc -p tsconfig.json && node scripts/copy-assets.mjs",
  "typecheck": "tsc --noEmit"
}
```

- **包内没有** `publish`、`prepare`、`prepublishOnly`、`postpack` 脚本;**只有 `build` / `prepack` / `typecheck`**。
- `files: ["dist"]`、`bin: { "wfs": "./dist/cli.js" }`、`publishConfig.access: "public"`、**无 `license` 字段**。

### 1.2 `pnpm publish:cli` 完整链路

```
pnpm publish:cli(根)
├─① pnpm build(根)→ turbo run build
│    turbo.json:「@kaijia/workflows#build」dependsOn ["^build", "@workflows/web#build"]
│    ⇒ 先构建 shared、apps/web(保证 apps/web/dist 存在),再构建 cli
│    packages/cli build = prepare.mjs(复制 api 源码)→ tsc → copy-assets.mjs(复制 agent .md + web-dist)
└─② pnpm --filter @kaijia/workflows publish
     pnpm publish 在 packages/cli 内自动触发 npm lifecycle:prepack → pack → publish(registry=https://registry.npmjs.org/,见 .npmrc)
     prepack = 与 build 完全相同的链(即构建被重复执行一次;因①已保证 apps/web/dist 存在,不会报错)
     pack 产出 tarball = files 白名单 dist/** + npm 自动附带 package.json / README.md / LICENSE
```

结论:发布前的「最后一公里」钩子就是 **`prepack`**——它在 `pnpm publish` 与 `pnpm pack`(仓库内验证用,根 README 也推荐 `pnpm --filter @kaijia/workflows pack`)时都会自动执行,且发生在打包之前。

### 1.3 prepare.mjs 完整内容与作用

位置:`packages/cli/scripts/prepare.mjs`(**不在包根,在 scripts/ 下**;包根无 prepare.mjs)。

```js
/**
 * 将 apps/api/src 整树复制到 packages/cli/src/api(排除 *.test.ts,含 pi/agents/*.md)。
 * 发布产物自包含的前提:CLI 包不依赖 workspace 内的私有包,api 源码以复制方式随包分发。
 * 硬性前置:apps/web/dist 必须已存在(先运行 pnpm build;prepack 自身不触发 web 构建)。
 */
import { cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiSrc = path.resolve(cliRoot, '../../apps/api/src')
const target = path.join(cliRoot, 'src/api')
const webDist = path.resolve(cliRoot, '../../apps/web/dist')

if (!existsSync(webDist)) {
  console.error('[prepare] 未找到 apps/web/dist,请先运行 pnpm build(前端构建产物随 CLI 包分发)')
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
cpSync(apiSrc, target, {
  recursive: true,
  filter: (src) => !src.endsWith('.test.ts'),
})
console.log(`[prepare] api 源码已复制到 ${path.relative(cliRoot, target)}(排除 *.test.ts)`)
```

**作用/时机**:
- 复制内容:`apps/api/src` **整树** → `packages/cli/src/api`(先删目标再复制),排除 `*.test.ts`;含 `pi/agents/*.md`(代理定义)。
- 时机:**`build` 与 `prepack` 都会执行**(两脚本共享同一条命令链);由 packages/cli/.gitignore 把 `src/api/` 排除出 git。
- 前置硬性要求:`apps/web/dist` 必须已存在,否则 exit 1(这正是根脚本先 `pnpm build` 的原因)。

**copy-assets.mjs**(同链中 tsc 之后执行):复制 `src/api/pi/agents` → `dist/api/pi/agents`(agent .md 定义)、`apps/web/dist` → `dist/web-dist`(前端产物),使发布包自包含。

---

## 2. 根 README.md 与 packages/cli/README.md 结构

### 2.1 根 `README.md`(约 200 行)标题结构

```
# workflows
## 功能                              ← 用户向(产品特性)
## 技术栈                            ← 开发者
## 数据存储(`.workflows/`)           ← 开发者(实现细节)
## Skills(技能)
### SKILL.md 格式                    ← 开发者(格式规范)
### 四来源目录                       ← 开发者/用户混合(路径表含 Windows 路径)
### 注意事项                         ← 开发者
## MCP(外部工具)
### 配置文件 mcp.json                ← 开发者/用户混合(JSON 格式 + 字段表)
### 配置方式与生效时机               ← 用户向(设置面板操作)
### 安全模型                         ← 开发者(信任模型分析)
## 端口策略(对外只暴露一个入口)      ← 用户向(端口 15200/5200)
## 命令                              ← 开发者(安装依赖/构建/测试命令)
## CLI 发布(`@kaijia/workflows`,命令 `wfs`)  ← 混合:安装/使用段用户向;发布产物/prepack 说明段开发者
## API 一览(前缀 `/api`)             ← 开发者(接口表)
## 目录结构                          ← 开发者
```

- 整体偏**开发者视角**(monorepo 结构、构建命令、API 表、实现机制);**用户向内容**集中在「功能」「CLI 发布」的安装/使用部分、端口策略。
- 已有「CLI 发布」专节,含用户向素材(全局安装、`wfs start/--port/--dev/upgrade`、存储根、发布产物说明)——与 packages/cli/README.md 内容高度重合,可视为根 README 的用户向候选章节。

### 2.2 `packages/cli/README.md`(上一轮新建,未提交)标题结构

```
# workflows — Web Agent 工作台
## 核心特性    ## 快速开始    ## 命令一览    ## 配置说明    ## 常见问题    ## 项目地址
```

- **全部为用户向**:无任何开发/构建/内部实现内容(刻意规避「tsc 编译」「自包含包」等表述)。
- 末尾「项目地址」节(上一轮审查后将「许可」节改名而来)——当前无 LICENSE,该节仅放仓库链接。

---

## 3. files 字段与 .npmignore / .gitignore

### 3.1 packages/cli/package.json `files`

```json
"files": ["dist"]
```

- 白名单模式,**只列了 `dist`**;npm 打包时**始终自动附带**(不受 files 白名单影响):`package.json`、`README.md`(大小写变体)、`LICENSE`/`LICENCE`(大小写变体)、`main` 入口等。→ **把 README/LICENSE 复制进 packages/cli/ 即可随包发布,`files` 字段无需改动**(上轮探索已核实 npm 官方文档表述)。

### 3.2 ignore 文件盘点

| 文件 | 内容 | 对 npm tarball 的影响 |
| --- | --- | --- |
| `packages/cli/.gitignore` | `src/api/`(prepare.mjs 生成物)、`dist/` | **无**(.gitignore 只影响 git,不影响 npm pack;npm 只看 files + .npmignore) |
| 根 `.gitignore` | node_modules、dist、.turbo、*.tsbuildinfo、*.tgz、.env、logs、.workflows/ 等 | 无 |
| **`.npmignore`** | **全仓库不存在**(fff-find `**/.npmignore` 无结果) | — |

- **全仓库无 LICENSE 文件、无 license 字段**(上一轮探索 `01-exploration-1.md` 已确认:5 个 package.json 均无 `license`;根、cli、shared、api、web 均无 LICENSE)。本次复核一致:`fff-find LICENSE*` 无结果、git index 无 LICENSE 条目。
- 根 `README.md` 在 git 索引中(tracked);`packages/cli/README.md` **不在** git 索引中(见 §5)。

---

## 4. 「复制根 README.md + LICENSE → packages/cli/」的实现建议

### 4.1 前置事实(决定方案)

1. npm **无法**把包目录之外的文件打进 tarball:`files` 条目、README 探测都只认**包根**(不能写 `../README.md`);**symlink 也不可靠**(npm pack 不跟随/不包含符号链接)。
2. 因此「根维护、随包分发」**必须做发布期复制**(或提交时双份同步,但那会违背「单点维护」目标)。
3. 复制目标文件名必须是 `packages/cli/README.md` 与 `packages/cli/LICENSE`——npm 自动附带规则认的就是这两个名字,无需改 `files`。
4. 复制方向为**根 → 包**,会覆盖 `packages/cli/README.md` 现有内容(上一轮新建的用户向 README,其内容应先行并入根 README 的用户向章节)。

### 4.2 方案对比与建议

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| **A(prepack 挂独立脚本)⭐推荐** | 新建 `packages/cli/scripts/copy-docs.mjs`(cpSync 根 `README.md`/`LICENSE` → 包根;根文件缺失时报错退出),`prepack` 链改为 `prepare.mjs && tsc && copy-assets.mjs && copy-docs.mjs` | ✅ 语义精准:prepack 正是「装配发布物」的钩子,`publish` 与 `pack` 都会触发;✅ 不动 `build`,日常 `pnpm build`/CI 不会因为文档/许可缺失而失败,也不会每次构建都弄脏工作区;✅ Node 脚本跨平台(仓库有 Windows 环境,此前已用 cross-env 修过跨平台问题,避免 shell `cp`);✅ 与 prepare.mjs(复制 api 源码,tsc 前置)职责分离 |
| B(prepare.mjs 末尾追加) | 在 prepare.mjs 末尾加 cpSync 根 README/LICENSE | ⚠️ 可行但耦合:`prepare.mjs` 同时挂在 `build` 上,每次 turbo build 都会覆盖 `packages/cli/README.md`(若该文件仍被 git 跟踪,会产生持续的工作区噪音/误报);且 build 阶段文档缺失会整链报错 |
| C(根 publish:cli 脚本内复制) | 根脚本 `publish:cli` 先复制再 publish | ⚠️ 把发布装配逻辑放在根脚本,`pnpm pack` 本地验证时不会执行;跨平台需再引 node 脚本,不如直接进 prepack |

**建议(明确结论)**:采用 **方案 A**——独立 `copy-docs.mjs` 挂在 **prepack** 链末尾(不动 build 链)。配套动作:
1. 先建根 `LICENSE`(MIT 文本)+ 根 README 补用户向章节(吸收现 `packages/cli/README.md` 内容,然后**从 git 中删除** `packages/cli/README.md`,它变成纯生成物);
2. `packages/cli/package.json` 增加 `"license": "MIT"`(当前缺失,npm 会警告并默认 UNLICENSED);
3. 发布前用 `pnpm --filter @kaijia/workflows pack` 验证 tarball 内含 README.md + LICENSE。

### 4.3 风险点

- 若 copy-docs 只挂在 prepack,而有人直接 `npm i <tarball>` 前手动删了包内 README——不成立,prepack 必然先执行;风险可忽略。
- 根 README/LICENSE 缺失时 prepack 会失败——符合预期(发布前强制要求文件存在),但注意 `publish:cli` 的 ① `pnpm build` 不会触发该检查(方案 A 下 build 不复制),只有 ② publish 阶段才暴露——建议在根脚本或文档中注明「先建根 LICENSE 再发布」。
- npm 自动附带 LICENSE 的规则是**包根** `LICENSE`;根目录 LICENSE 永远不会自动进 tarball(上一轮探索已确认),复制是唯一正道。

---

## 5. git 状态:`packages/cli/README.md` 是否已提交?

**结论:未提交——是未跟踪(uncommitted / untracked)的工作区文件。** 证据链:

1. **reflog**(`.git/logs/HEAD`)最后一条提交 = `1d20c493`「chore: 提交工作流运行记录 .wf-runs(工作区操作 UI 重构会话)」,时间戳 1786040732;其后**再无任何提交**。
2. 创建 README 的运行 `.wf-runs/2e125f07/run.json`:`createdAt: 1786040794819`——**比最后提交晚约 62 秒**;该 run 的 explorer 摘要确认当时「`packages/cli/` 下没有任何 README.md」,executor 新建了 README 并改了 package.json 元信息;第二次 executor 自述「`package.json` 的 M 状态为上一轮遗留」(M = 未提交的工作区修改)。
3. **git 索引实证**:直接读 `.git/index`(DIRC 二进制,路径为明文),`packages/cli/` 下索引条目共 7 条,恰好为:
   `.gitignore`、`eslint.config.mjs`、`package.json`、`scripts/copy-assets.mjs`、`scripts/prepare.mjs`、`src/cli.ts`、`tsconfig.json`(与 TREE 缓存 `cli 7 2` 的条目计数一致:4 文件 + scripts 2 + src 1 = 7)。
   **其中没有 `packages/cli/README.md`** → 它既不在 HEAD 中,也未被 `git add`。
4. 同理,`packages/cli/package.json` 的元信息改动(description/keywords/homepage/repository,run 2e125f07 所做)**同样未提交**(仅索引中有旧版本条目,工作区为 M 状态)。

---

## 6. 结论汇总

1. **发布链**:`pnpm publish:cli` = `pnpm build`(turbo,保证 web-dist 先就绪)→ `pnpm --filter @kaijia/workflows publish`(自动触发 **prepack** = `prepare.mjs && tsc && copy-assets.mjs` → pack → 推 npm)。**prepack 是发布装配的正确钩子**。
2. **prepare.mjs**:构建/打包时把 `apps/api/src` 整树复制到 `packages/cli/src/api`(排除 *.test.ts),前置要求 `apps/web/dist` 存在;包内无独立的 prepare/prepublishOnly 脚本。
3. **README 结构**:根 README 偏开发者视角(功能/CLI 发布节为用户向素材);`packages/cli/README.md` 全用户向,但**未提交**(untracked)。
4. **files/ignore**:`files: ["dist"]`;全仓库无 .npmignore;packages/cli/.gitignore 仅忽略 `src/api/`、`dist/`(不影响 npm pack)。npm 自动附带包根 README.md/LICENSE,`files` 无需改动;但**全仓库尚无 LICENSE 与 license 字段**——需先补根 LICENSE(MIT)+ 包 license 字段。
5. **建议**:新建 `packages/cli/scripts/copy-docs.mjs`,在 **prepack 链末尾**复制根 README.md + LICENSE → 包根;根 README 吸收现有 cli README 内容后,`packages/cli/README.md` 从 git 移除转为生成物;补 `"license": "MIT"`。发布前用 `pnpm --filter @kaijia/workflows pack` 验收 tarball。
