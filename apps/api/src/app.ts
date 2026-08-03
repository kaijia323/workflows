import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { DagGraph, DagNode } from '@dag-pi/shared'

// 前端构建产物目录(生产环境由本服务托管,前后端同源)
// src/ 与 dist/ 下均能正确解析到 apps/web/dist
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')

export const app = express()

app.use(express.json())

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({
    code: 0,
    message: 'ok',
    data: { status: 'up', timestamp: new Date().toISOString() },
  })
})

// 示例:返回一个 DAG 骨架数据
app.get('/api/dag', (_req, res) => {
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
  res.json({ code: 0, message: 'ok', data: graph })
})

// 未知 /api 路径:统一 JSON 404
app.use('/api', (_req, res) => {
  res.status(404).json({ code: 404, message: 'Not Found', data: null })
})

// 托管前端构建产物(存在时):单端口对外,用户只访问这一个地址
if (existsSync(webDist)) {
  app.use(express.static(webDist))

  // SPA fallback:非 /api 请求一律返回 index.html(express 5 通配符语法)
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'))
  })
}
