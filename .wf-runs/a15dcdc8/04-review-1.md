# 审查报告:CLI 打包改造(对照 `.wf-runs/a15dcdc8/02-plan-3.md`)

> 审查方式说明:执行报告 `03-execution-*.md` 缺失(run.json 状态仍为 `executing`),本次审查直接对工作区实际改动做静态核验:逐个读取新增/修改文件、比对计划、核验构建产物(dist 树、turbo 日志、lockfile、tgz 存在性)与文档一致性。
> 环境无 shell,无法实跑 node/tar/pnpm,运行时冒烟项以代码路径静态核验替代,已在问题清单标注。

---

## 结论:pass

无 blocker、无 major。全部 5 条验收项中 3 条静态确认通过、2 条(实机冒烟与正式发布)因环境/发布动作未执行但代码路径核验无缺陷;4 个 minor 问题不影响交付,建议顺手修复。

---

## 验收清单逐项核对

| # | 计划验收项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | `packages/cli/package.json` 含 `bin.wf`、`files:["dist"]`、engines、9 个运行时依赖且无 workspace:/私有依赖 | ✅ 通过 | `bin.wf → ./dist/cli.js`、`files:["dist"]`、`engines.node >=20.19.0`、`publishConfig.access public`。dependencies 恰 9 个(pi-ai/pi-coding-agent/fff-node/node-server/mcp-sdk/hono/picomatch/typebox/unbash),`@workflows/shared` 仅以 `workspace:*` 出现在 devDependencies;pnpm-lock.yaml `packages/cli` importer 与 package.json 完全一致,无泄漏。 |
| 2 | `pnpm build && pnpm typecheck` 全绿;`pnpm start` 回归正常 | ✅ 通过(静态) | `packages/cli/.turbo/turbo-build.log` 零错误(prepare 复制 + tsc + copy-assets 全部成功);`turbo-typecheck.log` 零输出(通过)。apps/api/dist 已重建为新代码(含 `startServer` 导出与直接运行守卫);apps/web/dist、packages/shared/dist 均存在。`pnpm start`(= `node dist/index.js`)直接运行守卫判定成立(`import.meta.url === pathToFileURL(path.resolve(argv[1]))`),生产默认端口 5200、PORT 覆盖逻辑原样保留,行为不变。运行时未实跑。 |
| 3 | `tar -tf` 产物含 shebang 的 `dist/cli.js`、`dist/api/pi/agents/*.md`、`dist/web-dist/index.html` | ✅ 通过(结构性核验) | 无法执行 tar,核验 pack 内容源(与 tgz 内容一一对应):`dist/cli.js` 首行 `#!/usr/bin/env node`;`dist/api/pi/agents/` 含 executor/explorer/orchestrator/planner/reviewer 5 个 .md;`dist/web-dist/` 含 index.html + assets/。`files:["dist"]` + npm 自动附带 package.json ⇒ tgz 内容确定。tgz 产物 `kaijia-workflows-0.1.0.tgz` 存在于仓库根。 |
| 4 | tarball 隔离安装后 `wf --version/--help/start`/端口优先级/`upgrade --dry-run` | ⚠️ 未实跑,代码路径静态核验通过 | 见问题 6。`--version` 读 `../package.json`(dist 与安装后布局均指向包根 ✓);`--help` 固定文本退出 0 ✓;`resolvePort` 严格实现 `--port > PORT > 5200`,非法值报错退出 1 ✓;`NODE_ENV` 在动态 import 之前设置 ✓;`upgrade --dry-run` 按 `npm_config_user_agent` 探测 pnpm/npm/yarn/bun 输出安装器+命令、退出 0 ✓;实跑失败(spawn error/非零退出)打印手动命令退出 1 ✓。 |
| 5 | 正式 `npm i -g @kaijia/workflows` 后同套验收 | ⏸ 未执行 | 属发布动作,计划步骤 7 前置条件(authToken 配置)未确认,不视为缺陷。 |

---

