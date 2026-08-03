import { marked } from 'marked'

/**
 * 消息 Markdown 渲染
 * 流式场景下每次 text_delta 都会触发全量重解析,marked 对聊天级文本
 * (几千字符) 为毫秒级,无需节流/防抖。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const SAFE_PROTO = /^(https?:|mailto:)/i

marked.use({
  // 模型输出中的原生 HTML 一律转义为文本展示,防止脚本注入
  walkTokens(token) {
    if (token.type === 'html') token.raw = escapeHtml(token.raw)
  },
  renderer: {
    // 只放行 http/https/mailto,其余协议退化为纯文本
    link(token) {
      const href = token.href ?? ''
      if (!SAFE_PROTO.test(href)) return token.text
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${title}>${token.text}</a>`
    },
  },
})

/**
 * 流式场景:模型还没输出闭合符时,未闭合的代码块会被 marked 当成普通段落,
 * 等闭合符到达的瞬间才跳变成代码块样式,造成闪烁。
 * 检测到末尾有未闭合 fence 时补上闭合符,让代码块在整个流式期间保持形态稳定。
 */
function closeOpenFence(text: string): string {
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^ {0,3}```/.test(line)) inFence = !inFence
  }
  return inFence ? `${text}\n\`\`\`` : text
}

export function renderMarkdown(text: string): string {
  const src = closeOpenFence(text)
  return marked.parse(src, { async: false }) as string
}
