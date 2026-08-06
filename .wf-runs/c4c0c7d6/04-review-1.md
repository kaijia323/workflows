# 代码审查报告:工作区切换竞态 + activeEmitter 串流修复(f7cd97d / 0161fa1)

> 审查对象:提交 f7cd97d(web)、0161fa1(api),对照 `.wf-runs/c4c0c7d6/02-plan-1.md` 与 `03-execution-1.md`,参考 `01-exploration-1.md`。
> 审查方式:只读核对 6 个改动文件(useAgent.ts / ChatPane.vue / useAgent.test.ts / ChatPane.test.ts / piService.ts / piService.test.ts)全文与关键行,未复跑测试(执行报告声明 pnpm test/typecheck/lint/build 全绿,husky 钩子亦通过)。

## 结论:pass

计划 P0-1/P0-2/P0-3 全部落实,无漏项、无超出范围改动;实现与计划逐条对应;新增 8 个测试均真实覆盖声称场景,无假阳性/假阴性;未发现阻断性问题。4 项建议修问题与 1 项验证缺口见问题清单。

---

## 一、逐条核对(计划项 → 状态)

| # | 计划项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | switchingWorkspaceId 置位/清位 | 通过 | `useAgent.ts:339` 在 await `/open` 前同步置位(窗口期从点击算起);finally(L350)仅最新 seq 清位,成功/失败路径都清,失败后用户留在旧工作区可立即重发 |
| 2 | openSeq 乱序防护 | 通过(残余边界见问题 1) | `useAgent.ts:340` seq 自增;`openWorkspace` await 后 `seq !== openSeq` 即丢弃晚到响应并跳过状态写入;旧 open 的 finally 不清位,避免误清新请求窗口标志 |
| 3 | sendMessage 窗口期拒绝 | 通过 | `useAgent.ts:709` gate 在 `pushUserMessage` 之前 throw,无幻影消息;ChatPane catch 恢复草稿,组件层另有早退(双保险) |
| 4 | SSE 归属校验与 abort | 通过 | `useAgent.ts:747-754` 读取循环内、`handleEvent` 之前逐行校验(快照 `streamWorkspaceId` vs 实时 `activeWorkspaceId`);不符 → `controller.abort()` + 双层 break,跳过 handleEvent 及其 done/error 副作用;服务端经 `routes.ts:281` `writeSSE().catch(()=>{})` 回合继续完成写旧会话(消息不丢) |
| 5 | abort 按流归属 | 通过(无单测,见问题 2) | `useAgent.ts:784-790` `streamingWorkspaceId ?? activeWorkspaceId`;`streamingWorkspaceId` 与 `streaming.value` 同步置位/清位,取值时机一致,不错杀不漏杀 |
| 6 | ChatPane 早退提示 | 通过 | `ChatPane.vue:200-204` 在既有检查之后、上传/发送逻辑之前,图片不会先传到旧工作区;草稿与待发图片保留(测试覆盖) |
| 7 | activeEmitters Map 隔离 | 通过 | `piService.ts:111` Map 声明;prompt set(L799)/finally delete(L862)成对;4 处引用点(487/503/522/563)全部改 `get(workspace.id)`;主会话事件仍走 subscribe 闭包直连,不走 Map |
| 8 | 改动范围 | 通过 | 6 个文件均在计划清单内;ChatPane.test.ts 基建更新(fake agent 补 switchingWorkspaceId)是 ChatPane 新访问点的必要配套,新增 1 例属计划 P0-2 测试意图的合理扩展;routes.ts 临时延迟未提交 |
| 9 | P1 验证项(JSONL header 核对 / 双标签页实测 / dev 冒烟) | 未完成(已声明) | 见问题 5,建议验收阶段人工补做 |

---

## 二、正确性细节核对(审查要点 2)

