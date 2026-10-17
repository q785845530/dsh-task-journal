/**
 * dsh-task-journal — 会话日志修复核心（host / CLI / 自测共用）。
 *
 * 为什么需要它
 * ------------
 * `Session.append()` 只校验事件外壳与 surface 元数据，**不校验消息形状**；
 * 消息不变量只在**加载**日志时才检查（`adoptSessionEvent` / `Session.fromRestore`）。
 * 于是插件若用 `session.append('user/message', { content, source })` 写入
 * （缺 `role` / `id`），事件能顺利落盘，却把该日志永久毒化：之后每次加载都失败，
 * 报 `session event at seq <n> lacks an identified message`。
 *
 * 本模块做四件事，只用 node 内建模块与本包内的模块
 * （不 import 宿主包，因为插件进程解析不到 `@deepseek-ai/dsh-session`）：
 *   1. `diagnose*` —— 判定一个日志能否加载、坏在哪、谁写的；
 *   2. `repairBuffer` —— 只重写含坏事件的 zstd 帧，其余帧原字节保留；
 *   3. `scrubBuffer` —— 只重写含凭据的那些行，其余帧原字节保留；
 *   4. 修复后自证 —— 解码新字节、逐事件复检，任一失败即拒绝写入。
 *
 * 关键不变量
 * ----------
 * - 只改「坏行」，其余行逐字节不变。
 * - 只补缺失的 `role` / `id`，绝不猜 `source`、绝不改 `content`。
 * - 补的 id 由 `sha256(sessionId:seq)` 派生 → 同一输入两次修复字节一致（幂等）。
 * - 未知键顺序原样保留，已知键按宿主规范顺序归位。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, statSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import { redactSecrets } from './redact.js'

/** zstd 帧魔数（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xFD2FB528

/** 与宿主一致的压缩参数：带校验和，保证帧自校验。 */
const COMPRESS_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** 会产生消息的事件类型（宿主 `SURFACE_EVENT_TYPES`）。 */
const MESSAGE_TYPES = new Set([
  'system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result',
])

/**
 * 每种消息类型期望的角色。
 *
 * 与 profile 安装的 dsh-session 0.2.1-alpha.1 对齐：`tool/result` → `tool`。
 * （旧的 0.1.x CLI 用 `user`，与本机会话数据不符，故不采用。）
 */
const ROLE_BY_TYPE = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/** 事件外壳的规范键顺序（未列出的键按原顺序附在末尾）。 */
const ENVELOPE_ORDER = ['type', 'seq', 'time', 'data', 'sourceEventSeqs', 'surfaceOp']

/** `data` 的规范键顺序，按事件类型区分。 */
const DATA_ORDER = {
  'user/message': ['content', 'source', 'role', 'id'],
  'request/header': ['header', 'reason'],
  'tool/result': ['turn', 'step', 'message', 'meta', 'error'],
}

/** 嵌套 `data.message` 的规范键顺序，按事件类型区分。 */
const MESSAGE_ORDER = {
  'system/message': ['role', 'content', 'source', 'id'],
  'developer/message': ['role', 'content', 'source', 'id'],
  'assistant/message': ['role', 'content', 'source', 'id'],
  'tool/result': ['role', 'source', 'toolCallId', 'content', 'isError', 'id'],
}

// ————————————————————————————— zstd 帧 —————————————————————————————

/**
 * 按 zstd 帧结构切分拼接流。
 *
 * 不复用「扫魔数」的做法：魔数可能出现在压缩块内部，扫魔数会把一个帧切碎，
 * 从而静默丢事件。这里逐帧读 frame header 与 block header 定位边界。
 *
 * @param {Buffer} buf 完整文件内容。
 * @returns {{frames: Array<{start:number,end:number}>, tornStart: (number|undefined)}}
 *   完整帧范围；末尾不完整帧的起点（没有则 undefined）。
 */
