#!/usr/bin/env node
/**
 * AnySearch 真实调用验证脚本(无依赖,Node >= 20 全局 fetch)
 *
 * 用法:node apps/api/scripts/verify-anysearch.mjs
 *
 * 行为:
 * 1. 匿名调用 POST https://api.anysearch.com/v1/search 一次(普通查询)
 * 2. 若设置了环境变量 ANYSEARCH_API_KEY,再带 key 调用一次(验证 key 路径;不打印 key 本身)
 *
 * 任何断言失败 → 打印错误详情并以非零码退出。保留在仓库作开发工具。
 */
const ENDPOINT = 'https://api.anysearch.com/v1/search'

function fail(message) {
  console.error(`[verify-anysearch] FAIL: ${message}`)
  process.exit(1)
}

async function search(query, apiKey) {
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const started = Date.now()
  let res
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, max_results: 3, format: 'markdown' }),
    })
  } catch (error) {
    fail(`请求失败(网络异常):${error instanceof Error ? error.message : String(error)}`)
  }
  const elapsed = Date.now() - started
  let body
  try {
    body = await res.json()
  } catch {
    fail(`HTTP ${res.status} 响应不是合法 JSON(耗时 ${elapsed}ms)`)
  }
  return { status: res.status, body, elapsed }
}

function assertSuccess(label, { status, body, elapsed }) {
  if (status !== 200) fail(`${label} HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}(耗时 ${elapsed}ms)`)
  if (body.code !== 0) fail(`${label} code=${body.code} message=${body.message}(耗时 ${elapsed}ms)`)
  const results = body.data?.results
  if (!Array.isArray(results) || results.length === 0) fail(`${label} results 为空(耗时 ${elapsed}ms)`)
  return results
}

async function main() {
  console.log('[verify-anysearch] 匿名调用 POST /v1/search ...')
  const anon = await search('pi coding agent SDK')
  const results = assertSuccess('匿名调用', anon)
  console.log(`[verify-anysearch] OK: code=0, results=${results.length}, 耗时 ${anon.elapsed}ms`)
  console.log(`  首条 title: ${results[0].title}`)
  console.log(`  首条 url:   ${results[0].url}`)
  if (typeof results[0].content === 'string' && results[0].content.length > 0) {
    console.log(`  content 前 500 字符:\n${results[0].content.slice(0, 500)}`)
  }

  if (process.env.ANYSEARCH_API_KEY) {
    console.log('[verify-anysearch] 检测到 ANYSEARCH_API_KEY,带 key 再调用一次 ...')
    const keyed = await search('pi coding agent SDK', process.env.ANYSEARCH_API_KEY)
    const keyedResults = assertSuccess('带 key 调用', keyed)
    console.log(`[verify-anysearch] OK(key 路径): code=0, results=${keyedResults.length}, 耗时 ${keyed.elapsed}ms`)
  } else {
    console.log('[verify-anysearch] 未设置 ANYSEARCH_API_KEY,跳过 key 路径验证')
  }

  console.log('[verify-anysearch] 全部通过')
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
