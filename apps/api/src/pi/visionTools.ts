/**
 * 小米视觉理解工具(vision-understand)
 *
 * 通过小米 OpenAI 兼容接口(REST,POST https://api.xiaomimimo.com/v1/chat/completions,
 * model=mimo-v2.5)识图:读取图片,返回图片内容的文字描述。
 * 主力文字模型(deepseek)不动——视觉能力完全由工具承担(内置 HTTP 工具模式,仿 anySearchTools)。
 *
 * 协议事实来源(探索-1 §4.2 / 探索-3 §7):baseUrl、mimo-v2.5 输入类型(image_url +
 * text 混合 content)、单图上限 10MB、OpenAI 兼容 chat/completions 协议形状。
 *
 * 设计:
 * - 工厂 createVisionTools(options) 与 createAnySearchTools 同构(测试注入友好)
 * - 注册门:visionAvailable(config.ts 单一事实源)= 开关开 && (env XIAOMI_API_KEY || 配置 key);
 *   主/子代理双点注册(piService openSession / subAgent runSubAgent+buildSubAgentTools)
 * - key 解析优先级:env XIAOMI_API_KEY > options.getApiKey()(piService/subAgent 注入
 *   loadConfig(...).visionApiKey,动态读取 config.json,保存 key 后下次调用立即生效)
 * - key 只进 Authorization 头,绝不写入返回文本/日志/错误文案
 * - 三路输入(v1.1,可混用,顺序 = schema 声明序 path → data → url):
 *   1. image_paths[](工作区相对路径,沿用 v1 守卫 isAllowedTargetPath,推荐本机图片;
 *      工作区 .wf-uploads/ 下的上传图片亦在此列)
 *   2. image_data[](data URL 或裸 base64;mime 白名单 / 魔数嗅探 + 单张 ≤10MB)
 *   3. image_urls[](https URL;SSRF 防护:协议白名单 + DNS 解析后 IP 黑名单 + 10s 超时 +
 *      流式限流 + Content-Type/魔数双校验;下载结果转 data URL 进请求体,不直传 URL 给小米)
 * - image_path(单数)保留为兼容别名(deprecated,归一化进 image_paths)
 * - 限制:单张 ≤ 10MB、总量 ≤ 20MB(默认)、≤ 8 张、超时 60s(与 MCP call 同级)、
 *   输出 50KB 截断(复用 anySearchTools 导出的 truncateOutput)、mime 白名单 jpeg/png/gif/webp、
 *   非流式(stream:false)、响应 reasoning_content 忽略
 * - 错误防御分层(仿 anySearchTools 纪律):任何异常落到可读错误文本(abort 除外,唯一透传
 *   Operation aborted)
 */

import { readFile, stat } from 'node:fs/promises'
import { lookup as dnsLookup } from 'node:dns/promises'
import path from 'node:path'
import { Type, type Static } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { isAllowedTargetPath } from './workspaceGuard.js'
import { truncateOutput } from './anySearchTools.js'
import { MAX_IMAGE_BYTES, sniffMime, SUPPORTED_MIME } from './imageMime.js'

export const VISION_TOOL_NAME = 'vision-understand'
const VISION_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions'
const VISION_MODEL = 'mimo-v2.5'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10_000
const MAX_IMAGES = 8
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const DEFAULT_QUESTION = '请详细描述这张图片的内容'

/** data URL 形状:data:<mime>;base64,<payload>(mime 段限定 image/*,base64 段贪婪) */
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/

const MIME_VALUES = Object.values(SUPPORTED_MIME)

export interface VisionToolOptions {
  /** 工作区根目录(image_paths 相对解析基准 + 守卫边界) */
  workspacePath: string
  /** 工作区外只读放行根(skills 目录,与 read 工具同语义;缺省 [] 保持现有行为) */
  extraAllowedRoots?: string[]
  /** 返回小米 API key(可选)。优先级:env XIAOMI_API_KEY > 此函数 */
  getApiKey?: () => string | undefined
  /** 测试注入用,默认全局 fetch */
  fetchImpl?: typeof fetch
  /** 测试注入用,默认 VISION_ENDPOINT */
  endpoint?: string
  /** 测试注入用,默认 60s(主请求超时) */
  timeoutMs?: number
  /** 测试注入用,默认 10s(image_urls 下载超时) */
  downloadTimeoutMs?: number
  /** 测试注入用,默认 10MB(单张上限) */
  maxImageBytes?: number
  /** 测试注入用,默认 20MB(多图总量上限) */
  maxTotalBytes?: number
  /** 测试注入用,默认 node:dns/promises lookup(hostname → IP 列表) */
  lookupImpl?: (hostname: string) => Promise<string[]>
}

