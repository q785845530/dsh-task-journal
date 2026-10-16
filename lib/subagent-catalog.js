/**
 * dsh-task-journal — 子智能体目录（subagent catalog）。
 *
 * 这里回答四个问题：
 *   1) 本机有哪些子智能体（内置目录 + 运行期自动发现）；
 *   2) 每个子智能体属于软件开发的哪一类（分类标签）；
 *   3) 怎么调用它（参数、示例、返回值）；
 *   4) 它的代码在哪、怎么把它持久化下来（调用规格 + 预设文件 + 源码归档）。
 *
 * 目录是**只读知识**：真实能否委派取决于当前组装里挂了哪些 provider 与工具，
 * 所以条目带 `availability` 字段，由运行期探测回填，不猜测。
 *
 * @module dsh-task-journal/subagent-catalog
 */
import { mkdir, writeFile, readdir, readFile, copyFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// ————————————————————————————— 分类标签 —————————————————————————————

/**
 * 按软件开发维度划分的分类。每个子智能体给一个主分类（category）与若干细标签（tags）。
 * 标签是稳定的英文 id，界面负责显示中文名。
 */
export const CATEGORIES = {
  requirement: { label: '需求与规划', order: 10, desc: '拆解需求、定范围、排计划' },
  architecture: { label: '架构与设计', order: 20, desc: '系统结构、接口契约、技术选型' },
  frontend: { label: '前端', order: 30, desc: '界面、交互、样式、浏览器侧逻辑' },
  backend: { label: '后端', order: 40, desc: '服务端逻辑、接口实现、通用编码' },
  data: { label: '数据与存储', order: 50, desc: '数据库、查询、数据管道、指标' },
  testing: { label: '测试与质量', order: 60, desc: '用例、回归、稳定性、缺陷复现' },
  review: { label: '代码审查', order: 70, desc: '读 diff、找问题、给修改意见' },
  security: { label: '安全', order: 80, desc: '漏洞、密钥、权限、注入面' },
  devops: { label: '构建与部署', order: 90, desc: '构建、发布、环境、进程与编排' },
  docs: { label: '文档', order: 100, desc: 'README、注释、交付说明' },
  research: { label: '调研', order: 110, desc: '查资料、读代码库、比方案' },
  writing: { label: '创作写作', order: 120, desc: '长篇文本、剧本、叙事结构' },
}

/** 分类 id 列表（按 order 排序）。 */
export function categoryIds() {
  return Object.keys(CATEGORIES).sort((a, b) => CATEGORIES[a].order - CATEGORIES[b].order)
}

/** 未知分类归到这里，而不是丢弃。 */
export const DEFAULT_CATEGORY = 'backend'

/** 归一化分类：接受中文名、id、常见别名；不认识的按关键词猜，最后落到默认。 */
export function normalizeCategory(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return DEFAULT_CATEGORY
  if (CATEGORIES[s] !== undefined) return s
  for (const [id, c] of Object.entries(CATEGORIES)) {
    if (c.label === s) return id
  }
  const guess = [
    ['frontend', /前端|界面|ui|react|vue|样式|css/i],
    ['testing', /测试|用例|回归|test|qa|稳定/i],
    ['review', /审查|评审|review|diff/i],
    ['security', /安全|漏洞|密钥|security|权限/i],
    ['devops', /部署|构建|发布|ci|cd|容器|docker|进程|编排|团队|team/i],
    ['data', /数据|数据库|sql|查询|指标|仓库|存储/i],
    ['docs', /文档|说明|readme|注释/i],
    ['research', /调研|检索|研究|搜索|探索|查/i],
    ['writing', /写作|小说|剧本|叙事|文稿/i],
    ['architecture', /架构|设计|选型|契约/i],
    ['requirement', /需求|规划|计划|拆解/i],
  ]
  for (const [id, re] of guess) if (re.test(s)) return id
  return DEFAULT_CATEGORY
}

// ————————————————————————————— 内置目录 —————————————————————————————

/**
 * 内置目录：DSH 官方子智能体后端与模型面向的委派工具。
 * 条目里的包名与 provider 名取自本机 deepseek-harness 检出（packages/subagent/*），
 * 属于可核对的事实；`usage` 是给使用者看的调用方法。
 */
export const BUILTIN = [
  // —— 后端 provider：一次性子智能体 ——
  {
    id: 'subagent-spawn',
    name: 'spawn 子智能体',
    category: 'backend',
    tags: ['backend', 'delegation', 'one-shot'],
    kind: 'provider',
    provider: 'spawn',
    tool: 'subagent',
    package: '@deepseek-ai/dsh-subagent-spawn-in-process',
    summary: '在进程内起一个全新上下文的子智能体，跑完一轮把结论返回给父会话。',
    when: '子任务独立、可并行，或者细节会污染主线上下文时。',
    usage: '调用 `subagent` 工具；`provider: spawn`。默认前台等结果，`run_in_background: true` 变成后台任务（用 job_output 取回）。',
    params: [
      ['description', '3-5 词的任务描述，用于展示', '是'],
      ['prompt', '完整、自包含的任务说明（子智能体看不到本会话上下文）', '是'],
      ['run_in_background', '是否后台执行，默认 false', '否'],
    ],
    example: 'subagent({ description: "核对接口契约", prompt: "读 packages/api/src/index.ts，列出所有导出函数的签名与错误码。" })',
  },
  {
    id: 'subagent-fork',
    name: 'fork 子智能体',
    category: 'review',
    tags: ['review', 'delegation', 'context-fork'],
    kind: 'provider',
    provider: 'fork',
    tool: 'subagent_fork',
    package: '@deepseek-ai/dsh-subagent-fork-in-process',
    summary: '把子智能体建立在父会话已完成轮次的前缀之上，让它带着上下文继续干活。',
    when: '子任务依赖本会话已有的上下文——审阅、追问、基于同一份材料再分析。',
    usage: '调用 `subagent_fork`。子智能体继承本会话到此为止的已完成轮次，因此不必重复粘贴背景。',
    params: [
      ['description', '3-5 词的任务描述', '是'],
      ['prompt', '在已有上下文之上要做什么', '是'],
    ],
    example: 'subagent_fork({ description: "审阅本次改动", prompt: "针对上面的实现给出对抗式审查：列出真实缺陷、边界情况与遗漏的测试。" })',
  },
  {
    id: 'subagent-acp',
    name: 'ACP 子智能体',
    category: 'devops',
    tags: ['devops', 'out-of-process', 'acp'],
    kind: 'provider',
    provider: 'acp',
    package: '@deepseek-ai/dsh-subagent-acp',
    summary: '把子智能体放到独立子进程里，通过 Agent Client Protocol 驱动。',
    when: '需要进程隔离，或对接实现了 ACP 的外部 agent。',
    usage: '组合里挂 `@deepseek-ai/dsh-subagent-acp` 后，用 provider 名 `acp` 通过 subagent 工具委派。',
    params: [['provider', '固定为 acp', '是']],
    example: '在 profile 里挂载 acp 后端，并把 tool-subagent 的 `provider` 设为 `acp`。',
  },
  {
    id: 'subagent-dsh-sdk',
    name: 'DSH SDK 子智能体',
    category: 'devops',
    tags: ['devops', 'out-of-process', 'sdk'],
    kind: 'provider',
    provider: 'dsh-sdk',
    package: '@deepseek-ai/dsh-subagent-dsh-sdk',
    summary: '另起一个 DSH runtime 子进程，用 stdio JSON-RPC 驱动；子进程有独立的 Harness home。',
    when: '需要完全隔离的运行环境（不同 profile、不同凭据、独立工作区）。',
    usage: '配置 `providerName`/`profile`/`patches`/`dshHome`，再用该 provider 名委派。',
    params: [
      ['providerName', 'provider 名，默认 dsh-sdk', '是'],
      ['profile', '子进程使用的 profile 名，默认 sdk', '是'],
      ['dshHome', '子进程独立的 Harness home（绝对路径）', '是'],
    ],
    example: 'tool-subagent 配置 `provider: dsh-sdk`，子任务在隔离 home 里跑。',
  },
  {
    id: 'subagent-codex',
    name: 'Codex 子智能体',
    category: 'backend',
    tags: ['backend', 'out-of-process', 'codex'],
    kind: 'provider',
    provider: 'codex',
    package: '@deepseek-ai/dsh-subagent-codex',
    summary: '通过官方 app-server 协议驱动一次性的 Codex 子智能体。',
    when: '希望用 Codex 的能力处理某个独立子任务。',
    usage: '配置 `model` 与 `permissionMode` 后，用 provider 名 `codex` 委派。',
    params: [
      ['providerName', 'provider 名，默认 codex', '是'],
      ['permissionMode', 'never / approve-for-me / dangerously-bypass-approvals-and-sandbox', '否'],
    ],
    example: 'provider 设为 `codex`，让 Codex 做一次独立实现或迁移。',
  },
  {
    id: 'subagent-claude-code',
    name: 'Claude Code 子智能体',
    category: 'backend',
    tags: ['backend', 'out-of-process', 'claude-code'],
    kind: 'provider',
    provider: 'claude-code',
    package: '@deepseek-ai/dsh-subagent-claude-code',
    summary: '通过官方 Agent SDK 驱动一次性的 Claude Code 子智能体。',
    when: '希望用 Claude Code 的能力处理某个独立子任务。',
    usage: '配置 `model` 与 `permissionMode`（默认 dontAsk）后，用 provider 名 `claude-code` 委派。',
    params: [
      ['providerName', 'provider 名，默认 claude-code', '是'],
      ['permissionMode', 'dontAsk / acceptEdits / auto / plan / bypassPermissions', '否'],
    ],
    example: 'provider 设为 `claude-code`，让 Claude Code 写一个独立模块。',
  },

  // —— 模型面向工具：编排与团队 ——
  {
    id: 'tool-subagent-control',
    name: '子智能体控制（send_message / list_agents / interrupt_agent）',
    category: 'devops',
    tags: ['devops', 'orchestration', 'control'],
    kind: 'tool',
    tool: 'send_message',
    package: '@deepseek-ai/dsh-tool-subagent-control',
    summary: '对**持续型**子智能体做后续操作：再发消息、查列表、打断当前轮次。',
    when: '子智能体不是一次性跑完，而要来回多轮；或要看当前有哪些活跃子智能体。',
    usage: '用 `send_message` 给子智能体追加指令（它会在最近的步骤边界收到）；`list_agents` 列出成员与状态；`interrupt_agent` 打断当前轮次但保留待处理消息。',
    params: [
      ['target', '子智能体 id/名称（send_message、interrupt_agent 必填）', '是'],
      ['message', '要投递的消息内容（send_message 必填，自包含）', '是'],
    ],
    example: 'send_message({ target: "reviewer", message: "再确认一下超时路径的错误码是否与文档一致。" })',
  },
  {
    id: 'agent-team',
    name: 'Agent Teams 队友',
    category: 'devops',
    tags: ['devops', 'orchestration', 'team'],
    kind: 'tool',
    tool: 'spawn_teammate',
    package: 'DSH Agent Teams',
    summary: '创建**持久**队友（有自己的会话与邮箱），用共享任务板分工协作。',
    when: '一个任务要拆成多块并行推进，且需要共享任务板、依赖顺序与写作用域隔离。',
    usage: '`spawn_teammate` 建队友（context: fresh/fork）→ `team_task_create` 建共享任务（写清 write_scopes 与 blocked_by）→ 队友 `team_task_update` 认领并完成 → Lead 收尾前 `list_agents` + `wait_agent` 等齐。',
    params: [
      ['name', '队友名（小写连字符）', '是'],
      ['description', '职责一句话', '是'],
      ['prompt', '自包含的初始任务', '是'],
      ['context', 'fresh（不带 Lead 历史）或 fork（继承已完成轮次）', '否'],
    ],
    example: '先用 team_task_create 建任务，再 spawn_teammate 分派；每个队友的写作用域不重叠。',
  },
  {
    id: 'workflow',
    name: 'workflow 批量编排',
    category: 'devops',
    tags: ['devops', 'orchestration', 'fan-out', 'script'],
    kind: 'tool',
    tool: 'workflow',
    package: 'DSH workflow',
    summary: '用一段 JavaScript 脚本把工作扇出到大量子智能体，带阶段与结构化结果。',
    when: '要对很多文件/条目做同一套处理（审计、迁移、多角度调研、对抗式验证）。',
    usage: '写脚本体，用 `agent(prompt, {schema})` 跑一个子智能体、`pipeline(items, ...stages)` 做无屏障多阶段、`phase(title)`/`log(msg)` 报告进度。脚本没有文件系统与网络，干活的是子智能体。',
    params: [
      ['script', 'JavaScript 脚本体（支持顶层 await，结尾 return 结果）', '是'],
      ['meta', 'workflow 身份：name/description/phases', '是'],
      ['args', '暴露给脚本的 JSON 输入（作为 args 全局）', '否'],
    ],
    example: '对 N 个模块并行做「找缺陷 → 对抗验证」，用 pipeline 串两阶段，最后汇总为结构化结果。',
  },
  {
    id: 'oh-story-role',
    name: 'Oh Story 专注角色',
    category: 'writing',
    tags: ['writing', 'specialist', 'story'],
    kind: 'tool',
    tool: 'oh_story_role',
    package: 'oh-story',
    summary: '按角色起一个专注子智能体（拆章、设计角色、连续性检查、叙事写作等）。',
    when: '长篇创作流程里要做某个明确环节，且希望它独立于主线上下文。',
    usage: '指定 role 与一段自包含 prompt 即可；子智能体继承当前工作区与权限。',
    params: [
      ['role', 'chapter-extractor / character-designer / consistency-checker / narrative-writer / story-architect / story-explorer / story-researcher', '是'],
      ['prompt', '自包含任务说明', '是'],
    ],
    example: 'oh_story_role({ role: "consistency-checker", prompt: "检查第 0400–0450 章的人称与刻痕计数是否自洽。" })',
  },
  {
    id: 'list-subagent-models',
    name: '子智能体模型选择',
    category: 'devops',
    tags: ['devops', 'model', 'routing'],
    kind: 'tool',
    tool: 'list_subagent_models',
    package: '@deepseek-ai/dsh-tool-subagent',
    summary: '列出可为子智能体指定的 provider / model / reasoning effort。',
    when: '想让某个子任务用更便宜或更强的模型，先查可用组合。',
    usage: '需要 tool-subagent 开 `modelSelectionSettings: true`；随后 subagent 调用可带 `provider`/`model`/`reasoning_effort`。',
    params: [['（无）', '直接调用即返回可用路由', '—']],
    example: 'list_subagent_models() → 选一个精确路由，再在 subagent 调用里带上 provider+model。',
  },
]

// ————————————————————————————— 条目归一化 —————————————————————————————

/** 内置条目按 id 建索引。 */
const BUILTIN_BY_ID = new Map(BUILTIN.map((e) => [e.id, e]))

/** provider 名 → 内置条目 id。 */
const BUILTIN_BY_PROVIDER = new Map(
  BUILTIN.filter((e) => typeof e.provider === 'string' && e.provider !== '').map((e) => [e.provider, e.id]),
)

/** 工具名 → 内置条目 id。 */
const BUILTIN_BY_TOOL = new Map(
  BUILTIN.filter((e) => typeof e.tool === 'string' && e.tool !== '').map((e) => [e.tool, e.id]),
)

/** 取一份内置目录的深拷贝，避免调用方改到模块常量。 */
export function builtinEntries() {
  return BUILTIN.map((e) => ({ ...e, tags: [...(e.tags ?? [])], params: (e.params ?? []).map((p) => [...p]) }))
}

/** 用运行期事实补齐/覆盖一个条目。 */
function mergeEntry(base, patch) {
  const out = { ...base, ...patch }
  out.tags = [...new Set([...(base.tags ?? []), ...(patch.tags ?? [])])]
  out.category = normalizeCategory(out.category)
  return out
}

/**
 * 自动发现：把运行期看到的东西并进目录。
 *
 * 三个来源，全部**只依据观察到的事实**：
 *   - providers：ctx.subagents.list() 返回的 provider 名；
 *   - tools：当前组装里模型可见的工具名（含委派类工具）；
 *   - runs：本次会话里出现过的 subagent/start 事件（记录 id 与 provider）。
 *
 * 发现到内置目录里没有的项时，新建一条 `source: discovered` 条目，而不是丢掉。
 * @param observed - `{ providers, tools, runs }`。
 * @param base - 基础目录（默认内置）。
 * @returns 合并后的条目数组。
 */
export function mergeObserved(observed, base = builtinEntries()) {
  const byId = new Map(base.map((e) => [e.id, e]))
  const now = Date.now()

  const touch = (id, extra) => {
    const cur = byId.get(id)
    if (cur === undefined) return
    byId.set(id, { ...cur, ...extra, lastSeen: now, availability: 'available' })
  }

  for (const p of observed?.providers ?? []) {
    const name = String(p)
    const hit = BUILTIN_BY_PROVIDER.get(name)
    if (hit !== undefined) { touch(hit, {}); continue }
    byId.set(`provider:${name}`, {
      id: `provider:${name}`,
      name: `${name} 子智能体（运行期发现）`,
      category: DEFAULT_CATEGORY,
      tags: ['discovered', 'provider'],
      kind: 'provider',
      provider: name,
      source: 'discovered',
      summary: `当前组装里注册了名为 ${name} 的子智能体后端。`,
      when: '按该 provider 的能力判断；本地目录暂无它的说明。',
      usage: `用 subagent 工具并把 provider 设为 \`${name}\`。`,
      params: [['provider', name, '是']],
      availability: 'available',
      lastSeen: now,
    })
  }

  for (const t of observed?.tools ?? []) {
    const name = String(t)
    const hit = BUILTIN_BY_TOOL.get(name)
    if (hit !== undefined) { touch(hit, {}); continue }
    byId.set(`tool:${name}`, {
      id: `tool:${name}`,
      name: `${name}（运行期发现）`,
      category: DEFAULT_CATEGORY,
      tags: ['discovered', 'tool'],
      kind: 'tool',
      tool: name,
      source: 'discovered',
      summary: `当前组装里模型可见名为 ${name} 的工具。`,
      when: '按该工具的说明判断；本地目录暂无它的说明。',
      usage: `直接调用 \`${name}\`；详细参数读它的工具描述。`,
      params: [],
      availability: 'available',
      lastSeen: now,
    })
  }

  for (const r of observed?.runs ?? []) {
    const provider = String(r?.provider ?? '')
    const hit = BUILTIN_BY_PROVIDER.get(provider)
    if (hit !== undefined) {
      const cur = byId.get(hit)
      byId.set(hit, {
        ...cur,
        runCount: (cur.runCount ?? 0) + 1,
        lastRunId: r?.id ?? null,
        lastSeen: now,
        availability: 'used',
      })
    }
  }

  return [...byId.values()].sort(compareEntries)
}

/** 排序：分类顺序 → 内置优先 → 名称。 */
export function compareEntries(a, b) {
  const ca = CATEGORIES[a.category]?.order ?? 999
  const cb = CATEGORIES[b.category]?.order ?? 999
  if (ca !== cb) return ca - cb
  const sa = a.source === 'discovered' ? 1 : 0
  const sb = b.source === 'discovered' ? 1 : 0
  if (sa !== sb) return sa - sb
  return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')
}

/** 按分类分组，供界面直接渲染。 */
export function groupByCategory(entries) {
  const groups = new Map()
  for (const id of categoryIds()) groups.set(id, [])
  groups.set('other', [])
  for (const e of entries) {
    const key = CATEGORIES[e.category] !== undefined ? e.category : 'other'
    groups.get(key).push(e)
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([id, list]) => ({
      id,
      label: CATEGORIES[id]?.label ?? '其他',
      desc: CATEGORIES[id]?.desc ?? '',
      entries: list,
    }))
}

// ————————————————————————————— 路径遮蔽 —————————————————————————————

/**
 * 把本机 HOME 前缀换成 `~`，避免日志与界面泄露这台电脑的用户名与目录结构。
 *
 * 只做前缀替换，不改路径其余部分；`<home>/a/b` → `~/a/b`。
 * @param p - 原始路径文本。
 * @param home - HOME 目录（默认 homedir()）。
 * @returns 遮蔽后的文本。
 */
export function redactHome(p, home = homedir()) {
  const s = String(p ?? '')
  if (s === '' || home === '') return s
  if (s === home) return '~'
  if (s.startsWith(`${home}/`)) return `~${s.slice(home.length)}`
  // 文本里嵌了绝对路径的情形：整段替换。
  return s.split(home).join('~')
}

/** 递归遮蔽对象/数组里所有字符串值（返回新对象，不改原对象）。 */
export function redactDeep(value, home = homedir()) {
  if (typeof value === 'string') return redactHome(value, home)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, home))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, home)
    return out
  }
  return value
}

