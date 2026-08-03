import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createAgentSession,
  createBashTool,
  createCodingTools,
  createReadOnlyTools,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import {
  auditBashCommand,
  createWorkspaceBashHook,
  guardPathTool,
  isPathWithinWorkspace,
  normalizeBashPath,
  toToolDefinition,
} from './workspaceGuard.js'

const WS = path.resolve('C:\\Users\\kaijia\\codes\\github\\workflows\\apps\\demo')

describe('isPathWithinWorkspace', () => {
  it('工作区内路径全部放行', () => {
    expect(isPathWithinWorkspace(WS, WS)).toBe(true)
    expect(isPathWithinWorkspace(WS, path.join(WS, 'src', 'index.ts'))).toBe(true)
    expect(isPathWithinWorkspace(WS, path.join(WS, '..', 'demo', 'x.txt'))).toBe(true)
  })

  it('工作区外路径全部拦截', () => {
    expect(isPathWithinWorkspace(WS, path.join(WS, '..'))).toBe(false)
    expect(isPathWithinWorkspace(WS, path.join(WS, '..', 'other', 'x.txt'))).toBe(false)
    expect(isPathWithinWorkspace(WS, 'C:\\Users\\kaijia\\secret.txt')).toBe(false)
  })

  it('Windows 路径大小写不敏感', () => {
    const lower = WS.toLowerCase()
    expect(isPathWithinWorkspace(lower, WS)).toBe(true)
    expect(isPathWithinWorkspace(WS, lower)).toBe(true)
  })
})

describe('normalizeBashPath', () => {
  it('~ 展开为 HOME', () => {
    const home = process.env.HOME ?? process.env.USERPROFILE
    expect(home).toBeTruthy()
    expect(normalizeBashPath('~')).toBe(home)
    expect(normalizeBashPath('~/x/y')).toBe(path.join(home!, 'x', 'y'))
  })

  it('/tmp 映射到系统临时目录', () => {
    const tmp = normalizeBashPath('/tmp')
    expect(tmp).toBeTruthy()
    expect(normalizeBashPath('/tmp/out.txt')).toBe(path.join(tmp!, 'out.txt'))
  })

  it('win32 下 /c/ 盘符形式转换为 Windows 路径', () => {
    if (process.platform === 'win32') {
      expect(normalizeBashPath('/c/Users/kaijia/a.txt')).toBe('C:\\Users\\kaijia\\a.txt')
      expect(normalizeBashPath('/d/dev/proj')).toBe('D:\\dev\\proj')
      // msys 根路径无法映射 → null(按越界处理)
      expect(normalizeBashPath('/etc/passwd')).toBeNull()
      expect(normalizeBashPath('/proc/cpuinfo')).toBeNull()
    }
  })

  it('相对路径与 Windows 路径原样返回', () => {
    expect(normalizeBashPath('./src/a.ts')).toBe('./src/a.ts')
    expect(normalizeBashPath('src/a.ts')).toBe('src/a.ts')
    expect(normalizeBashPath('C:/Users/kaijia/a.txt')).toBe('C:/Users/kaijia/a.txt')
  })
})

describe('auditBashCommand:放行场景', () => {
  it('无路径参数的普通命令', () => {
    for (const cmd of ['ls', 'git status', 'echo hello world', 'pnpm install', 'npm run build']) {
      expect(auditBashCommand(cmd, WS), cmd).toEqual([])
    }
  })

  it('设备文件(/dev/null 等)与 /dev/fd 放行', () => {
    for (const cmd of [
      'ls > /dev/null',
      'echo hi 2>/dev/null',
      'cat /dev/urandom | head -c 16',
      'cat < /dev/zero',
      'echo ok > /dev/fd/1',
      'dd if=/dev/urandom of=/dev/null bs=1 count=1',
    ]) {
      expect(auditBashCommand(cmd, WS), cmd).toEqual([])
    }
  })

  it('临时目录(/tmp、$TEMP)放行', () => {
    expect(auditBashCommand('echo hi > /tmp/out.txt', WS)).toEqual([])
    expect(auditBashCommand('cat /tmp/out.txt', WS)).toEqual([])
    expect(auditBashCommand('ls /tmp | head', WS)).toEqual([])
    expect(auditBashCommand('dd if=/dev/zero of=/tmp/rnd.bin bs=1M count=1', WS)).toEqual([])
    if (process.platform === 'win32' && process.env.TEMP) {
      expect(auditBashCommand('echo hi > "$TEMP/out.log"', WS)).toEqual([])
      expect(auditBashCommand('echo hi > "$TMP/out.log"', WS)).toEqual([])
    }
  })

  it('工作区内的相对路径参数与重定向', () => {
    expect(auditBashCommand('cat src/index.ts', WS)).toEqual([])
    expect(auditBashCommand('cat ./src/index.ts && echo done', WS)).toEqual([])
    expect(auditBashCommand('echo hi > out.txt', WS)).toEqual([])
    expect(auditBashCommand('cat < input.txt', WS)).toEqual([])
    expect(auditBashCommand('cat <<EOF\nbody\nEOF', WS)).toEqual([])
    expect(auditBashCommand('rm -rf node_modules dist', WS)).toEqual([])
    expect(auditBashCommand('cd apps && ls', WS)).toEqual([])
    expect(auditBashCommand('grep -rn "TODO" src', WS)).toEqual([])
    expect(auditBashCommand('FOO=bar echo $FOO', WS)).toEqual([])
    expect(auditBashCommand('git diff src/index.ts', WS)).toEqual([])
  })
})

