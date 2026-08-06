# 执行报告:修复「新工作区 A 对话时,消息/事件落错工作区」

> 依据 `.wf-runs/c4c0c7d6/02-plan-1.md`,按计划逐条实施,未扩大改动范围。
> 根因:假设 A(前端 openWorkspace 切换竞态,主因)+ 假设 B(后端 activeEmitter 服务级单例跨工作区串流)。

## 1. 改动文件清单

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/web/src/composables/useAgent.ts` | 新增 `switchingWorkspaceId` ref(openWorkspace 点击即同步置位、仅最新一次 open 在 finally 清位,失败也清);新增 `openSeq` 自增序号(晚到 /open 响应丢弃);新增 `streamingWorkspaceId`(流启动时快照,finally 置 null);`openWorkspace` 窗口期置位 + seq 乱序防护;`sendMessage` 入口在 `pushUserMessage` 之前拒绝窗口期发送;SSE 循环逐行校验归属(不符则 abort 连接 + 双层 break,跳过 done/error 副作用);`abort()` 按 `streamingWorkspaceId ?? activeWorkspaceId` 中止;return 导出 `switchingWorkspaceId` | P0-1:消除切换窗口期消息发往旧工作区 + 旧回合事件渲染进新视图 |
| `apps/web/src/components/ChatPane.vue` | `handleSend()` 在既有 early-return 之后、任何上传/发送逻辑之前加 `switchingWorkspaceId` 早退,提示「正在切换工作区,请稍候…」(草稿与待发图片保留) | P0-2:避免图片先传到旧工作区产生孤儿文件、消息落错会话 |
| `apps/api/src/pi/piService.ts` | `activeEmitter` 单例 → `activeEmitters: Map<workspaceId, callback>`;`prompt()` 改 `set(workspace.id, onEvent)` / finally `delete(workspace.id)`(沿用既有 try/finally,无泄漏);`createSubAgentTool` 3 处(sub_* 镜像、失败 sub_end、成功 sub_end)与 `createWaitForApprovalTool` 1 处(gate_required)全部改 `this.activeEmitters.get(workspace.id)?.(evt)`;同步更新注释 | P0-3:跨工作区并发回合 sub_*/gate 事件互不串流 |
| `apps/web/src/composables/useAgent.test.ts` | 新增 3 例:①openWorkspace 在途(手控挂起 /open)sendMessage 抛「正在切换工作区」且无幻影消息、无 /prompt 请求;②流式期间切走 activeWorkspaceId(手控 SSE 流),后续事件不再渲染,消息停留在切走前;③快速连点 ws-1→ws-2、ws-2 先返回,晚到响应被丢弃,最终激活 ws-2 | P0 测试(复用既有 sseStream/jsonResponse/stubApi 基建 + 新增 manualStream 手控流) |
| `apps/web/src/components/ChatPane.test.ts` | fake agent 补 `switchingWorkspaceId` ref(mountPane 基建同步,否则 7 个既有用例崩溃);新增 1 例:切换窗口期点击发送 → 提示文案、不触发 uploadImage/sendMessage、草稿与待发图片保留 | 组件层窗口期早退覆盖 |
| `apps/api/src/pi/piService.test.ts` | `vi.mock('./subAgent.js')`(仅 mock runSubAgent/SubAgentError,不拉起真实子代理会话);TestApi 扩展 `activeEmitters`/`createSubAgentTool`/`prompt`/`openSession`;新增 4 例:①双工作区并行子代理回合,sub_end 只进本工作区 emitter(双向断言不串流);②子代理失败 sub_end(isError)按工作区归位;③gate_required 双工作区对照;④prompt(fake session + spy openSession)结束后 activeEmitters 清空防泄漏 | P0 测试(沿用既有「私有成员视图 + fake handle」直测模式) |

## 2. 每处改动要点(与计划逐条对应)

- **P0-1 useAgent**:
  - `switchingWorkspaceId` 在 `await /open` 前同步置位 → 窗口期从「点击」算起;
  - `openSeq` 乱序防护:仅最新一次 open 应用结果并清位(旧 open 的 finally 不清位,避免误清新请求的窗口期标志);
  - sendMessage 门禁:`switchingWorkspaceId && switchingWorkspaceId !== streamWorkspaceId` 时在 `pushUserMessage` 之前 throw,草稿由 ChatPane catch 恢复;
  - SSE 归属校验在读取循环内、`handleEvent` 之前逐行执行:不符 → `controller.abort()` + break(内层) + detached break(外层),done/error 的 `refreshRun`/`finalizeSubSessions` 副作用一并跳过;服务端回合经 streamSSE 的既有 `.catch(() => {})` 继续完成写旧会话,消息不丢;
  - abort 按 `streamingWorkspaceId ?? activeWorkspaceId`,停止按钮不再误中止新工作区回合。
- **P0-2 ChatPane**:早退放在上传之前(位于压缩失败项检查之前),带图发送也不会先上传。
- **P0-3 piService**:4 处引用点全部改查表(`get(workspace.id)`);prompt 的 set/delete 成对,`finally` 中 delete 保证异常/正常路径都不泄漏;主会话事件仍经 `handle.session.subscribe` 闭包直连本流 onEvent,未改。
- **P1 项**:openSeq 与 abort 归属已并入 P0-1 完成;`routes.ts` 临时延迟(复现基线用)未引入,直接以单测覆盖竞态路径;发送/停止按钮 `:disabled` 绑定 switchingWorkspaceId 按计划标注「可选」未做(保留点击反馈以展示提示文案)。

## 3. 测试结果

- `pnpm --filter @workflows/api test`:**18 文件 / 374 用例全过**(含新增 4 例);
- `pnpm --filter @workflows/web test`:**10 文件 / 105 用例全过**(含新增 4 例:useAgent 3 + ChatPane 1);
- `pnpm typecheck`(turbo):3/3 通过(tsc + vue-tsc);
- `pnpm lint`(turbo):3/3 通过(修复 1 处测试文件 unused var);
- `pnpm build`(turbo):3/3 通过(vue-tsc -b + vite build + api tsc + copy-agents)。

## 4. 提交记录(前后端各一,可分别回滚)

- `f7cd97d` **fix(web)**:工作区切换窗口期发送防护 + SSE 事件归属过滤(useAgent.ts / ChatPane.vue / useAgent.test.ts / ChatPane.test.ts)
- `0161fa1` **fix(api)**:activeEmitter 单例改为按 workspace.id 隔离的 Map(piService.ts / piService.test.ts)

注:提交时 husky pre-commit 钩子自动执行 lint-staged + typecheck + test,均通过。

## 5. 未完成项与说明

- **验证阶段人工核对项(计划 §4.2)未执行**:双标签页真机并发回合、`workspace-sessions.json` messageCount 落点与 JSONL header cwd 核对、dev 冒烟——需运行环境(5200/3000 + 真实模型)操作,建议作为验收步骤人工执行;代码层已用单测覆盖等价路径(窗口期拒绝、归属过滤、openSeq、emitter 隔离)。
- 未提交 `.wf-runs/c4c0c7d6/`(产物目录),仅提交 6 个代码/测试文件。
