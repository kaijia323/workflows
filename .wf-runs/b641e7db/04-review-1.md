# 审查报告:McpPanel「编辑已有 MCP server」功能

审查对象:`.wf-runs/b641e7db/02-plan-1.md`(计划 + 验收清单)、`01-exploration-1.md`、`03-execution-1.md`(含 2 处偏差声明)、实际改动文件 `apps/web/src/components/McpPanel.vue` / `McpPanel.test.ts`。

审查方式:只读。逐行核对两份改动文件 + 对照计划/探索报告;对执行报告声称的测试结果做了静态验证(Vue 3.5.40 runtime-core 源码、@lucide/vue 1.28.0 类型声明、eslint 配置、useAgent.ts 接口)。**注:本环境无 shell,无法独立复跑 `pnpm test` / `pnpm typecheck`**,下述结论基于代码级静态推演。

---

## 结论:pass

---

## 一、逐条核对(对照计划 §5 验收清单)

| # | 验收项 | 状态 | 说明 |
|---|---|---|---|
| 1 | 列表「编辑」按钮(icon+文案,位于「测试」左侧,样式对齐) | 通过 | `McpPanel.vue:297-308`,`<Pencil class="size-3"/>` + 文案,`data-testid="edit-{name}"`,hover 主色与「测试」一致。`Pencil` 已在 `@lucide/vue@1.28.0` d.ts 导出块中确认存在(`index_Pencil as Pencil`,lucide-vue.d.ts 约 25766 行),import 不悬空 |
| 2 | 点击编辑:name/command/args/env 正确回填;name `readonly` + 弱化样式 + title | 通过 | `startEdit`(`McpPanel.vue:147-157`)先 `resetForm()` 再回填四项;模板 `:readonly="editingName !== null"` + `cursor-not-allowed opacity-60` + title「name 不可修改…」(约 271-278 行)。args 用 `join(' ')`、env 用 `envToText` 与计划一致 |
| 3 | 编辑态标题/「保存修改」/「编辑覆盖保存到 mcp.json」/「取消」;新增态复原 | 通过 | 模板三处联动(标题约 265 行、底部提示约 316 行、提交按钮文案约 324 行)、`v-if="editingName"` 取消按钮约 318-326 行;`cancelEdit` 复位 `editingName=null` + `resetForm` |
| 4 | 编辑保存同 name 调用,`enabled` 透传原值(绝不 false) | 通过(核心) | `handleSave`(`McpPanel.vue:183-190`):`enabled = editing !== null ? servers.find(s => s.name === editing)?.enabled ?? false : false`;保存参数 `name: editing ?? name`。测试 #4 用 `objectContaining({ enabled: true })` 锁定,能防「复用 enabled:false」回归 |
| 5 | env 含空格/含 `=` 逐字回填、保存语义一致 | 通过 | `envToText`(约 65-72 行)与 `parseEnvText` 互逆:按第一个 `=` 切分、value 原样保留;`Object.entries().map(k=v).join('\n')` 无多余空白。测试 #3 严格断言 textarea 逐字值 `'A=1\nGREETING=hello world\nURL=https://x?a=1'` + `saveMcpServer` 收到深相等 env 对象。往返成立 |
| 6 | 保存成功:清空、退出编辑态、显示「已保存到 mcp.json」、自动测试 | 通过(测试覆盖小缺口) | 代码:`resetForm()` + `editingName=null` + `saved=true` + `void handleTest(editing ?? name)`(`McpPanel.vue:191-195`),自动测试逻辑存在。测试 #8 断言了清空/退出/「已保存」,但**未断言 `testMcpServer` 被调用**——「自动测试」未被测试锁定(见问题 3) |
| 7 | 取消:清空、退出编辑态、无 saved 残留 | 通过 | `cancelEdit` + 测试 #5(四输入空、按钮回「添加并测试」、提示复原、cancel-edit 消失、无「已保存」残留) |
| 8 | 编辑中切换目标:先复位再回填 | 通过 | `startEdit` 内 `resetForm()` 先行;测试 #10 断言 s2 回填、无 s1 残留 |
| 9 | 编辑态 env 非法行零容忍拦截(带行号) | 通过 | `handleSave` 保留 `parseEnvText` 前置校验、非法行早退不发请求;测试 #7 断言 `saveMcpServer` 未调用 + 行号文案 + 仍处编辑态 |
| 10 | 新增态行为与改动前一致;列表摘要编辑中不变 | 通过 | `handleSave` 新增分支与旧 `handleAdd` 逐行等价(校验→`enabled:false`→保存→清空→saved→自动测试);旧 6 用例未改(执行报告称全过);测试 #9 锁定编辑过程列表 env 摘要不变 |
| 11 | 后端 / useAgent.ts / shared / ApiKeyModal 零改动 | 通过 | 已读 `useAgent.ts:223-240`:`saveMcpServer` 仍为 PUT upsert + env 透传 + 内部 `refreshMcp`,与探索报告一致;改动文件仅 2 个(执行报告 git status 声明,无法独立复验) |
| 12 | `pnpm test` 全绿(6 旧+11 新)、`pnpm typecheck` 通过 | 无法独立复跑 | 静态推演未发现必然失败点(见下);测试 #6 依赖的 Vue 行为已对照安装的 `runtime-core@3.5.40` 源码验证成立 |

