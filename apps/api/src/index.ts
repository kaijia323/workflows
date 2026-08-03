import { serve } from 'h3'
import { app } from './app.js'

const isProduction = process.env.NODE_ENV === 'production'
// 对外暴露端口:生产 5200,开发 3000(可通过 PORT 覆盖)
const port = Number(process.env.PORT ?? (isProduction ? 5200 : 3000))

const server = serve(app, { port })

await server.ready()

console.log(
  `🚀 API server listening on http://localhost:${port} (${isProduction ? 'production' : 'development'})`,
)
