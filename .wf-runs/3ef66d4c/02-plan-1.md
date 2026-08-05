# 修复计划:MCP 状态显示异常 & 设置模态窗高度超出可视区

> 依据:.wf-runs/3ef66d4c/01-exploration-1.md(已核实关键代码:McpPanel.vue / ApiKeyModal.vue / SubAgentModal.vue / routes.ts / useAgent.ts / mcpTools.ts / mcpRoutes.test.ts / packages/shared/src/index.ts)

---

## 0. 目标与范围

### 做什么

1. **修复 1(MCP 状态显示)**:前端 McpPanel 打开时自动刷新状态 + 提供手动刷新按钮;后端将「已配置但从未尝试连接」从 `error` 态(红色「异常:尚未连接…」)改为独立中性状态 `not_connected`,与真正的「连接失败」区分开。
2. **修复 2(模态窗高度)**:ApiKeyModal 参照 SubAgentModal 的 `max-h-[85vh]` 模式,内层加 `max-h` + `overflow-y-auto`,外层加 `overflow-y-auto p-6` 兜底。

### 不做什么(边界)

- **不改连接生命周期**:不触发 GET 接口被动连接(页面打开会 spawn 一堆 MCP 子进程,成本高,探索报告已论证);不改变「配置变更后需新建会话生效」的设计语义。
- **不改 `McpManager` 状态机**(mcpTools.ts 的 `McpEntry.state` 独立联合类型,维持 `connecting/connected/error` 不动)。
- **不做轮询**:onMounted 刷新 + 手动刷新按钮已覆盖主要场景;轮询会带来模态窗关闭后的后台请求与生命周期管理,属过度设计,不做。
- **不重构 ApiKeyModal 布局**:不做 flex-col + header 常驻(顶部固定)的改造,保持最小改动。
- **不动无关代码**:不改 useAgent.ts、piService.ts、subAgent.ts、App.vue、其他组件。

---

## 1. 修复 1:McP 状态显示

### 1.1 前端 `apps/web/src/components/McpPanel.vue`(必做,主修复)

**改动点 A — script 区**:

1. 第 1 行 import 增加 `onMounted`:`import { computed, onMounted, ref } from 'vue'`。
2. 新增状态与函数(放在 `saved` ref 附近):

```ts
/** 手动刷新中(防重复点击) */
const refreshing = ref(false)

/** 打开面板(模态窗)即拉最新状态;失败静默,与 init() 行为一致 */
onMounted(() => {
  void props.agent.refreshMcp().catch(() => {})
})

/** 手动刷新:失败在面板底部展示错误 */
async function handleRefresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  error.value = null
  try {
    await props.agent.refreshMcp()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    refreshing.value = false
  }
}
```

3. `statusLabel` switch 增加一个 case(放在 `connecting` 之后、`error` 之前):

```ts
case 'not_connected':
  return '未连接 · 新建会话后自动连接'
```

4. `statusClass` 增加一个分支(与 `connecting` 同样式):

```ts
if (state === 'not_connected') return 'text-mute'
```

> 注意:现有 `statusOf()` 的 fallback 是 `{ state: 'disabled', toolCount: 0 }`,`statusLabel`/`statusClass` 均有 default 兜底,新状态不会破坏既有渲染路径。

**改动点 B — template 区**:

5. 标题行「MCP · 外部工具」改为 flex 布局,右侧加刷新按钮(样式复用现有「测试/删除」小按钮的 class 模式):

```html
<div class="mt-6 flex items-center justify-between border-t border-hairline pt-4">
  <p class="font-mono text-[10px] tracking-wider text-mute">MCP · 外部工具</p>
  <button
    type="button"
    class="rounded-sm border border-hairline px-2 py-0.5 font-mono text-[10px] text-body hover:border-primary/50 hover:text-primary disabled:opacity-40"
    :disabled="refreshing"
    @click="handleRefresh"
  >
    {{ refreshing ? '刷新中…' : '刷新' }}
  </button>
</div>
```