### useAgent.ts
- **switchingWorkspaceId 置位/清位时机**:置位在 `await abort()` 之后、`await /open` 之前 —— 注意置位发生在 abort 完成之后而非点击瞬间,若 abort POST 耗时,窗口期起点略晚于点击;但 abort 期间 `streaming.value` 仍为 true,ChatPane 发送入口被 `streaming` 检查拦截,无实际暴露面。✓
- **openSeq 防乱序有效性**:对「A→B→C 不同工作区快速连点」完全有效(晚到响应被 seq 丢弃,仅最新 seq 清位)。**残余边界**:连点序列中含「点回当前工作区」时(在途 open(A) 期间点 W),`openWorkspace` 早退 `if (activeWorkspaceId.value === id) return`(L337)不 bump openSeq,在途 open(A) 的晚到响应仍会落地、覆盖用户"留在当前工作区"的意图。此为旧代码既有行为,计划原文亦含该早退,非本次引入;但既然本修复以乱序防护为目标,建议顺手补上(见问题 1)。
- **SSE 校验用流快照而非实时值**:校验表达式 `activeWorkspaceId.value !== streamWorkspaceId`,以启动流时的本地快照为固定参照、以实时激活值为变动项,语义正确;单标签页真实场景中,切换必经 openWorkspace→abort,流先被客户端中止,归属校验是纵深防御(多标签页/abort 未生效场景),实现与计划一致。✓
- **abort 错杀/漏杀**:`streamingWorkspaceId` 与 `streaming.value` 在同一同步代码段内置位/清位,`streaming=true` 时 streamingWorkspaceId 必非空 → 停止按钮(仅 streaming 时显示)永远命中流所属工作区,不错杀;切走后旧流 finally 已清位,后续停止落在当前工作区,不漏杀当前回合。✓
- **拒绝发送时草稿保留**:组件早退路径(switchingWorkspaceId truthy)在 draft 清空之前 return,草稿原样保留;useAgent 层 throw 路径由 ChatPane catch 恢复 `originalDraft`(既有 P2 修复)。两条路径均保留,测试①④断言。✓

### piService.ts
- **set/delete 成对性**:delete 在 finally 中,异常/正常路径都执行;同工作区并发被 `handle.busy` 拒绝,不存在"delete 删掉他人条目"的可能;delete 与 set 同用 `workspace.id`,key 一致。✓
- **泄漏路径**:正常回合无泄漏(Map 大小上界 = 并发回合数 ≤ 工作区数);`deleteSession`/`cleanupWorkspaceSessions` dispose busy 会话 → prompt 抛错 → finally delete,仍成对。唯一理论缺口:`set`(L799)在 `subscribe`(L801)与 `try` 之前,若 subscribe 抛异常则该条目残留至下次同工作区 prompt 覆盖 —— subscribe 为 SDK 普通方法,实际不可达,且与旧单例结构同构,非本次引入(见问题 3,加固建议)。
- **跨工作区并发互不串流**:主会话事件经 subscribe 闭包直达本回合 onEvent(不查 Map);sub_*/gate 事件经 `get(workspace.id)` 查表,工具闭包捕获的 workspace.id 与 prompt 的 workspace.id 同为路由层 requireWorkspace 的 id 字符串,key 一致。Map 天然支持多路并发,优于旧单例。✓

### 测试质量
- **useAgent ①(窗口期拒绝)**:手控挂起 `/open` → 断言 throw、messages 为空、无 `/prompt` 请求、清位。非假阳性(无 gate 则 fetch 会被调用)。✓
- **useAgent ②(SSE 归属)**:手控流先推送两段增量(渲染),直接改 `activeWorkspaceId` 后推送 text_delta/agent_end/done → 断言停留在 `['hi','旧']`。无归属校验时 '世界' 必渲染,断言不真空。✓
- **useAgent ③(openSeq)**:双挂起 open、B 先返回、A 晚到 → 断言最终激活 ws-2、历史不被 A 覆盖、清位。真实覆盖乱序。✓
- **piService ④-⑦(emitter 隔离)**:双工作区 Promise.all 并行子代理,双向负向断言(`eventsA` 无 cB、`eventsB` 无 cA);失败 sub_end(isError)归位;gate_required 双区对照;prompt 后 `activeEmitters.size===0` 防泄漏。均通过私有成员视图 + fake handle 直测,真实覆盖 Map 语义。✓
- **ChatPane ⑧(窗口期早退)**:断言提示文案、不触发 uploadImage/sendMessage、草稿与待发图片保留。✓
- **测试缺口**(非阻断):abort 按流归属分支(`streamingWorkspaceId ?? activeWorkspaceId`)无单测;openWorkspace 失败清位无单测;归属校验"跳过 refreshRun/finalizeSubSessions 副作用"仅间接覆盖(渲染层面)。见问题 2。

