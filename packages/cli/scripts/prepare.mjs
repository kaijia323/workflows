/**
 * 将 apps/api/src 整树复制到 packages/cli/src/api(排除 *.test.ts,含 pi/agents/*.md)。
 * 发布产物自包含的前提:CLI 包不依赖 workspace 内的私有包,api 源码以复制方式随包分发。
 * 硬性前置:apps/web/dist 必须已存在(先运行 pnpm build;prepack 自身不触发 web 构建)。
 */
import { cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiSrc = path.resolve(cliRoot, '../../apps/api/src')
const target = path.join(cliRoot, 'src/api')
const webDist = path.resolve(cliRoot, '../../apps/web/dist')

if (!existsSync(webDist)) {
  console.error('[prepare] 未找到 apps/web/dist,请先运行 pnpm build(前端构建产物随 CLI 包分发)')
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
cpSync(apiSrc, target, {
  recursive: true,
  filter: (src) => !src.endsWith('.test.ts'),
})
console.log(`[prepare] api 源码已复制到 ${path.relative(cliRoot, target)}(排除 *.test.ts)`)