export function scanZstdFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4 || buf.readUInt32LE(offset) !== ZSTD_MAGIC) {
      return { frames, tornStart: start }
    }
    const descriptor = buf.readUInt8(offset + 4)
    const fcsFlag = descriptor >>> 6
    const singleSegment = (descriptor >>> 5) & 1
    const checksum = (descriptor >>> 2) & 1
    const dictFlag = descriptor & 3
    offset += 5
    if (!singleSegment) offset += 1
    if (dictFlag === 1) offset += 4
    else if (dictFlag === 2) offset += 8
    else if (dictFlag === 3) offset += 4
    offset += fcsFlag === 0 ? (singleSegment ? 1 : 0)
      : fcsFlag === 1 ? 2
        : fcsFlag === 2 ? 4 : 8

    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start }
      const header = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (header & 1) !== 0
      const blockType = (header >>> 1) & 3
      const blockSize = header >>> 3
      if (blockType === 3) throw new Error(`zstd 保留块类型（偏移 ${offset - 3}）`)
      const payload = blockType === 1 ? 1 : blockSize
      if (buf.length - offset < payload) return { frames, tornStart: start }
      offset += payload
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * 解码整个会话归档。
 *
 * @param {Buffer} buf 文件内容。
 * @returns {{
 *   header: object|null, frames: Array, tornStart: (number|undefined),
 *   lines: Array<{text:string, event:object|null, frame:number, parseError:(string|null)}>,
 *   events: object[], failReason: (string|null),
 * }}
 */
export function decodeSession(buf) {
  const { frames, tornStart } = scanZstdFrames(buf)
  const lines = []
  let header = null
  let failReason = null
  if (frames.length === 0) return { header, frames, tornStart, lines, events: [], failReason: '没有可读的 zstd 帧' }

  // 第一帧是文件头（单行 JSON）。
  try {
    const head = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8')
    header = JSON.parse(head.trim())
  } catch (error) {
    failReason = `头部帧不可解析：${error?.message ?? String(error)}`
    return { header, frames, tornStart, lines, events: [], failReason }
  }

  for (let i = 1; i < frames.length; i += 1) {
    let text
    try {
      text = zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end)).toString('utf8')
    } catch (error) {
      return { header, frames, tornStart, lines, events: [], failReason: `第 ${i} 帧解压失败：${error?.message ?? String(error)}` }
    }
    const parts = text.split('\n')
    const trailing = parts.pop()
    if (trailing !== '') {
      return { header, frames, tornStart, lines, events: [], failReason: `第 ${i} 帧末尾不是换行（可能被撕裂）` }
    }
    for (const line of parts) {
      if (line === '') continue
      let event = null
      let parseError = null
      try { event = JSON.parse(line) } catch (error) { parseError = String(error?.message ?? error) }
      lines.push({ text: line, event, frame: i, parseError })
    }
  }
  return { header, frames, tornStart, lines, events: lines.map((l) => l.event).filter(Boolean), failReason }
}

// ————————————————————————————— 校验（宿主不变量副本）—————————————————————————————

/** 非空字符串判定。 */
function nonEmptyString(v) { return typeof v === 'string' && v !== '' }

/** 非负安全整数（用于 seq 判定）。 */
function isEventSeq(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0) }

/** 是否为普通记录对象。 */
function isRecord(v) { return typeof v === 'object' && v !== null && !Array.isArray(v) }

/**
 * 复检单条事件，返回失败原因或 null。
 *
 * 覆盖宿主 `assertMessageEventShape` 与 `validateSessionEventData` 中
 * 与「消息能否安全重放」相关的部分。不覆盖引用历史（replacement 成员关系）
 * 等需要全量上下文的检查，那些由修复后的宿主重读兜底。
 *
 * @param {object} event 会话事件。
 * @returns {string|null} 失败原因；通过则 null。
 */
