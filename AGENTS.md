# AGENTS.md

workflows 项目给 AI 编码 agent 的上下文速览。精简概念,详见 README.md。

## 这是什么

Turborepo monorepo — 基于 **pi SDK** 的 Web Agent 工作台(聊天 + 工作区 + 工具调用),附带 DAG 骨架示例接口。

## 前端 UI 风格

- 前端 UI 统一遵循 `designs/voltagent/DESIGN.md`(主设计规范:近黑画布 `#101010` + 电光绿 `#00d992`、Inter + JetBrains Mono、4px 间距、6/8px 圆角、hairline 分层)
- 消息块渲染另参考 `designs/warp/DESIGN.md`(辅助)
- **任何前端 UI 改动前必须先阅读上述设计文件**,遵循其中的 token 与风格;不得引入与设计规范冲突的颜色/字体/间距

## 结构

| 包 | 职责 |
| --- | --- |
| `apps/web` | Vue 3 + Vite + Tailwind v4,聊天 UI(组件在 `src/components`,SSE 接入在 `src/composables/useAgent.ts`) |
| `apps/api` | **Hono** + pi SDK。`src/pi/piService.ts` 是服务层(ModelRuntime + 每工作区一个 `AgentSession`);`src/agent/routes.ts` 是路由;`src/config.ts` 是 `.workflows` 存储 |
| `packages/shared` | 纯类型包。**改动后需先 `pnpm build`** 再被 api/web 消费(workspace 依赖构建产物) |

## 关键约定

- **统一响应结构**:`{ code, message, data }`,code 0 为成功;错误经 `app.onError` 统一格式化,不抛裸异常到前端
- **数据隔离**:所有运行数据(API key / 工作区 / 会话)存 `.workflows/`,开发在仓库根、生产在 `~/.workflows`,**绝不读写 pi 全局配置 `~/.pi/agent`**
- **会话模型**:一个工作区一个持久化会话(JSONL),上下文限定在工作区目录;只读工作区只给 `read/grep/find/ls` 工具
- **工作区边界守卫**:工具不允许逃逸到工作区目录外——`src/pi/workspaceGuard.ts` 用 unbash 静态审计 bash 命令(重定向/文件命令/cd/嵌套替换,解析失败或含未知展开一律拒绝),read/write/edit/grep/find/ls 包装 execute 校验 path 参数;改动守卫时同步更新 `workspaceGuard.test.ts`
- **流式输出**:`POST /api/agent/workspaces/:id/prompt` 走 SSE,事件类型见 shared 的 `SessionEvent`;前端按模型输出顺序渲染(思考/正文/工具调用交错)
- **端口**:开发 web 15200(代理 `/api` → 3000),生产 api 5200 单端口托管前端 + API;dev 脚本用 `cross-env NODE_ENV=development` 固定环境(曾出现 shell 残留 `NODE_ENV=production` 导致 dev 抢 5200 端口 EADDRINUSE 崩溃——改 dev 脚本前先查 `echo $NODE_ENV`)
- **API key**:用户手动输入 DeepSeek key,存 `.workflows/config.json`,运行时注入 `ModelRuntime`,key 本身不返回前端

## 命令

```bash
pnpm dev        # 开发(web 15200 + api 3000)
pnpm build      # shared → api/web
pnpm start      # 生产(仅 api,5200)
pnpm preview    # build + start
pnpm typecheck / lint / test
```

## 注意

- 改动 shared 类型后必须重建,否则 api/web 的 TS 检查会失败
- 测试用 Vitest(api: `app.test.ts`;web: `App.test.ts`、`useAgent.test.ts`)
- 会话事件映射在 `piService.ts` 的 `mapSessionEvent`,历史恢复在 `renderHistory`,两者需保持一致的输出顺序语义
- **代理定义是 .md 文件,tsc 不复制**:`apps/api/scripts/copy-agents.mjs` 在 build 时把 `src/pi/agents/*.md` 复制到 `dist/pi/agents`;改动 `src/pi/agents/*.md` 后必须 `pnpm build` 生产才生效(dev 直接跑 src 不受影响)。`PiAgentService.create()` 启动时会校验 orchestrator 定义存在,缺失直接抛错——不要绕过这个检查
