# 审查报告:根 README 重写 + MIT LICENSE + prepack 发布装配

> 审查对象:计划 `.wf-runs/f612b4e5/02-plan-1.md`(已批准)vs 执行 `.wf-runs/f612b4e5/03-execution-1.md`
> 审查方式:只读核对产物文件(根 README/LICENSE/package.json、docs/development.md、packages/cli 全套)、npm-packlist 官方文档核实、与探索报告(01-exploration-1/2)交叉验证

## 结论:pass

---

## 逐条核对结果

### 1. 需求符合性

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 根 README 用户向 | 通过 | 结构 = 简介 + 核心特性(10 条)/快速开始/命令一览/配置说明/常见问题/从源码运行/项目地址,全部用户视角;无技术栈/API 表/构建命令等开发者内容 |
| 根 README 无 DAG 残留 | 通过 | fff-grep `dag|DAG` 对根 README 0 命中;原 4 处残留(L3 项目定位、L11 工作流编排、L178 /dag 行、L189 /run 行)已全部消除或迁移改写 |
| 「工作流编排」表述与现状一致 | 通过 | 改写为「顶部流水线(源→处理→观测)+ 右侧观测面板(工作区/会话/用量/工具流/系统)+ 点击子代理块回看」,与探索报告 §1.2 前端现状(PipelineHeader/InfoPanel/SubAgentModal)一致,无「DAG 图」字样 |
| LICENSE 标准 MIT + 署名 | 通过 | LICENSE 全文为标准 MIT 文本(与计划附录 A 逐字一致);版权行 `Copyright (c) 2026 kaijia323`,为 D1 默认建议值,执行报告称已确认 |
| 发布链路真正带上 README/LICENSE | 通过 | `prepack` = prepare → tsc → copy-assets → copy-docs;`pnpm publish` 与 `pnpm pack` 均触发 prepack(官方生命周期);copy-docs 将根 README/LICENSE 复制到包根;`files:["dist"]` 白名单不影响——npm-packlist 规则 1「Always include the root readme, license...」+ npm 官方博客「npm will always include: package.json, README, LICENSE」 |
| **`.gitignore` 交互风险(npm pack 是否排除被 ignore 的 README/LICENSE)** | 通过(风险已排除) | 双重保障:① npm-packlist v6.0.0+ 明确「If you have a package.json file with a `files` array, any top level `.npmignore` and `.gitignore` files **will be ignored**」——`packages/cli/.gitignore` 在打包时根本不被读取;② 即使不读 files 字段,根 README/LICENSE 也属「always included regardless of rules」。佐证:执行报告步骤 4/5 的 `tar -tzf` 清单 + 解压 diff 为空,证据 tarball 保留在 `.wf-runs/f612b4e5/pack-check/kaijia-workflows-0.2.1.tgz`(文件在盘可查)。**结论:gitignore 掉这两个生成物不会导致 npm pack 遗漏它们,设计成立** |

### 2. 内容一致性

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 吸收 packages/cli/README.md 无遗漏 | 通过 | 10 条核心特性(工作区管理/持久化会话/SSE 流式/模型配置/工作流编排/代理即 md/skills/MCP/识图/黑板产物)全覆盖;快速开始(npm i -g + pnpm add -g、--port 优先级、--dev 措辞「包安装位置上一级」与 2e125f07 修订版一致)、命令一览(含 --dry-run)、配置说明(~/.workflows/ 五类文件)、FAQ(3 条)、项目地址均完整保留 |
| docs/development.md 零丢失迁移 | 通过 | 原根 README 全部开发者小节在册:项目定位(去「(DAG 可视化骨架)」)、技术栈表、数据存储(含 mcp.json 信任模型)、Skills(格式/四来源/注意事项)、MCP(配置/生效/安全)、端口策略、命令、CLI 发布(发布产物/prepack 四步链/验证命令,并注明「发布前置:根 LICENSE 必须存在」)、API 一览、目录结构(components 注释补 InfoPanel/PipelineHeader)、文档索引 |
| /dag 与 /run 行修正 | 通过 | API 表 `/dag` 行标注「示例端点,前端已不使用(已废弃的死端点)」;`/run` 行为「当前 run 快照(闸门状态 / 断连恢复)」,无 DAG 字样 |
| 链接有效性 | 通过 | 根 README → docs/development.md ✅;docs/development.md → ../README.md ✅、dag-workflow.md ✅、mcp.md ✅(docs/ 目录三文件均在盘) |

