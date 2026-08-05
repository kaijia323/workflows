# 实施计划:设置模态窗(ApiKeyModal)"垂直 tabs"布局改造

> 依据探索报告:`.wf-runs/f1feaf9b/01-exploration-1.md`
> 结论:核心改动集中在 `apps/web/src/components/ApiKeyModal.vue`(壳层重构)+ 新增 `ApiKeysPanel.vue`;`McpPanel.vue` **零改动**;数据层(App.vue / useAgent.ts / 后端)零改动;不引入新依赖。

---

## 1. 目标与范围

### 做什么
1. 将设置模态窗(`ApiKeyModal.vue`,标题"连接 · CONNECT")从"单列垂直堆叠 + 整窗滚动"改造为**垂直 tabs**布局:
   - 模态窗加宽至 `max-w-3xl`(参照 `SubAgentModal.vue` 先例),`flex flex-col` 结构:标题条 / 主体行 / 底部信息条;
   - 主体行 = 左侧垂直 tab 导航(参照 `WorkspaceRail.vue` 激活态范式:`border-l-2 border-l-primary bg-canvas-soft`)+ 右侧内容区(独立滚动);
   - tab 划分:两个 tab —— **API Keys**(DeepSeek + AnySearch 两个 key 表单)/ **MCP Servers**(现 `McpPanel.vue` 原样嵌入);
   - 默认激活 **API Keys**;
   - 环境信息区块(meta)→ 移到模态窗**底部常驻信息条**(footer,不随 tab 切换),不删除。
2. 把 API Keys 两个表单区块(含全部 ref/方法)从 ApiKeyModal 抽成**新子组件** `ApiKeysPanel.vue`;ApiKeyModal 只保留:壳层、标题条、tab 状态(`activeTab`)、左导航、内容区、footer。
3. tab 切换用 `v-show`(两个面板常驻 DOM),保证**切 tab 时已填表单输入不丢失**;McpPanel 的 `onMounted → refreshMcp()` 保持"打开模态窗即拉取一次"的现状行为。
4. 补可选单元测试 `ApiKeyModal.test.ts`(参照 `WorkspacePickerModal.test.ts` 范式)。

### 不做什么
- **不动数据层**:`App.vue`(showSettings / 挂载机制)、`composables/useAgent.ts`、后端 API 全部零改动;
- **不改 `McpPanel.vue`**(含其根元素 class、内部逻辑)——它已自带 `mt-6 border-t` 分隔样式,在新内容区中与 ApiKeysPanel 内部区块间距(mt-5/mt-6)基本一致,无需微调;
- 不做小屏专门响应式降级(与 SubAgentModal 现状一致,靠 `w-full max-w-3xl` + `min-w-0`/`truncate` 防溢出);
- 不引入新依赖;不做 tab 切换动画;不重构 useAgent 或 shared 类型。

---

## 2. 关键设计决策(已定,executor 直接执行)

| 决策点 | 结论 | 理由 |
|---|---|---|
| 模态窗宽度 | `max-w-3xl`(768px),`flex max-h-[85vh] w-full flex-col`,去掉 `p-6`/`overflow-y-auto`(改由内容区滚动) | 用户指定参照 SubAgentModal 先例;左导航 w-44(176px)后内容区仍有 ~540px |
| 左导航宽度 | `w-44 shrink-0` + `border-r border-hairline` | 仅两项文字导航,w-60(WorkspaceRail)过宽;w-44 从容容纳主标题 + mono 副行 |
| tab 划分 | 2 个:API Keys / MCP Servers;不拆 AnySearch | AnySearch 与 DeepSeek 同属 key 配置,现即同区块组,拆开碎片化 |
| 默认 tab | `activeTab = ref<'api' | 'mcp'>('api')` | ChatPane"配置 DeepSeek API KEY"入口的意图就是配 key |
| 切 tab 输入保留 | `v-show`(两面板常驻 DOM) | 比 KeepAlive 简单、无额外语义;输入与 McpPanel 内存态(testResults)天然保留 |
| 环境信息 | 底部 footer 常驻(`shrink-0 border-t`,内容 `v-if="meta"`),不并入任何 tab | 环境/配置目录对 key 与 MCP(mcp.json)都相关;不占内容区滚动空间;与 SubAgentModal"标题+内容+底部"结构一致 |
| 空态 | 无需额外处理:两个 tab 均有固定表单;MCP 空列表由 McpPanel 自带"尚未配置 MCP server"文案 | — |
| McpPanel | 原样嵌入(`<McpPanel :agent="agent" />`,包在 `v-show` 里) | 零改动满足约束;其根元素 `mt-6 border-t pt-4` 与 ApiKeysPanel 内部区块间距风格统一 |
| 关闭按钮 | 保留现有文字"关闭"按钮,移入标题条右侧 | 最小改动;统一为 X 图标列为可选增强(P2) |

