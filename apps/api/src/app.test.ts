import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { app } from './app.js'

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
const hasWebDist = existsSync(webDist)

describe('GET /api/health', () => {
  it('返回 up 状态', async () => {
    const res = await app.request('/api/health')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.code).toBe(0)
    expect(body.data.status).toBe('up')
    expect(body.data.timestamp).toBeTruthy()
  })
})

describe('GET /api/dag', () => {
  it('返回示例 DAG 图', async () => {
    const res = await app.request('/api/dag')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.code).toBe(0)
    expect(body.data.nodes).toHaveLength(3)
    expect(body.data.nodes[0].label).toBe('数据采集')
    expect(body.data.edges).toHaveLength(2)
  })
})

describe('未知 API 路径', () => {
  it('返回统一格式的 JSON 404', async () => {
    const res = await app.request('/api/does-not-exist')

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe(404)
    expect(body.message).toBe('Not Found')
  })
})

describe.skipIf(!hasWebDist)('静态托管(需先构建前端:pnpm --filter @dag-pi/web build)', () => {
  it('首页返回 index.html', async () => {
    const res = await app.request('/')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<div id="app">')
  })

  it('SPA 路由 fallback 到 index.html', async () => {
    const res = await app.request('/some/spa/route')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<div id="app">')
  })

  it('未匹配的 /api 请求不落回 SPA,仍返回 JSON 404', async () => {
    const res = await app.request('/api/nope')

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 404 })
  })
})
