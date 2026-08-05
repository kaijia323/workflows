# 探索报告:MCP 工具状态显示异常 & 设置模态窗高度超出可视区

> 产物:.wf-runs/3ef66d4c/01-exploration-1.md
> 调研范围:apps/api(agent 路由 / pi 层 MCP 实现)、apps/web(设置模态窗)
> 性质:只读调研,未修改任何代码

---

## 0. 仓库概览

- **结构**:pnpm workspace 单仓库(turbo),`apps/api`(Hono + TypeScript 后端)、`apps/web`(Vue 3 + Tailwind CSS v4 + Vite)、`packages/shared`(共享类型)。
- **后端关键模块**:`apps/api/src/pi/piService.ts`(PiAgentService 单例,持有 `McpManager`)、`apps/api/src/pi/mcpTools.ts`(MCP client 实现)、`apps/api/src/mcpConfig.ts`(mcp.json 存储)、`apps/api/src/agent/routes.ts`(REST 路由)。
- **前端关键模块**:`apps/web/src/composables/useAgent.ts`(agent store)、`apps/web/src/components/ApiKeyModal.vue`(设置模态窗,俗称 SettingsModal,含 DeepSeek key / AnySearch key / MCP 面板三个 section)、`McpPanel.vue`(内嵌 MCP 管理面板)。
- **测试**:vitest(api 侧 `mcpTools.test.ts` 覆盖 status/缓存/dispose 语义;web 侧 `useAgent.test.ts` 覆盖 MCP actions)。

---

## 1. 问题 1:MCP 工具状态显示异常(context7 显示「尚未连接」但调用成功)

### 1.1 涉及文件与关键代码

| 文件 | 作用 |
|---|---|
| `apps/api/src/mcpConfig.ts` | mcp.json 配置读取/写入(`loadMcpServers` / `upsertMcpServer` / `removeMcpServer`) |
| `apps/api/src/pi/mcpTools.ts` | `McpManager`(连接缓存 + 状态机)、`StdioMcpConnection`、`createMcpTools` 工厂 |
| `apps/api/src/pi/piService.ts` | 持有单例 `McpManager`;`openSession()` 时构建工具集;`getMcpStatus()` / `disposeMcpServer()` |
| `apps/api/src/agent/routes.ts` | `mcpOverview()` 配置+状态合并推导;`PUT/DELETE /api/agent/mcp/:name`、`POST .../test` |
| `apps/web/src/composables/useAgent.ts` | `refreshMcp()` / `saveMcpServer()` / `deleteMcpServer()` |
| `apps/web/src/components/McpPanel.vue` | 状态徽标渲染(`statusLabel` / `statusOf`) |

### 1.2 配置来源:独立文件 mcp.json,非环境变量

- 配置只来自 `mcp.json`(dev 为 `<repo>/.workflows/mcp.json`,prod 为 `~/.workflows/mcp.json`),内容 `{ "mcpServers": [...] }`。
- `mcpConfig.ts:29` `mcpConfigPath(store) = path.join(store.root, 'mcp.json')`;`loadMcpServers` 容错读取(文件缺失/损坏 → `[]`)。
- 无环境变量注入 MCP 配置;`enabled === true` 是 opt-in 注册开关。

### 1.3 连接建立时机:会话创建时(懒连接),不是进程启动时,也不是配置保存时

- `piService.ts:275`(`openSession` 内,主代理会话创建):`const mcpTools = workspace.readOnly ? [] : await createMcpTools(this.mcp, mcpServers)`。
- `subAgent.ts:359`(子代理会话创建)同构:`createMcpTools(mcp, mcpServers)`,共享同一 `McpManager`。
- `createMcpTools`(`mcpTools.ts:483`)只对 `enabled === true` 的 server 调用 `manager.listTools()` → `ensureConn()` → `StdioMcpConnection.connect()`(spawn 子进程 + 10s 握手)。
- 此外 `callTool`(`mcpTools.ts` 的 `ensureConn`)在调用时若连接已断会**自动重连一次**——这是「状态显示未连接但调用成功」能成立的关键机制之一。
- PUT/DELETE 配置变更时 `routes.ts` 调用 `pi.disposeMcpServer(name)` → `manager.disposeServer(name)`:**断开连接 + 从 entries 缓存删除**(旧会话工具集不变,新会话生效)。

### 1.4 状态推导:status() 只统计「已尝试连接」的 server

`McpManager`(`mcpTools.ts` ~L452):

```ts
/** 运行时状态(前端面板);未配置的 server 不输出 */
status(): McpServerStatus[] {
  const out: McpServerStatus[] = []
  for (const [name, entry] of this.entries) {   // ← 只遍历 entries 缓存
    out.push({ name, state: entry.state, error: entry.error,
               toolCount: entry.tools?.length ?? 0, lastCheckedAt: entry.lastCheckedAt })
  }
  return out
}
```

