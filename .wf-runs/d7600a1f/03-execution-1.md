# 执行报告:AGENTS.md 旧文案同步(MCP 保存即生效)

## 计划文件说明

产物目录 `.wf-runs/d7600a1f/` 内仅有 `run.json`(status=planning,无 `02-plan-*.md`),本任务以任务说明中的要求为准执行,并参照了相邻运行 `9c4a0796`(MCP 热更新功能实现轮)的 review 观察项 O1/P3(AGENTS.md:22 遗留旧文案)与 README.md / docs/mcp.md 的规范语义。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `AGENTS.md`(第 22 行,MCP 外部工具 bullet) | 「只读工作区不注册 MCP 工具;**配置变更后需新建会话/重开工作区生效**;详情见 `docs/mcp.md`」→「只读工作区不注册 MCP 工具;**配置保存后立即生效(忙碌会话下一回合生效),手工编辑 mcp.json 需重启进程生效**;详情见 `docs/mcp.md`」 | MCP 配置热更新已上线,旧文案与实际行为(保存即生效)及 README.md:45 / docs/mcp.md §4「生效时机」相矛盾;按任务要求改为与 README/docs 一致的语义 |

改动为单行最小替换(1 insertion / 1 deletion),未触碰其他内容。

## 未误改项

- **Skills 表述保持不变**:AGENTS.md:51「新增/修改 skill 后需重开会话模型才感知」未改动(skills 仍维持"新会话生效"语义,与任务要求一致)
- 未改 README.md / docs/mcp.md / McpPanel.vue(不在本任务范围)

## 自检结果

- **残留检查**:grep AGENTS.md「新建会话|重开工作区|配置变更后」→ 0 匹配;MCP 相关旧文案无残留
- **语义核对**:新文案与 README.md:45「保存后立即生效…忙碌会话下一回合生效…手工编辑 mcp.json 需重启进程生效」及 docs/mcp.md §4「生效时机(保存即生效)」一致
- **git diff**:仅 AGENTS.md 一行变更
- **CI 钩子**:commit 触发 lint-staged + typecheck(turbo 3/3 通过)+ test(web 53 通过,api 292 通过 1 skip)——均为 cache hit / 通过

## 提交

- `1083804` docs: AGENTS.md MCP 生效时机文案改为保存即生效(独立 commit,仅含 AGENTS.md)

## 未完成项

无。
