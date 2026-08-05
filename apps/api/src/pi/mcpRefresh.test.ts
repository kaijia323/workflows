/**
 * MCP 配置变更后会话重建单测(refreshMcpForOpenSessions / rebuildHandle / prompt 挂起消费)。
 *
 * 沿用 piService.test.ts 的私有构造 hack + spy 方案(Tier 1):
 * 不跑完整 openSession(避免 fff 原生进程 spawn),openSession 一律 vi.spyOn mock;
 * fake handle 的 session 仅需 dispose / subscribe / prompt(取决于被测路径)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Workspace } from '@workflows/shared'
import type { WorkflowsStore } from '../config.js'
import { PiAgentService } from './piService.js'

/** 与 SessionHandle 运行时同构的最小 handle(被测路径只用到其中部分字段) */
interface FakeHandle {
  workspace: Workspace
  sessionId: string
  session: {
    dispose: ReturnType<typeof vi.fn>
    subscribe?: ReturnType<typeof vi.fn>
    prompt?: ReturnType<typeof vi.fn>
    messages?: unknown[]
  }
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }
  busy: boolean
  lastActivityAt: number | null
  mcpRebuildPending?: boolean
  run: null
  turnWaitCalled: boolean
  turnCompleteCalled: boolean
  turnSubAgentCalled: boolean
}

