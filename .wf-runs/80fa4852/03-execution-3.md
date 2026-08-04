# 执行报告 3:P5 端到端验证 · 第一部分 — design 工具真实网络冒烟测试

> 对应计划 `.wf-runs/80fa4852/02-plan-3.md` Phase 5 第 6/7 步(不带 mock 的真实网络验证)。
> 方式:临时脚本 `.wf-runs/80fa4852/smoke-design.mts`(tsx 直跑 `apps/api/src/pi/designTools.ts` 源码导出,
> 未修改任何 src 代码;脚本用后已删除,下载产物保留为证据)。

## 冒烟测试结果表

| # | 调用 | 源(最终) | 耗时 | 大小 | 内容摘要 |
|---|------|---------|------|------|---------|
| 1 | `design` read(默认 path=README.md) | jsDelivr `https://cdn.jsdelivr.net/gh/VoltAgent/awesome-design-md@main/README.md` | 791ms | 16023 字节 | 仓库 README 全文,含设计清单;站点名命中 claude / vercel / linear / github / stripe / figma 等,首行即 VoltAgent logo 横幅链接 |
| 2 | `design` read path=design-md/claude/DESIGN.md | jsDelivr 同源 `...@main/design-md/claude/DESIGN.md` | 592ms | 33586 字节 | 内容完整:frontmatter(`version: alpha` / `name: Claude-design-analysis`)+ 完整设计分析正文(暖色画布 / 珊瑚色 CTA / serif 标题等风格要点) |
| 3 | `design` download path=design-md/claude/DESIGN.md dir=designs-smoke/claude | jsDelivr 同源 | 104ms | 33586 字节 | 落盘 `.wf-runs/80fa4852/designs-smoke/claude/DESIGN.md`,存在且非空(33586 字节,与 read 字节数一致);返回文本仅含路径+字节数+来源,无正文 |
| 4 | `design` read(jsDelivr 强制不可达 `cdnBase=https://cdn.invalid`) | **raw** `https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/README.md` | 610ms | 16023 字节 | 自动回退成功:URL 序列 `cdn.invalid(失败) → raw@main(2xx 即停)`,内容与用例 1 完全一致(16023 字节) |

## 合规确认

- **无 api.github.com 调用**:① 代码 grep —— `apps/api/src` 全文搜索 `api.github.com` **零命中**(design 工具仅 `cdn.jsdelivr.net/gh` + `raw.githubusercontent.com` 两个域名,`GITHUB_TOKEN` 不读取);② 运行时 —— 冒烟脚本用 `fetchImpl` 包装器记录了全部 4 个用例的**每个真实请求 URL**,`api.github.com` 请求数 = **0**。
- **无鉴权头**:所有请求仅带 `User-Agent: workflows-agent`,带 `Authorization` 的请求数 = **0**。
- 用例 1 首源即成功、仅 1 次请求(证明 jsDelivr 命中即停,无冗余重试)。

## 结论

**design 工具真实网络可用**。jsDelivr 主路径(CDN)在真实网络下对 README.md 与 DESIGN.md 的 read/download 全部成功;强制 jsDelivr 不可达时自动回退 `raw.githubusercontent.com` 成功且内容一致;全程无 api.github.com 请求、无 token 发送,与计划 D2"完全不走 GitHub API"的设计一致。无需配置代理。

## 说明与清理

- 临时脚本 `.wf-runs/80fa4852/smoke-design.mts` 已删除;下载产物 `.wf-runs/80fa4852/designs-smoke/claude/DESIGN.md`(33586 字节)保留作为落盘证据。
- 本次未修改任何 src 代码(纯验证),无需 typecheck/build 回归。
- 后续(计划 Phase 5 其余部分):完整对话流程(explorer 调研 → 闸门 → executor 下载)、驳回分支、只读工作区分支另见相应执行报告。
