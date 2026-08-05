# 审查报告:MCP 配置保存后热更新(阶段 1 + 2 + 4)

> 审查对象:commit a69e801(阶段 1)/ 2807a6b(阶段 2)/ ce13933(阶段 4),对照 `.wf-runs/9c4a0796/02-plan-1.md` 与 `03-execution-1.md`
> 审查方式:逐文件静态核对(piService.ts / routes.ts / mcpTools.ts / subAgent.ts / 3 个测试文件 / McpPanel.vue / McpPanel.test.ts / docs/mcp.md / README.md)+ git log 校验 3 个 commit 存在;本环境无 shell,`pnpm test`/typecheck/build 无法独立复跑,仅能静态核验测试逻辑(见 §5)。

## 结论:fail(打回执行,最小修复;核心实现与计划一致)

唯一阻断项:README.md 残留与实现相矛盾的旧文案(执行报告声称已更新,与事实不符)。功能代码、测试、范围控制全部通过。修复成本 1 行。

---

## 1. 逐条核对结果

### 阶段 1(方案 A — 会话重建)

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| SessionHandle 新增 `mcpRebuildPending?`(带注释) | 通过 | piService.ts:38-39,注释与计划一致 |
| `rebuildHandle`:dispose + handles.delete + 同 sessionId 重开 + usage/lastActivityAt 迁移 + 失败降级新建 | 通过 | piService.ts:472-487。顺序与计划逐行一致;降级分支 `openSession(workspace)` 不迁移 usage,与计划代码原文一致 |
| `refreshMcpForOpenSessions`:快照遍历 / 只读跳过 / 忙碌置 pending / 逐 handle catch | 通过 | piService.ts:497-509。`[...this.handles.values()]` 快照 ✓;`h.workspace.readOnly` 跳过 ✓;`h.busy → mcpRebuildPending = true` ✓;`rebuildHandle(h).catch(...)` 独立隔离 ✓ |
| `prompt()` 挂起消费在 busy 检查之后 | 通过 | piService.ts:566-569。顺序:`openSession → if (handle.busy) throw → if (mcpRebuildPending) rebuildHandle → busy = true`。计划 §3 代码块与要点自相矛盾,实现按要点(busy 先查)执行,且 busy 检查与 dispose 之间无 await、无竞态——**出入合理,执行报告 §3.1 说明成立** |
| 与 reopenIfOpen 语义一致性 | 通过 | reopenIfOpen 未改(计划可选低优先),rebuildHandle 注释互指,行为等价(sessionId 即 active) |
| routes.ts PUT/DELETE 在 disposeMcpServer 之后调 refreshMcpForOpenSessions | 通过 | routes.ts:106-107(PUT)、122-123(DELETE),顺序与计划一致;响应结构 `{ code, message, data: mcpOverview() }` 不变 |
| mcpRefresh.test.ts 7 用例 | 通过 | 7 个用例齐全(空闲重建+usage 迁移 / 忙碌挂起不 dispose / 只读跳过 / 失败降级 / 多 handle 单失败隔离 / prompt 忙碌先抛 / prompt 空闲先重建)。spy 真实拦截实例方法(prototype 方法被实例级 spy 替换,rebuildHandle/prompt 内 `this.openSession` 均命中);多 handle 用例按 workspace.id 分支 mock,确定性成立 |
| mcpRoutes.test.ts 路由接入断言 | 通过 | `vi.spyOn(pi, 'refreshMcpForOpenSessions')` PUT/DELETE 各断言 1 次,spy 真实拦截路由内调用 |