**预期结果**:模态窗打开即显示最新状态;会话建立后重新打开面板直接显示「已连接 · N 工具」;状态过期时用户可手动刷新。

### 1.2 共享类型 `packages/shared/src/index.ts`(必做,后端改动的前置)

`McpServerStatus` 接口(约 L98-108)的 `state` 联合类型增加 `'not_connected'`:

```ts
/** connecting:连接建立中(ensureEntry 后的初始态,不误报 connected);not_connected:已配置但从未尝试连接(路由推导层) */
state: 'disabled' | 'connecting' | 'connected' | 'error' | 'not_connected'
```

**影响面已排查,安全**:

- `apps/api/src/pi/mcpTools.ts` 的 `McpEntry.state` 是独立声明的字面量联合 `'connected' | 'connecting' | 'error'`,是扩展后联合类型的子集;`status()` 的 `out.push({ ..., state: entry.state, ... })` 类型兼容,**无需改动 mcpTools.ts**。
- `apps/web/src/components/McpPanel.vue` 的 `statusLabel`/`statusClass` 有 default 兜底(见 1.1)。
- 全仓仅 McpPanel.vue 消费 `McpServerStatus.state`(DagPanel 的 `state` 是独立类型),无其他穷尽 switch。

### 1.3 后端 `apps/api/src/agent/routes.ts`(必做)

`mcpOverview()`(L69-81)推导分支改为:

```ts
// 其余由配置推导:disabled 或 not_connected(已启用但从未尝试连接,中性提示,非错误态)
function mcpOverview(): { servers: McpServerConfig[]; status: McpServerStatus[] } {
  const servers = loadMcpServers(store)
  const statusByName = new Map(pi.getMcpStatus().map((s) => [s.name, s]))
  const status: McpServerStatus[] = servers.map((server) => {
    const existing = statusByName.get(server.name)
    if (existing) return existing
    return {
      name: server.name,
      state: server.enabled === true ? 'not_connected' : 'disabled',
      error: undefined,
      toolCount: 0,
      lastCheckedAt: null,
    }
  })
  return { servers, status }
}
```

要点:

- `state` 从 `'error'` 改为 `'not_connected'`(仅 enabled server);`error` 不再填「尚未连接(配置变更后需新建会话/重开工作区生效)」——该文案误导性强(渲染为红色「异常:」),且「未尝试」不是错误。
- **真正的连接失败**仍由 manager 状态输出 `state: 'error'` + 具体 `error` 文案(如超时/spawn 失败),此路径不动。

### 1.4 测试更新(必做)

**`apps/api/src/agent/mcpRoutes.test.ts`** — 加强「PUT 新增」用例(约 L71-89)的 status 断言,验证新推导语义:

```ts
// 原:expect(data.status).toHaveLength(1)
expect(data.status).toHaveLength(1)
expect(data.status[0]).toMatchObject({ name: 'echo', state: 'not_connected', toolCount: 0 })
expect(data.status[0].error).toBeUndefined()
```

其余用例(PUT 覆盖/DELETE/400 校验/test)不受影响,无需改动。

**可选(不强制)**:新增 `apps/web/src/components/McpPanel.test.ts` 组件测试:mock fetch 的 `/api/agent/mcp` GET,用 `@vue/test-utils` mount(传 stub AgentStore),断言 (a) onMounted 后 fetch 被调用(打开即刷新);(b) 点击「刷新」按钮再次触发 fetch;(c) `not_connected` 状态渲染为「未连接 · 新建会话后自动连接」而非「异常」。仓库已有 @vue/test-utils + jsdom 测试先例(App.test.ts),成本低。

---

## 2. 修复 2:设置模态窗高度超出可视区

### 2.1 `apps/web/src/components/ApiKeyModal.vue`(必做,仅改模板 class,零逻辑改动)

**改动点 A — 外层遮罩(L57-59)**:加 `overflow-y-auto p-6`(兜底:即使内层 max-h 在极端情况失效,遮罩本身可滚动):