// ————————————————————————————— 持久化 —————————————————————————————

/** 子智能体归档的目录名（放在会话日志目录下）。 */
export const SUBAGENT_DIRNAME = 'subagents'

/** 归档根目录。 */
export function subagentDir(logDir) {
  return join(logDir, SUBAGENT_DIRNAME)
}

/** 一份可读的条目 Markdown。 */
export function entryMarkdown(e) {
  const cat = CATEGORIES[e.category]?.label ?? e.category
  const lines = [
    `# ${e.name}`,
    '',
    `- id：\`${e.id}\``,
    `- 分类：**${cat}**（\`${e.category}\`）`,
    `- 标签：${(e.tags ?? []).map((t) => `\`${t}\``).join('、') || '—'}`,
    `- 类型：${e.kind === 'tool' ? '模型工具' : '子智能体后端（provider）'}`,
    `- 来源：${e.source === 'discovered' ? '运行期自动发现' : '内置目录'}`,
    e.package ? `- 所属包：\`${e.package}\`` : null,
    e.provider ? `- provider：\`${e.provider}\`` : null,
    e.tool ? `- 工具名：\`${e.tool}\`` : null,
    e.availability ? `- 可用性：${e.availability}` : null,
    '',
    '## 功能',
    '',
    e.summary ?? '（未描述）',
    '',
    '## 什么时候用',
    '',
    e.when ?? '（未描述）',
    '',
    '## 怎么用',
    '',
    e.usage ?? '（未描述）',
    '',
  ]
  if (Array.isArray(e.params) && e.params.length > 0) {
    lines.push('## 参数', '', '| 参数 | 说明 | 必填 |', '| --- | --- | --- |')
    for (const p of e.params) lines.push(`| \`${p[0]}\` | ${p[1]} | ${p[2] ?? '—'} |`)
    lines.push('')
  }
  if (e.example) {
    lines.push('## 调用示例', '', '```js', e.example, '```', '')
  }
  return lines.filter((l) => l !== null).join('\n')
}

