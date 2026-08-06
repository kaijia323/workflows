#!/usr/bin/env node
/**
 * workflows CLI(`wfs`)入口。
 *
 * 零 CLI 依赖:仅用 Node 内置 util.parseArgs 完成 flag 解析与子命令分派。
 * - 顶层 flag:--help/-h、--version/-V
 * - 子命令:start [--port <port>] [--dev]、upgrade [--dry-run]
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const HELP = `用法:wfs <command> [options]

命令:
  start [options]      启动 workflows 服务(默认端口 5200)
  upgrade [--dry-run]  将 @kaijia/workflows 升级到最新版
  --help, -h           显示本帮助
  --version, -V        显示版本号

start 选项:
  --port <port>  监听端口(1-65535)
  --dev          开发模式(NODE_ENV=development;存储根 = 包上一级 .workflows,不写 ~/.workflows)

端口优先级:--port > 环境变量 PORT > 默认 5200
存储根:生产模式 ~/.workflows;--dev 模式 <cli 包> 上一级 .workflows(仓库内为 packages/.workflows,全局安装为 node_modules/.workflows)
启动后访问 http://localhost:<port>
`

/** 读取包版本(dist/cli.js 与 src/cli.ts 下 ../package.json 均指向包根,随 files:["dist"] 发布) */
function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    version?: string
  }
  return pkg.version ?? '0.0.0'
}

/** 端口解析:--port > 环境变量 PORT > 默认 5200;非法值(非 1-65535 整数)抛错 */
function resolvePort(flagPort: string | undefined): number {
  const raw = flagPort ?? process.env.PORT
  if (raw === undefined || raw === '') return 5200
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效端口「${raw}」:需为 1-65535 的整数`)
  }
  return port
}

/** start 子命令:设置 NODE_ENV → 动态加载 api 并启动(优雅退出逻辑在 startServer 内) */
async function runStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      dev: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })
  if (values.help) {
    console.log(HELP)
    return
  }
  const port = resolvePort(values.port)
  // 关键顺序:先设 NODE_ENV 再动态 import(config.ts 的 workflowsRoot 依此决定存储根)
  process.env.NODE_ENV = values.dev ? 'development' : 'production'
  console.log(`[wfs] 启动 workflows · http://localhost:${port}(${process.env.NODE_ENV} 模式,Ctrl-C 退出)`)
  const { startServer } = await import('./api/index.js')
  await startServer(port)
}

/** 探测安装器:取 npm_config_user_agent 首段(pnpm/npm/yarn/bun);未知回退 npm */
function detectInstaller(): string {
  const first = (process.env.npm_config_user_agent ?? '').split('/')[0]?.toLowerCase() ?? ''
  return first === 'pnpm' || first === 'yarn' || first === 'bun' ? first : 'npm'
}

function upgradeCommand(installer: string): string {
  switch (installer) {
    case 'pnpm':
      return 'pnpm add -g @kaijia/workflows@latest'
    case 'yarn':
      return 'yarn global add @kaijia/workflows@latest'
    case 'bun':
      return 'bun add -g @kaijia/workflows@latest'
    default:
      return 'npm install -g @kaijia/workflows@latest'
  }
}

/** upgrade 子命令:--dry-run 只打印检测结果;实跑失败提示手动执行 */
async function runUpgrade(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { 'dry-run': { type: 'boolean' } },
    allowPositionals: false,
  })
  const installer = detectInstaller()
  const command = upgradeCommand(installer)
  if (values['dry-run']) {
    console.log(`检测到安装器:${installer}`)
    console.log(`升级命令:${command}`)
    return
  }
  console.log(`[wfs] 通过 ${installer} 升级 @kaijia/workflows 至最新版...`)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, { shell: true, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`命令退出码 ${code ?? '未知'}`))
      })
    })
    console.log('[wfs] 升级完成')
  } catch (error) {
    console.error(`[wfs] 升级失败:${error instanceof Error ? error.message : String(error)}`)
    console.error(`请手动执行:${command}`)
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  // 子命令优先分派:start/upgrade 的选项(--port/--dev/--dry-run)只属于子命令,
  // 顶层 parseArgs(strict 模式)不解析它们,避免 `wfs start --port 5201` 被误报未知 flag
  const first = argv[0]
  if (first === 'start' || first === 'upgrade') {
    try {
      await (first === 'start' ? runStart(argv.slice(1)) : runUpgrade(argv.slice(1)))
    } catch (error) {
      console.error(`wfs ${first}:${error instanceof Error ? error.message : String(error)}`)
      console.error('运行 wfs --help 查看用法')
      process.exit(1)
    }
    return
  }

  // 顶层 flag:--help/-h/--version/-V;未知 flag 或未知子命令 → 报错退出 1
  let values: { help?: boolean; version?: boolean }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
      allowPositionals: true,
    }))
  } catch (error) {
    console.error(`wfs:${error instanceof Error ? error.message : String(error)}`)
    console.error('运行 wfs --help 查看用法')
    process.exit(1)
  }

  if (values.version) {
    console.log(readVersion())
    return
  }
  if (values.help || positionals.length === 0) {
    console.log(HELP)
    return
  }
  console.error(`wfs:未知命令「${positionals[0]}」`)
  console.error('运行 wfs --help 查看用法')
  process.exit(1)
}

await main().catch((error) => {
  console.error(`wfs:${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