const visionSchema = Type.Object({
  image_path: Type.Optional(
    Type.String({ description: '(deprecated,请用 image_paths)单张图片路径,相对工作区根的图片文件路径' }),
  ),
  image_paths: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: MAX_IMAGES,
      description: '图片路径数组(推荐,本机图片):相对工作区根的图片文件路径,如 docs/diagram.png;' +
        '工作区 .wf-uploads/ 下的上传图片(用户消息 [图片: …] 标记)亦可用本路分析',
    }),
  ),
  image_data: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: MAX_IMAGES,
      description: '图片数据数组:data URL(data:image/png;base64,…)或裸 base64;' +
        'mime 白名单 JPEG/PNG/GIF/WebP,裸 base64 按魔数嗅探,单张 ≤ 10MB',
    }),
  ),
  image_urls: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: MAX_IMAGES,
      description: '图片 URL 数组(仅 https;内网/保留地址拒绝,SSRF 防护):下载后转 data URL 识别',
    }),
  ),
  question: Type.Optional(
    Type.String({ description: '关于图片的问题(可选,缺省「请详细描述这张图片的内容」)' }),
  ),
})
type VisionParams = Static<typeof visionSchema>

interface VisionResponse {
  choices?: Array<{ message?: { content?: unknown } }>
}

/** 单张待识图(顺序 = schema 声明序:path → data → url) */
interface CollectedImage {
  mime: string
  base64: string
}

/* ---------------- 私有 helper ---------------- */

function abortIfSignaled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted')
}

/** 提取错误对象的 name(DOMException 在 Node 中也是 Error 子类,统一防御) */
function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) return String((error as { name: unknown }).name)
  return ''
}

function resolveApiKey(opts: VisionToolOptions): string | undefined {
  const env = process.env.XIAOMI_API_KEY?.trim()
  if (env) return env
  return opts.getApiKey?.()?.trim() || undefined
}

/** 扩展名 → mime;不支持返回 undefined */
function mimeFor(imagePath: string): string | undefined {
  const ext = path.extname(imagePath).slice(1).toLowerCase()
  return SUPPORTED_MIME[ext]
}

/** HTTP 非 2xx 状态映射(文案脱敏,不回显 key) */
function mapHttpError(status: number, message?: string): string {
  switch (status) {
    case 400:
      return `请求参数错误(HTTP 400):${message ?? '请检查图片参数与格式、数量(≤8)、体积(单张≤10MB、总量≤20MB)'}`
    case 401:
    case 403:
      return '小米视觉 API key 无效或未授权(请检查配置的 key)'
    case 402:
      return '账户额度已用完(quota exhausted),请检查配额'
    case 429:
      return '请求过于频繁(限流),请稍后重试'
    default:
      if (status >= 500) return `服务端错误(HTTP ${status}),请稍后重试`
      return `请求失败(HTTP ${status})`
  }
}

/* ---------------- base64 / data URL 解码 ---------------- */

/**
 * base64 解码 + 单张上限校验:
 * 先按长度粗判(len*3/4 ≤ maxBytes)防超大字符串分配,解码后再复检实际字节数。
 */
function decodeBase64(payload: string, maxBytes: number): Buffer {
  if (payload.length * 3 > maxBytes * 4) {
    throw new Error(`图片数据超过大小上限(${maxBytes} 字节)`)
  }
  const buf = Buffer.from(payload, 'base64')
  if (buf.length > maxBytes) {
    throw new Error(`图片数据超过大小上限(${maxBytes} 字节,实际 ${buf.length} 字节)`)
  }
  return buf
}

