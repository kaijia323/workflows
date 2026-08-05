# 执行报告:图片上传目录迁移 `.wf-uploads` → `.workflows/uploads`

> 注:产物目录中不存在 `02-plan-*.md`(run.json `planFile: null`),本 run 以任务说明中的「改动要求」为计划实施。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
|---|---|---|
| `apps/api/src/agent/routes.ts` | `UPLOADS_DIR` 常量 `.wf-uploads` → `.workflows/uploads`;常量上方与上传路由两处注释同步更新 | 上传落盘目录迁移;mkdir/惰性清理/返回路径均引用该常量(已核实无其他硬编码),自动跟随 |
| `.workflows/.gitignore`(新建) | 内容单行 `*`(仅此一行) | 用户明确要求:即使工作区根 .gitignore 未忽略 `.workflows/`,目录内 `*` 也保证上传图片不进 git;未动 `.workflows/` 下其他文件 |
| `apps/api/src/pi/visionTools.ts` | 3 处文档/工具描述 `.wf-uploads/` → `.workflows/uploads/`(文件头设计注释、`image_paths` schema description、工具 description) | 与上传目录保持一致,agent 提示路径正确 |
| `apps/web/src/composables/useAgent.ts` | 1 处 doc 注释 `.wf-uploads/<uuid>.png` → `.workflows/uploads/<uuid>.png` | 注释同步;前端路径本身由后端返回,无硬编码(已确认 ChatPane/useAgent 均透传) |
| `apps/web/src/composables/useAgent.test.ts` | 5 处 mock 路径 `.wf-uploads/abc.png` → `.workflows/uploads/abc.png` | 测试 mock 与后端新返回路径一致 |
| `apps/api/src/agent/uploadsRoutes.test.ts` | `UPLOADS_DIR` 常量 + 3 处路径正则 `/^\.workflows\/uploads\/.../` + 1 处用例名同步 | 落盘路径断言更新;临时目录注入点(mkdtemp fake store)保持不变 |

## 目录清理

- 删除工作区根 `.wf-uploads/`(内含 1 个冒烟测试 PNG,已无用);删除后 `git status` 不再显示该目录 ✅

## 验证结果

- `pnpm typecheck`:3/3 tasks 通过
- `pnpm test`:api 18 文件 370 用例 + web 10 文件 101 用例,全绿(含 uploadsRoutes 10 用例)
- `pnpm lint`:3/3 tasks 通过
- `pnpm build`:3/3 tasks 通过
- git 可见性冒烟:`.workflows/uploads/` 下放置临时文件 → `git status` 0 行输出,`git check-ignore` 命中根 `.gitignore:24:.workflows/` ✅(临时文件已清理)
- 完整起服务上传冒烟未做:需 DeepSeek key + 工作区配置;等价覆盖已由单测落盘断言 + git 可见性冒烟达成

## Commit(一个)

`e1ea725` `chore: 图片上传目录迁移 .wf-uploads → .workflows/uploads`
6 files changed, 18 insertions(+), 17 deletions(-);`.workflows/.gitignore` 因被根 `.gitignore` 忽略需 `git add -f` 入库。

## 提交后状态

`git status` 仅剩 `?? .wf-runs/b0f3ab5f/`(本 run 产物目录,预期 untracked);`.workflows/` 无任何文件被 git 追踪或显示。

## 未完成项

- 无(唯一未做项为完整起服务上传冒烟,属"如可能"项,理由见上)
