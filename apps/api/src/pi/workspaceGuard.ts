/**
 * 工作区边界守卫(workspace guard)
 *
 * 目标:即使单用户使用,也不允许 agent 的工具调用逃逸到工作区目录之外。
 *
 * 分层拦截:
 * 1. bash 命令 → unbash 解析 AST,审计重定向目标 / 文件操作命令参数 / cd 目标 /
 *    嵌套命令替换,任何解析到工作区外的路径一律拒绝(返回带定位的错误,模型可自我纠正)
 * 2. read/write/edit/grep/find/ls → 包装 ToolDefinition,execute 前校验 path 参数
 *
 * 可选只读放行根(extraAllowedRoots,缺省空、向后兼容):
 * 工作区外的 skills 目录(~/.pi/agent/skills、~/.agents/skills、prod 下 ~/.workflows/skills)
 * 对 read/ls/fff-find/fff-grep 等只读工具的 path 参数校验放行;bash/write/edit 一律不放行。
 * 放行根是子树语义(仅 skills 根之下),兄弟路径(~/.workflows/config.json 等)仍拦截。
 * 放行根由 promptLoader.skillReadRoots(ctx) 提供(主/子代理共用单一事实源)。
 *
 * 设计取舍(护栏定位,非安全边界):
 * - 解释器 -c/-e 字符串(python3 -c "...")内部的路径不审计——静态分析无法可靠
 *   区分代码与路径,这是有意取舍
 * - 含未知动态展开($VAR 等)的路径:无法证明安全 → 拒绝
 * - bash 命令解析失败:无法证明安全 → 拒绝
 * - sed/awk/xargs 等"命令注入型"工具不审计参数(脚本体与路径无法区分),
 *   由其重定向兜底
 * - 嵌套命令替换递归审计,深度上限 6,超出不再深挖(正常生成几乎不可能到达)
 */

import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { parse, type Command, type Node, type ParsedScript, type Redirect, type Word } from 'unbash'
import type { BashSpawnContext, BashSpawnHook, ToolDefinition } from '@earendil-works/pi-coding-agent'

export interface GuardViolation {
  /** 越界的路径(或无法验证的内容) */
  target: string
  /** 来源描述:命令参数 / 重定向 / cd / 命令替换 / 解析失败 */
  source: string
}

/** 参数即路径的文件操作命令(选项参数以 - 开头,自动跳过) */
const FILE_PATH_COMMANDS = new Set([
  'cat', 'rm', 'cp', 'mv', 'mkdir', 'rmdir', 'touch', 'tee', 'ln', 'chmod', 'chown',
  'install', 'dd', 'truncate', 'stat', 'file', 'head', 'tail', 'less', 'more', 'wc',
  'diff', 'patch', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'xz', 'bzip2', 'zcat',
  'du', 'cpio', 'rsync', 'scp', 'vi', 'vim', 'nano', 'mount', 'umount', 'source', '.', 'ls',
])

/**
 * bash 中禁用的搜索命令:强制 agent 使用 fff-find / fff-grep 工具
 * (fff 为工作区维护常驻索引,毫秒级;子进程搜索每次调用都付冷启动成本)
 */
const DISABLED_SEARCH_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['find', '文件搜索已禁用,请使用 fff-find 工具'],
  ['rg', '全文搜索已禁用,请使用 fff-grep 工具'],
  ['fd', '文件搜索已禁用,请使用 fff-find 工具'],
  ['fzf', '文件搜索已禁用,请使用 fff-find 工具'],
])

/** grep 仅禁用递归形态(-r/-R/--recursive);单文件 grep 与管道过滤(git diff | grep)合法 */
const GREP_RECURSIVE_FLAGS = new Set(['-r', '-R', '--recursive', '--recurse'])

/** 组合短标志(-rn / -rin / -nr 等)也视为递归 */
function isRecursiveGrepFlag(flag: string): boolean {
  if (GREP_RECURSIVE_FLAGS.has(flag)) return true
  return /^-[a-zA-Z]*r[a-zA-Z]*$/.test(flag)
}

/** 参数即目录的命令(所有参数都是路径) */
const CD_COMMANDS = new Set(['cd', 'pushd', 'popd'])

/** 文件重定向操作符(heredoc / fd 复制不在此列) */
const FILE_REDIRECT_OPERATORS = new Set(['>', '>>', '<', '<>', '>|', '&>', '&>>'])

const MAX_SUBSTITUTION_DEPTH = 6