/** 解析 image_data 项:data URL(声明 mime 白名单)或裸 base64(魔数嗅探推断 mime) */
function decodeImageData(raw: string, maxBytes: number): CollectedImage {
  const match = DATA_URL_RE.exec(raw)
  if (match) {
    const mime = match[1].toLowerCase()
    if (!MIME_VALUES.includes(mime)) {
      throw new Error(`不支持的图片格式:${mime}(支持的格式:JPEG/PNG/GIF/WebP)`)
    }
    return { mime, base64: decodeBase64(match[2], maxBytes).toString('base64') }
  }
  const buf = decodeBase64(raw, maxBytes)
  const mime = sniffMime(buf)
  if (!mime) {
    throw new Error('无法识别图片格式(裸 base64 无 JPEG/PNG/GIF/WebP 魔数,请改用 data URL 并声明格式)')
  }
  return { mime, base64: buf.toString('base64') }
}

/* ---------------- IP 黑名单(SSRF) ---------------- */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = (n << 8) | v
  }
  return n >>> 0
}

/** IPv6 → 16 字节(支持 :: 压缩与末尾内嵌 IPv4);无法解析返回 null */
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  let v4Bytes: number[] = []
  if (v4) {
    const parts = v4[1].split('.').map(Number)
    if (parts.some((v) => Number.isNaN(v) || v > 255)) return null
    v4Bytes = parts
    s = s.slice(0, v4.index) + ':'
  }
  const doubleColon = s.indexOf('::')
  let head: string[]
  let tail: string[]
  if (doubleColon >= 0) {
    head = s.slice(0, doubleColon).split(':').filter(Boolean)
    tail = s.slice(doubleColon + 2).split(':').filter(Boolean)
  } else {
    head = s.split(':').filter(Boolean)
    tail = []
  }
  const toBytes = (groups: string[]): number[] => {
    const out: number[] = []
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return []
      const v = parseInt(g, 16)
      out.push((v >> 8) & 0xff, v & 0xff)
    }
    return out
  }
  const headBytes = toBytes(head)
  const tailBytes = toBytes(tail)
  if (headBytes.length === 0 && head.length > 0) return null
  if (tailBytes.length === 0 && tail.length > 0) return null
  const total = headBytes.length + tailBytes.length + v4Bytes.length
  if (doubleColon < 0 && total !== 16) return null
  if (total > 16) return null
  const out = new Array<number>(16).fill(0)
  headBytes.forEach((b, i) => {
    out[i] = b
  })
  const mergedTail = [...tailBytes, ...v4Bytes]
  mergedTail.forEach((b, i) => {
    out[16 - mergedTail.length + i] = b
  })
  return out
}

/**
 * 内网/保留地址黑名单(SSRF 防护核心;纯函数,零网络,可直测):
 * IPv4:127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16、0.0.0.0/8
 * IPv6:::1、fc00::/7(ULA)、fe80::/10(link-local)
 * 无法解析的 IP 一律按命中处理(无法证明安全 → 拒绝,与 workspaceGuard 同哲学)。
 */
