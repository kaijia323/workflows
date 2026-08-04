/**
 * 极简 ResourceLoader:只注入 systemPrompt / appendSystemPrompt,不加载任何扩展资源。
 *
 * 为什么不用 DefaultResourceLoader:
 * - DefaultResourceLoader 需要先 reload() 才会填充 prompt,而 reload 会走
 *   packageManager.resolve(),触碰全局扩展包(违反「不读写 pi 全局配置」约定)
 * - createAgentSession 对调用方传入的 resourceLoader 假设已加载完成
 */
import { homedir } from 'node:os'
import path from 'node:path'
import {
  loadSkills,
  type LoadSkillsResult,
  type ResourceDiagnostic,
  type ResourceLoader,
  type Skill,
} from '@earendil-works/pi-coding-agent'
import type { SkillInfo, SkillSource } from '@workflows/shared'

/**
 * skills 加载上下文(四个来源的根;agentDir 有意不传,SDK 默认 ~/.pi/agent 或 PI_CODING_AGENT_DIR)。
 * 主代理(piService)与子代理(subAgent)共用同一结构,保证主/子代理 skills 一致。
 */
export interface SkillLoadContext {
  /** 工作区目录(来源 b 的 cwd,同时是 skillPaths 相对解析基准) */
  cwd: string
  /** store.skillsDir = <root>/.workflows/skills(来源 c) */
  skillsDir: string
  /** 用户主目录(缺省 os.homedir();测试注入临时 home 以隔离 ~/.agents/skills) */
  homeDir?: string
}

function homeDirOf(ctx: SkillLoadContext): string {
  return ctx.homeDir ?? homedir()
}

/**
 * 用 SDK loadSkills 加载四来源:
 * - (a) ~/.pi/agent/skills:includeDefaults + 不传 agentDir → SDK 默认 getAgentDir()(scope=user)
 * - (b) <cwd>/.pi/skills:includeDefaults 附带(scope=project)
 * - (c) .workflows/skills:skillPaths 显式传 ctx.skillsDir(绝对路径)
 * - (d) ~/.agents/skills:skillPaths 显式传,用 os.homedir() 展开为绝对路径
 * diagnostics 记日志但不抛错(坏 skill 跳过,不阻断会话)。
 */
export function loadWorkspaceSkills(ctx: SkillLoadContext): LoadSkillsResult {
  const result = loadSkills({
    cwd: ctx.cwd,
    skillPaths: [ctx.skillsDir, path.join(homeDirOf(ctx), '.agents', 'skills')],
    includeDefaults: true,
    // agentDir 有意不传 → SDK 内部 agentDir ?? getAgentDir() 取默认 ~/.pi/agent
    // (LoadSkillsOptions 类型声明 agentDir 为必填,但运行时支持缺省,窄化断言)
  } as Parameters<typeof loadSkills>[0])
  logSkillDiagnostics(result.diagnostics)
  return result
}

/**
 * 诊断降噪:可选目录缺失(~/.agents/skills 在多数机器上不存在)是常态,
 * 降为 debug;其余诊断(坏 skill、同名冲突)保持 warn。
 */
function logSkillDiagnostics(diags: ResourceDiagnostic[]): void {
  for (const d of diags) {
    if (d.type === 'warning' && d.message === 'skill path does not exist') {
      console.debug(`[skills] 可选目录不存在(忽略): ${d.path ?? ''}`)
      continue
    }
    console.warn(`[skills] ${d.type}: ${d.message} (${d.path ?? ''})`)
  }
}

/** Skill → SkillInfo:scope 判断默认来源,路径判断显式来源(见分类函数) */
export function toSkillInfo(skill: Skill, ctx: SkillLoadContext): SkillInfo {
  const source = classifySkillSource(skill, ctx)
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    source,
    sourcePath: skill.baseDir,
    disableModelInvocation: skill.disableModelInvocation,
  }
}

/**
 * 来源分类(单一事实源):
 * - scope=user → 唯一来源 includeDefaults 的 <agentDir>/skills = ~/.pi/agent/skills
 * - scope=project → 唯一来源 <cwd>/.pi/skills
 * - scope=temporary(显式 skillPaths)→ 按我们传入的根做路径归属(workspace / global-agents)
 */
export function classifySkillSource(skill: Skill, ctx: SkillLoadContext): SkillSource {
  const scope = skill.sourceInfo.scope
  if (scope === 'user') return 'pi-agent'
  if (scope === 'project') return 'pi-project'
  const base = path.resolve(skill.baseDir)
  if (isUnder(base, path.resolve(ctx.skillsDir))) return 'workspace'
  if (isUnder(base, path.resolve(homeDirOf(ctx), '.agents', 'skills'))) return 'global-agents'
  return 'path'
}

/**
 * 路径归属判断:target 在 root 之下(含 root 自身),分隔符边界前缀比较;
 * Windows/macOS 折叠大小写(与 config.ts samePath 策略一致,防御性)。
 */
function isUnder(target: string, root: string): boolean {
  const t = path.resolve(target)
  const r = path.resolve(root)
  const fold = process.platform === 'win32' || process.platform === 'darwin'
  const a = fold ? t.toLowerCase() : t
  const b = fold ? r.toLowerCase() : r
  if (a === b) return true
  const prefix = b.endsWith(path.sep) ? b : `${b}${path.sep}`
  return a.startsWith(prefix)
}

export interface PromptOnlyLoaderOptions {
  systemPrompt?: string
  appendSystemPrompt?: string[]
  /** 提供则 getSkills 返回真实加载结果;缺省保持空(现状) */
  skills?: SkillLoadContext
}

export function createPromptOnlyLoader(options: PromptOnlyLoaderOptions = {}): ResourceLoader {
  let skillsResult: LoadSkillsResult = options.skills
    ? loadWorkspaceSkills(options.skills)
    : { skills: [], diagnostics: [] }
  const runtime = {
    pendingProviderRegistrations: [],
    pendingNativeProviderRegistrations: [],
    flagValues: new Map(),
    invalidate: () => {},
  }
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => skillsResult,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => options.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => options.appendSystemPrompt ?? [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {
      if (options.skills) skillsResult = loadWorkspaceSkills(options.skills)
    },
  } as unknown as ResourceLoader
}
