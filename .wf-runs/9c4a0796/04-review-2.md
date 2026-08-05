# 审查报告(第 2 轮:复查修复)

> 审查对象:commit `616e41e`(基线 `ce13933`),对照 `.wf-runs/9c4a0796/04-review-1.md` 问题清单 F1–F4 与 `03-execution-2.md`
> 审查方式:逐文件静态核对(README.md / docs/mcp.md / mcpRefresh.test.ts / mcpTools.ts)+ `.git/logs/HEAD` 校验 commit;本环境无 shell,`pnpm test`/typecheck 无法独立复跑,以静态核验 + 执行报告自检结果交叉确认

## 结论:pass

F1(P1)+ F2/F3/F4(P2)全部正确修复,修复 commit 独立、范围受控,未发现新行为或回归风险。

---

## 1. 逐条核对结果

| # | 计划项(上一轮问题) | 状态 | 说明 |
| --- | --- | --- | --- |
| F1 | README.md 删除旧文案「变更后需新建会话/重开工作区生效(与 skills 一致)」,新文案语义一致、无残留矛盾 | **通过** | ① README.md:45 现为「**保存后立即生效**(设置面板):已打开会话自动重建工具集(忙碌会话下一回合生效),删除/禁用立即断开连接并失效;手工编辑 mcp.json 需重启进程生效」——旧行已删,不再与新文案并存;② README.md:119(「配置方式与生效时机」小节)同义表述 +「工具调用时按最新配置解析」,两处互相一致,均与实现(rebuildHandle 重建 / busy 挂起 / 指纹失效 / 无 fs.watch)吻合;③ 全文检索「与 skills 一致」「变更后需新建会话」「重开工作区生效」在 README 中零残留;「新建会话/重开」仅剩 Skills 区(README.md:79「新增/修改 skill 后需重开会话…」)——skills 语义本就如此,与 MCP 形成正确区分,非矛盾 |
| F2 | docs/mcp.md §4 补 McpEntry fingerprint 字段 | **通过** | §4「生命周期与缓存」首行:`{ conn, tools, state: connected\|connecting\|error, error?, lastCheckedAt, fingerprint: 创建连接所用 config 指纹(null=从未连接) }`——fingerprint 已补;顺带修正的 `state` 枚举与实现一致(mcpTools.ts:356 `state: 'connected' \| 'connecting' \| 'error'`) |
| F3 | mcpRefresh.test.ts 降级用例改名 + 断言真实有效 | **通过** | ① 测试名已改为「重开失败 → 回退 openSession(workspace) 新建会话,不抛错,**usage 不迁移**」(mcpRefresh.test.ts:197),与实现语义相符;② fallbackHandle 改用与 makeHandle 默认值(usage 10/20/30、lastActivityAt 1234)不同的全零 usage + `lastActivityAt: null`;③ 断言不再是空洞对比:`expect(result.usage).not.toEqual(oldHandle.usage)`、`expect(result.lastActivityAt).toBeNull()`、`not.toBe(oldHandle.lastActivityAt)`——若实现改为迁移 usage/lastActivityAt,这三条必挂,真实锁定「降级不迁移」语义;另保留 `openSession` 两次调用入参(workspace,'s1')→(workspace)与 `errorLog` 断言 |
| F4 | mcpTools.ts configFingerprint 的 env 按键排序序列化 | **通过** | mcpTools.ts:341-347:`env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))`——键排序后 fromEntries 重建对象,JSON.stringify 按插入序输出,指纹与 env 原始键序无关;注释说明意图;`Object.entries` 返回新数组,sort 不污染原 config.env;比较运算符仅用于排序不改变相等语义 |

## 2. 修复 commit 独立性与回归核验

- **commit 独立**:`.git/logs/HEAD` 确认 `ce13933 → 616e41e44cc65c91bbdf9e766561cc85eaada8c1`「fix: 审查修复(README 旧文案残留 / 降级用例空洞断言 / 指纹 env 键序 / 文档补 fingerprint)」,独立新 commit,未 amend/混入其他改动;改动文件清单(README.md / docs/mcp.md / mcpRefresh.test.ts / mcpTools.ts)与报告一致。
- **无新行为**:唯一功能改动是 F4 的 env 排序——指纹对同内容配置输出不变,仅「键序不同但内容相同」的配置不再误判变化(即修复意图本身);等值/不等值语义对同键序配置完全保持;`configFingerprint` 仅两处消费(listTools 缓存命中 :375、ensureConn 重建 :480),均为对称比较,不受排序影响;mcpTools.test.ts 无直接引用 configFingerprint(全文检索零命中),指纹相关用例走 listTools/ensureConn 间接路径,无破坏面。
- **测试范围**:mcpRefresh.test.ts 仍为 7 用例,仅降级用例改名+强化断言;mcpTools.ts 其余部分(ensureConn :477-487、closeEntry :491-496、McpEntry :352-357)与上一轮通过状态逐行一致,无额外改动。
- **自检结果**(执行报告,未能独立复跑):api 15 文件 292 passed | 1 skipped(与基线同数,无新增用例、无回归)、web 53 passed、typecheck 通过。

## 3. 问题清单

| # | 级别 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- | --- |
| — | 无阻断项 | — | 本轮 4 项全部修复到位 | — |
| O1 | P3(观察项,不在本轮 F1–F4 范围) | AGENTS.md:22 | 「…配置变更后需新建会话/重开工作区生效;详情见 docs/mcp.md」——该句与新的「保存即生效」行为矛盾,且与其指引的 docs/mcp.md(已更新)不一致;上一轮未列入问题清单、本轮修复 commit 亦未触及,属遗留文案 | 下轮随手改为「保存后立即生效(设置面板);手工编辑 mcp.json 需重启」,或并入 docs 同步 |

## 4. 最终建议

**通过**。F1–F4 全部正确修复,无新回归;O1 为范围外观察项,不阻断,可并入后续任意文档同步顺手处理,无需打回。
