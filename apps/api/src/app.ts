import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { HTTPException } from 'hono/http-exception'
import type { DagGraph, DagNode } from '@workflows/shared'
import { createStore } from './config.js'
import { registerAgentRoutes } from './agent/routes.js'
import { PiAgentService } from './pi/piService.js'

// 前端构建产物目录(生产环境由本服务托管,前后端同源)
// src/ 与 dist/ 下均能正确解析到 apps/web/dist
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
const hasWebDist = existsSync(webDist)

export const app = new Hono()

/**
 * 初始化 pi agent 服务(创建 ModelRuntime 与 .workflows 存储,注册 agent 路由)。
 * 由 index.ts 启动时调用;测试环境无需调用。
 */
export async function initAgentRoutes(): Promise<PiAgentService> {
  const store = createStore()
  const pi = await PiAgentService.create()
  registerAgentRoutes(app, store, pi)
  return pi
}

// 统一错误响应:保持 ApiResponse<T> 结构,而不是 Hono 默认错误格式
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ code: error.status, message: error.message, data: null }, error.status)
  }
  // 未知错误:记录日志并返回统一 500
  console.error('[api] unhandled error:', error)
  return c.json({ code: 500, message: 'Internal Server Error', data: null }, 500)
})

// 统一 404 响应
app.notFound((c) => c.json({ code: 404, message: 'Not Found', data: null }, 404))

// 健康检查
app.get('/api/health', (c) =>
  c.json({
    code: 0,
    message: 'ok',
    data: { status: 'up', timestamp: new Date().toISOString() },
  }),
)

// 示例:返回一个 DAG 骨架数据
app.get('/api/dag', (c) => {
  const nodes: DagNode[] = [
    { id: 'node-1', label: '数据采集' },
    { id: 'node-2', label: '数据清洗' },
    { id: 'node-3', label: '模型训练' },
  ]
  const graph: DagGraph = {
    nodes,
    edges: [
      { source: 'node-1', target: 'node-2' },
      { source: 'node-2', target: 'node-3' },
    ],
  }
  return c.json({ code: 0, message: 'ok', data: graph })
})

// 生产环境:托管前端构建产物(单端口对外,用户只访问这一个地址)
if (hasWebDist) {
  // 静态文件(自带 etag / 304 / HEAD 处理),未命中时继续到下一个中间件
  app.use('*', serveStatic({ root: webDist }))

  // SPA fallback:非 /api 路径一律返回 index.html(前端路由),由前端接管
  app.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api')) return next()
    const indexHtml = await readFile(path.join(webDist, 'index.html'))
    return new Response(indexHtml, {
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    })
  })
}
