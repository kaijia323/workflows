/**
 * complete_task / wait_for_approval 工具 execute 单测。
 *
 * 背景:「无 run 不创建」方案 —— 两个工具在无进行中 run 可复用时不再自动新建空 run,
 * 直接返回提示文本(零落盘);有进行中 run 时行为完全不变(置 done / awaiting_approval + 落盘)。
 * 通过私有构造 + 注入 fake handle 的方式直测真实 execute 路径(piService 无既有测试基建)。
 */
import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SessionEvent, Workspace } from '@workflows/shared'
import type { RunStatus } from '@workflows/shared'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { WorkflowsStore } from '../config.js'
import { loadConfig } from '../config.js'
import { PiAgentService } from './piService.js'
import { loadRun, type RunFile } from './runManager.js'
import { runSubAgent } from './subAgent.js'

// 子代理运行器 mock:仅直测 activeEmitters 按 workspace.id 隔离的转发路径,
// 不真正拉起子代理会话(需要真实 ModelRuntime / 模型调用)
vi.mock('./subAgent.js', () => ({
  runSubAgent: vi.fn(),
  SubAgentError: class SubAgentError extends Error {},
}))

/** 与 SessionHandle 运行时同构的最小 handle(工具 execute 只用到其中部分字段) */
interface FakeHandle {
  workspace: Workspace
  sessionId: string
  session: unknown
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }
  busy: boolean
  lastActivityAt: number | null
  run: RunFile | null
  turnWaitCalled: boolean
  turnCompleteCalled: boolean
  turnSubAgentCalled: boolean
}

type ToolExec = (callId: string, params: { summary: string }) => Promise<{
  content: Array<{ type: string; text: string }>
  details: undefined
}>

/** 仅暴露测试所需私有成员的视图(private 成员编译期不可见,运行时可达) */
type TestApi = {
  handles: Map<string, FakeHandle>
  activeEmitters: Map<string, (event: SessionEvent) => void>
  createCompleteTaskTool(workspace: Workspace): { execute: unknown }
  createWaitForApprovalTool(workspace: Workspace): { execute: unknown }
  createSubAgentTool(workspace: Workspace, def: unknown): { execute: unknown }
  ensureRun(handle: FakeHandle): RunFile
  prompt(workspace: Workspace, text: string, onEvent: (event: SessionEvent) => void): Promise<void>
  openSession(workspace: Workspace): Promise<FakeHandle>
}

/** 子代理工具 execute 的最小调用签名(只用到 task 参数与 signal) */
type SubToolExec = (
  callId: string,
  params: { task: string },
  signal: AbortSignal,
) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>

/** 最小子代理定义(createSubAgentTool 只读 frontmatter.name / description) */
function makeAgentDef(name: string): { frontmatter: { name: string; description: string }; body: string } {
  return { frontmatter: { name, description: `${name} 子代理` }, body: 'x' }
}

function makeStore(dir: string): WorkflowsStore {
  return {
    root: dir,
    agentDir: path.join(dir, 'agent'),
    agentsDir: path.join(dir, 'agents'),
    skillsDir: path.join(dir, 'skills'),
    configPath: path.join(dir, 'config.json'),
    workspacesPath: path.join(dir, 'workspaces.json'),
    sessionsPath: path.join(dir, 'workspace-sessions.json'),
  }
}

function makeService(store: WorkflowsStore): PiAgentService {
  return new (PiAgentService as unknown as new (store: WorkflowsStore, runtime: ModelRuntime) => PiAgentService)(
    store,
    {} as unknown as ModelRuntime,
  )
}

function makeWorkspace(dir: string): Workspace {
  return { id: 'w1', path: dir } as unknown as Workspace
}

function makeHandle(workspace: Workspace, run: RunFile | null): FakeHandle {
  return {
    workspace,
    sessionId: 's1',
    session: {},
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    busy: false,
    lastActivityAt: null,
    run,
    turnWaitCalled: false,
    turnCompleteCalled: false,
    turnSubAgentCalled: false,
  }
}

function makeRun(runId: string, status: RunStatus = 'executing'): RunFile {
  return {
    runId,
    sessionId: 's1',
    status,
    gate: { pending: false, planFile: null },
    createdAt: 1,
    updatedAt: 1,
    agents: [{ callId: 'c1', agent: 'explorer', summary: 'x', artifact: null, sessionFile: null, ts: 1 }],
  }
}

function writeRunFile(dir: string, run: RunFile): void {
  const runDir = path.join(dir, '.wf-runs', run.runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2) + '\n', 'utf-8')
}

