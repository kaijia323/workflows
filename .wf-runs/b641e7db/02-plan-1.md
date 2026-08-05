# 实施计划:McpPanel「编辑已有 MCP server」功能

> 依据:`.wf-runs/b641e7db/01-exploration-1.md`(设计判断全部遵循,无偏离)
> 代码基线:已核实 `McpPanel.vue` / `McpPanel.test.ts` / `useAgent.ts`(saveMcpServer upsert + 内部 refreshMcp)/ `packages/shared`(McpServerConfig)
> 前置结论:后端 PUT 已是覆盖语义、`saveMcpServer` 已支持编辑场景 → **后端、useAgent.ts、shared 零改动**

---

## 1. 目标与范围

### 做什么
1. `apps/web/src/components/McpPanel.vue`:列表条目新增「编辑」入口;复用现有表单做「回填 → 覆盖保存」,`name` 只读,`enabled` 透传原值。
2. `apps/web/src/components/McpPanel.test.ts`:新增编辑场景测试(9 条核心 + 2 条补充),扩展测试 helper。

### 不做什么
- ❌ 不改后端(`apps/api/src/agent/routes.ts`、`mcpConfig.ts`)
- ❌ 不改 `apps/web/src/composables/useAgent.ts`(saveMcpServer 已满足:PUT upsert、env 透传、内部 refreshMcp)
- ❌ 不改 `packages/shared/src/index.ts`、`ApiKeyModal.vue`
- ❌ 不做「改名」(编辑态 name 只读,改名=删除+新增,复杂度不值得,见探索报告 §6.3)
- ❌ 不做「空 env 清空语义」之外的任何数据迁移

---

## 2. 实施步骤

### 步骤 1:McpPanel.vue — script 部分(状态与函数)

文件:`apps/web/src/components/McpPanel.vue`

**(1a) 新增 import**(现有 import 区,`import type { AgentStore }` 之后):

```ts
import { Pencil } from '@lucide/vue'   // 编辑按钮图标;若 1.x 无 Pencil,回退 PenLine/SquarePen
```

**(1b) 新增 `envToText`**(放在 `envSummary` 函数之后,与 `parseEnvText` 对称):

```ts
/**
 * env 对象 → 每行 KEY=VALUE(parseEnvText 的逆;值含空格/「=」均原样保留,往返一致)。
 * 已知边界(可接受,与 parseEnvText 的 line.trim() 对称):值行首尾空白、键行尾空白
 * 回填后再保存会被 trim 归一化;均为罕见脏数据。
 */
function envToText(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
}
```

**(1c) 新增状态**(`saved` ref 之后):

```ts
/** 当前编辑中的 server name;null = 新增态 */
const editingName = ref<string | null>(null)
```

**(1d) 新增 `resetForm` 共用复位函数**(`handleAdd` 附近):

```ts
/** 复位表单全部输入与提示(新增/取消/编辑切换/编辑保存成功共用) */
function resetForm(): void {
  nameInput.value = ''
  commandInput.value = ''
  argsInput.value = ''
  envInput.value = ''
  envError.value = null
  error.value = null
  saved.value = false
}
```

**(1e) 新增 `startEdit` / `cancelEdit`**:

```ts
/** 进入编辑:回填表单(name 只读);编辑中切换目标先复位再进入 */
function startEdit(server: McpServerConfig): void {
  resetForm()
  editingName.value = server.name
  nameInput.value = server.name
  commandInput.value = server.command
  argsInput.value = (server.args ?? []).join(' ')
  envInput.value = envToText(server.env)
  // 不触碰 testResults:该 server 的测试结果区保持原样(可选后续清空,本轮不做)
}

/** 取消编辑:回到新增态并清空表单 */
function cancelEdit(): void {
  editingName.value = null
  resetForm()
}
```

**(1f) `handleAdd` → 改造为 `handleSave`**(签名与模板 `@submit` 同步改):

