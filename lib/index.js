/**
 * dsh-task-journal — host half.
 *
 * 把「任务」「工作结果」「模型参数」「未完成的问题」写到本地文件，
 * 并支持导出结果与一键重试未完成的任务。
 *
 * 写入路径：
 *  1) 自动（会话事件流）：订阅 `session/event`，记录
 *     - 真人下发的任务（`user/message`，kind 为 user / dsh-continue）
 *     - 助手产出（`assistant/message` 文本 + usage 用量）
 *     - 工具调用与结果（`tool/call` 的 callId→名称映射，`tool/result` 的成败与输出）
 *     - 模型与参数（`request/header` 的 config）
 *     - 未完成的问题（`turn/end` 原因为 error/interrupted/aborted/blocked/max-tokens 时）
 *  2) 主动：`journal` 写任务/结论/待办；`journal_export` 导出；`journal_retry` 一键重试。
 *  3) 子智能体：`subagent_catalog` / `subagent_save` / `subagent_run` 记录与调用子智能体，
 *     并把目录、调用规格、预设文件与源码持久化到 `<日志目录>/subagents/`。
 *
 * 产出（默认落在会话 cwd 下的 `.dsh-journal/`）：
 *  - `journal-<sid>.md`    人读的 Markdown 汇总日志
 *  - `events-<sid>.jsonl`  机读事件流（含模型参数、用量、失败原因）
 *  - `tasks-<sid>.md`      任务清单（带 T 编号与完成状态）
 *  - `failures-<sid>.md`   未完成的任务与原因（可重试）
 *  - `models-<sid>.md`     模型与参数变更记录
 *  - `subagents-<sid>.md`  子智能体使用记录（谁在什么时候被派了什么活）
 *  - `subagents/`          子智能体目录与归档（catalog / entries / presets / src）
 *
 * 设计约束：
 *  - host 半负责落盘与接口；client 半（lib/client.js）只做界面。
 *  - 写入**只追加**，绝不覆盖既有内容。
 *  - 每会话一条写队列，串行落盘，顺序与事件一致。
 *  - 失败只记 warn，绝不让插件把宿主会话搞崩。
 *  - `followup` 必须在事件分发之外调用（宿主拒绝重入 append），用 setTimeout(0) 延后。
 */
import { appendFile, mkdir, writeFile, readFile, copyFile, readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  CATEGORIES, DEFAULT_CATEGORY, categoryIds, builtinEntries, mergeObserved, groupByCategory,
  normalizeCategory, redactHome, redactDeep, writeCatalog, archiveSources, subagentDir,
  entryMarkdown,
} from './subagent-catalog.js'

export const name = 'dsh-task-journal'

/** 注入消息时使用的 producer-owned kind。 */
const SOURCE_KIND = 'dsh-task-journal'

/** 不记录子代理会话（归其父会话所有）。 */
const EXCLUDE_ORIGIN = 'subagent'

/** 算「未完成/失败」的轮次结束原因（见 TurnEndReasonMap）。 */
const FAILURE_KINDS = new Set(['error', 'aborted', 'blocked', 'max-tokens', 'interrupted'])

// ——————————————————————————————— 配置读取 ———————————————————————————————

function boolFrom(config, key, def) {
  const v = config?.[key]
  return typeof v === 'boolean' ? v : def
}

function intFrom(config, key, def) {
  const v = Number(config?.[key])
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : def
}

function strFrom(config, key, def) {
  const v = config?.[key]
  return typeof v === 'string' && v !== '' ? v : def
}

// ——————————————————————————————— 文本工具 ———————————————————————————————

