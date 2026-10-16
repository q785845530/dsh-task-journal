# dsh-task-journal

把**任务**、**工作结果**、**模型参数**、**未完成的问题**、**子智能体的使用情况**自动写到本地文件的 DSH 插件。附带命令行 `dsh-journal` 用于导出、查看与归档。

它在会话事件流上工作：你下发的任务、助手的产出、工具的调用结果、每一轮用的模型与参数，都会被增量追加到当前会话工作目录下的 `.dsh-journal/`。轮次失败时会单独记下**未完成的任务与原因**，并可一键重试。委派给子智能体的每一次调用也会被记下来，并可按软件开发分类**浏览、归档、复用**。

## 产出什么

默认写到 **会话 cwd 下的 `.dsh-journal/`**：

| 文件 | 内容 | 给谁看 |
| --- | --- | --- |
| `journal-<会话id>.md` | 完整日志：任务、产出、工具调用、模型参数、用量、轮次分隔 | 人读 |
| `events-<会话id>.jsonl` | 一行一个 JSON 事件（含 usage、失败原因、子智能体生命周期） | 机读 |
| `tasks-<会话id>.md` | 任务清单，带 `T` 编号与完成状态 `[x]`/`[ ]` | 人读 |
| `failures-<会话id>.md` | **未完成的任务与原因**，可直接重试 | 人读 |
| `models-<会话id>.md` | **模型与参数**变更记录 | 人读 |
| `subagents-<会话id>.md` | **子智能体使用情况**：每次委派的时间、子智能体、分类、结果 | 人读 |
| `subagents/` | 子智能体**目录与归档**：catalog、调用规格、预设文件、源码 | 人读 + 机读 |

`subagents/` 展开：

```
subagents/
├── catalog.json                 全量目录（机读）
├── catalog.md                   全量目录（按分类分组，人读）
├── entries/<id>.md              单个子智能体：功能 / 用法 / 参数 / 示例
├── entries/<id>.json            同一份的机读规格
├── presets/<id>/preset.yml      可执行预设
├── presets/<id>/agent.cordis.yml 组装说明（怎么挂到 provider / 工具上）
└── src/<id>/…                   该子智能体的真实源码（按需归档）
```

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

示例 `subagents-*.md`：

```
## S1｜2026-10-16 19:48:02｜spawn 子智能体

- 分类：**后端**（`backend`）
- provider：`spawn`
- 子会话：`child-a1b2`
- 状态：已启动
- 结束：2026-10-16 19:48:37｜结果：**completed** ✅
```

## 安装

### 方式一：从 GitHub 直接装（推荐）

```bash
# 直接让 DSH 从仓库装（github: 简写由 pnpm 解析）
dsh plugin --profile web add github:q785845530/dsh-task-journal

# 或者指定分支/标签
dsh plugin --profile web add github:q785845530/dsh-task-journal#main
```

仓库地址：<https://github.com/q785845530/dsh-task-journal>

### 方式二：本地克隆后链接

```bash
git clone https://github.com/q785845530/dsh-task-journal.git ~/.dsh/plugins/dsh-task-journal
cd ~/.dsh/plugins/dsh-task-journal && npm install   # 装运行时依赖 @deepseek-ai/dsh-tools
dsh plugin --profile web add link:~/.dsh/plugins/dsh-task-journal
```

> `link:` 后面必须给**绝对路径**。上面用 `~` 是 shell 展开的结果；
> 如果手工填写，请写成完整路径（如 `/home/<你>/.dsh/plugins/dsh-task-journal`）。
>
> 方式一由 pnpm 自动装依赖，所以不需要这一步；方式二手动克隆，
> 必须自己 `npm install`，否则插件加载时会报 `Cannot find package '@deepseek-ai/dsh-tools'`。

装完**重启一次 DSH** 生效。确认已挂上：

```bash
cd ~/.dsh/profiles/web
python3 -c "import json;d=json.load(open('package.json'));print('dsh-task-journal' in d['dsh']['profile']['bundles'])"
```

