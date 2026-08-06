# 仓库发版信息探索报告(workflows)

> 调研时间:2026-08-07(仓库时间戳口径,UTC+8)
> 调研方式:只读。读取 package.json × 5、README/docs、`.git` 内部文件(reflog/packed-refs/refs)还原 git 状态;因无 shell 执行环境,提交历史来自 `.git/logs/HEAD`(含全部 110 条 commit 记录与提交时间戳)。

---

## 1. 仓库概览

- **形态**:pnpm + Turborepo monorepo(Node >= 20.19.0,`packageManager: pnpm@10.33.0`),前端/后端/共享类型/CLI 四个包。
- **技术栈**:
  - `apps/web`:Vue 3 + TypeScript + Vite 8 + Tailwind CSS v4 + marked + @lucide/vue(dev 端口 15200)
  - `apps/api`:Hono + @hono/node-server + pi SDK(@earendil-works/pi-coding-agent / pi-ai)、fff-node、MCP SDK(生产端口 5200,单端口托管前端产物)
  - `packages/shared`:跨端共享类型
  - `packages/cli`:`@kaijia/workflows` npm 发布包(bin `wfs`),prepack 时把 api 源码 + web 产物装配成自包含 `dist/`
- **构建/测试/发布**:`pnpm build`(turbo 并行)、`pnpm test`(Vitest)、`pnpm typecheck/lint`(turbo + ESLint + husky/lint-staged);发布入口 `pnpm publish:cli` = `pnpm build && pnpm --filter @kaijia/workflows publish`(prepack 钩子自动装配,见 docs/development.md「CLI 发布」)。

## 2. 版本号定义位置(全部)

| 文件 | 包名 | 当前版本 | 是否发布对象 |
| --- | --- | --- | --- |
| `package.json`(根,private) | workflows | `0.0.0` | 否(占位,非真实版本) |
| `packages/cli/package.json` | **@kaijia/workflows** | **`0.2.1`** | **是(npm 唯一发布包)** |
| `apps/web/package.json`(private) | @workflows/web | `0.0.0` | 否 |
| `apps/api/package.json`(private) | @workflows/api | `0.0.0` | 否 |
| `packages/shared/package.json`(private) | @workflows/shared | `0.0.0` | 否 |

- 无 VERSION 文件 / Cargo.toml / pyproject.toml;真实版本号只存在于 `packages/cli/package.json` 的 `version` 字段。
- 版本史(仓库内证据):根目录遗留 `kaijia-workflows-0.1.0.tgz`(0.1.0 的 pack 产物,已被 .gitignore 忽略)→ commit `0b982f2e refactor(cli): 命令名 wf 改为 wfs,版本升至 0.2.0`(2026-08-07 01:57)→ 当前 `0.2.1`(0.2.1 的 bump 混在后续 fix(cli) 提交中,无独立提交)。
- 发布链路:`packages/cli/scripts/prepare.mjs` → `tsc` → `copy-assets.mjs` → `copy-docs.mjs`(只复制根 README.md 与 LICENSE 进包)。**.npmrc 指向官方 registry**。

## 3. 更新日志文件

**不存在。** 全仓库(根、apps、packages、docs)无任何 CHANGELOG/RELEASE NOTES 文件(fff-find glob+fuzzy 双重确认;全库 `*.md` 中 "CHANGELOG" 仅出现在 `.wf-runs/` 旧报告里,指 pi SDK 的 changelog)。因此无既有格式可循,需**新建**。

建议格式(Keep a Changelog + Conventional Commits,与现有 commit 前缀 `feat/fix/refactor/docs/chore/test` 天然对应):

```markdown
# Changelog

本仓库更新日志遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[Semantic Versioning](https://semver.org/lang/zh-CN/)。发布对象为 `@kaijia/workflows`(命令 `wfs`),
版本号定义于 `packages/cli/package.json`。

## [Unreleased]

## [0.2.1] - 2026-08-07

### Added
### Changed
### Fixed
### Docs
```

## 4. git 状态