```ts
/** 保存(新增/编辑共用):新增 enabled:false;编辑透传原 enabled;成功后清空表单并自动测试 */
async function handleSave(): Promise<void> {
  const name = nameInput.value.trim()
  const command = commandInput.value.trim()
  if (!name || !command || saving.value) return
  // env 前端校验:非法行整体拦截,不发起请求(与现 handleAdd 一致)
  const parsed = parseEnvText(envInput.value)
  if (parsed.error) { envError.value = parsed.error; return }
  saving.value = true
  error.value = null
  envError.value = null
  saved.value = false
  try {
    const args = argsInput.value.trim() === '' ? [] : argsInput.value.trim().split(/\s+/)
    // 空 env 传 undefined:useAgent 的 JSON.stringify 自动省略该键,磁盘不写出 "env": {}
    const env = Object.keys(parsed.env).length > 0 ? parsed.env : undefined
    const editing = editingName.value
    // ★ 关键:编辑态 enabled 透传原值(绝不复用新增的 enabled:false,否则静默禁用已启用 server)
    const enabled = editing !== null
      ? (servers.value.find((s) => s.name === editing)?.enabled ?? false)
      : false
    await props.agent.saveMcpServer({ name: editing ?? name, command, args, enabled, env })
    resetForm()
    if (editing !== null) editingName.value = null
    saved.value = true
    void handleTest(editing ?? name)   // 保存后自动测试(新增/编辑一致;名称未变,可安全测试)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)   // 失败:保持当前 mode,表单不丢
  } finally {
    saving.value = false
  }
}
```

**预期结果**:新增态行为与现状完全一致(校验 → `enabled:false` → 保存 → 清空 → saved → 自动测试);编辑态走同一条链路但 `enabled` 透传原值、保存后 `editingName` 复位。

### 步骤 2:McpPanel.vue — 模板部分

**(2a) 列表条目「编辑」按钮**(v-for 条目内按钮区,「测试」按钮**之前**):

```html
<button
  type="button"
  class="flex items-center gap-1 rounded-sm border border-hairline px-2 py-0.5 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary"
  :data-testid="`edit-${server.name}`"
  @click="startEdit(server)"
>
  <Pencil class="size-3" />
  编辑
</button>
```
> 样式对齐现有「测试」按钮(hover 主色);icon 采用 lucide `<Pencil class="size-3" />`,与全项目 `<Plus class="size-3" />` 等惯例一致。`data-testid` 供测试精确按 name 定位(多 server 时避免按索引脆弱)。

**(2b) 表单标题**(`<form>` 之前新增一行;新增态/编辑态文案切换):

```html
<p class="mt-4 font-mono text-[10px] tracking-wider text-mute">
  {{ editingName ? `编辑 server: ${editingName}` : '添加外部 MCP server' }}
</p>
```

**(2c) name input 编辑态只读**:

```html
<input
  v-model="nameInput"
  :readonly="editingName !== null"
  :title="editingName !== null ? 'name 不可修改;如需改名请删除后重新添加' : undefined"
  :class="editingName !== null ? 'cursor-not-allowed opacity-60' : ''"
  spellcheck="false"
  placeholder="name(如 github)"
  class="w-full rounded-sm border border-hairline bg-canvas-soft px-3 py-2 font-mono text-xs text-ink placeholder:text-mute focus:border-primary"
>
```
> 用 `readonly`(非 `disabled`):保留焦点/复制,且不触发表单禁用样式;视觉弱化用条件 class。

**(2d) 表单提交处理**:`@submit.prevent="handleAdd"` → `@submit.prevent="handleSave"`。

**(2e) 按钮行**(底部提示文案 + 取消按钮 + 保存按钮文案联动):

```html
<div class="mt-3 flex items-center justify-between">
  <span class="font-mono text-[10px] text-mute">
    {{ editingName ? '编辑覆盖保存到 mcp.json' : '新增默认不启用(opt-in)' }}
  </span>
  <div class="flex items-center gap-2">
    <button
      v-if="editingName"
      type="button"
      data-testid="cancel-edit"
      class="rounded-sm border border-hairline px-4 py-1.5 font-display text-[11px] tracking-widest text-body hover:border-err/50 hover:text-err"
      @click="cancelEdit"
    >
      取消
    </button>
    <button
      type="submit"
      class="rounded-sm bg-primary px-4 py-1.5 font-display text-[11px] tracking-widest text-on-primary transition hover:bg-primary-soft disabled:opacity-40"
      :disabled="saving || !nameInput.trim() || !commandInput.trim()"
    >
      {{ saving ? (editingName ? '保存中…' : '添加中…') : (editingName ? '保存修改' : '添加并测试') }}
    </button>
  </div>
</div>
```