describe('complete_task 工具 execute(无 run 不创建)', () => {
  it('无进行中 run:返回提示文本且零落盘(不创建 .wf-runs 目录/文件)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const handle = makeHandle(workspace, null)
      api.handles.set('w1', handle)
      const exec = api.createCompleteTaskTool(workspace).execute as unknown as ToolExec

      const result = await exec('c1', { summary: '交付' })

      expect(result.content[0].text).toBe('当前没有进行中的任务,无需调用 complete_task。')
      expect(existsSync(path.join(dir, '.wf-runs'))).toBe(false)
      expect(handle.turnCompleteCalled).toBe(false)
      expect(handle.run).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('磁盘仅有已 done 的 run(上一任务完成):不新建 run,旧产物原样保留', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const oldRun = makeRun('old1', 'done')
      writeRunFile(dir, oldRun)
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const handle = makeHandle(workspace, null)
      api.handles.set('w1', handle)
      const exec = api.createCompleteTaskTool(workspace).execute as unknown as ToolExec

      const result = await exec('c1', { summary: '交付' })

      expect(result.content[0].text).toBe('当前没有进行中的任务,无需调用 complete_task。')
      // 零新增:目录仍只有 old1,且 run.json 未被改写
      expect(readdirSync(path.join(dir, '.wf-runs'))).toEqual(['old1'])
      expect(JSON.parse(readFileSync(path.join(dir, '.wf-runs', 'old1', 'run.json'), 'utf-8'))).toEqual(oldRun)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('有进行中 run:行为不变——置 done、崩溃安全落盘、释放内存 run', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const run = makeRun('r1', 'executing')
      const handle = makeHandle(workspace, run)
      api.handles.set('w1', handle)
      const exec = api.createCompleteTaskTool(workspace).execute as unknown as ToolExec

      const result = await exec('c1', { summary: '交付' })

      expect(result.content[0].text).toBe('任务已标记为完成。立即结束回合,向用户做最终交付总结。')
      const persisted = loadRun(dir, 'r1')
      expect(persisted?.status).toBe('done')
      expect(persisted?.gate.pending).toBe(false)
      expect(existsSync(path.join(dir, '.wf-runs', 'r1', 'run.json'))).toBe(true)
      expect(handle.turnCompleteCalled).toBe(true)
      expect(handle.run).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('wait_for_approval 工具 execute(无 run 不创建)', () => {
  it('无进行中 run:返回提示文本且零落盘(不创建 .wf-runs 目录/文件)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const handle = makeHandle(workspace, null)
      api.handles.set('w1', handle)
      const exec = api.createWaitForApprovalTool(workspace).execute as unknown as ToolExec

      const result = await exec('c1', { summary: '计划' })

      expect(result.content[0].text).toBe('当前没有进行中的任务,无需请求批准。')
      expect(existsSync(path.join(dir, '.wf-runs'))).toBe(false)
      expect(handle.turnWaitCalled).toBe(false)
      expect(handle.run).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('有进行中 run:行为不变——awaiting_approval 落盘、置闸门标志', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const run = makeRun('r1', 'executing')
      const handle = makeHandle(workspace, run)
      api.handles.set('w1', handle)
      const exec = api.createWaitForApprovalTool(workspace).execute as unknown as ToolExec

      const result = await exec('c1', { summary: '计划' })

      expect(result.content[0].text).toContain('已请求用户批准')
      const persisted = loadRun(dir, 'r1')
      expect(persisted?.status).toBe('awaiting_approval')
      expect(persisted?.gate.pending).toBe(true)
      expect(handle.turnWaitCalled).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('setVisionConfig(开关翻转触发会话重建,key-only 不重建)', () => {
  it('开关翻转 → 调用 refreshOpenSessions;仅 key 变更 → 不调用;配置落盘', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const store = makeStore(dir)
      const service = makeService(store)
      const api = service as unknown as {
        setVisionConfig(patch: { enabled?: boolean; apiKey?: string }): Promise<void>
        refreshOpenSessions(): Promise<void>
      }
      const refresh = vi.spyOn(api, 'refreshOpenSessions').mockResolvedValue()

      // 默认关 → 开:开关翻转,重建
      await api.setVisionConfig({ enabled: true, apiKey: 'sk-a' })
      expect(refresh).toHaveBeenCalledTimes(1)

      // 开关不变,仅 key 变更:不重建(getApiKey 动态读取,已注册工具下次调用即用新 key)
      await api.setVisionConfig({ enabled: true, apiKey: 'sk-b' })
      expect(refresh).toHaveBeenCalledTimes(1)

      // 开 → 关:开关翻转,重建
      await api.setVisionConfig({ enabled: false })
      expect(refresh).toHaveBeenCalledTimes(2)

      // 磁盘断言:开关与 key 均落盘(空串删除语义由 config.ts 覆盖)
      const stored = loadConfig(store)
      expect(stored.visionEnabled).toBe(false)
      expect(stored.visionApiKey).toBe('sk-b')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ensureRun(子代理调用路径不受影响)', () => {
  it('默认 create=true 仍自动创建 run 并落盘(子代理路径行为不变)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const handle = makeHandle(workspace, null)
      api.handles.set('w1', handle)

      const created = api.ensureRun(handle)

      expect(created.runId).toBeTruthy()
      expect(handle.run?.runId).toBe(created.runId)
      expect(loadRun(dir, created.runId)?.status).toBe('planning')
      expect(existsSync(path.join(dir, '.wf-runs', created.runId, 'run.json'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('activeEmitters(按 workspace.id 隔离,跨工作区并发回合不串流)', () => {
  /** 双工作区夹具:各建 run + handle,并注入独立 emitter */
  function setupTwoWorkspaces(dir: string) {
    const service = makeService(makeStore(dir))
    const api = service as unknown as TestApi
    const wsA = { ...makeWorkspace(dir), id: 'wsA' }
    const wsB = { ...makeWorkspace(dir), id: 'wsB' }
    writeRunFile(dir, makeRun('rA', 'executing'))
    writeRunFile(dir, makeRun('rB', 'executing'))
    api.handles.set('wsA', makeHandle(wsA, makeRun('rA', 'executing')))
    api.handles.set('wsB', makeHandle(wsB, makeRun('rB', 'executing')))
    const eventsA: SessionEvent[] = []
    const eventsB: SessionEvent[] = []
    api.activeEmitters.set('wsA', (e) => eventsA.push(e))
    api.activeEmitters.set('wsB', (e) => eventsB.push(e))
    return { api, wsA, wsB, eventsA, eventsB }
  }

  it('子代理回合 sub_end 只进入本工作区 emitter(双工作区并行对照)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const { api, wsA, wsB, eventsA, eventsB } = setupTwoWorkspaces(dir)
      vi.mocked(runSubAgent).mockResolvedValue({ summary: '搞定', artifact: null, sessionFile: null })
      const execA = api.createSubAgentTool(wsA, makeAgentDef('explorer')).execute as unknown as SubToolExec
      const execB = api.createSubAgentTool(wsB, makeAgentDef('explorer')).execute as unknown as SubToolExec

      const [ra, rb] = await Promise.all([
        execA('cA', { task: 't' }, new AbortController().signal),
        execB('cB', { task: 't' }, new AbortController().signal),
      ])

      expect(ra.content[0].text).toBe('搞定')
      expect(rb.content[0].text).toBe('搞定')
      expect(eventsA).toEqual([expect.objectContaining({ type: 'sub_end', callId: 'cA', isError: false })])
      expect(eventsB).toEqual([expect.objectContaining({ type: 'sub_end', callId: 'cB', isError: false })])
      // 互不串流:事件没有落到对方 emitter
      expect(eventsA.some((e) => e.type === 'sub_end' && e.callId === 'cB')).toBe(false)
      expect(eventsB.some((e) => e.type === 'sub_end' && e.callId === 'cA')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('子代理失败:sub_end(isError=true) 仍按工作区归位,且错误向上抛', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const { api, wsA, eventsA, eventsB } = setupTwoWorkspaces(dir)
      vi.mocked(runSubAgent).mockRejectedValue(new Error('boom'))
      const execA = api.createSubAgentTool(wsA, makeAgentDef('explorer')).execute as unknown as SubToolExec

      await expect(execA('cA', { task: 't' }, new AbortController().signal)).rejects.toThrow('boom')
      expect(eventsA).toEqual([expect.objectContaining({ type: 'sub_end', callId: 'cA', isError: true })])
      expect(eventsB).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gate_required 事件只进入本工作区 emitter(双工作区对照)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const { api, wsA, wsB, eventsA, eventsB } = setupTwoWorkspaces(dir)
      const execA = api.createWaitForApprovalTool(wsA).execute as unknown as ToolExec
      const execB = api.createWaitForApprovalTool(wsB).execute as unknown as ToolExec

      await execA('cA', { summary: '计划A' })
      await execB('cB', { summary: '计划B' })

      expect(eventsA).toEqual([expect.objectContaining({ type: 'gate_required', runId: 'rA', summary: '计划A' })])
      expect(eventsB).toEqual([expect.objectContaining({ type: 'gate_required', runId: 'rB', summary: '计划B' })])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('prompt 回合 activeEmitters 生命周期', () => {
  it('prompt 结束(finally)后 activeEmitters 清空,不泄漏', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const handle = makeHandle(workspace, null)
      // 最小 fake session:subscribe 返回退订函数,prompt 直接成功,无事件回调触发
      handle.session = {
        subscribe: () => () => {},
        prompt: async () => {},
        messages: [],
      }
      vi.spyOn(api, 'openSession').mockResolvedValue(handle)
      const received: string[] = []

      await api.prompt(workspace, 'hi', (e) => received.push(e.type))

      expect(received).toEqual(['done'])
      expect(api.activeEmitters.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('subscribe 抛异常:activeEmitters 无残留条目(set 在 subscribe 之后、try 内)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-pi-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const handle = makeHandle(workspace, null)
      handle.session = {
        subscribe: () => {
          throw new Error('subscribe boom')
        },
        prompt: async () => {},
        messages: [],
      }
      vi.spyOn(api, 'openSession').mockResolvedValue(handle)

      await expect(api.prompt(workspace, 'hi', () => {})).rejects.toThrow('subscribe boom')

      // set 未执行 → Map 无残留;后续同工作区回合不会被幽灵条目串流
      expect(api.activeEmitters.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