/** 可执行的 preset 文件（DSH agent preset 形态）。 */
export function presetYml(e) {
  return [
    `name: ${e.name}`,
    `description: ${e.summary ?? ''}`,
    `order: ${CATEGORIES[e.category]?.order ?? 900}`,
    `category: ${e.category}`,
    `tags: [${(e.tags ?? []).join(', ')}]`,
    '',
  ].join('\n')
}

/** preset 的组装说明：写清怎么挂到某个 provider / 工具上。 */
export function presetCordisYml(e) {
  const head = [
    `# ${e.name} — 由 dsh-task-journal 归档生成的预设层。`,
    `# 用途：把「${e.summary ?? ''}」固化下来，后续任务可直接按此组合调用。`,
    '# 该文件是**说明性归档**：请把它并入你的 profile patch，而不是直接覆盖现有组装。',
    '',
  ]
  if (e.kind === 'provider') {
    head.push(
      '# 1) 挂后端 provider',
      '- name: ' + (e.package ?? '@deepseek-ai/dsh-subagent'),
      ...(e.provider ? ['  config:', `    providerName: ${e.provider}`] : []),
      '',
      '# 2) 暴露模型工具，并指向该 provider',
      "- name: '@deepseek-ai/dsh-tool-subagent'",
      '  config:',
      `    provider: ${e.provider ?? 'spawn'}`,
      `    toolName: ${e.tool ?? 'subagent'}`,
      '',
    )
  } else {
    head.push(
      '# 这是一个模型工具，由所属插件提供；挂载对应插件即可用。',
      `- name: ${e.package ?? '(见说明)'}`,
      '  config: {}',
      '',
    )
  }
  head.push('', '# 调用方法：', ...String(e.usage ?? '').split('\n').map((l) => `# ${l}`), '')
  return head.join('\n')
}