**预期结果**:编辑态下标题/按钮/提示三处文案联动;取消按钮仅编辑态出现;新增态视觉零变化(仅多一行标题)。

### 步骤 3:McpPanel.test.ts — 扩展 helper

文件:`apps/web/src/components/McpPanel.test.ts`

在 `fillBasic` 之后新增(不改动 `mountPanel` 签名,其已支持 `mcp: ref({servers, status})` 传入):

```ts
/** 构造 server 配置(测试工厂):name 必填,command 默认 'node' */
function makeServer(overrides: Partial<McpServerConfig> & { name: string }): McpServerConfig {
  return { name: overrides.name, command: 'node', args: [], enabled: false, ...overrides }
}

/** 点击指定 server 的「编辑」按钮(data-testid 精确定位) */
async function clickEdit(wrapper: ReturnType<typeof mountPanel>['wrapper'], name: string) {
  await wrapper.find(`[data-testid="edit-${name}"]`).trigger('click')
}

/**
 * 填表单内输入(避开列表里的 checkbox):
 * form 内 input 依次为 name[0]/command[1]/args[2];env 用唯一 textarea。
 * 编辑态 name 只读,不提供 name 参数。
 */
async function setForm(
  wrapper: ReturnType<typeof mountPanel>['wrapper'],
  values: { command?: string; args?: string; env?: string } = {},
) {
  const inputs = wrapper.find('form').findAll('input')
  if (values.command !== undefined) await inputs[1].setValue(values.command)
  if (values.args !== undefined) await inputs[2].setValue(values.args)
  if (values.env !== undefined) await wrapper.find('textarea').setValue(values.env)
}

/** 取表单提交按钮(按文本) */
function submitButton(wrapper: ReturnType<typeof mountPanel>['wrapper']) {
  return wrapper.findAll('button').find((b) => b.text().includes('添加') || b.text().includes('保存'))
}
```

> 注:现有 `fillBasic` 用 `wrapper.findAll('input')` 取前两个,在有 server 列表时会命中 checkbox,故编辑用例一律用 form 作用域内的 `setForm`。

### 步骤 4:McpPanel.test.ts — 新增编辑用例

新增 `describe('McpPanel 编辑已有 server')` 分组(核心 9 条 + 补充 2 条),每条均以 `mountPanel({ mcp: ref({ servers, status: [] }) })` + `await flushPromises()` 起步:

| # | 用例 | 操作 | 断言要点 |
|---|---|---|---|
| 1 | 编辑按钮渲染(补充) | servers=[s1,s2] 挂载;再挂空列表 | `[data-testid="edit-s1"]`/`edit-s2` 存在且文本含「编辑」;空列表无 `[data-testid^="edit-"]` |
| 2 | 回填 | servers=[{s1, command:'node', args:['-y','@x/y'], env:{A:'1'}}];clickEdit('s1') | form 内 inputs[0].value==='s1'、[1]==='node'、[2]==='-y @x/y';textarea.value==='A=1';文本含「编辑 server: s1」;提交按钮文本==='保存修改';提示「编辑覆盖保存到 mcp.json」;cancel-edit 存在 |
| 3 | env 往返 | server env={A:'1', GREETING:'hello world', URL:'https://x?a=1'};clickEdit;直接 submit | textarea.value==='A=1\nGREETING=hello world\nURL=https://x?a=1'(严格相等);saveMcpServer 收到 `env: {A:'1', GREETING:'hello world', URL:'https://x?a=1'}`(objectContaining 深比较) |
| 4 | 保存覆盖 + enabled 保留(★核心回归) | server {enabled:true, args:['old'], env:{OLD:'1'}};clickEdit;setForm command='python', args='new', env='NEW=2';submit | saveMcpServer 收到 objectContaining({name:'s1', command:'python', args:['new'], **enabled:true**, env:{NEW:'2'}});断言 enabled:true 防复用 `enabled:false` |
| 5 | 取消 | clickEdit;setForm env='X=1';click cancel-edit | 四个输入全空;提交按钮回「添加并测试」;提示回「新增默认不启用(opt-in)」;cancel-edit 消失;文本不含「已保存到 mcp.json」;无「编辑 server」标题 |
| 6 | 编辑态 name 只读 | clickEdit | form inputs[0] 有 `readonly` 属性(element.readOnly === true);value==='s1';setValue('renamed') 后 value 仍 's1' |
| 7 | 非法行拦截仍生效 | clickEdit;textarea='A=1\nBAD';submit | saveMcpServer **未**被调用;文本含「env 第 2 行缺少「=」」;仍在编辑态(submit 仍「保存修改」、cancel-edit 仍存在) |
| 8 | 编辑保存后退出编辑态 | clickEdit;submit(不改内容);flushPromises | 四个输入全空;submit 回「添加并测试」;cancel-edit 消失;文本含「已保存到 mcp.json」;无「编辑 server」标题 |
| 9 | 列表摘要不变 | server env={A:'1', B:'x y'};记录列表摘要;clickEdit 后改 textarea='C=3' | 列表始终含「env: A=1 B=x y」;条目 name/command 行文本不变(防 v-model 误绑 server 对象) |
| 10 | 切换编辑目标复位 | servers=[s1{env:{A:'1'}}, s2{command:'python', args:['-y'], env:{B:'2'}}];clickEdit('s1');再 clickEdit('s2') | inputs[0].value==='s2'、[1]==='python'、[2]==='-y';textarea.value==='B=2';标题「编辑 server: s2」;无 s1 残留 |
| 11 | 空 env 编辑保存(补充) | server 无 env;clickEdit;submit | textarea.value==='';saveMcpServer 收到 objectContaining({env: undefined})(空 env 不写盘约定保持) |

