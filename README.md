# dsh-task-journal

把**任务**、**工作结果**、**模型参数**、**未完成的问题**、**子智能体的使用情况**自动写到本地文件的 DSH 插件。附带命令行 `dsh-journal` 用于导出、查看与归档。

它在会话事件流上工作：你下发的任务、助手的产出、工具的调用结果、每一轮用的模型与参数，都会被增量追加到当前会话工作目录下的 `.dsh-journal/`。轮次失败时会单独记下**未完成的任务与原因**，并可一键重试。委派给子智能体的每一次调用也会被记下来，并可按软件开发分类**浏览、归档、复用**。

## 产出什么

默认写到 **会话 cwd 下的 `.dsh-journal/`**：

| 文件 | 内容 | 给谁看 |
| --- | --- | --- |
| `journal-<会话id>.md` | 完整日志：任务、产出、工具调用、模型参数、用量、轮次分隔 | 人读 |
| `events-<会话id>.jsonl` | 一行一个 JSON 事件（含 usage、失败原因、子智能体生命周期） | 机读 |
| `tasks-<会话id>.md` | 任务清单，带 `T` 编号、完成状态与**子智能体用量标注** | 人读 |
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
- **七个标签页**：
  - 任务清单（带 `T` 编号与 `[x]`/`[ ]` 状态）
  - 未完成的问题（含原始错误码）
  - 模型与参数（每次变更一行）
  - **子智能体**（目录 + 分类标签 + 归档按钮，见下节）
  - **子智能体使用记录**（本会话每次委派）
  - 完整日志
  - **会话修复**（扫描 / 诊断 / 修复 / 复验，见「会话修复」一节）
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
| GET | `/api/dsh-journal/repair/scan` | **① 扫描**：体检全部会话归档（`?force=1` 忽略缓存） |
| POST | `/api/dsh-journal/repair/fix` | **②③ 修复一个会话**（`session` 或 `file`；`apply:true` 才落盘） |
| POST | `/api/dsh-journal/repair/fix-all` | **③ 批量修复**全部可自动修复的，并附带复验 |
| GET | `/api/dsh-journal/repair/verify` | **④ 复验**：强制重扫，给出通过/不通过 |

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

三种落点，都在同一次委派发生时写入：

- `subagents-<会话id>.md` —— 每次委派的完整块（时间、名字、分类、provider、子会话、结果），
  以及 `events-*.jsonl` 里的 `subagent_start` / `subagent_end` / `subagent_tool` 事件
- **任务清单 `tasks-<会话id>.md`** —— 直接在**那一条任务行**上标注，一眼看出这条任务用过什么：

  ```
  - [x] [`T1`] 2026-10-16 21:19:59｜重构导出模块　🤖 spawn 子智能体×2　🤖 代码审查子智能体
  ```

  同一个子智能体重复派只累加计数（`×2`），不同子智能体并列写。
- `journal-<会话id>.md` —— 一条 HTML 注释，便于在主日志里按时间轴定位

记录来源有两类，覆盖完整：

- **子智能体生命周期**：`subagent/start` 与 `subagent/end`（含 provider、子会话 id、结束原因）
- **委派工具调用**：`subagent`、`subagent_fork`、`spawn_teammate`、`workflow`、`oh_story_role`、
  `send_message`、`list_agents`、`interrupt_agent`、`list_subagent_models`

> 生命周期事件本身**不带父会话 id**。插件优先用子会话的 `header.parentSession` 归因；
> 只能退回推断时，会在记录里写明「推断」，并在 jsonl 里标 `attributed: false`——
> 不把猜的当成确定的。

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

## 凭据遮蔽

日志会把**用户原话**与**工具输出**整段落盘，密钥经常就藏在这两处。所以写入前统一过一道闸：