describe('auditBashCommand:拦截场景', () => {
  it('临时目录内的相对逃逸仍拦截(resolve 后判定)', () => {
    expect(auditBashCommand('echo x > /tmp/../../secret.txt', WS).length).toBeGreaterThan(0)
  })

  it('/dev/tcp 等网络伪设备不放行', () => {
    expect(auditBashCommand('cat < /dev/tcp/example.com/80', WS).length).toBeGreaterThan(0)
  })

  it('绝对路径越界(msys 根 / 盘符 / Windows 路径)', () => {
    expect(auditBashCommand('cat /etc/passwd', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('cat /proc/cpuinfo', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('cat /c/Users/kaijia/secret.txt', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('cat C:/Users/kaijia/secret.txt', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('cat C:\\Users\\kaijia\\secret.txt', WS).length).toBeGreaterThan(0)
  })

  it('重定向越界', () => {
    expect(auditBashCommand('echo hi >> ../outside.log', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('cat <<EOF > /etc/x\nbody\nEOF', WS).length).toBeGreaterThan(0)
  })

  it('相对路径逃逸(..)', () => {
    expect(auditBashCommand('rm -rf ../../foo', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('cp src/a.ts ../outside/', WS).length).toBeGreaterThan(0)
  })

  it('cd 到工作区外', () => {
    expect(auditBashCommand('cd /etc && ls', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('cd ~/Downloads', WS).length).toBeGreaterThan(0)
  })

  it('~ 展开后越界', () => {
    expect(auditBashCommand('cat ~/.ssh/id_rsa', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('ls ~', WS).length).toBeGreaterThan(0)
  })

  it('双引号内展开后越界', () => {
    expect(auditBashCommand('cat "$HOME/x/y"', WS).length).toBeGreaterThan(0)
  })

  it('赋值常量传播($VAR=越界路径)', () => {
    expect(auditBashCommand('FOO=/etc/x cat $FOO', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('FOO=/etc/x cat "$FOO/file"', WS).length).toBeGreaterThan(0)
  })

  it('嵌套命令替换中的越界访问', () => {
    expect(auditBashCommand('cat $(cat /etc/x)', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('echo x > "$(dirname /etc/y)/out"', WS).length).toBeGreaterThan(0)
  })

  it('未知动态展开无法验证 → 拒绝', () => {
    expect(auditBashCommand('cat "$UNKNOWN_VAR/file"', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('echo x > "$UNDEFINED_DIR/out"', WS).length).toBeGreaterThan(0)
  })

  it('解析失败 → 拒绝', () => {
    expect(auditBashCommand('if fi', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('echo "unclosed', WS).length).toBeGreaterThan(0)
  })

  it('dd 的 if=/of= 形式(源越界拦截,合法源放行)', () => {
    expect(auditBashCommand('dd if=/etc/passwd of=out.bin bs=1M count=1', WS).length).toBeGreaterThan(0)
    expect(auditBashCommand('dd if=/dev/urandom of=/tmp/rnd.bin bs=1M count=1', WS)).toEqual([])
  })
})

describe('guardPathTool', () => {
  type Exec = (toolCallId: string, params: { path?: string }) => Promise<unknown>

  function makeDef(): { def: ToolDefinition; executed: string[] } {
    const executed: string[] = []
    const def = {
      name: 'read',
      label: 'read',
      description: 'read a file',
      parameters: {},
      execute: async (_toolCallId: string, params: { path?: string }) => {
        executed.push(params.path ?? '')
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    } as unknown as ToolDefinition
    return { def, executed }
  }

  function callExecute(def: ToolDefinition, params: { path?: string }): Promise<unknown> {
    return (def.execute as unknown as Exec)( 'id', params)
  }

  it('工作区内路径放行,原 execute 执行', async () => {
    const { def, executed } = makeDef()
    guardPathTool(def, WS)
    const result = await callExecute(def, { path: path.join(WS, 'src', 'a.ts') })
    expect(executed).toEqual([path.join(WS, 'src', 'a.ts')])
    expect((result as { content: unknown }).content).toBeTruthy()
  })

  it('工作区外路径拦截,原 execute 不执行', async () => {
    const { def, executed } = makeDef()
    guardPathTool(def, WS)
    await expect(callExecute(def, { path: 'C:\\Users\\kaijia\\secret.txt' })).rejects.toThrow(/工作区边界拦截/)
    expect(executed).toEqual([])
  })

  it('相对路径基于工作区解析', async () => {
    const { def, executed } = makeDef()
    guardPathTool(def, WS)
    await expect(callExecute(def, { path: '../outside.txt' })).rejects.toThrow(/工作区边界拦截/)
    await callExecute(def, { path: './src/a.ts' })
    expect(executed).toEqual(['./src/a.ts'])
  })

  it('path 缺失或为空时不拦截', async () => {
    const { def, executed } = makeDef()
    guardPathTool(def, WS)
    await callExecute(def, {})
    expect(executed).toEqual([''])
  })
})

describe('真实 AgentSession 集成', () => {
  const tempDirs: string[] = []
  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'wf-guard-it-'))
    tempDirs.push(dir)
    return dir
  }

  afterAll(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('customTools 同名覆盖内置工具,守卫生效', async () => {
    const wsPath = tempDir()
    const agentDir = tempDir()
    const guarded = [
      ...createCodingTools(wsPath)
        .filter((t) => t.name !== 'bash')
        .map((t) => guardPathTool(toToolDefinition(t), wsPath)),
      toToolDefinition(createBashTool(wsPath, { spawnHook: createWorkspaceBashHook(wsPath) })),
    ]
    const { session } = await createAgentSession({
      cwd: wsPath,
      agentDir,
      sessionManager: SessionManager.inMemory(wsPath),
      customTools: guarded,
    })

    expect(session.getActiveToolNames().sort()).toEqual(['bash', 'edit', 'read', 'write'])

    // bash 越界命令 → spawnHook 拦截(直接调用时抛错;agent loop 中会转为错误结果)
    const bashDef = session.getToolDefinition('bash')!
    await expect(
      bashDef.execute('id1', { command: 'cat /etc/passwd' }, undefined, undefined, undefined as never),
    ).rejects.toThrow(/工作区边界拦截/)

    // read 越界参数 → 拦截
    const readDef = session.getToolDefinition('read')!
    await expect(
      readDef.execute('id2', { path: 'C:\\Users\\kaijia\\secret.txt' }, undefined, undefined, undefined as never),
    ).rejects.toThrow(/工作区边界拦截/)

    // read 工作区内相对路径 → 放行
    writeFileSync(path.join(wsPath, 'inside.txt'), 'hi')
    const result = (await readDef.execute('id3', { path: 'inside.txt' }, undefined, undefined, undefined as never)) as {
      isError?: boolean
    }
    expect(result.isError ?? false).toBe(false)
  })

  it('只读工作区工具集带守卫', async () => {
    const wsPath = tempDir()
    const agentDir = tempDir()
    const { session } = await createAgentSession({
      cwd: wsPath,
      agentDir,
      sessionManager: SessionManager.inMemory(wsPath),
      tools: ['read', 'grep', 'find', 'ls'],
      customTools: createReadOnlyTools(wsPath).map((t) => guardPathTool(toToolDefinition(t), wsPath)),
    })

    expect(session.getActiveToolNames().sort()).toEqual(['find', 'grep', 'ls', 'read'])

    const readDef = session.getToolDefinition('read')!
    await expect(
      readDef.execute('id4', { path: 'C:\\Users\\kaijia\\secret.txt' }, undefined, undefined, undefined as never),
    ).rejects.toThrow(/工作区边界拦截/)
  })
})
