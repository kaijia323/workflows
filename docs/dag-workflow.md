# DAG 工作流设计文档(主代理编排模式)

> 状态:设计定稿,待实现
> 范围:本设计不涉及现有聊天/会话/工作区能力的重构,在其之上叠加「工作流编排」层。

## 1. 背景与目标

现状是单 agent 会话直接对话。本设计引入**主代理编排(orchestrator-workers)**模式:

- 一个**主代理(orchestrator)**:理解用户需求,临场决定流程——调谁、什么顺序、循环几次、要不要闸门
- 四个内置**子代理**:explorer(探索)、planner(计划)、executor(执行)、reviewer(审查)
- 子代理以「工具」形式暴露给主代理,与现有 `customTools` / `tool_*` 事件体系完全同构

设计原则:

1. **主代理只调度,不亲自探索**——避免消耗主上下文;子代理细节消耗在子代理自己的会话里,主代理只保留摘要
2. **人工闸门**——planner 产出计划后必须暂停,用户批准才执行
3. **黑板模式**——子代理间通过工作区文件共享产物,持久化且可 git 追踪
4. **事件易失,状态落盘**——SSE 只保证实时,恢复一律靠磁盘快照重建

## 2. 流程定义

```
用户需求 → explorer 探索 → planner 出计划
                                   ↓
                          ⏸ 人工闸门:【批准】/【驳回+意见】
                                   ↓
                          executor 执行 ⇄ reviewer 审查 → 交付
                          (审查不过打回,最多 N 轮)
```

- **审查打回**:reviewer 输出 fail → 主代理带问题清单再调 executor;连续打回可升级回 planner 重做
- **人工驳回**:带意见回 planner 修改计划(人工触发的一层 loop)
- **循环上限(代码兜底,不靠模型自觉)**:执行⇄审查 3 轮,回到 planner 全流程 2 次,超限强制收尾交付「未解决清单」
- **流程非固定**:简单需求(如改配置端口)主代理可只走 explorer → executor,不经过 planner/reviewer;复杂度由主代理临场判断

## 3. 配置体系:agent 文件化

所有代理(含主代理)定义为一个 markdown 文件:`frontmatter 声明能力 + 正文定义行为`。

### 3.1 文件位置与加载顺序

```
内置:apps/api/src/pi/agents/*.md     (随代码分发,只读)
用户: .workflows/agents/*.md          (同名覆盖内置,新名字 = 新增自定义代理)
```

加载顺序:**用户 > 内置**。新增/改写代理 = 丢一个 md 文件,零代码。

### 3.2 frontmatter 字段

```yaml
---
name: explorer           # 代理名(必填)
agents: [...]            # 仅主代理:可用子代理白名单;省略 = 可用全部已注册
tools: [...]             # 工具集;省略 = 只读默认(read / ls / fff-find / fff-grep)
write: [...]             # 可写目标;省略 = 纯只读;** = 全量写
---
```

- 值类型宽松:数组与单个字符串都接受,解析时统一转数组
- `write` 匹配语义:**相对工作区根**的逐段 glob(picomatch 风格)
  - `*.md` 只匹配根级,`**` 任意层级,`docs/**` 子目录
  - 产物动态目录用单层 `*` 匹配 runId:`.wf-runs/*/01-exploration-*.md`(`-N` 为同 run 内同角色调用序号)
  - 绝对路径、`..` 一律拒绝(沿用 workspaceGuard 哲学);glob 解析失败一律拒绝,不静默放行

### 3.3 内置四个子代理

| 代理 | 职责 | write |
| --- | --- | --- |
| explorer | 探索仓库需求,产出调研报告 | `.wf-runs/*/01-exploration-*.md` |
| planner | 基于探索报告出实施计划 | `.wf-runs/*/02-plan-*.md` |
| executor | 按计划改代码 | `**`(全量写) |
| reviewer | 对照计划审查改动,diff 校验,输出 pass/fail + 问题清单 | `.wf-runs/*/04-review-*.md` |

主代理(`orchestrator.md`):`agents: [explorer, planner, executor, reviewer]`,自身只保留只读工具(路由查证用),正文为调度策略(闸门触发时机、循环控制规则)。

## 4. 权限模型

