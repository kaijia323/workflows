# 执行报告:MCP 配置保存后热更新(阶段 1 + 2 + 4)

> 依据计划 `.wf-runs/9c4a0796/02-plan-1.md` 实施;阶段 3(fs.watch)本期不做。
> 3 个独立 commit(便于 revert):`a69e801`(阶段 1)、`2807a6b`(阶段 2)、`ce13933`(阶段 4)。

## 1. 改动文件清单

### 阶段 1(方案 A:会话重建)— commit a69e801

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/piService.ts` | ① `SessionHandle` 接口新增 `mcpRebuildPending?: boolean`(带注释);② 新增私有 `rebuildHandle()`:dispose + 从 handles 删除 + 同 sessionId 重开 + 迁移 usage/lastActivityAt + 失败降级 `openSession(workspace)` 新建;③ 新增公开 `refreshMcpForOpenSessions()`:先 `[...handles.values()]` 快照再遍历,只读工作区跳过,忙碌置 `mcpRebuildPending=true`,空闲 `rebuildHandle`,每 handle 独立 catch;④ `prompt()` 入口在 busy 检查之后、置 busy 之前消费挂起标记;⑤ `reopenIfOpen` 补注释互指 rebuildHandle(行为未改) | 保存即生效核心:已打开空闲会话立即按新配置重建;忙碌会话挂起下回合生效;绝不 dispose 运行中回合 |
| `apps/api/src/agent/routes.ts` | PUT 与 DELETE `/api/agent/mcp/:name` 在 `disposeMcpServer` 之后追加 `await pi.refreshMcpForOpenSessions()`;响应结构与 message 不变 | 路由接线:写盘 → 断旧连接 → 重建已打开会话 |
| `apps/api/src/pi/mcpRefresh.test.ts`(新增) | 沿用 piService.test.ts 私有构造 hack + openSession spy(不跑完整 openSession,避免 fff spawn)。7 用例:空闲重建+usage 迁移 / 忙碌挂起不 dispose / 只读跳过 / rebuildHandle 失败降级不抛 / 多工作区单失败隔离 / prompt 忙碌+置位先抛「正在处理中」不 dispose / prompt 空闲+置位先重建再开始回合 | 阶段 1 测试清单 |
| `apps/api/src/agent/mcpRoutes.test.ts` | `makeApp` 返回 pi;新增用例:PUT 与 DELETE 成功后 `refreshMcpForOpenSessions` 各被调用一次;`afterEach` restore mocks | 轻量路由接入断言 |

### 阶段 2(方案 B:配置指纹化 + 调用时解析)— commit 2807a6b

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/api/src/pi/mcpTools.ts` | ① 新增导出 `configFingerprint(config)`(稳定键序 JSON:command/args/env);② `McpEntry` 增 `fingerprint: string | null`(注释:创建连接所用 config 指纹;null=从未连接);③ `ensureConn` 指纹校验:conn 存在且指纹变化 → `closeEntry` 后按新配置重建;④ `listTools` 缓存判断加指纹条件(`entry.fingerprint === fp && entry.tools`);⑤ `createMcpTools` 签名向后兼容扩展第三个可选参数 `resolveServer`,默认回退 `servers.find`;⑥ `buildServerTools`/`toMcpToolDefinition` 透传 resolve,execute 改为调用时 `resolve(server.name)`,undefined 或 `enabled !== true` 返回「已删除或未启用,工具不可用」且不调 manager;工具名与 schema 仍来自注册时快照 | 补方案 A 两个洞:未重建窗口期旧闭包不按旧配置复活;删除/禁用立即失效 |
| `apps/api/src/pi/piService.ts` | openSession 内 `createMcpTools` 传入 live resolver `(name) => loadMcpServers(this.store).find(...)`;readOnly 仍传 `[]` | 消费点接入 |
| `apps/api/src/pi/subAgent.ts` | runSubAgent 内同样传入 live resolver;readOnly 仍传 `[]` | 消费点接入(子代理行为与主代理一致) |
| `apps/api/src/pi/mcpTools.test.ts` | 新增 6 用例:指纹变化重连(旧 conn.close + 按新 config 重建 + 新连接 listTools)/ 指纹相同缓存命中不重连 / live resolver 两次执行按新配置重连(断言 create 入参 cfgA→cfgB)/ resolve undefined 失效不 spawn / enabled:false 失效 / 不传 resolveServer 兼容性 | 阶段 2 测试清单 |