### 阶段 2(方案 B — 指纹化 + 调用时解析)

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| `configFingerprint` 稳定键序(command/args/env) | 通过 | mcpTools.ts:341-347。键序固定;env 内键序未排序(见问题 F4,与计划原文一致,非偏离) |
| McpEntry 增 `fingerprint: string \| null` | 通过 | mcpTools.ts:354,注释明确「null = 从未连接」 |
| `ensureConn` 指纹校验(变化 → closeEntry 重建) | 通过 | mcpTools.ts:477-487,与计划逐行一致 |
| `listTools` 缓存指纹条件 | 通过 | mcpTools.ts:373 `entry.fingerprint === configFingerprint(config) && entry.tools` |
| `createMcpTools` 向后兼容 resolveServer 扩展 | 通过 | mcpTools.ts:400-406,缺省回退 `servers.find`,既有调用方零改动 |
| execute 调用时解析、删除/禁用返回「已删除或未启用」且不 spawn | 通过 | mcpTools.ts:520-529。`abortIfSignaled → resolve(server.name) → !current \|\| enabled !== true → toolError(已删除或未启用)`;manager.callTool 用 `current`(最新配置),工具名/schema 仍为注册时快照(与计划一致) |
| piService.openSession / subAgent.runSubAgent live resolver 接入,readOnly 传 [] | 通过 | piService.ts:190-192;subAgent.ts:321-323,两处均 `readOnly ? [] : createMcpTools(mcp, servers, resolve)` |
| mcpTools.test.ts 新增 6 用例 | 通过 | 指纹变化重连(断言 close + create 第 2 次入参 cfgB + 新连接 listTools)/ 指纹相同缓存命中 / live resolver 两连(create 入参 cfgA→cfgB,old conn close)/ undefined 失效不 spawn / enabled:false 失效 / 不传 resolve 兼容性。断言均有实际拦截与具体入参校验,非形式化 |

### 阶段 4(文案 + 文档)

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| McpPanel.vue 底部提示改写 | 通过 | McpPanel.vue:454「保存后立即生效(已打开会话自动重建工具集;忙碌会话下一回合生效);删除/禁用立即断开连接。手工编辑 mcp.json 需重启生效。」与计划文案一致,去「与 skills 一致」、补手工编辑边界 |
| saved 提示「已保存并生效」 | 通过 | McpPanel.vue:452 |
| statusLabel not_connected →「未连接」 | 通过 | McpPanel.vue:61 |
| McpPanel.test.ts 同步 | 通过 | 两处断言更新(272/337 行);全文无旧提示文案(「重开/新建会话」)残留断言 |
| docs/mcp.md §2/§4/§8 | 通过 | §2 架构图含 refreshMcpForOpenSessions/resolveServer;§4 生效时机(保存即生效 + 手工编辑需重启 + 文件监听未实现)与实现一致;§8 风险表新增 3 行(降级/忙碌挂起/指纹竞态)。小瑕疵见 F2 |
| useAgent.ts 零改动 | 通过 | 仅含既有 saveMcpServer/deleteMcpServer(223/241 行),无 refreshMcpForOpenSessions 引用 |

### 范围控制

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 未改 SDK | 通过 | piService/mcpTools/subAgent 对 `@earendil-works/*` 仅 import 既有 API |
| 未新增依赖 | 通过 | 改动文件无新 import;package.json 未涉及(3 个 commit 均为源码/测试/文档) |
| mcp.json 存储结构/校验/原子写未动 | 通过 | mcpConfig.ts 无 fingerprint/refresh/watch 任何改动痕迹 |
| useAgent.ts 零改动 | 通过 | 见上 |
| PUT/DELETE 响应结构不变 | 通过 | routes.ts 仍返回 `{ code, message, data: mcpOverview() }` |
| 阶段 3 fs.watch 未做 | 通过 | apps/api/src 全文无 `fs.watch/watchFile/chokidar` 匹配 |
| 3 个 commit 存在且独立 | 通过 | git log 确认:a69e801「重建已打开会话」、2807a6b「配置指纹化 + 调用时解析」、ce13933「文案与文档同步」 |

---

## 2. 问题清单