- **写侧**：`md()` / `json()` / `task()` / `failure()` / `model()` / `subagent()` 全部先过 `redactSecrets`
- **读侧**：`journal_export` 与 CLI `export` 从磁盘读老文件时也过一遍，避免把修复前的历史垃圾再打包一份
- **界面/接口**：`/api/*` 响应同样过滤

认到就换成 `<redacted:标签>`，标签说明是哪种：

| 标签 | 认什么 |
|---|---|
| `github-pat` | `ghp_`、`github_pat_`、`gho_`/`ghu_`/`ghs_`/`ghr_` |
| `aws-key` | `AKIA…` / `ASIA…` |
| `api-key` | `sk-…` |
| `slack-token` | `xoxb-`/`xoxp-` 等 |
| `google-key` | `AIza…` |
| `private-key` | PEM 私钥整块 |

**不跟 `redactHome` 走。** 那开关只关路径遮蔽；凭据遮蔽始终生效。两件事性质不同，共用一个开关会让图省事关路径遮蔽的人顺手泄密。

只认**有明确前缀**的凭据，不做高熵猜测：日志里满是提交哈希、会话 id 与 base64 摘要，通用熵检测会把它们一起撕碎。宁可漏掉一个无前缀的密钥，也不毁日志可读性。

### 日志目录的其它防护

- 日志文件一律 **0600**，只有本用户可读
- 目录里自动写 `.gitignore`（内容 `*`），落在任何仓库里都不会被 `git add` 捡走

凭据一旦**进了会话存档**（`session.v4.jsonl.zstd`），插件管不到 —— 那是宿主写的。别把密钥打进对话。已经进去了，用「会话修复」页签的扫描定位，再按帧重写洗掉。

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
    redactHome: true         # 把本机 HOME 前缀遮蔽成 ~（凭据遮蔽始终开启，不受此开关影响）
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

## 会话修复

历史加载失败时（典型报错 `session event at seq <n> lacks an identified message`）用它。

### 为什么会坏

`Session.append()` 只校验事件外壳与 surface 元数据，**不校验消息形状**；消息不变量只在
**加载**日志时才检查。于是插件若用 `session.append('user/message', { content, source })`
写入（缺 `role` / `id`），事件能顺利落盘，却把该日志永久毒化——之后每次加载都失败。
写入方当时毫无感觉，报错出现在很久以后、甚至另一个会话里。

### 四步流水线

界面的「会话修复」页签、`session_repair` 工具、`dsh-journal repair` 命令走的是同一条流水线，
后端只有这一份实现：

| 步骤 | 做什么 | 为什么不能省 |
| --- | --- | --- |
| ① 扫描 | 遍历会话归档，按「文件 size + mtime」指纹缓存 | 不扫描就没有可修的对象；缓存让重复扫描不必重解 100MB+ |
| ② 诊断 | 逐事件校验，定级 `auto` / `manual`，并归因到插件 | 判定必须结构化——按错误文案判会把「同时缺 id 与 source」误判成可自动修 |
| ③ 修复 | 只补 `role` / `id`，只重写含坏事件的帧 | 猜 `source` 会静默改变模型看到的历史，所以一律拒绝 |
| ④ 复验 | 用**宿主的持久化后端**真读一次；读不过就自动回滚 | 自己的校验通过 ≠ 宿主能加载；这才是最终把关 |

### 安全性质

- **默认试运行**。界面先给「修完会怎样」，落盘要再点一次；CLI 要显式 `--apply`。
- **只改坏行**。其余帧原字节保留；修复行用宿主自己的编码器序列化，字段顺序与既有行一致。
- **确定性 id**。由 `sha256(会话id:seq)` 派生 → 同一输入两次修复字节一致（幂等，实测已验证）。
- **先备份后落盘**，临时文件 + `rename` 发布；读取后文件若被并发改动则中止。
- **运行中的会话拒绝修复**：进程内存状态与磁盘必须一致，改写会导致后续追加写错位置。
- **只修登记过的文件**，不接受任意路径。

### 分级的边界