```html
<!-- 改前 -->
<div class="fixed inset-0 z-50 grid place-items-center bg-canvas/80 backdrop-blur-sm"
     @click.self="emit('close')">
<!-- 改后 -->
<div class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-canvas/80 p-6 backdrop-blur-sm"
     @click.self="emit('close')">
```

> `@click.self` 行为不变:点击 padding 区域 target 仍是外层自身,照常关闭;内层盒子滚动条在自身内部,不影响关闭逻辑。

**改动点 B — 内层盒子(L60)**:加 `max-h-[85vh]` + `overflow-y-auto`(与 SubAgentModal.vue 的 `max-h-[85vh]` 模式一致;max-height 与 overflow 成对出现,缺一不可):

```html
<!-- 改前 -->
<div class="w-full max-w-md rounded-md border border-hairline bg-canvas p-6 shadow-modal">
<!-- 改后 -->
<div class="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-md border border-hairline bg-canvas p-6 shadow-modal">
```

**预期结果**:内容超高时盒子在 85vh 内整体滚动,顶部标题与关闭按钮可滚回;小视口下外层 p-6 保证上下留白。

**可选测试(不强制)**:新增 `apps/web/src/components/ApiKeyModal.test.ts`,mount 后断言内外两层 div 的 class 含 `max-h-[85vh]`/`overflow-y-auto`(jsdom 无法验证真实布局,仅作 class 契约回归保护)。

---

## 3. 改动文件清单(汇总)

| 文件 | 改动性质 | 内容 |
|---|---|---|
| `apps/web/src/components/McpPanel.vue` | 改 | onMounted 刷新、刷新按钮、not_connected 文案/样式 |
| `apps/web/src/components/ApiKeyModal.vue` | 改 | 外层 + `overflow-y-auto p-6`;内层 + `max-h-[85vh] overflow-y-auto` |
| `packages/shared/src/index.ts` | 改 | `McpServerStatus.state` 联合类型 + `'not_connected'` |
| `apps/api/src/agent/routes.ts` | 改 | mcpOverview 推导分支:error→not_connected,error 文案删除 |
| `apps/api/src/agent/mcpRoutes.test.ts` | 改 | 加强 PUT 新增用例的 status 断言 |
| `apps/web/src/components/McpPanel.test.ts`(可选) | 新增 | 打开即刷新/刷新按钮/not_connected 文案 |
| `apps/web/src/components/ApiKeyModal.test.ts`(可选) | 新增 | class 契约断言 |

**明确不动的文件**:`apps/api/src/pi/mcpTools.ts`、`apps/api/src/pi/piService.ts`、`apps/api/src/pi/subAgent.ts`、`apps/web/src/composables/useAgent.ts`、`apps/web/src/App.vue`、`apps/web/src/components/SubAgentModal.vue`、`apps/api/src/mcpConfig.ts`。

---

## 4. 验证方式

### 4.1 自动化

```bash
# 类型检查 + lint + 单测(api 与 web 各跑一遍;或根目录 turbo 全量)
pnpm --filter @workflows/api typecheck && pnpm --filter @workflows/api lint && pnpm --filter @workflows/api test
pnpm --filter @workflows/web typecheck && pnpm --filter @workflows/web lint && pnpm --filter @workflows/web test
```

重点关注:

- `mcpRoutes.test.ts` 新断言通过(not_connected 推导)。
- api 侧 `mcpTools.test.ts` 全绿(manager 状态机未动,应为零变化)。
- web 侧 `useAgent.test.ts` / `App.test.ts` 全绿(refreshMcp 行为未改)。

### 4.2 手动验证(dev 环境:`pnpm dev` 起前后端)

**修复 1 场景**:

1. 打开设置模态窗 → MCP section 显示 server 列表。
2. 新增一个真实 server(如 `npx -y @modelcontextprotocol/server-filesystem /tmp`)→ 保存后状态显示**「未连接 · 新建会话后自动连接」**(中性灰,不再是红色「异常:尚未连接…」)。
3. 关闭模态窗,发起一次会话(触发懒连接)→ 重新打开模态窗 → 状态**自动**显示「已连接 · N 工具」(验证 onMounted 刷新)。
4. 打开模态窗保持不动,在另一操作触发连接变化后点「刷新」按钮 → 状态更新(验证手动刷新;按钮短暂显示「刷新中…」)。
5. 配置一个不存在命令的 server(如 `no-such-binary`)→ 点「测试」或新建会话 → 状态显示**红色「异常:<真实错误文案>」**(验证真正的连接失败仍走 error 态)。
6. 未启用 server 显示「未启用」;删除/启用开关/测试按钮均正常。

**修复 2 场景**:

7. 浏览器窗口高度缩到 ~700px(或笔记本小屏)打开设置模态窗 → 模态窗不超出视口,顶部标题「连接 · CONNECT」与关闭按钮可见可达,内容在盒内滚动。
8. 高度正常的窗口下打开 → 外观与行为无变化(不出现多余滚动条)。
9. 滚动模态窗内容后点击遮罩空白 → 仍正常关闭。

---

## 5. 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| 共享类型 `state` 扩展破坏其他消费方 | 低 | 已全仓排查:仅 McpPanel 消费;mcpTools 内部独立类型为子集,类型兼容;前端 switch 有 default 兜底 |
| 后端文案/状态语义变化破坏既有测试 | 低 | 已 grep 确认无测试断言「尚未连接」文案;mcpRoutes.test.ts 原断言仅 `toHaveLength(1)`,加强后仍兼容 |
| 前端 onMounted 刷新失败导致面板异常 | 低 | 刷新失败静默(catch 空),与 init() 现有行为一致;不影响聊天 |
| 手动刷新与表单错误共用 `error` ref 的显示位置 | 低 | 刷新失败显示在面板底部错误行,与保存/删除错误同位置,语义一致 |
| 模态窗滚动样式回归(如滚动条可见性) | 低 | 仅 class 改动,无逻辑;参照仓库既有 SubAgentModal 模式,回滚只需还原两行 class |

**回滚方案**:

- 每个文件改动相互独立、均为局部小改:任一处出问题可单独 `git checkout -- <file>` 还原。
- 若 `not_connected` 状态引入连锁问题,可仅还原 `packages/shared/src/index.ts` + `routes.ts`(后端部分),保留前端 onMounted 刷新/刷新按钮(纯增量,无依赖)。
- 若有提交,整体回滚为 `git revert <commit>`。

---

## 6. 验收清单(逐条核对)

- [ ] `McpPanel.vue` 挂载(onMounted)时自动调用 `refreshMcp()` 拉取最新状态
- [ ] MCP 面板标题行有「刷新」按钮,点击触发 `refreshMcp()`,刷新中禁用并显示「刷新中…」
- [ ] `packages/shared` 的 `McpServerStatus.state` 类型含 `'not_connected'`
- [ ] `routes.ts` `mcpOverview()` 对 enabled 但从未连接的 server 返回 `state: 'not_connected'`、`error: undefined`;对 disabled 返回 `state: 'disabled'`;manager 已记录的连接状态(connected/connecting/error)原样透传
- [ ] 前端 `not_connected` 渲染为中性文案「未连接 · 新建会话后自动连接」,`text-mute` 灰色,非红色异常
- [ ] 真实连接失败仍渲染为红色「异常:<error>」
- [ ] `ApiKeyModal.vue` 内层盒子含 `max-h-[85vh]` 与 `overflow-y-auto`(成对);外层含 `overflow-y-auto p-6`
- [ ] 小视口(≈700px 高)打开设置模态窗:不溢出、内容可滚、顶部可达
- [ ] api 与 web 的 typecheck / lint / 全部单测通过;`mcpRoutes.test.ts` 新增断言通过
- [ ] 未触碰 mcpTools.ts / piService.ts / subAgent.ts / useAgent.ts / App.vue / SubAgentModal.vue(除 ApiKeyModal/McpPanel/shared/routes/测试外无其他文件改动)
