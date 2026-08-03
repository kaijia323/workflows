/**
 * complete_task / wait_for_approval 工具 execute 单测。
 *
 * 背景:「无 run 不创建」方案 —— 两个工具在无进行中 run 可复用时不再自动新建空 run,
 * 直接返回提示文本(零落盘);有进行中 run 时行为完全不变(置 done / awaiting_approval + 落盘)。
 * 通过私有构造 + 注入 fake handle 的方式直测真实 execute 路径(piService 无既有测试基建)。
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Workspace } from '@workflows/shared'
import type { RunStatus } from '@workflows/shared'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { WorkflowsStore } from '../config.js'
import { PiAgentService } from './piService.js'
import { loadRun, type RunFile } from './runManager.js'

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
  createCompleteTaskTool(workspace: Workspace): { execute: unknown }
  createWaitForApprovalTool(workspace: Workspace): { execute: unknown }
  ensureRun(handle: FakeHandle): RunFile
}

function makeStore(dir: string): WorkflowsStore {
  return {
    root: dir,
    agentDir: path.join(dir, 'agent'),
    agentsDir: path.join(dir, 'agents'),
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