| 子代理 | 读 | 写 |
| --- | --- | --- |
| explorer / planner / reviewer | 全量只读(read / ls / fff-find / fff-grep) | 白名单(各自产物文件) |
| executor | 同上 | 全量写(bash / edit / write)+ `03-execution-*.md` |

实现:基于现有 `guardPathTool` 扩展「白名单可写」模式(只读工具集 + 限定可写文件的 write 工具);executor 复用现有读写工作区完整工具集。搜索工具只有 fff(内置 grep/find 已废弃,不开放)。

## 5. 数据模型

### 5.1 run:一次需求处理

- **run 绑定「会话内的一次需求处理」**,不是与会话 1:1——一个会话可连续多次下发需求,产物各自隔离
- 开启规则(服务端判定):用户发新消息时,当前会话有**进行中**的 run(status 非 done)→ 归并进该 run(闸门续跑即此场景);否则 → 新建 run(新 runId)
- **回合释放**:回合结束(status 置 done)后服务端释放内存中的 run(`handle.run = null`),同一会话的下一个需求自动开新 run、新产物目录;仅 awaiting_approval(闸门等待)归并同一 run
- 删除会话**不删** `.wf-runs/` 产物(已进 git,是用户资产);`run.json` 的 sessionId 是归属索引

### 5.2 产物黑板(工作区,git 可追踪)

```
<工作区>/.wf-runs/<runId>/
├── run.json              ← { status, phase, gate, sessionId, artifacts[] }
├── 01-exploration-1.md   ← explorer 产物(planner 输入;同角色多次调用按序号递增)
├── 02-plan-1.md          ← planner 产物(闸门批准的就是最新一份)
├── 03-execution-1.md     ← executor 执行摘要 + 改动清单
└── 04-review-1.md        ← reviewer 审查报告(每轮独立文件,历史全部保留)
```

- 产物命名规则:`NN-role-N.md`——`NN-role` 沿用角色基名(`01-exploration` / `02-plan` / `03-execution` / `04-review`),`N` 为该 run 内同角色**已发生调用次数 + 1**(含失败调用);旧名 `NN-role.md` 结构性不可写(白名单只留 `-N.md` 模式),同一 run 内多轮调用各自独立文件,互不覆盖

run 状态机:`planning → awaiting_approval → executing → reviewing → done`。

### 5.3 子代理会话持久化(运行数据,.workflows)

```
.workflows/agent/sessions/<workspaceId>/sub/<runId>/<role>.jsonl
```

模态窗历史回看的数据源;与主会话 JSONL 同构,复用现有会话管理。

## 6. 事件流(SSE 单通道,双轨渲染)

主代理调用子代理 = 一次工具调用。新增 `sub_*` 事件 = 子代理会话事件的镜像,实现时复用 `mapSessionEvent` 套一层 callId 包装。

```
tool_start      {toolName: 'explorer', callId: 'c1'}        ← 主代理视角(现有事件)
sub_message_start {callId: 'c1', role: 'assistant'}          ← 子代理内部镜像
sub_tool_start    {callId: 'c1', toolName: 'read', ...}
sub_text_delta    {callId: 'c1', delta: '...'}
sub_end           {callId: 'c1', summary, artifact: '.wf-runs/r1/01-exploration-1.md'}
tool_end        {callId: 'c1', toolName: 'explorer', output: '<摘要>'}
```

前端分轨:

- **主聊天流**只渲染主代理事件(行为不变)
- `sub_*` 事件按 callId 归入模态窗数据容器(tool_start 创建,tool_end 关闭)
- 模态窗内容 = 子代理完整对话 + 内部工具调用 + 产物链接,复用聊天流渲染组件
- 历史回看:模态窗打开时内存无数据则从 sub JSONL 经 API 拉取

## 7. 闸门交互(回合制,无长连接)

```
planner 完成 → 主代理调用 wait_for_approval 工具(prompt 指示:计划完成后必须调用并停止)
    ↓
服务端收到该工具调用 → 记录闸门状态 + 发 gate_required 事件 → 回合自然结束(done)
    ↓
前端:计划摘要 + 【批准】【驳回+意见框】按钮
    ↓
批准 → POST /prompt("用户已批准计划,继续执行")   ← 复用现有 prompt 接口
驳回 → POST /prompt("用户驳回:<意见>,请修改计划") → 主代理回到 planner
```