/** 仅暴露测试所需私有成员的视图(private 成员编译期不可见,运行时可达) */
type TestApi = {
  handles: Map<string, FakeHandle>
  openSession(workspace: Workspace, sessionId?: string): Promise<FakeHandle>
  rebuildHandle(handle: FakeHandle): Promise<FakeHandle>
  refreshMcpForOpenSessions(): Promise<void>
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

function makeWorkspace(dir: string, extra: Partial<Workspace> = {}): Workspace {
  return { id: 'w1', path: dir, ...extra } as unknown as Workspace
}

function makeHandle(workspace: Workspace, extra: Partial<FakeHandle> = {}): FakeHandle {
  return {
    workspace,
    sessionId: 's1',
    session: { dispose: vi.fn() },
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.1 },
    busy: false,
    lastActivityAt: 1234,
    run: null,
    turnWaitCalled: false,
    turnCompleteCalled: false,
    turnSubAgentCalled: false,
    ...extra,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('refreshMcpForOpenSessions(空闲立即重建)', () => {
  it('空闲 handle:旧 session 被 dispose,openSession 以 (workspace, sessionId) 重开,usage/lastActivityAt 迁移', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-mcp-refresh-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const oldHandle = makeHandle(workspace)
      api.handles.set('w1', oldHandle)
      const freshHandle = makeHandle(workspace, { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } })
      // mock 同时模拟真实 openSession 的注册行为(rebuildHandle 依赖 map 更新)
      const openSession = vi.spyOn(api, 'openSession').mockImplementation(async () => {
        api.handles.set('w1', freshHandle)
        return freshHandle
      })

      await api.refreshMcpForOpenSessions()

      expect(oldHandle.session.dispose).toHaveBeenCalledTimes(1)
      expect(openSession).toHaveBeenCalledWith(workspace, 's1')
      // 新 handle 入 map,usage/lastActivityAt 从旧 handle 迁移
      expect(api.handles.get('w1')).toBe(freshHandle)
      expect(freshHandle.usage).toEqual(oldHandle.usage)
      expect(freshHandle.lastActivityAt).toBe(oldHandle.lastActivityAt)
      expect(freshHandle.mcpRebuildPending).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('忙碌 handle:不 dispose、不重建,置 mcpRebuildPending=true', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-mcp-refresh-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const busyHandle = makeHandle(workspace, { busy: true })
      api.handles.set('w1', busyHandle)
      const openSession = vi.spyOn(api, 'openSession').mockResolvedValue(makeHandle(workspace))

      await api.refreshMcpForOpenSessions()

      expect(busyHandle.session.dispose).not.toHaveBeenCalled()
      expect(openSession).not.toHaveBeenCalled()
      expect(busyHandle.mcpRebuildPending).toBe(true)
      expect(api.handles.get('w1')).toBe(busyHandle)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('只读工作区 handle:跳过(不 dispose、不置位)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-mcp-refresh-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir, { readOnly: true })
      const roHandle = makeHandle(workspace)
      api.handles.set('w1', roHandle)
      const openSession = vi.spyOn(api, 'openSession').mockResolvedValue(makeHandle(workspace))

      await api.refreshMcpForOpenSessions()

      expect(roHandle.session.dispose).not.toHaveBeenCalled()
      expect(roHandle.mcpRebuildPending).toBeUndefined()
      expect(openSession).not.toHaveBeenCalled()
      expect(api.handles.get('w1')).toBe(roHandle)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('多 handle 单失败隔离:一个重建彻底失败不影响另一个正常重建,refresh 不抛', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-mcp-refresh-'))
    try {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const wsBad = makeWorkspace(dir, { id: 'w-bad' })
      const wsGood = makeWorkspace(dir, { id: 'w-good' })
      const badHandle = makeHandle(wsBad)
      const goodHandle = makeHandle(wsGood)
      api.handles.set('w-bad', badHandle)
      api.handles.set('w-good', goodHandle)
      const freshGood = makeHandle(wsGood, { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 } })
      // w-bad 的主重建与降级回退都失败(按 workspace id 区分,确定性);w-good 正常重开(同时模拟注册)
      const openSession = vi.spyOn(api, 'openSession').mockImplementation(async (ws: Workspace) => {
        if (ws.id === 'w-bad') throw new Error('boom')
        api.handles.set('w-good', freshGood)
        return freshGood
      })

      await expect(api.refreshMcpForOpenSessions()).resolves.toBeUndefined()

      // w-good 正常重建(usage 迁移);w-bad 被 dispose 且无新 handle(降级也失败,仅记录日志)
      expect(goodHandle.session.dispose).toHaveBeenCalledTimes(1)
      expect(api.handles.get('w-good')).toBe(freshGood)
      expect(freshGood.usage).toEqual(goodHandle.usage)
      expect(badHandle.session.dispose).toHaveBeenCalledTimes(1)
      expect(api.handles.get('w-bad')).toBeUndefined()
      expect(errorLog).toHaveBeenCalled()
      expect(openSession).toHaveBeenCalledTimes(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('rebuildHandle(失败降级)', () => {
  it('重开失败 → 回退 openSession(workspace) 新建会话,不抛错,usage 不迁移', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-mcp-refresh-'))
    try {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const oldHandle = makeHandle(workspace)
      api.handles.set('w1', oldHandle)
      // fallback 用与 makeHandle 默认值不同的非默认 usage/lastActivityAt(全新会话语义)
      const fallbackHandle = makeHandle(workspace, {
        sessionId: 'fresh-id',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
        lastActivityAt: null,
      })
      const openSession = vi
        .spyOn(api, 'openSession')
        .mockRejectedValueOnce(new Error('JSONL 恢复失败'))
        .mockResolvedValueOnce(fallbackHandle)

      const result = await api.rebuildHandle(oldHandle)

      expect(oldHandle.session.dispose).toHaveBeenCalledTimes(1)
      // 同 sessionId 重开失败 → 降级新建会话(不带 sessionId)
      expect(openSession).toHaveBeenNthCalledWith(1, workspace, 's1')
      expect(openSession).toHaveBeenNthCalledWith(2, workspace)
      expect(result).toBe(fallbackHandle)
      // 降级路径不迁移:fallback 保留自身全新 usage/lastActivityAt,而非旧 handle 的值
      expect(result.usage).toEqual(fallbackHandle.usage)
      expect(result.usage).not.toEqual(oldHandle.usage)
      expect(result.lastActivityAt).toBeNull()
      expect(result.lastActivityAt).not.toBe(oldHandle.lastActivityAt)
      expect(errorLog).toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('prompt() 挂起重建消费', () => {
  it('忙碌且置位:先抛「正在处理中」,不 dispose(绝不打断运行中回合)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-mcp-refresh-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const busyHandle = makeHandle(workspace, { busy: true, mcpRebuildPending: true })
      api.handles.set('w1', busyHandle)
      vi.spyOn(api, 'openSession').mockResolvedValue(busyHandle)

      await expect(service.prompt(workspace, 'hi', () => {})).rejects.toThrow('agent 正在处理中,请稍候')

      expect(busyHandle.session.dispose).not.toHaveBeenCalled()
      expect(busyHandle.mcpRebuildPending).toBe(true) // 挂起标记保留,下一回合生效
      expect(api.handles.get('w1')).toBe(busyHandle)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('空闲且置位:prompt 入口先重建再开始回合(旧 session dispose,新 handle 生效)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-mcp-refresh-'))
    try {
      const service = makeService(makeStore(dir))
      const api = service as unknown as TestApi
      const workspace = makeWorkspace(dir)
      const oldHandle = makeHandle(workspace, {
        mcpRebuildPending: true,
        session: {
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {}),
          messages: [],
        },
      })
      api.handles.set('w1', oldHandle)
      const freshHandle = makeHandle(workspace, {
        session: {
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
          prompt: vi.fn(async () => {}),
          messages: [],
        },
      })
      const openSession = vi
        .spyOn(api, 'openSession')
        .mockResolvedValueOnce(oldHandle)
        .mockImplementation(async () => {
          // 模拟真实 openSession 的注册行为(rebuildHandle 先 delete 再由 openSession 重新 set)
          api.handles.set('w1', freshHandle)
          return freshHandle
        })

      await service.prompt(workspace, 'hi', () => {})

      // 重建发生:旧 handle dispose,openSession 第二次以同 sessionId 重开,usage 迁移
      expect(oldHandle.session.dispose).toHaveBeenCalledTimes(1)
      expect(openSession).toHaveBeenNthCalledWith(1, workspace)
      expect(openSession).toHaveBeenNthCalledWith(2, workspace, 's1')
      expect(freshHandle.usage).toEqual(oldHandle.usage)
      expect(freshHandle.busy).toBe(false) // 回合正常结束
      expect(api.handles.get('w1')).toBe(freshHandle)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
