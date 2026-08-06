# 实施计划:修复「新工作区 A 对话时,消息/事件落错工作区(workflows 仓库)」

> 依据:`.wf-runs/c4c0c7d6/01-exploration-1.md`(根因假设 A 前端切换竞态、B 后端 activeEmitter 单例)。
> 已补充核对:`apps/web/src/composables/useAgent.ts`(openWorkspace/sendMessage/handleEvent/abort 全文)、
> `apps/api/src/pi/piService.ts`(activeEmitter 4 处引用点、prompt 生命周期、createSubAgentTool 闭包)、
> `apps/api/src/agent/routes.ts`(/open、/prompt、streamSSE 用法)、`packages/shared/src/index.ts`(SessionEvent 无归属字段)、
> 测试基建(`apps/web/src/composables/useAgent.test.ts` 已有 sseStream 模拟、`apps/api/src/pi/piService.test.ts` 已有私有成员直测模式)。

---

## 1. 目标与范围

### 做什么
1. **P0-前端**:消除 openWorkspace 窗口期(await `/open` 未返回)内消息发往旧工作区的路径;SSE 事件按流所属工作区过滤,杜绝「旧回合事件渲染进新工作区视图」。
2. **P0-后端**:`activeEmitter` 服务级单例改为按 workspaceId 隔离,消除跨工作区并发回合 sub_* 事件串流。
3. **P1-顺手**:openWorkspace 快速连点乱序覆盖防护;abort 按「流所属工作区」而非「当前激活工作区」;验证阶段核对 session JSONL header cwd 归属(排查根因 C)。

### 不做什么
- 不改 SDK(`node_modules/@earendil-works/pi-coding-agent`)——根因 C 当前未触发(三处 createAgentSession 均显式传 cwd),仅验证阶段核对,不引入补丁。
- 不改 `skillReadRoots` 只读放行面(设计内,非本 bug)。
- 不做消息「等待/重定向」队列等复杂方案(见 §3.1 取舍)。
- 不改后端路由层(/prompt、/open 已按 workspaceId 现读工作区,无需变更)。

---

## 2. 实施步骤

### P0-1 前端:useAgent.ts 切换窗口期发送防护 + SSE 事件归属过滤

**文件**:`apps/web/src/composables/useAgent.ts`

1. **新增状态**(模块级,与 `activeWorkspaceId` 并列):
   - `const switchingWorkspaceId = ref<string | null>(null)`(导出;组件/测试可用);
   - `let openSeq = 0`(openWorkspace 乱序防护用,非响应式);
   - `let streamingWorkspaceId: string | null = null`(模块级变量,记录当前流所属工作区,供 abort 用)。

2. **`openWorkspace(id)`**(L329-337)改为:
   ```
   if (activeWorkspaceId.value === id) return
   if (streaming.value) await abort()          // 既有
   switchingWorkspaceId.value = id             // 同步置位:窗口期从点击开始
   const seq = ++openSeq
   try {
     const data = await request<SessionData>(`/api/agent/workspaces/${id}/open`, …)
     if (seq !== openSeq) return               // 有更新的 open 请求,丢弃本次结果(防 A→B 乱序覆盖)
     activeWorkspaceId.value = id
     applySessionData(data)
     await Promise.all([refreshRun(), refreshSkills()])
   } finally {
     if (seq === openSeq) switchingWorkspaceId.value = null   // 失败也清位:用户仍留在旧工作区,可重发
   }
   ```
   要点:`switchingWorkspaceId` 在 await 前同步置位 —— 窗口期从「点击」算起而非从「/open 返回」算起。

