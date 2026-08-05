#!/usr/bin/env node
/**
 * 小米视觉接口离线 mock 服务器(无依赖,node:http)
 *
 * 用途:离线验证 vision-understand 工具的协议形状(image_url data URL 序列化 /
 * mime 前缀 / model / stream 字段),不消耗真实 API 额度。
 *
 * 用法:node apps/api/scripts/mock-xiaomi-server.mjs [--port 3999]
 * 配套:node apps/api/scripts/verify-vision.mjs --base-url http://127.0.0.1:3999/v1
 *
 * 行为:POST /v1/chat/completions → 解析 body,打印 model、image_url 数量与
 * data URL 前 80 字符(确认 base64 前缀/mime 序列化),返回固定 choices 文本。
 */
function parsePort(argv) {
  const idx = argv.indexOf('--port')
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1])
    if (Number.isInteger(n) && n > 0 && n < 65536) return n
  }
  return 3999
}

const PORT = parsePort(process.argv.slice(2))

import http from 'node:http'

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } })
    return
  }
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { error: { message: 'invalid json', type: 'invalid_request_error' } })
      return
    }
    const msg = Array.isArray(body.messages) ? body.messages[0] : undefined
    const parts = Array.isArray(msg?.content) ? msg.content : []
    const images = parts.filter((p) => p && p.type === 'image_url')
    const texts = parts.filter((p) => p && p.type === 'text')
    console.log(
      `[mock-xiaomi] model=${body.model ?? '?'} stream=${String(body.stream)} images=${images.length} ` +
        `text=${texts.map((t) => String(t.text ?? '')).join('|').slice(0, 120)}`,
    )
    for (const img of images) {
      const url = String(img.image_url?.url ?? '')
      console.log(
        `[mock-xiaomi] image_url 前 80 字符:${url.slice(0, 80)}${url.length > 80 ? '…' : ''}(总长 ${url.length})`,
      )
    }
    sendJson(res, 200, { choices: [{ message: { content: `mock 识图成功(${images.length} 张图)` } }] })
  })
})

server.listen(PORT, () => {
  console.log(`[mock-xiaomi] listening on http://127.0.0.1:${PORT}`)
})
