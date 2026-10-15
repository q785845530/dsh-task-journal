# dsh-task-journal

把**任务**、**工作结果**、**模型参数**、**未完成的问题**自动写到本地文件的 DSH 插件。附带命令行 `dsh-journal` 用于导出与查看。

它在会话事件流上工作：你下发的任务、助手的产出、工具的调用结果、每一轮用的模型与参数，都会被增量追加到当前会话工作目录下的 `.dsh-journal/`。轮次失败时会单独记下**未完成的任务与原因**，并可一键重试。

## 产出什么

默认写到 **会话 cwd 下的 `.dsh-journal/`**：

| 文件 | 内容 | 给谁看 |
| --- | --- | --- |
| `journal-<会话id>.md` | 完整日志：任务、产出、工具调用、模型参数、用量、轮次分隔 | 人读 |
| `events-<会话id>.jsonl` | 一行一个 JSON 事件（含 usage、失败原因） | 机读 |
| `tasks-<会话id>.md` | 任务清单，带 `T` 编号与完成状态 `[x]`/`[ ]` | 人读 |
| `failures-<会话id>.md` | **未完成的任务与原因**，可直接重试 | 人读 |
| `models-<会话id>.md` | **模型与参数**变更记录 | 人读 |

示例 `models-*.md`：

```
- 2026-10-15 21:05:58｜provider=workbuddy model=deepseek-v4.1-flash reasoning=high maxTokens=128000
```

示例 `failures-*.md`：

```
## F1｜任务 T2｜2026-10-15 21:05:58

- 任务：继续写 0500 终章
- 原因：模型限流中，请稍后再试 [QUOTA_EXCEEDED]
- 状态：未完成

> 重试：让模型调用 `journal_retry`，或在这个会话里发一句「继续」。
```

## 安装

```bash
dsh plugin --profile web add link:/home/wsn/.dsh/plugins/dsh-task-journal
```

装完重启一次 DSH 生效。确认已挂上：

```bash
cd ~/.dsh/profiles/web
python3 -c "import json;d=json.load(open('package.json'));print('dsh-task-journal' in d['dsh']['profile']['bundles'])"
```

## 命令行 `dsh-journal`

不进入会话也能导出和查看结果。安装后 `dsh-journal` 即在 PATH（或直接 `node bin/dsh-journal.mjs`）。

```bash
# 列出本地有哪些会话日志
dsh-journal list --cwd /home/wsn/文档/dsh

# 导出结果（默认 .dsh-journal/export/，只出汇总 Markdown）
dsh-journal export --cwd /home/wsn/文档/dsh

# 导出全部单文件 + jsonl
dsh-journal export --cwd /home/wsn/文档/dsh --format all --dir ./工作日志

# 只看未完成的任务
dsh-journal failures --cwd /home/wsn/文档/dsh

# 查看某一份日志
dsh-journal show --cwd /home/wsn/文档/dsh --file models
dsh-journal show --cwd /home/wsn/文档/dsh --file tasks   # journal | tasks | failures | models

# 未完成任务的重试指引
dsh-journal retry --cwd /home/wsn/文档/dsh --note "先补 0485"
```

每个写盘命令结束时都会打印一行带 ✅ 的完成提示，含文件路径与条数。

| 命令 | 作用 |
| --- | --- |
| `export` | 导出结果到目录（`--format md\|all`） |
| `list` | 列出可用会话日志 |
| `show` | 查看某一份（`--file journal\|tasks\|failures\|models`） |
| `failures` | 只看未完成的任务与原因 |
| `retry` | 给出重试指引（命令行无法注入会话） |

> 命令行不能唤醒会话。要真正继续未完成的任务，请在该会话里发一句「继续」，或让模型调用 `journal_retry`。

## 模型工具

插件给模型注册三个工具：

| 工具 | 作用 |
| --- | --- |
| `journal(kind, text)` | 主动记 `task`/`result`/`note`/`todo` |
| `journal_export(dir?, format?)` | 把本次会话日志导出到本地目录 |
| `journal_retry(note?)` | **一键重试**最近未完成的任务：注入「接着上次继续做完」并唤醒会话 |

`journal_retry` 会把最近一条未完成任务的原文附在提示里，所以下一轮是从断点接着做，而不是重头开始。

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-task-journal
  config:
    dir: ""                  # 空 = <会话 cwd>/.dsh-journal/；可写绝对路径
    markdown: true           # 人读的 .md
    jsonl: true              # 机读的 .jsonl
    recordAssistant: true    # 记录助手回复正文
    recordModel: true        # 记录模型与参数
    maxChars: 4000           # 单条上限，超出截断并标注
    notify: false            # 每条任务写入时回 notice
    notifyOnFailure: true    # 失败时提示可重试
    retryPrompt: "上一个任务没有做完。请接着上次的进度继续把它做完……"
```

## 行为约定

- **只追加，不覆盖。** 已有日志不会被清空，同名会话续写。
- **一个会话一组文件。** 文件名带会话 id，多会话互不干扰。
- **顺序稳定。** 每会话一条写队列，串行落盘；文件里的顺序就是事件顺序。
- **任务状态会更新。** 轮次成功 → 该任务标 `[x]`；失败 → 留 `[ ]` 并记进 `failures`。
- **不记子代理。** `origin: 'subagent'` 的会话由父会话负责。
- **只记真人输入。** `source.kind` 为 `user` / `dsh-continue` 的才算任务；`runtime-context`、`time-context`、`skill-catalog` 等注入上下文一律排除。
- **工具名能解析。** `tool/result` 只带 `callId`，插件用 `tool/call` 建映射，所以日志里是 `bash`、`write` 这样的真名。
- **失败不影响会话。** 任何写盘错误只记一条 warn。

## 自测

```bash
cd ~/.dsh/plugins/dsh-task-journal
node verify.mjs       # 插件逻辑：50 项
node verify-cli.mjs   # 命令行：28 项
```

覆盖：自动落盘、注入上下文排除、追加语义、自定义目录、三个工具、子代理排除、禁用开关、超长截断、工具名映射、模型参数记录、用量、未完成任务与错误码、导出、重试、CLI 全部子命令与错误处理。

## 实现要点

- host 半插件，无 client 半。
- 依赖 `@deepseek-ai/dsh-tools`（`defineTool`）。
- 订阅 `session/event`：`user/message`、`assistant/message`、`tool/call`、`tool/result`、`request/header`、`turn/end`。
- `journal_retry` 走 `agent.followup()`，且必须在事件分发之外调用（`setTimeout(0)`），否则宿主拒绝重入 append。
- 写入用 `appendFile`；导出用 `copyFile`。

## License

MIT