每条保存类用例后 `await flushPromises()`(handleSave 内 await saveMcpServer + void handleTest)。

**预期结果**:`pnpm vitest run src/components/McpPanel.test.ts` 下 6 条既有用例 + 11 条新用例全绿;既有用例不受按钮文案/标题新增影响(它们只 trigger submit,不按文本找按钮)。

### 步骤 5:全量验证

```bash
cd apps/web && pnpm test        # vitest run,全绿
cd apps/web && pnpm typecheck   # vue-tsc -b,通过
```

---

## 3. 状态机(新增 / 编辑 / 取消)伪代码

```
mode := 'add' | 'edit(name)'        // 实现:editingName: string | null

┌─ 初始: mode=add, 表单空, saved=false
│
├─ startEdit(server) ──────────────► mode=edit(server.name)
│     resetForm()                    // 复位输入 + envError/error/saved
│     nameInput=server.name          // name 只读
│     commandInput=server.command
│     argsInput=server.args.join(' ')
│     envInput=envToText(server.env)
│     (testResults 不动)
│
├─ [mode=edit(a)] startEdit(b) ────► mode=edit(b)   // 切换目标:先 resetForm 再回填 b(无残留)
│
├─ cancelEdit() ───────────────────► mode=add
│     editingName=null; resetForm()
│
├─ handleSave() 校验失败 ──────────► 保持当前 mode; envError=行号错误; 不发请求
│
├─ handleSave() 校验通过:
│     enabled = (mode=edit(name)) ? servers.find(name).enabled ?? false
│                                  : false                    // ★ 编辑透传原值
│     await saveMcpServer({ name: editingName ?? nameInput, command, args, enabled, env })
│         ├─ 成功 ──► resetForm(); editingName=null; saved=true;
│         │           void handleTest(name)                   // 自动测试(新增/编辑一致)
│         │           ──► mode=add
│         └─ 失败 ──► error=消息; 保持当前 mode, 表单不丢
```

不变量:
- `editingName !== null` ⇔ 表单处于编辑态(标题/按钮/取消/hint 联动,`v-if="editingName"` 驱动)。
- 编辑态 `nameInput` 恒等于 `editingName`(只读回填,保存以 `editingName` 为准,双保险)。
- 任何离开编辑态路径(取消/保存成功/切换)都先 `resetForm()`,保证无残留。

---

## 4. envToText 定义(与 parseEnvText 严格互逆)

```ts
/** env 对象 → 每行 KEY=VALUE(parseEnvText 的逆;值含空格/「=」均原样保留,往返一致) */
function envToText(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
}
```

往返正确性论证:
- `parseEnvText` 按**第一个** `=` 切分(`line.indexOf('=')`)、value 取右侧**原样保留**(含空格与 `=`)、行整体 trim。
- `envToText` 输出 `k=v` 每行一个,无额外空白 → parse 后 key/value 与源对象逐字一致。
- 测试用例 #3 直接锁定该往返(值含空格 `hello world`、含 `=` 的 URL)。
- 已知边界(写注释,不处理):值行首尾空白、键行尾空白会被 parse 的 `line.trim()` 归一化(罕见脏数据)。
- args 往返:`args.join(' ')` ↔ `split(/\s+/)`,含空格的单参数无法往返(新增/编辑共用同一语义,已知限制,可接受)。