| # | 级别 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| F1 | **P1** | README.md:45(MCP 配置小节 bullet) | 旧文案「变更后需**新建会话/重开工作区**生效(与 skills 一致)」**未被删除**,与其下第 46 行新文案「保存后立即生效…」并存同一列表,文档自相矛盾且与实现相反(用户会误以为仍需新建会话)。执行报告 §3.4 声称「第 45/119 行做 2 行最小更新」,实际 119 行是替换、45 行只是新增了一行,旧行残留——报告自述与事实不符 | 删除 README.md:45 旧行(或改为与 skills 区分的说明,如「skills 仍为新会话生效」) |
| F2 | P2 | docs/mcp.md §4「生命周期与缓存」 | McpEntry 结构描述仍为 `{ conn, tools, state, error?, lastCheckedAt }`,未含阶段 2 新增的 `fingerprint` 字段,与实现(mcpTools.ts:354)轻微漂移 | 补 `fingerprint: 创建连接所用 config 指纹(null=从未连接)` |
| F3 | P2 | apps/api/src/pi/mcpRefresh.test.ts(「重开失败→降级新建」用例,约 176-206 行) | ① 测试名「…不抛错,usage 迁移」与实现语义不符(降级路径按计划**不**迁移 usage);② `expect(result.usage).toEqual(oldHandle.usage)` 与 `lastActivityAt` 断言空洞:fallbackHandle 与 oldHandle 共用 makeHandle 同一默认值(10/20/…/1234),无论实现是否迁移都通过,起不到锁定行为的作用 | 给 fallbackHandle 传入不同的 usage/lastActivityAt 值,显式断言「降级不迁移」(锁定当前语义);或改测试名去掉「usage 迁移」 |
| F4 | P2(信息级) | apps/api/src/pi/mcpTools.ts:341-347 | `configFingerprint` 对 env 用 `JSON.stringify` 原键序序列化(未排序):若同一 server 的 env 键序在不同写入路径下不一致(如手工编辑 mcp.json 重排键),会误判指纹变化,导致一次多余 close+重建(功能无损,仅多一次重连)。与计划原文实现一致,非偏离,仅提示 | 可留作已知边界;若想更稳,对 env 键排序后再序列化(一行) |

**未计入问题的观察项**:
- PUT/DELETE 现在会 await 全部会话重建(含 connect 10s 超时的 down server),保存接口最坏延迟可达约 10s——这是计划明示的接线方式(「保存即生效」语义),非偏离;仅提示前端保存按钮的等待体验。
- 重建窗口期(dispose 后、openSession 完成前)并发 prompt 可能多重建一次——计划 §4 风险 1 已明确记录为已知边界,与 reopenIfOpen 既有模式一致。

---

## 3. 计划与实现的出入判定

1. **prompt() 重建位置**:计划 §3 代码块把重建写在 busy 检查之前,但其下要点与任务要求均为「先查 busy 再重建」。实现按要点(busy 先查),且 busy 检查与 dispose 之间无 await、无竞态。**出入合理**,执行报告 §3.1 说明准确。
2. **reopenIfOpen 复用 rebuildHandle(计划可选低优先)**:跳过未改,仅注释互指。**合理**(两者语义有细微差别,低优先项)。
3. **降级路径不迁移 usage**:与计划代码原文一致。**合理**。
4. **README.md 同步(超出计划文件清单)**:方向合理,但**执行不完整**(F1 旧行未删)——这正是本次打回的原因。
5. **mcpRefresh.test.ts 多 handle 用例 mock 写法**:按 workspace.id 分支替代 mockRejectedValueOnce 顺序消费。**合理**(Promise.all 并发下顺序消费会错位,执行报告 §3.5 说明准确)。

---

## 4. 测试有效性评估

- **spy 均真实拦截**:mcpRefresh.test.ts 中 `vi.spyOn(api, 'openSession')` 拦截实例方法,`rebuildHandle`/`refreshMcpForOpenSessions`/`prompt` 内部的 `this.openSession` 调用全部命中;mcpRoutes.test.ts 的 `vi.spyOn(pi, 'refreshMcpForOpenSessions')` 命中路由内调用。非形式化 mock。
- **断言有意义**:usage 迁移(用例 1/4 用零值 freshHandle 对比真实迁移)、调用参数(`toHaveBeenNthCalledWith(2, cfgB)`)、不 spawn(`connect` 次数不变 + `callTool` 未调)等均为行为级断言。
- **唯一空洞断言**:F3(降级用例的 usage/lastActivityAt 断言)。
- 关键回归风险(断线重连、缓存命中、单 server 失败隔离、stdio 真实链路)均有既有用例覆盖且保持全绿(执行者自述)。

## 5. 验证限制

本环境无 shell 工具,无法复跑 `pnpm test` / `turbo run typecheck` / build;执行者自述「api 15 文件 292 passed | 1 skipped;web 5 文件 53 passed」未独立复核。已通过逐行静态核对 3 个测试文件 + 改动源码,未发现会必然导致测试失败的逻辑问题。

---

## 6. 最终建议

**打回执行(最小修复)**:功能实现、测试、范围控制全部符合计划,仅需一次小修:
1. 删除 README.md:45 残留旧文案(P1,必须);
2. 可选:F2(docs/mcp.md 补 fingerprint 字段)、F3(修正空洞断言与测试名)。

修复后即可通过,无需重做计划。