- `entries` 只在 `ensureEntry`(首次 listTools/callTool 尝试)时写入;`disposeServer` 会删除条目。
- 状态机:`connecting`(ensureEntry 初始态)→ `connected` / `error`;**status() 是纯读,绝不触发连接**。
- 测试佐证(`mcpTools.test.ts`):「连接建立前 status 为 connecting」「disposeServer 后 `status()` 返回 `[]`」。

路由层合并推导(`routes.ts:69-81`):

```ts
function mcpOverview(): { servers: McpServerConfig[]; status: McpServerStatus[] } {
  const servers = loadMcpServers(store)
  const statusByName = new Map(pi.getMcpStatus().map((s) => [s.name, s]))
  const status: McpServerStatus[] = servers.map((server) => {
    const existing = statusByName.get(server.name)
    if (existing) return existing
    return {
      name: server.name,
      state: server.enabled === true ? 'error' : 'disabled',
      error: server.enabled === true
        ? '尚未连接(配置变更后需新建会话/重开工作区生效)' : undefined,
      toolCount: 0, lastCheckedAt: null,
    }
  })
  return { servers, status }
}
```

前端(`McpPanel.vue`):`statusLabel` 对 `error` 态渲染为「异常:尚未连接(配置变更后需新建会话/重开工作区生效)」。

### 1.5 根因:状态推导与实际可用性为何不一致

用户操作序列与代码行为对照:

1. **配置 context7**:`PUT /api/agent/mcp/context7` → `upsertMcpServer` 写 mcp.json → `disposeMcpServer('context7')` 把 manager 中该条目**删除**。响应与随后的 `refreshMcp()`(`useAgent.ts:234`)拿到的 `mcpOverview()` 中,manager 无 context7 条目 → 走推导分支 → 显示「尚未连接」。✅ 与用户所见一致。
2. **此时连接尚未建立**:GET /api/agent/mcp 是纯读,不会 spawn 任何 MCP 子进程;连接只会在**新建会话**(openSession / 子代理会话)时发生。
3. **调用成功**:用户随后发起会话/子代理 → `createMcpTools` 连接 context7 并注册 `mcp__context7__*` 工具 → 调用成功。且 `callTool` 的 `ensureConn` 支持断线即重连,即使连接曾被 dispose,工具闭包(引用的是 manager 而非连接)依然可恢复连接后成功调用。
4. **状态面板不再刷新**:`refreshMcp()` 只在 `init()`(页面加载)与 save/delete 之后调用;`ApiKeyModal`/`McpPanel` **打开时没有 onMounted 刷新,也没有轮询**。会话建立后 manager 条目已变为 `connected`,但面板展示的是更早的快照,永远停在「尚未连接」。

结论(三层原因叠加):

- **后端语义**:`status()` 只统计「进程启动以来 / 上次 dispose 之后已尝试连接」的 server;对已配置未连接的 enabled server,路由层静态推导 `error` 态 + 固定文案——这是**占位提示而非实时探测**,GET 接口不会触发连接,状态天然滞后于实际可用性。
- **生命周期设计**:连接绑定会话(懒连接),配置保存即 dispose →「保存后立即看」必然是「尚未连接」;要变成 connected 必须新建会话/重开工作区(设计如此,README/docs/mcp.md §4 已声明)。
- **前端刷新缺口**:面板无打开时刷新、无轮询、无手动刷新按钮,导致「会话已建、工具已可用」之后状态仍显示旧快照——这是用户看到不一致的直接原因。

### 1.6 修复建议

前端(主要,低成本):

1. `McpPanel.vue` 增加 `onMounted(() => props.agent.refreshMcp().catch(() => {}))`,打开设置模态窗即拉最新状态。
2. 面板加「刷新」按钮与/或轻量轮询(如每 30s `refreshMcp`);`useAgent.ts` 的 `mcp` 是 `ref`,刷新后 `statusByName` computed 自动更新。
3. 文案层面:后端推导的「尚未连接」可改为中性描述(如「已配置 · 新建会话后自动连接」),避免与真正的 `error`(连接失败)混淆——当前把「未尝试」推导成 `error` 态是误导性的(前端渲染为红色「异常:」)。

后端(可选):

4. 在 `McpServerStatus` 增加 `idle`/`not_connected` 状态,把「已配置未尝试」与「尝试过但失败」区分开;或在 GET /api/agent/mcp 响应中附带 `lastCheckedAt: null` 语义(已有),前端据此渲染「从未连接」而非「异常」。
5. 不建议在状态接口里触发连接(页面加载会 spawn 一堆 MCP 子进程,成本高);保持被动状态 + 前端刷新即可。

---

## 2. 问题 2:设置模态窗高度超出可视区

### 2.1 涉及文件