---

## 3. 实施步骤

### Step 0:基线确认(不改代码)
- 命令:`git status` 确认工作区干净;`git log --oneline -3` 记录当前 HEAD(回滚锚点)。
- 确认 `apps/web/src/components/` 下无 `ApiKeysPanel.vue` 冲突。
- 预期结果:无未提交改动,记录 HEAD。

### Step 1:新建 `apps/web/src/components/ApiKeysPanel.vue`
从 ApiKeyModal 原样搬移 **DeepSeek + AnySearch 两个 key 区块**的脚本与模板,组件只负责这两个表单。

**文件**:`apps/web/src/components/ApiKeysPanel.vue`(新增)

**改动点**:
- `<script setup lang="ts">`:
  - `import { ref } from 'vue'`;`import type { AgentStore } from '../composables/useAgent'`;
  - `const props = defineProps<{ agent: AgentStore; meta: { workflowsRoot: string; environment: string } | null }>()`(meta 供 DeepSeek 说明文字的 `meta?.environment === 'production' ? '~/.workflows' : '.workflows'` 引用,原样保留);
  - 原样搬入:`keyInput / saving / error / saved / anyKeyInput / anySaving / anyError / anySaved` 8 个 ref + `handleSave()` + `handleAnySave()`(逻辑逐字不变,`props.agent.saveApiKey(...)` 等调用不变)。
- `<template>`:根元素 `<div>`(无 class);内部**原样**保留:
  - DeepSeek 区块(标题 `mt-5` 起);
  - AnySearch 区块(`mt-6 border-t border-hairline pt-4` 起)。
  - 两个区块的说明文字、表单、徽标(已配置/未配置)、错误/成功提示全部逐字搬移。
- 无 `<style>` 块(纯 utility class,与仓库一致)。

**预期结果**:新组件独立可渲染,行为与原来两个区块完全一致(保存/清空/徽标逻辑)。

**验收**:
- [ ] ApiKeysPanel 仅含两个 key 表单区块,无壳层/导航/环境信息;
- [ ] `handleSave` 仍调 `props.agent.saveApiKey(key)` 且保存成功后清空 `keyInput`;
- [ ] `handleAnySave` 空输入=清空语义不变(直接传 `anyKeyInput.value`)。

### Step 2:改造 `apps/web/src/components/ApiKeyModal.vue`(壳层 + 垂直 tabs)
**文件**:`apps/web/src/components/ApiKeyModal.vue`(修改)

**改动点**:
1. **script 部分**:
   - 删除已搬走的 8 个 ref 与 2 个方法(保留 `props` / `emit` 定义);
   - 新增 `import ApiKeysPanel from './ApiKeysPanel.vue'`(McpPanel import 保留);
   - 新增:`type TabId = 'api' | 'mcp'` + `const activeTab = ref<TabId>('api')`。
2. **template 部分**(整窗结构重构,目标结构如下,照此实现):