- **当前分支**:`main`(HEAD = `6caf9ab091e8a1d356e08755fe3c9aeaad5ed4c5`,2026-08-07 02:54 +0800)
- **远程**:`origin/main` = `ae209aee` → **本地 main 领先 origin 22 个提交(未推送)**;remote 为 github.com:kaijia323/workflows.git(原 dag-pi 改名)
- **Tag**:`.git/refs/tags` 为空、packed-refs 无 tag → **仓库从未打过任何 git tag**;「发版」无 tag 记录,仅能从 npm 侧推断(上次已知产物 = 0.1.0 tgz)
- **历史跨度**:克隆自 `github.com:kaijia323/dag-pi.git`(单提交 850404f6,2026-08-03 20:29 +0800)后全部重写;整个仓库历史仅 **2026-08-03 ~ 2026-08-07 约 4 天**,不存在 1-2 个月窗口,以下即全部有效提交(110 条,按日分组,非 .wf-runs 记录类均已列出;chore 类提交折叠)

### 2026-08-03(克隆 + 基础建设)
- `223650e5` chore: 仓库改名 workflows,统一包名/存储目录/品牌文案
- `61c4e85f` fix(api): cross-env 跨平台 NODE_ENV
- `8e94ca30` feat(web): 工作区改为目录选择器(可搜索/Tab 补全/双击进入)
- `51ba202e` feat(api): 工作区边界守卫,禁止工具逃逸到工作区外(+`069b83a2` 放行修正)
- `911bfbbc` feat(api): fff 索引搜索工具(fff-find/fff-grep)替换内置 grep/find(+`cadc511f` bash 禁用 find/rg/fd)

### 2026-08-04(核心编排 + 前端改版 + skills)
- `6bf087e4` feat: 主代理编排工作流(4 子代理 + 人工闸门 + run 产物黑板)
- `4ae29cc2` / `f7b46b2d` fix/feat(web): 子代理工具结果渲染、thinking 块独立展开收起
- `1f484e58` fix(api): 构建产物缺失代理定义(生产子代理静默失效)
- `fb17642e` / `65614836` fix: subagent 模态窗 tools 展开、历史会话 renderHistory 两遍扫描+单测
- `fd6057fc` fix(api): .wf-runs 子代理产物不互相覆盖
- `d05bf476` fix(api): runId 按编排任务归并,新增 complete_task 工具
- `c1cba88e` chore: done 冻结改造(ensureRun 排除 done、complete_task 释放、saveRun 熔断)
- `745ffade` feat: complete_task 改为主代理自行判断,根治空 run
- `5f209294` feat: 新增 anysearch-search 网络搜索工具 + 前端 API key 设置弹窗,图标统一 @lucide/vue
- `63e49be1` feat: 内置 design 工具 + 子代理注册 anysearch + planner 重做上限可配置
- `abd84115` feat: 前端 UI 按 VoltAgent 设计规范重设计(表现层)
- `cb6f7c48` chore: 彻底移除 design 工具及设计资产
- `59631d7a`→`3215f238`(skills 批次):SkillInfo/SkillSource 类型、WorkflowsStore skillsDir、skills 四来源加载 + listSkills 端点、useAgent skills 状态 + `/` 搜索下拉、workspaceGuard extraAllowedRoots、promptLoader skillReadRoots、主/子代理接入只读放行、配套单测与文档

### 2026-08-05(a11y/UI 修复 + 视觉能力)
- `e630dda2`→`54fc9c2d`(a11y/UI 批次):pointer 光标、输入框居中、modal dialog contract、workspace row actions、responsive drawers(<1100px)、sr-only labels、aria-expanded/aria-pressed、live regions、combobox 语义、对比度/字号、heading outline、消息列宽、reject-reason label、chat column min-h-0、选中工作区关抽屉
- `8ac9480a` fix(web): 子代理模态窗 footer 移除重复摘要
- `20703ca0` feat(api): 内置视觉理解工具 vision-understand(开关门 + 双点注册 + 配置路由)
- `71ab29c4` feat(web): 设置新增「视觉模型」tab(开关 + 小米 key)
- `8980fef6` fix(web): 视觉面板空 key 不覆盖后端配置 + 保存失败回滚
- `d80177b8` feat(api): vision-understand 多图/URL/base64 三路输入 + SSRF 防护
- `4f1d6a29` feat(api): 工作区图片上传路由 POST /uploads(.workflows/uploads)
- `026c259c` feat(web): 输入框粘贴图片缩略图(compressorjs)+ 随消息发送
- `46cd3c29` fix(web): ChatPane 发送并发锁 + 压缩失败剔除 + 发送失败恢复草稿
- `536fcf4f` fix(api): image_urls 移除 DNS 内网 IP 拦截(SSRF 黑名单)

