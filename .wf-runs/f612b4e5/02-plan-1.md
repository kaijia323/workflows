# 实施计划:根目录维护 README + LICENSE(MIT),发布时复制进 packages/cli

> 基于探索报告 `01-exploration-1.md`(DAG 现状 + LICENSE 情况)与 `01-exploration-2.md`(发布链路 + README 现状)。
> 前置结论(探索已论证,本计划直接采用):
> - npm 只能打包**包根**的 `README.md` / `LICENSE`(files 白名单不影响,自动附带),根目录文件不会自动进 tarball → 必须发布期复制;
> - 发布装配的正确钩子是 **prepack**(`pnpm publish` 与 `pnpm pack` 都触发,发生在打包前);
> - `packages/cli/README.md` 为 **untracked** 文件(未提交),`packages/cli/package.json` 元信息改动为未提交的 M 状态;
> - 前端现状:顶部 `PipelineHeader`(源 → 处理 → 观测流水线)+ 左 `WorkspaceRail` + 中 `ChatPane` + 右 `InfoPanel` 观测面板(工作区/会话/用量/工具流/系统);DagPanel 已删除(提交 `53544ed7`)。

---

## 0. 目标与范围

### 做什么
1. **根 README.md** 重写为**用户向**产品介绍(吸收 `packages/cli/README.md` 全部内容),修正其中与前端现状不符的 DAG 表述(现为「右侧 DAG 图实时展示节点状态」→ 改为「顶部流水线 + 右侧观测面板」);原开发者视角内容迁移至 `docs/development.md`(决策见 §2)。
2. **根 LICENSE** 新增 MIT 全文(版权行署名见闸门决策 D1)。
3. **根 package.json** 补 `"license": "MIT"`(与根 LICENSE 对应;闸门决策 D3 确认)。
4. **packages/cli/scripts/copy-docs.mjs** 新建:prepack 时将根 `README.md` + `LICENSE` 复制到 `packages/cli/` 包根(方案 A,探索报告推荐)。
5. **packages/cli/package.json**:补 `"license": "MIT"`;`prepack` 链末尾追加 `copy-docs.mjs`(`build` 链不动);修正 `description`/`keywords` 中的 DAG 表述。
6. **删除 `packages/cli/README.md`**(untracked,直接 rm);`packages/cli/.gitignore` 追加忽略生成物 `/README.md`、`/LICENSE`。
7. 验证:`pnpm --filter @kaijia/workflows pack` 触发 prepack,确认 tarball 内含 README.md 与 LICENSE。

### 不做什么(边界)
- ❌ 不清理 `apps/api` 与 `packages/cli/src/api` 的 `/api/dag` 死端点(前端已无调用方)。
- ❌ 不删除 `packages/shared` 的 `DagGraph/DagNode/DagEdge` 类型(无消费方但仍在 shared 导出)。
- ❌ 不改 `useAgent.ts:160`、`apps/api/src/agent/routes.ts:329`、`AGENTS.md:7` 三处过时注释(属「DAG 痕迹清理」另一任务,仅列提醒)。
- ❌ 不处理 `docs/dag-workflow.md` 过期设计文档(根 README 本就未引用它;是否删除由闸门决策 D4)。
- ❌ 不改 `apps/api`、`apps/web`、`packages/shared` 的 package.json(不补 license 字段,均为 private 不发包)。
- ❌ 不改 `files: ["dist"]`(npm 自动附带包根 README/LICENSE,无需改)。

---

## 1. 实施步骤

### Step 1 — 新建根 LICENSE(MIT)

**文件**:`LICENSE`(仓库根,新增,git add)

**动作**:
- 写入 MIT License 全文(标准文本,见附录 A)。
- 版权行:`Copyright (c) 2026 kaijia323`(依据:git remote `git@github.com:kaijia323/workflows.git` 的 owner;本地 `.git/config` 无 user.name/email,全局配置不可读;仓库最近提交时间戳 1786040732 ≈ 2026-08,年份用 2026)。**署名需闸门确认**(D1)。

