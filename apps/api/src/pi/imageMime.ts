/**
 * 图片格式 / 体积公共常量与魔数嗅探(vision-understand 工具与上传路由共用,避免重复)。
 *
 * 值域白名单:JPEG / PNG / GIF / WebP(扩展名判定 + 字节魔数嗅探两条路)。
 * 单图上限 10MB 与 visionTools 共用;上传路由与工具保持一致。
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** mime 白名单(键 = 扩展名,值 = mime;v1 语义不变,按扩展名判定) */
export const SUPPORTED_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 嗅探到的 mime → 落盘扩展名(上传路由用;mime 一律来自 SUPPORTED_MIME 值域) */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** mime → 扩展名;不在白名单返回 undefined */
export function extForMime(mime: string): string | undefined {
  return EXT_BY_MIME[mime]
}

/**
 * 魔数嗅探:按字节判断图片 mime,无法识别返回 undefined。
 * - PNG:89 50 4E 47(0x89 'PNG')
 * - JPEG:FF D8 FF
 * - GIF:47 49 46 38('GIF8',兼容 87a/89a)
 * - WebP:52 49 46 46('RIFF').... 57 45 42 50('WEBP')
 */
export function sniffMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 6) === 'GIF87a') return 'image/gif'
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 6) === 'GIF89a') return 'image/gif'
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}