`auto`：只缺 `role` / `id`——两者都能由事件类型唯一推导。
`manual`：`source` 非法、`content` 非数组、`toolCallId` 不匹配、缺消息对象等。
这些一律不猜，只如实报告，让人来判断。

### 模型工具与命令行

```
session_repair(action: scan | fix | fix_all | verify, session?, file?, apply?)
dsh-journal repair [--session <id>] [--apply]
```

## 插件更新

DSH 的插件市场只**报告** `update-available`，自己不升级：官方插件的「更新」由 Discover 页走「先移除、再安装」，第三方插件没有这条路。这个页签把那条路做掉。

界面上的「**插件更新**」页签（或 `journal_updates` 工具、`dsh-journal updates` 命令）会列出 profile 里已安装的插件、当前版本与可用更新，需要时一键升级。

### 两个版本来源

| 来源 | 何时用 | 怎么判 |
|---|---|---|
| **插件市场**（`pluginMarket` 服务） | 装配了市场时优先 | 权威：自带兼容性与版本豁免判断 |
| **npm registry** | 市场没装配时 | 读目标版本的 `engines.dsh`，自己比 |

随附 profile **默认不挂** `pluginMarket`（它由 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 提供），所以多数情况下走的是 registry 这条路。两条都会在界面上写明用的是哪条。

### 升级为什么是「先移除、再安装」

启用 HMR 的 profile 里，在已安装的包上再装一个版本会以 `already-installed` 失败（见 DSH 的 `docs/upgrade-guide/v0.2.1-alpha.2/plugin-install-over-installed`）。所以升级必须是两步。

**移除之后没有回退。** 这个顺序带来一个真实风险：目标版本装不上，插件就没了。所以升级前会先过兼容性：

- 目标版本声明 `engines.dsh` 而当前运行时不满足 → **拦下不升**，并写明要求与现状；
- 版本判断用 `lib/semver.js`，口径**刻意与 DSH 一致**（`semver.satisfies(v, r, { includePrerelease: true })`）。比 DSH 严会拦下本该能升的包；比 DSH 松会在移除之后被 DSH 拒绝安装，把插件弄丢；
- 移除失败或抛异常 → 不再安装，如实报告；
- 移除成功但安装失败 → 明确说「现在处于未安装状态」，不假装还是旧版本。

### 只做该做的事

- **只升级已安装的包。** 不接受任意包名 —— 否则这个接口就成了任意包安装器，一个本地请求就能把任意代码装进 profile。
- **装哪个版本由版本来源决定。** 请求里只能给包名，spec 由来源推导。
- **写操作要显式确认**（接口要 `confirm: true`，界面会再问一次）。
- **本地链接/仓库来源的包不参与**（`link:`、`file:`、绝对路径、`git+`、`github:`）—— 它们没有 registry 版本可升。
- 不可移除的包不能走这条路。

### 模型工具与命令行

```
journal_updates(action: list | apply, name?, confirm?, enabled?)
dsh-journal updates                 # 列出已安装插件与可用更新
dsh-journal updates --apply <包名>   # 升级一个（会先移除旧版，再装新版）
```

命令行自己起不来插件管理服务（它只活在宿主进程里），所以 `updates` 走**运行中的 DSH** 的 HTTP 接口：默认 `http://127.0.0.1:3080`，可用 `--url` 或 `DSH_WEB_URL` 指定。界面没起来时它会明确告诉你。

## 后台日志

DSH 启动失败时会往 `$DSH_HOME/logs/` 写一份诊断快照。这个页签把那些文件读出来：列出、诊断、给出修复方案。**发现最近一次启动失败会主动弹提醒** —— 后台出过事而没人知道，是这类文件最常见的浪费。

### 读的是什么

`startup-<时间>-<uuid>.log`。不是 JSON，是 `util.inspect` 的文本输出，开头一行明确写着「可能含配置与凭据」。所以：