**预期结果**:根目录出现 LICENSE;`pnpm pack` 时它是 copy-docs 的复制源。

---

### Step 2 — 重写根 README.md 为用户向 + 迁移开发者内容到 docs/development.md

**决策(D2,推荐):开发者内容移入 `docs/development.md`**,理由:
- 用户明确要求 README 面向用户;原 README 约 200 行中约 70% 是开发者内容(技术栈/数据存储/Skills 格式/MCP 配置/API 表/目录结构),若精简为「开发」小节仍需 100+ 行,与"面向用户"目标冲突;
- 移入 `docs/development.md` 单文件:README 保持干净、可扩展,仓库文档有集中去处(与 docs/dag-workflow.md 同目录),可发现性由 README 末尾一行链接保证;
- 避免删除信息(开发者内容是几个月积累的实现文档,直接删有信息损失风险)。

**文件 A**:`README.md`(重写,git tracked)

新结构(全部用户向,吸收 packages/cli/README.md 并修正 DAG):

```
# workflows — Web Agent 工作台
简介段(采用 cli README 开头:安装后 wfs start 即得本地 Web 应用…)
## 核心特性   ← 9 条,照搬 cli README;其中「工作流编排」条改写(见下)
## 快速开始   ← 照搬(npm i -g / pnpm add -g;wfs start;http://localhost:5200)
## 命令一览   ← 照搬(wfs start/upgrade/--help/--version 表格 + 升级示例)
## 配置说明   ← 照搬(~/.workflows/ 目录清单)
## 常见问题   ← 照搬(端口占用/--dev/升级生效)
## 从源码运行 ← 简短 3~5 行:pnpm install && pnpm dev → http://localhost:15200,并链接「开发文档:docs/development.md」
## 项目地址   ← 照搬(https://github.com/kaijia323/workflows)
```

「工作流编排」特性条的具体改写(替换 cli README L11 的「右侧 DAG 图实时展示各节点状态,点击可回看子代理完整对话」):

> 「**工作流编排**:主代理统一调度 4 个内置子代理——explorer(探索)→ planner(计划)→ executor(执行)⇄ reviewer(审查);planner 产出计划后需**人工批准**才进入执行。运行状态在**顶部流水线**(源 → 处理 → 观测)与**右侧观测面板**(工作区/会话/用量/工具流/系统)实时呈现,点击聊天中的子代理块可回看完整对话」

(依据:App.vue 现状 = PipelineHeader 顶部流水线 + InfoPanel 右侧观测面板;子代理对话经 ChatPane 子代理块 → SubAgentModal 回看,探索报告 §1.2 已核实。)

**文件 B**:`docs/development.md`(新增;目录已存在)

迁移清单(从原根 README 逐节搬入,保留原内容并修正 DAG 表述):

| 迁移小节 | 原 README 位置 | 处理 |
| --- | --- | --- |
| 项目定位(monorepo 一句话) | L3 | 改为「Turborepo monorepo — 基于 pi SDK 的 Web Agent 工作台」,**去掉「(DAG 可视化骨架)」** |
| 技术栈表 | 技术栈 | 原样 |
| 数据存储(`.workflows/`)含 mcp.json 与信任模型 | 数据存储 | 原样 |
| Skills(格式/四来源/注意事项) | Skills | 原样 |
| MCP(配置/生效时机/安全模型) | MCP | 原样 |
| 端口策略 | 端口策略 | 原样 |
| 命令 | 命令 | 原样 |
| CLI 发布(开发者向) | CLI 发布的「发布产物/prepack/pack 验证」部分 | 保留:自包含 dist/ 机制、prepare.mjs 复制逻辑、`pnpm --filter @kaijia/workflows pack` 验证说明;安装/使用部分已并入根 README,此处留一句交叉引用 |
| API 一览 | API 一览 | 原样迁入,但:① `GET /dag` 行注明「示例端点,前端已不使用」;② `GET /agent/workspaces/:id/run` 说明「DAG 图 / 闸门状态 / 恢复」→「run 快照(闸门状态 / 断连恢复)」 |
| 目录结构 | 目录结构 | 原样(components 注释可补 InfoPanel/PipelineHeader) |
| 文档索引 | — | 新增一行注明 `docs/dag-workflow.md` 为历史设计文档、与现状部分脱节(配合 D4) |