- `apps/web/src/components/ApiKeyModal.vue`(设置模态窗,含 DeepSeek / AnySearch / MCP 三个 section)
- `apps/web/src/components/McpPanel.vue`(第三 section,内容最重:安全警告框 + server 卡片列表 + 添加表单 + 测试结果列表)
- 对照样板:`apps/web/src/components/SubAgentModal.vue`(已实现正确的高度约束模式)

### 2.2 关键代码与样式分析

`ApiKeyModal.vue:57-60`(模板根):

```html
<div class="fixed inset-0 z-50 grid place-items-center bg-canvas/80 backdrop-blur-sm"
     @click.self="emit('close')">
  <div class="w-full max-w-md rounded-md border border-hairline bg-canvas p-6 shadow-modal">
```

- 外层:`fixed inset-0` + `grid place-items-center` —— 全视口固定遮罩、网格居中。
- 内层:只有 `w-full max-w-md p-6` —— **没有任何高度约束**:无 `max-height`、无 `overflow-y`、无 `my-*` 外边距。高度完全由内容撑开(p-6 内边距 + 三个 section + 环境信息;MCP section 含安全警告、每 server 一张卡片、添加表单,内容很高)。
- 对照 `SubAgentModal.vue:82-85`(正确模式):

```html
<div class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-canvas/80 p-6 backdrop-blur-sm" ...>
  <div class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-md border border-hairline bg-canvas shadow-modal">
    ...
    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
```

### 2.3 根因

1. 内层模态盒无 `max-height` / `overflow-y`。总高 ≈ 内容高度(带 MCP 面板时轻松超过 800–1000px)。
2. `place-items-center` 在内容高于视口时把盒子**上下对称溢出**:顶部(标题「连接 · CONNECT」、关闭按钮)被推出可视区上方。
3. 外层遮罩 `fixed inset-0` 不随 body 滚动,内层又无 `overflow-y: auto`,因此**没有任何滚动途径**可以滚回顶部——顶部内容不可达,底部也被裁掉一部分(视口越矮越严重,笔记本/浏览器 chrome 占高时尤甚)。

### 2.4 修复建议(按推荐度排序)

方案 A(最小改动,贴合仓库既有 Tailwind v4 用法,参照 SubAgentModal):

```html
<div class="w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-md border border-hairline bg-canvas p-6 shadow-modal">
```

- `max-h-[calc(100vh-2rem)]` 保证盒子不超过视口高度并留出上下各 1rem 呼吸空间;
- `overflow-y-auto` 让内容超高时在盒子内部滚动(顶部 header 滚出时仍可滚回);
- 若希望 header 常驻,可仿 SubAgentModal 改为 flex-col + `shrink-0` header + `min-h-0 flex-1 overflow-y-auto` 内容区。

方案 B(同时给外层兜底,防极端小屏):

```html
<div class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-canvas/80 p-6 backdrop-blur-sm" ...>
```

- 外层加 `overflow-y-auto p-6`:即使内层 max-height 失效(极端缩放),遮罩本身也可滚动。

方案 C(可选,进一步控制面板内长列表):McpPanel 的 server 列表区可加 `max-h-* overflow-y-auto`(组件内测试结果列表已有 `max-h-24 overflow-y-auto` 先例,`ChatPane.vue` 也有 `max-h-64 overflow-y-auto` 模式)。

> 注意:不要只加 `overflow-y-auto` 而不加 `max-height`——没有高度上限时 overflow 不会生效;两者必须成对出现。

---

## 3. 结论与可行性

### 问题 1(MCP 状态显示)

- **根因确认**:三层叠加——(a) `McpManager.status()` 只统计已尝试连接的 server,GET /api/agent/mcp 不触发连接;(b) 连接绑定会话创建(懒连接),配置保存即 dispose,保存后立刻查询必为「尚未连接」;(c) 前端面板无打开刷新/轮询,状态快照过期。实际调用成功是因为新会话建立时已连接(或 callTool 断线自动重连),与面板快照不同步。
- **修复可行且低成本**:前端 `McpPanel` 加 `onMounted` 刷新 + 刷新按钮/轮询;后端把「未尝试」与「连接失败」状态语义区分开。不涉及架构改动。

### 问题 2(模态窗高度)

- **根因确认**:`ApiKeyModal.vue` 内层盒子无 `max-height` + `overflow-y`,外层 `place-items-center` 居中导致超高时上下溢出且不可滚动。
- **修复可行且低成本**:参照仓库内 `SubAgentModal.vue` 既有模式,给内层加 `max-h-[calc(100vh-2rem)] overflow-y-auto`(方案 A),外层加 `overflow-y-auto p-6` 兜底(方案 B)。改动仅模板 class,无逻辑影响,建议补一个组件级测试或用浏览器视口断言验证。
