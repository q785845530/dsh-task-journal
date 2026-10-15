/**
 * dsh-task-journal — host half.
 *
 * 把「任务」与「工作结果」写到本地文件。两条写入路径：
 *
 *  1) 自动（会话事件流）：订阅 `session/event`，在事件提交后把
 *     - 真人下发的任务（`user/message`，source.kind === 'user'）
 *     - 助手产出（`assistant/message` 文本）
 *     - 工具结果（`tool/result`：工具名、成败、输出摘要）
 *     增量追加到当次会话的日志文件。
 *
 *  2) 主动（`journal` 工具）：模型按需把任务/结论/待办写进同一份日志。
 *
 * 产出（默认落在会话 cwd 下的 `.dsh-journal/`）：
 *  - `journal-<sessionId>.md`   人读的 Markdown 汇总日志
 *  - `events-<sessionId>.jsonl` 机读事件流，一行一个 JSON
 *  - `tasks-<sessionId>.md`     任务清单
 *
 * 设计约束：
 *  - 只做 host 半；不注册 client 半。
 *  - 写入**只追加**，绝不覆盖既有内容。
 *  - 每会话一条写队列，串行落盘，顺序与事件一致、不交错。
 *  - 失败只记 warn，绝不让插件把宿主会话搞崩。
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-task-journal'

/** 注入消息时使用的 producer-owned kind（会话准入会校验 kind）。 */
const SOURCE_KIND = 'dsh-task-journal'

/** 不记录子代理会话（归其父会话所有）。 */
const EXCLUDE_ORIGIN = 'subagent'

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

// ——————————————————————————————— 日志写入器 ———————————————————————————————