**文件 C**:`packages/cli/README.md` — 本步不动,其内容已在 Step 2A 吸收,Step 3 删除。

**预期结果**:根 README 全文无「DAG 图」表述(grep `dag|DAG` 除 docs/development.md 链接外 0 命中);开发者信息零丢失地出现在 docs/development.md。

---

### Step 3 — packages/cli 侧:复制脚本 + package.json + 删除包内 README + .gitignore

**文件 A**:`packages/cli/scripts/copy-docs.mjs`(新增)

脚本要点(风格对齐 `prepare.mjs` / `copy-assets.mjs`;纯 Node API,无 shell,Windows 安全):

```js
/**
 * prepack 时把根 README.md 与 LICENSE 复制到包根,npm 自动附带进 tarball。
 * 源缺失时退出报错(发布前强制根文档/许可存在)。
 */
import { cpSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(cliRoot, '../..')
const docs = [
  ['README.md', path.join(repoRoot, 'README.md')],
  ['LICENSE', path.join(repoRoot, 'LICENSE')],
]
for (const [name, src] of docs) {
  if (!existsSync(src)) {
    console.error(`[copy-docs] 未找到根 ${name},请先在仓库根创建后再发布`)
    process.exit(1)
  }
  cpSync(src, path.join(cliRoot, name))  // 文件复制,覆盖包根同名文件
  console.log(`[copy-docs] ${name} 已复制到包根`)
}
```

要点说明:
- 路径解析:`import.meta.url` → scripts/ → `..` = 包根,`../..` = 仓库根(与 prepare.mjs 同款);
- 失败处理:任一源缺失 → `console.error` + `process.exit(1)`,阻止打包;
- 覆盖语义:`fs.cpSync` 默认 `force: true`,包根旧文件被覆盖(生成物语义);
- 只复制文件、不递归,无需 rmSync。

**文件 B**:`packages/cli/package.json`(修改,当前为 M 状态,改动并入现有未提交修改)

1. `scripts` 拆分为(build 不动,prepack 末尾追加):

```json
"build": "node scripts/prepare.mjs && tsc -p tsconfig.json && node scripts/copy-assets.mjs",
"prepack": "node scripts/prepare.mjs && tsc -p tsconfig.json && node scripts/copy-assets.mjs && node scripts/copy-docs.mjs"
```

理由:build 是日常构建(CI/turbo),不应因文档缺失失败、也不应每次构建覆盖工作区文件;prepack 才是发布装配钩子。

2. 顶层加 `"license": "MIT"`(放 `version` 之后、`description` 之前,SPDX 表达式)。
3. `description` 修正:`"…SSE 流式对话与 DAG 工作流编排(wfs 命令)"` → `"…SSE 流式对话与流水线式工作流编排(wfs 命令)"`。
4. `keywords` 修正:删除 `"dag"`;可加 `"pipeline"` 与现有「流水线」表述呼应(可选,见 D6)。

**文件 C**:`packages/cli/README.md`(删除)——untracked 文件,直接 `rm`(不用 `git rm`);内容已被 Step 2A 吸收。

**文件 D**:`packages/cli/.gitignore`(修改,追加,保持现有注释风格):

```
# 生成物:根 README.md / LICENSE 由 scripts/copy-docs.mjs 在 prepack 时复制,不提交
/README.md
/LICENSE
```

**预期结果**:`packages/cli` 目录下无手工维护的 README;`prepack` 全链 = prepare → tsc → copy-assets → copy-docs;git status 中 README/LICENSE 均不可见(被忽略)。

---

### Step 4 — 验证

