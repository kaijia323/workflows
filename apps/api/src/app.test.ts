import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { app } from './app.js'

describe('GET /api/health', () => {
  it('返回 up 状态', async () => {
    const res = await request(app).get('/api/health')

    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.status).toBe('up')
    expect(res.body.data.timestamp).toBeTruthy()
  })
})

describe('GET /api/dag', () => {
  it('返回示例 DAG 图', async () => {
    const res = await request(app).get('/api/dag')

    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.nodes).toHaveLength(3)
    expect(res.body.data.nodes[0].label).toBe('数据采集')
    expect(res.body.data.edges).toHaveLength(2)
  })
})

describe('未知 API 路径', () => {
  it('返回 JSON 404 而不是 HTML', async () => {
    const res = await request(app).get('/api/does-not-exist')

    expect(res.status).toBe(404)
    expect(res.body.code).toBe(404)
    expect(res.body.message).toBe('Not Found')
  })
})
