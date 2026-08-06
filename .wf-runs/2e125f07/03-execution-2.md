# 执行报告:packages/cli/README.md 措辞修订(审查非阻塞项)

> 执行时间:2026-08-07;依据 `.wf-runs/2e125f07/04-review-1.md` 问题清单第 1、2 项;只修改 `packages/cli/README.md`,未动其他文件。

## 改动文件清单

### 1. `packages/cli/README.md` — 末尾「许可」节标题

- **改动**:`## 许可` → `## 项目地址`
- **原因**:该节内容仅为仓库链接,无任何许可声明,原标题误导用户;「项目地址」与正文「本项目仓库地址:https://github.com/kaijia323/workflows」完全对应(采用审查报告建议的标题)。
- **前后对比**:
  - 前:`## 许可` / 本项目仓库地址:https://github.com/kaijia323/workflows
  - 后:`## 项目地址` / 本项目仓库地址:https://github.com/kaijia323/workflows(正文未动)

### 2. `packages/cli/README.md` — 快速开始 `--dev` 参数注释

- **改动**:「开发模式:运行数据存到**包所在位置的** .workflows,不写入 ~/.workflows」→「开发模式:运行数据存到**包安装位置上一级的** .workflows,不写入 ~/.workflows」
- **原因**:原表述易误解为包目录内;实际为包安装位置**上一级**的 .workflows(全局安装即 `node_modules/.workflows`,与 cli.ts HELP 一致)。
- **前后对比**:
  - 前:`wfs start --dev         # 开发模式:运行数据存到包所在位置的 .workflows,不写入 ~/.workflows`
  - 后:`wfs start --dev         # 开发模式:运行数据存到包安装位置上一级的 .workflows,不写入 ~/.workflows`

## 自检结果

- 两处修改位置逐一重读核实,均已生效;
- 其余内容(H1、核心特性、快速开始其余行、命令一览、配置说明、FAQ)与改动前逐字一致,未触碰;FAQ 中「包安装位置附近」措辞审查已确认准确,保持原样;
- 仅改 `packages/cli/README.md` 一个文件;`git status` 显示 `packages/cli/package.json` 的 M 状态为上一轮执行(01-exploration/03-execution-1)遗留,本次未动;
- 审查报告第 3 项(补 `license` 字段)为 advisory 且需仓库先补 LICENSE,超出本次范围,未执行。

## 未完成项

- 无。审查报告问题 1、2 已全部修订;问题 3 属建议项,维持原跳过决定。