### 阶段 4(前端文案 + 文档)— commit ce13933

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `apps/web/src/components/McpPanel.vue` | 底部提示改为「**保存后立即生效**(已打开会话自动重建工具集;忙碌会话下一回合生效);删除/禁用立即断开连接。手工编辑 mcp.json 需重启生效。」(去掉「与 skills 一致」、补手工编辑边界);saved 提示「已保存到 mcp.json」→「已保存并生效」;`statusLabel` not_connected 文案「未连接 · 新建会话后自动连接」→「未连接」 | 提示与实现一致 |
| `apps/web/src/components/McpPanel.test.ts` | 两处「已保存到 mcp.json」断言同步为「已保存并生效」 | 前端测试同步;`useAgent.ts` 零改动 |
| `docs/mcp.md` | §2 架构图补 `refreshMcpForOpenSessions` 与 `resolveServer`;§4 生命周期改写(disposeServer 注释更新 + refreshMcpForOpenSessions 说明 + 生效时机=保存即生效,手工编辑需重启,注明文件监听未实现);§8 风险表补 3 行:会话重建失败降级(新建会话、旧 JSONL 保留)/ 忙碌会话挂起语义(busy 检查先行)/ 指纹重连并发竞态(last-write-wins,已知边界) | 文档与实现一致 |
| `README.md` | 两处旧文案「变更后需新建会话/重开工作区生效(与 skills 一致)」更新为「保存后立即生效…手工编辑 mcp.json 需重启进程生效」 | **最小适配(超出计划文档范围,见 §3 差异说明)** |

## 2. 自检结果

| 项 | 结果 |
| --- | --- |
| `pnpm test`(turbo 全仓,3 个 commit 各跑一遍) | ✅ 全绿:api 15 文件 292 passed | 1 skipped;web 5 文件 53 passed;shared build 通过 |
| 类型检查 `turbo run typecheck`(tsc + vue-tsc) | ✅ 3 包全部通过 |
| API 构建 `pnpm -C apps/api build`(tsc + copy-agents) | ✅ 通过 |
| lint(eslint --fix,commit 钩子) | ✅ 通过 |
| 范围控制 | ✅ 未改 SDK、未加依赖、mcp.json 存储结构零改动、PUT/DELETE 响应结构不变、useAgent.ts 零改动、阶段 3 未做 |

## 3. 计划与代码现状差异(最小适配,已在实施中处理)

1. **prompt() 消费顺序**:计划 §3 代码块把重建写在 busy 检查之前,但其下要点与任务说明均要求「先查 busy 再重建」。以要点为准实现:先 `if (handle.busy) throw`,再消费 `mcpRebuildPending`(busy 检查与 dispose 之间无 await,无竞态;忙碌期间发消息 → 抛「正在处理中」且挂起标记保留到下一回合)。
2. **reopenIfOpen 复用 rebuildHandle(计划可选低优先)**:跳过未改(两者语义有细微差别:reopenIfOpen 不带 sessionId 走激活会话),仅按计划留注释互指。
3. **降级路径不迁移 usage**:按计划代码原文,rebuildHandle 的 catch 回退分支 `openSession(workspace)` 不做 usage 迁移(语义=全新会话);已在注释与测试中明确。
4. **README.md 同步(超出计划列出的 docs/mcp.md)**:README 第 45/119 行含将被本功能推翻的旧文案,直接与实现矛盾;做 2 行最小更新以保持文档一致(阶段 4 目标「提示与实现一致」的合理延伸)。
5. **mcpRefresh.test.ts 多工作区隔离用例**:`Promise.all` 并发下按顺序消费 `mockRejectedValueOnce` 会错位,改为按 workspace.id 区分行为的确定性 mock(实现无改动,纯测试写法适配)。
6. 计划中「忙碌会话置位后 dispose 不被调」等用例在实现中逐一验证通过;`refreshMcpForOpenSessions` 内部每 handle 的 catch 与计划一致(rebuildHandle 自身有降级 catch,双保险)。

## 4. 未完成项与原因

- **阶段 3(fs.watch 手工编辑 mcp.json 监听)**:按计划明确不做(评估见 02-plan §3 阶段 3 留档)。面板文案与文档均已注明「手工编辑 mcp.json 需重启生效」。
- **手动 E2E(dev 环境)**:未执行(需要真实 DeepSeek API key 与 MCP server 环境);自动化覆盖见 §2。计划 §5 功能验收清单中的手动项留给人工验证。