## 计划项逐条核对

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| §0 决策:新建 `packages/cli`、prepare.mjs 整树复制、版本读 ../package.json | ✅ 通过 | 与计划一致。复制+编译+资源复制三阶段结构完整。 |
| §1 包骨架:package.json/tsconfig/.gitignore/.npmrc/根 publish:cli | ✅ 通过 | 全部就位;tsconfig 与 apps/api 完全一致(含 `types:["node"]`、sourceMap);`.gitignore` 忽略 `src/api/` 与 `dist/`;根 `.npmrc` 仅 registry(无 authToken,符合不入库要求);根 package.json 增 `publish:cli`。 |
| §1 附加:eslint 覆盖 cli.ts | ⚠️ 偏离(等价实现) | 计划假设根 eslint 配置存在并覆盖新包;实际仓库无根级 eslint.config.mjs(四个子包各自携带,是既有惯例),executor 为 cli 包新增 `packages/cli/eslint.config.mjs`(ignores 排除 src/api 复制品),turbo lint 按包运行正常。lint-staged 从仓库根运行对全部包均找不到配置——仓库既有状况,非本次引入(见问题 4)。 |
| §2 app.ts webDist 回退链 | ✅ 通过 | `WF_WEB_DIST` → `../../web/dist` → `web-dist`,仓库内命中不变,CLI 包内命中 `dist/web-dist`;改动仅限文件头部,`hasWebDist` 逻辑原样。 |
| §2 index.ts startServer + 守卫 | ✅ 通过 | `startServer(port)` 原样搬入 serve/监听日志/SIGINT/SIGTERM dispose/5s 兜底;守卫 `entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href` 对 `node dist/index.js`、`tsx src/index.ts`、CLI 动态 import 三种场景判定均正确;`pnpm dev`(tsx)与 `pnpm start`(dist)行为不变。 |
| §3 cli.ts 命令实现 | ✅ 通过 | 单文件零 CLI 依赖、shebang 保留(tsc 验证)、子命令优先分派避免 `wf start --port 5201` 被顶层 parseArgs 误报、未知命令/flag 退出 1、`start --help` 可用。upgrade 安装器探测与权限失败降级(打印手动命令退出 1)符合计划。 |
| §4 prepare.mjs / copy-assets.mjs / prepack 链路 | ✅ 通过 | prepare 排除 `*.test.ts`(apps/api/src 有 app/config/mcpConfig/pi/*.test.ts 均被滤除,dist/api 无任何 .test.js 残留 ✓)、含 pi/agents/*.md;硬性前置校验 web dist 存在;prepack = 完整构建;copy-assets 目标路径与 agentDefs.ts `BUILTIN_AGENTS_DIR` 在 dist 层级吻合。 |
| §4 dependencies 完整性 | ✅ 通过 | 全量 grep `apps/api/src` 非测试 import:全部落在 9 个 dependencies 内;`@workflows/shared` 全部为 `import type`(编译擦除),零运行时依赖成立。 |
| §5 全仓库验证 | ✅ 通过(静态) | cli 包 build/typecheck 日志零错误;api/web/shared 构建产物均在。`pnpm start` 回归见验收项 2。 |
| §6 tarball 冒烟 | ⚠️ 未实跑 | 无 shell 环境;见问题 6。 |
| §7 正式发布 | ⏸ 未执行 | 发布动作,计划内。 |
| §8 风险缓解 | ✅ 通过 | prepare 全量覆盖复制 ✓;shared 为 type-only(已核验)✓;prepack 前置校验 ✓;`--dev` 不写 ~/.workflows ✓(位置见问题 1);lint-staged 风险见问题 4。 |

---

## 问题清单

1. **[minor] `--dev` 存储根文案与实现不符(差一级目录)**
   - 位置:`packages/cli/src/cli.ts` HELP 文本(「存储根 = 包内 .workflows」);`README.md:164`;实现:`apps/api/src/config.ts:14-19` `workflowsRoot()` 向上三级。
   - 描述:dev 模式实际存储根 = `dist/api` 向上三级 → 仓库内为 `packages/.workflows`(计划预期 `packages/cli/.workflows`),全局安装时为 `<global-prefix>/node_modules/.workflows`(与其它全局包共享)。「不写 ~/.workflows」的核心语义成立,但「包内」表述不准确。
   - 建议:修正 cli.ts HELP 与 README 文案;如要求包内,需在 config.ts 对 CLI 场景特判(env 覆盖或按模块层级区分),超出最小改动范围,可不做。

2. **[minor] `startServer` 无 'error' 监听,端口占用时崩溃堆栈**
   - 位置:`apps/api/src/index.ts` `startServer`(serve 调用处)。
   - 描述:端口被占(EADDRINUSE)时 server 触发 'error' 事件且无监听器 → Node uncaught 崩溃带堆栈(exit 1),提示不友好;与原仓库行为一致,非本次回归,但 `wf start` 场景下更易暴露。
   - 建议:`serve()` 后挂 `server.on('error', ...)` 打印「端口 X 被占用」并 `process.exit(1)`。

3. **[minor] pack 产物 tgz 未纳入 .gitignore**
   - 位置:仓库根 `kaijia-workflows-0.1.0.tgz`;根 `.gitignore` 无 `*.tgz`。
   - 描述:未跟踪的构建产物会污染 `git status`/提交风险。
   - 建议:根 `.gitignore` 增加 `*.tgz`。

4. **[minor] lint-staged 从仓库根运行 eslint 找不到配置(既有状况)**
   - 位置:根 `package.json` lint-staged 配置;根目录无 `eslint.config.mjs`(各包自带)。
   - 描述:lint-staged 以仓库根为 cwd 对所有包跑 `eslint --fix`,flat config 从 cwd 向上查找均无配置会报错——此问题对所有包存在,非 cli 包引入;cli 包的 `eslint.config.mjs` 遵循包级惯例(含 `tsconfigRootDir: import.meta.dirname`、忽略 src/api 复制品),turbo lint 路径正常。
   - 建议:如 hooks 实际失效需另行治理(根级聚合配置或 lint-staged 按包执行),不属于本任务范围。

5. **[info] 执行报告缺失**
   - `.wf-runs/a15dcdc8/` 下无 `03-execution-*.md`,run.json 状态 `executing`。审查基于实际产物完成,但流程闭环缺失。
   - 建议:补一份执行报告(改动清单、验证命令与输出、tgz 冒烟记录),并更新 run.json 状态。

6. **[info] 运行时冒烟未执行(环境无 shell)**
   - 无法实跑:`pnpm pack` 重验、`node packages/cli/dist/cli.js --help/--version`、`wf start`(临时端口 5201)/`upgrade --dry-run`、tar 内容核验。未触碰 5200 端口现有进程(PID 29876)。
   - 建议:在有 shell 的环境补跑计划步骤 6 全部命令(注意用临时端口,勿动 5200)。

---

## 最终建议

**通过**。实现与计划高度一致,包自包含性、依赖完整性、构建链路、业务改动最小性均静态核验成立;无 blocker/major。minor 问题 1-3 建议顺手修复(文案、error 监听、gitignore),问题 5-6 为流程补强项,建议补执行报告并在真实环境跑一遍 tarball 冒烟后即可执行发布。
