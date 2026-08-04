# 执行报告:AnySearch API key 设置弹窗(前端部分)

> 依据:`.wf-runs/24d5aebd/02-plan-2.md`(计划)+ `.wf-runs/24d5aebd/01-exploration-2.md`(前端结构)+ `.wf-runs/24d5aebd/03-execution-1.md`(后端已完成契约:shared 已 build 含 `hasAnySearchApiKey`;`PUT /api/agent/config/anysearch-key` 支持空串=清空)。
> 范围:仅前端 4 文件;未动后端、未引入新依赖、无 localStorage、key 不回显。

## 1. 改动文件清单

| # | 文件 | 操作 | 改动内容 | 原因 |
| --- | --- | --- | --- | --- |
| 1 | `apps/web/src/composables/useAgent.ts` | 修改 | 新增 `hasAnySearchApiKey` computed(`config.value?.hasAnySearchApiKey ?? false`,仿 `hasApiKey`);新增 `saveAnySearchApiKey(key)`(PUT `/api/agent/config/anysearch-key`,body `{apiKey: key}`,完成后 `refreshConfig()`;空串=清空由后端 saveConfig 删除语义处理);return 中追加两者 | 前端保存 AnySearch key 的唯一入口 + 状态回显 |
| 2 | `apps/web/src/components/ApiKeyModal.vue` | 修改 | DeepSeek 段加小标题 `DEEPSEEK · 对话模型`;下方 `border-t border-edge` 分隔新增独立 AnySearch section:小标题 `ANYSEARCH · 网络搜索`、说明文案(可选/匿名限流/「key 仅保存在后端配置文件,不会返回给前端」/「环境变量 ANYSEARCH_API_KEY 优先于此处配置」/「输入为空保存将清空已配置的 key」)、独立 `anyKeyInput`(password + autocomplete off + placeholder `anysearch-…`)、独立保存按钮(空输入也可保存=清空)、独立状态点(`agent.hasAnySearchApiKey.value` → 绿点「已配置(可覆盖)」/ faint「未配置(匿名可用)」)、独立 `anyError`/`anySaved` 提示;script 新增 `handleAnySave()` 流程(与 DeepSeek 的 loading/成功/失败风格一致) | 任务要求两段 UI 清晰区分、独立保存、空输入=清空 |
| 3 | `apps/web/src/components/PipelineHeader.vue` | 修改 | script setup 新增 `const emit = defineEmits<{ 'open-settings': [] }>()`;右上 `w-60` 状态区、LINK 胶囊前新增 ⚙ 按钮(`grid size-6 place-items-center border border-edge font-mono text-[11px] text-dim hover:border-signal/60 hover:text-signal`,Unicode 字符,与项目边框方块风格一致,`@click="emit('open-settings')"`) | 任务要求右上角设置入口,复用现有 open-settings 事件链 |
| 4 | `apps/web/src/App.vue` | 修改 | `<PipelineHeader ... @open-settings="showSettings = true" />` | 与 ChatPane 现有入口共用 `showSettings` ref,天然合并 |

**key 安全确认**:输入框 `type="password"` + `autocomplete="off"`;保存只经后端接口,前端无任何 key 持久化;状态仅回显 `hasAnySearchApiKey` 布尔,不显示/存储 key 明文;无 localStorage。

## 2. 自检结果(全部从仓库根执行)

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm --filter @workflows/web typecheck`(vue-tsc -b) | ✅ 通过 |
| Lint | `pnpm --filter @workflows/web lint`(eslint .) | ✅ 0 error 0 warning(修复 3 处 vue 单行元素换行 style warning 后) |
| 单测 | `pnpm --filter @workflows/web test`(vitest run) | ✅ 3 文件 15/15 通过 |
| 构建 | `pnpm --filter @workflows/web build`(vue-tsc -b && vite build) | ✅ 构建成功(built in 1.24s) |
| shared 重建 | 无需(后端批次已完成 `@workflows/shared build`,dist 已含 `hasAnySearchApiKey`) | — |
| 改动面 | `git status` 确认前端仅上述 4 文件(+108/-2);后端/新建文件属执行批次 1 范围,未触碰 | ✅ |

## 3. 未完成项与原因

- **无**(本批次范围内全部完成)。未做计划中可选的 `useAgent.test.ts` 补测(web 既有测试 15/15 全绿,无回归;任务未强制要求);子代理工具集、batch/extract 等为后端 v1 明确排除项,不在本批次范围。