/** 内容块数组 → 纯文本（只取 text 块）。 */
function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (b === null || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** 截断到上限。 */
function clip(text, max) {
  const s = String(text ?? '')
  if (max <= 0 || s.length <= max) return s
  return `${s.slice(0, max)}\n…（已截断，原文 ${s.length} 字）`
}

/** 本地时间戳 YYYY-MM-DD HH:mm:ss。 */
function stamp(ms) {
  const d = new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 文件名安全化。 */
function safeId(id) {
  return String(id ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
}

/** 会话工作目录：优先 header.cwd，退回进程 cwd。 */
function cwdOf(session) {
  const c = session?.header?.cwd
  return typeof c === 'string' && c !== '' ? c : process.cwd()
}

/** 一行模型参数摘要。 */
function modelLine(config) {
  if (!config || typeof config !== 'object') return null
  const bits = []
  if (config.provider) bits.push(`provider=${config.provider}`)
  if (config.model) bits.push(`model=${config.model}`)
  if (config.reasoningEffort) bits.push(`reasoning=${config.reasoningEffort}`)
  if (config.temperature !== undefined) bits.push(`temp=${config.temperature}`)
  if (config.maxTokens !== undefined) bits.push(`maxTokens=${config.maxTokens}`)
  if (Array.isArray(config.stop) && config.stop.length > 0) bits.push(`stop=${config.stop.length}项`)
  return bits.join(' ')
}

/** 用量摘要。 */
function usageLine(u) {
  if (!u || typeof u !== 'object') return null
  const bits = []
  if (u.inputTokens !== undefined) bits.push(`in=${u.inputTokens}`)
  if (u.outputTokens !== undefined) bits.push(`out=${u.outputTokens}`)
  if (u.cacheReadTokens !== undefined) bits.push(`cacheRead=${u.cacheReadTokens}`)
  if (u.reasoningTokens !== undefined) bits.push(`reasoning=${u.reasoningTokens}`)
  return bits.join(' ')
}

// ——————————————————————————————— 日志写入器 ———————————————————————————————

/** 每会话一个写入器：一条串行队列，保证顺序与不交错。 */
class JournalWriter {
  constructor(ctx, session, cfg) {
    this.ctx = ctx
    this.cfg = cfg
    this.queue = Promise.resolve()
    this.taskCount = 0
    this.failureCount = 0
    this.headerWritten = false
    /** callId -> 工具名。`tool/result` 只带 callId，名字在 `tool/call` 里。 */
    this.toolNames = new Map()
    /** 未完成的任务栈：{ n, text, at } */
    this.pending = []
    /** 当前模型参数（来自最近的 request/header）。 */
    this.lastModel = null
    /** 子智能体使用计数与本次会话见过的 run。 */
    this.subagentCount = 0
    this.subagentRuns = []
    /** 记住 session 对象，供工具路径取用。 */
    this.session = session

    this.sessionId = String(session?.id ?? '')
    const sid = safeId(this.sessionId)
    const cwd = cwdOf(session)
    const base = cfg.dir !== '' ? cfg.dir : join(cwd, '.dsh-journal')
    this.dir = isAbsolute(base) ? base : resolve(cwd, base)
    this.cwd = cwd

    this.mdPath = join(this.dir, `journal-${sid}.md`)
    this.jsonlPath = join(this.dir, `events-${sid}.jsonl`)
    this.tasksPath = join(this.dir, `tasks-${sid}.md`)
    this.failPath = join(this.dir, `failures-${sid}.md`)
    this.modelsPath = join(this.dir, `models-${sid}.md`)
    this.subagentsPath = join(this.dir, `subagents-${sid}.md`)
  }

  /** 入队一个写操作；错误被吞成 warn，不冒泡到宿主。 */
  enqueue(fn) {
    this.queue = this.queue.then(fn).catch((e) => {
      this.ctx.logger?.warn?.(`dsh-task-journal: 写入失败：${e?.message ?? String(e)}`)
    })
    return this.queue
  }

  /** 建目录 + 首次写文件头。 */
  async ensure() {
    await mkdir(this.dir, { recursive: true })
    if (this.headerWritten) return
    this.headerWritten = true
    const base = [
      `- 会话：\`${this.sessionId}\``,
      `- 工作目录：\`${this.cwd}\``,
      `- 创建时间：${stamp(Date.now())}`,
      ``,
    ]
    if (!existsSync(this.mdPath)) {
      await writeFile(this.mdPath, ['# 任务日志', '', ...base,
        `> 由 dsh-task-journal 自动追加；请勿手工清空。`, ``, `---`, ``].join('\n'), 'utf8')
    }
    if (!existsSync(this.tasksPath)) {
      await writeFile(this.tasksPath, ['# 任务清单', '', ...base, `---`, ``].join('\n'), 'utf8')
    }
    if (!existsSync(this.failPath)) {
      await writeFile(this.failPath, ['# 未完成的任务与问题', '', ...base,
        `> 每条给出原因；可用 journal_retry 工具一键重试（或在该会话发一句「继续」）。`,
        ``, `---`, ``].join('\n'), 'utf8')
    }
    if (!existsSync(this.modelsPath)) {
      await writeFile(this.modelsPath, ['# 模型与参数记录', '', ...base, `---`, ``].join('\n'), 'utf8')
    }
    if (!existsSync(this.subagentsPath)) {
      await writeFile(this.subagentsPath, ['# 子智能体使用记录', '', ...base,
        `> 每次委派记一行：时间、子智能体、分类、任务、结果。目录与归档见 \`subagents/\`。`,
        ``, `---`, ``].join('\n'), 'utf8')
    }
  }

  /** 追加一段 Markdown。 */
  md(text) {
    if (!this.cfg.markdown) return this.queue
    return this.enqueue(async () => {
      await this.ensure()
      await appendFile(this.mdPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
    })
  }

  /** 追加一条 JSONL 事件。 */
  json(obj) {
    if (!this.cfg.jsonl) return this.queue
    return this.enqueue(async () => {
      await this.ensure()
      await appendFile(this.jsonlPath, `${JSON.stringify(obj)}\n`, 'utf8')
    })
  }

  /** 往任务清单追加一行。 */
  task(line) {
    return this.enqueue(async () => {
      await this.ensure()
      await appendFile(this.tasksPath, `${line}\n`, 'utf8')
    })
  }

  /** 往失败清单追加一条（含原因）。 */
  failure(text) {
    return this.enqueue(async () => {
      await this.ensure()
      await appendFile(this.failPath, `${text}\n`, 'utf8')
    })
  }

  /** 往模型记录追加一行。 */
  model(text) {
    return this.enqueue(async () => {
      await this.ensure()
      await appendFile(this.modelsPath, `${text}\n`, 'utf8')
    })
  }

  /** 往子智能体使用记录追加一行（或一段）。 */
  subagent(text) {
    return this.enqueue(async () => {
      await this.ensure()
      await appendFile(this.subagentsPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
    })
  }

  /** 更新任务清单里某条的完成状态。 */
  markTask(n, done, note) {
    return this.enqueue(async () => {
      await this.ensure()
      const raw = await readFile(this.tasksPath, 'utf8')
      const lines = raw.split('\n')
      const tag = `[\`T${n}\`]`
      const idx = lines.findIndex((l) => l.includes(tag))
      if (idx >= 0) {
        lines[idx] = lines[idx].replace(/^- \[[ x]\]/, done ? '- [x]' : '- [ ]')
        if (note) lines[idx] += `　${note}`
        await writeFile(this.tasksPath, lines.join('\n'), 'utf8')
      }
    })
  }

  /**
   * 在某条任务行上追记一次子智能体使用。
   *
   * 任务清单是「这条任务做过什么」的第一落点，所以子智能体用量要写在这里，
   * 而不是只在旁路的 `subagents-*.md` 里。
   * 同一个子智能体重复派只累加计数（`🤖 名字×2`），不同子智能体并列写。
   * @param n - 任务编号。
   * @param label - 子智能体显示名。
   */
  noteSubagent(n, label) {
    return this.enqueue(async () => {
      await this.ensure()
      const raw = await readFile(this.tasksPath, 'utf8')
      const lines = raw.split('\n')
      const tag = `[\`T${n}\`]`
      const idx = lines.findIndex((l) => l.includes(tag))
      if (idx < 0) return
      const name = String(label ?? '').trim()
      if (name === '') return
      // 名字里可能带正则元字符（如「（send_message / list_agents）」），必须先转义。
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // 匹配本行里**任意位置**的这个标记（不只看最后一个），避免同一名字被写两遍。
      const marker = new RegExp(`　🤖 ${escaped}(?:×(\\d+))?(?=　🤖 |$)`)
      const line = lines[idx]
      if (marker.test(line)) {
        lines[idx] = line.replace(marker, (_all, cnt) =>
          `　🤖 ${name}×${(cnt === undefined ? 1 : Number(cnt)) + 1}`)
      } else {
        lines[idx] = `${line}　🤖 ${name}`
      }
      await writeFile(this.tasksPath, lines.join('\n'), 'utf8')
    })
  }
}

// ——————————————————————————————— 导出 ———————————————————————————————

/**
 * 导出：把日志、任务、失败、模型记录汇总成一个 Markdown；
 * format='all' 时再额外复制各自单文件与 jsonl。
 */
async function exportJournal(w, dirArg, format) {
  const outDir = dirArg && String(dirArg) !== ''
    ? (isAbsolute(String(dirArg)) ? String(dirArg) : resolve(w.cwd, String(dirArg)))
    : join(w.dir, 'export')
  await mkdir(outDir, { recursive: true })

  const day = stamp(Date.now()).slice(0, 10)
  const sid = safeId(w.sessionId)
  const files = []
  const sources = [
    ['journal', w.mdPath, '.md'],
    ['tasks', w.tasksPath, '.md'],
    ['failures', w.failPath, '.md'],
    ['models', w.modelsPath, '.md'],
    ['subagents', w.subagentsPath, '.md'],
  ]

  // 汇总：一次交付一份可读文件。
  const parts = []
  for (const [label, p] of sources) {
    if (!existsSync(p)) continue
    parts.push(`\n\n<!-- ===== ${label} ===== -->\n\n`, await readFile(p, 'utf8'))
  }
  if (existsSync(w.jsonlPath)) {
    parts.push(`\n\n<!-- ===== events(jsonl) ===== -->\n\n`, '```jsonl\n', await readFile(w.jsonlPath, 'utf8'), '\n```\n')
  }
  const summaryPath = join(outDir, `export-${sid}-${day}.md`)
  await writeFile(summaryPath, parts.join(''), 'utf8')
  files.push(summaryPath)

  if (format === 'all') {
    for (const [label, p, ext] of [...sources, ['events', w.jsonlPath, '.jsonl']]) {
      if (!existsSync(p)) continue
      const target = join(outDir, `${label}-${sid}-${day}${ext}`)
      await copyFile(p, target)
      files.push(target)
    }
  }

  return {
    dir: outDir,
    files,
    summary: `导出 ${files.length} 个文件：\n` + files.map((f) => `- ${f}`).join('\n'),
  }
}

// ——————————————————————————————— 插件主体 ———————————————————————————————

export function apply(ctx, config = {}) {
  if (!boolFrom(config, 'enabled', true)) return

  const cfg = {
    dir: strFrom(config, 'dir', ''),
    markdown: boolFrom(config, 'markdown', true),
    jsonl: boolFrom(config, 'jsonl', true),
    recordAssistant: boolFrom(config, 'recordAssistant', true),
    recordModel: boolFrom(config, 'recordModel', true),
    maxChars: intFrom(config, 'maxChars', 4000),
    notify: boolFrom(config, 'notify', false),
    /** 失败时是否在会话里提示。 */
    notifyOnFailure: boolFrom(config, 'notifyOnFailure', true),
    /** 重试时注入的提示词。 */
    retryPrompt: strFrom(config, 'retryPrompt',
      '上一个任务没有做完。请接着上次的进度继续把它做完，不要重新开始；完成后简要说明结果。'),
    /** 是否记录子智能体使用情况（写入 subagents-<sid>.md）。 */
    recordSubagents: boolFrom(config, 'recordSubagents', true),
    /** 界面与日志里是否把本机 HOME 前缀遮蔽成 `~`。 */
    redactHome: boolFrom(config, 'redactHome', true),
    /** 子智能体归档目录（空 = <日志目录>/subagents）。 */
    subagentDir: strFrom(config, 'subagentDir', ''),
  }

  /** 按配置遮蔽 HOME 前缀；关掉时原样返回。 */
  const hideHome = (v) => (cfg.redactHome ? redactHome(v) : String(v ?? ''))
  /** 递归遮蔽（对象/数组）。 */
  const hideDeep = (v) => (cfg.redactHome ? redactDeep(v) : v)
  /** 子智能体归档根：优先配置，否则放在该会话的日志目录下。 */
  const catalogRootFor = (w) => (cfg.subagentDir !== ''
    ? (isAbsolute(cfg.subagentDir) ? cfg.subagentDir : resolve(w.cwd, cfg.subagentDir))
    : w.dir)

  /** 已知日志目录登记（模块级实现，API handler 也能用）。 */
  const registry = makeDirRegistry()

  /** sessionId -> JournalWriter */
  const writers = new Map()
  /** sessionId -> 活跃 agent（重试时唤醒用） */
  const liveAgents = new Map()

  const writerFor = (session) => {
    const sid = String(session?.id ?? '')
    let w = writers.get(sid)
    if (w === undefined) {
      w = new JournalWriter(ctx, session, cfg)
      writers.set(sid, w)
      registry.remember(w.dir)
      ctx.logger?.info?.(`dsh-task-journal: 日志目录 ${w.dir}`)
    } else if (session !== undefined && session !== null) {
      w.session = session
    }
    return w
  }

  /** 会话内提示（不唤醒模型）。 */
  const notifySession = (session, text) => {
    if (!cfg.notify && !cfg.notifyOnFailure) return
    if (!session || typeof session.append !== 'function') return
    setTimeout(() => {
      try {
        session.append('user/message', {
          content: [{ type: 'text', text }],
          source: { kind: SOURCE_KIND, form: 'notice', summary: text },
        }, { surfaceOp: 'append' })
      } catch (e) {
        ctx.logger?.warn?.(`dsh-task-journal: notice 失败：${e?.message ?? String(e)}`)
      }
    }, 0).unref?.()
  }

  /**
   * 一键重试：向同一会话注入 follow-up 并唤醒它。
   * 宿主拒绝重入 append，所以延后到下一个 tick。
   */
  const retryTask = (sessionId, prompt) => {
    // 三条路依次尝试：事件里记下的 → 注册表按 id 取 → 注册表全量里按 id 找。
    let live = liveAgents.get(String(sessionId)) ?? ctx.agents?.get?.(String(sessionId))
    if (live === undefined) {
      try {
        live = (ctx.agents?.list?.() ?? []).find((a) => String(a?.id) === String(sessionId))
      } catch { /* 忽略 */ }
    }
    if (!live || typeof live.followup !== 'function') {
      return { ok: false, reason: '该会话当前没有活跃的 agent，无法自动重启；请直接在这个会话里发一句「继续」。' }
    }
    setTimeout(() => {
      try {
        live.followup({
          id: crypto.randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: String(prompt) }],
          source: { kind: SOURCE_KIND },
        })
      } catch (e) {
        ctx.logger?.warn?.(`dsh-task-journal: 重试注入失败：${e?.message ?? String(e)}`)
      }
    }, 0).unref?.()
    return { ok: true }
  }

  /**
   * 开一个**新会话**继续未完成的任务。
   *
   * 与 `retryTask`（在原会话里 followup）不同：这条路创建一个全新的根会话，
   * 把未完成任务的原文作为首条消息发进去，原会话不受影响。适合原会话已经
   * 结束/上下文已满的情况。
   *
   * 依赖 `ctx.agents.create` + `ctx.agentPresets`（挂载 preset）+ 可选的
   * `ctx.agentDefaultModel`（取当前模型）。缺任一项就如实报错，不硬撑。
   */
  const retryInNewSession = async (w, prompt, note) => {
    const agents = ctx.get?.('agents') ?? ctx.agents
    if (agents === undefined || typeof agents.create !== 'function') {
      return { ok: false, message: '当前组装没有可用的 agent 注册表，无法开新会话。' }
    }
    const presets = ctx.get?.('agentPresets')
    let presetId
    let setup
    if (presets !== undefined && typeof presets.resolve === 'function') {
      try {
        const preset = await presets.resolve(undefined)
        presetId = preset?.id
        setup = async (agentCtx) => { await presets.mount(agentCtx, presetId) }
      } catch (e) {
        ctx.logger?.warn?.(`dsh-task-journal: 解析 preset 失败：${e?.message ?? String(e)}`)
      }
    }

    // 模型：优先沿用原会话当前的模型，其次问默认模型服务。
    let agentOptions
    try {
      const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      if (sel !== undefined && sel !== null) agentOptions = { provider: sel.provider, model: sel.model }
    } catch { /* 忽略 */ }
    if (agentOptions === undefined) {
      const live = liveAgents.get(w.sessionId) ?? (ctx.get?.('agents')?.get?.(w.sessionId))
      const cfgSel = live?.session?.requestHeader?.()?.config
      if (cfgSel?.provider !== undefined && cfgSel?.model !== undefined) {
        agentOptions = { provider: cfgSel.provider, model: cfgSel.model }
      }
    }

    const sessionId = `journal-retry-${crypto.randomUUID()}`
    try {
      const handle = await agents.create({
        sessionId,
        meta: {
          cwd: w.cwd,
          ...(presetId === undefined ? {} : { agentPreset: presetId }),
        },
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(setup === undefined ? {} : { setup }),
      })

      // 借用宿主已有能力，让新会话开出来就是「能用的」而不是一个裸会话：
      // ① 起个能认出来的标题；② 挂进工作区；③ 继承原会话的权限档位。
      const taskLabel = note || (prompt.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 40)
      try {
        ctx.get?.('sessionTitle')?.rename?.(handle.agent.session, `续跑：${taskLabel}`.slice(0, 60))
      } catch (e) {
        ctx.logger?.warn?.(`dsh-task-journal: 命名新会话失败：${e?.message ?? String(e)}`)
      }
      try {
        await ctx.get?.('workspaceRegistry')?.create?.(w.cwd)
      } catch { /* 工作区不可用时不影响会话本身 */ }
      try {
        const srcSession = liveAgents.get(w.sessionId)?.session
          ?? ctx.get?.('agents')?.get?.(w.sessionId)?.session
        const presetName = ctx.get?.('permissionPresets')?.defaultPreset
        if (srcSession !== undefined && presetName !== undefined) {
          ctx.get?.('permissionPresets')?.set?.(handle.agent.session, presetName)
        }
      } catch { /* 权限服务缺席时跳过 */ }

      const body = [prompt, note ? `补充：${note}` : ''].filter((x) => x !== '').join('\n\n')
      handle.agent.followup({
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: body }],
        source: { kind: SOURCE_KIND, form: 'notice', summary: '由任务日志发起的续跑' },
      })
      w.md(`\n### 已开新会话续跑｜${stamp(Date.now())}\n\n- 新会话：\`${sessionId}\`\n- 原会话：\`${w.sessionId}\`\n`)
      w.json({ t: stamp(Date.now()), ts: Date.now(), type: 'retry_new_session', from: w.sessionId, to: sessionId })
      return { ok: true, sessionId, message: `已开新会话 ${sessionId} 继续这条任务。` }
    } catch (e) {
      return { ok: false, message: `开新会话失败：${e?.message ?? String(e)}` }
    }
  }

  /** 把最近一条未完成的任务直接标记为失败（不再重试）。 */
  const markFailed = async (w, note) => {
    await w.queue
    const last = await lastOpenFromDisk(w)
    if (last === null) return { ok: false, message: '没有待处理的未完成任务。' }
    const now = stamp(Date.now())
    const why = note ? `（人工放弃：${note}）` : '（人工放弃）'
    await w.failure(`\n## F${w.failureCount + 1}｜任务 T${last.n}｜${now}\n\n`
      + `- 任务：${last.text.split('\n')[0].slice(0, 200)}\n`
      + `- 原因：已标记为失败 ${why}\n`
      + `- 状态：失败（不再重试）\n`)
    w.failureCount += 1
    await w.markTask(last.n, false, `　❌ 已放弃${why}`)
    // 只弹内存栈里确实存在的那个（磁盘兜底来的不在栈里）。
    if (w.pending.length > 0 && w.pending[w.pending.length - 1].n === last.n) w.pending.pop()
    await w.md(`\n<!-- 任务 T${last.n} 已被标记为失败 ${why}｜${now} -->\n`)
    await w.json({ t: now, ts: Date.now(), type: 'task_abandoned', n: last.n, note: note ?? null })
    return { ok: true, task: `T${last.n}`, message: `任务 T${last.n} 已标记为失败，不再重试。` }
  }

  /** 主事件处理。 */
  const onSessionEvent = (session, event) => {
    if (!session || !event || typeof event.type !== 'string') return
    if (session.header?.origin === EXCLUDE_ORIGIN) return

    const w = writerFor(session)
    const time = typeof event.time === 'number' ? event.time : Date.now()
    const seq = event.seq

    switch (event.type) {
      // —— 模型与参数：变化时记一行 ——
      case 'request/header': {
        if (!cfg.recordModel) return
        const header = event.data?.header ?? {}
        const line = modelLine(header.config)
        if (line === null || line === w.lastModel) return
        w.lastModel = line
        w.model(`- ${stamp(time)}｜${line}`)
        w.json({ t: stamp(time), ts: time, seq, type: 'model', config: header.config })
        w.md(`\n<!-- 模型参数：${line}｜${stamp(time)} -->\n`)
        return
      }

      // —— 任务 ——
      case 'user/message': {
        const msg = event.data
        const srcKind = msg?.source?.kind
        if (srcKind !== 'user' && srcKind !== 'dsh-continue') return
        const text = clip(blocksToText(msg?.content), cfg.maxChars)
        if (text.trim() === '') return
        w.taskCount += 1
        const n = w.taskCount
        w.pending.push({ n, text, at: time })
        w.md(`\n## 任务 ${n}｜${stamp(time)}\n\n${text}\n`)
        w.task(`- [ ] [\`T${n}\`] ${stamp(time)}｜${text.split('\n')[0].slice(0, 140)}`)
        w.json({ t: stamp(time), ts: time, seq, type: 'task', n, text, source: srcKind })
        if (cfg.notify) notifySession(session, `已记入任务日志（第 ${n} 条）`)
        return
      }

      // —— 助手产出 + 用量 ——
      case 'assistant/message': {
        const u = usageLine(event.data?.usage)
        const text = clip(blocksToText(event.data?.message?.content), cfg.maxChars)
        if (cfg.recordAssistant && text.trim() !== '') {
          w.md(`\n### 产出｜${stamp(time)}\n\n${text}\n`)
        }
        w.json({ t: stamp(time), ts: time, seq, type: 'assistant', text, usage: event.data?.usage ?? null })
        if (u !== null) w.md(`<!-- 用量：${u} -->\n`)
        return
      }

      // —— 工具调用：记 callId→名称 ——
      case 'tool/call': {
        const callId = event.data?.callId
        const toolName = event.data?.name
        if (typeof callId === 'string' && typeof toolName === 'string') {
          w.toolNames.set(callId, toolName)
        }
        w.json({ t: stamp(time), ts: time, seq, type: 'tool_call', tool: toolName ?? 'unknown' })
        return
      }

      case 'tool/result': {
        const msg = event.data?.message
        const callId = msg?.source?.callId ?? msg?.toolCallId
        const toolName = (typeof callId === 'string' ? w.toolNames.get(callId) : undefined)
          ?? msg?.source?.toolName
          ?? msg?.source?.name
          ?? 'unknown'
        const isError = msg?.isError === true
        const out = clip(blocksToText(msg?.content), Math.min(cfg.maxChars, 1500))
        w.md(`- **工具** \`${toolName}\`${isError ? '（失败）' : ''}｜${stamp(time)}`)
        w.json({ t: stamp(time), ts: time, seq, type: 'tool', tool: toolName, isError, text: out })
        if (isError) w.md(`\n  > 工具失败：${out.split('\n')[0].slice(0, 160)}\n`)
        return
      }

      // —— 轮次结束：判成功/失败，失败则记「未完成的问题」 ——
      case 'turn/end': {
        const r = event.data?.reason
        const kind = typeof r === 'string' ? r : r?.kind
        const err = (typeof r === 'object' && r !== null) ? r.error : undefined
        const last = w.pending.length > 0 ? w.pending[w.pending.length - 1] : null
        const failed = FAILURE_KINDS.has(String(kind))

        w.md(`\n<!-- 轮次结束：${kind ?? 'unknown'}｜${stamp(time)} -->\n`)
        w.json({
          t: stamp(time), ts: time, seq, type: 'turn/end',
          reason: kind ?? null,
          error: err ? { message: err.message, code: err.code, status: err.status } : null,
          task: last ? last.n : null,
        })

        if (failed) {
          w.failureCount += 1
          const why = (err && err.message) ? err.message
            : kind === 'aborted' ? '被中断（aborted）'
              : kind === 'interrupted' ? '中断（进程/恢复时关闭）'
                : kind === 'max-tokens' ? '输出达上限，未写完'
                  : `未完成（${kind}）`
          const code = err?.code ? ` [${err.code}]` : ''
          const label = last !== null ? `任务 T${last.n}` : '未关联到具体任务'
          w.failure(`\n## F${w.failureCount}｜${label}｜${stamp(time)}\n\n`
            + (last !== null ? `- 任务：${last.text.split('\n')[0].slice(0, 200)}\n` : '')
            + `- 原因：${why}${code}\n`
            + `- 状态：未完成\n\n`
            + `> 重试：让模型调用 \`journal_retry\`，或在这个会话里发一句「继续」。\n`)
          if (last !== null) {
            w.markTask(last.n, false, `（${kind}${code}）`)
          }
          notifySession(session, `任务未完成：${label}｜${why}${code}\n可用 journal_retry 一键重试。`)
        } else if (last !== null) {
          w.markTask(last.n, true)
          w.pending.pop()
        }
        return
      }

      default:
        return
    }
  }

  ctx.effect(() => ctx.on('session/event', onSessionEvent), 'dsh-task-journal: session/event 订阅')

  // ————————————————————— 子智能体：记录使用情况 + 自动发现 —————————————————————

  /** 本次会话见过的子智能体 run（供目录页显示「最近用过」）。 */
  const subagentRuns = []
  /** 记忆化的目录（内置 + 发现），避免每次请求都重算。 */
  let catalogCache = null
  let catalogCacheAt = 0

  /** 委派类工具名 → 目录条目 id。这些工具被调用时计入子智能体使用情况。 */
  const DELEGATION_TOOLS = new Map([
    ['subagent', 'subagent-spawn'],
    ['subagent_fork', 'subagent-fork'],
    ['spawn_teammate', 'agent-team'],
    ['workflow', 'workflow'],
    ['oh_story_role', 'oh-story-role'],
    ['send_message', 'tool-subagent-control'],
    ['list_agents', 'tool-subagent-control'],
    ['interrupt_agent', 'tool-subagent-control'],
    ['list_subagent_models', 'list-subagent-models'],
  ])

  /** 当前组装里可用的 provider 名（探不到就空数组，不猜）。 */
  const observedProviders = () => {
    try {
      const svc = ctx.get?.('subagents') ?? ctx.subagents
      const names = svc?.list?.()
      return Array.isArray(names) ? names.map(String) : []
    } catch { return [] }
  }

  /** 当前组装里模型可见的工具名（探不到就空数组）。 */
  const observedTools = () => {
    try {
      const reg = ctx.get?.('tools') ?? ctx.tools
      const all = reg?.list?.() ?? reg?.all?.() ?? []
      return Array.isArray(all)
        ? all.map((t) => (typeof t === 'string' ? t : t?.name)).filter((n) => typeof n === 'string')
        : []
    } catch { return [] }
  }

  /** 生成当前目录：内置 + 运行期发现。 */
  const currentCatalog = () => {
    const now = Date.now()
    if (catalogCache !== null && now - catalogCacheAt < 5000) return catalogCache
    const entries = mergeObserved(
      { providers: observedProviders(), tools: observedTools(), runs: subagentRuns },
      builtinEntries(),
    )
    catalogCache = entries
    catalogCacheAt = now
    return entries
  }

  /** 没有明确父会话时，退到最近有 writer 的会话（不凭空造）。 */
  const newestSession = () => {
    let best = null
    for (const w of writers.values()) {
      if (best === null || w.taskCount >= best.taskCount) best = w
    }
    return best?.session ?? null
  }

  /**
   * 找这次子智能体运行属于哪个会话。
   *
   * 生命周期事件本身**不带父会话 id**（只有 runId / provider / 子会话 id），
   * 所以按可信度依次尝试：
   *   1) 用子会话 id 反查活跃 agent，读它的 `header.parentSession`（真事实）；
   *   2) 该子会话自己的 writer（子代理会话被主流程排除，但这里可能已建过）；
   *   3) 退回最近有 writer 的会话——**这属于推断**，调用方会标注出来。
   * @param info - 生命周期事件负载。
   * @returns `{ session, attributed }`；`attributed` 为 false 表示是推断的。
   */
  const sessionForRun = (info) => {
    const childId = String(info?.id ?? '')
    if (childId !== '') {
      try {
        const child = ctx.get?.('agents')?.get?.(childId) ?? ctx.agents?.get?.(childId)
        const parentId = child?.session?.header?.parentSession
        if (typeof parentId === 'string' && parentId !== '' && writers.has(parentId)) {
          return { session: writers.get(parentId).session, attributed: true }
        }
        if (child?.session !== undefined && child.session !== null && child.session.id !== undefined
          && writers.has(String(child.session.id))) {
          return { session: writers.get(String(child.session.id)).session, attributed: true }
        }
      } catch { /* 查不到就往下退 */ }
    }
    const fallback = newestSession()
    return { session: fallback, attributed: false }
  }

  /** 一条 run 记录写进 session 日志与子智能体使用记录。 */
  const recordSubagentRun = (session, info, phase, extra = {}) => {
    if (!cfg.recordSubagents) return
    if (session === null || session === undefined) return
    const w = writerFor(session)
    const time = Date.now()
    const provider = String(info?.provider ?? '')
    const childId = String(info?.id ?? '')
    // 反查目录条目：按 provider 名匹配内置目录。
    const entry = currentCatalog().find((e) => e.provider !== undefined && e.provider === provider)
    const label = entry?.name ?? (provider !== '' ? `${provider} 子智能体` : '子智能体')
    const cat = entry?.category ?? DEFAULT_CATEGORY
    // 归因：attributed=false 表示事件没带父会话 id，这条是退回推断的。
    const inferred = extra.attributed === false
    subagentRuns.push({ provider, id: childId, runId: String(info?.runId ?? ''), at: time, phase })
    if (subagentRuns.length > 200) subagentRuns.shift()

    if (phase === 'start') {
      w.subagentCount += 1
      w.subagent(`\n## S${w.subagentCount}｜${stamp(time)}｜${label}\n\n`
        + `- 分类：**${CATEGORIES[cat]?.label ?? cat}**（\`${cat}\`）\n`
        + `- provider：\`${provider || '(未知)'}\`\n`
        + `- 子会话：\`${childId || '(未记录)'}\`\n`
        + (inferred ? `- 归属：\`${w.sessionId}\`（推断：事件未带父会话 id）\n` : '')
        + `- 状态：已启动\n`)
      // 同时写进任务清单：这条任务用过哪些子智能体。
      const open = w.pending.length > 0 ? w.pending[w.pending.length - 1] : null
      if (open !== null) w.noteSubagent(open.n, label)
    } else {
      const stop = String(extra.stopReason ?? 'unknown')
      const okRun = stop === 'completed'
      w.subagent(`- 结束：${stamp(time)}｜结果：**${stop}**${okRun ? ' ✅' : ' ⚠'}\n`)
    }
    w.json(hideDeep({
      t: stamp(time), ts: time, type: phase === 'start' ? 'subagent_start' : 'subagent_end',
      provider, childId, runId: info?.runId ?? null, label, category: cat,
      session: w.sessionId, attributed: !inferred,
      ...(phase === 'end' ? { stopReason: extra.stopReason ?? null } : {}),
    }))
    w.md(`\n<!-- 子智能体：${label}（${cat}）${phase === 'start' ? '启动' : `结束 ${extra.stopReason ?? ''}`}｜${stamp(time)} -->\n`)
  }

  // 生命周期事件：子智能体的启动与结束。
  ctx.effect(() => {
    const offStart = ctx.on?.('subagent/start', (info) => {
      const { session, attributed } = sessionForRun(info)
      recordSubagentRun(session, info, 'start', { attributed })
    })
    const offEnd = ctx.on?.('subagent/end', (info) => {
      const { session, attributed } = sessionForRun(info)
      recordSubagentRun(session, info, 'end', { attributed, stopReason: info?.stopReason })
    })
    return () => {
      if (typeof offStart === 'function') offStart()
      if (typeof offEnd === 'function') offEnd()
    }
  }, 'dsh-task-journal: subagent 生命周期订阅')

  // 工具调用里认出委派工具：计入使用情况（即使没有 lifecycle 事件）。
  ctx.effect(() => {
    const off = ctx.on?.('session/event', (session, event) => {
      if (event?.type !== 'tool/call' || !cfg.recordSubagents) return
      const name = event?.data?.name
      if (typeof name !== 'string' || !DELEGATION_TOOLS.has(name)) return
      const w = writerFor(session)
      const entryId = DELEGATION_TOOLS.get(name)
      const entry = currentCatalog().find((e) => e.id === entryId)
      const time = typeof event.time === 'number' ? event.time : Date.now()
      const label = entry?.name ?? name
      w.json(hideDeep({
        t: stamp(time), ts: time, type: 'subagent_tool',
        tool: name, entryId, label, category: entry?.category ?? DEFAULT_CATEGORY,
      }))
      // 任务清单同样标注：这条任务用过这个委派工具。
      const open = w.pending.length > 0 ? w.pending[w.pending.length - 1] : null
      if (open !== null) w.noteSubagent(open.n, label)
    })
    return () => { if (typeof off === 'function') off() }
  }, 'dsh-task-journal: 委派工具调用订阅')

  /**
   * 列出所有活跃 agent 的日志目录。
   *
   * 服务重启后内存里的 writer 会丢，但 agent 是活的；用 ctx.agents.list()
   * 反推它们的会话目录并登记，这样面板一打开就能看到当前会话，不必先发消息。
   */
  const rememberLiveAgentDirs = () => {
    let agents = []
    try { agents = ctx.agents?.list?.() ?? [] } catch { agents = [] }
    for (const a of agents) {
      const cwd = a?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') {
        const base = cfg.dir !== '' ? cfg.dir : join(cwd, '.dsh-journal')
        registry.remember(isAbsolute(base) ? base : resolve(cwd, base))
      }
      // 顺带把活跃 agent 记进 liveAgents，重试时能直接唤醒。
      if (a?.id) liveAgents.set(String(a.id), a)
    }
    return agents.length
  }

  // 启动时登记一次，之后每次有新会话事件也顺带刷新。
  try { rememberLiveAgentDirs() } catch { /* 启动早期 ctx.agents 可能还没就绪 */ }

  // —— 给浏览器界面用的 HTTP API ——
  // 界面（client 半）通过同源 /api/dsh-journal/* 读日志、触发导出与重试。
  ctx.inject(['webServer'], (hostCtx) => {
    const handler = makeApiHandler({
      cfg, writers, writerFor, liveAgents, retryTask, exportJournal, registry,
      rememberLiveAgentDirs, retryInNewSession, markFailed,
      currentCatalog, catalogRootFor, hideHome, hideDeep,
    })
    hostCtx.effect(
      () => hostCtx.webServer.register({ kind: 'prefix', path: '/api/dsh-journal', handler }),
      'dsh-task-journal: api routes',
    )
  })

  // 记住活跃 agent（重试时唤醒用）。
  ctx.inject(['agents'], (actx) => {
    ctx.effect(() => {
      const off = actx.on?.('agent/created', (payload) => {
        const agent = payload?.agent ?? payload
        if (agent?.id) liveAgents.set(String(agent.id), agent)
      })
      return () => { if (typeof off === 'function') off() }
    }, 'dsh-task-journal: agent/created 订阅')
  })

  // —— 工具：journal / journal_export / journal_retry ——
  ctx.inject(['tools'], (agentCtx) => {
    /** 从 exec 拿会话：优先 agent.session，退路按 sessionId 找回同一 writer。 */
    const sessionOf = (exec) => {
      const s = exec?.agent?.session
      if (s !== undefined && s !== null) return s
      const sid = String(exec?.agent?.sessionId ?? exec?.agent?.id ?? '')
      const w = writers.get(sid)
      if (w !== undefined) return w.session ?? { id: sid, header: {} }
      return { id: sid, header: {} }
    }

    try {
      agentCtx.tools.register(defineTool({
        name: 'journal',
        description:
          '把一条任务/结论/待办写入本地任务日志（.dsh-journal/），用于长任务里留下可追溯的阶段结果。'
          + 'kind：task=新任务，result=阶段结论，note=备注，todo=待办。',
        parameters: {
          kind: { type: 'string', required: true, description: 'task | result | note | todo', enum: ['task', 'result', 'note', 'todo'] },
          text: { type: 'string', required: true, description: '要记录的内容（支持 Markdown）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { path: { type: 'string', required: true }, bytes: { type: 'number', required: true } },
          },
          render: (_a, v) => [{ type: 'text', text: `已写入 ${v.path}（${v.bytes} 字节）` }],
        },
        async execute(args, exec) {
          const w = writerFor(sessionOf(exec))
          const now = stamp(Date.now())
          const head = args.kind === 'task' ? `## 任务｜${now}`
            : args.kind === 'result' ? `### 结论｜${now}`
              : args.kind === 'todo' ? `### 待办｜${now}`
                : `### 备注｜${now}`
          const body = clip(args.text, cfg.maxChars)
          await w.md(`${head}\n\n${body}\n`)
          if (args.kind === 'task') {
            w.taskCount += 1
            await w.task(`- [ ] [\`T${w.taskCount}\`] ${now}｜${body.split('\n')[0].slice(0, 140)}`)
          }
          await w.json({ t: now, ts: Date.now(), type: 'manual', kind: args.kind, text: body })
          return { path: w.mdPath, bytes: Buffer.byteLength(body, 'utf8') }
        },
      }))

      agentCtx.tools.register(defineTool({
        name: 'journal_export',
        description:
          '把本次会话的任务日志导出到本地目录（默认 .dsh-journal/export/），返回导出文件清单。'
          + 'format=md 只导汇总 Markdown；format=all 再额外导出各单文件与 jsonl。',
        parameters: {
          dir: { type: 'string', description: '导出目录（可选，默认 .dsh-journal/export）' },
          format: { type: 'string', description: 'md（默认，汇总）或 all（含 jsonl）', enum: ['md', 'all'] },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              dir: { type: 'string', required: true },
              files: { type: 'array', required: true, items: { type: 'string' } },
              summary: { type: 'string', required: true },
            },
          },
          render: (_a, v) => [{ type: 'text', text: `已导出到 ${v.dir}\n${v.summary}` }],
        },
        async execute(args, exec) {
          const w = writerFor(sessionOf(exec))
          await w.queue
          return await exportJournal(w, args.dir, args.format ?? 'md')
        },
      }))

      agentCtx.tools.register(defineTool({
        name: 'journal_retry',
        description:
          '一键重试未完成的任务：向当前会话注入一条「接着上次继续做完」的提示并唤醒它。'
          + '不带参时重试最近一条未完成的任务。',
        parameters: {
          note: { type: 'string', description: '补充说明（可选），附在重试提示后面' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              task: { type: 'string' },
            },
          },
          render: (_a, v) => [{ type: 'text', text: v.message }],
        },
        async execute(args, exec) {
          const w = writerFor(sessionOf(exec))
          await w.queue
          const last = w.pending.length > 0 ? w.pending[w.pending.length - 1] : null
          const prompt = last !== null ? `${cfg.retryPrompt}\n\n原任务：${last.text}` : cfg.retryPrompt
          const extra = typeof args.note === 'string' && args.note !== '' ? `\n补充：${args.note}` : ''
          const r = retryTask(w.sessionId, prompt + extra)
          if (!r.ok) return { ok: false, message: r.reason }
          const label = last !== null ? `T${last.n}` : '（无记录的任务）'
          return { ok: true, message: `已请求继续：${label}。下一个轮次会接着上次的进度做。`, task: label }
        },
      }))

      agentCtx.tools.register(defineTool({
        name: 'journal_retry_new',
        description:
          '为未完成的任务**开一个新会话**继续运行：创建全新会话，把任务原文发进去，原会话不受影响。'
          + '适合原会话已结束或上下文已满的情况。',
        parameters: {
          note: { type: 'string', description: '补充说明（可选）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              sessionId: { type: 'string' },
            },
          },
          render: (_a, v) => [{ type: 'text', text: v.message }],
        },
        async execute(args, exec) {
          const w = writerFor(sessionOf(exec))
          await w.queue
          const last = await lastOpenFromDisk(w)
          const prompt = last !== null ? `${cfg.retryPrompt}\n\n原任务：${last.text}` : cfg.retryPrompt
          const r = await retryInNewSession(w, prompt, typeof args.note === 'string' ? args.note : '')
          return { ok: r.ok, message: r.message, ...(r.sessionId ? { sessionId: r.sessionId } : {}) }
        },
      }))

      agentCtx.tools.register(defineTool({
        name: 'journal_abandon',
        description:
          '把最近一条未完成的任务**直接标记为失败**（不再重试）。用于确认某个任务已放弃，'
          + '让它从「未完成」清单里结案。',
        parameters: {
          note: { type: 'string', description: '放弃原因（可选）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              task: { type: 'string' },
            },
          },
          render: (_a, v) => [{ type: 'text', text: v.message }],
        },
        async execute(args, exec) {
          const w = writerFor(sessionOf(exec))
          const r = await markFailed(w, typeof args.note === 'string' ? args.note : '')
          return { ok: r.ok, message: r.message, ...(r.task ? { task: r.task } : {}) }
        },
      }))

      ctx.logger?.info?.('dsh-task-journal: 已注册 journal / journal_export / journal_retry / journal_retry_new / journal_abandon')

      // ————————————————— 子智能体：目录 / 归档 / 调用 —————————————————

      agentCtx.tools.register(defineTool({
        name: 'subagent_catalog',
        description:
          '列出本机可用的子智能体目录（内置 + 运行期自动发现），带软件开发分类标签、'
          + '功能说明与调用方法。category 可选：只列某一类。'
          + '要持久化目录与源码用 subagent_save。',
        parameters: {
          category: {
            type: 'string',
            description: `只看某一分类：${categoryIds().join(' | ')}`,
          },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              count: { type: 'number', required: true },
              categories: { type: 'array', required: true, items: { type: 'string' } },
              groups: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
            },
          },
          render: (_a, v) => [{
            type: 'text',
            text: `${v.count} 个子智能体，${v.groups.length} 个分类：\n`
              + v.groups.map((g) => `\n【${g.label}】\n`
                + g.entries.map((e) => `- ${e.name}（\`${e.id}\`）：${e.summary ?? ''}`).join('\n')).join('\n'),
          }],
        },
        async execute(args) {
          const all = currentCatalog()
          const want = typeof args.category === 'string' && args.category !== ''
            ? normalizeCategory(args.category) : null
          const filtered = want === null ? all : all.filter((e) => e.category === want)
          return {
            count: filtered.length,
            categories: categoryIds(),
            groups: groupByCategory(filtered).map((g) => ({
              id: g.id, label: g.label, desc: g.desc,
              entries: g.entries.map((e) => ({
                id: e.id, name: e.name, category: e.category, kind: e.kind,
                summary: e.summary ?? '', usage: e.usage ?? '',
                tool: e.tool ?? null, provider: e.provider ?? null,
                package: e.package ?? null, source: e.source ?? 'builtin',
              })),
            })),
          }
        },
      }))

      agentCtx.tools.register(defineTool({
        name: 'subagent_save',
        description:
          '把子智能体目录**持久化**到本地：目录 JSON/Markdown、每个子智能体的调用规格、'
          + '可执行预设文件（preset.yml + agent.cordis.yml），可选归档真实源码。'
          + '后续任务可直接按归档的规格调用。',
        parameters: {
          sources: {
            type: 'boolean',
            description: '是否同时归档子智能体的真实源码（默认 false；找不到会如实说明）',
          },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              dir: { type: 'string', required: true },
              count: { type: 'number', required: true },
              files: { type: 'number', required: true },
              sources: { type: 'string' },
            },
          },
          render: (_a, v) => [{
            type: 'text',
            text: `已归档 ${v.count} 个子智能体 → ${v.dir}（${v.files} 个文件）`
              + (v.sources === undefined ? '' : `\n源码：${v.sources}`),
          }],
        },
        async execute(args, exec) {
          const w = writerFor(sessionOf(exec))
          await w.queue
          const root = catalogRootFor(w)
          const entries = currentCatalog()
          const r = await writeCatalog(root, entries, { home: homedir() })
          let srcNote
          if (args.sources === true) {
            const s = await archiveSources(root, entries, { home: homedir() })
            srcNote = `${s.ok}/${s.total} 个条目已归档源码 → ${hideHome(s.dir)}`
            await w.md(`\n<!-- 子智能体源码归档：${srcNote}｜${stamp(Date.now())} -->\n`)
            await w.json(hideDeep({ t: stamp(Date.now()), ts: Date.now(), type: 'subagent_sources', ok: s.ok, total: s.total, dir: s.dir }))
          }
          await w.md(`\n<!-- 子智能体目录已归档：${r.count} 条 → ${hideHome(r.dir)}｜${stamp(Date.now())} -->\n`)
          await w.json(hideDeep({ t: stamp(Date.now()), ts: Date.now(), type: 'subagent_catalog_saved', count: r.count, dir: r.dir }))
          return {
            dir: hideHome(r.dir),
            count: r.count,
            files: r.files.length,
            ...(srcNote === undefined ? {} : { sources: srcNote }),
          }
        },
      }))

      agentCtx.tools.register(defineTool({
        name: 'subagent_run',
        description:
          '按归档的调用规格**直接调用**一个子智能体：给出目录条目 id 与任务说明，'
          + '本轮就把它派出去。provider 型条目需要当前组装挂了对应的子智能体后端与委派工具。',
        parameters: {
          id: { type: 'string', required: true, description: '目录条目 id（见 subagent_catalog）' },
          prompt: { type: 'string', required: true, description: '自包含的任务说明（子智能体看不到本会话上下文）' },
          description: { type: 'string', description: '3-5 词的任务描述（可选）' },
          background: { type: 'boolean', description: '是否后台执行（可选）' },
        },
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              how: { type: 'string' },
            },
          },
          render: (_a, v) => [{ type: 'text', text: v.message }],
        },
        async execute(args, exec) {
          const w = writerFor(sessionOf(exec))
          const entry = currentCatalog().find((e) => e.id === args.id)
          if (entry === undefined) {
            return { ok: false, message: `目录里没有 \`${args.id}\`。先用 subagent_catalog 看可用 id。` }
          }
          const label = args.description ?? String(args.prompt).split('\n')[0].slice(0, 32)
          // 本插件不代替模型发起委派（那会绕过宿主的能力校验），而是：
          // 归档一条调用记录 + 回一张可直接复制的调用单。
          const how = entry.kind === 'provider'
            ? `${entry.tool ?? 'subagent'}({ description: ${JSON.stringify(label)}, prompt: ${JSON.stringify(args.prompt)}`
              + `${args.background === true ? ', run_in_background: true' : ''} })`
            : `${entry.tool ?? entry.id}({ ... })`
          await w.subagent(`\n## S${w.subagentCount + 1}｜${stamp(Date.now())}｜${entry.name}（按规格调用）\n\n`
            + `- 分类：**${CATEGORIES[entry.category]?.label ?? entry.category}**（\`${entry.category}\`）\n`
            + `- 工具：\`${entry.tool ?? entry.id}\`\n`
            + `- 任务：${label}\n`)
          w.subagentCount += 1
          await w.json(hideDeep({
            t: stamp(Date.now()), ts: Date.now(), type: 'subagent_invoke',
            id: entry.id, tool: entry.tool ?? null, label, category: entry.category,
          }))
          return {
            ok: true,
            message: `已按 \`${entry.id}\` 的规格登记这次调用（${entry.name}）。用下面的调用单发起：\n\n${how}`,
            how,
          }
        },
      }))

      ctx.logger?.info?.('dsh-task-journal: 已注册 subagent_catalog / subagent_save / subagent_run')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-task-journal: 工具注册失败：${e?.message ?? String(e)}`)
    }
  })
}

/**
 * 从磁盘的 tasks 清单里找出最后一条未完成任务。
 *
 * 内存里的 `pending` 栈在服务重启后会丢，所以重试/放弃都要能从磁盘兜底，
 * 否则重启后面板上的「一键重试」会误报「没有未完成任务」。
 */
async function lastOpenFromDisk(w) {
  if (w.pending.length > 0) return w.pending[w.pending.length - 1]
  try {
    const raw = existsSync(w.tasksPath) ? await readFile(w.tasksPath, 'utf8') : ''
    const open = raw.split('\n').filter((l) => /^- \[ \]/.test(l))
    if (open.length === 0) return null
    const line = open[open.length - 1]
    const m = /\[`T(\d+)`\]/.exec(line)
    if (m === null) return null
    return { n: Number(m[1]), text: line.replace(/^- \[ \] \[`T\d+`\] \S+｜/, '').trim(), at: Date.now() }
  } catch { return null }
}

// ——————————————————————————————— 浏览器界面的 HTTP API ———————————————————————————————

/** 读 JSON 请求体（有上限，防止超大 body）。 */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { req.destroy(); resolve(null); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/** 写 JSON 响应。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 构造 /api/dsh-journal/* 的处理器。
 *
 * 路由：
 *   GET  /api/dsh-journal/sessions            列出会话日志
 *   GET  /api/dsh-journal/summary?session=&cwd=   汇总（任务/失败/模型计数 + 最近记录）
 *   GET  /api/dsh-journal/tasks?session=&cwd=     任务清单
 *   GET  /api/dsh-journal/failures?session=&cwd=  未完成任务
 *   GET  /api/dsh-journal/models?session=&cwd=    模型记录
 *   GET  /api/dsh-journal/journal?session=&cwd=   完整日志（尾部截断）
 *   POST /api/dsh-journal/export              导出结果
 *   POST /api/dsh-journal/retry               一键重试
 */
function makeApiHandler(deps) {
  const {
    cfg, writers, writerFor, liveAgents, retryTask, exportJournal, registry,
    rememberLiveAgentDirs, retryInNewSession, markFailed,
    currentCatalog, catalogRootFor, hideHome, hideDeep,
  } = deps

  /** 定位目标会话的 writer：优先内存里的，其次磁盘上确实存在的。 */
  const resolveWriter = async (sessionId, cwd) => {
    if (sessionId && writers.has(sessionId)) return writers.get(sessionId)
    // 磁盘上找：优先显式 cwd，其次所有活跃 writer 的目录。
    if (sessionId) {
      const dirs = []
      if (typeof cwd === 'string' && cwd !== '') {
        const b = cfg.dir !== '' ? cfg.dir : join(cwd, '.dsh-journal')
        dirs.push(isAbsolute(b) ? b : resolve(cwd, b))
      }
      for (const w of writers.values()) if (!dirs.includes(w.dir)) dirs.push(w.dir)
      await registry.load()
      for (const d of registry.known) if (!dirs.includes(d)) dirs.push(d)
      const sid0 = safeId(sessionId)
      for (const d of dirs) {
        if (existsSync(join(d, `tasks-${sid0}.md`)) || existsSync(join(d, `journal-${sid0}.md`))) {
          const probe0 = { id: sessionId, header: { cwd: dirname(d) } }
          const w0 = new JournalWriter({ logger: { warn() {}, info() {} } }, probe0, cfg)
          w0.dir = d
          w0.mdPath = join(d, `journal-${sid0}.md`)
          w0.jsonlPath = join(d, `events-${sid0}.jsonl`)
          w0.tasksPath = join(d, `tasks-${sid0}.md`)
          w0.failPath = join(d, `failures-${sid0}.md`)
          w0.modelsPath = join(d, `models-${sid0}.md`)
          // 登记目录：这样后续 /sessions 也能列出这个会话。
          registry.remember(d)
          return w0
        }
      }
    }
    if (sessionId) {
      // 内存里没有（例如服务重启过）：只有磁盘上确有该会话的日志时才认，
      // 否则如实返回「找不到」，不凭空造一个空 writer。
      const dir = cfg.dir !== '' ? cfg.dir : join(cwd || process.cwd(), '.dsh-journal')
      const base = isAbsolute(dir) ? dir : resolve(cwd || process.cwd(), dir)
      const sid = safeId(sessionId)
      const probe = {
        id: sessionId, header: { cwd: cwd || process.cwd() },
      }
      const w = new JournalWriter({ logger: { warn() {}, info() {} } }, probe, cfg)
      w.dir = base
      w.mdPath = join(base, `journal-${sid}.md`)
      w.jsonlPath = join(base, `events-${sid}.jsonl`)
      w.tasksPath = join(base, `tasks-${sid}.md`)
      w.failPath = join(base, `failures-${sid}.md`)
      w.modelsPath = join(base, `models-${sid}.md`)
      const anyExists = [w.mdPath, w.jsonlPath, w.tasksPath, w.failPath, w.modelsPath]
        .some((p) => existsSync(p))
      return anyExists ? w : null
    }
    // 没指定会话：取最近活跃的那个。
    let newest = null
    for (const w of writers.values()) {
      if (newest === null || w.taskCount >= newest.taskCount) newest = w
    }
    return newest
  }

  const readIfExists = async (p) => (p && existsSync(p) ? readFile(p, 'utf8') : '')

  /** 从 Markdown 里粗提统计（界面只需要计数）。 */
  const countOf = (text, re) => (text.match(re) ?? []).length

  const handler = async (req, res) => {
    let url
    try { url = new URL(req.url ?? '/', 'http://localhost') }
    catch { sendJson(res, 400, { error: '非法 URL' }); return }
    const path = url.pathname.replace(/^\/api\/dsh-journal/, '') || '/'
    const q = url.searchParams
    const cwd = q.get('cwd') ?? undefined
    const sessionId = q.get('session') ?? undefined

    try {
      // —— 列出会话 ——
      if (req.method === 'GET' && path === '/sessions') {
        // 日志可能散在多个工作目录（服务进程的 cwd 未必等于会话的 cwd），
        // 所以这里把「所有活跃 writer 的目录」＋「显式 cwd」＋「进程 cwd」
        // 全部扫一遍，按会话去重后返回。
        try { rememberLiveAgentDirs?.() } catch { /* 忽略 */ }
        await registry.load()
        const dirs = new Set(registry.known)
        for (const w of writers.values()) {
          dirs.add(w.dir)
          registry.remember(w.dir)
        }
        if (typeof cwd === 'string' && cwd !== '') {
          const base = cfg.dir !== '' ? cfg.dir : join(cwd, '.dsh-journal')
          dirs.add(isAbsolute(base) ? base : resolve(cwd, base))
        }
        // 候选目录始终包含进程 cwd（服务可能从别处启动）。
        {
          const base = cfg.dir !== '' ? cfg.dir : join(process.cwd(), '.dsh-journal')
          dirs.add(isAbsolute(base) ? base : resolve(process.cwd(), base))
        }
        // 顺带把每个已知目录的「工作目录」也扫一遍（目录名固定为 .dsh-journal）。
        for (const d of [...dirs]) {
          const parent = dirname(d)
          if (parent !== d) dirs.add(join(parent, '.dsh-journal'))
        }

        const seen = new Map()
        for (const dir of dirs) {
          if (!existsSync(dir)) continue
          let names = []
          try { names = await readdir(dir) } catch { continue }
          for (const n of names) {
            const m = /^(journal|events|tasks|failures|models)-(.+?)\.(md|jsonl)$/.exec(n)
            if (!m) continue
            const sid = m[2]
            if (!seen.has(sid)) seen.set(sid, { session: sid, kinds: [], mtime: 0, dir })
            const e = seen.get(sid)
            if (!e.kinds.includes(m[1])) e.kinds.push(m[1])
            try {
              const st = await stat(join(dir, n))
              if (st.mtimeMs > e.mtime) e.mtime = st.mtimeMs
            } catch { /* 忽略 */ }
          }
        }
        const out = [...seen.values()].sort((a, b) => b.mtime - a.mtime)
        for (const e of out) {
          const cwdGuess = dirname(e.dir)
          e.sessionFile = sessionFilePath(cwdGuess, e.session)
          e.sessionFileExists = existsSync(e.sessionFile)
        }
        sendJson(res, 200, hideDeep({
          dirs: [...dirs],
          dir: out[0]?.dir ?? [...dirs][0] ?? '',
          sessions: out,
        }))
        return
      }

      // —— 汇总 ——
      if (req.method === 'GET' && path === '/summary') {
        const w = await resolveWriter(sessionId, cwd)
        if (!w) { sendJson(res, 404, { error: '还没有任何会话日志' }); return }
        const [tasks, fails, models, journal, subs] = await Promise.all([
          readIfExists(w.tasksPath), readIfExists(w.failPath),
          readIfExists(w.modelsPath), readIfExists(w.mdPath), readIfExists(w.subagentsPath),
        ])
        const modelLines = models.split('\n').filter((l) => /^- \d{4}-/.test(l))
        const failBlocks = fails.split('\n').filter((l) => l.startsWith('## F'))
        const subBlocks = subs.split('\n').filter((l) => l.startsWith('## S'))
        sendJson(res, 200, hideDeep({
          session: w.sessionId,
          dir: w.dir,
          sessionFile: sessionFilePath(w.cwd, w.sessionId),
          sessionFileExists: existsSync(sessionFilePath(w.cwd, w.sessionId)),
          files: {
            journal: w.mdPath, tasks: w.tasksPath, failures: w.failPath,
            models: w.modelsPath, events: w.jsonlPath, subagents: w.subagentsPath,
          },
          counts: {
            tasks: countOf(tasks, /^- \[[ x]\]/gm),
            open: countOf(tasks, /^- \[ \]/gm),
            done: countOf(tasks, /^- \[x\]/gm),
            failures: failBlocks.length,
            models: modelLines.length,
            subagents: subBlocks.length,
          },
          latestModel: modelLines.length > 0 ? modelLines[modelLines.length - 1].replace(/^- \S+\s*\S*｜/, '') : null,
          live: writers.has(w.sessionId),
        }))
        return
      }

      // —— 各份文本 ——
      const textRoutes = {
        '/tasks': 'tasksPath',
        '/failures': 'failPath',
        '/models': 'modelsPath',
        '/journal': 'mdPath',
        '/subagents': 'subagentsPath',
      }
      if (req.method === 'GET' && textRoutes[path] !== undefined) {
        const w = await resolveWriter(sessionId, cwd)
        if (!w) { sendJson(res, 404, { error: '还没有任何会话日志' }); return }
        const text = await readIfExists(w[textRoutes[path]])
        // 界面不需要整份巨量日志，尾部截断即可。
        const cap = 200 * 1024
        const clipped = text.length > cap ? `…（仅显示末尾 ${Math.floor(cap / 1024)}KB）\n\n${text.slice(-cap)}` : text
        sendJson(res, 200, { session: w.sessionId, path: hideHome(w[textRoutes[path]]), text: clipped })
        return
      }

      // —— 导出 ——
      if (req.method === 'POST' && path === '/export') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        const w = await resolveWriter(body.session ?? sessionId, body.cwd ?? cwd)
        if (!w) { sendJson(res, 404, { error: '还没有任何会话日志' }); return }
        await w.queue
        const r = await exportJournal(w, body.dir, body.format ?? 'md')
        sendJson(res, 200, hideDeep({ ok: true, ...r }))
        return
      }

      // —— 一键重试 ——
      if (req.method === 'POST' && path === '/retry') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        const w = await resolveWriter(body.session ?? sessionId, body.cwd ?? cwd)
        if (!w) { sendJson(res, 404, { error: '还没有任何会话日志' }); return }
        await w.queue
        const last = await lastOpenFromDisk(w)
        const prompt = last !== null ? `${cfg.retryPrompt}\n\n原任务：${last.text}` : cfg.retryPrompt
        const extra = typeof body.note === 'string' && body.note !== '' ? `\n补充：${body.note}` : ''
        const r = retryTask(w.sessionId, prompt + extra)
        if (!r.ok) { sendJson(res, 200, { ok: false, message: r.reason }); return }
        const label = last !== null ? `T${last.n}` : '（无记录的任务）'
        sendJson(res, 200, { ok: true, task: label, message: `已请求继续：${label}` })
        return
      }

      // —— 历史会话查询（含未装插件时期的旧会话）——
      if (req.method === 'GET' && path === '/history') {
        const q2 = (q.get('q') ?? '').trim().toLowerCase()
        const lim = Math.max(1, Math.min(500, Number(q.get('limit') ?? 100) || 100))
        let list = await scanSessionArchives(lim)
        // 带上「是否已有插件日志」的标记，界面据此决定能否看统计。
        // 对每个历史会话，判断它的 cwd 下有没有插件日志（tasks-<sid>.md）。
        // 不能只看 registry：旧会话从没进过 registry，但它自己的 cwd 下可能
        // 确实有日志（比如当前这台机器上的活动项目）。
        {
          const extraDirs = [...registry.known]
          for (const w of writers.values()) extraDirs.push(w.dir)
          if (typeof cwd === 'string' && cwd !== '') {
            const b = cfg.dir !== '' ? cfg.dir : join(cwd, '.dsh-journal')
            extraDirs.push(isAbsolute(b) ? b : resolve(cwd, b))
          }
          for (const s of list) {
            // 契约稳定：无论有没有日志，hasJournal 始终是布尔值。
            s.hasJournal = false
            s.journalDir = null
            const sid2 = safeId(s.sessionId)
            const candidates = new Set(extraDirs)
            if (typeof s.cwd === 'string' && s.cwd !== '') {
              const b = cfg.dir !== '' ? cfg.dir : join(s.cwd, '.dsh-journal')
              candidates.add(isAbsolute(b) ? b : resolve(s.cwd, b))
            }
            for (const d of candidates) {
              if (existsSync(join(d, `tasks-${sid2}.md`))) {
                s.hasJournal = true
                s.journalDir = d
                break
              }
            }
          }
        }
        if (q2 !== '') {
          list = list.filter((s) =>
            String(s.sessionId).toLowerCase().includes(q2)
            || String(s.cwd ?? '').toLowerCase().includes(q2))
        }
        sendJson(res, 200, hideDeep({ root: sessionsRoot(), sessions: list }))
        return
      }

      // —— 单个历史会话的摘要（从存档直接抽任务与产出）——
      if (req.method === 'GET' && path === '/history/digest') {
        const target = q.get('session')
        if (typeof target !== 'string' || target === '') {
          sendJson(res, 400, { error: '需要 ?session=<会话id>' }); return
        }
        const all = await scanSessionArchives(500)
        const hit = all.find((s) => s.sessionId === target)
        if (hit === undefined) { sendJson(res, 404, { error: `找不到会话 ${target}` }); return }
        const dg = readArchiveDigest(hit.file)
        if (dg === null) { sendJson(res, 500, { error: '存档解压失败' }); return }
        sendJson(res, 200, hideDeep({
          session: hit.sessionId,
          cwd: hit.cwd,
          file: hit.file,
          size: hit.size,
          mtime: hit.mtime,
          turns: dg.turns,
          taskCount: dg.tasks.length,
          replyCount: dg.replies.length,
          tasks: dg.tasks.slice(-50),
          replies: dg.replies.slice(-20),
        }))
        return
      }

      // —— 开新会话续跑 ——
      if (req.method === 'POST' && path === '/retry-new') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        const w = await resolveWriter(body.session ?? sessionId, body.cwd ?? cwd)
        if (!w) { sendJson(res, 404, { error: '还没有任何会话日志' }); return }
        await w.queue
        const last = await lastOpenFromDisk(w)
        const prompt = last !== null ? `${cfg.retryPrompt}\n\n原任务：${last.text}` : cfg.retryPrompt
        const r = await retryInNewSession(w, prompt, typeof body.note === 'string' ? body.note : '')
        sendJson(res, 200, r)
        return
      }

      // —— 直接标记失败 ——
      if (req.method === 'POST' && path === '/abandon') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        const w = await resolveWriter(body.session ?? sessionId, body.cwd ?? cwd)
        if (!w) { sendJson(res, 404, { error: '还没有任何会话日志' }); return }
        const r = await markFailed(w, typeof body.note === 'string' ? body.note : '')
        sendJson(res, 200, r)
        return
      }

      // —— 子智能体目录 ——
      if (req.method === 'GET' && path === '/subagents/catalog') {
        const all = currentCatalog()
        const want = (q.get('category') ?? '').trim()
        const filtered = want === '' ? all : all.filter((e) => e.category === normalizeCategory(want))
        sendJson(res, 200, {
          count: filtered.length,
          categories: categoryIds().map((id) => ({ id, ...CATEGORIES[id] })),
          groups: groupByCategory(filtered),
        })
        return
      }

      // —— 单个子智能体的详情 ——
      if (req.method === 'GET' && path === '/subagents/entry') {
        const id = q.get('id')
        if (typeof id !== 'string' || id === '') { sendJson(res, 400, { error: '需要 ?id=<条目id>' }); return }
        const hit = currentCatalog().find((e) => e.id === id)
        if (hit === undefined) { sendJson(res, 404, { error: `目录里没有 ${id}` }); return }
        sendJson(res, 200, { entry: hit, markdown: entryMarkdown(hit) })
        return
      }

      // —— 子智能体归档状态 ——
      if (req.method === 'GET' && path === '/subagents/archive') {
        const w = await resolveWriter(sessionId, cwd)
        const root = w !== null ? catalogRootFor(w) : null
        const out = { dir: root === null ? null : hideHome(root), exists: false, counts: {}, files: [] }
        if (root !== null) {
          const entriesDir = join(subagentDir(root), 'entries')
          const presetsDir = join(subagentDir(root), 'presets')
          const srcDir = join(subagentDir(root), 'src')
          out.exists = existsSync(subagentDir(root))
          try { out.counts.entries = (await readdir(entriesDir)).filter((n) => n.endsWith('.md')).length } catch { out.counts.entries = 0 }
          try { out.counts.presets = (await readdir(presetsDir)).length } catch { out.counts.presets = 0 }
          try { out.counts.sources = (await readdir(srcDir)).filter((n) => n !== 'SOURCE.md').length } catch { out.counts.sources = 0 }
          for (const n of ['catalog.json', 'catalog.md']) {
            if (existsSync(join(subagentDir(root), n))) out.files.push(hideHome(join(subagentDir(root), n)))
          }
        }
        sendJson(res, 200, out)
        return
      }

      // —— 持久化目录（可选归档源码）——
      if (req.method === 'POST' && path === '/subagents/save') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        const w = await resolveWriter(body.session ?? sessionId, body.cwd ?? cwd)
        if (!w) { sendJson(res, 404, { error: '还没有任何会话日志' }); return }
        await w.queue
        const root = catalogRootFor(w)
        const entries = currentCatalog()
        const r = await writeCatalog(root, entries, { home: homedir() })
        let src = null
        if (body.sources === true) {
          const s = await archiveSources(root, entries, { home: homedir() })
          src = { ok: s.ok, total: s.total, dir: hideHome(s.dir), results: hideDeep(s.results) }
          await w.md(`\n<!-- 子智能体源码归档：${s.ok}/${s.total}｜${stamp(Date.now())} -->\n`)
        }
        await w.md(`\n<!-- 子智能体目录已归档：${r.count} 条 → ${hideHome(r.dir)}｜${stamp(Date.now())} -->\n`)
        sendJson(res, 200, {
          ok: true, dir: hideHome(r.dir), count: r.count,
          files: r.files.map(hideHome), sources: src,
        })
        return
      }

      // —— 归档真实源码 ——
      if (req.method === 'POST' && path === '/subagents/sources') {
        const body = await readBody(req)
        if (body === null) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return }
        const w = await resolveWriter(body.session ?? sessionId, body.cwd ?? cwd)
        if (!w) { sendJson(res, 404, { error: '还没有任何会话日志' }); return }
        await w.queue
        const root = catalogRootFor(w)
        const s = await archiveSources(root, currentCatalog(), { home: homedir() })
        await w.md(`\n<!-- 子智能体源码归档：${s.ok}/${s.total}｜${stamp(Date.now())} -->\n`)
        sendJson(res, 200, { ok: true, dir: hideHome(s.dir), okCount: s.ok, total: s.total, results: hideDeep(s.results) })
        return
      }

      sendJson(res, 404, { error: `未知接口：${req.method} ${path}` })
    } catch (e) {
      sendJson(res, 500, { error: e?.message ?? String(e) })
    }
  }

  return handler
}



// ——————————————————————————————— 会话存档扫描 ———————————————————————————————

/** 会话存档根目录。 */
function sessionsRoot() {
  return process.env.DSH_SESSIONS_DIR
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}


/**
 * 解压一个多帧 zstd 文件。
 *
 * DSH 的会话归档是**边写边压缩**的：每次追加都产生一个独立的 zstd 帧，
 * 所以一个 4MB 的会话可能有几千帧。`zstdDecompressSync` 只解第一帧，
 * 必须按魔数切帧、逐帧解压再拼接。
 *
 * @param buf 整个文件内容。
 * @returns 解码后的 UTF-8 文本；不可解的部分跳过。
 */
function decompressAllFrames(buf) {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      offsets.push(i)
    }
  }
  if (offsets.length === 0) {
    try { return zstdDecompressSync(buf).toString('utf8') } catch { return '' }
  }
  const parts = []
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    const frame = buf.subarray(start, end)
    try { parts.push(zstdDecompressSync(frame)) } catch { /* 该帧损坏，跳过 */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * 枚举磁盘上的历史会话（含尚未装插件时期的旧会话）。
 *
 * 扫描 `<sessionsRoot>/*\/session-*\/session.v4.jsonl.zstd`，从每个存档的
 * 头两行读出 id / cwd / 创建时间（不解压全文，只取文件头一小段）。
 *
 * @param limit 最多返回多少条（按修改时间倒序）。
 * @returns 会话摘要数组。
 */
