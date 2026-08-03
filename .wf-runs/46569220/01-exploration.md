# 探索报告:subagent 模态窗 tools 展开后没有内容

## 结论速览(根因)

**数据没有丢,是「渲染时序」bug。**

- 子代理会话 JSONL 里 toolResult 消息(含完整输出文本)被完整持久化(已用磁盘真实文件验证);
- 但后端 `apps/api/src/pi/history.ts` 的 `renderHistory()` 用单遍扫描 + `lastToolOutput` Map 挂接工具输出,**Map 只在遍历到 toolResult 消息时才写入,而 toolResult 消息总是排在对应 assistant 消息之后**,因此渲染 assistant 消息里的 toolCall 块时 Map 永远查不到 → `output: undefined` → 前端 `?? ''` → 展开面板 `<pre v-if="... && block.tool.output">` 为空。
- 该 bug 同时影响主会话与子代理会话的历史恢复;用户主要在 subagent 模态窗观察到,是因为 live(实时)有内容、恢复后为空的对比最明显。

---

## 1. 仓库概览

- **结构**:Turborepo monorepo,`apps/web`(Vue 3 + Vite + Tailwind v4 前端)、`apps/api`(Hono + pi SDK 后端)、`packages/shared`(纯类型包)。
- **构建/测试**:`pnpm dev`(web 15200 / api 3000)、`pnpm build`(shared → api/web)、`pnpm test`(Vitest:api `app.test.ts`;web `App.test.ts`、`useAgent.test.ts`)。
- **数据隔离**:所有运行数据在 `.workflows/`(API key / 工作区 / 会话 JSONL),不碰 pi 全局配置。

## 2. 会话持久化机制(存哪 / 何时存 / 何时加载)

### 前端:无任何本地持久化
`apps/web/src` 全量搜索 `localStorage / sessionStorage / IndexedDB` → **零命中**。前端不序列化会话,所有历史数据都来自后端 API。