### 2026-08-06(稳定性 + CLI 包诞生)
- `f7cd97d8` fix(web): 工作区切换窗口期发送防护 + SSE 事件归属过滤
- `0161fa1f` / `e6ae3629` fix(api): activeEmitter 按 workspace.id 隔离 Map、subscribe 后 set 不留残留
- `de088a1d` fix(web): 点回当前工作区作废在途切换 + abort 按流归属单测
- `53544ed7` refactor(web): 移除右侧 DAG 流程面板(DagPanel)
- `de7563c6` refactor(api): 会话列表按创建时间降序
- `643ce714` feat(cli): 新增 @kaijia/workflows npm 全局 CLI 包(wf 命令)

### 2026-08-07(发版准备,即本次待发布内容)
- `0b982f2e` refactor(cli): 命令名 wf 改为 **wfs**,版本升至 0.2.0
- `dc5a53b2` fix(cli): 修复全局安装后前端资源 404(webDist 回退链补包内路径)—— 版本升至 0.2.1
- `f742b652` refactor(web): 工作区操作 UI 重构(只读切换移至右侧面板、移除按钮替换左栏 RW 徽标)
- `a569733c` docs: 根 README 重写为用户向,新增 MIT LICENSE 与 docs/development.md,根 package.json 补 license
- `268c7e82` feat(cli): prepack 时复制根 README/LICENSE 进发布包,补 license 字段
- `1c11d3c5` / `6caf9ab0`(HEAD,amend) chore: 提交工作流运行记录

## 5. 根目录文件清单

```
.git/  .gitignore  .husky/  .npmrc  .turbo/  .wf-runs/  .workflows/
AGENTS.md  apps/  docs/  kaijia-workflows-0.1.0.tgz  LICENSE
node_modules/  package.json  packages/  pnpm-lock.yaml
pnpm-workspace.yaml  README.md  turbo.json
```

→ 更新日志文件**不存在**,确认需新建;确切路径建议:**`CHANGELOG.md`(仓库根目录,与 README/LICENSE 同级)**。

## 6. 关键发现与风险点

1. **无 CHANGELOG、无 git tag**:全仓库发版痕迹仅剩 0.1.0 tgz 与版本号提交;发版全靠手动(publish:cli),无自动化、无发布清单。本次建议建立 CHANGELOG.md + 打 `v0.2.1` tag 作为起点。
2. **npm 已发布版本无法确证**:registry.npmjs.org 查询超时、无 tag 佐证;0.1.0 已发布为大概率(存在正式 pack 产物与完整 CLI 设计),0.2.x 是否发布未知。发版前必须先 `npm view @kaijia/workflows versions` 确认,避免版本号撞车。
3. **本地 main 领先 origin 22 个提交未推送**(origin/main = ae209aee):发版前需先 push。
4. **命令更名是破坏性变更**:0.1.0 时代命令为 `wf`,0.2.0 起为 `wfs`;若 0.2.x 未发布而本次直接发 0.2.1,CHANGELOG 必须显著标注 breaking change。
5. **CHANGELOG.md 不会进 npm 包**:`copy-docs.mjs` 只复制 README/LICENSE;若希望包内带更新日志,需同步修改 `packages/cli/scripts/copy-docs.mjs`(与 package.json 的 files 字段)。
6. 根/各 app 包 `version: 0.0.0` 为占位,勿误改;版本唯一真源 = `packages/cli/package.json`。

## 7. 结论

### 当前版本号
`0.2.1`(`packages/cli/package.json`,@kaijia/workflows;上次已知产物 0.1.0)。

### 建议的新版本号
- **主场景(0.2.x 未发布)**:直接以 **0.2.1** 发版——源码版本已是 0.2.1,0.2.0→0.2.1 仅含 wfs 更名 + 404 修复 + UI 重构 + docs,属 minor 级内容;发版同时打 tag `v0.2.1`。
- **备选场景(npm 上已存在 0.2.1)**:建议 **0.3.0(minor)**。理由:自 0.2.1 后无新 feat、无破坏性变更,严格 semver 可归 patch(0.2.2),但 `f742b652` 工作区操作 UI 重构为用户可见行为变更,且 0.x 阶段 minor 提升无兼容负担,取 0.3.0 更稳。

### 更新日志需新增的条目内容(建议写入新建的根 CHANGELOG.md)