- 解析是**尽力而为的文本匹配**，认不出就如实说认不出，不猜；
- 对外输出一律先过 `redact.js` 遮蔽已知前缀的凭据。

**不读 stdout。** 网关的 stdout 常常是 socket 或终端（`/proc/<pid>/fd/1 -> socket:[...]`），插件拿不到，也读不到历史。这些落盘文件是唯一稳定来源。

### 能认出什么

| 故障 | 判据 |
|---|---|
| 端口被占用 | 失败插件里有 `EADDRINUSE` |
| 插件模块找不到 | `ENOENT` / `Cannot find module` / `exports "./x" but importing` |
| 插件与运行时版本不匹配 | 错误里含 `incompatible with dsh` |
| 必装插件未激活 | 只有启动失败计数，没有失败插件明细 |

认不出的一律不下结论 —— 宁可只报「有故障」，也不为一个未知错误编一个原因。

### 修复工具怎么动

诊断与动手是**分开**的：`plan` 只出方案，`apply` 才动，每一步都会再问一次。

安全边界是这几条：

- **只跑白名单动作。** 绝不把日志里的文本拼成 shell 命令去跑 —— 那样日志里的一句注入就能变成任意代码执行。每个动作是一个具名函数，按 id 找（`inspect-port`、`reinstall-profile`）。
- **命令与参数分开传。** 走 `execFile` 且 `shell: false`，参数不经 shell 展开。端口、profile 名都先做白名单校验，`80; rm -rf /` 这种直接被拒。
- **修完要复查，且只认实时证据。** 日志是历史快照，修好也不会变；把「日志还记着失败」当成「没修好」是错的。所以会区分：没有实时证据就报「无法判定」，不假装修好。

### 模型工具与命令行

```
journal_logs(action: list | read | plan, name?, limit?)
dsh-journal logs                    # 列出全部诊断日志
dsh-journal logs --read <文件名>     # 读一份的结论
dsh-journal logs --plan <文件名>     # 出修复方案（不动手）
```

工具**只读**：列、读、出方案。真正执行要人在面板上点按钮 —— 改系统状态不该由模型自作主张。

## 镜像源

把「国外源换国内镜像」这件事做成一屏：左边是工具清单，右边是选中项的镜像与测速。

覆盖 **npm / pnpm / yarn / pip / Docker / APT / GitHub 加速**。每项显示当前用的是原源还是哪个镜像。

### 两栏

- **左栏**：工具清单。一眼看到每个工具现在用的是原源还是镜像。
- **右栏**：选中项的镜像列表。每个镜像可单独测速、一键切换；顶部有「清除镜像（回原源）」；底部能加一个新地址并测速。

### 改配置的安全边界

这个功能改的是**系统的真实配置**，改错会让 `npm install` / `pip install` 直接失败。所以：

- **只动目标键。** `~/.npmrc` 里的 `_authToken`、`allow-scripts` 等其它行原样保留 —— 弄丢凭据比换错源更麻烦。
- **写前先备份。** 备份名 `<原文件>.dtj-backup-<时间戳>`，可一键恢复。
- **原子写。** 临时文件 + `rename`，不留半个文件；保留原文件权限。
- **非法 JSON 拒绝改写。** Docker 的 `daemon.json` 若语法已坏，硬改会把配置整个毁掉，所以拒绝动手并说明原因。
- **需要 root 的不偷试。** Docker（`/etc/docker/daemon.json`）与 APT（`/etc/apt/sources.list`）在 `/etc` 下，界面不给按钮，只给命令与原因。假装能改比不能改更糟。

### 几处容易搞错的地方

- **pnpm 不读 `~/.npmrc` 的 registry。** 它读 `~/.config/pnpm/auth.ini`。拿 npm 的行判断 pnpm 会得出错误结论（实测踩过）。
- **pip 没有显式「原源」。** 清除镜像 = 删掉 `index-url` 这一行，不是写一个默认值。
- **GitHub 加速不是改配置。** 它是给地址加前缀（`git clone https://gh-proxy.com/https://github.com/x/y`），所以只提供地址与测速。