async function scanSessionArchives(limit = 200) {
  const root = sessionsRoot()
  const out = []
  let dirs = []
  try { dirs = await readdir(root) } catch { return out }
  for (const proj of dirs) {
    const projDir = join(root, proj)
    let ids = []
    try { ids = await readdir(projDir) } catch { continue }
    for (const id of ids) {
      const file = join(projDir, id, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      let mtime = 0
      let size = 0
      try {
        const st = await stat(file)
        mtime = st.mtimeMs
        size = st.size
      } catch { continue }
      const head = readArchiveHead(file, 8192)
      out.push({
        sessionId: head?.id ?? id,
        cwd: head?.cwd ?? null,
        createdAt: head?.createdAt ?? null,
        agentPreset: head?.agentPreset ?? null,
        file,
        size,
        mtime,
      })
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, limit)
}

/** 只解压存档开头的一小段，取前两行元数据。失败返回 null。 */
function readArchiveHead(file, bytes) {
  try {
    const text = decompressAllFrames(readFileSync(file)).slice(0, 64 * 1024)
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const e = JSON.parse(line)
        if (e.type === 'session') return e
      } catch { /* 该行不完整，继续 */ }
    }
  } catch { /* 解压失败 */ }
  return null
}

/**
 * 从会话存档里抽取「任务」与「助手产出」的摘要，用于在没有插件日志的
 * 旧会话上也能给出可读预览。
 */