---

## 三、回归风险(审查要点 3)

- **正常单工作区**:switchingWorkspaceId 恒 null(gate 不触发)、activeWorkspaceId===streamWorkspaceId(归属校验恒等)、abort 目标与旧行为一致(旧代码即 abort 当前工作区) → 无行为变化。
- **切换回来/快速连点**:openSeq 丢弃晚到响应,最终激活 = 最后点击(不同工作区时);「点回当前工作区」残余边界见问题 1,低概率。
- **失败重试**:open 失败 finally 清位,可立即重发;发送失败草稿/图片恢复为既有逻辑,测试覆盖。✓
- **性能/内存**:Map 有界(按工作区),finally 删除,无无限增长;前端新增三个 O(1) 状态。✓
- **服务端孤跑回合**:客户端断开后回合继续完成并写旧会话(消息不丢),期间同工作区新消息被 busy 拒绝 —— 既有语义,可接受;闸门批准路径的窗口期交互细节见问题 4。

---

## 四、代码风格与仓库一致性(审查要点 4)

- 命名(camelCase)、中文注释风格、`??`/`?.(evt)` 用法与仓库一致;switchingWorkspaceId/openSeq/streamingWorkspaceId 三者注释说明职责,注释质量高。
- ChatPane 早退位置与既有 early-return 模式一致;piService 注释同步更新(433 行说明按 workspace.id 隔离)。
- 测试沿用既有 sseStream/stubApi/jsonResponse 基建与「私有成员视图 + fake handle」直测模式,新增 manualStream 手控流合理。
- 无遗留 `activeEmitter`(单数)引用(grep 确认生产代码 0 处)。

---

## 五、问题清单

### 必改(阻断):无

### 建议修
1. **[低] `apps/web/src/composables/useAgent.ts:337`** openWorkspace 早退不 bump openSeq:在途 open(A) 期间点回当前工作区 W,open(A) 晚到响应仍落地,「最后点击者」语义被破坏(旧行为遗留,非本次引入)。建议早退分支 `openSeq++` 并清 switchingWorkspaceId,使点回当前工作区作废在途切换。
2. **[低] 测试缺口**:`abort()` 的 `streamingWorkspaceId ?? activeWorkspaceId` 分支(计划验收标准「abort 中止流所属工作区」)无单测;建议补一例:流式期间改 activeWorkspaceId 后调 abort,断言 POST 目标为流所属工作区。
3. **[极低] `apps/api/src/pi/piService.ts:799`** `activeEmitters.set` 位于 subscribe 与 try 之间,subscribe 若抛异常条目残留。建议将 set 移入 try 内或给 subscribe 包 try,保证 set/delete 严格成对(与旧结构同构,加固性质)。
4. **[低] `apps/web/src/components/ChatPane.vue:353-358`(approvePlan)/370-375(rejectPlan)** `dismissGate()` 在 `sendMessage` 之前调用:若窗口期内批准,useAgent gate 抛「正在切换工作区」,闸门 UI 已 dismiss 但服务端回合仍 awaiting_approval,批准意图丢失(需下一条普通消息归并续跑)。建议批准/驳回前先检查 switchingWorkspaceId 或把 dismissGate 移到 sendMessage 成功后。新行为比旧行为安全(旧行为会把 W 回合事件渲染进 A 视图),仅交互细节。
5. **[验证缺口,非代码问题]** 计划 §4.2 的实测项(双标签页并发子代理回合、`~/.workflows/workspace-sessions.json` messageCount 与 JSONL header cwd 核对、dev 冒烟)未执行(需真实运行环境),执行报告已声明。建议作为验收步骤人工补做;若双标签页并发可复现环境,优先补 4.2-3(重点回归点)。

---

## 六、最终建议

**通过。** 7 项计划全部落实、无超范围改动、单测真实有效、回归风险低;建议修问题 1-4 不阻断合并,可在后续随手处理;问题 5(实测验证)建议在具备运行环境后按计划 §4.2 补做,并顺带核对 JSONL header cwd 以排除根因 C。
