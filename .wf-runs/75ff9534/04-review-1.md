# 代码审查:ChatPane 输入提示增强 + Tab 选择 skill

> 审查对象:`.wf-runs/75ff9534/03-execution-1.md`(本 run 无 02-plan 文件,以任务说明为审查基准;现有 `/` 下拉基线对照 `.wf-runs/8315c3f1/02-plan-2.md` 与 `03-execution-1.md`)。
> 审查方式:静态审查(本环境无 shell 工具,无法复跑 pnpm test/typecheck/lint;执行报告自检声明 29 tests / typecheck / lint 全绿,以下逐条静态核验)。

## 结论:pass

## 逐条核对结果

### 需求 ① 输入框提示增强

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| 占位符提示用户 `/` 可搜索 skills | 通过 | `ChatPane.vue:413` 有工作区占位符改为 `'输入消息,输入 / 可搜索 skills,Enter 发送,Shift+Enter 换行…'`,明确包含 `/ 可搜索 skills`;保留原 Enter/Shift+Enter 提示,无信息丢失 |
| 不破坏无工作区分支 | 通过 | 同处三元表达式无工作区分支仍为 `'先在左侧选择一个工作区'`;新测试 `ChatPane.test.ts:189-195` 断言有工作区 `toContain('/ 可搜索 skills')`、无工作区 `toBe('先在左侧选择一个工作区')` 精确匹配 |
| 无残留旧文本 | 通过 | 全仓 grep `输入指令` 无任何匹配(旧占位符已彻底替换);`placeholder` 相关断言仅存在于新测试(191/194 行) |

### 需求 ② Tab 键选择当前高亮 skill

| 计划项 | 状态 | 说明 |
| --- | --- | --- |
| Tab 与 Enter 同行为(填入 `/skill:name` 不发送) | 通过 | `ChatPane.vue` onKeydown 新增 Tab 分支:`event.preventDefault()` + `selectSkill(filteredSkills[skillIndex])`;`selectSkill` 填入 `/skill:<name> `(带尾随空格)、关闭菜单、`nextTick` 重新 focus,与 Enter 分支共用同一函数,行为完全一致 |
| 焦点不丢 | 通过 | `preventDefault()` 阻止 Tab 默认焦点移出 + `selectSkill` 内 `nextTick(() => textareaRef.value?.focus())` 双保险;测试以 `attachTo: document.body` 挂载并断言 `document.activeElement === textarea.element`(jsdom 仅对已连接元素 focus 生效,方案正确,`apps/web/vitest.config.ts:13` 确认环境为 jsdom) |
| IME 组合中不触发 | 通过 | Tab 分支位于外层 `skillMenuOpen && filteredSkills.length > 0 && !event.isComposing` 条件内,`isComposing` 守卫天然覆盖 Tab;测试用 `new KeyboardEvent('keydown', { key: 'Tab', isComposing: true })` 断言 `defaultPrevented === false` 且菜单保持打开 |
| 下拉未打开时不拦截 | 通过 | Tab 分支仅在外层条件成立时进入;菜单关闭/无匹配时 Tab 落到函数末尾,无任何 preventDefault,走浏览器默认焦点移动;测试断言 `defaultPrevented === false`、值不变、不发送 |
| 与方向键/Esc 逻辑协调 | 通过 | Tab 分支插在 Enter 之后、Escape 之前,四者 key 互斥、各自 `return`,无穿透/覆盖;菜单打开但无匹配时 Tab 同样不拦截,与 Enter/Esc "无匹配走原逻辑" 的既有约定一致;注释已同步更新(方向键/Enter/Tab/Esc/IME/默认行为) |
| 选中后菜单不重开 | 通过 | `selectSkill` 填入 `/skill:<name> ` 后,watch 重算:query=`skill:<name>` 对任意 skill 名/描述无匹配 → `shouldOpen=false`,菜单保持关闭(测试断言菜单已关闭) |