## 二、偏差审查(执行报告 §3,2 处)

### 偏差 1:name input 由 `v-model` 改为 `:value` + 条件 `@input`(McpPanel.vue 约 271-279 行)— 合理,通过

- **理由成立**:计划测试 #6 要求「`setValue('renamed')` 后 value 仍 's1'」。@vue/test-utils 2.4.11 的 `setValue` 直接写 `element.value` 并派发 `input` 事件,`readonly` 只拦真实键入;纯 `v-model` 下 `nameInput` 状态会被污染,该断言必然失败。执行者改为状态级短路,使「name 不可修改」成为实现级保证——与计划「handleSave 以 editingName 为准」的双保险思路一致,方向正确。
- **新增态等价性**:`editingName === null` 时 `@input` 赋值与 `v-model` 语义一致;模板内对 ref 赋值是 Vue 模板编译的标准支持写法,vue-tsc 可类型检查(`nameInput` 解包为 string,`$event.target as HTMLInputElement` 合法)。
- **测试 #6 机制已实证**:`$forceUpdate()` 后重渲染是否会把 DOM 值纠正回 `'s1'`,取决于 Vue 是否在值不变时也 patch `value`。已读安装的 `node_modules/.pnpm/@vue+runtime-core@3.5.40/.../runtime-core.esm-bundler.js`(约 5895 行):`patchElement` 的 `patchFlag & 8` 分支为 `if (next !== prev || key === "value") hostPatchProp(...)` —— **`value` 无条件 patch**,故 `$forceUpdate()` 后 `el.value` 被重设为 `'s1'`,断言成立。执行报告的测试通过声明可信。
- **遗留微差(非问题)**:手写绑定不含 `v-model` 的 IME composition 短路,但 name 字段仅允许 `[a-zA-Z0-9_-]`(后端校验),中文输入法场景无实际影响。

### 偏差 2:`makeServer` 去掉冗余 `name: overrides.name`(McpPanel.test.ts 约 37-40 行)— 合理,通过

- 计划写法 `{ name: overrides.name, ..., ...overrides }` 在 TS 6.0 下确实触发 TS2783(显式属性被后续 spread 覆盖),`vue-tsc -b` 会失败;实际写法语义完全等价且更简洁。

## 三、测试用例质量核对(11 条)

全部为真实断言,无空断言/恒真模式:

- #1 编辑按钮渲染/空列表不渲染(存在性 + 文本 + 计数)✅
- #2 回填 + UI 联动(5 项值断言 + 3 项文本断言 + cancel-edit 存在)✅
- #3 env 往返(逐字严格相等 + 深比较)✅
- #4 保存覆盖 + `enabled: true` 透传(核心回归,objectContaining 含 name/command/args/enabled/env 五项)✅
- #5 取消(4 input + textarea 空 + 文案复原 + 无残留)✅
- #6 name 只读(`readOnly === true` + 值断言 + 污染后强制重渲染纠正,机制已实证)✅
- #7 非法行拦截(未调用 + 行号 + 保持编辑态)✅
- #8 保存成功 UI 复原(清空/退出/「已保存」)✅(缺 testMcpServer 断言,见问题 3)
- #9 列表摘要/名称/命令编辑中不变 ✅
- #10 切换目标复位(值 + 无残留)✅
- #11 空 env → `env: undefined`(沿用仓库既有断言惯例)✅

helper(`makeServer`/`clickEdit`/`setForm`/`submitButton`)与仓库惯例一致:`setForm` 限定 form 作用域避开列表 checkbox 的做法正确(旧 `fillBasic` 的全局 `findAll('input')` 在有 server 列表时会命中 checkbox);`data-testid` 定位比按文本/索引更稳。

## 四、问题清单(均非阻塞,按优先级)

1. **【minor】`handleSave` 编辑态保存存在删除/切换竞态** — `McpPanel.vue:183-190`。`enabled` 取 `servers.find(editing)?.enabled ?? false`:若编辑 s1 期间用户在列表点了 s1 的「删除」(编辑态下列表按钮仍可用),保存会静默回退 `enabled:false` 并重建 s1。另:await 窗口内若用户切换编辑目标/取消,保存成功后 `resetForm()` 会清掉新目标的回填。均为计划自带行为(计划伪代码同构),边缘场景,建议后续在 `startEdit`/`handleSave` 增加互斥或在删除时退出编辑态,本轮可不改。
2. **【minor】测试 #6 耦合 Vue 内部行为** — `McpPanel.test.ts:228-233`。断言依赖 Vue 3.5 的「`value` 无条件 patch」(`next !== prev || key === "value"`)。已对照 3.5.40 源码验证成立,但属实现细节耦合,升级 Vue 时该用例可能失效;届时降级为仅断言 `readOnly` + 状态未被污染即可,测试注释已说明意图,风险可控。
3. **【minor】验收项「自动测试」未被测试锁定** — 计划验收清单第 6 条要求编辑保存后自动测试,代码有 `void handleTest(...)`(`McpPanel.vue:195`),但测试 #8 未解构 `testMcpServer` 断言调用。建议补一行 `expect(testMcpServer).toHaveBeenCalledWith('s1')`(`mountPanel` 已返回该 stub,零成本)。
4. **【info】新增态 `enabled: false` 无独立用例锁定** — 代码三分支正确(`McpPanel.vue:189`),测试 #4 仅锁定编辑态 `true`;新增态 false 由旧用例隐式覆盖,计划也未安排显式用例,可接受。
5. **【info】`submitButton(wrapper)!` 非空断言** — `McpPanel.test.ts:52-54` 及 4 处调用点。eslint 配置(recommended 集,已读 `apps/web/eslint.config.mjs`)未启用 `no-non-null-assertion`,不违规;若按钮文案匹配失败会抛 TypeError 而非清晰断言失败,可改为 `expect(...).toBeDefined()` 先行,非必须。

## 五、最终建议

**通过(pass)**。计划验收清单 12 项中 11 项经代码核对全部满足,1 项(测试/typecheck 复跑)受限于无 shell 未能独立复验,但静态推演未发现必然失败点:核心回归点(enabled 透传、env 往返、编辑态状态机)实现与测试双重锁定,2 处偏差均方向正确、理由充分且已实证,未引入类型错误/未使用变量/风格冲突。问题清单均为 minor 级增强建议(尤其问题 3 补一条断言),不构成打回理由。