### 后端:JSONL 实时落盘(含 toolResult)
- 主会话:`.workflows/agent/sessions/<workspaceId>/<ts>_<id>.jsonl`,由 `PiAgentService.openSession`(piService.ts)创建/打开。
- 子代理会话:`subAgent.ts:268` `SessionManager.create(workspace.path, sessionDir)`,每个子代理调用一个 JSONL(`.../sub/<runId>/<ts>_<id>.jsonl`)。
- 落盘时机:pi-coding-agent SDK `agent-session.js` `_handleAgentEvent` 在 `message_end` 时 `sessionManager.appendMessage(event.message)`(role 为 user/assistant/**toolResult** 都会写盘);`SessionManager._persist` 用 `appendFileSync` 逐条追加。**子代理 `session.dispose()` 前文件已实时写好**(subAgent.ts:305-306 先取 sessionFile 再 dispose)。

### 恢复路径(重启 / 刷新 / 切换会话)
1. 打开工作区/切换会话:`POST /api/agent/workspaces/:id/open`、`POST /sessions/:sessionId` → `pi.getHistory / switchSession`(piService.ts:550/505)→ `renderHistory(session)` → 前端 `applySessionData`(useAgent.ts:236)。
2. 子代理模态窗:live 数据在内存 `subSessions` Map(SSE `sub_*` 事件填充,useAgent.ts:161);**`applySessionData` 会 `subSessions.clear()`(useAgent.ts:239)**——重启服务/刷新浏览器/切换会话后 Map 为空。
3. 模态窗 `SubAgentModal.vue` `onMounted`:无 live 容器 → `fetchSubHistory(callId)`(useAgent.ts:573)→ `GET /api/agent/workspaces/:id/run/agents/:callId` → `pi.getSubAgentHistory`(piService.ts:645):从 run.json `agents[].sessionFile` 定位 sub JSONL,`SessionManager.open` + `createAgentSession` 重新载入 → `renderHistory(session)`。

## 3. tools 展开面板内容来源(MessageBubble.vue)

```vue
<!-- apps/web/src/components/MessageBubble.vue:139-146 -->
<span>{{ block.tool.collapsed ? '▸ 详情' : '▾ 收起' }}</span>
<pre
  v-if="!block.tool.collapsed && block.tool.output"   <!-- :143 -->
  ...
>{{ block.tool.output }}</pre>                       <!-- :146 -->
```
- 面板内容 = tool segment 的 `output` 字段(`planBlocks` 来自 `UiSegment.tool.output`)。
- 历史加载时前端映射(useAgent.ts:247 / 582):
  ```ts
  { kind: 'tool', callId: block.callId, name: block.name,
    output: block.output ?? '', isError: block.isError ?? false, collapsed: true }
  ```
  即后端 `output` 缺失 → `''` → `v-if` 不成立 → 展开后无内容。
- **THINKING 对比**:thinking 块内容 `block.text` 直接取自 assistant 消息 content 的 thinking part(history.ts:58-61),不依赖 toolResult 关联,所以历史恢复时 THINKING 能正常显示。二者保存路径差异正是根因所在。

## 4. 丢失环节:后端 renderHistory 单遍扫描时序 bug

`apps/api/src/pi/history.ts`(完整逻辑):

```ts
// :9-48
export function renderHistory(session: AgentSession): HistoryItem[] {
  const items: HistoryItem[] = []
  const lastToolOutput = new Map<string, { output?: string; isError?: boolean }>()  // :13
  for (const message of session.messages) {
    if (message.role === 'user') { ... }
    else if (message.role === 'assistant') {
      const blocks = renderBlocks(message, lastToolOutput)   // :25 ← 此时 Map 还没有本次 toolCall 的结果
      ...
    } else if (message.role === 'toolResult') {
      lastToolOutput.set(message.toolCallId, { output: extractText(message.content), isError: message.isError })  // :41-44 ← 在 assistant 之后才写入
    }
  }
}

// :66-77 renderBlocks 内
} else if (type === 'toolCall') {
  const result = lastToolOutput.get(call.id)   // :68 ← 永远 undefined
  blocks.push({ type: 'tool', callId: call.id, ..., output: result?.output, isError: result?.isError })  // :74
}
```

**消息顺序**(SDK agent-loop.js `runLoop` 与真实 JSONL 一致):
`user → assistant(含 toolCall) → toolResult → assistant(含 toolCall) → toolResult → …`
toolResult 必然排在引用它的 assistant 消息之后;单遍扫描渲染 assistant 时 Map 尚未写入,`get(call.id)` 恒为 undefined → 所有工具块的 `output` 都缺失。

**磁盘数据验证**(`.workflows/agent/sessions/0253b680-.../sub/6cf6ef7b/*.jsonl`):
assistant 消息 content 含 5 个 `toolCall`(call_00…call_04),紧随其后 5 条 `toolResult` 消息均带完整 `content:[{type:'text', text:'…'}]`。→ **持久化完整,问题只出在渲染**。

**Live 为何有内容**:SSE 路径不经过 renderHistory——`piService.ts` `mapSessionEvent` 把 SDK `tool_execution_end` 映射为 `tool_end`(piService.ts:699-706,`output: stringifyResult(event.result)`),前端 `tool_end`/`sub_tool_end` 直接累积 output(useAgent.ts:474-479 / 517-521)。恢复路径才走 renderHistory。

## 5. 涉及文件与改动范围评估

| 文件 | 行 | 作用 |
| --- | --- | --- |
| `apps/api/src/pi/history.ts` | 9-77 | **根因所在**:renderHistory 单遍扫描,Map 写入晚于使用 |
| `apps/api/src/pi/piService.ts` | 550/505/645-662 | getHistory / switchSession / getSubAgentHistory 均调用 renderHistory(共享缺陷) |
| `apps/web/src/composables/useAgent.ts` | 236-247 / 573-582 | 历史→segment 映射,`output: block.output ?? ''`(正确消费,无需改) |
| `apps/web/src/components/MessageBubble.vue` | 143-146 | 展开面板 `v-if="!collapsed && output"`(正确,无需改) |
| `apps/web/src/components/SubAgentModal.vue` | 24-42 | live 缺失时走 fetchSubHistory(正确,无需改) |
| `apps/api/src/pi/subAgent.ts` | 268/305-311 | 子代理 JSONL 创建与 sessionFile 记录(数据完整,无需改) |

**修复方向(只改后端,一处)**:
把 `renderHistory` 改为两遍扫描:第一遍遍历 `session.messages` 收集全部 `toolResult` 的 `toolCallId → {output, isError}`;第二遍再渲染 assistant 消息时查找。纯函数改动,`apps/api/src/pi/history.ts` 一个文件即可,前端、SDK、存储层均不动。修复后主会话历史与子代理模态窗历史同时恢复正常。

**建议**:
1. 为 `history.ts` 补单测(构造 user/assistant(toolCall)/toolResult 序列,断言 tool block 带 output);当前 `src/pi` 下无 history.test.ts。
2. 修复后可用磁盘上现存 sub JSONL 走 `GET /run/agents/:callId` 回归验证(数据已在,无需重跑 agent)。

**风险点**:
- 前端无本地存储,任何"只改前端"的修复都无法覆盖重启/刷新场景;数据源必须来自后端渲染,故修复点必须在 `history.ts`。
- `getSubAgentHistory` 依赖 `SessionManager.open` 重新载入 JSONL 的能力(已验证可用);不属本次改动范围。