/**
 * 把目录持久化到磁盘。
 *
 * 产出：
 *   <dir>/catalog.json                 机读全量目录
 *   <dir>/catalog.md                   人读全量目录（按分类分组）
 *   <dir>/entries/<safeId>.md          单条：功能 / 用法 / 参数 / 示例
 *   <dir>/entries/<safeId>.json        单条机读规格
 *   <dir>/presets/<safeId>/preset.yml      可执行预设
 *   <dir>/presets/<safeId>/agent.cordis.yml 组装说明
 *
 * 只覆盖本插件自己生成的文件，不动用户放进来的东西。
 * @param dir - 归档根（通常是日志目录）。
 * @param entries - 条目数组。
 * @param opts - `{ home }` 用于路径遮蔽。
 * @returns 写出的文件清单与统计。
 */
export async function writeCatalog(dir, entries, opts = {}) {
  const home = opts.home ?? homedir()
  const root = subagentDir(dir)
  const entriesDir = join(root, 'entries')
  const presetsDir = join(root, 'presets')
  await mkdir(entriesDir, { recursive: true })
  await mkdir(presetsDir, { recursive: true })

  const files = []
  const write = async (p, text) => {
    await writeFile(p, text, 'utf8')
    files.push(p)
  }

  const publicEntries = entries.map((e) => redactDeep(e, home))
  await write(join(root, 'catalog.json'),
    `${JSON.stringify({ generatedAt: Date.now(), count: publicEntries.length, categories: CATEGORIES, entries: publicEntries }, null, 2)}\n`)

  const md = ['# 子智能体目录', '',
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 条目数：${publicEntries.length}`,
    `- 分类数：${groupByCategory(publicEntries).length}`,
    '', '---', '']
  for (const g of groupByCategory(publicEntries)) {
    md.push(`## ${g.label}（\`${g.id}\`）`, '', g.desc, '')
    for (const e of g.entries) {
      md.push(`- **${e.name}**（\`${e.id}\`）｜${e.source === 'discovered' ? '运行期发现' : '内置'}`)
      md.push(`  - 功能：${e.summary ?? '—'}`)
      md.push(`  - 用法：${String(e.usage ?? '—').split('\n')[0]}`)
    }
    md.push('')
  }
  await write(join(root, 'catalog.md'), md.join('\n'))

  for (const e of publicEntries) {
    const sid = safeFileId(e.id)
    await write(join(entriesDir, `${sid}.md`), entryMarkdown(e))
    await write(join(entriesDir, `${sid}.json`), `${JSON.stringify(e, null, 2)}\n`)
    const pd = join(presetsDir, sid)
    await mkdir(pd, { recursive: true })
    await write(join(pd, 'preset.yml'), presetYml(e))
    await write(join(pd, 'agent.cordis.yml'), presetCordisYml(e))
    files.push(join(pd, 'preset.yml'), join(pd, 'agent.cordis.yml'))
  }

  return { dir: root, files, count: publicEntries.length }
}