```html
<template>
  <!-- 遮罩:不变 -->
  <div class="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-canvas/80 p-6 backdrop-blur-sm"
       @click.self="emit('close')">
    <!-- 壳:参照 SubAgentModal;去掉 p-6 与 overflow-y-auto -->
    <div class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-md border border-hairline bg-canvas shadow-modal">
      <!-- 标题条 -->
      <div class="flex shrink-0 items-center justify-between border-b border-hairline px-5 py-3">
        <span class="font-display text-[14px] font-semibold tracking-[0.15em] text-ink">连接 · CONNECT</span>
        <button type="button"
                class="rounded-sm border border-hairline px-2 py-0.5 font-mono text-[10px] text-body hover:border-err/50 hover:text-err"
                @click="emit('close')">关闭</button>
      </div>

      <!-- 主体:左导航 + 右内容 -->
      <div class="flex min-h-0 flex-1">
        <!-- 左导航:抄 WorkspaceRail 激活态语言 -->
        <nav class="flex w-44 shrink-0 flex-col border-r border-hairline">
          <div class="px-4 pb-2 pt-3.5">
            <span class="font-display text-[10px] font-semibold tracking-[0.2em] text-mute">配置 · CONFIG</span>
          </div>
          <div class="min-h-0 flex-1 space-y-1.5 px-2.5 py-1">
            <!-- Tab 1:API Keys(默认激活) -->
            <button type="button"
                    class="block w-full rounded-sm border-l-2 px-3 py-2.5 text-left transition-colors duration-200"
                    :class="activeTab === 'api' ? 'border-l-primary bg-canvas-soft' : 'border-l-transparent hover:bg-canvas-soft/60'"
                    @click="activeTab = 'api'">
              <span class="block truncate text-[13px] font-medium"
                    :class="activeTab === 'api' ? 'text-ink' : 'text-body'">API Keys</span>
              <span class="mt-0.5 block truncate font-mono text-[10px] text-mute">对话模型 · 网络搜索</span>
            </button>
            <!-- Tab 2:MCP Servers -->
            <button type="button"
                    class="block w-full rounded-sm border-l-2 px-3 py-2.5 text-left transition-colors duration-200"
                    :class="activeTab === 'mcp' ? 'border-l-primary bg-canvas-soft' : 'border-l-transparent hover:bg-canvas-soft/60'"
                    @click="activeTab = 'mcp'">
              <span class="block truncate text-[13px] font-medium"
                    :class="activeTab === 'mcp' ? 'text-ink' : 'text-body'">MCP Servers</span>
              <span class="mt-0.5 block truncate font-mono text-[10px] text-mute">外部工具</span>
            </button>
          </div>
        </nav>

        <!-- 右内容区:独立滚动 -->
        <main class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <ApiKeysPanel v-show="activeTab === 'api'" :agent="agent" :meta="meta" />
          <McpPanel v-show="activeTab === 'mcp'" :agent="agent" />
        </main>
      </div>

      <!-- 底部环境信息:常驻 footer(原 meta 区块迁至此,单行 flex 化) -->
      <div v-if="meta"
           class="flex shrink-0 items-center justify-between gap-4 border-t border-hairline px-5 py-2.5 font-mono text-[10px] leading-relaxed text-mute">
        <p class="flex items-center gap-2"><span>环境</span><span class="text-body">{{ meta.environment }}</span></p>
        <p class="flex min-w-0 items-center gap-2">
          <span class="shrink-0">配置目录</span>
          <span class="truncate text-body" :title="meta.workflowsRoot">{{ meta.workflowsRoot }}</span>
        </p>
      </div>
    </div>
  </div>
</template>
```

3. 删除原模板中 DeepSeek / AnySearch 区块、McpPanel 直嵌位置、原 meta 区块(均已被上述结构取代)。

**预期结果**:模态窗呈"标题条 + 左 tab 导航 + 右内容区 + 底部信息条",两 tab 可切换,输入保留。

