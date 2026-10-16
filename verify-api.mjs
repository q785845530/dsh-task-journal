#!/usr/bin/env node
/**
 * dsh-task-journal 界面 API 自测。
 *
 *   node verify-api.mjs
 *
 * 起一个临时 HTTP 服务挂上 /api/dsh-journal/*，造一份日志数据，
 * 逐个接口请求并断言返回。
 */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

/** 从插件模块里取出 API handler 工厂（通过 apply 捕获）。 */
async function loadHandler() {
  const mod = await import('./lib/index.js')
  const handlers = []
  const registrations = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on: () => () => {},
    effect: (f) => f(),
    inject: (services, cb) => {
      if (services.includes('webServer')) {
        cb({
          effect: (f) => f(),
          webServer: {
            register({ kind, path, handler }) {
              registrations.push({ kind, path })
              handlers.push(handler)
              return () => {}
            },
          },
        })
      }
      if (services.includes('tools')) cb({ tools: { register() {} } })
      if (services.includes('agents')) cb({ on: () => () => {} })
    },
    agents: { get: () => undefined },
  }
  mod.apply(ctx, { enabled: true, dir: process.env.DTJ_DIR ?? '', notifyOnFailure: false })
  return { handler: handlers[0], registrations, mod }
}

const main = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-journal-api-'))
  const base = join(root, '.dsh-journal')
  await mkdir(base, { recursive: true })
  const sid = 'api-test-7'

  await writeFile(join(base, `journal-${sid}.md`),
    `# 任务日志\n\n- 会话：\`${sid}\`\n\n---\n## 任务 1｜2026-01-01 00:00:00\n\n写插件\n`, 'utf8')
  await writeFile(join(base, `tasks-${sid}.md`),
    `# 任务清单\n\n- 会话：\`${sid}\`\n\n---\n- [x] [\`T1\`] 2026-01-01 00:00:00｜写插件\n- [ ] [\`T2\`] 2026-01-01 00:01:00｜写文档\n`, 'utf8')
  await writeFile(join(base, `failures-${sid}.md`),
    `# 未完成的任务与问题\n\n---\n\n## F1｜任务 T2｜2026-01-01 00:02:00\n\n- 原因：限流 [QUOTA_EXCEEDED]\n`, 'utf8')
  await writeFile(join(base, `models-${sid}.md`),
    `# 模型与参数记录\n\n---\n- 2026-01-01 00:00:00｜provider=p model=m reasoning=high maxTokens=128000\n`, 'utf8')
  await writeFile(join(base, `events-${sid}.jsonl`), `{"type":"task"}\n`, 'utf8')

  process.env.DTJ_DIR = base
  const { handler, registrations } = await loadHandler()

  ok(registrations.some((r) => r.path === '/api/dsh-journal' && r.kind === 'prefix'),
    '注册了 /api/dsh-journal 前缀路由')

  const server = createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const url = (p) => `http://127.0.0.1:${port}/api/dsh-journal${p}`

  const get = async (p) => {
    const r = await fetch(url(p))
    return { status: r.status, body: await r.json() }
  }
  const post = async (p, body) => {
    const r = await fetch(url(p), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: r.status, body: await r.json() }
  }

  console.log(`临时目录：${root}\n`)

  // —— sessions ——
  console.log('用例 1：GET /sessions')
  const s = await get(`/sessions?cwd=${encodeURIComponent(root)}`)
  ok(s.status === 200, 'HTTP 200')
  ok(Array.isArray(s.body.sessions) && s.body.sessions.length >= 1, '列出至少 1 个会话')
  ok(s.body.sessions[0].session === sid, '会话 id 正确')
  ok(s.body.sessions[0].kinds.length === 5, '识别出 5 类文件')

  // —— summary ——
  console.log('\n用例 2：GET /summary')
  const sum = await get(`/summary?session=${sid}&cwd=${encodeURIComponent(root)}`)
  ok(sum.status === 200, 'HTTP 200')
  ok(sum.body.counts.tasks === 2, `任务总数 2（实际 ${sum.body.counts.tasks}）`)
  ok(sum.body.counts.done === 1, '已完成 1')
  ok(sum.body.counts.open === 1, '未完成 1')
  ok(sum.body.counts.failures === 1, '失败 1')
  ok(sum.body.counts.models === 1, '模型记录 1')
  ok(typeof sum.body.latestModel === 'string' && sum.body.latestModel.includes('model=m'), '返回当前模型参数')
  ok(typeof sum.body.dir === 'string', '返回日志目录')
  ok(sum.body.files && sum.body.files.tasks !== undefined, '返回文件路径表')

  // —— tasks / failures / models / journal ——
  console.log('\n用例 3：GET 各份文本')
  const t = await get(`/tasks?session=${sid}&cwd=${encodeURIComponent(root)}`)
  ok(t.status === 200 && t.body.text.includes('写插件'), 'tasks 返回内容')
  const f = await get(`/failures?session=${sid}&cwd=${encodeURIComponent(root)}`)
  ok(f.status === 200 && f.body.text.includes('QUOTA_EXCEEDED'), 'failures 返回原因')
  const m = await get(`/models?session=${sid}&cwd=${encodeURIComponent(root)}`)
  ok(m.status === 200 && m.body.text.includes('provider=p'), 'models 返回参数')
  const j = await get(`/journal?session=${sid}&cwd=${encodeURIComponent(root)}`)
  ok(j.status === 200 && j.body.text.includes('任务日志'), 'journal 返回日志')

  // —— export ——
  console.log('\n用例 4：POST /export')
  const ex = await post('/export', { session: sid, cwd: root, format: 'all' })
  ok(ex.status === 200 && ex.body.ok === true, '导出成功')
  ok(Array.isArray(ex.body.files) && ex.body.files.length > 0, `返回 ${ex.body.files?.length} 个文件`)
  ok(typeof ex.body.dir === 'string', '返回导出目录')

  // —— retry（无活跃 agent）——
  console.log('\n用例 5：POST /retry')
  const rt = await post('/retry', { session: sid, cwd: root })
  ok(rt.status === 200, 'HTTP 200')
  ok(rt.body.ok === false, '无活跃 agent 时明确返回失败')
  ok(typeof rt.body.message === 'string' && rt.body.message.includes('继续'), '给出替代做法')

  // —— 跨目录：日志不在请求 cwd 下也要能列出来 ——
  console.log('\n用例 6：跨目录汇总（服务 cwd ≠ 会话 cwd）')
  const other = await get(`/sessions?cwd=/tmp/definitely-not-here`)
  ok(other.status === 200, 'HTTP 200')
  ok(Array.isArray(other.body.dirs) && other.body.dirs.length > 0, '返回扫描过的目录列表')
  ok(other.body.dirs.some((d) => d.includes('dsh-journal-api-')), '包含了活跃 writer 的目录')

  // —— 服务刚重启：靠活跃 agent 反推目录 ——
  console.log('\n用例 7：重启后靠活跃 agent 反推目录')
  {
    const live = { id: 'live-x', session: { id: 'live-x', header: { cwd: root }, append() {} } }
    const regs2 = []
    const ctx2 = {
      logger: { info() {}, warn() {} },
      on: () => () => {},
      effect: (f) => f(),
      inject: (services, cb) => {
        if (services.includes('webServer')) {
          cb({ effect: (f) => f(), webServer: { register(o) { regs2.push(o.handler); return () => {} } } })
        }
        if (services.includes('tools')) cb({ tools: { register() {} } })
        if (services.includes('agents')) cb({ on: () => () => {} })
      },
      agents: { get: (id) => (id === 'live-x' ? live : undefined), list: () => [live] },
    }
    const mod2 = await import('./lib/index.js')
    mod2.apply(ctx2, { enabled: true, dir: base, notifyOnFailure: false })
    const srv2 = createServer((req, res) => regs2[0](req, res))
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
    const p2 = srv2.address().port
    const r2 = await fetch(`http://127.0.0.1:${p2}/api/dsh-journal/sessions`)
    const b2 = await r2.json()
    ok(r2.status === 200, 'HTTP 200')
    ok(b2.sessions.some((s) => s.session === sid), '内存无 writer 也能靠 agent 列出该会话')
    srv2.close()
  }


  // —— 会话文件路径 ——
  console.log('\n用例 8：会话文件路径')
  const sf = await get(`/summary?session=${sid}&cwd=${encodeURIComponent(root)}`)
  ok(typeof sf.body.sessionFile === 'string' && sf.body.sessionFile !== '', '返回 sessionFile')
  ok(sf.body.sessionFile.includes('.dsh/sessions/'), '路径含 .dsh/sessions/')
  ok(sf.body.sessionFile.endsWith('session.v4.jsonl.zstd'), '文件名正确')
  ok(sf.body.sessionFile.includes(sid), '路径含会话 id')
  ok(typeof sf.body.sessionFileExists === 'boolean', '返回 sessionFileExists')

  // —— 标记失败 ——
  console.log('\n用例 9：标记失败 /abandon')
  const ab = await post('/abandon', { session: sid, cwd: root, note: '测试放弃' })
  ok(ab.status === 200 && ab.body.ok === true, '标记失败成功')
  ok(typeof ab.body.task === 'string', `返回任务号 ${ab.body.task}`)
  const failAfter = await get(`/failures?session=${sid}&cwd=${encodeURIComponent(root)}`)
  ok(failAfter.body.text.includes('已标记为失败'), '失败清单记录了放弃')
  ok(failAfter.body.text.includes('测试放弃'), '记录了放弃原因')
  ok(failAfter.body.text.includes('不再重试'), '标注不再重试')
  const tasksAfter = await get(`/tasks?session=${sid}&cwd=${encodeURIComponent(root)}`)
  ok(tasksAfter.body.text.includes('已放弃'), '任务清单标注已放弃')

  // —— 开新会话（无 agents.create 时应如实失败）——
  console.log('\n用例 10：开新会话 /retry-new')
  const rn = await post('/retry-new', { session: sid, cwd: root })
  ok(rn.status === 200, 'HTTP 200')
  ok(rn.body.ok === false, '缺少 agent 注册表时如实返回失败')
  ok(typeof rn.body.message === 'string' && rn.body.message.includes('新会话'), '给出可读原因')


  // —— 历史会话查询 ——
  console.log('\n用例 12：历史会话 /history')
  const hist = await get('/history?limit=50')
  ok(hist.status === 200, 'HTTP 200')
  ok(Array.isArray(hist.body.sessions), '返回会话数组')
  ok(typeof hist.body.root === 'string' && hist.body.root.includes('sessions'), '返回存档根目录')
  if (hist.body.sessions.length > 0) {
    const s0 = hist.body.sessions[0]
    ok(typeof s0.sessionId === 'string' && s0.sessionId !== '', '含 sessionId')
    ok(typeof s0.file === 'string' && s0.file.endsWith('.zstd'), '含存档路径')
    ok(typeof s0.size === 'number', '含存档大小')
    ok('hasJournal' in s0, '含 hasJournal 标记')
  }
  const q1 = await get('/history?q=zzz-not-exist-zzz')
  ok(q1.status === 200 && q1.body.sessions.length === 0, '按不存在的关键词过滤返回空')

  // —— 历史会话摘要（多帧解压）——
  console.log('\n用例 13：历史会话摘要 /history/digest')
  const firstId = hist.body.sessions[0]?.sessionId
  if (firstId) {
    const dg = await get(`/history/digest?session=${encodeURIComponent(firstId)}`)
    ok(dg.status === 200, 'HTTP 200')
    ok(dg.body.session === firstId, '返回对应会话')
    ok(typeof dg.body.turns === 'number', '含轮数')
    ok(typeof dg.body.taskCount === 'number', '含任务数')
    ok(typeof dg.body.replyCount === 'number', '含产出数')
    ok(Array.isArray(dg.body.tasks), 'tasks 是数组')
    ok(typeof dg.body.file === 'string', '含存档路径')
  }
  const dgBad = await get('/history/digest?session=no-such-session-xyz')
  ok(dgBad.status === 404, '不存在的会话返回 404')
  const dgNoArg = await get('/history/digest')
  ok(dgNoArg.status === 400, '缺 session 参数返回 400')

  // —— 错误处理 ——
  console.log('\n用例 14：错误处理')
  const nf = await get(`/nope?cwd=${encodeURIComponent(root)}`)
  ok(nf.status === 404, '未知接口返回 404')
  const noSess = await get(`/summary?session=does-not-exist&cwd=${encodeURIComponent(root)}`)
  ok(noSess.status === 404, '不存在的会话返回 404')

  server.close()
  await rm(root, { recursive: true, force: true })
  console.log(`\n结果：${pass} passed / ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('自测崩了：', e)
  process.exit(1)
})