/** 文件名安全化（保留 `:` 之外的可读性——冒号换成 `-`）。 */
export function safeFileId(id) {
  return String(id ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 80)
}

// ————————————————————————————— 源码归档 —————————————————————————————

/** 找「包里声明的源码根」：优先 src/，其次 lib/。 */
async function sourceRootOf(pkgDir) {
  for (const name of ['src', 'lib']) {
    const p = join(pkgDir, name)
    if (existsSync(p)) {
      try {
        const st = await stat(p)
        if (st.isDirectory()) return p
      } catch { /* 忽略 */ }
    }
  }
  return null
}

/**
 * 在候选根里按 **package.json 的 name 字段** 定位一个包。
 *
 * 目录名与包名经常不一致（monorepo 里 `@deepseek-ai/dsh-subagent-spawn-in-process`
 * 可能落在 `packages/subagent/subagent-spawn-in-process/`），所以不猜目录名，
 * 而是读 package.json 核对。
 *
 * 用**逐层扫描（BFS）**而不是深度优先：包在树里通常不深，深度优先会先钻进
 * 第一个子目录的深处、把预算耗光，反而漏掉旁边就有的目标。
 *
 * @param roots - 候选根目录列表。
 * @param pkg - 目标包名。
 * @param opts - `{ maxDepth, maxEntries }`。
 * @returns 找到的包目录（绝对路径）或 null。
 */
