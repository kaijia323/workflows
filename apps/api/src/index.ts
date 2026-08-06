import { serve } from '@hono/node-server'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, initAgentRoutes } from './app.js'

/**
 * 启动 HTTP 服务(供本文件直接运行与 CLI 包复用):
 * 初始化 pi agent 服务(ModelRuntime + .workflows 存储 + agent 路由)→ serve → 监听日志 → 优雅退出。
 */
export async function startServer(port: number): Promise<void> {
  // 初始化 pi agent 服务(ModelRuntime + .workflows 存储 + agent 路由)
  const pi = await initAgentRoutes()

  const isProduction = process.env.NODE_ENV === 'production'
  const server = serve({ fetch: app.fetch, port })
  // 端口被占用(EADDRINUSE 等)时 serve 异步触发 'error' 事件,无监听会裸抛堆栈:
  // 捕获后打印友好提示并退出(正常启动路径不变)
  server.on('error', (error: Error & { code?: string }) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用,请换一个端口(如 --port <port>)`)
    } else {
      console.error(`服务启动失败:${error.message}`)
    }
    process.exit(1)
  })
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
}

// 直接运行守卫:node dist/index.js / tsx src/index.ts 直接运行时自动启动(行为不变);
// 被 CLI 包动态 import 时不触发(process.argv[1] 是 cli.js 路径,与 import.meta.url 不相等)
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  const isProduction = process.env.NODE_ENV === 'production'
  // 对外暴露端口:生产 5200,开发 3000(可通过 PORT 覆盖)
  await startServer(Number(process.env.PORT ?? (isProduction ? 5200 : 3000)))
}
