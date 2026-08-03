import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { H3, HTTPError, serveStatic } from 'h3'
import type { DagGraph, DagNode } from '@dag-pi/shared'
import { createStore } from './config.js'
import { registerAgentRoutes } from './agent/routes.js'
import { PiAgentService } from './pi/piService.js'

// 前端构建产物目录(生产环境由本服务托管,前后端同源)
// src/ 与 dist/ 下均能正确解析到 apps/web/dist
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
const hasWebDist = existsSync(webDist)

export const app = new H3()

/**
 * 初始化 pi agent 服务(创建 ModelRuntime 与 .dag-pi 存储,注册 agent 路由)。
 * 由 index.ts 启动时调用;测试环境无需调用。
 */
export async function initAgentRoutes(): Promise<void> {
  const store = createStore()
  const pi = await PiAgentService.create()
  registerAgentRoutes(app, store, pi)
}

// 统一错误响应:保持 ApiResponse<T> 结构,而不是 H3 默认错误格式
app.use(async (event, next) => {
  try {
    return await next()
  } catch (error) {
    if (error instanceof HTTPError) {
      return new Response(JSON.stringify({ code: error.status, message: error.message, data: null }), {
        status: error.status,
        headers: { 'content-type': 'application/json;charset=UTF-8' },
      })
    }
    // 未知错误:交给 H3 默认错误处理(500)
    throw error
  }
})

// 健康检查
app.get('/api/health', () => ({
  code: 0,
  message: 'ok',
  data: { status: 'up', timestamp: new Date().toISOString() },
}))

// 示例:返回一个 DAG 骨架数据
app.get('/api/dag', () => {
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
  return { code: 0, message: 'ok', data: graph }
})

// 兜底中间件:仅在路由未匹配时执行
app.use(async (event) => {
  // 已有路由匹配:直接放行
  if (event.context.matchedRoute) {
    return
  }

  const pathname = event.url.pathname

  // 未知 /api 路径:统一 JSON 404(由错误中间件转成统一格式)
  if (pathname.startsWith('/api')) {
    throw HTTPError.status(404, 'Not Found')
  }

  // 生产环境:托管前端构建产物(单端口对外,用户只访问这一个地址)
  if (hasWebDist) {
    // 静态文件(自带 etag / 304 / HEAD 处理)
    const served = await serveStatic(event, {
      fallthrough: true,
      indexNames: ['/index.html'],
      getContents: (id) => readFile(path.join(webDist, id)),
      getMeta: async (id) => {
        const stats = await stat(path.join(webDist, id)).catch(() => undefined)
        if (stats?.isFile()) {
          return { size: stats.size, mtime: stats.mtimeMs }
        }
      },
    })
    if (served !== undefined) {
      return served
    }

    // SPA fallback:前端路由(如 /foo/bar)一律返回 index.html
    const indexHtml = await readFile(path.join(webDist, 'index.html'))
    return new Response(indexHtml, {
      headers: { 'content-type': 'text/html;charset=UTF-8' },
    })
  }

  throw HTTPError.status(404, 'Not Found')
})