async function findPackageDir(roots, pkg, opts = {}) {
  const maxDepth = opts.maxDepth ?? 4
  const maxEntries = opts.maxEntries ?? 4000
  let visited = 0
  const seen = new Set()

  /** 该目录的 package.json 是否声明了目标包名。 */
  const matches = async (dir) => {
    const pj = join(dir, 'package.json')
    if (!existsSync(pj)) return false
    try {
      const j = JSON.parse(await readFile(pj, 'utf8'))
      return j?.name === pkg
    } catch { return false }
  }

  for (const root of roots) {
    if (!existsSync(root)) continue
    let level = [root]
    for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
      for (const dir of level) {
        if (visited >= maxEntries) break
        visited += 1
        if (await matches(dir)) return dir
      }
      if (depth === maxDepth) break
      const next = []
      for (const dir of level) {
        let entries = []
        try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
        for (const d of entries) {
          if (!d.isDirectory() && !d.isSymbolicLink()) continue
          if (d.name.startsWith('.')) continue
          const sub = join(dir, d.name)
          if (seen.has(sub)) continue
          seen.add(sub)
          next.push(sub)
        }
      }
      level = next
    }
  }
  return null
}

/** 递归复制目录（只复制源码类文件；跳过 node_modules、.git 与构建产物）。 */
async function copyTree(from, to, budget) {
  const copied = []
  let files = 0
  let bytes = 0
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo'])
  const walk = async (src, dst) => {
    if (files >= budget.maxFiles || bytes >= budget.maxBytes) return
    await mkdir(dst, { recursive: true })
    let names = []
    try { names = await readdir(src, { withFileTypes: true }) } catch { return }
    for (const d of names) {
      if (files >= budget.maxFiles || bytes >= budget.maxBytes) return
      if (d.name.startsWith('.')) continue
      const s = join(src, d.name)
      const t = join(dst, d.name)
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue
        await walk(s, t)
        continue
      }
      if (!d.isFile()) continue
      if (!/\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml)$/.test(d.name)) continue
      try {
        const st = await stat(s)
        if (st.size > budget.maxFileBytes) continue
        await copyFile(s, t)
        copied.push(t)
        files += 1
        bytes += st.size
      } catch { /* 单个文件失败不中断 */ }
    }
  }
  await walk(from, to)
  return { copied, files, bytes }
}

