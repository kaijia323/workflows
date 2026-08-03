# 执行报告:解决 run.json updatedAt 导致 git 状态脏

## 任务
每次工作流运行后 `.wf-runs/*/run.json` 的 updatedAt 变化导致 git 状态脏。run.json 由 runManager.ts 每次 saveRun() 全量重写,已被 git 跟踪,提交后总是 modified。

## 改动文件清单

| 文件 | 改动内容 | 原因 |
|---|---|---|
| `.gitignore` | 在末尾 `# local workflows config (dev)` / `.workflows/` 之后追加两行:`# workflow run metadata (regenerated on every run)` + `.wf-runs/*/run.json` | 忽略所有工作流运行目录下的 run.json,保留已有规则 |

未改动任何源码(runManager.ts 等),未删除任何 `.wf-runs` 下的实际文件(包括 696fc399 目录)。

## git rm --cached 的文件(保留工作区文件)

```
git ls-files '.wf-runs/*/run.json' | xargs git rm --cached
```
- `.wf-runs/2a2b4d0d/run.json`(rm --cached 成功)
- `.wf-runs/46569220/run.json`(rm --cached 成功)
- `.wf-runs/d06adb0f/run.json`(rm --cached 成功)

## 验证结果

1. **run.json 不再被跟踪**:`git ls-files '.wf-runs/*/run.json'` 输出为空。
2. **run.json 已被忽略**:`git check-ignore -v` 确认 4 个目录(2a2b4d0d / 46569220 / d06adb0f / 696fc399)下的 run.json 均命中 `.gitignore:27:.wf-runs/*/run.json`。
3. **产物 md 仍被跟踪**:`git ls-files '.wf-runs/*'` 中 NN-*.md 全部保留(2a2b4d0d 4 个、46569220 3 个、d06adb0f 4 个)。
4. **工作区文件完好**:`.wf-runs/*/run.json` 4 个文件均存在。
5. **git status --short 结果**:
   ```
    M .gitignore
   D  .wf-runs/2a2b4d0d/run.json
   D  .wf-runs/46569220/run.json
   D  .wf-runs/d06adb0f/run.json
   ?? .wf-runs/696fc399/
   ```
   - `.gitignore` 的 M 为本次改动(预期);
   - 三个 `D` 为 `git rm --cached` 产生的暂存删除,即从跟踪中移除(预期);
   - `.wf-runs` 下**不再出现任何 run.json 的 modified / untracked**;
   - `?? .wf-runs/696fc399/` 为该目录内 `01-exploration-1.md` 本身未跟踪(任务前即如此),其 run.json 已忽略、不会进入状态;按要求未删除该目录。

结论:问题已解决——run.json 不再被 git 跟踪,后续运行 updatedAt 变化不会再产生脏状态。剩余变更(.gitignore 修改 + 3 个 cached 删除)待提交。

## 未完成项
无。
