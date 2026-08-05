import { serve } from '@hono/node-server'
import { app, initAgentRoutes } from './app.js'

// 初始化 pi agent 服务(ModelRuntime + .workflows 存储 + agent 路由)
const pi = await initAgentRoutes()

const isProduction = process.env.NODE_ENV === 'production'
// 对外暴露端口:生产 5200,开发 3000(可通过 PORT 覆盖)
const port = Number(process.env.PORT ?? (isProduction ? 5200 : 3000))

const server = serve({ fetch: app.fetch, port })
await new Promise<void>((resolve) => server.once('listening', resolve))

console.log(
  `🚀 API server listening on http://localhost:${port} (${isProduction ? 'production' : 'development'})`,
)

// 优雅退出:关闭 MCP server 子进程与 fff 索引,避免子进程残留;
// 5s 兜底超时:某 MCP 子进程不响应 close 导致 dispose() 挂起时强制退出,防止进程挂死
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    const cleanup = pi.dispose().catch((error) => {
      console.warn(`[exit] 清理异常:${error instanceof Error ? error.message : String(error)}`)
    })
    const timer = setTimeout(() => {
      console.warn(`[exit] ${sig} 后 5s 内未完成清理,强制退出`)
      process.exit(0)
    }, 5_000)
    timer.unref?.()
    void cleanup.finally(() => {
      clearTimeout(timer)
      process.exit(0)
    })
  })
}