- `wait_for_approval` 是普通工具:执行时只「通知前端 + 记录闸门状态」,返回占位值
- 闸门时机由主代理控制(prompt 指示),服务端零检测逻辑
- 优点:复用现有接口,无长连接、无异步工具结果;断线/重启后闸门点天然可恢复

## 8. 恢复与可靠性

**核心原则:事件易失,状态落盘;恢复 = 拉快照重建 UI,不重放事件。**

| 场景 | 恢复路径 |
| --- | --- |
| 刷新浏览器 | 拉 run 快照 + getHistory(现有)+ 子代理 JSONL → 重建聊天流 / DAG 图 / 模态窗 / 闸门按钮 |
| 断连重连(服务活着) | 同上;进行中的回合继续跑,重连后从快照看结果 |
| 重启服务 | 同上;主/子会话经 openSession 从 JSONL 恢复 |
| 运行中崩溃 | 中断回合标记为「已中止」(前端标注「上次运行在此中断」),用户重发 prompt 续跑——主代理上下文完好,自行判断重跑或继续 |

**新增接口**:`GET /api/agent/workspaces/:id/run` → run 快照 `{ runId, status, phase, artifacts[], gate: { pending, planFile }, agents: [...] }`。

闸门等待点是天然可恢复的中断点:回合已结束、计划已落盘,续跑只是一条新用户消息,不依赖内存状态。

## 9. 前端交互

- **布局**:右侧上下结构——上方 DAG 流程图(节点状态实时流转),下方保留现有信息面板
- **DAG 图**:粗粒度节点(explorer / planner / executor / reviewer),状态(运行中/完成/打回/第几轮角标);MVP 不做节点内下钻
- **模态窗**:点击图上节点或聊天中子代理块弹出:子代理完整对话 + 工具调用流水 + 产物文件链接
- 图上节点状态来自 run 状态机 + 事件流实时更新

## 10. 已知风险与待确认

1. **SDK systemPrompt 开口子**:`createAgentSession` options 未暴露 systemPrompt;SDK 内部有 `_systemPromptOverride` 与 `buildSystemPrompt({ customPrompt })` 支持。落地需:给 SDK 开扩展口或内部 hack,成本不为零
2. 内置 grep/find 已废弃,搜索只走 fff;bash 内禁 rg/fd 递归搜索——子代理工具集不要引入内置 grep/find

## 11. 实现顺序建议

1. shared 类型扩展:`sub_*` 事件、`gate_required`、run 快照、DagNode 状态
2. agent 配置加载:`agents/*.md` 解析(frontmatter + 正文)、用户优先加载、glob 匹配(`write`)
3. 子代理会话服务:`createAgentSession` 注入 systemPrompt(开口子)、子代理工具集构建、`mapSessionEvent` 镜像
4. 闸门与续跑:`wait_for_approval` 工具、`gate_required` 事件、续跑 prompt
5. run 生命周期:`run.json` 持久化、开启/归并规则、`GET /run` 快照
6. 前端:DAG 图(右侧上下结构)、模态窗、双轨事件渲染、闸门按钮
7. 收尾:循环上限校验、崩溃恢复标注、测试

## 12. 决策记录(已确认)

- 主代理编排 + 4 内置子代理(explorer / planner / executor / reviewer),可 loop
- 人工闸门(planner 后)必选;驳回带意见回 planner
- 子代理 = 主代理的工具;内部事件镜像为 `sub_*`
- 权限:全量只读 + `write` 白名单;executor 全量写
- 产物进工作区 `.wf-runs/<runId>/`,git 可追踪;删会话不删产物
- 子代理会话落 `.workflows/.../sub/<runId>/<role>.jsonl`,可回看
- agent 定义全文件化(frontmatter + md),用户覆盖/新增;write 支持 glob
- DAG 图放右侧上下结构;粗粒度节点 + 模态窗
- 闸门回合制,无长连接
- 恢复:状态落盘 + 快照重建;崩溃 = 标记中止 + 手动续跑
- 循环上限:执行⇄审查 3 轮,回 planner 2 次,代码兜底