输出 `True` 即已挂载。

## 命令行 `dsh-journal`

不进入会话也能导出和查看结果。

**命令已在 PATH**：已链接到 `~/.local/bin/dsh-journal`（登录 shell）与 `~/.local/share/pnpm/bin/dsh-journal`（非登录 shell），直接敲 `dsh-journal` 即可。

若换机器或链接失效，重建一次（`~/.dsh/plugins/...` 按你的实际安装位置替换）：

```bash
ln -sf ~/.dsh/plugins/dsh-task-journal/bin/dsh-journal.mjs ~/.local/bin/dsh-journal
chmod +x ~/.dsh/plugins/dsh-task-journal/bin/dsh-journal.mjs
```

也可以直接 `node ~/.dsh/plugins/dsh-task-journal/bin/dsh-journal.mjs <命令>`。

> **路径隐私**：CLI 与界面的输出默认把本机 HOME 前缀遮蔽成 `~`，
> 避免把用户名与目录结构写进导出文件或截图。需要完整路径时加 `--no-redact`。

```bash
# 列出本地有哪些会话日志
dsh-journal list --cwd "$PWD"

# 导出结果（默认 .dsh-journal/export/，只出汇总 Markdown）
dsh-journal export --cwd "$PWD"

# 导出全部单文件 + jsonl
dsh-journal export --cwd "$PWD" --format all --dir ./工作日志

# 只看未完成的任务
dsh-journal failures --cwd "$PWD"

# 查看某一份日志
dsh-journal show --cwd "$PWD" --file models
dsh-journal show --cwd "$PWD" --file tasks   # journal | tasks | failures | models | subagents

# 浏览子智能体目录（按软件开发分类分组）
dsh-journal agents --cwd "$PWD"
dsh-journal agents --cwd "$PWD" --category backend   # 只看某一类

# 把目录持久化下来：调用规格 + 预设文件（+ 真实源码）
dsh-journal agents --cwd "$PWD" --archive
dsh-journal agents --cwd "$PWD" --archive --sources

# 未完成任务的重试指引
dsh-journal retry --cwd "$PWD" --note "先补 0485"
```

每个写盘命令结束时都会打印一行带 ✅ 的完成提示，含文件路径与条数。

| 命令 | 作用 |
| --- | --- |
| `export` | 导出结果到目录（`--format md\|all`） |
| `list` | 列出可用会话日志 |
| `show` | 查看某一份（`--file journal\|tasks\|failures\|models\|subagents`） |
| `failures` | 只看未完成的任务与原因 |
| `agents` | **子智能体目录**；`--archive` 持久化规格与预设，`--sources` 连源码一起归档 |
| `retry` | 给出重试指引（命令行无法注入会话） |

> 命令行不能唤醒会话。要真正继续未完成的任务，请在该会话里发一句「继续」，或让模型调用 `journal_retry`。

## 界面（Web GUI）

插件带一个**独立界面**：打开 DSH 的设置页，左侧导航多一项 **「任务日志」**，右侧是完整面板。

面板内容：

- **顶部工具条**：会话选择器、刷新、导出汇总、导出全部、一键重试、**新会话续跑**、**标记失败**
- **文件路径区**：列出日志目录、**会话原始文件**（`.dsh/sessions/.../session.v4.jsonl.zstd`）与各份日志的路径，方便直接打开
- **统计卡片**：任务总数 / 已完成 / 未完成 / 失败记录 / 模型参数变更 / **子智能体委派**
- **当前模型**：显示最近一次的 provider 与模型参数
- **六个标签页**：
  - 任务清单（带 `T` 编号与 `[x]`/`[ ]` 状态）
  - 未完成的问题（含原始错误码）
  - 模型与参数（每次变更一行）
  - **子智能体**（目录 + 分类标签 + 归档按钮，见下节）
  - **子智能体使用记录**（本会话每次委派）
  - 完整日志