### 3. 脚本正确性

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| copy-docs.mjs 路径解析 | 通过 | `import.meta.url` → dirname → `..`(包根)→ `../..`(仓库根),与 prepare.mjs 完全同款;纯 Node API,Windows 安全 |
| 错误处理 | 通过 | 源缺失 → `console.error` + `process.exit(1)`,报错信息指明文件与动作;执行报告步骤 2 实测 exit 1 后恢复 |
| 风格一致性 | 通过 | `[copy-docs]` 日志前缀、cpSync 覆盖语义(force 默认 true)、注释风格均对齐 prepare.mjs |
| prepack/build 拆分 | 通过 | `build` 链不动(日常构建不因文档缺失失败、不弄脏工作区);`prepack` 末尾追加 copy-docs;`pnpm pack`/`pnpm publish` 均触发 prepack(与探索报告 §1.2 生命周期结论一致) |

### 4. 范围控制

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 未误改范围外文件 | 通过 | 改动集 = 计划所列 8 项(新建 LICENSE/docs-development.md/copy-docs.mjs,重写 README,修改 cli package.json/cli .gitignore/根 package.json,删除 cli README);`apps/api`、`apps/web`、`packages/shared`、`docs/dag-workflow.md`、`docs/mcp.md` 未动(执行报告 git status 与此一致,无反向证据);D4/D5 边界项(dag-workflow.md、/api/dag 死端点、shared 死类型)保持不动并已在 development.md 文档索引/API 表标注 |

### 5. 元信息

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| cli license/description/keywords | 通过 | `"license": "MIT"` 置于 version 后(计划指定位置);description「DAG 工作流编排」→「流水线式工作流编排」;keywords 删 `dag`、加 `pipeline`(D6 采纳),grep 复核无残留 |
| 根 package.json license | 通过 | `"license": "MIT"` 已补(D3 默认采纳,AC11);其余 3 个私有包未动,符合边界 |

### 6. 验收标准对照(计划 §3)

AC1–AC11 全部达成(证据见上);AC12(提交拆分)未执行——执行报告已如实标注为未完成项,任务未含提交指令,D7 为闸门决策项,属待办而非缺陷。

---

## 问题清单(无阻断性问题)

| # | 文件/位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1 | 全仓库(无) | 无阻断问题。git 提交未执行(计划 Step 5 / AC12 ⏸) | 按计划拆分两条提交:① docs(根 LICENSE/README.md/docs-development.md/根 package.json)② chore(cli) |
| 2 | LICENSE 版权行 | 署名 `kaijia323` 依据 remote owner 推断(本地无 git user 信息),若需真名/其他署名,发布前是最后低成本修改窗口 | 首次 publish 前确认一次 D1;之后改署名需重新发版(R5) |
| 3 | docs/dag-workflow.md、/api/dag | 过期设计文档与死端点按 D4/D5 保留,与「修正 DAG 已删除事实」的目标长期共存,可能再次被误读为现状 | 已在 development.md 文档索引/API 表显式标注;若日后有专门任务可清理 |
| 4 | 核心特性条数 | 计划写「9 条照搬」,执行为 10 条(含黑板产物);内容为超集、无遗漏,源自 cli README 本身条数统计口径 | 无需处理,仅记录口径差异 |

---

## 最终建议:**通过**

执行与已批准计划一致,验收标准 AC1–AC11 达成;用户需求(根维护 README/LICENSE、发布期复制进包、补 MIT、修正 DAG 表述)全部落实。重点风险「.gitignore 导致 npm pack 排除 README/LICENSE」经 npm-packlist 官方规则核实 + tarball 实证双重确认不成立。仅剩提交与署名确认两个非阻塞待办。