3. **`sendMessage(text, images)`**(L629-650):
   - 入口(读 `activeWorkspaceId` 之后、`pushUserMessage` 之前)加防护:
     ```
     if (switchingWorkspaceId.value && switchingWorkspaceId.value !== activeWorkspaceId.value) {
       throw new Error('正在切换工作区,请稍候再发送')
     }
     ```
     → 拒绝策略(推荐,取舍见 §3.1)。throw 在 pushUserMessage 之前,不产生幻影用户消息;ChatPane 既有 catch 会恢复草稿。
   - 现有 `const workspaceId = activeWorkspaceId.value` 改名为 `streamWorkspaceId` 语义(快照即流归属);`streamingWorkspaceId = streamWorkspaceId`(同步赋值,随后才 `streaming.value = true`;finally 中置 null)。
   - SSE 读取循环内、`handleEvent(...)` 调用前,每行事件统一校验:
     ```
     if (activeWorkspaceId.value !== streamWorkspaceId) {
       abortController.abort()   // 客户端断开;服务端回合继续完成,消息留在旧会话(不丢)
       break
     }
     handleEvent(evt)
     ```
     校验点必须在循环处而非 handleEvent 内部:归属不符时 `done`/`error` 分支的 `refreshRun()`/`finalizeSubSessions` 副作用一并跳过。

4. **`abort()`**(L745-760):改为对 `streamingWorkspaceId ?? activeWorkspaceId.value` 发 `POST /abort`。防止「回合在 W 运行时用户切到 A 再点停止」误中止 A。

5. **导出**:return 对象增加 `switchingWorkspaceId`。

### P0-2 前端:ChatPane.vue 发送入口早退提示

**文件**:`apps/web/src/components/ChatPane.vue`

- `handleSend()`(L193)在既有 `!props.agent.activeWorkspaceId.value` 检查旁加:
  ```
  if (props.agent.switchingWorkspaceId.value) { sendError.value = '正在切换工作区,请稍候…'; return }
  ```
  放在任何上传/发送逻辑之前(避免图片先传到旧工作区 `.workflows/uploads/` 再被拒绝,产生孤儿文件)。
- 发送按钮 `:disabled` 可顺带绑定 `switchingWorkspaceId`(P1 可选,非必须)。

### P0-3 后端:piService.ts activeEmitter 按 workspaceId 隔离

**文件**:`apps/api/src/pi/piService.ts`

1. L111 声明改:
   ```ts
   /** 各工作区当前 prompt 回合的 SSE 事件回调(子代理工具/闸门事件经此转发);key = workspace.id */
   private readonly activeEmitters = new Map<string, (event: SessionEvent) => void>()
   ```
2. `prompt()` 内(L798)`this.activeEmitter = onEvent` → `this.activeEmitters.set(workspace.id, onEvent)`;finally(L861)`this.activeEmitter = null` → `this.activeEmitters.delete(workspace.id)`(沿用既有 try/finally,无泄漏)。
3. `createSubAgentTool` 的 execute 内 3 处 `this.activeEmitter?.(evt)`(L487 子代理 onEvent 镜像、L503 失败 sub_end、L522 成功 sub_end)→ `this.activeEmitters.get(workspace.id)?.(evt)`(工具闭包已捕获 workspace,直接按 id 查)。
4. `createWaitForApprovalTool` 的 gate_required 处(L563)→ 同上。
5. 语义不变:同工作区并发回合仍被 `handle.busy` 拒绝;跨工作区并发回合各自转发各自 SSE 流。主会话事件本就经 `handle.session.subscribe` 闭包直达本连接 `onEvent`,不走 emitter,无需改。

### P1 建议项(成本低,顺手修)
- 已并入 P0-1:openSeq 乱序防护、abort 按 streamingWorkspaceId。
- 验证阶段人工核对(无代码改动):`~/.workflows/workspace-sessions.json` 中每个 sessionFile 的 JSONL 首行 header `cwd` 与所属 workspaceId 目录一致(排查根因 C;发现不一致才需要进一步处理,届时单独立项)。
- 可选:ChatPane 发送/停止按钮 `:disabled` 绑定 `switchingWorkspaceId`。

---

## 3. 关键取舍说明