### 测速

用**轻量端点**（npm 用 `/-/ping`，pip 用 `simple/` 索引），不拉真包 —— 拉包会把「慢」和「大」混在一起。

逐条串行测，不并发：并发会互相干扰延迟读数，测量就不值得信了。

「超时」与「不可达」分开显示：超时说明可能连得上但很慢，不可达说明根本不通。这两种对选择的意义完全不同。

实测参考（同一时刻）：

```
        npmmirror（淘宝）      155ms      HTTP 200
        腾讯云                240ms      HTTP 200
        华为云                296ms      HTTP 200
        CNPM                1232ms     HTTP 200
[原源] 原源                 1560ms     HTTP 200
```

### 提权通道（Docker / APT）

Docker 的 `daemon.json` 与 APT 的 `sources.list` 在 `/etc` 下，只有 root 能改。界面里给这两项配了一条**临时提权通道**：输入 sudo 密码授权，改完可立即取消。

**密码只存在内存里。** 这是硬要求，做法是：

- 存在 `lib/privileged.js` 的模块级变量，**不写文件、不写日志、不出现在任何响应里**；
- 闲置 5 分钟自动失效，另有 30 分钟总时长上限；
- 取消授权时把变量置空，并顺手 `sudo -k` 让 sudo 自己的时间戳缓存也失效；
- **密码走 stdin**（`sudo -S`），不走命令行参数 —— 参数会出现在 `ps` 里，任何本机用户都看得到；
- 文件内容也**不经过 argv**：先写进用户自己的临时文件，再用 `sudo install` 搬过去，密码与内容永远是两条通道；
- 改完的临时文件在 `finally` 里删掉。

**校验用 `sudo -v`。** 它只刷新时间戳，不改任何东西。拿一个写操作去试密码，密码错就会留下半截改动。

**这条通道的边界：** 网关只监听 `127.0.0.1`，所以密码不出这台机器。但本机其它进程仍可能通过 `/proc` 或调试接口碰到宿主内存 —— 这是本方案**接受的风险**，不宣称比这更强。要彻底避免，只能用免密 sudo 白名单或 polkit。

**模型工具没有提权动作。** `journal_mirrors` 只有 `list` 与 `probe`。密码只能人在面板上输 —— 模型不代劳，也不会把密码写进会话记录。

### Docker 的 registry-mirrors 必须是数组

这是**踩过的坑**：Docker 的 schema 要求 `registry-mirrors` 是 `[]string`，写成字符串会让 dockerd **直接起不来** —— 所有容器一起挂。

用 `dockerd --validate` 实测过：

```
{"registry-mirrors": ["https://x"]}   → configuration OK
{"registry-mirrors": "https://x"}     → invalid JSON: cannot unmarshal string
                                        into ... of type []string
```

所以这一项标了 `listValue`：写入时**永远**包成数组，传单个字符串也包；读的时候把历史遗留的字符串纠成数组形态显示，再写一次就修好。

界面也支持一次填多个镜像（逗号或空格分隔），因为 Docker 会按顺序试。清空写成 `[]`（表示不用镜像直连），也是合法状态。

### 落盘前的校验闸门

Docker 这一项在写入前后各过一道 `dockerd --validate`：

1. **写前**：把将要写入的内容放进临时文件问 dockerd 收不收。不收就**放弃**，一个字节都不动。
2. **写后**：重新读回来再验一次，并且**在重启之前**验 —— 写入过程出问题（截断、编码）能立刻发现。

没有这道闸门的话，「写错 + 重启」= 所有容器下线。`dockerd --validate` 不需要 root，这个闸门很便宜。

### APT 只改官方源

`/etc/apt/sources.list` 里可能混着多个源，而 `sources.list.d/` 下是 docker / vscode / chrome 等**第三方仓库**。改写时只认**路径正好是 `/debian` 或 `/debian-security`** 的行：