/**
 * 归档子智能体的**真实源码**。
 *
 * 只从调用方给出的候选根里找（默认几个常见安装位），找到哪个记哪个；
 * 找不到就写一份 `SOURCE.md` 说明找过哪里、为什么没有，
 * **不伪造**源码、也不假装成功。
 *
 * @param dir - 归档根（日志目录）。
 * @param entries - 目录条目（用 package 名定位）。
 * @param opts - `{ roots, home, maxFiles, maxBytes, maxFileBytes }`。
 * @returns 每个条目的归档结果。
 */
export async function archiveSources(dir, entries, opts = {}) {
  const home = opts.home ?? homedir()
  const roots = (opts.roots ?? defaultSourceRoots()).filter((r) => typeof r === 'string' && r !== '')
  const budget = {
    maxFiles: opts.maxFiles ?? 400,
    maxBytes: opts.maxBytes ?? 4 * 1024 * 1024,
    maxFileBytes: opts.maxFileBytes ?? 512 * 1024,
  }
  const outDir = join(subagentDir(dir), 'src')
  await mkdir(outDir, { recursive: true })

  const results = []
  for (const e of entries) {
    const pkg = e.package
    if (typeof pkg !== 'string' || pkg === '') {
      results.push({ id: e.id, ok: false, reason: '条目没有声明所属包，无源码可归档。' })
      continue
    }
    if (!pkg.startsWith('@')) {
      results.push({ id: e.id, ok: false, reason: `\`${pkg}\` 不是 npm 包名（可能是内置能力），无源码可归档。` })
      continue
    }
    // 按 package.json 的 name 精确定位（目录名常与包名不同）。
    const found = await findPackageDir(roots, pkg, { maxDepth: opts.maxDepth ?? 3 })
    if (found === null) {
      results.push({ id: e.id, ok: false, reason: '在候选源码根里没有找到该包。', searched: roots.map((r) => redactHome(r, home)) })
      continue
    }
    const srcRoot = await sourceRootOf(found)
    if (srcRoot === null) {
      results.push({ id: e.id, ok: false, reason: `找到了 ${redactHome(found, home)}，但里面既没有 src/ 也没有 lib/。` })
      continue
    }
    const sid = safeFileId(e.id)
    const dst = join(outDir, sid)
    const r = await copyTree(srcRoot, dst, budget)
    results.push({
      id: e.id, ok: true, from: redactHome(srcRoot, home), to: redactHome(dst, home),
      files: r.files, bytes: r.bytes,
    })
  }

  const lines = ['# 子智能体源码归档', '', `- 生成时间：${new Date().toLocaleString('zh-CN')}`, '']
  for (const r of results) {
    lines.push(`## ${r.id}`, '')
    if (r.ok) {
      lines.push(`- 结果：已归档`, `- 来源：\`${r.from}\``, `- 归档到：\`${r.to}\``, `- 文件数：${r.files}，共 ${(r.bytes / 1024).toFixed(1)}KB`, '')
    } else {
      lines.push(`- 结果：未归档`, `- 原因：${r.reason}`, '')
      if (Array.isArray(r.searched)) {
        lines.push('- 找过的位置：', ...r.searched.map((s) => `  - \`${s}\``), '')
      }
    }
  }
  await writeFile(join(outDir, 'SOURCE.md'), `${lines.join('\n')}\n`, 'utf8')

  const okCount = results.filter((r) => r.ok).length
  return { dir: outDir, results, ok: okCount, total: results.length }
}