/** 设备/无信息流白名单(原始 bash 形式精确匹配,msys 与 Linux 语义一致):
 * 这些路径不携带任何数据(丢弃/熵源/进程自身 fd),拦截无安全收益只有误伤。
 * `/dev/fd/N` 放行是安全的:要打开指向外部文件的 fd,必须先出现外部路径(已被审计)。 */
const DEVICE_WHITELIST = new Set([
  '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom',
  '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty',
])

/** 主目录:Git Bash 场景 HOME 可能是 POSIX 风格(/c/Users/...),展开后统一转换 */
function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir()
}

/** 展开环境的预置变量(HOME/PWD/临时目录),赋值传播在此基础上叠加 */
function baseEnv(workspacePath: string): Map<string, string> {
  const env = new Map<string, string>()
  env.set('HOME', homeDir())
  env.set('PWD', workspacePath)
  if (process.env.TEMP) env.set('TEMP', process.env.TEMP)
  if (process.env.TMP) env.set('TMP', process.env.TMP)
  if (process.env.TMPDIR) env.set('TMPDIR', process.env.TMPDIR)
  return env
}

/**
 * 临时目录判定(resolve 后边界匹配,win32 大小写归一)。
 * 必须 resolve 后再比:否则 `$TEMP\..\..\secret` 可骗过字符串前缀检查。
 */
function isTempPath(resolved: string): boolean {
  const temps = new Set<string>()
  temps.add(tmpdir())
  if (process.env.TEMP) temps.add(process.env.TEMP)
  if (process.env.TMP) temps.add(process.env.TMP)
  if (process.env.TMPDIR) temps.add(process.env.TMPDIR)
  for (const t of temps) {
    const root = path.resolve(t)
    const rel = path.relative(root, resolved)
    if (rel === '') return true
    const normalized = process.platform === 'win32' ? rel.toLowerCase() : rel
    if (!normalized.startsWith('..') && !path.isAbsolute(normalized)) return true
  }
  return false
}

/**
 * 统一路径判定(bash 层与工具层共用):
 * 设备白名单 → 临时目录 → 工作区内 → 任一放行根内 → 否则拒绝。
 * candidate 为 bash/工具参数语境下的原始路径;extraAllowedRoots 缺省空(向后兼容)。
 * 注意:bash 层(auditBashCommand/createWorkspaceBashHook)不接收放行根,
 * 只读放行仅对 read/ls/fff 等工具的参数校验生效。
 */
export function isAllowedTargetPath(
  candidate: string,
  workspacePath: string,
  extraAllowedRoots: string[] = [],
): boolean {
  if (DEVICE_WHITELIST.has(candidate)) return true
  if (candidate === '/dev/fd' || candidate.startsWith('/dev/fd/')) return true
  const normalized = normalizeBashPath(candidate)
  if (normalized === null) return false
  const resolved = path.resolve(workspacePath, normalized)
  if (isTempPath(resolved)) return true
  if (isPathWithinWorkspace(workspacePath, resolved)) return true
  // 任一放行根内(子树语义;root 防御性 resolve;win32 大小写折叠由 isPathWithinWorkspace 内置)
  for (const root of extraAllowedRoots) {
    if (isPathWithinWorkspace(path.resolve(root), resolved)) return true
  }
  return false
}

/**
 * 判断 target 是否位于 workspace 目录内(含工作区根本身)。
 * Windows 上大小写不敏感;符号链接不解析(信任模型不会用链接绕行)。
 */
export function isPathWithinWorkspace(workspacePath: string, targetPath: string): boolean {
  const root = path.resolve(workspacePath)
  // 相对路径基于工作区解析(与 pi 工具 resolveToCwd 语义一致)
  const target = path.resolve(root, targetPath)
  const rel = path.relative(root, target)
  if (rel === '') return true
  const normalized = process.platform === 'win32' ? rel.toLowerCase() : rel
  return !normalized.startsWith('..') && !path.isAbsolute(normalized)
}

/**
 * 把 bash 命令语境下的路径规范化为可比较的绝对路径。
 * - `~/...` → HOME 展开
 * - `/tmp/...` → 临时目录(msys 语义;win32 映射到 os.tmpdir())
 * - win32 下 `/c/Users/...` → `C:\Users\...`;`/etc/...` 等其他 msys 根 → null(无法映射,按越界处理)
 * - 相对路径原样返回(调用方基于工作区 resolve)
 */
