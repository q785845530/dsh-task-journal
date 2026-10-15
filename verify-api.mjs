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
  ok(Array.isArray(s.body.sessions) && s.body.sessions.length === 1, '列出 1 个会话')
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

  // —— 错误处理 ——
  console.log('\n用例 6：错误处理')
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
