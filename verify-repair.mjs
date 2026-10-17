#!/usr/bin/env node
/**
 * dsh-task-journal / 会话修复 自测。
 *
 *   node verify-repair.mjs
 *
 * 不依赖 DSH 宿主，也不依赖真实会话数据：在临时目录里**自己造**会话归档
 * （含各种坏法），跑完整条流水线，断言：
 *   - 诊断能认出坏在哪、谁写的、能否自动修；
 *   - 修复只补 role/id，其它字节不动；
 *   - 修复后内置校验通过；
 *   - 幂等（再修一次字节完全一致）；
 *   - 宿主复验被拒时自动回滚；
 *   - API 四步（scan / fix / fix-all / verify）串得起来；
 *   - 活跃会话被跳过；未登记路径被拒绝。
 *
 * 这是「修得快」的前提：回归一跑就知道规则还在不在，不用等真实事故。
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'
import {
  decodeSession, diagnoseBuffer, repairBuffer, repairFile, validateEvent,
  classifyIssue, derivedMessageId, scanZstdFrames, scrubBuffer,
} from './lib/session-repair.js'
import { apply } from './lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

const OPTS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
/** 与宿主一致：一个 frame 一段 JSONL（含末尾换行）。 */
const frame = (text) => zstdCompressSync(Buffer.from(text), OPTS)
const headerLine = (id, cwd) => `${JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd, isSeeded: false })}\n`

/** 规范形状的 user/message（参考宿主 README 的写法）。 */
const goodUser = (seq, text) => ({
  type: 'user/message', seq, time: 1000 + seq, surfaceOp: 'append',
  data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `id-good-${seq}` },
})
/** 插件通知的坏形状：缺 role 与 id（这正是线上事故的样子）。 */
const badNotice = (seq, text, kind = 'dsh-task-journal') => ({
  type: 'user/message', seq, time: 1000 + seq, surfaceOp: 'append',
  data: { content: [{ type: 'text', text }], source: { kind, form: 'notice', summary: text } },
})
/** 坏形状但 source 也没了：只能人工处理。 */
const badNoSource = (seq) => ({
  type: 'user/message', seq, time: 1000 + seq, surfaceOp: 'append',
  data: { content: [{ type: 'text', text: 'x' }] },
})

/** 组装一个会话归档。 */
function buildLog(id, events, cwd = '/tmp/proj') {
  const frames = [frame(headerLine(id, cwd))]
  for (const e of events) frames.push(frame(`${JSON.stringify(e)}\n`))
  return Buffer.concat(frames)
}

/**
 * 最小假 ctx：捕获 webServer 处理器与注册的工具，
 * 并记住 session/event 订阅——这样测试可以「喂」一个事件，把会话标记成活跃。
 */
function fakeCtx() {
  const tools = []
  const handlers = []
  let handler = null
  return {
    logger: { info() {}, warn() {} },
    on(type, fn) { handlers.push([type, fn]); return () => {} },
    effect(fn) { return fn() },
    get() { return undefined },
    inject(services, cb) {
      if (services.includes('tools')) cb({ tools: { register: (t) => tools.push(t) } })
      if (services.includes('webServer')) {
        cb({
          webServer: { register: ({ handler: h2 }) => { handler = h2; return () => {} } },
          effect: (f) => f(),
        })
      }
    },
    /** 触发一次会话事件，让插件为该会话建 writer（= 标记为活跃）。 */
    emit(session, event) { for (const [t, fn] of handlers) if (t === 'session/event') fn(session, event) },
    _tools: tools,
    _handler: () => handler,
  }
}

/** 极简 req/res，够 handler 用。 */
function call(handler, method, path, body) {
  return new Promise((done) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      url: path, method,
      on(ev, fn) { if (ev === 'data') for (const c of chunks) fn(c); if (ev === 'end') fn(); return this },
      destroy() {},
    }
    const res = {
      status: 0, body: null,
      writeHead(s) { this.status = s },
      end(b) { try { this.body = JSON.parse(b) } catch { this.body = b }; done(this) },
    }
    handler(req, res)
  })
}

