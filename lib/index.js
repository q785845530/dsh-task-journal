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
 *
 * 产出（默认落在会话 cwd 下的 `.dsh-journal/`）：
 *  - `journal-<sid>.md`    人读的 Markdown 汇总日志
 *  - `events-<sid>.jsonl`  机读事件流（含模型参数、用量、失败原因）
 *  - `tasks-<sid>.md`      任务清单（带 T 编号与完成状态）
 *  - `failures-<sid>.md`   未完成的任务与原因（可重试）
 *  - `models-<sid>.md`     模型与参数变更记录
 *
 * 设计约束：
 *  - 只做 host 半。
 *  - 写入**只追加**，绝不覆盖既有内容。
 *  - 每会话一条写队列，串行落盘，顺序与事件一致。
 *  - 失败只记 warn，绝不让插件把宿主会话搞崩。
 *  - `followup` 必须在事件分发之外调用（宿主拒绝重入 append），用 setTimeout(0) 延后。
 */
import { appendFile, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

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
  }

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
    const live = liveAgents.get(String(sessionId)) ?? ctx.agents?.get?.(String(sessionId))
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

      ctx.logger?.info?.('dsh-task-journal: 已注册 journal / journal_export / journal_retry')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-task-journal: 工具注册失败：${e?.message ?? String(e)}`)
    }
  })
}