**验收**:
- [ ] 壳层为 `max-w-3xl` + `flex flex-col` + `max-h-[85vh]`,遮罩 `@click.self` 关闭不变;
- [ ] 左导航仅两项,默认 `activeTab='api'` 高亮(`border-l-primary bg-canvas-soft`),点击切换高亮跟随;
- [ ] 内容区 `min-h-0 flex-1 overflow-y-auto`,左侧导航 / 标题条 / footer 不随内容滚动;
- [ ] `v-show` 切换:API Keys 输入未保存时切到 MCP 再切回,输入仍在;MCP 添加表单同理;
- [ ] 环境信息出现在底部 footer,`meta` 为 null 时不渲染,切 tab 不消失;
- [ ] diff 中不出现 App.vue / useAgent.ts 的改动。

### Step 3:静态验证
**命令**(在仓库根执行):
- `pnpm --filter @workflows/web typecheck`(vue-tsc -b)
- `pnpm --filter @workflows/web lint`(eslint .)
- `pnpm --filter @workflows/web test`(vitest run;现有 App.test / ChatPane.test / WorkspacePickerModal.test / useAgent.test 应全绿,本次改动不触碰它们)

**预期结果**:三条命令全部通过;若 lint 报格式问题,只修新文件的格式,不改逻辑。

### Step 4:手动验证(`pnpm --filter @workflows/web dev`)
按以下清单逐项手测(核心验证路径):

1. **入口**:PipelineHeader"设置"按钮、ChatPane 空态"配置 DeepSeek API KEY"均可打开设置窗;
2. **布局**:窗口加宽(max-w-3xl);顶部标题"连接 · CONNECT"+ 关闭按钮;左侧"配置 · CONFIG"导航(API Keys 默认高亮,绿左缘 + bg-canvas-soft);右侧内容区;底部环境/配置目录;
3. **tab 切换**:点"MCP Servers"→ 右侧切换为 MCP 面板(含安全警告、server 列表、添加表单),左导航高亮移动;再切回 API Keys;
4. **输入保留**:API Keys 输入 key(不保存)→ 切 MCP → 切回,输入仍在;MCP 添加表单填入 name/command → 切走再切回,仍在;
5. **滚动**:MCP 列表+表单较长时,仅右侧内容区滚动,左导航/标题/footer 固定;窗口不整体滚动;
6. **MCP 功能回归**:刷新、启用 checkbox、测试(结果展开)、删除、"添加并测试" 与改造前行为一致;打开模态窗时 `refreshMcp` 触发一次(Network 面板确认无重复请求);
7. **API Keys 功能回归**:DeepSeek 保存(成功/失败提示、已配置徽标)、AnySearch 保存、空输入清空语义不变;
8. **环境信息**:footer 显示 environment 与 workflowsRoot(长路径截断,title 悬停可见全文);
9. **关闭**:遮罩空白处点击、关闭按钮,均正常关闭;重开正常;
10. **小屏兜底**:浏览器缩窄至 ~800px,模态窗 `w-full` 自适应,无横向溢出(内容 truncate/min-w-0 生效)。

### Step 5(可选,P2):新增 `apps/web/src/components/ApiKeyModal.test.ts`
参照 `WorkspacePickerModal.test.ts` 范式(mount + stub fetch/agent + flushPromises):
- agent stub:`{ hasApiKey: ref(false), hasAnySearchApiKey: ref(false), saveApiKey: vi.fn(async()=>{}), saveAnySearchApiKey: vi.fn(async()=>{}), refreshMcp: vi.fn(async()=>{}), mcp: ref({ servers: [], status: [] }) } as unknown as AgentStore`;
- `global.stubs: { McpPanel: true }` 隔离 McpPanel(避免其 onMounted 副作用);
- 用例:① 渲染标题"连接 · CONNECT"与两个 tab 按钮;② 默认 API Keys 面板可见(v-show)且 API Keys tab 高亮;③ 点击"MCP Servers"后切换(v-show 断言);④ 输入保留:在 key input setValue 后切 tab,再切回,值仍在;⑤ meta 传入时 footer 渲染环境信息、meta 为 null 时不渲染。