/**
 * 默认源码候选根。
 *
 * 不写死任何一台机器的目录。按可信度从近到远：
 *   1) `DSH_SOURCE_ROOT` 环境变量（显式指定，最高优先级）；
 *   2) 从**本插件自己解析到的依赖**往上推 monorepo 根——
 *      用 `import.meta.resolve` 找到 `@deepseek-ai/dsh-tools` 的真实位置，
 *      它的祖先里第一个含 `packages/` 的目录就是 DSH 检出根；
 *   3) `DSH_HOME`（或 `~/.dsh`）下的 `plugins`／`profiles`；
 *   4) 当前工作目录的 `node_modules/@deepseek-ai`。
 *
 * 全部只是**候选**：找不到就如实报「没找到」，不猜、不伪造。
 * @returns 候选根目录（去重、保序）。
 */
export function defaultSourceRoots() {
  const home = homedir()
  const roots = []
  const push = (p) => {
    if (typeof p === 'string' && p !== '' && !roots.includes(p)) roots.push(p)
  }

  if (process.env.DSH_SOURCE_ROOT !== undefined) push(process.env.DSH_SOURCE_ROOT)

  // 由依赖的真实位置反推检出根，避免写死用户名。
  try {
    const toolsPkg = import.meta.resolve('@deepseek-ai/dsh-tools/package.json')
    const toolsDir = dirname(fileURLToPath(toolsPkg))   // …/packages/core/tools
    // 逐级向上找「同级含 packages 目录」的那一层。
    let cur = toolsDir
    for (let i = 0; i < 6 && cur !== dirname(cur); i += 1) {
      cur = dirname(cur)
      if (existsSync(join(cur, 'packages'))) { push(join(cur, 'packages')); break }
    }
    // 退路：直接用它所在的那一层。
    push(dirname(toolsDir))
  } catch { /* 依赖解析不到（例如独立安装）时跳过 */ }

  const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
  push(join(dshHome, 'plugins'))
  push(join(dshHome, 'profiles'))
  push(join(process.cwd(), 'node_modules', '@deepseek-ai'))
  return roots
}

/** 供外部只读检查：解析一个条目在磁盘上的归档路径。 */
export function archivePaths(dir, id) {
  const root = subagentDir(dir)
  const sid = safeFileId(id)
  return {
    entryMd: join(root, 'entries', `${sid}.md`),
    entryJson: join(root, 'entries', `${sid}.json`),
    preset: join(root, 'presets', sid, 'preset.yml'),
    cordis: join(root, 'presets', sid, 'agent.cordis.yml'),
    source: join(root, 'src', sid),
  }
}