### 3.1 窗口期消息:拒绝 vs 等待 vs 重定向 → 推荐「拒绝」
| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **拒绝(采纳)** | 改动最小、无数据错位、消息留草稿用户重按一次即可;窗口期通常 <1s(首次开 A 因 MCP 连接/fff 索引可达数秒,提示文案覆盖) | 窗口内需用户二次操作(可接受) |
| 等待(队列) | 用户体验连续 | 需队列状态机、open 失败/超时处理、与 applySessionData 清空 messages 的时序耦合,过度设计 |
| 重定向到待开工作区 | 消息直达 A | A 会话未加载完成,`/open` 返回的历史会清掉刚推的乐观消息;顺序混乱,不可控 |

拒绝策略 + SSE 归属过滤(纵深防御)已覆盖全部已知竞态路径,收敛且不丢消息(回合留在旧会话,回 W 可见)。

### 3.2 SSE 事件归属:绑定在「流」而非「单条事件」
单次 `/prompt` fetch 的所有事件必然属于同一工作区(sendMessage 快照),故在读取循环处按 `streamWorkspaceId` 一次性校验,不给 SessionEvent 增加字段、不改 shared 类型、不改 handleEvent 签名 —— 最小侵入。

---

## 4. 验证方案

### 4.1 修复前复现(基线,可选)
1. dev(3000)或 prod(5200):在 W(workflows 仓库)会话空闲时点击新工作区 A;
2. 放大窗口:临时在 `routes.ts` 的 `/open` handler 里 `await new Promise(r => setTimeout(r, 3000))`(验证后删除);
3. 窗口内输入并发送消息 → 观察消息发往 W 会话(fetch 面板可见 `/workspaces/<W>/prompt`)、`/open` 返回后视图切 A、W 回合事件渲染进 A 视图;
4. 双标签页:标签 1 在 W 发消息(含子代理调用),标签 2 在 A 发消息 → 修复前标签 2 的 SSE 可能收到标签 1 的 sub_* 事件(activeEmitter 被后启动回合覆盖)。

### 4.2 修复后验证(逐条)
1. 窗口期发送被拒:重复 4.1 步骤 → 输入框提示「正在切换工作区」,消息不发出(fetch 面板无 /prompt);切完后发送,落点正确。
2. 事件归属:W 回合流式期间切到 A → A 视图无任何 W 事件混入;回 W 后历史完整(回合在 W 会话正常完成,messageCount 与内容正确)。
3. 双标签页并发回合:两工作区同时跑子代理回合,sub_* 各自归位(重点回归点)。
4. 落点核对:`~/.workflows/workspace-sessions.json` 的 W/A messageCount 与各自 JSONL header cwd(仓库路径 / A 路径)一一对应,无错位;`.workflows/agent/sessions/<workspaceId>/` 目录与工作区匹配。
5. 回归:`pnpm test`(api + web 全部 vitest)、`pnpm build`、dev 冒烟(发消息、切工作区、切会话、新建会话、闸门批准/驳回、abort)。

### 4.3 测试新增/修改
- **`apps/web/src/composables/useAgent.test.ts`**(复用既有 sseStream/stubApi 基建):
  1. openWorkspace 在途(sendMessage 前调用 openWorkspace 且 fetch mock 延迟 resolve)→ sendMessage 抛「正在切换工作区」且 fetch 未被调用;
  2. 流式期间 activeWorkspaceId 被切走(模拟 openWorkspace 完成)→ 后续 SSE 事件不进入 messages(断言 messages 长度/内容不变);
  3. 快速连点 openWorkspace(A)→openWorkspace(B)、B 先返回 → 最终 activeWorkspaceId 为 B(A 的晚到响应被丢弃)。
