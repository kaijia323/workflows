# 探索报告:子代理详情模态窗 footer 摘要重复渲染

## 1. 仓库概览

- **Monorepo**(pnpm + turborepo):`apps/web`(Vue 3 + Vite + TypeScript,`@lucide/vue` 图标,`marked` 渲染 markdown)、`apps/api`(Node + `@earendil-works/pi-coding-agent` SDK,子代理运行器)、`packages/shared`(共享类型)、`docs/`。
- **测试**:Vitest;前端测试与源码同目录(`*.test.ts`),后端 `apps/api/src/**/*.test.ts`。
- 前端状态中心:`apps/web/src/composables/useAgent.ts`(`useAgent()`,SSE 流式事件 → 响应式状态)。

## 2. 需求相关模块清单

| 文件 | 说明 |
|---|---|
| `apps/web/src/components/SubAgentModal.vue` | **问题主文件**:子代理详情模态窗(header / 思考工具条 / body 消息流 / footer 摘要+产物) |
| `apps/web/src/composables/useAgent.ts` | `subSessions` 容器(Map<callId, UiSubSession>);`sub_end` 事件写入 `sub.summary`/`sub.artifact`(L547-558);`fetchSubHistory` 历史回看 |
| `apps/web/src/components/MessageBubble.vue` | 消息气泡渲染组件,**内容区 markdown 渲染位置**(`renderMarkdown` @ L60 / L111) |
| `apps/web/src/utils/markdown.ts` | `renderMarkdown`(marked 封装,HTML 转义防注入,未闭合 fence 补全) |
| `apps/api/src/pi/subAgent.ts` | `runSubAgent` / `extractSummary`:**summary = 子代理会话最后一条 assistant 文本**(L~250-270),与消息流同源 |
| `apps/api/src/pi/piService.ts` | `createSubAgentTool`:`sub_end` 事件携带 `summary`/`artifact`(L~472、L~491) |
| `apps/web/src/App.vue` | 挂载 `SubAgentModal`(L78-84,`subModal` ref 控制开合) |
| `apps/web/src/composables/useAgent.test.ts` | sub_end 状态断言(与渲染无关) |
| `apps/api/src/pi/subAgent.test.ts` | `toSubEvents` 事件镜像测试(与渲染无关) |

## 3. 关键发现

### 3.1 重复的根因:同一份文本,两条渲染路径

```
子代理最终回复(摘要文本)
 ├─ 路径 A(消息流):sub_message_start + sub_text_delta 增量事件
 │    → useAgent.ts L490-515 写入 sub.messages 最后一条 assistant 消息
 │    → 模态窗 body 经 MessageBubble 用 renderMarkdown 渲染 ✅(markdown)
 │
 └─ 路径 B(footer 摘要):后端 extractSummary(session) 取「最后一条 assistant 文本」
      → runSubAgent 返回 summary(subAgent.ts)
      → piService 发 sub_end{ summary }(piService.ts L~472/491)
      → useAgent.ts L556 sub.summary = event.summary
      → 模态窗 footer 用 {{ summary }} 纯文本渲染 ❌(重复,且非 markdown)
```

`extractSummary`(subAgent.ts)与流式消息取自**同一条 assistant 消息文本**(截断 2000 字符),因此 footer 摘要与 body 最后一条消息内容一致 → 视觉重复。

### 3.2 footer 摘要渲染代码(待移除)

`apps/web/src/components/SubAgentModal.vue`:

- **L32**:`const summary = computed(() => live.value?.summary ?? '')`(数据源:`subSessions.get(callId)?.summary`,由 `sub_end` 写入;仅 footer 使用此变量)
- **L159-167** 模板(纯文本插值,非 markdown):

```html
      <!-- 底部:摘要 + 产物 -->
      <div class="shrink-0 border-t border-hairline px-5 py-3">
        <p
          v-if="summary"
          class="text-xs leading-relaxed text-body"
        >
          <span class="font-display text-[10px] tracking-[0.2em] text-mute">摘要 </span>
          {{ summary }}
        </p>
```

### 3.3 内容区(重复内容的 markdown 渲染位置)

