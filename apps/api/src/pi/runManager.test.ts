/**
 * run 生命周期与回合结束决策单测。
 *
 * 覆盖:
 * - decideTurnEnd 纯函数全分支矩阵(闸门优先 / 失败防护 / 显式完成 / 纯文本交付 / 中途停止)
 * - run 生命周期集成:中途停止不释放、complete_task 释放、闸门归并、纯文本释放、失败防护
 *
 * 背景:修复 fd6057f「回合结束 done 即释放 run」导致的同任务跨非闸门回合被拆成多个 runId
 * (实测反例 707736e6 / 1c0fdcc1);方案 c1 = 显式 complete_task + 回合结束三分支。
 */
import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  appendRunAgentCall,
  createRun,
  decideTurnEnd,
  loadRun,
  resolveCurrentRun,
  saveRun,
  type RunFile,
} from './runManager.js'

/** 临时工作区:每用例独立 tmpdir,用后清理 */
function makeWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'wf-run-'))
}

type TurnFlags = Parameters<typeof decideTurnEnd>[0]

/** 回合标志包(默认全 false = 纯文本交付回合) */
function flags(over: Partial<TurnFlags> = {}): TurnFlags {
  return {
    turnFailed: false,
    turnWaitCalled: false,
    turnCompleteCalled: false,
    turnSubAgentCalled: false,
    ...over,
  }
}

function makeCall(agent: string, callId: string, ts: number) {
  return { callId, agent, summary: 'x', artifact: null, sessionFile: null, ts }
}

describe('decideTurnEnd 回合结束决策矩阵', () => {
  it('失败回合(turnFailed)一律 keep,即使其他标志任意组合', () => {
    expect(decideTurnEnd(flags({ turnFailed: true }))).toBe('keep')
    expect(decideTurnEnd(flags({ turnFailed: true, turnWaitCalled: true }))).toBe('keep')
    expect(
      decideTurnEnd(flags({ turnFailed: true, turnCompleteCalled: true, turnSubAgentCalled: true })),
    ).toBe('keep')
  })

  it('闸门优先:turnWaitCalled → awaiting_approval(含同时 completeCalled 的异常组合,闸门胜出)', () => {
    expect(decideTurnEnd(flags({ turnWaitCalled: true }))).toBe('awaiting_approval')
    expect(decideTurnEnd(flags({ turnWaitCalled: true, turnCompleteCalled: true }))).toBe('awaiting_approval')
    expect(decideTurnEnd(flags({ turnWaitCalled: true, turnSubAgentCalled: true }))).toBe('awaiting_approval')
  })

  it('显式完成:turnCompleteCalled + 调过子代理 → done', () => {
    expect(decideTurnEnd(flags({ turnCompleteCalled: true, turnSubAgentCalled: true }))).toBe('done')
  })

  it('纯文本交付回合(全 false,未调子代理/闸门/完成)→ done', () => {
    expect(decideTurnEnd(flags())).toBe('done')
  })

  it('中途停止:调过子代理、无闸门、无 complete → keep', () => {
    expect(decideTurnEnd(flags({ turnSubAgentCalled: true }))).toBe('keep')
  })

  it('调过子代理 + 闸门 → awaiting_approval', () => {
    expect(decideTurnEnd(flags({ turnSubAgentCalled: true, turnWaitCalled: true }))).toBe('awaiting_approval')
  })

  it('调过子代理 + complete_task → done', () => {
    expect(decideTurnEnd(flags({ turnSubAgentCalled: true, turnCompleteCalled: true }))).toBe('done')
  })
})

