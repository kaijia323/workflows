# 执行报告:修复 CLI 全局安装后前端资源找不到

> 依据:任务说明(产物目录 `.wf-runs/fff99d72/` 下无 `02-plan-*.md`,run.json 中 planFile=null,以任务说明本身为计划)。
> 根因:`resolveWebDist()` 回退链缺「包内 dist/web-dist」路径 —— CLI 全局安装时 moduleDir=`<包>/dist/api`,`../../web/dist` 解析到包外不存在,`web-dist` 解析到 `dist/api/web-dist` 也不存在 → hasWebDist=false,前端未托管。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/api/src/app.ts` | `resolveWebDist()` 回退链 `['../../web/dist', 'web-dist']` → **`['../../web/dist', '../web-dist', 'web-dist']`**;同步重写上方注释,逐条说明三个分支的命中场景 | 新增包内路径 `../web-dist`(moduleDir=`dist/api` → `dist/web-dist`),修复全局安装时前端资源找不到;`../../web/dist` 保留仓库内命中、`web-dist` 保留向后兼容 |
| `packages/cli/package.json` | `version` 0.2.0 → **0.2.1** | bugfix 升 patch |

构建链路说明:CLI 包通过 `prepare.mjs` 复制 `apps/api/src` → `src/api`,tsc 编译 → `copy-assets.mjs` 复制 `apps/web/dist` → `dist/web-dist`,故 `apps/api/src/app.ts` 的修改随构建自动进入发布产物。

## 构建结果

- `pnpm --filter @kaijia/workflows build` → **成功**(prepare.mjs 复制 api 源码 + tsc + copy-assets.mjs 全通过,日志显示 `@kaijia/workflows@0.2.1 build`)
- 产物验证:`packages/cli/dist/api/app.js` 含新回退链 `['../../web/dist', '../web-dist', 'web-dist']`;`packages/cli/dist/web-dist/index.html` 存在;`node packages/cli/dist/cli.js --version` → `0.2.1` ✓

## 本地冒烟结果(端口 5202)

前置:`netstat` 确认 5200 被用户进程 PID 30536 占用(未触碰),5202 空闲。`nohup node packages/cli/dist/cli.js start --port 5202` 后台启动,监听 PID 26812,日志:「[wfs] 启动 workflows · http://localhost:5202(production 模式)」。

| 请求 | 结果 |
| --- | --- |
| `curl http://localhost:5202/` | **HTTP 200**,`text/html; charset=utf-8`,415 字节;内容为 index.html(`<!doctype html>` … `<title>workflows · Agent 控制台</title>` … `<script src="/assets/index-BHs2GuRN.js">`) |
| `curl http://localhost:5202/api/health` | **HTTP 200**,`application/json`:`{"code":0,"message":"ok","data":{"status":"up",...}}` |

命中路径验证:`packages/web/dist` 不存在(排除 `../../web/dist` 分支);冒烟响应与 `packages/cli/dist/web-dist/index.html` **逐字节一致** → 确认由新增的 `../web-dist` 分支命中,修复生效。

清理:仅 `taskkill //PID 26812`(自己启动的 5202 进程),5202 已无监听;5200 用户进程 PID 30536 全程未受影响。

## 未完成项与原因

无。约束遵守:未触碰 5200 端口进程;冒烟后已清理 5202;未执行 npm publish(由用户执行)。
