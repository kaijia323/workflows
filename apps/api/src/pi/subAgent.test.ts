/**
 * 子代理事件镜像单测。
 *
 * 回归:SDK agent-loop 对每个工具结果发 message_start(role=toolResult),
 * 若无条件镜像,前端模态窗会出现一条条只有闪烁光标(showCaretRow)的空消息。
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Workspace } from '@workflows/shared'
import type { AgentDefinition } from './agentDefs.js'
import type { RunFile } from './runManager.js'
import type { FffIndexManager } from './fffTools.js'
import { buildSubAgentTools, detectArtifact, nextArtifactName, toSubEvents } from './subAgent.js'

function msgEvent(role: string, timestamp = 1): AgentSessionEvent {
  return {
    type: 'message_start',
    message: {
      role,
      content: [{ type: 'text', text: 'hello' }],
      timestamp,
    },
  } as unknown as AgentSessionEvent
}

function makeRun(runId = 'r1', agents: Array<{ agent: string }> = []): RunFile {
  return {
    runId,
    sessionId: 's1',
    status: 'planning',
    gate: { pending: false, planFile: null },
    createdAt: 0,
    updatedAt: 0,
    agents: agents.map((a, i) => ({
      callId: `c${i}`,
      agent: a.agent,
      summary: '',
      artifact: null,
      sessionFile: null,
      ts: 0,
    })),
  } as RunFile
}

function makeDef(name: string, write?: string[]): AgentDefinition {
  return { source: 'test', frontmatter: { name, ...(write ? { write } : {}) }, body: 'x' }
}

function makeWorkspace(): { dir: string; workspace: Workspace } {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-sub-'))
  mkdirSync(path.join(dir, '.wf-runs', 'r1'), { recursive: true })
  const workspace = { id: 'w1', path: dir } as unknown as Workspace
  return { dir, workspace }
}

describe('buildSubAgentTools 子代理工具集(anysearch-search)', () => {
  const ROLES = ['explorer', 'planner', 'executor', 'reviewer']
  /** fff 索引缺失 stub(与无索引工作区等价) */
  const stubFff = { get: () => undefined } as unknown as FffIndexManager

  it.each(ROLES)('%s:tools 与 activeNames 均含 anysearch-search(恰一次)', (role) => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { tools, activeNames } = buildSubAgentTools({
        workspace,
        definition: makeDef(role),
        fff: stubFff,
        matcher: undefined,
      })
      expect(activeNames.filter((n) => n === 'anysearch-search')).toHaveLength(1)
      expect(tools.filter((t) => t.name === 'anysearch-search')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('executor(全量写)与 explorer(纯只读)的工具集差异仅限写工具,联网工具一致', () => {
    const { dir, workspace } = makeWorkspace()
    try {
      const explorer = buildSubAgentTools({
        workspace,
        definition: makeDef('explorer'),
        fff: stubFff,
        matcher: undefined,
      })
      const executor = buildSubAgentTools({
        workspace,
        definition: makeDef('executor', ['**']),
        fff: stubFff,
        matcher: undefined,
      })
      for (const name of ['anysearch-search', 'read', 'ls']) {
        expect(explorer.tools.some((t) => t.name === name)).toBe(true)
        expect(executor.tools.some((t) => t.name === name)).toBe(true)
      }
      // executor 额外获得写工具;explorer 无 bash/edit/write
      for (const name of ['bash', 'edit', 'write']) {
        expect(executor.activeNames).toContain(name)
        expect(explorer.activeNames).not.toContain(name)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('executor 分支 read 与只读分支 read 放行行为一致(P2 回归:extraAllowedRoots 生效,write/edit 仍拦)', async () => {
    type Exec = (toolCallId: string, params: { path?: string }) => Promise<unknown>
    const { dir, workspace } = makeWorkspace()
    // 放行根:真实 HOME 下的 skills 路径(不在临时目录白名单内,纯词法校验,无 I/O)
    const home = process.env.HOME ?? process.env.USERPROFILE
    expect(home).toBeTruthy()
    const extraRoot = path.join(home!, '.agents', 'skills')
    const skillPath = path.join(extraRoot, 'grill-me', 'SKILL.md')
    // read 对放行根内路径的 guard 结果:不抛「工作区边界拦截」即放行(真实文件缺失与否不影响断言)
    const readOutcome = async (tools: ToolDefinition[]): Promise<string> => {
      const readDef = tools.find((t) => t.name === 'read')!
      try {
        await (readDef.execute as unknown as Exec)('id', { path: skillPath })
        return 'ok'
      } catch (err) {
        return String((err as Error).message)
      }
    }
    try {
      const explorer = buildSubAgentTools({
        workspace,
        definition: makeDef('explorer'),
        fff: stubFff,
        matcher: undefined,
        extraAllowedRoots: [extraRoot],
      })
      const executor = buildSubAgentTools({
        workspace,
        definition: makeDef('executor', ['**']),
        fff: stubFff,
        matcher: undefined,
        extraAllowedRoots: [extraRoot],
      })
      const executorNoRoots = buildSubAgentTools({
        workspace,
        definition: makeDef('executor', ['**']),
        fff: stubFff,
        matcher: undefined,
      })
      // 两分支 read 对放行根内路径均不抛工作区边界拦截(executor 的 read 不得丢放行根)
      expect(await readOutcome(explorer.tools)).not.toMatch(/工作区边界拦截/)
      expect(await readOutcome(executor.tools)).not.toMatch(/工作区边界拦截/)
      // 控制组:不传放行根时 executor read 对同一路径仍拦(证明放行根确实生效,非空断言)
      expect(await readOutcome(executorNoRoots.tools)).toMatch(/工作区边界拦截/)
      // executor 工具集中 read 唯一(与只读基础工具统一,无重复注册覆盖)
      expect(executor.tools.filter((t) => t.name === 'read')).toHaveLength(1)
      // write/edit 对放行根内路径仍拦(P1 语义在子代理侧同样成立)
      for (const name of ['write', 'edit']) {
        const def = executor.tools.find((t) => t.name === name)!
        await expect((def.execute as unknown as Exec)('id', { path: skillPath })).rejects.toThrow(/工作区边界拦截/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildSubAgentTools 子代理工具集(mcpTools 注册)', () => {
  const ROLES = ['explorer', 'planner', 'executor', 'reviewer']
  const stubFff = { get: () => undefined } as unknown as FffIndexManager
  const fakeMcpTool = {
    name: 'mcp__srv__foo',
    label: 'mcp__srv__foo',
    description: 'MCP 工具',
    parameters: { type: 'object' },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'x' }], details: undefined }),
  } satisfies ToolDefinition

  it.each(ROLES)('%s:传入 mcpTools 时 tools 与 activeNames 均含该工具名(恰一次)', (role) => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { tools, activeNames } = buildSubAgentTools({
        workspace,
        definition: makeDef(role, role === 'executor' ? ['**'] : undefined),
        fff: stubFff,
        matcher: undefined,
        mcpTools: [fakeMcpTool],
      })
      expect(activeNames.filter((n) => n === 'mcp__srv__foo')).toHaveLength(1)
      expect(tools.filter((t) => t.name === 'mcp__srv__foo')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(ROLES)('%s:缺省 mcpTools 时不包含 mcp 工具(既有行为不变)', (role) => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { tools, activeNames } = buildSubAgentTools({
        workspace,
        definition: makeDef(role, role === 'executor' ? ['**'] : undefined),
        fff: stubFff,
        matcher: undefined,
      })
      expect(activeNames.some((n) => n.startsWith('mcp__'))).toBe(false)
      expect(tools.some((t) => t.name.startsWith('mcp__'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildSubAgentTools 子代理工具集(visionTools 注册)', () => {
  const ROLES = ['explorer', 'planner', 'executor', 'reviewer']
  const stubFff = { get: () => undefined } as unknown as FffIndexManager
  const fakeVisionTool = {
    name: 'vision-understand',
    label: 'vision-understand',
    description: '视觉理解工具',
    parameters: { type: 'object' },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'x' }], details: undefined }),
  } satisfies ToolDefinition

  it.each(ROLES)('%s:传入 visionTools 时 tools 与 activeNames 均含该工具名(恰一次)', (role) => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { tools, activeNames } = buildSubAgentTools({
        workspace,
        definition: makeDef(role, role === 'executor' ? ['**'] : undefined),
        fff: stubFff,
        matcher: undefined,
        visionTools: [fakeVisionTool],
      })
      expect(activeNames.filter((n) => n === 'vision-understand')).toHaveLength(1)
      expect(tools.filter((t) => t.name === 'vision-understand')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(ROLES)('%s:缺省 visionTools 时不包含(既有行为不变)', (role) => {
    const { dir, workspace } = makeWorkspace()
    try {
      const { tools, activeNames } = buildSubAgentTools({
        workspace,
        definition: makeDef(role, role === 'executor' ? ['**'] : undefined),
        fff: stubFff,
        matcher: undefined,
      })
      expect(activeNames.some((n) => n === 'vision-understand')).toBe(false)
      expect(tools.some((t) => t.name === 'vision-understand')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('toSubEvents 事件镜像', () => {
  it('toolResult 消息不镜像为 sub_message_start(回归:模态窗空消息光标)', () => {
    const events = toSubEvents('c1', msgEvent('toolResult'))
    expect(events).toEqual([])
  })

  it('user 消息镜像为带完整任务文本的 sub_message_start', () => {
    const events = toSubEvents('c1', msgEvent('user'))
    expect(events).toEqual([
      { type: 'sub_message_start', callId: 'c1', role: 'user', id: '1-user', text: 'hello' },
    ])
  })

  it('assistant 消息镜像为 sub_message_start(无文本,增量事件随后到达)', () => {
    const events = toSubEvents('c1', msgEvent('assistant'))
    expect(events).toEqual([
      { type: 'sub_message_start', callId: 'c1', role: 'assistant', id: '1-assistant', text: undefined },
    ])
  })
})

describe('nextArtifactName 序号命名(方案 B)', () => {
  it('空 run → 01-exploration-1.md(从 1 起)', () => {
    expect(nextArtifactName(makeRun(), 'explorer')).toBe('01-exploration-1.md')
  })

  it('已有 1 条 explorer → 01-exploration-2.md', () => {
    expect(nextArtifactName(makeRun('r1', [{ agent: 'explorer' }]), 'explorer')).toBe('01-exploration-2.md')
  })

  it('reviewer 2 条后 → 04-review-3.md(含失败调用也计数)', () => {
    const run = makeRun('r1', [{ agent: 'reviewer' }, { agent: 'reviewer' }])
    expect(nextArtifactName(run, 'reviewer')).toBe('04-review-3.md')
  })

  it('executor 序号同样递增', () => {
    expect(nextArtifactName(makeRun('r1', [{ agent: 'executor' }]), 'executor')).toBe('03-execution-2.md')
  })

  it('未知角色 → null(自定义代理不注入产物文件指令)', () => {
    expect(nextArtifactName(makeRun(), 'my-agent')).toBeNull()
  })
})

describe('detectArtifact 产物检测(方案 B)', () => {
  it('预期名精确命中 → 返回预期路径(快路径)', () => {
    const { dir, workspace } = makeWorkspace()
    try {
      writeFileSync(path.join(dir, '.wf-runs', 'r1', '01-exploration-1.md'), 'x')
      const p = detectArtifact(workspace, makeRun(), makeDef('explorer'), '01-exploration-1.md')
      expect(p).toBe(path.join('.wf-runs', 'r1', '01-exploration-1.md'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('预期名缺失但旧名存在 → 前缀扫描返回旧名(容错)', () => {
    const { dir, workspace } = makeWorkspace()
    try {
      writeFileSync(path.join(dir, '.wf-runs', 'r1', '01-exploration.md'), 'x')
      const p = detectArtifact(workspace, makeRun(), makeDef('explorer'), '01-exploration-1.md')
      expect(p).toBe(path.join('.wf-runs', 'r1', '01-exploration.md'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('多个序号文件 → 取最新 mtime;同时刻按文件名降序', () => {
    const { dir, workspace } = makeWorkspace()
    try {
      const f1 = path.join(dir, '.wf-runs', 'r1', '01-exploration-1.md')
      const f2 = path.join(dir, '.wf-runs', 'r1', '01-exploration-2.md')
      writeFileSync(f1, 'a')
      writeFileSync(f2, 'b')
      utimesSync(f1, 1000, 1000)
      utimesSync(f2, 2000, 2000)
      expect(detectArtifact(workspace, makeRun(), makeDef('explorer'), null)).toBe(
        path.join('.wf-runs', 'r1', '01-exploration-2.md'),
      )
      utimesSync(f1, 3000, 3000)
      utimesSync(f2, 3000, 3000)
      expect(detectArtifact(workspace, makeRun(), makeDef('explorer'), null)).toBe(
        path.join('.wf-runs', 'r1', '01-exploration-2.md'),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录无匹配 → null', () => {
    const { dir, workspace } = makeWorkspace()
    try {
      expect(detectArtifact(workspace, makeRun(), makeDef('explorer'), null)).toBeNull()
      expect(detectArtifact(workspace, makeRun(), makeDef('explorer'), '01-exploration-1.md')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('自定义代理回退:白名单单层 * 替换 runId 精确 existsSync', () => {
    const { dir, workspace } = makeWorkspace()
    try {
      writeFileSync(path.join(dir, '.wf-runs', 'r1', 'report.md'), 'x')
      const def = makeDef('my-agent', ['.wf-runs/*/report.md'])
      // 自定义分支返回白名单模式串(正斜杠,与原实现一致),非 path.join 结果
      expect(detectArtifact(workspace, makeRun(), def, null)).toBe('.wf-runs/r1/report.md')
      // 预期名快路径走 path.join(平台分隔符,与 run.json 记录一致)
      expect(detectArtifact(workspace, makeRun(), def, 'report.md')).toBe(path.join('.wf-runs', 'r1', 'report.md'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