**预期结果**:`pnpm --filter @workflows/web test` 新增用例全绿。

---

## 4. 风险与回滚

### 风险
| 风险 | 影响 | 缓解 |
|---|---|---|
| `v-show` 双面板常驻 → McpPanel 打开即 refreshMcp | 与现状一致(现状打开即拉取),非新行为 | 不改动;Step 4.6 验证无重复请求 |
| flex 滚动布局缺 `min-h-0` | 内容区不独立滚动,整窗撑高 | 结构模板已含 `min-h-0`;Step 4.5 验收 |
| 加宽后小屏溢出 | 窄屏内容挤压 | `w-full` + 内容区 `min-w-0` + truncate;与 SubAgentModal 同取舍 |
| 误删环境信息/footer | 信息丢失 | `v-if="meta"` 保留;Step 4.8 验收 |
| 抽组件时误改保存逻辑 | key 保存行为变化 | Step 1 要求逐字搬移;Step 4.7 回归 |
| typecheck 类型报错(TabId / props) | 编译失败 | Step 3 前置验证 |

### 回滚方案
- 改动仅 2 个文件(1 改 1 增),无数据迁移、无依赖变更:
  ```bash
  git checkout -- apps/web/src/components/ApiKeyModal.vue
  rm apps/web/src/components/ApiKeysPanel.vue        # 新增文件
  # 若 Step 5 已加测试:rm apps/web/src/components/ApiKeyModal.test.ts
  ```
- 回滚后 `pnpm --filter @workflows/web test` 应回到基线全绿。

---

## 5. 验收标准(总清单)

- [ ] 设置窗为 `max-w-3xl` 垂直 tabs 布局:标题条(连接 · CONNECT + 关闭)/ 左导航 / 右内容区 / 底部环境信息条;
- [ ] 左导航 `w-44`、`border-r border-hairline`;激活项 `border-l-2 border-l-primary bg-canvas-soft`(WorkspaceRail 范式);两项:API Keys(默认激活)/ MCP Servers;
- [ ] 右侧内容区 `min-h-0 flex-1 overflow-y-auto` 独立滚动,左导航/标题/footer 固定;
- [ ] tab 切换(v-show)后已填输入保留(API Keys 与 MCP 添加表单均验证);
- [ ] McpPanel.vue 零 diff;其功能(刷新/启用/测试/删除/添加并测试)与改造前一致;
- [ ] 环境信息常驻 footer,`meta` 为 null 时隐藏;
- [ ] 打开/关闭机制不变(遮罩 self click + 关闭按钮),重开正常;
- [ ] diff 仅 `ApiKeyModal.vue`(改)+ `ApiKeysPanel.vue`(增)+ 可选测试文件;App.vue / useAgent.ts / 后端 / package.json 零改动;无新依赖;
- [ ] `pnpm --filter @workflows/web typecheck`、`lint`、`test` 全部通过(现有测试全绿);
- [ ] 手测清单(Step 4 十条)全部通过。

---

## 附:参考文件(只读,不改)
- `apps/web/src/components/WorkspaceRail.vue` — 左导航激活态范式(border-l-2 border-l-primary bg-canvas-soft / hover:bg-canvas-soft/60、标题 tracking-[0.2em])
- `apps/web/src/components/SubAgentModal.vue` — 宽模态窗结构(flex max-h-[85vh] w-full max-w-3xl flex-col + 标题条 border-b px-5 py-3)
- `apps/web/src/components/WorkspacePickerModal.test.ts` — 模态窗测试范式(agent stub + flushPromises)
- `apps/web/src/style.css` — token:canvas/canvas-soft/hairline/ink/body/mute/primary/err