export function normalizeBashPath(raw: string): string | null {
  let p = raw
  if (p === '~') p = homeDir()
  else if (p.startsWith('~/')) p = path.join(homeDir(), p.slice(2))
  else if (p === '/tmp' || p.startsWith('/tmp/')) p = path.join(tmpdir(), p.slice(4))
  if (process.platform === 'win32') {
    const drive = /^\/[a-zA-Z]\//.exec(p)
    if (drive) return `${drive[0][1].toUpperCase()}:\\${p.slice(3).replace(/\//g, '\\')}`
    if (p.startsWith('/')) return null // msys 根(/etc /usr /proc ...)在工作区外
  }
  return p
}

interface WordValue {
  /** 拼出的值(含动态部分时的已知前缀,仅用于报错展示) */
  value: string
  /** 是否含无法静态确定的展开 */
  dynamic: boolean
}

/**
 * 把 unbash Word 解析为静态值。
 * - 纯字面量(Literal/SingleQuoted/AnsiCQuoted/DoubleQuoted 内字面量)→ 静态
 * - 已知展开(赋值传播表 env 中的变量、:- 默认值字面量)→ 静态
 * - 未知展开($VAR 未定义、命令替换、花括号、glob)→ dynamic
 */
function resolveWord(word: Word | undefined, env: ReadonlyMap<string, string>): WordValue {
  if (!word) return { value: '', dynamic: false }
  const parts = word.parts
  if (!parts || parts.length === 0) {
    // 无展开的纯字面量;~ 前缀在 parts 中不体现,手动展开
    if (word.text.startsWith('~')) {
      const expanded = normalizeBashPath(word.text)
      return { value: expanded ?? word.text, dynamic: false }
    }
    return { value: word.text, dynamic: false }
  }
  let value = ''
  let dynamic = false
  const appendPart = (p: Word['parts'] extends (infer T)[] | undefined ? T : never): void => {
    if (dynamic) return
    switch (p.type) {
      case 'Literal':
      case 'SingleQuoted':
      case 'AnsiCQuoted':
        value += p.value
        return
      case 'DoubleQuoted':
      case 'LocaleString':
        for (const child of p.parts) appendPart(child as never)
        return
      case 'SimpleExpansion': {
        // text 形如 "$TEMP",去 $ 前缀后查 env
        const v = env.get(p.text.slice(1))
        if (v !== undefined) value += v
        else dynamic = true
        return
      }
      case 'ParameterExpansion': {
        if (p.indirect) {
          dynamic = true
          return
        }
        const v = env.get(p.parameter)
        if (v !== undefined) {
          value += v
          return
        }
        // ${VAR:-default} 的默认值字面量可静态使用
        if ((p.operator === ':-' || p.operator === '-') && p.operand) {
          const fallback = resolveWord(p.operand, env)
          if (!fallback.dynamic) value += fallback.value
          else dynamic = true
          return
        }
        dynamic = true
        return
      }
      default:
        // 命令替换 / 算术展开 / 进程替换 / 花括号 / extglob:不可静态确定
        dynamic = true
    }
  }
  for (const part of parts) appendPart(part as never)
  return { value, dynamic }
}

/** 审计单条命令:参数路径 + 重定向 + 赋值传播 + 嵌套命令替换 */
function auditCommand(
  command: Command,
  workspacePath: string,
  violations: GuardViolation[],
): void {
  // 赋值前缀(FOO=/etc/x cat $FOO)→ 本命令内的常量传播
  const env = baseEnv(workspacePath)
  for (const assignment of command.prefix) {
    if (!assignment.name) continue
    const resolved = resolveWord(assignment.value, env)
    if (!resolved.dynamic) env.set(assignment.name, resolved.value)
  }

  const nameText = command.name?.text ?? ''
  const nameStatic = command.name ? !resolveWord(command.name, env).dynamic : false
  if (command.name && !nameStatic) {
    violations.push({
      source: '命令名',
      target: `无法静态确定命令名「${command.name.text}」,拒绝执行`,
    })
    return
  }

  // 禁用搜索命令:find/rg/fd 无条件;grep 仅递归形态
  if (DISABLED_SEARCH_COMMANDS.has(nameText)) {
    violations.push({ source: '命令', target: DISABLED_SEARCH_COMMANDS.get(nameText)! })
    return
  }
  if (nameText === 'grep') {
    const hasRecursive = command.suffix.some((arg) => isRecursiveGrepFlag(arg.text))
    if (hasRecursive) {
      violations.push({ source: 'grep 参数', target: '递归搜索(-r/-R)已禁用,请使用 fff-grep 工具' })
      return
    }
  }

  // 参数路径检查
  const isCd = CD_COMMANDS.has(nameText)
  const isFileCommand = FILE_PATH_COMMANDS.has(nameText)
  if (isCd || isFileCommand) {
    for (const arg of command.suffix) {
      const text = arg.text
      if (text === '-' || text.startsWith('-')) continue
      const resolved = resolveWord(arg, env)
      let candidate = resolved.value
      // dd 的 if=/of= 形式
      if (nameText === 'dd') {
        const eq = candidate.lastIndexOf('=')
        if (eq >= 0 && (candidate.startsWith('if=') || candidate.startsWith('of='))) {
          candidate = candidate.slice(eq + 1)
        }
      }
      if (resolved.dynamic) {
        violations.push({
          source: `${nameText} 参数`,
          target: `「${text}」含无法静态验证的展开,拒绝执行`,
        })
        continue
      }
      if (!isAllowedTargetPath(candidate, workspacePath)) {
        violations.push({
          source: `${nameText} 参数`,
          target: `「${candidate}」位于工作区之外`,
        })
      }
    }
  }

  // 重定向目标检查(heredoc marker / fd 复制跳过)
  for (const redirect of command.redirects) {
    auditRedirect(redirect, nameText, workspacePath, violations)
  }
}