```markdown
## [0.2.1] - 2026-08-07

### Added
- 新增 `@kaijia/workflows` npm 全局 CLI 包:自包含打包 api 源码与 web 构建产物,
  全局安装后 `wfs start` 一键启动 Web Agent 工作台(`wfs upgrade` 自动升级)
- prepack 自动复制根 README 与 MIT LICENSE 进发布包,补 license 字段
- 内置视觉理解工具 vision-understand(mimo-v2.5):支持本地图片路径 / URL / base64 三路输入,
  SSRF 防护;设置面板新增「视觉模型」tab(开关 + 小米 key)
- 工作区图片上传:聊天框粘贴图片(compressorjs 压缩),POST /uploads 存至 .workflows/uploads
- 内置 anysearch-search 网络搜索工具,前端设置弹窗配置 API key;图标统一改用 @lucide/vue
- 主代理编排工作流:explorer → planner(人工批准闸门)→ executor ⇄ reviewer 四子代理,
  黑板产物落盘 .wf-runs;complete_task 工具与 runId 按编排任务归并;done 冻结防空 run
- skills 多来源加载(pi 全局 / 项目 / 工作台 / 全局 agents),聊天框 `/` 搜索与 `/skill:<name>` 调用,
  工作区外 skills 只读放行(skillReadRoots / extraAllowedRoots)
- MCP client(stdio)外部工具接入:设置面板维护 mcp.json,工具以 mcp__<server>__<tool> 注册进主/子代理
- fff 索引搜索工具(fff-find/fff-grep)替代内置 grep/find;bash 禁用 find/rg/fd 递归搜索
- 工作区边界守卫:禁止工具逃逸到工作区外;只读工作区只暴露只读工具

### Changed
- **BREAKING**:CLI 命令由 `wf` 更名为 `wfs`(`wfs start` / `wfs upgrade` / `wfs -V`)
- 前端 UI 按 VoltAgent 设计规范整体重设计;移除右侧 DAG 面板,改为顶部流水线 + 右侧观测面板
- 工作区操作 UI 重构:只读切换移至右侧面板,移除按钮替换为左栏 RW 徽标
- 会话列表按创建时间降序(最新在前)
- 仓库由 dag-pi 更名为 workflows,包名/存储目录/品牌文案统一

### Fixed
- 修复全局安装后前端资源 404(webDist 回退链补包内路径)
- 修复生产构建产物缺失代理定义导致子代理静默失效
- 修复工作区切换窗口期发送竞态:SSE 事件按流归属过滤、activeEmitter 按 workspace 隔离、abort 按流归属
- 修复 subagent 模态窗 tools 无法展开 / 历史会话 tools 展开为空 / footer 重复摘要
- 修复视觉面板空 key 覆盖后端配置、保存失败回滚;image_urls SSRF 内网 IP 拦截调整
- 修复 ChatPane 发送并发锁、压缩失败剔除、发送失败恢复草稿、发送后清空缩略图
- a11y 批次:modal dialog contract、sr-only 表单标签、aria-expanded/aria-pressed、live regions、
  combobox 语义、heading outline、对比度与字号下限;响应式抽屉(<1100px)

### Docs
- 根 README 重写为用户向(快速开始 / 命令 / 配置 / FAQ),新增 MIT LICENSE 与 docs/development.md
```

(若走备选 0.3.0,仅需把标题与日期换成 `## [0.3.0] - 2026-08-07`,内容为上面 f742b652 起的 4 条。)

### 需要修改的确切文件路径清单

| 路径 | 操作 | 说明 |
| --- | --- | --- |
| `CHANGELOG.md`(新建,根目录) | 新增 | 写入上节条目;建议保留 `[Unreleased]` 段 |
| `packages/cli/package.json` | 视情况改 | 主场景(发 0.2.1)无需改;备选场景改 `version` → `0.3.0` |
| (建议)git tag | 新增 | `git tag -a v0.2.1` + push(仓库此前零 tag) |
| (可选)`packages/cli/scripts/copy-docs.mjs` | 修改 | 若需 CHANGELOG 随 npm 包发布,加入复制逻辑 |

### 可行性判断
完全可行且改动极小:版本号真源唯一、无历史 changelog 格式包袱、提交信息规范(conventional 前缀),一次「新建 CHANGELOG.md + 确认 npm 版本 + (可选 bump)+ tag + push」即可完成发版。前置动作:先 `npm view @kaijia/workflows versions` 确认 0.2.1 是否已被发布,并推送本地领先的 22 个提交。