export function isBlockedIp(ip: string): boolean {
  const v4 = ipv4ToInt(ip)
  if (v4 !== null) {
    // 位运算结果是 int32(高位为 1 时负数),掩码后必须 >>> 0 转回无符号再与网段常量比较
    if (((v4 & 0xff000000) >>> 0) === 0x7f000000) return true // 127.0.0.0/8
    if (((v4 & 0xff000000) >>> 0) === 0x0a000000) return true // 10.0.0.0/8
    if (((v4 & 0xfff00000) >>> 0) === 0xac100000) return true // 172.16.0.0/12
    if (((v4 & 0xffff0000) >>> 0) === 0xc0a80000) return true // 192.168.0.0/16
    if (((v4 & 0xffff0000) >>> 0) === 0xa9fe0000) return true // 169.254.0.0/16
    if (((v4 & 0xff000000) >>> 0) === 0x00000000) return true // 0.0.0.0/8
    return false
  }
  const bytes = ipv6ToBytes(ip)
  if (!bytes) return true
  // IPv4-mapped IPv6(::ffff:a.b.c.d):取末 4 字节按 IPv4 判定(防绕过)
  if (
    bytes.slice(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return isBlockedIp(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`)
  }
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true // ::1
  if ((bytes[0] & 0xfe) === 0xfc) return true // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true // fe80::/10
  return false
}

/** 默认 DNS 解析(hostname → IP 列表;all:true 返回全部 A/AAAA) */
async function defaultLookup(hostname: string): Promise<string[]> {
  const result = await dnsLookup(hostname, { all: true })
  return result.map((r) => r.address)
}

/* ---------------- image_urls 下载(SSRF 防护) ---------------- */

/**
 * 下载 https 图片并转 data URL(不直传 URL 给小米):
 * - 协议白名单:仅 https(http/file/data 拒绝)
 * - DNS 校验:解析后任一 IP 命中 isBlockedIp 即拒绝(不发起连接)
 * - 下载:10s 超时 + 调用方 abort 信号;redirect follow(残余 DNS rebinding 窗口接受,
 *   与 workspaceGuard「符号链接不解析」同级信任取舍——护栏,非安全边界)
 * - 流式读 body:累计 > maxImageBytes 即 abort,禁止整包读入
 * - 响应校验:Content-Type 白名单 + 魔数嗅探
 */
async function downloadImageUrl(
  url: string,
  opts: {
    maxImageBytes: number
    downloadTimeoutMs: number
    fetchImpl: typeof fetch
    lookupImpl: (hostname: string) => Promise<string[]>
    signal?: AbortSignal
  },
): Promise<CollectedImage> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('图片 URL 无效')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`仅支持 https 图片 URL,收到「${parsed.protocol.replace(':', '')}」`)
  }

  // DNS 校验:任一 IP 命中黑名单即拒绝,不发起连接
  let addresses: string[]
  try {
    addresses = await opts.lookupImpl(parsed.hostname)
  } catch {
    throw new Error(`图片域名解析失败:${parsed.hostname}`)
  }
  if (addresses.length === 0 || addresses.some((ip) => isBlockedIp(ip))) {
    throw new Error('图片目标地址被拒绝(解析到内网/保留地址)')
  }

  const sizeController = new AbortController()
  const signals: AbortSignal[] = [AbortSignal.timeout(opts.downloadTimeoutMs), sizeController.signal]
  if (opts.signal) signals.push(opts.signal)
  const combined = AbortSignal.any(signals)

  let res: Response
  try {
    res = await opts.fetchImpl(url, { redirect: 'follow', signal: combined })
  } catch (error) {
    // 中止/超时:区分调用方中止(透传 Operation aborted)与下载超时
    const name = errorName(error)
    if (name === 'AbortError') {
      if (opts.signal?.aborted) throw new Error('Operation aborted', { cause: error })
      throw new Error(`图片下载超时(${opts.downloadTimeoutMs}ms)`, { cause: error })
    }
    if (name === 'TimeoutError') {
      throw new Error(`图片下载超时(${opts.downloadTimeoutMs}ms)`, { cause: error })
    }
    throw new Error(`图片下载失败(网络异常):${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  if (!res.ok) {
    throw new Error(`图片下载失败(HTTP ${res.status})`)
  }

  // Content-Type 白名单(读取 body 前校验;值域与 SUPPORTED_MIME 一致)
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!MIME_VALUES.includes(contentType)) {
    throw new Error(`不支持的图片格式:${contentType || '(无 content-type)'}(支持的格式:JPEG/PNG/GIF/WebP)`)
  }

  // 流式读取:累计超限即 abort(不整包读入)
  if (!res.body) {
    throw new Error('图片下载失败(响应无内容)')
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > opts.maxImageBytes) {
        sizeController.abort()
        throw new Error(`图片下载超过大小上限(${opts.maxImageBytes} 字节)`)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('图片下载超过大小上限')) throw error
    const name = errorName(error)
    if (name === 'AbortError') {
      if (opts.signal?.aborted) throw new Error('Operation aborted', { cause: error })
      throw new Error(`图片下载超时(${opts.downloadTimeoutMs}ms)`, { cause: error })
    }
    if (name === 'TimeoutError') {
      throw new Error(`图片下载超时(${opts.downloadTimeoutMs}ms)`, { cause: error })
    }
    throw error
  }

  const buf = Buffer.concat(chunks)
  const mime = sniffMime(buf)
  if (!mime) {
    throw new Error('无法识别图片格式(下载内容非 JPEG/PNG/GIF/WebP)')
  }
  return { mime, base64: buf.toString('base64') }
}

/* ---------------- 主流程 ---------------- */

async function callVision(
  opts: VisionToolOptions,
  params: VisionParams,
  signal: AbortSignal | undefined,
): Promise<string> {
  abortIfSignaled(signal)

  // image_path 兼容别名(弃用):显式传了但为空 → 明确错误(v1 行为保留)
  const alias = params.image_path?.trim()
  if (params.image_path !== undefined && alias === '') throw new Error('image_path 不能为空')

  const pathList = [...(alias ? [alias] : []), ...(params.image_paths ?? [])]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p !== '')
  const dataList = (params.image_data ?? []).map((d) => d.trim()).filter((d) => d !== '')
  const urlList = (params.image_urls ?? []).map((u) => u.trim()).filter((u) => u !== '')

  if (pathList.length + dataList.length + urlList.length === 0) {
    throw new Error('至少提供 image_paths / image_data / image_urls 之一')
  }
  const imageCount = pathList.length + dataList.length + urlList.length
  if (imageCount > MAX_IMAGES) {
    throw new Error(`图片数量超过上限(最多 ${MAX_IMAGES} 张,实际 ${imageCount} 张)`)
  }

  const key = resolveApiKey(opts)
  if (!key) {
    throw new Error('未配置小米视觉 API key(请先在设置 → 视觉模型中开启并填写)')
  }

  const maxBytes = opts.maxImageBytes ?? MAX_IMAGE_BYTES
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES
  const fetchImpl = opts.fetchImpl ?? fetch
  const endpoint = opts.endpoint ?? VISION_ENDPOINT
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  const lookupImpl = opts.lookupImpl ?? defaultLookup

  // 收集图片(顺序 = path → data → url);总量按字节在请求前累加校验
  const images: CollectedImage[] = []
  let totalBytes = 0
  const pushImage = (image: CollectedImage): void => {
    totalBytes += image.base64.length * 3 / 4
    if (totalBytes > maxTotalBytes) {
      throw new Error(`图片总量超过大小上限(${maxTotalBytes} 字节)`)
    }
    images.push(image)
  }

  // image_paths 路:沿用 v1 流程(守卫 → stat 体积 → mimeFor → readFile),逐个提取
  for (const imagePath of pathList) {
    // 守卫内置于工具(参数名是 image_paths,guardPathTool 只校验 path 参数)
    if (!isAllowedTargetPath(imagePath, opts.workspacePath, opts.extraAllowedRoots)) {
      throw new Error(
        `工作区边界拦截:vision-understand 尝试访问工作区之外的路径「${imagePath}」` +
          `(解析为 ${path.resolve(opts.workspacePath, imagePath)})。` +
          `\n工作区:${opts.workspacePath}\n请将操作限制在该工作区目录内。`,
      )
    }
    const absPath = path.resolve(opts.workspacePath, imagePath)
    // 先 stat 拿体积:超限文件直接报错,避免把超大文件读进内存
    let size: number
    try {
      size = (await stat(absPath)).size
    } catch {
      throw new Error(`图片文件不存在或不可读:${imagePath}`)
    }
    if (size > maxBytes) {
      throw new Error(`图片文件超过大小上限(${maxBytes} 字节,实际 ${size} 字节)`)
    }
    const mime = mimeFor(imagePath)
    if (!mime) {
      throw new Error(`不支持的图片格式:${path.extname(imagePath) || '(无扩展名)'}(支持的格式:JPEG/PNG/GIF/WebP)`)
    }
    pushImage({ mime, base64: (await readFile(absPath)).toString('base64') })
  }

  // image_data 路:data URL / 裸 base64(mime 白名单 + 魔数嗅探 + 单张上限)
  for (const raw of dataList) {
    pushImage(decodeImageData(raw, maxBytes))
  }

  // image_urls 路:SSRF 防护下载(协议白名单 + DNS IP 黑名单 + 超时 + 流式限流 + mime 双校验)
  for (const url of urlList) {
    pushImage(
      await downloadImageUrl(url, {
        maxImageBytes: maxBytes,
        downloadTimeoutMs,
        fetchImpl,
        lookupImpl,
        signal,
      }),
    )
  }

  const question = params.question?.trim() || DEFAULT_QUESTION

  // 组合信号:60s 超时 + 用户中止信号(与 anySearchTools 同纪律;Node >= 20.19 原生 AbortSignal.any)
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)
  const combined = AbortSignal.any(signals)

  const body = {
    model: VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } })),
          { type: 'text', text: question },
        ],
      },
    ],
    stream: false,
  }

  let res: Response
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: combined,
    })
  } catch (error) {
    // 中止/超时:区分用户中止(透传 Operation aborted)与超时
    const name = errorName(error)
    if (name === 'AbortError') {
      if (signal?.aborted) throw new Error('Operation aborted', { cause: error })
      throw new Error(`请求超时(${timeoutMs}ms),请稍后重试`, { cause: error })
    }
    if (name === 'TimeoutError') {
      throw new Error(`请求超时(${timeoutMs}ms),请稍后重试`, { cause: error })
    }
    throw new Error(`网络请求失败:${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  if (!res.ok) {
    // 尝试读取 body message(错误响应一般为 JSON;非 JSON 也不影响映射)
    let message: string | undefined
    try {
      const raw = (await res.json()) as { message?: unknown }
      message = typeof raw?.message === 'string' ? raw.message : undefined
    } catch {
      // 非 JSON body:忽略
    }
    throw new Error(mapHttpError(res.status, message))
  }

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    throw new Error('响应不是合法 JSON')
  }

  const resp = parsed as VisionResponse
  if (!Array.isArray(resp?.choices) || !resp.choices[0]?.message) {
    throw new Error('响应结构异常(缺少 choices[0].message)')
  }
  const content = resp.choices[0].message.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('响应缺少文本内容')
  }
  // reasoning_content 忽略(v1 只取 content 文本)
  return truncateOutput(content)
}

function toolError(error: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text: `Vision 错误:${error}` }], details: undefined }
}

/** 工厂:返回工具数组(与 createAnySearchTools 模式一致) */
export function createVisionTools(options: VisionToolOptions): ToolDefinition[] {
  return [
    {
      name: VISION_TOOL_NAME,
      label: VISION_TOOL_NAME,
      description:
        '视觉理解工具(小米 mimo-v2.5 视觉模型)。当用户要求描述/分析图片——截图、UI 图、流程图、' +
        '报错截图、示意图等——时使用;工具读取图片内容并返回文字描述(图片本身不回传)。' +
        '用户消息中的 [图片: 路径] 标记对应工作区 .wf-uploads/ 下的上传图片,可用本工具分析。' +
        '前提:设置 → 视觉模型中已开启「视觉模型」开关并配置小米 API key(按量付费,不计入订阅/Token Plan);' +
        '开关关闭或未配置 key 时本工具不可用。' +
        '输入三路(可混用,最多 8 张、单张 ≤ 10MB、总量 ≤ 20MB):' +
        'image_paths 图片路径数组(推荐,本机图片):相对工作区根的图片文件路径,如 docs/diagram.png;' +
        'image_data 图片数据数组:data URL(data:image/png;base64,…)或裸 base64,适合剪贴板图片;' +
        'image_urls 图片 URL 数组:仅 https(内网/保留地址拒绝),适合网页图片。' +
        'image_path(单数)已弃用,请用 image_paths。' +
        '支持格式:JPEG/PNG/GIF/WebP。' +
        'question 可选(关于图片的问题,缺省「请详细描述这张图片的内容」)。' +
        '返回图片内容的文字描述。',
      promptSnippet: 'Understand an image inside the workspace (Xiaomi vision API)',
      parameters: visionSchema,
      async execute(_toolCallId, params: VisionParams, signal, _onUpdate): Promise<AgentToolResult<undefined>> {
        try {
          const text = await callVision(options, params, signal)
          return { content: [{ type: 'text', text }], details: undefined }
        } catch (error) {
          if (error instanceof Error && error.message === 'Operation aborted') throw error
          return toolError(error instanceof Error ? error.message : String(error))
        }
      },
    },
  ]
}