```
deb http://deb.debian.org/debian trixie main        → 改
deb http://security.debian.org/debian-security ...  → 改（安全更新也要换，只换一个会漏）
deb https://download.docker.com/linux/debian ...     → 不动（路径不是 /debian）
```

Debian 的源分主仓库与安全更新两个域名，所以每个镜像都同时记了 `url` 与 `security` 两个地址。

### 模型工具与命令行

```
journal_mirrors(action: list | probe, id?, url?, timeout?)
```

工具**只读**：看现状、测速。换源会改真实配置，只能人在面板上点。

## 关于

一个回答「这个插件自己怎么样」的页签，省得去翻文件系统。

**基本信息**：本地安装路径、版本、来源（链接安装还是 registry）、装在哪个 profile、许可、版本要求、依赖数。

**☆ 去 GitHub 点 Star**：顺带显示 star / fork / issue 数。数据来自 GitHub 公开接口，带 10 分钟缓存 —— 未认证接口每小时只有 60 次，一个统计数字不值得把额度打光。拿不到数据**不报错，只降级**显示「暂不可用」。设了 `GH_TOKEN` / `GITHUB_TOKEN` 就用上（额度更高）。

**安装与卸载命令**：点一下复制。
```
dsh plugin --profile web add dsh-task-journal
dsh plugin --profile web remove dsh-task-journal
```

**升级**：复用「插件更新」那套已测过的逻辑，只是聚焦到本插件。

**热重载状态**：见下。

**全部已安装插件**：一张表，标出哪些是本地来源（不随 registry 升级）。

### 「跑的是不是磁盘上那份代码」

这是这个页签最该回答的问题。插件加载进内存之后，磁盘上的文件可能已经被改过 —— 界面显示「0.1.0」并不代表**正在跑**的就是那份 0.1.0，可能跑的是十分钟前的代码。

所以把「进程启动时间」和「源码文件修改时间」摆在一起。源码比进程新 → 明确提示「这次改动还没生效」。

### 热重载计数为什么不能放在模块里

热重载会**重新导入模块**，模块内的变量全部重置。计数器放在模块里就永远是 0，等于没测。所以挂在 `globalThis` 上（用 `Symbol.for` 做键，多次导入拿到同一个）。

- `moduleLoads`：本进程内该模块被求值几次。**大于 1 就说明热重载真的发生过**。
- `reloadCount`：本实例订阅到的 `hmr/reload` 事件数（热重载后会重新计数，所以可能小于 `moduleLoads`）。

订阅不到事件时如实标注「未订阅」，让「0 次」不被当成确凿结论。

**实测结论：本插件不会热重载。** 改内容后运行中的实例仍执行旧代码，`moduleLoads` 保持 1。原因是 DSH 的 HMR 只监视自己的根目录，而插件装在 `$DSH_HOME/plugins/` 下，不在监视范围内。

所以界面**不写**「等它自动热重载」这种话 —— 那是猜测，会让人白等。改成按证据说：「本进程内插件模块只加载过 N 次，没发生过热重载 —— 需要重启网关才生效」。

## 自测

```bash
cd ~/.dsh/plugins/dsh-task-journal
node verify-all.mjs        # 一键跑全部（推荐）
```

或逐个跑：

```bash
node verify.mjs            # 插件逻辑
node verify-cli.mjs        # 命令行
node verify-api.mjs        # 界面 API
node verify-subagent.mjs   # 子智能体目录 / 归档 / 记录 / 接口
node verify-repair.mjs     # 会话修复流水线（自造损坏样本）
node verify-updates.mjs    # 插件更新（版本比较、兼容性拦截、升级顺序）
node verify-logs.mjs       # 后台日志（解析、诊断、修复白名单、路径穿越）
node verify-mirrors.mjs    # 镜像源（清单、配置改写、备份恢复、测速）
node verify-about.mjs      # 关于（仓库归一化、GitHub 降级、热重载、profile 检测）
node verify-client.mjs     # 浏览器半渲染（含「会话修复」页签）
```