export function validateEvent(event) {
  if (!isRecord(event)) return '事件不是对象'
  if (typeof event.type !== 'string' || event.type === '') return '事件缺 type'
  if (!isEventSeq(event.seq)) return '事件 seq 非法'
  if (!Number.isSafeInteger(event.time)) return '事件 time 非法'
  if (event.data === undefined) return '事件缺 data'

  const type = event.type
  const data = event.data

  // —— request/header 的形状与空字段禁令 ——
  if (type === 'request/header') {
    if (!isRecord(data)) return 'data 必须是对象'
    const header = data.header
    if (!isRecord(header)) return 'header 必须是对象'
    if (Object.hasOwn(header, 'system')) return 'header 不得带 system 字段'
    if (Array.isArray(header.tools) && header.tools.length === 0) return 'header.tools 不得为空数组'
    const defaults = header.adapterDefaults
    if (isRecord(defaults) && Object.keys(defaults).length === 0) return 'header.adapterDefaults 不得为空对象'
    return null
  }

  // —— tool/result：有 error 就必须 message.isError === true ——
  if (type === 'tool/result') {
    if (!isRecord(data)) return 'data 必须是对象'
    if (data.error !== undefined) {
      const message = data.message
      if (!isRecord(message) || message.isError !== true) return 'data.error 要求 message.isError === true'
    }
  }

  // —— 消息形状 ——
  if (!MESSAGE_TYPES.has(type)) return null
  if (!isRecord(data)) return 'data 必须是对象'
  const message = type === 'user/message' ? data : data.message
  if (!isRecord(message)) return '缺少消息对象'
  if (!nonEmptyString(message.id)) return '消息缺少 id'
  const expectedRole = ROLE_BY_TYPE[type]
  if (message.role !== expectedRole) return `消息 role 必须是 "${expectedRole}"`
  const source = message.source
  if (!isRecord(source) || !nonEmptyString(source.kind)) return '消息 source 非法'
  if (!Array.isArray(message.content)) return '消息 content 必须是数组'

  if (type === 'system/message') {
    if (source.kind !== 'system-prompt') return 'system 消息的 source.kind 必须是 "system-prompt"'
    return null
  }
  if (type === 'assistant/message') {
    if (source.kind !== 'model') return 'assistant 消息的 source.kind 必须是 "model"'
    if (!nonEmptyString(source.provider) || !nonEmptyString(source.model)) return 'assistant 消息缺 provider/model'
    return null
  }
  if (type !== 'tool/result') return null
  if (source.kind !== 'tool') return 'tool/result 的 source.kind 必须是 "tool"'
  if (!nonEmptyString(source.callId)) return 'tool/result 的 source.callId 缺失'
  if (message.toolCallId !== source.callId) return 'tool/result 的 toolCallId 与 source.callId 不一致'
  return null
}

/**
 * 施加「可推导的修复」：只补 role 与 id，其余字段一律不动。
 *
 * 这是纯函数，不做判定；判定见 {@link classifyIssue}。
 *
 * @param {object} event 消息事件。
 * @param {string} sessionId 会话 id。
 * @returns {object|null} 修复后的事件；结构上不可推导时返回 null。
 */
function applyDerivableFix(event, sessionId) {
  const type = event.type
  const isInline = type === 'user/message'
  const message = isInline ? event.data : event.data?.message
  if (!isRecord(message)) return null
  if (!Array.isArray(message.content)) return null

  const nextMessage = { ...message }
  if (!nonEmptyString(nextMessage.id)) {
    nextMessage.id = sessionId === '' ? 'probe-id-placeholder' : derivedMessageId(sessionId, event.seq)
  }
  nextMessage.role = ROLE_BY_TYPE[type]

  const orderedMessage = reorderKeys(nextMessage, MESSAGE_ORDER[type] ?? Object.keys(nextMessage))
  const nextData = isInline
    ? orderedMessage
    : reorderKeys({ ...event.data, message: orderedMessage }, DATA_ORDER[type] ?? Object.keys(event.data))

  return reorderKeys({ ...event, data: nextData }, ENVELOPE_ORDER)
}

/**
 * 判定一条失败能否自动修复。
 *
 * 判据是**结构性的，不是看错误文案**：把 role 与 id 补齐（其它一律不动），
 * 若这条事件随即通过校验，就说明它唯一的问题就是「缺 role/id」→ 可自动修。
 * 只要还剩下任何别的问题（source 非法、content 不是数组、toolCallId 不一致……），
 * 就归为人工处理——猜错会静默改变模型看到的历史。
 *
 * 不按文案判断是刻意的：`validateEvent` 只报第一个问题，
 * 一条同时缺 id 与 source 的事件会先报「缺少 id」，按文案就会误判成可自动修。
 *
 * @param {object} event 事件。
 * @returns {'auto'|'manual'} 处理级别。
 */
export function classifyIssue(event) {
  if (!isRecord(event)) return 'manual'
  if (!MESSAGE_TYPES.has(event.type)) return 'manual'
  const probe = applyDerivableFix(event, '')
  if (probe === null) return 'manual'
  return validateEvent(probe) === null ? 'auto' : 'manual'
}