function auditRedirect(
  redirect: Redirect,
  commandName: string,
  workspacePath: string,
  violations: GuardViolation[],
): void {
  if (!FILE_REDIRECT_OPERATORS.has(redirect.operator)) return
  const target = redirect.target
  if (!target || target.text === '') return
  const resolved = resolveWord(target, baseEnv(workspacePath))
  if (resolved.dynamic) {
    violations.push({
      source: `${commandName} 重定向 ${redirect.operator}`,
      target: `「${target.text}」含无法静态验证的展开,拒绝执行`,
    })
    return
  }
  if (!isAllowedTargetPath(resolved.value, workspacePath)) {
    violations.push({
      source: `${commandName} 重定向 ${redirect.operator}`,
      target: `「${resolved.value}」位于工作区之外`,
    })
  }
}

/** 递归遍历 AST,审计所有命令与嵌套命令替换 */
function auditNode(
  node: Node | undefined,
  workspacePath: string,
  violations: GuardViolation[],
  depth: number,
): void {
  if (!node || depth > MAX_SUBSTITUTION_DEPTH) return
  switch (node.type) {
    case 'Statement':
      for (const redirect of node.redirects) {
        auditRedirect(redirect, '(语句)', workspacePath, violations)
      }
      auditNode(node.command, workspacePath, violations, depth)
      return
    case 'Command':
      auditCommand(node, workspacePath, violations)
      // 参数/重定向中的嵌套命令替换会执行新 shell,递归审计
      for (const word of [node.name, ...node.suffix, ...node.prefix.map((a) => a.value)]) {
        auditWordSubstitutions(word, workspacePath, violations, depth)
      }
      for (const redirect of node.redirects) {
        auditWordSubstitutions(redirect.target, workspacePath, violations, depth)
      }
      return
    case 'Pipeline':
    case 'AndOr':
      for (const child of node.commands) auditNode(child, workspacePath, violations, depth)
      return
    case 'If':
      auditNode(node.clause, workspacePath, violations, depth)
      auditNode(node.then, workspacePath, violations, depth)
      if (node.else) auditNode(node.else, workspacePath, violations, depth)
      return
    case 'While':
      auditNode(node.clause, workspacePath, violations, depth)
      auditNode(node.body, workspacePath, violations, depth)
      return
    case 'CompoundList':
      for (const child of node.commands) auditNode(child, workspacePath, violations, depth)
      return
    case 'For':
    case 'Select':
      for (const word of node.wordlist) auditWordSubstitutions(word, workspacePath, violations, depth)
      auditNode(node.body, workspacePath, violations, depth)
      return
    case 'Case':
      for (const item of node.items) {
        for (const pattern of item.pattern) auditWordSubstitutions(pattern, workspacePath, violations, depth)
        auditNode(item.body, workspacePath, violations, depth)
      }
      return
    case 'Subshell':
    case 'BraceGroup':
    case 'Function':
    case 'Coproc':
      auditNode(node.body, workspacePath, violations, depth)
      return
    case 'ArithmeticFor':
      auditNode(node.body, workspacePath, violations, depth)
      return
    default:
      // TestCommand / ArithmeticCommand 等不涉及文件访问
      return
  }
}