- **`apps/api/src/pi/piService.test.ts`**(沿用现有「私有成员视图 + fake handle」直测模式):
  4. 两个 workspace 各注入 emitter 到 `activeEmitters`,调用 `createSubAgentTool(wsA)` 的 execute(经 fake handle/run)与 wsB 对照,断言 A 回合产生的 sub_* 事件只进 A 的 emitter;
  5. prompt 路径若可直测:断言 finally 后 `activeEmitters` 为空(防泄漏)。
- 若既有用例依赖旧 sendMessage/openWorkspace 行为(如无 gate),同步更新。

---

## 5. 涉及文件清单与风险

### 文件清单
| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| `apps/web/src/composables/useAgent.ts` | switchingWorkspaceId/openSeq/streamingWorkspaceId;openWorkspace 置位+seq+finally;sendMessage gate+归属过滤;abort 按流归属;导出 | P0 |
| `apps/web/src/components/ChatPane.vue` | handleSend 早退提示(上传前) | P0 |
| `apps/api/src/pi/piService.ts` | activeEmitters Map;prompt set/delete;createSubAgentTool 3 处 + gate 1 处引用改查表 | P0 |
| `apps/web/src/composables/useAgent.test.ts` | 新增用例 1-3 | P0 |
| `apps/api/src/pi/piService.test.ts` | 新增用例 4-5 | P0 |
| (验证用,不提交) `routes.ts` 临时延迟 | 复现基线用,验证后还原 | - |

### 风险点
1. **窗口期误伤**:gate 在 openWorkspace 全周期(含失败)生效;失败路径 finally 清位,用户可立即重发 —— 已处理。
2. **服务端回合孤跑**:SSE 归属过滤时 abort 客户端连接,服务端回合继续完成并写旧会话(streamSSE 的 write 失败被既有 `.catch(() => {})` 吞掉,回合不中断) —— 消息不丢;若担心孤跑,可把 abort+break 改为 continue(保守兜底,计划默认前者)。
3. **emitter Map 泄漏**:prompt 的 finally 必须 delete(沿用既有 try/finally 结构,无新增泄漏面);测试 5 兜底。
4. **乱序覆盖**:快速连点工作区,晚到响应覆盖新选择 —— openSeq 防护;低风险。
5. **多标签页**:前端状态每标签页独立,改动互不影响;后端 Map 天然支持多路并发,优于单例。
6. **abort 语义变化**:按 streamingWorkspaceId 中止后,`refreshStatus` 刷当前工作区状态,行为与既有一致。

### 回滚方案
- 每处改动独立成 commit:P0-1/P0-2(前端)与 P0-3(后端)互不依赖,可单独 revert;
- 前端 revert 后回到旧行为(窗口期竞态复现,但无数据损坏——消息仅落错会话);
- 后端 revert 后跨工作区并发串流复现,但单标签页顺序使用不受影响。

---

## 6. 验收标准(逐条核对)

- [ ] `useAgent.ts`:openWorkspace 在途时(switchingWorkspaceId 非空且 ≠ activeWorkspaceId)sendMessage 抛错,且发生在 pushUserMessage 之前;
- [ ] `useAgent.ts`:SSE 循环处归属校验生效,切走工作区后旧流事件不再渲染、不再触发 refreshRun/finalizeSubSessions 副作用;客户端连接被 abort;
- [ ] `useAgent.ts`:快速连点两个工作区,最终激活 = 最后点击者;
- [ ] `useAgent.ts`:abort 中止的是流所属工作区的回合(streamingWorkspaceId 优先);
- [ ] `piService.ts`:`activeEmitters` 按 workspace.id 存取,prompt finally 后清空;4 处引用点全部改查表;
- [ ] 双标签页两工作区并发子代理回合,sub_* 事件互不串流(实测);
- [ ] 窗口期发送被拒且草稿保留(实测);
- [ ] `~/.workflows/workspace-sessions.json` messageCount 落点与 JSONL header cwd 与工作区一一对应(实测核对);
- [ ] `pnpm test` 全绿(含新增 5 用例)、`pnpm build` 通过、dev 冒烟通过。