- **实时刷新**：该会话有活跃 agent 时每 5 秒自动刷新
- **操作反馈**：导出、重试与归档完成后右下角弹提示（带 ✅）

界面数据走同源 `/api/dsh-journal/*`（由插件 host 半提供），不依赖任何构建步骤——`lib/client.js` 是手写的 ModuleLoader bundle，只用 shell 已提供的 `react`，颜色全部取自主题变量，切换明暗主题不会坏。

### 界面怎么找到日志

日志可能散在多个工作目录（服务进程的 cwd 未必等于会话的 cwd），所以 host 半会：

1. 记住每个会话的日志目录，写进 `<DSH_HOME>/dsh-task-journal/dirs.json`（服务重启后仍在）；
2. `/sessions` 扫描**所有已知目录** + 显式 `?cwd=` + 进程 cwd，按会话去重；
3. 访问过某个会话后，它的目录也会被登记，后续列表里就能看到。

因此：**重启后先在会话里发一句话**（产生一轮事件），日志目录会被登记，界面刷新即可看到该会话。

### 界面用到的接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/dsh-journal/sessions` | 列出会话日志 |
| GET | `/api/dsh-journal/summary` | 统计 + 当前模型 + 文件路径 |
| GET | `/api/dsh-journal/tasks` | 任务清单 |
| GET | `/api/dsh-journal/failures` | 未完成任务 |
| GET | `/api/dsh-journal/models` | 模型记录 |
| GET | `/api/dsh-journal/subagents` | **子智能体使用记录** |
| GET | `/api/dsh-journal/journal` | 完整日志（尾部截断） |
| GET | `/api/dsh-journal/subagents/catalog` | **子智能体目录**（支持 `?category=`） |
| GET | `/api/dsh-journal/subagents/entry` | **单个子智能体规格**（`?id=`） |
| GET | `/api/dsh-journal/subagents/archive` | **归档状态**（条目/预设/源码计数） |
| GET | `/api/dsh-journal/history` | **历史会话列表**（含旧会话，支持 `?q=` 筛选） |
| GET | `/api/dsh-journal/history/digest` | **单个历史会话的存档摘要** |
| POST | `/api/dsh-journal/export` | 导出结果 |
| POST | `/api/dsh-journal/subagents/save` | **持久化目录**（`sources: true` 时连源码） |
| POST | `/api/dsh-journal/subagents/sources` | **仅归档源码** |
| POST | `/api/dsh-journal/retry` | 一键重试（原会话内 followup） |
| POST | `/api/dsh-journal/retry-new` | 开新会话续跑 |
| POST | `/api/dsh-journal/abandon` | 标记任务失败 |

查询参数：`?session=<会话id>&cwd=<工作目录>`（都可省略，省略时取最近的会话）。

所有接口返回的路径都经过 HOME 遮蔽。

## 子智能体

这是本插件除任务日志之外的第二个重点：把**本机有哪些子智能体、各自能干什么、怎么调用**记下来，
按软件开发的维度分类，并把调用规格与代码持久化，方便后续任务直接复用。

### 「子智能体」页签

设置页 →「任务日志」→「**子智能体**」标签页：

- 按**分类**分组展示（可折叠），每类给出说明
- 顶部支持**按名称 / id / 工具 / 包名过滤**，以及按分类筛选
- 每条显示：名称、id、来源（内置 / 运行期发现）、类型（后端 / 模型工具）、可用性、功能、用法
- 「**调用规格**」按钮 → 打开该条目的完整 Markdown（功能、使用场景、怎么用、参数表、调用示例）
- 「**生成调用单**」按钮 → 直接给出可复制的调用代码
- 顶部三个归档按钮：
  - **归档目录** → 写 `catalog.json` / `catalog.md` / `entries/` / `presets/`
  - **归档目录 + 源码** → 再归档每个子智能体的真实源码
  - **仅归档源码** → 只做源码归档

旁边还有「**子智能体使用记录**」标签页，显示本会话每一次委派（时间、子智能体、分类、结果）。

### 软件开发分类标签

