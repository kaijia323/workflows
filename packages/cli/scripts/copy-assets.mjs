/**
 * tsc 之后把两类资源复制进 dist(tsc 只产出 JS/声明文件,不复制 .md 与前端产物):
 * 1. dist/api/pi/agents ← src/api/pi/agents(agent 的 .md 定义;agentDefs.ts 的
 *    BUILTIN_AGENTS_DIR = dirname/agents 在 dist 层级自然命中)
 * 2. dist/web-dist ← apps/web/dist(前端构建产物;app.ts 的 webDist 回退链在包内命中该目录)
 */
import { cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webDist = path.resolve(cliRoot, '../../apps/web/dist')

if (!existsSync(webDist)) {
  console.error('[copy-assets] 未找到 apps/web/dist,请先运行 pnpm build')
  process.exit(1)
}

// 1. agents .md 定义
const agentsSrc = path.join(cliRoot, 'src/api/pi/agents')
const agentsTarget = path.join(cliRoot, 'dist/api/pi/agents')
rmSync(agentsTarget, { recursive: true, force: true })
cpSync(agentsSrc, agentsTarget, { recursive: true })

// 2. 前端构建产物
const webTarget = path.join(cliRoot, 'dist/web-dist')
rmSync(webTarget, { recursive: true, force: true })
cpSync(webDist, webTarget, { recursive: true })

console.log('[copy-assets] dist/api/pi/agents 与 dist/web-dist 已就绪')
