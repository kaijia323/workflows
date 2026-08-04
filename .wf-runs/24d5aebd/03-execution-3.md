# 执行报告(第 3 轮):修复 04-review-1.md 问题 1、2

> 范围:仅修复审查报告 `04-review-1.md` 中指定的两个问题(中危 #1 截断、低危 #2 format),其余低危问题(#3-#6)按指示文档化取舍、不动;不扩大改动面。

## 改动文件清单

### 1. `apps/api/src/pi/anySearchTools.ts`(修改)

**问题 1 — 50KB 截断改为字节安全截断**
- 旧实现(L265-267):`Buffer.byteLength` 判定 + `text.slice(0, MAX_OUTPUT_BYTES)` 按 UTF-16 code unit 截断,全中文内容最坏输出 ≈ 153KB,与"50KB 字节截断"目标不符。
- 新实现:
  - 抽出 `TRUNCATION_MARKER = '\n\n[50KB limit reached]'` 常量,保留原有截断提示风格;
  - 截断预算 `limit = MAX_OUTPUT_BYTES - marker 字节数`,保证**截断内容 + 提示标记总字节 ≤ 50KB**(严格满足"不超过 50KB 字节",比审查建议的 `≤50*1024+64` 更紧);
  - 用二分查找(byteLength 判定)找到不超过 limit 字节的最大完整字符前缀,截断点按字符边界;
  - 若切点落在代理对中间(低代理位),回退 1 个 code unit 保住完整代理对,避免孤立代理编码后产生 U+FFFD 替换字符(乱码)。

**问题 2 — format 恒显式发送**
- 旧实现:body 构建时 `if (params.format !== undefined)` 才发送,未传时 API 按自身默认(可能 json),与工具描述"默认 markdown"不一致。
- 新实现:body 初始化即 `{ query: params.query, format: params.format ?? 'markdown' }`,恒发送 format(默认 markdown),使描述、请求、渲染三方一致;其余可选字段仍按 undefined 剔除。

### 2. `apps/api/src/pi/anySearchTools.test.ts`(修改)

- 更新既有用例"未传可选参数时 body 仅含 query"→ 断言 `{ query: 'only query', format: 'markdown' }`(问题 2 的请求体断言同步,名称改为"未传可选参数时 body 仅含 query 与默认 format")。
- 新增中文截断用例"50KB 截断(中文/多字节):按字节截断,字符边界完整,无乱码/替换字符":构造 60K 个中文(`'中'.repeat(60 * 1024)` ≈ 180KB 字节)的 content,断言:
  - 输出含 `[50KB limit reached]` 标记;
  - `Buffer.byteLength(result.text) ≤ 50 * 1024`(含标记的总字节);
  - 不含 `\ufffd` 替换字符(无乱码);
  - 头部与标记之间的截断内容匹配 `/^中+$/`(截断点落在字符边界,无被切半的字节)。

## 自检结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单测 | `pnpm --filter @workflows/api test` | ✅ 10 文件 / 153 用例全过(上轮 152 + 新增中文截断用例 1) |
| 类型检查 | `pnpm --filter @workflows/api typecheck` | ✅ 0 错误 |
| Lint | `pnpm --filter @workflows/api lint` | ✅ 0 错误 |
| 改动面 | `git status --short` | ✅ 仅两目标文件本次被改;未触碰其他文件(其余修改/未跟踪文件均为前两轮计划的产物) |

## 未完成项

无。问题 1、2 已修复并验证;审查报告其余低危问题(#3 shared 注释歧义、#4 空串=清空偏离、#5 max_results 越界、#6 观察项)按指示不动。
