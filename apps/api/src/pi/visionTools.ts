/**
 * 小米视觉理解工具(vision-understand)
 *
 * 通过小米 OpenAI 兼容接口(REST,POST https://api.xiaomimimo.com/v1/chat/completions,
 * model=mimo-v2.5)识图:读取工作区内图片,返回图片内容的文字描述。
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
 * - 图片路径守卫内置于工具(参数名是 image_path,guardPathTool 只校验 path):
 *   isAllowedTargetPath(workspaceGuard 单一事实源),越界报「工作区边界拦截」;
 *   extraAllowedRoots = skills 放行根,与 read 工具同语义(D8)
 * - 限制:单图 ≤ 10MB、超时 60s(与 MCP call 同级)、输出 50KB 截断(复用 anySearchTools
 *   导出的 truncateOutput)、mime 白名单 jpeg/png/gif/webp(按扩展名判定)、非流式(stream:false)、
 *   响应 reasoning_content 忽略
 * - 错误防御分层(仿 anySearchTools 纪律):任何异常落到可读错误文本(abort 除外,唯一透传
 *   Operation aborted)
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Type, type Static } from 'typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { isAllowedTargetPath } from './workspaceGuard.js'
import { truncateOutput } from './anySearchTools.js'

export const VISION_TOOL_NAME = 'vision-understand'
const VISION_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions'
const VISION_MODEL = 'mimo-v2.5'
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const DEFAULT_QUESTION = '请详细描述这张图片的内容'

/** mime 白名单(按扩展名判定,v1 不做魔数嗅探) */
const SUPPORTED_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

export interface VisionToolOptions {
  /** 工作区根目录(image_path 相对解析基准 + 守卫边界) */
  workspacePath: string
  /** 工作区外只读放行根(skills 目录,与 read 工具同语义;缺省 [] 保持现有行为) */
  extraAllowedRoots?: string[]
  /** 返回小米 API key(可选)。优先级:env XIAOMI_API_KEY > 此函数 */
  getApiKey?: () => string | undefined
  /** 测试注入用,默认全局 fetch */
  fetchImpl?: typeof fetch
  /** 测试注入用,默认 VISION_ENDPOINT */
  endpoint?: string
  /** 测试注入用,默认 60s */
  timeoutMs?: number
  /** 测试注入用,默认 10MB */
  maxImageBytes?: number
}

const visionSchema = Type.Object({
  image_path: Type.String({
    description: '图片路径(必填,相对工作区根的图片文件路径,如 docs/diagram.png)',
  }),
  question: Type.Optional(
    Type.String({ description: '关于图片的问题(可选,缺省「请详细描述这张图片的内容」)' }),
  ),
})
type VisionParams = Static<typeof visionSchema>

interface VisionResponse {
  choices?: Array<{ message?: { content?: unknown } }>
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
      return `请求参数错误(HTTP 400):${message ?? '请检查 image_path/question 与图片格式'}`
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

async function callVision(
  opts: VisionToolOptions,
  params: VisionParams,
  signal: AbortSignal | undefined,
): Promise<string> {
  abortIfSignaled(signal)
  const imagePath = params.image_path.trim()
  if (!imagePath) throw new Error('image_path 不能为空')
  // 守卫内置于工具(参数名是 image_path,guardPathTool 只校验 path 参数)
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
  const maxBytes = opts.maxImageBytes ?? MAX_IMAGE_BYTES
  if (size > maxBytes) {
    throw new Error(`图片文件超过大小上限(${maxBytes} 字节,实际 ${size} 字节)`)
  }
  const mime = mimeFor(imagePath)
  if (!mime) {
    throw new Error(`不支持的图片格式:${path.extname(imagePath) || '(无扩展名)'}(支持的格式:JPEG/PNG/GIF/WebP)`)
  }
  const key = resolveApiKey(opts)
  if (!key) {
    throw new Error('未配置小米视觉 API key(请先在设置 → 视觉模型中开启并填写)')
  }
  const base64 = (await readFile(absPath)).toString('base64')
  const question = params.question?.trim() || DEFAULT_QUESTION

  const endpoint = opts.endpoint ?? VISION_ENDPOINT
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

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
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
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
        '视觉理解工具(小米 mimo-v2.5 视觉模型)。当用户要求描述/分析工作区内的图片——截图、UI 图、' +
        '流程图、报错截图、示意图等——时使用;工具读取图片内容并返回文字描述(图片本身不回传)。' +
        '前提:设置 → 视觉模型中已开启「视觉模型」开关并配置小米 API key(按量付费,不计入订阅/Token Plan);' +
        '开关关闭或未配置 key 时本工具不可用。' +
        '参数:image_path 必填(相对工作区根的图片路径,支持 JPEG/PNG/GIF/WebP,单张 ≤ 10MB);' +
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
