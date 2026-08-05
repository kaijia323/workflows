# 执行报告(第 2 轮:审查修复)

> 依据 `.wf-runs/9c4a0796/04-review-1.md` 修复,commit `616e41e`(独立新 commit,基线 `ce13933`)

## 改动文件清单

| 文件 | 改动内容 | 原因 |
| --- | --- | --- |
| `README.md` | 删除 MCP 配置 bullet 中旧文案「变更后需**新建会话/重开工作区**生效(与 skills 一致)」,保留「保存后立即生效(设置面板)…;手工编辑 mcp.json 需重启进程生效」 | F1(P1):旧文案与「保存即生效」新文案并存矛盾,且与实现相反 |
| `docs/mcp.md` §4 | McpEntry 描述补 `fingerprint: 创建连接所用 config 指纹(null=从未连接)`;顺带把 `state: connected\|error` 修正为实现的 `connected\|connecting\|error`(同一行,与 mcpTools.ts:354-361 一致) | F2(P2):文档与实现漂移 |
| `apps/api/src/pi/mcpRefresh.test.ts` | 降级用例:① 测试名「…usage 迁移」→「…usage 不迁移」;② fallbackHandle 改用非默认 `usage`(全零)与 `lastActivityAt: null`,断言改为「保留 fallback 自身值 + 显式 `not.toEqual(oldHandle.usage)` / `not.toBe(oldHandle.lastActivityAt)`」 | F3(P2):原断言两 handle 共用 makeHandle 默认值,无论实现是否迁移都通过(空洞);现锁定「降级路径不迁移」真实语义 |
| `apps/api/src/pi/mcpTools.ts` | `configFingerprint` 对 env 先按键排序(`Object.entries(env).sort(...)`)再序列化,附注释 | F4(P2):不同写入路径键序不一致时不误判指纹变化,避免多余 close+重建 |

## 自检结果

- `pnpm -C apps/api test`:15 文件 **292 passed | 1 skipped**(与基线一致,无回归)
- `pnpm -C apps/web test`:5 文件 **53 passed**
- `pnpm -C apps/api typecheck`(tsc --noEmit):通过
- pre-commit hook(eslint --fix + turbo typecheck + turbo test):全部通过(api 292 passed | 1 skipped;web 53 passed)
- 全文检索 README.md 无 MCP 配置相关旧文案残留(「新建会话」仅剩 Skills 区,语义正确,与 MCP 无关)

## 未完成项

无。F1–F4 全部完成;未扩大改动范围(未改功能行为、未新增依赖、未改 SDK)。
