#!/usr/bin/env node
/**
 * 小米视觉接口协议验证脚本(无依赖,Node >= 20 全局 fetch)
 *
 * 用法:
 *   离线(无需 key):node apps/api/scripts/mock-xiaomi-server.mjs &
 *                   node apps/api/scripts/verify-vision.mjs --base-url http://127.0.0.1:3999/v1
 *   线上(需 key):  XIAOMI_API_KEY=sk-... node apps/api/scripts/verify-vision.mjs
 *
 * 参数:--base-url(默认 https://api.xiaomimimo.com/v1)、--model(默认 mimo-v2.5)、
 *      --images N(默认 1,构造 N 个 image_url 项 + text 项的请求)
 *
 * 行为:内置程序生成的 1×1 PNG base64 常量,构造 text + N 个 image_url 请求,断言
 * 200 + choices[0].message.content 非空;离线(mock)模式下额外断言响应含「(N 张图)」
 * 文案(验证 mock 收到 N 图);任何断言失败 → 打印错误详情并以非零码退出。
 * 线上模式未设置 XIAOMI_API_KEY 时打印跳过提示并正常退出(0)。
 * 不打印 key 本身。
 */
const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
const DEFAULT_MODEL = 'mimo-v2.5'

/** 1×1 PNG(70 字节,合法 PNG 签名 + IHDR) */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function parseArgs(argv) {
  const out = { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL, images: 1 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base-url' && argv[i + 1]) out.baseUrl = argv[i + 1]
    if (argv[i] === '--model' && argv[i + 1]) out.model = argv[i + 1]
    if (argv[i] === '--images' && argv[i + 1]) {
      const n = Number(argv[i + 1])
      if (Number.isInteger(n) && n > 0 && n <= 8) out.images = n
    }
  }
  return out
}

function fail(message) {
  console.error(`[verify-vision] FAIL: ${message}`)
  process.exit(1)
}

async function main() {
  const { baseUrl, model, images } = parseArgs(process.argv.slice(2))
  const isOnline = !baseUrl.includes('127.0.0.1') && !baseUrl.includes('localhost')
  const apiKey = process.env.XIAOMI_API_KEY?.trim()

  if (isOnline && !apiKey) {
    console.log('[verify-vision] 线上模式需要 XIAOMI_API_KEY,未检测到,跳过。')
    console.log('[verify-vision] 离线验证:node apps/api/scripts/mock-xiaomi-server.mjs & 后再跑本脚本(--base-url http://127.0.0.1:3999/v1)')
    process.exit(0)
  }

  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  // N 个 image_url 项(多图协议形状,顺序 = 声明序)+ 末尾 text 项
  const imageUrl = `data:image/png;base64,${PNG_1X1_BASE64}`
  const reqContent = [
    ...Array.from({ length: images }, () => ({ type: 'image_url', image_url: { url: imageUrl } })),
    { type: 'text', text: '请描述这张图片' },
  ]
  const body = {
    model,
    messages: [{ role: 'user', content: reqContent }],
    stream: false,
  }

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  console.log(`[verify-vision] POST ${url} (model=${model}, images=${images}${apiKey ? ', 带 key' : ', 无 key(离线 mock)'})`)
  const started = Date.now()
  let res
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (error) {
    fail(`请求失败(网络异常):${error instanceof Error ? error.message : String(error)}`)
  }
  const elapsed = Date.now() - started

  let json
  try {
    json = await res.json()
  } catch {
    fail(`HTTP ${res.status} 响应不是合法 JSON(耗时 ${elapsed}ms)`)
  }

  if (res.status !== 200) {
    fail(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}(耗时 ${elapsed}ms)`)
  }
  const content = json?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    fail(`choices[0].message.content 缺失或为空(耗时 ${elapsed}ms):${JSON.stringify(json).slice(0, 300)}`)
  }
  console.log(`[verify-vision] OK: HTTP 200, choices[0].message.content 非空,耗时 ${elapsed}ms`)
  console.log(`[verify-vision] content: ${content.slice(0, 200)}`)
  // 离线(mock)模式:断言 mock 响应文案含「(N 张图)」,确证多图协议形状到达服务端
  if (!isOnline) {
    const expected = `(${images} 张图)`
    if (!content.includes(expected)) {
      fail(`离线 mock 响应应包含「${expected}」,实际:${content.slice(0, 120)}`)
    }
    console.log(`[verify-vision] 离线断言通过:mock 响应含「${expected}」`)
  }
  console.log('[verify-vision] 全部通过')
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
