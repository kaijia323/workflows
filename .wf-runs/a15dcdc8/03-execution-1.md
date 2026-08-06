# 执行报告:修复审查报告(04-review-1.md)3 个 minor 问题

> 依据:`.wf-runs/a15dcdc8/04-review-1.md` 问题清单 #1–#3。仅修这 3 项,其余(问题 #4–#6)未触碰。

## 改动文件清单

### 1. `--dev` 存储根文案修正(问题 #1)

- **packages/cli/src/cli.ts**(HELP 文本两处)
  - `--dev` 行:「存储根 = 包内 .workflows」→「存储根 = 包上一级 .workflows」
  - 存储根说明行:`--dev 模式 <cli 包>/.workflows` → `--dev 模式 <cli 包> 上一级 .workflows(仓库内为 packages/.workflows,全局安装为 node_modules/.workflows)`
- **README.md** 两处(`wf start --dev` 注释、存储根 bullet):「包内 .workflows」→「包上一级 .workflows」,并注明仓库内即 `packages/.workflows`
- 依据:apps/api/src/config.ts `workflowsRoot()` 实现为 `dist/api`(src/api 同构)向上三级 → 仓库内 `packages/.workflows`、全局安装 `<global-prefix>/node_modules/.workflows`,即「包所在目录的上一级」,差一级,文案已对齐实现(不写 ~/.workflows 的核心语义不变)。

### 2. startServer 端口占用友好报错(问题 #2)

- **apps/api/src/index.ts** `startServer` 内 `serve()` 之后、等待 listening 之前新增:
  - `server.on('error', ...)`:EADDRINUSE 时打印「端口 X 已被占用,请换一个端口(如 --port <port>)」,其他错误打印「服务启动失败:<message>」,均 `process.exit(1)`(避免裸抛堆栈与 await 挂起)
  - 正常启动路径(listening 日志、SIGINT/SIGTERM 优雅退出)原样不动

### 3. tgz 进 .gitignore(问题 #3)

- **.gitignore**(根):build outputs 段后新增 `# pack artifacts` 块 + `*.tgz`(此前任何 .gitignore 均无 tgz 规则,无重复/冲突)

## 自检结果

| 项目 | 结果 |
| --- | --- |
| `pnpm --filter @kaijia/workflows typecheck`(packages/cli,tsc --noEmit) | ✅ 通过,零错误 |
| `pnpm --filter @workflows/api typecheck`(apps/api,验证 index.ts 改动) | ✅ 通过,零错误 |
| `git check-ignore -v kaijia-workflows-0.1.0.tgz` | ✅ 命中 `.gitignore:10:*.tgz`,产物不再污染 git status |

## 未完成项

- 无。未触碰 5200 端口现有进程、未重新 pack/发布(按约束);packages/cli/src/api/ 为 gitignored 构建复制品,index.ts 修复将在下次 cli build 时经 prepare.mjs 自动同步,无需手动改。