每个子智能体有一个**主分类**（`category`）与若干**细标签**（`tags`）：

| 分类 | id | 说明 |
| --- | --- | --- |
| 需求与规划 | `requirement` | 拆解需求、定范围、排计划 |
| 架构与设计 | `architecture` | 系统结构、接口契约、技术选型 |
| 前端 | `frontend` | 界面、交互、样式、浏览器侧逻辑 |
| 后端 | `backend` | 服务端逻辑、接口实现、通用编码 |
| 数据与存储 | `data` | 数据库、查询、数据管道、指标 |
| 测试与质量 | `testing` | 用例、回归、稳定性、缺陷复现 |
| 代码审查 | `review` | 读 diff、找问题、给修改意见 |
| 安全 | `security` | 漏洞、密钥、权限、注入面 |
| 构建与部署 | `devops` | 构建、发布、环境、进程与编排 |
| 文档 | `docs` | README、注释、交付说明 |
| 调研 | `research` | 查资料、读代码库、比方案 |
| 创作写作 | `writing` | 长篇文本、剧本、叙事结构 |

分类名接受 id、中文名或常见别名；认不出的按关键词猜，最后落到默认分类，**不会丢条目**。

### 收录哪些子智能体

目录 = **内置目录** + **运行期自动发现**。

**内置目录**收录 DSH 的委派后端与编排工具（各条目都写明所属包，可核对）：

| 条目 | 分类 | 工具 / provider |
| --- | --- | --- |
| spawn 子智能体 | 后端 | `subagent` / `spawn` |
| fork 子智能体 | 代码审查 | `subagent_fork` / `fork` |
| ACP 子智能体 | 构建与部署 | `acp` |
| DSH SDK 子智能体 | 构建与部署 | `dsh-sdk` |
| Codex 子智能体 | 后端 | `codex` |
| Claude Code 子智能体 | 后端 | `claude-code` |
| 子智能体控制 | 构建与部署 | `send_message` / `list_agents` / `interrupt_agent` |
| Agent Teams 队友 | 构建与部署 | `spawn_teammate` |
| workflow 批量编排 | 构建与部署 | `workflow` |
| Oh Story 专注角色 | 创作写作 | `oh_story_role` |
| 子智能体模型选择 | 构建与部署 | `list_subagent_models` |

**运行期自动发现**三处事实，发现到目录里没有的就新加一条（标记为「运行期发现」）：

1. `ctx.subagents.list()` 里注册的 provider 名；
2. 当前组装里模型可见的工具名；
3. 本会话里出现过的 `subagent/start` 事件。

探测不到就不写。条目上的 `availability` 只在真观察到时才出现，**不猜**。

### 持久化：调用规格、预设、源码

「归档目录」写出三类东西：

- **调用规格** — `entries/<id>.json` 是机读规格，`entries/<id>.md` 是人读版
  （功能 / 什么时候用 / 怎么用 / 参数表 / 调用示例）。后续任务照抄即可调用。
- **可执行预设** — `presets/<id>/preset.yml` 是 DSH 预设形态；
  `presets/<id>/agent.cordis.yml` 给出**怎么把它挂到 provider 与工具上**的组装片段，
  并把它当说明性归档——并入你的 profile patch，而不是覆盖现有组装。
- **真实源码** — `src/<id>/` 归档该子智能体的源码。定位方式是**读 `package.json` 的
  `name` 字段精确匹配**（monorepo 里目录名常与包名不同），不是猜目录名。
  搜索有界（默认 3 层、400 个目录）；找不到就写进 `src/SOURCE.md` 说明找过哪里、
  为什么没有，**不伪造源码、也不假装成功**。

源码候选根（可用 `DSH_SOURCE_ROOT` 追加）：DSH 开发检出、`<DSH_HOME>/plugins`、
`<DSH_HOME>/profiles`、当前目录的 `node_modules/@deepseek-ai`。

### 记录使用情况

两种情况都会写进 `subagents-<会话id>.md` 与 `events-*.jsonl`：