const main = async () => {
  // 故意放在 HOME 下：这样「路径遮蔽」才是可验证的（遮蔽只处理 HOME 前缀）。
  const root = await mkdtemp(join(homedir(), '.dsh-journal-repair-test-'))
  const project = '--tmp-proj--'
  const badId = 'session-bad-1'
  const okId = 'session-ok-1'
  const manualId = 'session-manual-1'
  const liveId = 'session-live-1'

  await mkdir(join(root, project, badId), { recursive: true })
  await mkdir(join(root, project, okId), { recursive: true })
  await mkdir(join(root, project, manualId), { recursive: true })
  await mkdir(join(root, project, liveId), { recursive: true })

  // 1) 可自动修复：两个坏 notice（来自不同插件）
  const badLog = buildLog(badId, [
    goodUser(0, '真实提问'),
    badNotice(1, '任务未完成', 'dsh-task-journal'),
    badNotice(2, '自动续跑已达上限', 'dsh-continue'),
    goodUser(3, '再问一句'),
  ])
  await writeFile(join(root, project, badId, 'session.v4.jsonl.zstd'), badLog)

  // 2) 完好
  await writeFile(join(root, project, okId, 'session.v4.jsonl.zstd'),
    buildLog(okId, [goodUser(0, 'hi'), goodUser(1, 'ok')]))

  // 3) 需人工：缺 source，无法推导
  await writeFile(join(root, project, manualId, 'session.v4.jsonl.zstd'),
    buildLog(manualId, [goodUser(0, 'hi'), badNoSource(1)]))

  // 4) 活跃会话（迁移期插件会把它标记为 live）
  await writeFile(join(root, project, liveId, 'session.v4.jsonl.zstd'),
    buildLog(liveId, [badNotice(0, '活跃会话的通知')]))

  console.log(`临时会话根：${root}\n`)

  // ————————————— 一、底层：帧扫描与解码 —————————————
  console.log('一、帧扫描与解码')
  const frames = scanZstdFrames(badLog)
  ok(frames.frames.length === 5, `按帧结构切出 ${frames.frames.length} 帧（1 头 + 4 事件）`)
  ok(frames.tornStart === undefined, '没有撕裂帧')
  const decoded = decodeSession(badLog)
  ok(decoded.header?.id === badId, '解出会话头')
  ok(decoded.events.length === 4, '解出 4 个事件')

  // ————————————— 二、诊断 —————————————
  console.log('\n二、诊断')
  const diag = diagnoseBuffer(badLog)
  ok(diag.ok === false, '认出破损')
  ok(diag.issues.length === 2, `2 处问题（实际 ${diag.issues.length}）`)
  ok(diag.autoCount === 2 && diag.manualCount === 0, '全部可自动修复')
  ok(diag.repairable === true, 'repairable=true')
  ok(diag.producers['dsh-task-journal'] === 1 && diag.producers['dsh-continue'] === 1, '归因到两个插件')
  ok(diag.issues[0].reason.includes('缺少 id'), '原因说明是「缺少 id」')

  const okDiag = diagnoseBuffer(buildLog(okId, [goodUser(0, 'x')]))
  ok(okDiag.ok === true, '完好日志诊断通过')

  const manualDiag = diagnoseBuffer(buildLog(manualId, [goodUser(0, 'x'), badNoSource(1)]))
  ok(manualDiag.repairable === false, '缺 source 的归为需人工')
  ok(manualDiag.manualCount === 1, '需人工计数为 1')

  // ————————————— 三、修复的最小性与正确性 —————————————
  console.log('\n三、修复')
  const plan = repairBuffer(badLog)
  ok(plan.ok === true, '修复计划通过')
  ok(plan.changed === true, '标记为有改动')
  ok(plan.report.length === 2, `改了 2 处（实际 ${plan.report.length}）`)
  ok(plan.report[0].added.role === 'user', '补的 role 是 user')
  ok(typeof plan.report[0].added.id === 'string' && plan.report[0].added.id.length === 36, '补的 id 是 UUID 形状')

  const after = decodeSession(plan.output)
  ok(after.events.length === decoded.events.length, '事件数不变')
  ok(after.frames.length === decoded.frames.length, '帧数不变')
  ok(after.header.id === badId, '会话头不变')

  // 逐行对比：只有坏行变，其他行逐字节相同
  const changedLines = []
  for (let i = 0; i < decoded.lines.length; i += 1) {
    if (decoded.lines[i].text !== after.lines[i].text) changedLines.push(i)
  }
  ok(changedLines.length === 2, `只有 2 行变化（实际 ${changedLines.length}）`)
  ok(decoded.lines[0].text === after.lines[0].text, '第 1 行（正常 user/message）逐字节未变')

  // 语义：只多了 id/role
  const beforeMsg = decoded.lines[1].event.data
  const afterMsg = after.lines[1].event.data
  ok(JSON.stringify(beforeMsg.content) === JSON.stringify(afterMsg.content), 'content 未改')
  ok(JSON.stringify(beforeMsg.source) === JSON.stringify(afterMsg.source), 'source 未改')
  ok(decoded.lines[1].event.seq === after.lines[1].event.seq
    && decoded.lines[1].event.time === after.lines[1].event.time, 'seq/time 未改')
  ok(after.lines[1].event.surfaceOp === 'append', 'surfaceOp 未改')

  // 修复后校验通过
  ok(after.events.every((e) => validateEvent(e) === null), '修复后所有事件通过内置校验')
  ok(diagnoseBuffer(plan.output).ok === true, '修复后诊断通过')

  // ————————————— 四、幂等 —————————————
  console.log('\n四、幂等')
  const again = repairBuffer(plan.output)
  ok(again.changed === false, '再修一次：无需改动')
  ok(again.output === null, '再修一次：不产出新字节')
  ok(plan.output.equals(repairBuffer(badLog).output), '同一输入两次修复字节一致')

  const idA = derivedMessageId('s', 7)
  const idB = derivedMessageId('s', 7)
  ok(idA === idB, 'id 派生是确定性的')
  ok(derivedMessageId('s', 8) !== idA, '不同 seq 派生不同 id')
  ok(derivedMessageId('t', 7) !== idA, '不同会话派生不同 id')

  // ————————————— 五、校验与分级的边界 —————————————
  console.log('\n五、校验与分级')
  ok(validateEvent(goodUser(0, 'x')) === null, '正常 user/message 通过')
  ok(validateEvent({ type: 'user/message', seq: 0, time: 1, data: { content: [], source: { kind: 'user' } } }) !== null, '缺 id 被拒')
  ok(validateEvent({ type: 'user/message', seq: 0, time: 1, data: { content: [], source: { kind: 'user' }, role: 'assistant', id: 'x' } }) !== null, '角色错被拒')
  const asstWrong = { type: 'assistant/message', seq: 0, time: 1, data: { message: { role: 'assistant', content: [], source: { kind: 'model' }, id: 'x' } } }
  ok(validateEvent(asstWrong) !== null, 'assistant 缺 provider/model 被拒')
  const toolMismatch = { type: 'tool/result', seq: 0, time: 1, data: { message: { role: 'tool', content: [], source: { kind: 'tool', callId: 'a' }, toolCallId: 'b', id: 'x' } } }
  ok(validateEvent(toolMismatch) !== null, 'toolCallId 不一致被拒')
  ok(validateEvent({ type: 'request/header', seq: 0, time: 1, data: { header: { system: 'x' } } }) !== null, 'header.system 被拒')
  ok(validateEvent({ type: 'request/header', seq: 0, time: 1, data: { header: { tools: [] } } }) !== null, '空 tools 被拒')
  ok(validateEvent({ type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } }) === null, '无关事件类型直接通过')

  ok(classifyIssue(badNotice(0, 'x')) === 'auto', '缺 role/id → auto')
  ok(classifyIssue(badNoSource(0)) === 'manual', 'source 非法 → manual')
  ok(classifyIssue({ type: 'user/message', seq: 0, time: 1, data: { message: null } }) === 'manual', '结构缺失 → manual')
  // 关键回归：同时缺 id 与 source 时，不能因为「先报缺少 id」就误判成可自动修
  ok(classifyIssue({ type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'x' }] } }) === 'manual',
    '缺 id 且缺 source → manual（不按首个错误文案误判）')
  ok(classifyIssue({ type: 'user/message', seq: 0, time: 1, data: { content: 'not-array', source: { kind: 'user' }, role: 'user', id: 'x' } }) === 'manual',
    'content 非数组 → manual')

  // ————————————— 六、拒绝不该碰的东西 —————————————
  console.log('\n六、保守拒绝')
  const noHeader = frame('{"not":"a session header"}\n')
  ok(repairBuffer(noHeader).ok === false, '头部不是会话头 → 拒绝')
  const torn = Buffer.concat([headerLine('s', '/tmp').length ? frame(headerLine('s', '/tmp')) : Buffer.alloc(0),
    frame(`${JSON.stringify(badNotice(0, 'x'))}\n`), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])])
  const tornR = repairBuffer(torn)
  ok(tornR.ok === false, '末尾撕裂帧 → 拒绝（提示先修撕裂）')

  // ————————————— 七、文件级：备份、回滚、并发保护 —————————————
  console.log('\n七、文件级修复')
  const file = join(root, project, badId, 'session.v4.jsonl.zstd')
  const dry = await repairFile(file, { apply: false })
  ok(dry.applied === false, 'dry-run 不落盘')
  ok(dry.projected === true, 'dry-run 给出预期结果')
  ok(dry.after?.ok === true, 'dry-run 的预期结果是「修好」')
  ok(Buffer.from(await readFile(file)).equals(badLog), 'dry-run 后文件未变')

  const applied = await repairFile(file, { apply: true })
  ok(applied.applied === true, 'apply 落盘')
  ok(applied.backup !== null && existsSync(applied.backup), '生成了备份文件')
  ok(Buffer.from(await readFile(applied.backup)).equals(badLog), '备份内容 = 修复前原件')
  const nowBuf = Buffer.from(await readFile(file))
  ok(diagnoseBuffer(nowBuf).ok === true, '落盘后的文件诊断通过')
  ok(nowBuf.equals(plan.output), '落盘内容 = 计划内容')

  ok((await repairFile(file, { apply: true })).applied === false, '已修好的文件再修：不重复落盘')

  // 宿主复验被拒 → 自动回滚
  const file2 = join(root, project, manualId, 'session.v4.jsonl.zstd')
  await writeFile(file2, buildLog(manualId, [goodUser(0, 'x'), badNotice(1, 'y')]))
  const beforeRollback = Buffer.from(await readFile(file2))
  const rejected = await repairFile(file2, {
    apply: true,
    verifyHost: async () => { throw new Error('stored session "x" failed validation: still broken') },
  })
  ok(rejected.hostVerify?.ok === false, '宿主拒绝被记录')
  ok(rejected.rolledBack === true, '自动回滚')
  ok(rejected.applied === false, '回滚后不算已落盘')
  ok(Buffer.from(await readFile(file2)).equals(beforeRollback), '文件已恢复到修复前')

  // 环境类错误（找不到会话）不应回滚
  await writeFile(file2, buildLog(manualId, [goodUser(0, 'x'), badNotice(1, 'y')]))
  const inconclusive = await repairFile(file2, {
    apply: true,
    verifyHost: async () => { throw new Error('session "x" not found') },
  })
  ok(inconclusive.applied === true, '「找不到会话」不回滚（环境问题，不是内容问题）')
  ok(inconclusive.hostVerify?.status === 'inconclusive', '记为 inconclusive')

  // ————————————— 八、API 四步流水线 —————————————
  console.log('\n八、API 流水线（scan → fix → verify）')
  process.env.DSH_SESSIONS_DIR = root
  // 重新造一份坏的给 API 用
  await writeFile(join(root, project, badId, 'session.v4.jsonl.zstd'), badLog)
  // 第 7 节把 manualId 的文件改成了「可自动修复」并已修好，这里恢复成「需人工」那一版
  await writeFile(join(root, project, manualId, 'session.v4.jsonl.zstd'),
    buildLog(manualId, [goodUser(0, 'hi'), badNoSource(1)]))
  const ctx = fakeCtx()
  apply(ctx, { enabled: true })
  await new Promise((r) => setTimeout(r, 50))
  const handler = ctx._handler()
  ok(typeof handler === 'function', 'API handler 已注册')
  ok(ctx._tools.some((t) => t.name === 'session_repair'), 'session_repair 工具已注册')
  ok(ctx._tools.some((t) => t.name === 'journal_retry'), '原有工具未受影响')
  // 把一个会话「跑起来」：喂一条事件，插件就会为它建 writer → 视为活跃
  ctx.emit({ id: liveId, header: { cwd: root } },
    { type: 'step/start', seq: 0, time: Date.now(), data: { turn: 1, step: 1 } })

  const scan = await call(handler, 'GET', '/api/dsh-journal/repair/scan?force=1')
  ok(scan.status === 200, '① scan 200')
  ok(scan.body.scanned === 4, `扫到 4 个会话（实际 ${scan.body.scanned}）`)
  ok(scan.body.broken === 3, `破损 3 个（实际 ${scan.body.broken}）`)
  ok(scan.body.autoFixable === 1, `可立即自动修复 1 个（活跃那个不算，实际 ${scan.body.autoFixable}）`)
  ok(scan.body.manualOnly === 1, `需人工 1 个（实际 ${scan.body.manualOnly}）`)
  ok(scan.body.liveBroken === 1, `运行中（本轮跳过）1 个（实际 ${scan.body.liveBroken}）`)
  ok(scan.body.results.every((r) => typeof r.session === 'string'), '每个结果带 session id')
  // 遮蔽：测试根就在 HOME 下，所以「不出现 HOME 字面量」是真检查
  const homeDir = homedir()
  ok(root.startsWith(homeDir), '前置条件：测试根位于 HOME 之下（遮蔽才可验证）')
  ok(!JSON.stringify(scan.body).includes(homeDir), '对外字段不含本机 HOME 前缀')
  ok(JSON.stringify(scan.body).includes('~'), '路径以 ~ 遮蔽形式出现')

  // 先试运行，再落盘
  const dryApi = await call(handler, 'POST', '/api/dsh-journal/repair/fix', { session: badId })
  ok(dryApi.body.applied === false && dryApi.body.projected === true, '② 试运行：不落盘但给出结果')
  const fixApi = await call(handler, 'POST', '/api/dsh-journal/repair/fix', { session: badId, apply: true })
  ok(fixApi.body.applied === true, '③ 修复落盘')
  ok(fixApi.body.changed === 2, `改动 2 处（实际 ${fixApi.body.changed}）`)
  ok(fixApi.body.after?.ok === true, '修复后校验通过')
  ok(fixApi.body.backup !== null, '响应里带备份路径')

  const verify = await call(handler, 'GET', '/api/dsh-journal/repair/verify')
  ok(verify.body.ok === false, '④ 复验：仍有需人工的会话 → 不通过')
  ok(verify.body.broken === 2, `剩下 2 个（需人工 1 + 活跃 1，实际 ${verify.body.broken}）`)
  ok(verify.body.manualOnly === 1, `其中 1 个标记为需人工（实际 ${verify.body.manualOnly}）`)
  ok(verify.body.liveBroken === 1, `其中 1 个是运行中跳过（实际 ${verify.body.liveBroken}）`)

  // 活跃会话被跳过
  const liveFix = await call(handler, 'POST', '/api/dsh-journal/repair/fix', { session: liveId, apply: true })
  ok(liveFix.body.skippedLive === true, '活跃会话被跳过')

  // 未登记路径被拒
  const evil = await call(handler, 'POST', '/api/dsh-journal/repair/fix', { file: '/etc/passwd', apply: true })
  ok(evil.body.applied !== true, '未登记路径被拒')

  // 批量：只应处理剩下的可自动修复项（此处无），且不碰需人工的
  const all = await call(handler, 'POST', '/api/dsh-journal/repair/fix-all', { apply: true, force: true })
  ok(all.status === 200, 'fix-all 返回 200')
  ok(all.body.attempted === 0, `无需再自动修复的（实际 ${all.body.attempted}）`)
  ok(all.body.verify !== null, 'fix-all 自带复验')

  const info = await call(handler, 'GET', '/api/dsh-journal/repair/nope')
  ok(info.status === 404, '未知修复接口 → 404')

  // ————————————— 九、凭据擦除 —————————————
  console.log('\n九、凭据擦除（scrubBuffer）')
  const leaked = 'ghp' + '_' + 'f'.repeat(36)
  const cleanId = 'clean-1'
  // 三帧：一个干净事件、一个带凭据的事件、一个干净事件。
  const scrubBuf = Buffer.concat([
    frame(headerLine(cleanId, '/tmp/x')),
    frame(`${JSON.stringify(goodUser(0, '普通任务'))}\n`),
    frame(`${JSON.stringify(goodUser(1, `我的 token 是 ${leaked} ，帮我配`))}\n`),
    frame(`${JSON.stringify(goodUser(2, '收尾'))}\n`),
  ])
  const sres = scrubBuffer(scrubBuf)
  ok(sres.ok === true, '擦除成功')
  ok(sres.changed === true, '报告有改动')
  ok(sres.changedLines === 1, `只重写了含凭据的 1 行（实际 ${sres.changedLines}）`)
  ok(sres.hits.length === 1 && sres.hits[0].seq === 1, '命中定位到 seq 1')
  ok(sres.eventCount === 3, '事件数仍为 3')
  const sdec = decodeSession(sres.output)
  ok(sdec.failReason === null, '擦除后可正常解码')
  ok(sdec.events.length === 3, '擦除后仍是 3 个事件')
  // 帧序：0 是头，1/2/3 是 seq 0/1/2 的事件。凭据在 seq 1，即第 2 帧。
  const sOutFrames = scanZstdFrames(sres.output).frames
  const sText = zstdDecompressSync(sres.output.subarray(
    sOutFrames[2].start, sOutFrames[2].end)).toString('utf8')
  ok(!sText.includes(leaked), '第 2 帧里没有明文凭据')
  ok(sText.includes('<redacted:github-pat>'), '第 2 帧留下遮蔽标记')
  ok(JSON.parse(sText).data.content[0].text.includes('帮我配'), '其余原文保留')
  // 帧级最小性：没含凭据的帧必须逐字节不变。
  const sframes = scanZstdFrames(scrubBuf).frames
  const sout = scanZstdFrames(sres.output).frames
  const same = (a, b) => scrubBuf.subarray(a.start, a.end).equals(sres.output.subarray(b.start, b.end))
  ok(same(sframes[0], sout[0]), '第 0 帧（头）逐字节未变')
  ok(!same(sframes[2], sout[2]), '第 2 帧（含凭据）被重写')
  ok(same(sframes[1], sout[1]) && same(sframes[3], sout[3]), '干净帧逐字节未变')
  // 幂等：再擦一次不该有改动。
  const sres2 = scrubBuffer(sres.output)
  ok(sres2.ok === true && sres2.changed === false, '再擦一次无改动（幂等）')
  // 干净文件不产出新字节。
  const cleanBuf = Buffer.concat([
    frame(headerLine('clean-2', '/tmp/x')),
    frame(`${JSON.stringify(goodUser(0, '干净'))}\n`),
  ])
  const cres = scrubBuffer(cleanBuf)
  ok(cres.ok === true && cres.changed === false && cres.output === null, '干净文件不产出新字节')
  // 头部带凭据也要擦。
  const headLeak = Buffer.concat([
    frame(headerLine('clean-3', `/tmp/${leaked}`)),
    frame(`${JSON.stringify(goodUser(0, 'x'))}\n`),
  ])
  const hres = scrubBuffer(headLeak)
  ok(hres.ok === true && hres.changedFrames.includes(0), '头部帧里的凭据也被擦除')

  // ————————————— 十、工具入口 —————————————
  console.log('\n十、session_repair 工具')
  const tool = ctx._tools.find((t) => t.name === 'session_repair')
  const exec = { agent: { session: { id: 'x', header: { cwd: root } } } }
  const rScan = await tool.execute({ action: 'scan' }, exec)
  ok(rScan.ok === false, 'scan 报告仍有破损')
  ok(typeof rScan.message === 'string' && rScan.message.includes('扫描'), 'scan 输出可读摘要')
  const rVerify = await tool.execute({ action: 'verify' }, exec)
  ok(typeof rVerify.message === 'string', 'verify 输出可读摘要')
  const rFix = await tool.execute({ action: 'fix', session: liveId }, exec)
  ok(rFix.message.includes('跳过'), 'fix 对活跃会话给出跳过说明')
  const rBad = await tool.execute({ action: 'fix' }, exec)
  ok(rBad.ok === false && rBad.message.includes('session'), 'fix 缺参时给出指引')

  // ————————————— 清理 —————————————
  await rm(root, { recursive: true, force: true })

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('\n自测自身异常：', e)
  process.exit(1)
})
