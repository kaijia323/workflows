/**
 * 极简 ResourceLoader:只注入 systemPrompt / appendSystemPrompt,不加载任何扩展资源。
 *
 * 为什么不用 DefaultResourceLoader:
 * - DefaultResourceLoader 需要先 reload() 才会填充 prompt,而 reload 会走
 *   packageManager.resolve(),触碰全局扩展包(违反「不读写 pi 全局配置」约定)
 * - createAgentSession 对调用方传入的 resourceLoader 假设已加载完成
 */
import type { ResourceLoader } from '@earendil-works/pi-coding-agent'

export function createPromptOnlyLoader(systemPrompt?: string, appendSystemPrompt?: string[]): ResourceLoader {
  const runtime = {
    pendingProviderRegistrations: [],
    pendingNativeProviderRegistrations: [],
    flagValues: new Map(),
    invalidate: () => {},
  }
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => appendSystemPrompt ?? [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  } as unknown as ResourceLoader
}