describe('run 生命周期:任务粒度归并/释放', () => {
  it('中途停止回合不释放:keep 决策后 run 保持 executing,下回合仍归并同一 runId', () => {
    const dir = makeWorkspace()
    try {
      const sessionId = 's1'
      // 回合 1:子代理调用 → status=executing(子代理工具行为)+ 决策 keep(不写盘、不释放)
      let run: RunFile = createRun(dir, sessionId)
      run.status = 'executing'
      appendRunAgentCall(dir, run, makeCall('explorer', 'c1', 1))
      expect(decideTurnEnd(flags({ turnSubAgentCalled: true }))).toBe('keep')
      // handle.run 保留 → 内存命中;服务端视角:resolveCurrentRun 返回同一 run
      const resumed = resolveCurrentRun(dir, sessionId, run.runId)
      expect(resumed?.runId).toBe(run.runId)
      expect(resumed?.status).toBe('executing')
      // 回合 2:再次子代理调用 → 同一 runId(核心回归:707736e6 → 1c0fdcc1 拆分)
      run = resumed!
      appendRunAgentCall(dir, run, makeCall('planner', 'c2', 2))
      const again = resolveCurrentRun(dir, sessionId, run.runId)
      expect(again?.runId).toBe(run.runId)
      expect(again?.agents.map((a) => a.agent)).toEqual(['explorer', 'planner'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('complete_task 释放:决策 done + saveRun 后 resolveCurrentRun 返回 null,新 createRun 产生不同 runId', () => {
    const dir = makeWorkspace()
    try {
      const sessionId = 's1'
      const run = createRun(dir, sessionId)
      // complete_task 工具 execute 语义:status=done + gate.pending=false + saveRun
      run.status = 'done'
      run.gate = { pending: false, planFile: null }
      saveRun(dir, run)
      expect(decideTurnEnd(flags({ turnCompleteCalled: true, turnSubAgentCalled: true }))).toBe('done')
      // 任务完成 → 不再复用(内存/磁盘两条路径均返回 null)
      expect(resolveCurrentRun(dir, sessionId, null)).toBeNull()
      expect(resolveCurrentRun(dir, sessionId, run.runId)).toBeNull()
      const next = createRun(dir, sessionId)
      expect(next.runId).not.toBe(run.runId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('闸门归并:awaiting_approval + gate.pending=true → 返回同一 run;续跑后子代理调用翻回 executing', () => {
    const dir = makeWorkspace()
    try {
      const sessionId = 's1'
      const run = createRun(dir, sessionId)
      // wait_for_approval 工具 execute 语义
      run.status = 'awaiting_approval'
      run.gate = { pending: true, planFile: '.wf-runs/x/02-plan-1.md' }
      saveRun(dir, run)
      expect(decideTurnEnd(flags({ turnWaitCalled: true, turnSubAgentCalled: true }))).toBe('awaiting_approval')
      // 批准续跑 → 同一 run
      const resumed = resolveCurrentRun(dir, sessionId, null)
      expect(resumed?.runId).toBe(run.runId)
      // 续跑后子代理调用 → status 翻回 executing、gate.pending=false(现有行为回归)
      const active = resumed!
      active.status = 'executing'
      active.gate.pending = false
      appendRunAgentCall(dir, active, makeCall('executor', 'c3', 3))
      const persisted = loadRun(dir, run.runId)
      expect(persisted?.status).toBe('executing')
      expect(persisted?.gate.pending).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('纯文本交付释放:决策 done → resolveCurrentRun null → 新 runId', () => {
    const dir = makeWorkspace()
    try {
      const sessionId = 's1'
      const run = createRun(dir, sessionId)
      run.status = 'executing'
      saveRun(dir, run)
      expect(decideTurnEnd(flags())).toBe('done')
      // 纯文本交付回合 finally:置 done + 释放
      run.status = 'done'
      run.gate.pending = false
      saveRun(dir, run)
      expect(resolveCurrentRun(dir, sessionId, null)).toBeNull()
      const next = createRun(dir, sessionId)
      expect(next.runId).not.toBe(run.runId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('失败防护:turnFailed → keep,run.json 内容不变(不写盘),续跑仍归并同一 run', () => {
    const dir = makeWorkspace()
    try {
      const sessionId = 's1'
      const run = createRun(dir, sessionId)
      run.status = 'executing'
      appendRunAgentCall(dir, run, makeCall('explorer', 'c1', 1))
      saveRun(dir, run)
      const before = readFileSync(path.join(dir, '.wf-runs', run.runId, 'run.json'), 'utf-8')
      // 失败回合:决策 keep,finally 不写盘(内容不变、updatedAt 不变)
      expect(decideTurnEnd(flags({ turnFailed: true, turnSubAgentCalled: true }))).toBe('keep')
      const after = readFileSync(path.join(dir, '.wf-runs', run.runId, 'run.json'), 'utf-8')
      expect(after).toBe(before)
      // 语义上不释放:resolveCurrentRun 返回同一 run
      expect(resolveCurrentRun(dir, sessionId, run.runId)?.runId).toBe(run.runId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('done 冻结:done 后 run.json 不再改写', () => {
  it('done 冻结:首次 done 落盘成功(崩溃安全),之后写盘不再改动文件', () => {
    const dir = makeWorkspace()
    try {
      const sessionId = 's1'
      const run = createRun(dir, sessionId)
      run.status = 'executing'
      saveRun(dir, run)
      // complete_task 语义:首次 done 写盘必须成功
      run.status = 'done'
      run.gate = { pending: false, planFile: null }
      saveRun(dir, run)
      expect(loadRun(dir, run.runId)?.status).toBe('done')
      const frozen = readFileSync(path.join(dir, '.wf-runs', run.runId, 'run.json'), 'utf-8')
      // 模拟 finally 重复写 / 同回合改写企图:内容与 updatedAt 均不得变化
      run.updatedAt = 0
      run.gate = { pending: true, planFile: 'x' }
      saveRun(dir, run)
      expect(readFileSync(path.join(dir, '.wf-runs', run.runId, 'run.json'), 'utf-8')).toBe(frozen)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('done 后 appendRunAgentCall 不落盘(磁盘冻结,agents 不追加)', () => {
    const dir = makeWorkspace()
    try {
      const sessionId = 's1'
      const run = createRun(dir, sessionId)
      run.status = 'done'
      run.gate = { pending: false, planFile: null }
      saveRun(dir, run) // 首次 done 写盘
      const frozen = readFileSync(path.join(dir, '.wf-runs', run.runId, 'run.json'), 'utf-8')
      appendRunAgentCall(dir, run, makeCall('explorer', 'c9', 999))
      const persisted = loadRun(dir, run.runId)
      expect(persisted?.agents).toHaveLength(0) // 磁盘未追加
      expect(readFileSync(path.join(dir, '.wf-runs', run.runId, 'run.json'), 'utf-8')).toBe(frozen)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 done → done 的首次写盘不被冻结误伤(纯文本交付 finally 语义)', () => {
    const dir = makeWorkspace()
    try {
      const sessionId = 's1'
      const run = createRun(dir, sessionId)
      run.status = 'executing'
      appendRunAgentCall(dir, run, makeCall('explorer', 'c1', 1))
      const before = loadRun(dir, run.runId)!
      // 纯文本交付回合 finally:决策 done → 首次置 done 落盘
      // saveRun 内部用 Date.now() 写 updatedAt;同毫秒内两次写盘会相等,导致 toBeGreaterThan
      // 偶发失败。用 mock 时钟确定性推进(保留「必须严格递增」语义,比 sleep 方案零 flake)。
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(before.updatedAt + 1000)
      try {
        run.status = 'done'
        run.gate.pending = false
        saveRun(dir, run)
      } finally {
        nowSpy.mockRestore()
      }
      const after = loadRun(dir, run.runId)!
      expect(after.status).toBe('done')
      expect(after.updatedAt).toBeGreaterThan(before.updatedAt) // 正常推进一次
      // 且 resolveCurrentRun 从此排除该 run(终态)
      expect(resolveCurrentRun(dir, sessionId, null)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
