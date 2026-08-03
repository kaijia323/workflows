/**
 * run 生命周期管理。
 *
 * - run 绑定「会话内的一次需求处理」,一个会话可有多个 run(产物各自隔离)
 * - 产物目录:<workspace>/.wf-runs/<runId>/run.json + NN-role.md(进 git,删会话不删产物)
 * - 归并规则:当前会话有进行中 run(status 非 done)→ 归并;否则新建
 * - 恢复:服务重启后扫描 .wf-runs,取最新 gate.pending 或未完成的 run 作为当前 run
 * - 冻结:done 后 run.json 不再改写(状态落盘为 done 后不再改写,git 保持干净),新需求开新 run
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { RunAgentCall, RunSnapshot, RunStatus } from '@workflows/shared'

/** 产物根目录名(工作区内,git 可追踪) */
export const RUNS_DIR_NAME = '.wf-runs'

/** run.json 文件名 */
const RUN_FILE = 'run.json'

export interface RunFile {
  runId: string
  sessionId: string
  status: RunStatus
  gate: { pending: boolean; planFile: string | null }
  createdAt: number
  updatedAt: number
  agents: RunAgentCall[]
}

/** 产物目录(相对工作区根) */
export function runDirRel(runId: string): string {
  return path.join(RUNS_DIR_NAME, runId)
}

/** 产物目录绝对路径 */
export function runDirFor(workspacePath: string, runId: string): string {
  return path.join(workspacePath, RUNS_DIR_NAME, runId)
}

/** run.json 绝对路径 */
function runFileFor(workspacePath: string, runId: string): string {
  return path.join(runDirFor(workspacePath, runId), RUN_FILE)
}

function shortId(): string {
  return randomUUID().slice(0, 8)
}

/** 新建 run:创建产物目录 + run.json,返回记录 */
export function createRun(workspacePath: string, sessionId: string): RunFile {
  const runId = shortId()
  const dir = runDirFor(workspacePath, runId)
  mkdirSync(dir, { recursive: true })
  const run: RunFile = {
    runId,
    sessionId,
    status: 'planning',
    gate: { pending: false, planFile: null },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    agents: [],
  }
  saveRun(workspacePath, run)
  return run
}

/** 持久化 run.json(不存在的目录自动创建) */
export function saveRun(workspacePath: string, run: RunFile): void {
  const file = runFileFor(workspacePath, run.runId)
  // 冻结:磁盘上已是 done 的 run.json 永不改写(done 即终态,run.json 是仓库记录)。
  // 首次进入 done 的写盘(complete_task / finally 首次 done)不受影响——此时磁盘还不是 done。
  // 未来如需手动补录 done run,须显式通道(如 force 参数),当前不实现。
  if (run.status === 'done') {
    const existing = loadRun(workspacePath, run.runId)
    if (existing?.status === 'done') return
  }
  mkdirSync(path.dirname(file), { recursive: true })
  run.updatedAt = Date.now()
  writeFileSync(file, JSON.stringify(run, null, 2) + '\n', 'utf-8')
}

/** 读取 run.json;文件不存在或损坏返回 null */
export function loadRun(workspacePath: string, runId: string): RunFile | null {
  const file = runFileFor(workspacePath, runId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as RunFile
  } catch {
    return null
  }
}

/** 扫描 .wf-runs 下所有 run,按 updatedAt 倒序 */
export function listRuns(workspacePath: string): RunFile[] {
  const root = path.join(workspacePath, RUNS_DIR_NAME)
  if (!existsSync(root)) return []
  const runs: RunFile[] = []
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue
    const run = loadRun(workspacePath, entry)
    if (run) runs.push(run)
  }
  return runs.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 归并判定:返回应继续使用的 run。
 * - 内存优先(由调用方传入 currentRunId)
 * - 恢复场景:扫描磁盘,取「最新且未完成(gate.pending 或 status 非 done)」且属于该会话的 run
 */
export function resolveCurrentRun(
  workspacePath: string,
  sessionId: string,
  currentRunId: string | null,
): RunFile | null {
  if (currentRunId) {
    const run = loadRun(workspacePath, currentRunId)
    if (run && run.sessionId === sessionId && run.status !== 'done') return run
  }
  for (const run of listRuns(workspacePath)) {
    if (run.sessionId !== sessionId) continue
    if (run.gate.pending || run.status !== 'done') return run
  }
  return null
}

/** run 快照(前端 / 恢复用) */
export function toSnapshot(run: RunFile): RunSnapshot {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.status,
    gate: { ...run.gate },
    artifacts: collectArtifacts(run),
    agents: run.agents.map((a) => ({ ...a })),
  }
}

/** 扫描产物目录中的 md 文件(相对工作区根) */
export function collectArtifacts(run: RunFile): Array<{ name: string; path: string }> {
  return run.agents
    .map((a) => a.artifact)
    .filter((p): p is string => Boolean(p))
    .map((p) => ({ name: path.basename(p), path: p }))
}

/** 追加一次子代理调用记录并持久化 */
export function appendRunAgentCall(workspacePath: string, run: RunFile, call: RunAgentCall): void {
  const existing = run.agents.findIndex((a) => a.callId === call.callId)
  if (existing >= 0) run.agents[existing] = call
  else run.agents.push(call)
  saveRun(workspacePath, run)
}

/** 回合结束决策(纯函数,供 prompt() finally 与单测共用,决策单一事实源) */
export type TurnEndDecision = 'awaiting_approval' | 'done' | 'keep'

/**
 * 回合结束决策。
 * - turnFailed: 回合异常(错误/abort),不做任何处置(任务状态未知,保守保持)
 * - turnWaitCalled: 闸门优先(即使同时调过 complete_task 也以闸门为准,模型异常行为,闸门胜出)
 * - turnCompleteCalled || !turnSubAgentCalled: 显式完成 / 纯文本交付回合 → done
 * - 其余(调过子代理、无闸门、无 complete_task)= 中途停止 → keep(保持 executing,下回合归并)
 */
export function decideTurnEnd(flags: {
  turnFailed: boolean
  turnWaitCalled: boolean
  turnCompleteCalled: boolean
  turnSubAgentCalled: boolean
}): TurnEndDecision {
  if (flags.turnFailed) return 'keep'
  if (flags.turnWaitCalled) return 'awaiting_approval'
  if (flags.turnCompleteCalled || !flags.turnSubAgentCalled) return 'done'
  return 'keep'
}