**前置**:`apps/web/dist` 必须存在(prepack 链的 prepare.mjs 硬性要求)→ 先执行根 `pnpm build`(或 `pnpm --filter @workflows/web build`)。

**验证命令**(按序):

```bash
# 1. 直接跑脚本(快速冒烟,不触发 tsc)
node packages/cli/scripts/copy-docs.mjs
#   预期:两行 [copy-docs] 日志;packages/cli/README.md 与 packages/cli/LICENSE 生成且与根文件 diff 为空

# 2. 模拟发布(触发完整 prepack 链)
pnpm build
pnpm --filter @kaijia/workflows pack
#   预期:prepack 四步全过,生成 packages/cli/*.tgz

# 3. 检查 tarball 内容清单
tar -tzf packages/cli/*.tgz | grep -E 'README|LICENSE'
#   预期:package/README.md、package/LICENSE 均在列
#   (Windows 10+ 自带 bsdtar 支持 -tzf;若不可用,pnpm pack 后解压核对)

# 4. 内容一致性
#    解压 tgz 或直接对比 packages/cli/README.md 与根 README.md(diff 应为空)

# 5. 回归:pnpm typecheck 通过;pnpm --filter @kaijia/workflows typecheck 通过
#    验证 .gitignore 生效:git status 不显示 packages/cli/README.md、packages/cli/LICENSE

# 6. 清理 tgz(根 .gitignore 已忽略 *.tgz,可留可删)
```

**预期结果**:tarball 含 README.md + LICENSE,内容与根文件一致;prepack 链正常;工作区无多余 git 噪音。

---

### Step 5 — 提交(建议拆分,见 D7)

- **提交 1(docs)**:根 `LICENSE`、重写的 `README.md`、新增 `docs/development.md`、根 `package.json` 加 license 字段。
- **提交 2(cli)**:`packages/cli/scripts/copy-docs.mjs`、`packages/cli/package.json`(license + prepack + description/keywords)、`packages/cli/.gitignore`、删除 `packages/cli/README.md`。

提交信息建议:`docs: 根 README 重写为用户向,新增 LICENSE(MIT)与开发文档` / `chore(cli): prepack 复制根 README/LICENSE 随包发布,补 license 字段`。

---

## 2. 风险与回滚

| # | 风险 | 影响 | 缓解 / 回滚 |
| --- | --- | --- | --- |
| R1 | 根 README/LICENSE 缺失时 prepack 失败,阻断发布 | 发布不可用 | **预期行为**(发布前强制要求);根 README 已 tracked 必存在,LICENSE 由 Step 1 保证;在 docs/development.md 注明「发布前置:根 LICENSE 必须存在」 |
| R2 | prepack 链变长引入新失败点 | 发布被阻 | copy-docs.mjs 逻辑极小(2 次 cpSync),与 prepare/copy-assets 同风格;失败即回滚:删脚本、还原 package.json scripts、还原 .gitignore 三处即可(单提交可逆) |
| R3 | 根 README 重写丢失开发者信息 | 信息损失 | 迁移清单(§1 Step 2 表格)逐节核对,执行后对照原 README 逐节打勾;diff 检查 |
| R4 | copy-docs 覆盖包根文件(若有人手工改过) | 手工修改丢失 | 生成物语义已通过 .gitignore 声明;包根文件已被忽略,不会产生 diff 噪音 |
| R5 | license 署名错误,发布后进 tarball 难以更改 | 法律/归属问题 | **闸门 D1 必须先确认**;改署名 = 改根 LICENSE + 重新发布(简单但需发版),故宁可先确认 |
| R6 | Windows 跨平台兼容 | 脚本失败 | 纯 Node `fs`/`path` API,无 shell 命令(仓库已有 Windows 环境,prepare.mjs 同款写法已验证) |
| R7 | 验证时 pack 失败(非本次改动引起) | 无法验证 | 常见原因是 apps/web/dist 缺失:先跑 `pnpm build` 再 pack(与发布链路 ① 一致) |