- `SubAgentModal.vue` L124-137:body 滚动区,`v-for="msg in messages"` 渲染 `MessageBubble`(L129-134)
- `MessageBubble.vue` L111:assistant 正文块 `v-html="renderMarkdown(block.text) + (block.caret ? CARET_HTML : '')"` ← **摘要文本在内容区的 markdown 渲染点**
- `MessageBubble.vue` L60:用户消息同样走 `renderMarkdown`
- 历史回看路径(`fetchSubHistory`,useAgent.ts L637-652)下 `live` 为 null → `summary` 恒为空,footer 本来就不显示摘要;移除后两路径行为统一。

### 3.4 模态窗布局(SubAgentModal.vue)

| 区域 | 行号 | 内容 |
|---|---|---|
| header | L83-108 | agentName / callId / 状态徽标(运行中/失败/完成)/ 关闭按钮(唯一关闭入口,在 header) |
| 思考块工具条 | L110-122 | THINKING 全局展开/收起(仅 `messages.some(hasThinking)` 时) |
| body(内容区) | L124-157 | 历史加载态 / 错误态 / MessageBubble 消息流 / 空态 |
| **footer** | **L159-174** | **L161-167 摘要(纯文本,待移除)+ L168-173 产物 artifact(保留)** |

footer 其余用途:**产物 artifact 链接行(L168-173,`{{ artifact }}`)**;无按钮、无关闭(关闭在 header)。→ 只需删除摘要 `<p>` 块,不动 artifact 块。

### 3.5 相关测试

- **无 `SubAgentModal.test.ts`** 组件测试(components 目录确认过)。
- `apps/web/src/composables/useAgent.test.ts`:
  - L226 `'sub_end 带 isError 时子代理会话置为 error,模态窗不再显示「● 运行中」(回归)'` — 断言 `sub.summary`/`sub.status` 状态值(L250),**只测数据层,不受渲染改动影响**
  - L259 `'error 事件(回合中断)时收尾所有运行中的子代理会话(回归)'`
- `apps/api/src/pi/subAgent.test.ts`:`toSubEvents` 镜像测试(后端,不受影响)。
- `apps/web/src/App.test.ts`:仅三栏挂载,不涉及模态窗。

## 4. 风险点

1. **失败调用场景**(`sub_end` 带 `isError`):`summary` = 错误消息文本(如「子代理 planner 执行失败:boom」),该文本**不在 sub.messages 消息流中**(只出现在主代理 `tool_end` 的 output)。移除 footer 摘要后,失败原因在模态窗内不再可见。若产品可接受(主消息流 DAG/工具块已展示),直接移除;否则可考虑仅对 `isError` 保留或提示(超出"最小改动")。
2. `summary` computed(L32)移除渲染后将无引用 → TS `noUnusedLocals` 可能报错,建议一并删除(或确认 eslint 配置后处理)。
3. 后端 `sub_end` 的 summary 仍被 **DagPanel.vue**(`run.agents[].summary`,来自 run 快照,独立数据源)使用,不可删后端逻辑;本次改动严格限定在 `SubAgentModal.vue` 内。
4. 历史回看路径 footer 摘要本就不显示,移除后无行为回归。

## 5. 结论与移除方案建议(最小改动)

**可行性:高。** 改动可完全收敛在单文件 `apps/web/src/components/SubAgentModal.vue`:

1. **删除模板 L161-167**(整个摘要 `<p v-if="summary">…{{ summary }}</p>`),footer 仅保留产物块(L168-173);注释 L159 可同步改为「底部:产物」。
2. **删除脚本 L32** `const summary = computed(() => live.value?.summary ?? '')`(避免未使用变量)。
3. 不动 `useAgent.ts`、后端 `sub_end` 事件与 `UiSubSession.summary` 字段(DAG 与 run 快照仍在用)。
4. 无现有测试覆盖该渲染,可顺手补一条 `SubAgentModal.test.ts`(选做;若补,验证 footer 无「摘要」文本、body 消息流仍渲染 summary 文本)。

预期效果:模态窗 body 消息流(最后一条 assistant 消息,markdown 渲染)保留摘要,footer 仅剩产物链接,重复展示消除。