---

## 5. 验收标准(可逐条核对)

- [ ] 列表每条目按钮区出现「编辑」按钮(icon + 文案,位于「测试」左侧,样式/hover 与「测试」对齐)
- [ ] 点击「编辑」:name/command/args/env 正确回填;name input `readonly` 且弱化样式、title 提示「name 不可修改…」
- [ ] 编辑态表单标题「编辑 server: X」、提交按钮「保存修改」、提示「编辑覆盖保存到 mcp.json」、「取消」按钮可见;新增态三者均复原
- [ ] 编辑态保存:`saveMcpServer` 以同 name 调用,`enabled` **透传原值**(true 保持 true,绝不变成 false),新 command/args/env 覆盖
- [ ] env 含空格/含 `=` 的条目:回填文本逐字还原,保存后 `saveMcpServer` 收到语义相同的 env 对象
- [ ] 编辑保存成功:表单清空、退出编辑态(标题/按钮/取消复原)、显示「已保存到 mcp.json」、自动测试
- [ ] 取消:表单清空、退出编辑态、无 saved 残留
- [ ] 编辑中切换另一条目:表单先复位再回填新目标,无旧值残留
- [ ] 编辑态 env 非法行仍零容忍拦截(不发起请求、显示行号)
- [ ] 新增态行为与改动前完全一致(含 `enabled: false`、保存后清空、自动测试);列表 env 摘要行在编辑过程中不变
- [ ] 后端 / `useAgent.ts` / `packages/shared` / `ApiKeyModal.vue` 零改动
- [ ] `cd apps/web && pnpm test` 全绿(6 旧 + 11 新);`cd apps/web && pnpm typecheck` 通过

---

## 6. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 编辑保存误传 `enabled: false`(复用新增逻辑) | 已启用 server 被静默禁用 | 测试 #4 核心回归断言 `enabled:true`;`handleSave` 中 enabled 分支代码评审重点 |
| env 往返边界(值/键行首尾空白被 trim) | 罕见脏数据回填后再存被归一化 | 已知限制,`envToText` 注释声明,不处理 |
| 编辑保存后自动 `handleTest` 展开测试结果区 | 视觉噪音(非功能问题) | 与新增态行为一致,属预期;如产品不接受,删 `handleTest` 一行即可(标记为独立小改动) |
| `@lucide/vue` 1.x 无 `Pencil` 图标 | 构建失败 | 回退 `PenLine` / `SquarePen`(lucide 标准图标),或纯文本按钮(删 icon 元素) |
| `readonly` 不触发 `disabled:opacity-40` 样式 | 编辑态 name 不够「灰」 | 已用条件 class `opacity-60 cursor-not-allowed`,实施时目视确认 |
| 测试按文本找按钮脆弱 | 用例误判 | 编辑/取消按钮用 `data-testid` 定位;提交按钮文本唯一,`submitButton` helper 集中管理 |

**回滚方案**:
- 改动收敛于 2 个文件(`McpPanel.vue` + `McpPanel.test.ts`),无数据/迁移/接口变更。
- 任一步失败:`git checkout -- apps/web/src/components/McpPanel.vue apps/web/src/components/McpPanel.test.ts` 即完全还原。
- 中间态安全:模板与 script 改动同批提交;`handleSave` 改名与模板 `@submit` 引用必须同步(同一次编辑完成),避免中间提交出现 `handleAdd is not defined`。

---

## 7. 交付物清单

| 文件 | 动作 |
|---|---|
| `apps/web/src/components/McpPanel.vue` | 改:import Pencil;新增 `editingName`/`envToText`/`resetForm`/`startEdit`/`cancelEdit`;`handleAdd`→`handleSave`;模板(编辑按钮/表单标题/name 只读/取消按钮/文案联动) |
| `apps/web/src/components/McpPanel.test.ts` | 改:新增 `makeServer`/`clickEdit`/`setForm`/`submitButton` helper + `describe('McpPanel 编辑已有 server')` 11 条用例 |
| 其余全部 | 不改 |
