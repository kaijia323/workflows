/**
 * 图片压缩工具封装单测(双层 mock 策略第一层:mock compressorjs 本体,测封装逻辑)。
 *
 * jsdom 不实现 canvas / HTMLCanvasElement.toBlob(),compressorjs 在单测环境不可用;
 * 此处 mock 库本体(成功/失败回调直通),验证 Promise 包装、参数透传、双趟压缩参数、
 * blobToDataUrl(jsdom FileReader 真实可用,不 mock)与非图片拒绝。
 * 真实压缩行为/画质/速度由 Phase 4 浏览器冒烟覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Compressor from 'compressorjs'
import { blobToDataUrl, compressImage, PASTE_COMPRESS_OPTS, preparePastedImage, THUMB_COMPRESS_OPTS } from './image'

// jsdom 未实现 URL.createObjectURL / revokeObjectURL:stub 为确定性值
URL.createObjectURL = vi.fn(() => 'blob:mock-thumb')
URL.revokeObjectURL = vi.fn()

interface FakeOptions {
  maxWidth?: number
  maxHeight?: number
  quality?: number
  mimeType?: string
  convertSize?: number
  success?: (file: Blob) => void
  error?: (error: Error) => void
}

/** mock 库本体:记录实例化参数;默认成功回调原样返回;failNext=true 时走 error 回调 */
vi.mock('compressorjs', () => {
  class FakeCompressor {
    static failNext = false
    static calls: FakeOptions[] = []
    constructor(file: Blob, options: FakeOptions = {}) {
      const { success, error, ...params } = options
      FakeCompressor.calls.push(params) // 只记压缩参数,不记回调
      queueMicrotask(() => {
        if (FakeCompressor.failNext) {
          FakeCompressor.failNext = false
          error?.(new Error('compress boom'))
        } else {
          success?.(file)
        }
      })
    }
  }
  return { default: FakeCompressor }
})

const mockCompressor = Compressor as unknown as { failNext: boolean; calls: FakeOptions[] }
const pngFile = (): File => new File(['img-bytes'], 'shot.png', { type: 'image/png' })

beforeEach(() => {
  mockCompressor.calls = []
  mockCompressor.failNext = false
  vi.mocked(URL.createObjectURL).mockClear()
  vi.mocked(URL.revokeObjectURL).mockClear()
})

describe('compressImage(compressorjs Promise 包装)', () => {
  it('成功:resolve 为 Blob;options 原样透传给 Compressor', async () => {
    const file = pngFile()
    const out = await compressImage(file, { maxWidth: 2048, quality: 0.85, convertSize: 1 * 1024 * 1024 })
    expect(out).toBe(file)
    expect(mockCompressor.calls).toHaveLength(1)
    expect(mockCompressor.calls[0]).toEqual({ maxWidth: 2048, quality: 0.85, convertSize: 1 * 1024 * 1024 })
  })

  it('缺省 options 时透传空对象(库默认 strict/checkOrientation 生效)', async () => {
    const file = pngFile()
    await compressImage(file)
    expect(mockCompressor.calls[0]).toEqual({})
  })

  it('错误路径:error 回调被调用 → reject 且错误信息透出', async () => {
    mockCompressor.failNext = true
    await expect(compressImage(pngFile(), {})).rejects.toThrow('compress boom')
  })
})

describe('blobToDataUrl(FileReader 字节序列化,jsdom 真实可用)', () => {
  it('data URL 前缀与内容一致', async () => {
    const bytes = new TextEncoder().encode('hello-image')
    const url = await blobToDataUrl(new Blob([bytes], { type: 'image/png' }))
    expect(url).toBe(`data:image/png;base64,${btoa('hello-image')}`)
  })
})

describe('preparePastedImage(双趟压缩,均走 compressorjs)', () => {
  it('两次 Compressor 调用参数 = PASTE_COMPRESS_OPTS(2048/0.85/1MB)与 THUMB_COMPRESS_OPTS(160/0.75)', async () => {
    const result = await preparePastedImage(pngFile())
    expect(mockCompressor.calls).toHaveLength(2)
    // 第一趟:上传图(≤2048px / quality 0.85 / PNG>1MB 转 JPEG);第二趟:缩略图(≤160px / 0.75)
    expect(mockCompressor.calls[0]).toEqual(PASTE_COMPRESS_OPTS)
    expect(mockCompressor.calls[1]).toEqual(THUMB_COMPRESS_OPTS)
    // 返回形状:uploadDataUrl(data: 前缀)+ thumbUrl(objectURL)
    expect(result.uploadDataUrl).toBe(`data:image/png;base64,${btoa('img-bytes')}`)
    expect(result.thumbUrl).toBe('blob:mock-thumb')
    expect(result.uploadBlob instanceof Blob).toBe(true)
  })

  it('第二趟输入是第一趟压缩产物(uploadBlob,非原文件)', async () => {
    const file = pngFile()
    await preparePastedImage(file)
    // mock 的 success 回调原样返回入参:第一趟返回 file,第二趟入参 = 第一趟产物
    expect(PASTE_COMPRESS_OPTS.maxWidth).toBe(2048)
    expect(THUMB_COMPRESS_OPTS.maxHeight).toBe(160)
    expect(mockCompressor.calls).toHaveLength(2)
  })

  it('非图片 File → 拒绝(类型校验)', async () => {
    const txt = new File(['x'], 'note.txt', { type: 'text/plain' })
    await expect(preparePastedImage(txt)).rejects.toThrow('仅支持粘贴图片文件')
    expect(mockCompressor.calls).toHaveLength(0)
  })
})