/** 审计 Word 内的 $(...) 嵌套脚本 */
function auditWordSubstitutions(
  word: Word | undefined,
  workspacePath: string,
  violations: GuardViolation[],
  depth: number,
): void {
  if (!word) return
  for (const part of word.parts ?? []) {
    if (part.type === 'CommandExpansion' && part.script) {
      auditScript(part.script, workspacePath, violations, depth + 1)
    }
    if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
      for (const child of part.parts) {
        if (child.type === 'CommandExpansion' && child.script) {
          auditScript(child.script, workspacePath, violations, depth + 1)
        }
      }
    }
  }
}

function auditScript(
  script: ParsedScript,
  workspacePath: string,
  violations: GuardViolation[],
  depth: number,
): void {
  if (depth > MAX_SUBSTITUTION_DEPTH) return
  // 嵌套脚本的解析错误必须单独检查(错误挂在最近的 script 上)
  for (const error of script.errors ?? []) {
    violations.push({
      source: '嵌套命令替换',
      target: `解析失败:${error.message}`,
    })
  }
  for (const statement of script.commands) {
    auditNode(statement, workspacePath, violations, depth)
  }
}

/**
 * 审计一条 bash 命令,返回所有越界/无法验证的违规项。
 * 解析失败也视为违规(无法证明安全 → 拒绝)。
 */
export function auditBashCommand(command: string, workspacePath: string): GuardViolation[] {
  const violations: GuardViolation[] = []
  const script = parse(command)
  for (const error of script.errors ?? []) {
    violations.push({
      source: '命令解析',
      target: `解析失败:${error.message} (位置 ${error.pos})`,
    })
  }
  for (const statement of script.commands) {
    auditNode(statement, workspacePath, violations, 0)
  }
  return violations
}

/** 生成 bash 工具的 spawnHook:命令越界时抛错阻断执行 */
export function createWorkspaceBashHook(workspacePath: string): BashSpawnHook {
  return (context: BashSpawnContext): BashSpawnContext => {
    const violations = auditBashCommand(context.command, workspacePath)
    if (violations.length > 0) {
      const details = violations.map((v) => `- ${v.source}:${v.target}`).join('\n')
      throw new Error(
        `工作区边界拦截:命令尝试访问工作区之外,已拒绝执行。\n${details}\n\n` +
          `工作区:${workspacePath}\n` +
          `请将操作限制在该工作区目录内。`,
      )
    }
    return context
  }
}

/** AgentTool 的结构子集(SDK 主入口未导出 Tool 类型,用泛型结构类型适配) */
interface AgentToolLike<P = unknown, D = unknown> {
  name: string
  label: string
  description: string
  parameters: unknown
  constrainedSampling?: unknown
  prepareArguments?: unknown
  executionMode?: unknown
  execute: (toolCallId: string, params: P, signal?: AbortSignal, onUpdate?: (update: D) => void) => Promise<unknown>
}

/**
 * AgentTool → ToolDefinition 适配(SDK 内置同名函数未从主入口导出,等价实现)。
 * 使 SDK 工厂创建的完整工具(含渲染)能以 customTools 形式注册并同名覆盖内置工具。
 */
export function toToolDefinition<P = unknown, D = unknown>(tool: AgentToolLike<P, D>): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as ToolDefinition['parameters'],
    constrainedSampling: tool.constrainedSampling as ToolDefinition['constrainedSampling'],
    prepareArguments: tool.prepareArguments as ToolDefinition['prepareArguments'],
    executionMode: tool.executionMode as ToolDefinition['executionMode'],
    execute: async (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params as P, signal, onUpdate as (update: D) => void),
  } as ToolDefinition
}

/**
 * 包装工具定义:execute 前校验 path 参数(相对路径基于工作区解析,与 pi 工具语义一致)。
 * 覆盖 read/write/edit/grep/find/ls;返回原定义(原地修改 execute)。
 */
export function guardPathTool<T extends ToolDefinition>(
  definition: T,
  workspacePath: string,
  extraAllowedRoots: string[] = [],
): T {
  const originalExecute = definition.execute
  definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
    const rawPath = (params as { path?: unknown }).path
    if (typeof rawPath === 'string' && rawPath !== '') {
      if (!isAllowedTargetPath(rawPath, workspacePath, extraAllowedRoots)) {
        throw new Error(
          `工作区边界拦截:${definition.name} 尝试访问工作区之外的路径「${rawPath}」` +
            `(解析为 ${path.resolve(workspacePath, rawPath)})。` +
            `\n工作区:${workspacePath}\n请将操作限制在该工作区目录内。`,
        )
      }
    }
    return originalExecute(toolCallId, params, signal, onUpdate, ctx)
  }
  return definition
}