**总体回滚方案**:所有改动集中在两个可独立 revert 的提交;若 copy-docs 方案出现问题,还原 `packages/cli/package.json` 的 prepack 一行 + 删除脚本 + 删除 .gitignore 两行,即完全回到现状(发布不依赖根 README/LICENSE 复制)。

---

## 3. 验收标准(逐条核对)

- [ ] AC1:仓库根存在 `LICENSE`,内容为 MIT 全文,版权行署名经闸门确认(D1)。
- [ ] AC2:根 `README.md` 为用户向结构(核心特性/快速开始/命令一览/配置说明/常见问题/从源码运行/项目地址),grep `dag|DAG` 全文 0 命中(链接与文档索引除外)。
- [ ] AC3:根 README「工作流编排」特性条表述与前端现状一致(顶部流水线 + 右侧观测面板 + 子代理块回看),无「DAG 图」字样。
- [ ] AC4:`docs/development.md` 存在,原 README 开发者内容逐节迁移无遗漏(对照 §1 Step 2 表格);其中 API 表 `/dag` 行已标注「示例端点,前端已不使用」,`/run` 行无「DAG 图」字样。
- [ ] AC5:`packages/cli/README.md` 已删除,git status 无该文件(untracked 消失,未误提交)。
- [ ] AC6:`packages/cli/.gitignore` 含注释说明的 `/README.md`、`/LICENSE` 两条;`git status` 不显示这两个生成物。
- [ ] AC7:`packages/cli/package.json` 含 `"license": "MIT"`;`description` 与 `keywords` 无 `dag` 表述;`prepack` = `prepare.mjs && tsc && copy-assets.mjs && copy-docs.mjs`,`build` 不变。
- [ ] AC8:`packages/cli/scripts/copy-docs.mjs` 存在;手动删除根 LICENSE 后运行脚本 exit 1 且报错信息明确(失败路径验证,测后恢复)。
- [ ] AC9:`pnpm --filter @kaijia/workflows pack` 成功,`tar -tzf` 显示 tarball 含 `package/README.md` 与 `package/LICENSE`,且与根文件内容一致(diff 为空)。
- [ ] AC10:`pnpm typecheck` 与 `pnpm --filter @kaijia/workflows typecheck` 通过(无回归)。
- [ ] AC11:根 `package.json` 已加 `"license": "MIT"`(若 D3 采纳)。
- [ ] AC12:提交按 D7 拆分,提交信息清晰,`git status` 干净(除生成物忽略项外)。

---

## 4. 闸门确认清单(执行前需用户拍板)

| # | 决策点 | 建议(默认) | 影响 |
| --- | --- | --- | --- |
| D1 | **LICENSE 版权行署名** | `Copyright (c) 2026 kaijia323`(来自 remote owner;本地无 git user 信息) | 可改真名/其他;发布前必须确认(R5) |
| D2 | **根 README 开发者内容去向** | 移入 `docs/development.md`(推荐)vs 精简保留「开发」小节 | 影响 Step 2 结构;推荐理由见 §1 Step 2 |
| D3 | **根 package.json 是否补 license 字段** | 补(与根 LICENSE 呼应;其余 3 个私有包不补) | 不改也不影响发布,纯一致性 |
| D4 | **`docs/dag-workflow.md` 过期文档** | 默认不动;可选项:删除 / 加「已过时」横幅 | 若选删除,追加一个独立小步骤 |
| D5 | **`/api/dag` 死端点 + shared 死类型** | 默认不动(仅 docs 中标注);可选项:另行清理 | 若选清理,属独立任务,不在本计划内展开 |
| D6 | **keywords 是否加 `"pipeline"`** | 加(替换 dag 后补位) | 纯元数据,可省略 |
| D7 | **提交拆分** | 两条(Step 5)vs 一条 | 影响历史可读性;两条便于单独 revert |

---

## 附录 A:根 LICENSE 内容(标准 MIT 文本)

```text
MIT License

Copyright (c) 2026 kaijia323

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
