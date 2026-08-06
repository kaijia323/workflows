# 执行报告:根维护 README + LICENSE(MIT),发布时复制进 packages/cli

> 计划:`.wf-runs/f612b4e5/02-plan-1.md`(已批准);探索依据:`01-exploration-1.md`、`01-exploration-2.md`
> 执行日期:2026(仓库时间线);环境:Windows + Node v24.9.0 + pnpm 10.33.0

## 1. 改动文件清单

| 文件 | 操作 | 要点 |
| --- | --- | --- |
| `LICENSE` | 新建 | 标准 MIT 全文,版权行 `Copyright (c) 2026 kaijia323`(闸门 D1 已确认) |
| `README.md` | 重写(用户向) | 吸收 `packages/cli/README.md` 全部内容:产品定位、核心特性(10 条)、快速开始、命令一览、配置说明、FAQ;「工作流编排」特性条改写为「顶部流水线(源 → 处理 → 观测)+ 右侧观测面板(工作区/会话/用量/工具流/系统)+ 点击聊天中子代理块回看对话」,无「DAG 图」字样;新增「从源码运行」节(3 行 + 开发文档链接);「项目地址」保留仓库链接 |
| `docs/development.md` | 新建 | 原根 README 开发者内容逐节迁移(零丢失):项目定位(去 DAG 表述)、技术栈、数据存储(`.workflows/`)、Skills(格式/四来源/注意事项)、MCP(配置/生效时机/安全模型)、端口策略、命令、CLI 发布(开发者向)、API 一览、目录结构(components 注释补 InfoPanel/PipelineHeader)、文档索引(注明 dag-workflow.md 为历史设计文档);开头注明「开发者文档,用户请见根 README.md」;API 表 `/dag` 行标注「示例端点,前端已不使用(已废弃的死端点)」,`/run` 行改为「run 快照(闸门状态 / 断连恢复)」;CLI 发布节补充 copy-docs.mjs 为 prepack 第 4 步并注明发布前置(根 LICENSE 必须存在) |
| `packages/cli/scripts/copy-docs.mjs` | 新建 | 风格对齐 prepare.mjs:纯 Node `fs`/`path` API(Windows 安全);从脚本 `../..` 解析仓库根,复制 `README.md`、`LICENSE` 到包根;源缺失 `console.error` + `process.exit(1)`;`cpSync` 覆盖语义;输出 `[copy-docs]` 成功日志 |
| `packages/cli/package.json` | 修改 | ① 顶层补 `"license": "MIT"`(version 后);② `prepack` 末尾追加 `&& node scripts/copy-docs.mjs`(build 链不动);③ description「DAG 工作流编排」→「流水线式工作流编排」;④ keywords 删 `"dag"`、加 `"pipeline"`(闸门 D6) |
| `packages/cli/README.md` | 删除 | untracked 文件直接 `rm`;内容已并入根 README,包内版本由 copy-docs.mjs 生成 |
| `packages/cli/.gitignore` | 修改 | 追加 `/README.md`、`/LICENSE` 两条 + 注释「由 scripts/copy-docs.mjs 在 prepack 时复制,不提交」 |
| `package.json`(根) | 修改 | 补 `"license": "MIT"`(闸门 D3 默认采纳,与根 LICENSE 呼应;其余私有包未动) |

未改动(遵守边界):`apps/api`、`apps/web`、`packages/shared`、`docs/dag-workflow.md`、`docs/mcp.md`、3 处过时源码注释、`/api/dag` 死端点。

## 2. 验证结果

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | `node packages/cli/scripts/copy-docs.mjs` 冒烟 | ✅ 两行 `[copy-docs]` 日志;生成 `packages/cli/README.md`、`LICENSE`;`diff` 与根文件**均为空**(完全一致) |
| 2 | 失败路径(临时改名根 LICENSE 后运行) | ✅ `[copy-docs] 未找到根 LICENSE…` + exit 1;测后 LICENSE 已恢复 |
| 3 | `pnpm --filter @kaijia/workflows pack --pack-destination .wf-runs/f612b4e5/pack-check` | ✅ prepack 四步链(prepare → tsc → copy-assets → copy-docs)完整执行,tarball 生成:`kaijia-workflows-0.2.1.tgz`(apps/web/dist 已存在,满足 prepare 前置) |
| 4 | tarball 清单 | ✅ `package/README.md`、`package/LICENSE` 均在列(npm 自动附带) |
| 5 | tarball 内容一致性 | ✅ 解压后 `diff extracted/package/README.md ↔ 根 README.md`、`LICENSE` 均**为空** |
| 6 | tarball 内 dag 表述 | ✅ `README.md` / `LICENSE` / `package.json` 三份元信息 **0 命中**;代码侧命中 5 个文件全部为已批准范围外或无关子串:`app.js`(`/api/dag` 死端点 + 注释,计划明确不清理)、`agent/routes.js`(过时注释,计划明确不改)、`agentDefs.js`(`loadAgentDefinitions` 函数名子串)、css/woff(构建产物 base64 字节巧合) |
| 7 | 根 README dag 表述(AC2) | ✅ grep 0 命中 |
| 8 | docs/development.md dag 命中(AC4) | ✅ 仅 2 处,均为计划允许项:API 表 `/dag` 行「已废弃的死端点」标注、文档索引中 dag-workflow.md 历史文档说明 |
| 9 | typecheck 回归(AC10) | ✅ `pnpm --filter @kaijia/workflows typecheck` 通过;`pnpm typecheck` 4/4 任务成功 |
| 10 | git 状态(AC5/AC6) | ✅ `packages/cli/README.md` 已从 untracked 消失;`git check-ignore` 确认 `packages/cli/README.md`、`LICENSE` 被 `.gitignore` 忽略;`git status` 仅显示预期改动(M: README.md / package.json / cli .gitignore / cli package.json;??: LICENSE / docs/development.md / cli scripts/copy-docs.mjs) |

## 3. 未完成项与说明

- **git 提交未执行**:计划 Step 5 建议按两条拆分提交(docs / cli),但任务执行步骤未包含提交指令,故未执行 commit,留待用户确认后手动提交(建议信息见计划 Step 5)。
- **pack 验证方式**:`--pack-destination` 用仓库内 `.wf-runs/f612b4e5/pack-check/`(Windows 下 `/tmp` 不可靠);tarball 保留于该目录作为验证证据(`.wf-runs` 已被 gitignore),解压目录已清理。
- **D3(根 package.json license)**:任务步骤未显式列出,但计划闸门默认采纳「补」且为 AC11 验收项,故已补;如用户不想要可一行还原。
- 其余闸门(D4 不动 dag-workflow.md、D5 不动死端点/死类型、D7 拆分)按计划默认执行。

## 4. 验收对照(计划 §3)

AC1 ✅ 根 LICENSE(MIT,署名已确认)· AC2 ✅ 根 README 用户向、dag 0 命中 · AC3 ✅ 特性条与前端现状一致(顶部流水线 + 右侧观测面板,无「DAG 图」)· AC4 ✅ 开发者内容零丢失迁移,`/dag` 标注、`/run` 无 DAG 字样 · AC5 ✅ cli README 已删除 · AC6 ✅ .gitignore 含注释两条且 git status 不可见 · AC7 ✅ license 字段 / description、keywords 无 dag / prepack 四步链,build 不动 · AC8 ✅ 失败路径 exit 1 + 明确报错 · AC9 ✅ tarball 含 README/LICENSE 且与根一致 · AC10 ✅ typecheck 全通过 · AC11 ✅ 根 package.json 已补 license · AC12 ⏸ 提交未执行(见未完成项)。
