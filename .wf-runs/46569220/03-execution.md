# 执行报告:修复历史会话 tools 展开内容为空

## 改动文件清单

### 1. `apps/api/src/pi/history.ts`(根因修复)
- **改动内容**:`renderHistory()` 由单遍扫描改为两遍扫描:
  - 第一遍:遍历全部 `session.messages`,收集所有 `toolResult` 消息的 `toolCallId → { output, isError }` 写入 `lastToolOutput` Map(同 toolCallId 多条时取最后一条,与原语义一致);
  - 第二遍:按原逻辑渲染 user / assistant 消息,渲染 assistant 消息时 Map 已包含全部 tool 输出,`renderBlocks` 中 `lastToolOutput.get(call.id)` 能正确命中。
- **原因**:原单遍扫描时消息顺序恒为 assistant(含 toolCall) → toolResult,渲染 assistant 时 Map 尚未写入该 tool 的输出,导致 tool 块 `output: undefined`,前端 `v-if="!collapsed && output"` 不成立、展开面板空白。两遍扫描后主会话与子代理会话历史一并修复。
- **保持不变的输出**:`HistoryItem` 结构、block 顺序(thinking/text/tool 交错)、`usage`/`model` 字段、toolResult 不单独成条等格式均未改动;`renderBlocks`、`extractText` 未改动。

### 2. `apps/api/src/pi/piService.ts`
- **不改动**。三处调用方(`switchSession` :505、`getHistory` :552、`getSubAgentHistory` :662)均只传入 `session` 并返回 `renderHistory` 结果,`renderHistory` 签名未变,无需适配。

### 3. `apps/api/src/pi/history.test.ts`(新增,参照 `subAgent.test.ts` 风格)
- vitest `describe/it/expect` + `as unknown as AgentSession` 构造会话,覆盖 3 个用例:
  1. **回归主场景**:assistant toolCall 在前、toolResult 在后 → tool 块 `output` 非空(`'文件内容'`)、`callId`/`name`/`args`/`isError` 正确,且块顺序仍为 `['thinking', 'tool']`(输出格式保持);
  2. toolResult 在 assistant 之前(顺序无关)同样能关联;
  3. 同 toolCallId 多条 toolResult 时取最后一条。
- **原因**:按任务要求补充针对 renderHistory 的单元测试,锁定回归。

## 自检结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单测(全量) | `pnpm test`(apps/api) | ✅ 7 个测试文件、92 个用例全部通过 |
| 新增单测 | `npx vitest run src/pi/history.test.ts` | ✅ 3 个用例全部通过 |
| 类型检查 | `pnpm typecheck`(apps/api,tsc --noEmit) | ✅ 无错误 |

## 未完成项
无。改动严格限制在 `history.ts` 与新增测试文件内,未触碰前端、SDK 与存储层。
