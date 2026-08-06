/**
 * prepack 时把根 README.md 与 LICENSE 复制到包根,npm 自动附带进 tarball。
 * 源缺失时退出报错(发布前强制根文档/许可存在)。
 */
import { cpSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(cliRoot, '../..')
const docs = [
  ['README.md', path.join(repoRoot, 'README.md')],
  ['LICENSE', path.join(repoRoot, 'LICENSE')],
]

for (const [name, src] of docs) {
  if (!existsSync(src)) {
    console.error(`[copy-docs] 未找到根 ${name},请先在仓库根创建后再发布`)
    process.exit(1)
  }
  cpSync(src, path.join(cliRoot, name)) // 文件复制,覆盖包根同名文件
  console.log(`[copy-docs] ${name} 已复制到包根`)
}