- **子智能体生命周期**：`subagent/start` 与 `subagent/end`（含 provider、子会话 id、结束原因）
- **委派工具调用**：`subagent`、`subagent_fork`、`spawn_teammate`、`workflow`、`oh_story_role`、
  `send_message`、`list_agents`、`interrupt_agent`、`list_subagent_models`

关掉记录：配置 `recordSubagents: false`。

### 模型工具

插件给模型注册三个子智能体工具：

| 工具 | 作用 |
| --- | --- |
| `subagent_catalog(category?)` | 列出目录（内置 + 发现），带分类标签、功能与调用方法 |
| `subagent_save(sources?)` | **持久化**：目录 + 调用规格 + 预设文件，可选归档真实源码 |
| `subagent_run(id, prompt, description?, background?)` | 按归档规格**登记并生成调用单** |

> `subagent_run` **不代替模型发起委派**——那会绕过宿主对 provider 能力与深度的校验。
> 它做的是：记一次使用、回一张可直接复制的调用单。真正的委派仍由 `subagent` 等工具发出。

## 路径隐私（HOME 遮蔽）

插件把本机 HOME 前缀遮蔽成 `~`，避免日志、导出文件与界面截图泄露用户名与目录结构：

- **host 半**：所有 `/api/*` 响应与写入日志的路径都过一遍遮蔽
- **CLI**：输出默认遮蔽，`--no-redact` 关闭
- **界面**：显示的就是后端给出的已遮蔽路径

配置关掉：`redactHome: false`。

只做**前缀替换**，不动路径其余部分：`/home/<你>/a/b.md` → `~/a/b.md`。

## 历史会话查询

面板顶部有「**历史会话**」按钮，打开后可以浏览磁盘上的**全部** DSH 会话（包括插件安装之前的老会话）：

- 按会话 id 或工作目录**筛选**
- 显示每个会话的时间、存档大小、工作目录
- 标记「**有任务日志**」（插件记录过的）或「**仅会话存档**」
- 点任意一行 → 预览该会话的**轮数、任务数、产出数**与最近的任务/产出原文
- 点「**打开**」→ 切换到这个会话的日志视图

### 怎么读到旧会话的

DSH 的会话归档是**边写边压缩**的：每次追加产生一个独立的 zstd 帧，一个 4MB 的会话可能有几千帧。插件按 zstd 魔数切帧、逐帧解压再拼接，所以能读出完整内容。只用 Node 内置的 `zlib`，无外部依赖。

## 记住上次的会话

面板会**记住上次选中的会话和标签页**（存在浏览器 `localStorage`）：

- 下次打开直接回到那个会话，不用重新找
- 如果那个会话这次没出现在列表里，选择器仍会保留它并标注「（上次的会话）」，不会悄悄跳走
- 新任务照常**追加**到该会话的日志里（日志是只追加的，不会覆盖旧记录）

不想记住就在浏览器里清掉 `dsh-task-journal:last-session` 这个键。

## 模型工具

插件给模型注册八个工具：

| 工具 | 作用 |
| --- | --- |
| `journal(kind, text)` | 主动记 `task`/`result`/`note`/`todo` |
| `journal_export(dir?, format?)` | 把本次会话日志导出到本地目录 |
| `journal_retry(note?)` | **一键重试**最近未完成的任务：注入「接着上次继续做完」并唤醒会话 |
| `journal_retry_new(note?)` | **开新会话续跑**：创建一个全新会话，把任务原文发进去，原会话不受影响 |
| `journal_abandon(note?)` | **标记失败**：把最近未完成的任务直接结案，不再重试 |
| `subagent_catalog(category?)` | 列出子智能体目录（内置 + 发现），带分类标签 |
| `subagent_save(sources?)` | **持久化**子智能体目录、调用规格与预设，可选源码 |
| `subagent_run(id, prompt, …)` | 按归档规格登记调用并生成调用单 |

`journal_retry` 会把最近一条未完成任务的原文附在提示里，所以下一轮是从断点接着做，而不是重头开始。