共 **935 项**。覆盖：自动落盘、注入上下文排除、追加语义、自定义目录、全部工具、子代理会话排除、
禁用开关、超长截断、工具名映射、模型参数记录、用量、未完成任务与错误码、导出、重试、
CLI 全部子命令与错误处理、子智能体分类与标签、运行期自动发现、HOME 遮蔽、凭据遮蔽、
归档凭据擦除（帧级最小性、幂等、头部命中）、
日志目录权限与自忽略、归档产物、源码定位（找得到与找不到两种）、`subagents-*.md` 记录、
`/subagents/*` 全部接口，
以及会话修复的：帧结构切分、诊断与归因、修复最小性、幂等、回滚、
四步 API 串接、活跃会话跳过、路径遮蔽、浏览器半渲染；
插件更新的：语义化版本比较与范围判断（口径对齐 DSH 的 includePrerelease）、
来源判定、市场路径与 registry 退路、兼容性拦截、升级顺序与参数、
各种失败处理、接口与工具；
后台日志的：文件名与头部解析、四种故障诊断、认不出时不编结论、
白名单动作、命令注入拦截、路径穿越拦截、凭据遮蔽、
复查只认实时证据、接口与工具；
镜像源的：清单完整性、各格式读值、改写只动目标键（保留 token 等其它行）、
备份与恢复、非法 JSON 拒绝改写、测速的超时与不可达分离、接口与工具；
提权的：密码只走 stdin 不进 argv、文件内容不经过 argv、未授权一律不执行、
授权过期、取消授权并清 sudo 缓存、地址校验（数组/伪协议/控制字符全拒）、
APT 只改官方源不动第三方仓库、工具里没有提权动作、
Docker 的 registry-mirrors 必须是数组（含 dockerd --validate 实测）、
历史遗留的字符串写法会被纠回数组、列表混入非法项整批拒绝；
关于的：仓库地址归一化（SSH/HTTPS/git+/简写）、GitHub 降级不报错、
限流不缓存而成功要缓存、token 只在有值时带上、
热重载计数跨模块重载累计、「磁盘比进程新」判定、profile 从磁盘检测。

修复相关的自测**自造损坏样本**，不依赖真实会话数据，也不需要 DSH 宿主。

## 实现要点

- host 半插件 + 手写 client 半。
- 依赖 `@deepseek-ai/dsh-tools`（`defineTool`）。工具输出 schema 用**受约束的 JSON Schema 子集**：
  对象节点必须显式写 `additionalProperties`，否则注册会被拒绝。
- 订阅 `session/event`：`user/message`、`assistant/message`、`tool/call`、`tool/result`、`request/header`、`turn/end`。
- 订阅 `subagent/start` 与 `subagent/end` 记录委派生命周期。
- 子智能体目录与归档在 `lib/subagent-catalog.js`，host 半与 CLI 共用同一份实现。
- 会话修复在 `lib/session-repair.js`，界面 / 工具 / CLI 共用同一份实现。
  它只用 node 内建模块、**不 import 宿主包**：插件进程解析不到 `@deepseek-ai/dsh-session*`，
  所以校验不变量在本地按宿主语义复刻一份，最终把关改走宿主已注册的 `sessionPersistence` 服务。
- 帧切分按 zstd 的 frame/block 结构走，**不扫魔数**——魔数可能出现在压缩块内部，
  按魔数切帧会把一个帧切碎并静默丢事件。
- `journal_retry` 走 `agent.followup()`，且必须在事件分发之外调用（`setTimeout(0)`），否则宿主拒绝重入 append。
- 写入用 `appendFile`；导出用 `copyFile`；源码归档用 `copyFile` 递归复制。

## License

MIT