function readArchiveDigest(file, maxEvents = 400) {
  try {
    const text = decompressAllFrames(readFileSync(file))
    const tasks = []
    const replies = []
    let turns = 0
    let lastTime = 0
    let i = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '' || i >= maxEvents) continue
      i += 1
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (typeof e.time === 'number') lastTime = e.time
      if (e.type === 'turn/end') turns += 1
      if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
        const txt = blocksToText(e.data.content)
        if (txt.trim() !== '') tasks.push({ at: e.time, text: txt.slice(0, 300) })
      }
      if (e.type === 'assistant/message') {
        const txt = blocksToText(e.data?.message?.content)
        if (txt.trim() !== '') replies.push({ at: e.time, text: txt.slice(0, 300) })
      }
    }
    return { tasks, replies, turns, lastTime }
  } catch { return null }
}

// ——————————————————————————————— 会话文件路径 ———————————————————————————————

/**
 * 复刻 DSH 会话持久化的路径规则（见 dsh-session-persistence-jsonl 的
 * `projectKey` / `encodeSegment`），用来算出「这个会话的原始日志文件在哪」。
 *
 *   <sessionsRoot>/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.v4.jsonl.zstd
 *
 * 规则：非 [A-Za-z0-9._-] 的字符编码成 `~XXXX`（4 位大写十六进制）；
 * 路径分隔符与冒号压成一个 `-`；整体包成 `--slug--`。
 */