/** 事件的产出者：取消息 source.kind（notice 类来自插件）。 */
export function producerOf(event) {
  const message = event?.type === 'user/message' ? event?.data : event?.data?.message
  const kind = message?.source?.kind
  if (nonEmptyString(kind)) return kind
  if (nonEmptyString(event?.data?.message?.source?.kind)) return event.data.message.source.kind
  return '(未知)'
}

// ————————————————————————————— 诊断 —————————————————————————————

/**
 * 诊断一个已解码的会话。
 *
 * @param {{header: object|null, events: object[], failReason: (string|null)}} decoded 解码结果。
 * @param {object} [opts] 选项。
 * @param {string} [opts.sessionId] 会话 id（缺省取 header.id）。
 * @returns {object} 诊断报告。
 */
export function diagnoseDecoded(decoded, opts = {}) {
  const sessionId = String(opts.sessionId ?? decoded.header?.id ?? '')
  const issues = []
  const producers = {}

  if (decoded.failReason) issues.push({ seq: null, type: '(文件)', reason: decoded.failReason, level: 'manual', producer: '(文件)' })

  for (const event of decoded.events) {
    const reason = validateEvent(event)
    if (reason === null) continue
    const level = classifyIssue(event)
    const producer = producerOf(event)
    producers[producer] = (producers[producer] || 0) + 1
    issues.push({ seq: event?.seq ?? null, type: String(event?.type ?? '?'), reason, level, producer })
  }

  const auto = issues.filter((i) => i.level === 'auto').length
  const manual = issues.length - auto
  return {
    sessionId,
    cwd: decoded.header?.cwd ?? null,
    createdAt: decoded.header?.createdAt ?? null,
    ok: issues.length === 0,
    eventCount: decoded.events.length,
    frameCount: decoded.frames?.length ?? 0,
    tornStart: decoded.tornStart,
    issues,
    autoCount: auto,
    manualCount: manual,
    producers,
    repairable: issues.length > 0 && manual === 0,
  }
}

/** 诊断一段会话归档字节。 */
export function diagnoseBuffer(buf, opts = {}) {
  return diagnoseDecoded(decodeSession(buf), opts)
}

// ————————————————————————————— 修复 —————————————————————————————

/**
 * 由会话 id 与 seq 确定性派生消息 id。
 *
 * 用 sha256 而不是随机 UUID：同一输入两次修复产生完全相同字节，
 * 于是重复执行不会引入新 diff（幂等）。
 *
 * @param {string} sessionId 会话 id。
 * @param {number} seq 事件序号。
 * @returns {string} UUID 形状的稳定 id。
 */
