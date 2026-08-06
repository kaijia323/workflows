# Changelog

本仓库更新日志遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[Semantic Versioning](https://semver.org/lang/zh-CN/)。发布对象为 `@kaijia/workflows`(命令 `wfs`),
版本号定义于 `packages/cli/package.json`。

## [0.3.0] - 2026-08-07

### Added

- 新增 `@kaijia/workflows` npm 全局 CLI 包:prepack 时自包含打包 api 源码与 web 构建产物,
  `pnpm publish:cli` 一键发布,全局安装后 `wfs start` 启动 Web Agent 工作台
- prepack 自动复制根 README 与 MIT LICENSE 进发布包,补 license 字段

### Changed

- **BREAKING**:CLI 命令由 `wf` 更名为 `wfs`(`wfs start` / `wfs upgrade` / `wfs -V`)
- 工作区操作 UI 重构:只读切换移至右侧面板,移除按钮替换为左栏 RW 徽标
- 移除右侧 DAG 流程面板(DagPanel)
- 会话列表按创建时间降序(最新在前)

### Fixed

- 修复全局安装后前端资源 404(webDist 回退链补包内路径)
- 修复工作区切换窗口期发送竞态:SSE 事件按流归属过滤、activeEmitter 按 workspace.id 隔离、
  点回当前工作区作废在途切换、abort 按流归属

### Docs

- 根 README 重写为用户向(快速开始 / 命令 / 配置 / FAQ),新增 MIT LICENSE 与 docs/development.md

## [0.2.1] - 2026-08-07

> 历史补录:0.2.1 已发布于 npm,此前从未记录。

### Added

- 内置视觉理解工具 vision-understand(mimo-v2.5):支持本地图片路径 / URL / base64 三路输入,
  SSRF 防护;设置面板新增「视觉模型」tab(开关 + 小米 key)
- 工作区图片上传:聊天框粘贴图片(compressorjs 压缩),POST /uploads 存至 .workflows/uploads
- 内置 anysearch-search 网络搜索工具,前端设置弹窗配置 API key;图标统一改用 @lucide/vue
- 主代理编排工作流:explorer → planner(人工批准闸门)→ executor ⇄ reviewer 四子代理,
  黑板产物落盘 .wf-runs;complete_task 工具与 runId 按编排任务归并;done 冻结防空 run
- skills 多来源加载(pi 全局 / 项目 / 工作台 / 全局 agents),聊天框 `/` 搜索与 `/skill:<name>` 调用,
  工作区外 skills 只读放行(skillReadRoots / extraAllowedRoots)
- MCP client(stdio)外部工具接入:设置面板维护 mcp.json,工具以 `mcp__<server>__<tool>` 注册进主/子代理
- fff 索引搜索工具(fff-find/fff-grep)替代内置 grep/find;bash 禁用 find/rg/fd 递归搜索
- 工作区边界守卫:禁止工具逃逸到工作区外;只读工作区只暴露只读工具

### Changed

- 前端 UI 按 VoltAgent 设计规范整体重设计(表现层)
- 仓库由 dag-pi 更名为 workflows,包名/存储目录/品牌文案统一

### Fixed

- 修复生产构建产物缺失代理定义导致子代理静默失效
- 修复 subagent 模态窗 tools 无法展开 / 历史会话 tools 展开为空 / footer 重复摘要
- 修复视觉面板空 key 覆盖后端配置、保存失败回滚;image_urls SSRF 内网 IP 拦截调整
- 修复 ChatPane 发送并发锁、压缩失败剔除、发送失败恢复草稿、发送后清空缩略图
- a11y 批次:modal dialog contract、sr-only 表单标签、aria-expanded/aria-pressed、live regions、
  combobox 语义、heading outline、对比度与字号下限;响应式抽屉(<1100px)

---

*Changelog 遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),分类遵循 Conventional Commits:
`feat` → Added,`fix` → Fixed,`docs` → Docs,`refactor`/其他 → Changed;日期格式为 ISO 8601(YYYY-MM-DD)。*