function encodeSegment(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** cwd → 会话所在的项目目录名。 */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** 会话原始日志文件的绝对路径（不保证存在）。 */
function sessionFilePath(cwd, sessionId) {
  const root = process.env.DSH_SESSIONS_DIR
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  return join(root, projectKey(cwd || process.cwd()), encodeSegment(String(sessionId)), 'session.v4.jsonl.zstd')
}

// ——————————————————————————————— 已知目录登记 ———————————————————————————————

/**
 * 已知日志目录的持久化登记。
 *
 * 服务重启后内存里的 writer 会丢；界面仍要能列出历史日志，所以把见过的
 * 目录写进 `<DSH_HOME>/dsh-task-journal/dirs.json`，启动后读回。
 */
function makeDirRegistry() {
  const file = join(
    process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    'dsh-task-journal', 'dirs.json',
  )
  const known = new Set()
  let loaded = false
  let timer = null

  const load = async () => {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(file, 'utf8')
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) for (const d of arr) if (typeof d === 'string' && d !== '') known.add(d)
    } catch { /* 首次运行没有该文件 */ }
  }

  const save = () => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      mkdir(dirname(file), { recursive: true })
        .then(() => writeFile(file, JSON.stringify([...known], null, 2), 'utf8'))
        .catch(() => {})
    }, 500)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const remember = (d) => {
    if (typeof d !== 'string' || d === '' || known.has(d)) return
    known.add(d)
    save()
  }

  return { file, known, load, remember }
}
