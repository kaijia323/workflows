# 发版准备执行报告(workflows 0.3.0)

> 执行时间:2026-08-07 · 依据探索报告:`.wf-runs/f0f017b3/01-exploration-1.md`
> 范围:仅发版准备 3 项任务;未执行 git commit/push/tag/npm publish。

## 改动文件清单

| 文件 | 操作 | 改动内容 | 原因 |
| --- | --- | --- | --- |
| `packages/cli/package.json` | 修改 | `version`: `0.2.1` → `0.3.0`(仅此一处,其余字段未动) | 版本唯一真源;npm 已发布 0.1.0/0.2.0/0.2.1,工作区操作 UI 重构 + wf→wfs 更名等为行为变更,0.x 阶段取 minor bump |
| `CHANGELOG.md` | 新建(仓库根) | Keep a Changelog + Conventional Commits 风格全文 | 仓库此前无任何 CHANGELOG,本次建立更新日志基线 |

### CHANGELOG.md 结构(顶部)

```
# Changelog
(简介:遵循 Keep a Changelog / SemVer;发布对象 @kaijia/workflows,命令 wfs,版本真源 packages/cli/package.json)

## [0.3.0] - 2026-08-07        ← 本次待发布(22 个未发布提交,实际 21 个,见下)
  ### Added    CLI 包 + prepack 复制 README/LICENSE
  ### Changed  BREAKING wf→wfs 更名 / 工作区操作 UI 重构 / 移除 DAG 面板 / 会话降序
  ### Fixed    全局安装 404 / 工作区切换窗口期发送竞态
  ### Docs     根 README 重写 + LICENSE + docs/development.md

## [0.2.1] - 2026-08-07       ← 历史补录(已发布但从未记录)
  ### Added    视觉工具 / 图片上传 / anysearch / 编排工作流 / skills / MCP / fff / 工作区边界守卫
  ### Changed  VoltAgent 重设计 / 仓库更名 workflows
  ### Fixed    代理定义缺失 / subagent 模态窗 / 视觉面板 / ChatPane 并发 / a11y 批次

--- 底部格式约定:Keep a Changelog + feat→Added, fix→Fixed, docs→Docs, refactor/其他→Changed,ISO 日期
```

## 关键决策与依据

1. **[0.3.0] 内容范围 = origin/main..HEAD 全部未发布提交**。`git rev-list --count origin/main..HEAD` 实为 **21 个**(报告口径 22 = 21 + HEAD `6caf9ab0` 是 `1c11d3c5` 的 amend,amend 前身不计入),与任务描述吻合:含工作区操作 UI 重构(`f742b65`)、wf→wfs 更名(`0b982f2`)、CLI 包创建(`643ce71`)、404 修复(`dc5a53b`)、README 重写(`a569733`)等;chore 类(.wf-runs 运行记录)提交不进 CHANGELOG。
2. **[0.2.1] 历史条目 = 探索报告第 7 节建议条目剔除本次 21 提交内容后的剩余部分**(vision/skills/MCP/fff/编排/VoltAgent/a11y 等),避免与 [0.3.0] 重复计数;条目下加了一行「历史补录」说明。
3. **`packages/cli/scripts/copy-docs.mjs` 不改**(任务第 3 项评估结论):该脚本只复制根 README/LICENSE;而 npm 打包时仅自动附带 README/LICENSE/package.json,`CHANGELOG.md` 不在自动附带清单、也不在 `files: ["dist"]` 中。若要让 CHANGELOG 进 npm 包,必须同时改 `copy-docs.mjs` 与 `packages/cli/package.json` 的 `files` 字段——后者违反任务「version 之外字段不动」的约束,故不做(属「不过度改动」的合理取舍)。

## 自检结果

- `git diff`:仅 `packages/cli/package.json` 1 行变更(`version` 0.2.1→0.3.0),无其他文件被改动 ✓
- `node -e` 校验:package.json JSON 合法、`version === "0.3.0"` ✓
- CHANGELOG.md 已确认创建,顶部结构如上(标题 → 简介 → [0.3.0] → [0.2.1] → 底部格式约定)✓
- 未执行构建/测试/类型检查(纯元数据 + 文档改动,不影响产物);未执行 git commit/push/tag/npm publish ✓

## 未完成项与原因

- 无。发布动作(push / tag / npm publish)按约束留给用户;建议发版前先 `npm view @kaijia/workflows versions` 确认真源版本,并推送本地领先的 21 个提交。