export function derivedMessageId(sessionId, seq) {
  const hex = createHash('sha256').update(`${sessionId}:repair:${seq}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * 按规范顺序重排键：已知键按 canonical 归位，未知键保持原相对顺序附在末尾。
 *
 * 这是「归一化」而非「重建」——不会丢键、不会改值，只调整输出顺序，
 * 使新行与日志里其它行的字段顺序一致。
 *
 * @param {object} obj 源对象。
 * @param {string[]} canonical 规范键顺序。
 * @returns {object} 重排后的新对象。
 */
function reorderKeys(obj, canonical) {
  const out = {}
  for (const key of canonical) if (Object.hasOwn(obj, key)) out[key] = obj[key]
  for (const key of Object.keys(obj)) if (!Object.hasOwn(out, key)) out[key] = obj[key]
  return out
}

/**
 * 生成一条事件修复后的对象；无需修复或无法修复时返回 null。
 *
 * 只做两件事：补 `role`、补 `id`。其余字段原样引用，绝不改写内容。
 *
 * @param {object} event 待修事件。
 * @param {string} sessionId 会话 id。
 * @returns {object|null} 修复后的事件，或 null。
 */
export function repairEvent(event, sessionId) {
  if (validateEvent(event) === null) return null
  if (classifyIssue(event) !== 'auto') return null
  return applyDerivableFix(event, sessionId)
}

/**
 * 修复一段会话归档字节。
 *
 * 关键性质：只重新压缩「含坏事件的帧」，其余帧沿用原字节；修复结果先自证
 * （重新解码 + 逐事件复检），任一事件仍不通过就返回 ok=false，绝不产出可写字节。
 *
 * @param {Buffer} buf 原文件内容。
 * @param {object} [opts] 选项。
 * @param {string} [opts.sessionId] 会话 id（缺省用 header.id）。
 * @returns {{
 *   ok: boolean, changed: boolean, output: (Buffer|null),
 *   header: object|null, report: object[], remaining: object[],
 *   changedFrames: number[], eventCount: number, reason: (string|null),
 * }}
 */
export function repairBuffer(buf, opts = {}) {
  const decoded = decodeSession(buf)
  if (decoded.header === null) {
    return { ok: false, changed: false, output: null, header: null, report: [], remaining: [], changedFrames: [], eventCount: 0, reason: decoded.failReason ?? '头部不可解析' }
  }
  if (decoded.failReason) {
    return { ok: false, changed: false, output: null, header: decoded.header, report: [], remaining: [], changedFrames: [], eventCount: decoded.events.length, reason: decoded.failReason }
  }
  // 头部必须真的是一份会话头：第一帧是任意 JSON 都不算。
  // 没有 id 就没法派生消息 id，也没法让宿主按 id 找到它——修了也无意义。
  if (decoded.header?.type !== 'session' || !nonEmptyString(decoded.header?.id)) {
    return { ok: false, changed: false, output: null, header: decoded.header, report: [], remaining: [], changedFrames: [], eventCount: decoded.events.length, reason: '头部不是合法的会话头（缺 type="session" 或 id）' }
  }
  if (decoded.tornStart !== undefined) {
    return { ok: false, changed: false, output: null, header: decoded.header, report: [], remaining: [], changedFrames: [], eventCount: decoded.events.length, reason: `末尾有撕裂帧（偏移 ${decoded.tornStart}），先修撕裂再修内容` }
  }

  const sessionId = nonEmptyString(opts.sessionId) ? opts.sessionId : String(decoded.header.id)
  const frames = decoded.frames
  const rebuilt = [buf.subarray(frames[0].start, frames[0].end)]
  const report = []
  const changedFrames = []

  // 按帧聚合行文本：未变的行原样写回，只替换真正修过的那几行。
  const byFrame = new Map()
  for (const line of decoded.lines) {
    if (!byFrame.has(line.frame)) byFrame.set(line.frame, [])
    byFrame.get(line.frame).push(line)
  }

  for (let i = 1; i < frames.length; i += 1) {
    const lines = byFrame.get(i) ?? []
    let touched = false
    const nextTexts = lines.map((line) => {
      if (line.event === null) return line.text
      const fixed = repairEvent(line.event, sessionId)
      if (fixed === null) return line.text
      touched = true
      report.push({
        seq: line.event.seq,
        type: line.event.type,
        producer: producerOf(line.event),
        added: { id: nonEmptyString(line.event.data?.id) ? undefined : fixed.data.id, role: fixed.data.role },
      })
      return JSON.stringify(fixed)
    })

    if (!touched) {
      rebuilt.push(buf.subarray(frames[i].start, frames[i].end))
      continue
    }
    changedFrames.push(i)
    rebuilt.push(zstdCompressSync(Buffer.from(`${nextTexts.join('\n')}\n`), COMPRESS_OPTIONS))
  }

  const output = Buffer.concat(rebuilt)

  // —— 自证：解码新字节并逐事件复检 ——
  const check = decodeSession(output)
  const remaining = []
  if (check.failReason) remaining.push({ seq: null, type: '(文件)', reason: check.failReason, level: 'manual', producer: '(文件)' })
  for (const event of check.events) {
    const reason = validateEvent(event)
    if (reason === null) continue
    remaining.push({
      seq: event?.seq ?? null,
      type: String(event?.type ?? '?'),
      reason,
      level: classifyIssue(event),
      producer: producerOf(event),
    })
  }
  // 帧数与事件数必须与原件一致，否则视为结构被破坏。
  if (check.frames.length !== frames.length) {
    return { ok: false, changed: false, output: null, header: decoded.header, report, remaining, changedFrames, eventCount: decoded.events.length, reason: `帧数变化：${frames.length} → ${check.frames.length}` }
  }
  if (check.events.length !== decoded.events.length) {
    return { ok: false, changed: false, output: null, header: decoded.header, report, remaining, changedFrames, eventCount: decoded.events.length, reason: `事件数变化：${decoded.events.length} → ${check.events.length}` }
  }

  return {
    ok: remaining.length === 0,
    changed: changedFrames.length > 0,
    output: remaining.length === 0 && changedFrames.length > 0 ? output : null,
    header: decoded.header,
    report,
    remaining,
    changedFrames,
    eventCount: decoded.events.length,
    reason: remaining.length === 0 ? null : '修复后仍有事件不通过校验',
  }
}

// ————————————————————————————— 凭据擦除 —————————————————————————————

/**
 * 就地擦掉会话归档里已知前缀的凭据。
 *
 * 与 `repairBuffer` 同一套帧处理，但目标不同：修复是「补结构」，擦除是
 * 「换文本」。同样的纪律：
 *  - 只重写**真的含凭据**的那些行，其余字节原样搬回去；
 *  - 帧数、事件数、每行 JSON 结构必须与原件一致，否则拒绝产出；
 *  - 不碰事件语义字段（seq/type/data 结构），只换文本值里的密钥字面量。
 *
 * @param {Buffer} buf 文件内容。
 * @param {object} [opts] 选项：`redact`（文本 → 文本的函数，默认 redactSecrets）。
 * @returns {{
 *   ok: boolean, changed: boolean, output: (Buffer|null),
 *   header: object|null, changedFrames: number[], changedLines: number,
 *   hits: Array<{frame:number,seq:(number|null),type:(string|null),count:number}>,
 *   eventCount: number, reason: (string|null),
 * }}
 */
export function scrubBuffer(buf, opts = {}) {
  const redact = typeof opts.redact === 'function' ? opts.redact : redactSecrets
  const decoded = decodeSession(buf)
  if (decoded.header === null) {
    return { ok: false, changed: false, output: null, header: null, changedFrames: [], changedLines: 0, hits: [], eventCount: 0, reason: decoded.failReason ?? '头部不可解析' }
  }
  if (decoded.failReason) {
    return { ok: false, changed: false, output: null, header: decoded.header, changedFrames: [], changedLines: 0, hits: [], eventCount: decoded.events.length, reason: decoded.failReason }
  }
  if (decoded.tornStart !== undefined) {
    return { ok: false, changed: false, output: null, header: decoded.header, changedFrames: [], changedLines: 0, hits: [], eventCount: decoded.events.length, reason: `末尾有撕裂帧（偏移 ${decoded.tornStart}），先修撕裂再擦除` }
  }

  const frames = decoded.frames
  // 第 0 帧是文件头，也可能被写进过凭据（例如 cwd 里带密钥），一并过闸。
  const headRaw = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString('utf8')
  const headNext = redact(headRaw)
  const rebuilt = []
  const changedFrames = []
  const hits = []
  let changedLines = 0

  if (headNext !== headRaw) {
    changedFrames.push(0)
    rebuilt.push(zstdCompressSync(Buffer.from(headNext), COMPRESS_OPTIONS))
    hits.push({ frame: 0, seq: null, type: '(header)', count: 1 })
  } else {
    rebuilt.push(buf.subarray(frames[0].start, frames[0].end))
  }

  const byFrame = new Map()
  for (const line of decoded.lines) {
    if (!byFrame.has(line.frame)) byFrame.set(line.frame, [])
    byFrame.get(line.frame).push(line)
  }

  for (let i = 1; i < frames.length; i += 1) {
    const lines = byFrame.get(i) ?? []
    let touched = false
    const nextTexts = lines.map((line) => {
      const next = redact(line.text)
      if (next === line.text) return line.text
      touched = true
      changedLines += 1
      hits.push({
        frame: i,
        seq: typeof line.event?.seq === 'number' ? line.event.seq : null,
        type: line.event === null ? null : String(line.event.type ?? '?'),
        count: 1,
      })
      // 换完文本必须仍能解析成同一形状的事件，否则不改这一行。
      try {
        const a = JSON.parse(line.text)
        const b = JSON.parse(next)
        if (typeof b !== 'object' || b === null || a?.seq !== b?.seq || a?.type !== b?.type) {
          changedLines -= 1
          hits.pop()
          return line.text
        }
      } catch {
        changedLines -= 1
        hits.pop()
        return line.text
      }
      return next
    })

    if (!touched) {
      rebuilt.push(buf.subarray(frames[i].start, frames[i].end))
      continue
    }
    changedFrames.push(i)
    rebuilt.push(zstdCompressSync(Buffer.from(`${nextTexts.join('\n')}\n`), COMPRESS_OPTIONS))
  }

  const output = Buffer.concat(rebuilt)

  // —— 自证 ——
  const check = decodeSession(output)
  if (check.failReason) {
    return { ok: false, changed: false, output: null, header: decoded.header, changedFrames, changedLines: 0, hits, eventCount: decoded.events.length, reason: `擦除后不可解码：${check.failReason}` }
  }
  if (check.frames.length !== frames.length) {
    return { ok: false, changed: false, output: null, header: decoded.header, changedFrames, changedLines: 0, hits, eventCount: decoded.events.length, reason: `帧数变化：${frames.length} → ${check.frames.length}` }
  }
  if (check.events.length !== decoded.events.length) {
    return { ok: false, changed: false, output: null, header: decoded.header, changedFrames, changedLines: 0, hits, eventCount: decoded.events.length, reason: `事件数变化：${decoded.events.length} → ${check.events.length}` }
  }

  return {
    ok: true,
    changed: changedFrames.length > 0,
    output: changedFrames.length > 0 ? output : null,
    header: decoded.header,
    changedFrames,
    changedLines,
    hits,
    eventCount: decoded.events.length,
    reason: null,
  }
}

// ————————————————————————————— 文件级操作 —————————————————————————————

/**
 * 修复一个会话归档文件。
 *
 * 安全措施（缺一不可）：
 *  1. 默认 dry-run，`apply` 为真才写；
 *  2. 写前复查文件 size+mtime 与读取时一致，变了就中止（避免覆盖并发追加）；
 *  3. 先写 `.bak` 备份；
 *  4. 临时文件 + rename 落盘；
 *  5. 若提供 `verifyHost`，修复后由宿主真实读取复验；失败则自动回滚。
 *
 * @param {string} file 归档路径。
 * @param {object} opts 选项：`apply`、`sessionId`、`verifyHost`、`keepBackup`。
 * @returns {Promise<object>} 修复结果（含 before / after 诊断）。
 */
export async function repairFile(file, opts = {}) {
  const before0 = statSync(file)
  const buf = readFileSync(file)
  // 注意：只有「真的给了 sessionId」才传下去。
  // 传空串会覆盖掉从文件头读出的真实 id，导致同一份日志经
  // repairBuffer 与 repairFile 两个入口派生出不同的消息 id（幂等性被破坏）。
  const explicitId = typeof opts.sessionId === 'string' && opts.sessionId !== '' ? opts.sessionId : undefined
  const before = diagnoseBuffer(buf, explicitId === undefined ? {} : { sessionId: explicitId })
  const plan = repairBuffer(buf, explicitId === undefined ? {} : { sessionId: explicitId })

  const result = {
    file,
    sessionId: before.sessionId,
    before,
    plan: { ok: plan.ok, changed: plan.changed, report: plan.report, remaining: plan.remaining, reason: plan.reason },
    applied: false,
    projected: false,
    backup: null,
    rolledBack: false,
    hostVerify: null,
    after: null,
  }

  if (!plan.ok || plan.output === null) return result

  // dry-run：把「修完会是什么样」也算出来，界面不必先落盘才知道结果。
  if (opts.apply !== true) {
    result.after = diagnoseBuffer(plan.output, explicitId === undefined ? {} : { sessionId: explicitId })
    result.projected = true
    return result
  }

  // 并发保护：读取后文件被动过就放弃，避免把别人的追加覆盖掉。
  const before1 = statSync(file)
  if (before1.size !== before0.size || before1.mtimeMs !== before0.mtimeMs) {
    return { ...result, plan: { ...result.plan, ok: false, reason: '文件在读取后发生变化（可能有并发写入），已中止' } }
  }

  let backup = null
  if (opts.keepBackup !== false) {
    backup = `${file}.pre-repair-${Date.now()}.bak`
    copyFileSync(file, backup)
  }
  const tmp = `${file}.repair-${process.pid}.tmp`
  try {
    writeFileSync(tmp, plan.output, { mode: before0.mode & 0o777 })
    renameSync(tmp, file)
    result.applied = true
    result.backup = backup
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 已不存在 */ }
    return { ...result, plan: { ...result.plan, ok: false, reason: `写入失败：${error?.message ?? String(error)}` } }
  }

  // 宿主复验：让真正要读这份日志的那套代码去读。
  //
  // 只有「宿主读到了内容、并判定内容非法」才算修复失败 → 回滚。
  // 「找不到会话」「服务不可用」这类是环境/路由问题，不能作为回滚依据：
  // 那会把一次本来正确的修复白白撤掉。这类记为 inconclusive，如实上报。
  if (typeof opts.verifyHost === 'function') {
    try {
      const detail = await opts.verifyHost(result.sessionId)
      if (detail === null || detail === undefined) {
        result.hostVerify = { ok: null, status: 'unavailable', detail: '宿主未提供 sessionPersistence，已改用内置校验' }
      } else {
        result.hostVerify = { ok: true, status: 'verified', detail }
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      const contentRejected = /failed validation|is corrupt|stored log is corrupt|lacks an identified message|unsupported/i.test(message)
      if (contentRejected) {
        result.hostVerify = { ok: false, status: 'rejected', detail: message }
        if (backup !== null) {
          try {
            copyFileSync(backup, file)
            result.rolledBack = true
            result.applied = false
          } catch { /* 回滚失败：备份路径仍在，交由人工 */ }
        }
      } else {
        result.hostVerify = { ok: null, status: 'inconclusive', detail: message }
      }
    }
  }

  result.after = result.rolledBack ? before : diagnoseBuffer(readFileSync(file), explicitId === undefined ? {} : { sessionId: explicitId })
  return result
}

// ————————————————————————————— 批量扫描 —————————————————————————————

/**
 * 扫描会话根目录下的所有归档并诊断。
 *
 * 只读，不修复。用于「一键体检」与自测。
 *
 * @param {string} root 会话根（默认 <DSH_HOME>/sessions）。
 * @param {object} [opts] 选项：`limit`、`onEach`（每条回调）。
 * @returns {Promise<{scanned: number, broken: object[], results: object[]}>}
 */
/**
 * 扫描会话根目录下的所有归档并诊断。
 *
 * 只读，不修复。供 CLI 的 `repair` 与自测使用。
 *
 * @param {string} root 会话根（默认 <DSH_HOME>/sessions）。
 * @param {object} [opts] 选项：`limit`、`onEach`（每条回调）。
 * @returns {Promise<{scanned: number, broken: object[], results: object[]}>}
 *   `broken` 只含诊断不通过的；每条都带 `repairable`（能否自动修复）。
 */
export async function scanRoot(root, opts = {}) {
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const results = []
  const broken = []
  let scanned = 0
  let projects = []
  try { projects = await readdir(root) } catch { return { scanned, broken, results } }

  for (const project of projects) {
    let ids = []
    try { ids = await readdir(join(root, project)) } catch { continue }
    for (const id of ids) {
      const file = join(root, project, id, 'session.v4.jsonl.zstd')
      let buf
      try { buf = readFileSync(file) } catch { continue }
      scanned += 1
      let report
      try {
        report = diagnoseBuffer(buf, {})
      } catch (error) {
        report = {
          sessionId: id, ok: false, eventCount: 0,
          issues: [{ seq: null, type: '(文件)', reason: String(error?.message ?? error), level: 'manual', producer: '(文件)' }],
          autoCount: 0, manualCount: 1, producers: { '(文件)': 1 }, repairable: false,
        }
      }
      // repairable 必须带上：调用方（CLI / 界面）都靠它决定「能不能自动修」，
      // 漏掉会让每个可修的会话都被误报成「需人工」。
      const row = {
        file, project, session: report.sessionId,
        ok: report.ok, repairable: report.repairable === true,
        issueCount: report.issues.length,
        autoCount: report.autoCount, manualCount: report.manualCount,
        producers: report.producers, issues: report.issues,
      }
      results.push(row)
      if (!report.ok) broken.push(row)
      if (typeof opts.onEach === 'function') opts.onEach(row)
      if (opts.limit !== undefined && scanned >= opts.limit) return { scanned, broken, results }
    }
  }
  return { scanned, broken, results }
}
