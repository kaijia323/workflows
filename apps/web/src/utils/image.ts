/**
 * 图片压缩封装(compressorjs 唯一入口)。
 *
 * 粘贴图片链路:粘贴 → compressorjs 压缩(≤2048px / quality 0.85 / PNG>1MB 自动转 JPEG)
 * → Blob → base64 上传 + objectURL 预览(双趟:上传图 + 160px 缩略图,均走同一库,
 * 仓库内不自实现任何 canvas 绘制/缩放逻辑)。
 *
 * 设计(决策 11):
 * - compressImage 是三方库的 Promise 包装(success → resolve(Blob)、error → reject(Error)),
 *   未来切换备选库(browser-image-compression)仅需重写本文件,自有签名不变;
 * - 输出格式跟随原图 mime:≤1MB PNG 保持 PNG 无损清晰;>1MB PNG 经 convertSize 自动转 JPEG;
 *   JPEG/WebP 按原格式重压(quality 0.85);不强制 WebP(决策 9);
 * - compressorjs 默认 strict:true(压缩后更大时返回原图)、checkOrientation:true(EXIF 方向自动修正);
 * - blobToDataUrl 只做字节序列化(上传接口需要 base64),不属于压缩实现,jsdom 可用。
 */
import Compressor from 'compressorjs'

export interface CompressOptions {
  maxWidth?: number
  maxHeight?: number
  quality?: number
  mimeType?: string
  /** 源图超过该字节数时按 convertTypes 转换格式(PNG→JPEG,compressorjs 默认 convertTypes=['image/png']) */
  convertSize?: number
}

/** compressorjs 回调式 API → Promise 封装(压缩库唯一入口,未来换库只改本文件) */
export function compressImage(file: File | Blob, options: CompressOptions = {}): Promise<Blob> {
  return new Promise((resolve, reject) => {
    new Compressor(file, { ...options, success: resolve, error: reject })
  })
}

/** 粘贴图压缩参数:最长边 ≤2048px / quality 0.85 / PNG >1MB 自动转 JPEG */
export const PASTE_COMPRESS_OPTS: CompressOptions = {
  maxWidth: 2048,
  quality: 0.85,
  convertSize: 1 * 1024 * 1024,
}

/** 缩略图参数:同一库第二次调用,最长边 ≤160px(预览条 56px / 气泡 64px 显示,2x 清晰度) */
export const THUMB_COMPRESS_OPTS: CompressOptions = {
  maxWidth: 160,
  maxHeight: 160,
  quality: 0.75,
}

/**
 * 压缩 → 双趟产物:
 * - uploadBlob / uploadDataUrl:上传用(data URL 纯字节序列化,非压缩)
 * - thumbUrl:预览用内存 objectURL(调用方负责 revokeObjectURL,决策 6)
 */
export async function preparePastedImage(
  file: File,
): Promise<{ uploadBlob: Blob; uploadDataUrl: string; thumbUrl: string }> {
  if (!file.type.startsWith('image/')) {
    throw new Error('仅支持粘贴图片文件')
  }
  const uploadBlob = await compressImage(file, PASTE_COMPRESS_OPTS) // 第一趟:上传图(≤2048px)
  const thumbBlob = await compressImage(uploadBlob, THUMB_COMPRESS_OPTS) // 第二趟:缩略图(≤160px)
  return {
    uploadBlob,
    uploadDataUrl: await blobToDataUrl(uploadBlob),
    thumbUrl: URL.createObjectURL(thumbBlob),
  }
}

/** Blob → data URL(FileReader 纯字节序列化,非压缩逻辑,jsdom 可用) */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('读取图片数据失败'))
    reader.readAsDataURL(blob)
  })
}