## 未完成任务的三种处理

任务失败（限流、中断、输出超限等）时会记进 `failures-*.md`。之后有三种走法：

| 做法 | 适用场景 | 怎么用 |
| --- | --- | --- |
| **原会话重试** | 原会话还活着、上下文没满 | `journal_retry` 工具，或界面「一键重试」 |
| **开新会话续跑** | 原会话已结束 / 上下文已满 | `journal_retry_new` 工具，或界面「新会话续跑」 |
| **标记失败** | 确认放弃这个任务 | `journal_abandon` 工具，或界面「标记失败」 |

**开新会话续跑**会：新建一个根会话（`journal-retry-<uuid>`）→ 继承原会话的 `cwd` → 沿用当前模型 →
挂载同一 preset → 自动命名（`续跑：<任务摘要>`）→ 挂进工作区 → 继承权限档位 →
把任务原文作为首条消息发进去。原会话完全不受影响。

**标记失败**会：在 `failures-*.md` 追加一条带原因的记录 → 把 `tasks-*.md` 里那条标上 `❌ 已放弃`
→ 从待重试队列移除。之后「一键重试」不会再挑到它。

> 服务重启后内存里的待办队列会丢，但两种重试都能从磁盘的 `tasks-*.md` 兜底找回最后一条未完成任务。

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
    recordSubagents: true    # 记录子智能体使用情况
    redactHome: true         # 把本机 HOME 前缀遮蔽成 ~
    subagentDir: ""          # 空 = <日志目录>/subagents
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
- **不记子代理会话。** `origin: 'subagent'` 的会话日志归其父会话所有；但**委派这件事本身**会记进父会话的 `subagents-*.md`。
- **只记真人输入。** `source.kind` 为 `user` / `dsh-continue` 的才算任务；`runtime-context`、`time-context`、`skill-catalog` 等注入上下文一律排除。
- **工具名能解析。** `tool/result` 只带 `callId`，插件用 `tool/call` 建映射，所以日志里是 `bash`、`write` 这样的真名。
- **不猜事实。** 子智能体的可用性只在真观察到时才写；源码找不到就如实说明，不伪造。
- **失败不影响会话。** 任何写盘错误只记一条 warn。

## 自测

```bash
cd ~/.dsh/plugins/dsh-task-journal
node verify.mjs            # 插件逻辑：50 项
node verify-cli.mjs        # 命令行：45 项
node verify-api.mjs        # 界面 API：62 项
node verify-subagent.mjs   # 子智能体目录 / 归档 / 记录 / 接口：86 项
```

共 **243 项**。覆盖：自动落盘、注入上下文排除、追加语义、自定义目录、全部工具、子代理会话排除、
禁用开关、超长截断、工具名映射、模型参数记录、用量、未完成任务与错误码、导出、重试、
CLI 全部子命令与错误处理、子智能体分类与标签、运行期自动发现、HOME 遮蔽、归档产物、
源码定位（找得到与找不到两种）、`subagents-*.md` 记录、`/subagents/*` 全部接口。

## 实现要点

- host 半插件 + 手写 client 半。
- 依赖 `@deepseek-ai/dsh-tools`（`defineTool`）。工具输出 schema 用**受约束的 JSON Schema 子集**：
  对象节点必须显式写 `additionalProperties`，否则注册会被拒绝。
- 订阅 `session/event`：`user/message`、`assistant/message`、`tool/call`、`tool/result`、`request/header`、`turn/end`。
- 订阅 `subagent/start` 与 `subagent/end` 记录委派生命周期。
- 子智能体目录与归档在 `lib/subagent-catalog.js`，host 半与 CLI 共用同一份实现。
- `journal_retry` 走 `agent.followup()`，且必须在事件分发之外调用（`setTimeout(0)`），否则宿主拒绝重入 append。
- 写入用 `appendFile`；导出用 `copyFile`；源码归档用 `copyFile` 递归复制。

## License

MIT