/** 每会话一个写入器：一条串行队列，保证顺序与不交错。 */
class JournalWriter {
  constructor(ctx, session, cfg) {
    this.ctx = ctx
    this.cfg = cfg
    this.queue = Promise.resolve()
    this.taskCount = 0
    this.headerWritten = false
    /** callId -> 工具名。`tool/result` 只带 callId，名字在 `tool/call` 里。 */
    this.toolNames = new Map()

    this.sessionId = String(session?.id ?? '')
    const sid = safeId(this.sessionId)
    const cwd = cwdOf(session)
    const base = cfg.dir !== '' ? cfg.dir : join(cwd, '.dsh-journal')
    this.dir = isAbsolute(base) ? base : resolve(cwd, base)
    this.cwd = cwd

    this.mdPath = join(this.dir, `journal-${sid}.md`)
    this.jsonlPath = join(this.dir, `events-${sid}.jsonl`)
    this.tasksPath = join(this.dir, `tasks-${sid}.md`)
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
    if (!existsSync(this.mdPath)) {
      await writeFile(this.mdPath, [
        `# 任务日志`,
        ``,
        `- 会话：\`${this.sessionId}\``,
        `- 工作目录：\`${this.cwd}\``,
        `- 创建时间：${stamp(Date.now())}`,
        ``,
        `> 由 dsh-task-journal 自动追加；请勿手工清空。`,
        ``,
        `---`,
        ``,
      ].join('\n'), 'utf8')
    }
    if (!existsSync(this.tasksPath)) {
      await writeFile(this.tasksPath, [
        `# 任务清单`,
        ``,
        `- 会话：\`${this.sessionId}\``,
        ``,
        `---`,
        ``,
      ].join('\n'), 'utf8')
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
}

// ——————————————————————————————— 插件主体 ———————————————————————————————

export function apply(ctx, config = {}) {
  if (!boolFrom(config, 'enabled', true)) return

  const cfg = {
    dir: strFrom(config, 'dir', ''),
    markdown: boolFrom(config, 'markdown', true),
    jsonl: boolFrom(config, 'jsonl', true),
    recordAssistant: boolFrom(config, 'recordAssistant', true),
    maxChars: intFrom(config, 'maxChars', 4000),
    notify: boolFrom(config, 'notify', false),
  }

  /** sessionId -> JournalWriter */
  const writers = new Map()

  const writerFor = (session) => {
    const sid = String(session?.id ?? '')
    let w = writers.get(sid)
    if (w === undefined) {
      w = new JournalWriter(ctx, session, cfg)
      writers.set(sid, w)
      ctx.logger?.info?.(`dsh-task-journal: 日志目录 ${w.dir}`)
    }
    return w
  }

  /** 会话内轻量回执（不唤醒模型）。 */
  const notifySession = (session, text) => {
    if (!cfg.notify || !session || typeof session.append !== 'function') return
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

  /** 主事件处理。 */
  const onSessionEvent = (session, event) => {
    if (!session || !event || typeof event.type !== 'string') return
    if (session.header?.origin === EXCLUDE_ORIGIN) return

    const w = writerFor(session)
    const time = typeof event.time === 'number' ? event.time : Date.now()
    const seq = event.seq

    switch (event.type) {
      case 'user/message': {
        const msg = event.data
        // 真人输入（kind='user'）与自动续写提示（kind='dsh-continue'）都算任务；
        // runtime-context / time-context / skill-catalog 等注入上下文不算。
        const srcKind = msg?.source?.kind
        if (srcKind !== 'user' && srcKind !== 'dsh-continue') return
        const text = clip(blocksToText(msg?.content), cfg.maxChars)
        if (text.trim() === '') return
        w.taskCount += 1
        const n = w.taskCount
        w.md(`\n## 任务 ${n}｜${stamp(time)}\n\n${text}\n`)
        w.task(`- [ ] ${stamp(time)}｜${text.split('\n')[0].slice(0, 140)}`)
        w.json({ t: stamp(time), ts: time, seq, type: 'task', n, text })
        notifySession(session, `已记入任务日志（第 ${n} 条）`)
        return
      }

      case 'assistant/message': {
        if (!cfg.recordAssistant) return
        const text = clip(blocksToText(event.data?.message?.content), cfg.maxChars)
        if (text.trim() === '') return
        w.md(`\n### 产出｜${stamp(time)}\n\n${text}\n`)
        w.json({ t: stamp(time), ts: time, seq, type: 'assistant', text })
        return
      }

      // 工具调用：记下 callId -> 名字，供随后到达的 tool/result 查名。
      case 'tool/call': {
        const callId = event.data?.callId
        const toolName = event.data?.name
        if (typeof callId === 'string' && typeof toolName === 'string') {
          w.toolNames.set(callId, toolName)
        }
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
        return
      }

      case 'turn/end': {
        const r = event.data?.reason
        const kind = typeof r === 'string' ? r : r?.kind
        w.md(`\n<!-- 轮次结束：${kind ?? 'unknown'}｜${stamp(time)} -->\n`)
        w.json({ t: stamp(time), ts: time, seq, type: 'turn/end', reason: kind ?? null })
        return
      }

      default:
        return
    }
  }

  ctx.effect(() => ctx.on('session/event', onSessionEvent), 'dsh-task-journal: session/event 订阅')

  // —— 主动记录工具 ——
  ctx.inject(['tools'], (agentCtx) => {
    try {
      agentCtx.tools.register(defineTool({
        name: 'journal',
        description:
          '把一条任务/结论/待办写入本地任务日志（.dsh-journal/），用于长任务里留下可追溯的阶段结果。'
          + 'kind：task=新任务，result=阶段结论，note=备注，todo=待办。',
        parameters: {
          kind: {
            type: 'string',
            required: true,
            description: '记录类型：task | result | note | todo',
            enum: ['task', 'result', 'note', 'todo'],
          },
          text: {
            type: 'string',
            required: true,
            description: '要记录的内容（支持 Markdown）',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              bytes: { type: 'number', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `已写入 ${value.path}（${value.bytes} 字节）` }],
        },
        async execute(args, exec) {
          // 官方取法：exec.agent.session（LiveAgent 上挂着 session）。
          // 退路：只有 sessionId 时，按 id 找回同一个 writer。
          const session = exec?.agent?.session
          const w = session !== undefined
            ? writerFor(session)
            : (writers.get(String(exec?.agent?.sessionId ?? '')) ?? writerFor({ id: exec?.agent?.sessionId, header: {} }))
          const now = stamp(Date.now())
          const head = args.kind === 'task' ? `## 任务｜${now}`
            : args.kind === 'result' ? `### 结论｜${now}`
              : args.kind === 'todo' ? `### 待办｜${now}`
                : `### 备注｜${now}`
          const body = clip(args.text, cfg.maxChars)
          await w.md(`${head}\n\n${body}\n`)
          if (args.kind === 'task') {
            w.taskCount += 1
            await w.task(`- [ ] ${now}｜${body.split('\n')[0].slice(0, 140)}`)
          }
          await w.json({ t: now, ts: Date.now(), type: 'manual', kind: args.kind, text: body })
          return { path: w.mdPath, bytes: Buffer.byteLength(body, 'utf8') }
        },
      }))
      ctx.logger?.info?.('dsh-task-journal: journal 工具已注册')
    } catch (e) {
      ctx.logger?.warn?.(`dsh-task-journal: journal 工具注册失败：${e?.message ?? String(e)}`)
    }
  })
}
