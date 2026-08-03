// 构建后把代理定义(src/pi/agents/*.md)复制到 dist/pi/agents。
// tsc 只编译 .ts,不会复制 .md —— 缺失会导致生产环境加载不到任何代理定义,
// 主代理退化为普通编码助手(orchestrator.md 不注入、子代理工具全部不注册)。
import { cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src', 'pi', 'agents')
const dest = path.join(root, 'dist', 'pi', 'agents')

if (!existsSync(src)) {
  console.error(`[build] 代理定义目录不存在:${src}`)
  process.exit(1)
}

// 先清空再复制:避免 src 中删除的代理残留在 dist
rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, { recursive: true })
console.log(`[build] agents/*.md → ${dest}`)