### 测试用例质量(4 条新增)

| 用例 | 状态 | 说明 |
| --- | --- | --- |
| 占位符断言(含无工作区分支) | 通过 | `ChatPane.test.ts:189-195`,双分支覆盖,精确断言无工作区提示 |
| Tab 选择(填入/不发送/菜单关闭/焦点/defaultPrevented) | 通过 | `ChatPane.test.ts:130-155`:ArrowDown 高亮后 Tab → 断言值 `/skill:summarize `、`sendMessage` 未调用、菜单关闭、`document.activeElement === textarea`;另手动构造 `cancelable: true` 的 KeyboardEvent dispatch 断言 `ev.defaultPrevented === true`(直接断言 preventDefault 本身,比 VTU trigger 间接断言更可靠);`wrapper.unmount()` 正确清理 DOM |
| Tab 不拦截 | 通过 | `ChatPane.test.ts:157-170`:非 `/` 输入(菜单关闭)dispatch Tab → `defaultPrevented === false`、值不变、不发送 |
| IME 守卫 | 通过 | `ChatPane.test.ts:172-187`:`isComposing: true` → 不拦截、值不变、菜单保持打开;jsdom 支持 `KeyboardEventInit.isComposing` |
| 需求覆盖度 | 通过 | 需求两条各 2 项行为 + 边界(下拉关闭、IME)均有直接断言;基线 10 条用例(Enter/Esc/点击/blur/过滤/空态/切工作区/流式/无匹配走原逻辑)未改动,回归面完好 |

### 回归风险

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 现有 `/` 下拉与键盘逻辑 | 通过 | 仅新增 Tab 分支 + 更新注释 + 占位符文本;Enter/方向键/Esc/watch/`selectSkill` 全部未动 |
| 发送逻辑 | 通过 | `handleSend`、Enter 兜底发送分支(含 `!event.isComposing`)未动;`无匹配查询时菜单关闭` 用例仍验证 Enter 直接发送 `/skill:nope` |
| 其他测试受影响面 | 通过 | grep 确认无任何测试/快照引用旧占位符;`mountPane` 新增 `attachTo` 选项默认 `undefined`,既有 10 条用例挂载行为不变;ChatPane.test.ts 共 14 条(基线 10 + 新增 4),与报告 "25 → 29" 一致 |

## 问题清单

| 级别 | 文件/位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 低(建议) | `ChatPane.vue` onKeydown Tab 分支 | Tab 分支未区分 `event.shiftKey`:Shift+Tab 也会触发选中,而非反向焦点移动;与 Enter 分支的 `!event.shiftKey`(Shift+Enter 换行)不对称。任务说明未规定 Shift+Tab 行为,不构成需求违约 | 若需与浏览器默认一致,可加 `!event.shiftKey` 守卫让 Shift+Tab 走默认焦点移动;属可选细化 |
| 低(建议) | `ChatPane.test.ts:189-195` | 占位符用例创建的两个 wrapper(及 `Tab 不拦截`、`IME` 用例的 wrapper)未显式 `unmount()`,依赖 vitest 隔离;`attachTo` 用例已正确 unmount,无 DOM 泄漏风险 | 可加 `afterEach(() => wrapper.unmount())` 或 `enableAutoUnmount`,纯测试卫生 |

## 最终建议

**通过。** 两项需求均正确实现并有针对性测试覆盖:占位符提示含 `/ 可搜索 skills` 且无工作区分支不受影响;Tab 与 Enter 同行为(preventDefault、填入不发送、焦点不丢)、IME 组合不触发、下拉未打开时不拦截,与既有方向键/Esc 逻辑协调;4 条新测试直接断言关键行为(含 `defaultPrevented` 与 `activeElement`),jsdom 焦点方案(attachTo)正确。未发现代码级缺陷或回归风险,仅有 2 条低级别建议(Shift+Tab 语义、测试 unmount 卫生),不影响合入。
