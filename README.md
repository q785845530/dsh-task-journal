# dsh-task-journal

把**任务**与**工作结果**自动写到本地文件的 DSH 插件。

它在会话事件流上工作：你下发的任务、助手的产出、工具的执行结果，都会被增量追加到当前会话工作目录下的 `.dsh-journal/`。另外提供一个 `journal` 工具，让模型在长任务里主动把阶段结论、决策、待办写进同一份日志。

## 产出什么

默认写到 **会话 cwd 下的 `.dsh-journal/`**：

| 文件 | 内容 | 给谁看 |
| --- | --- | --- |
| `journal-<会话id>.md` | 逐条追加的完整日志：任务、产出、工具调用、轮次分隔 | 人读 |
| `events-<会话id>.jsonl` | 一行一个 JSON 事件，字段稳定 | 机读／后续处理 |
| `tasks-<会话id>.md` | 任务清单（`- [ ]` 条目） | 人读 |

示例：

```markdown
# 任务日志

- 会话：`session-abc`
- 工作目录：`/home/wsn/文档/dsh`
- 创建时间：2026-10-15 20:40:54

> 由 dsh-task-journal 自动追加；请勿手工清空。

---
## 任务 1｜2026-10-15 20:40:54

把 0091 章重新写一遍，解决查重问题

### 产出｜2026-10-15 20:40:55

我先读 0090 与 0092，再把核心事件换掉。

- **工具** `read`｜2026-10-15 20:40:55

<!-- 轮次结束：completed｜2026-10-15 20:41:02 -->
```

## 安装

```bash
dsh plugin --profile web add link:/home/wsn/.dsh/plugins/dsh-task-journal
```

装完重启一次 DSH，插件即生效。确认已挂上：

```bash
cd ~/.dsh/profiles/web
python3 -c "import json;d=json.load(open('package.json'));print('dsh-task-journal' in d['dsh']['profile']['bundles'])"
```

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖（该行的 `config` 字段）：

```yaml
- id: dsh-task-journal
  config:
    enabled: true
    dir: ""              # 空 = <会话 cwd>/.dsh-journal/；可写绝对路径
    markdown: true       # 写人读的 .md
    jsonl: true          # 写机读的 .jsonl
    recordAssistant: true # 是否记录助手回复全文
    maxChars: 4000       # 单条记录上限，超出截断并标注
    notify: false        # 是否在会话里回一条 notice
```

环境变量式的位置控制没有：`dir` 就是唯一开关。

## `journal` 工具

模型可以主动调用：

```
journal(kind: "task" | "result" | "note" | "todo", text: "……")
```

- `task` 新任务（同时进 `tasks-*.md`）
- `result` 阶段结论
- `note` 备注
- `todo` 待办

返回写入的文件路径与字节数。

## 行为约定

- **只追加，不覆盖。** 已有日志不会被清空，同名会话续写。
- **一个会话一组文件。** 文件名带会话 id，多个会话互不干扰。
- **顺序稳定。** 每会话一条写队列，串行落盘；文件里的顺序就是事件顺序。
- **不记子代理。** `origin: 'subagent'` 的会话由父会话负责，避免重复。
- **只记真人输入。** `source.kind !== 'user'` 的注入上下文（系统提示注入、通知、文件变更提示等）不算"任务"。
- **失败不影响会话。** 任何写盘错误只记一条 warn，不会让宿主崩。

## 自测

```bash
cd ~/.dsh/plugins/dsh-task-journal
node verify.mjs
```

覆盖：自动落盘、注入上下文排除、追加语义、自定义目录、`journal` 工具、子代理排除、禁用开关、超长截断。

## 实现要点

- host 半插件，无 client 半。
- 依赖 `@deepseek-ai/dsh-tools`（提供 `defineTool`）。
- 订阅 `session/event`：`user/message` / `assistant/message` / `tool/result` / `turn/end`。
- 写入用 `appendFile`，目录用 `mkdir -p` 语义。
