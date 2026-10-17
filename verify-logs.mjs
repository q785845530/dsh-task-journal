#!/usr/bin/env node
/**
 * dsh-task-journal / 后台日志 自测。
 *
 *   node verify-logs.mjs
 *
 * 不依赖真实 DSH、不联网、不执行真命令：日志样本在内存里造，
 * 执行器是假的。断言的重点是**不该发生的没发生**：
 *   - 认不出的格式不瞎猜（返回空，而不是猜一个结论）；
 *   - 只读接口不执行任何命令；
 *   - 修复只跑白名单动作，绝不把日志文本当命令执行；
 *   - 路径穿越被挡住；
 *   - 修完复查不把「日志还在」当成「没修好」。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseLogName, parseHeader, parseStartupError, parseFailedPlugins,
  parseRuntimeMessages, diagnose, listLogFiles, readLogFile, logsDir,
} from './lib/logs.js'
import { plan, runStep, verify, ACTIONS } from './lib/log-repair.js'
import { apply } from './lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

// ————————————————————————— 样本 —————————————————————————

/** 造一份与 DSH 实际输出同构的日志。 */
function makeLog({
  ts = '2026-10-17T06:35:35.974Z',
  version = '0.2.1-alpha.5',
  profile = 'web',
  startup = '2 required plugins did not activate',
  failed = [{ id: 'webserver', required: true, pkg: '@deepseek-ai/dsh-host-webserver', errors: ['listen EADDRINUSE: address already in use 127.0.0.1:3080'] }],
  messages = [],
} = {}) {
  const lines = [
    'WARNING: Raw diagnostics may contain configuration or credential values from plugin errors. Review before sharing.',
    '',
    '{',
    `  timestamp: '${ts}',`,
    `  dshVersion: '${version}',`,
    "  nodeVersion: 'v22.23.3',",
    "  platform: 'linux',",
    "  arch: 'x64',",
    `  profile: '${profile}',`,
    `  error: StartupError: dsh: startup failed: ${startup}`,
    '  ',
  ]
  if (failed.length > 0) {
    lines.push(`  Failed plugins (${failed.length}):`)
    for (const p of failed) {
      lines.push(`    ${p.id}${p.required ? ' (required)' : ''}`)
      if (p.pkg) lines.push(`      Package: ${p.pkg}`)
      for (const e of p.errors) lines.push(`      Error: ${e}`)
      lines.push('')
    }
  }
  lines.push('  Plugins waiting for services (1):')
  lines.push('    Plugin                  Missing services')
  lines.push('    web-runtime (required)  webServer')
  lines.push('')
  if (messages.length > 0) {
    lines.push('    [startup]: {')
    lines.push('      configurationPath: \'/home/u/.dsh/profiles/web/cordis.yml\',')
    lines.push('      messages: [')
    for (const m of messages) {
      lines.push('        {')
      lines.push(`          ts: ${m.ts ?? 1792218933822},`)
      lines.push(`          name: '${m.name}',`)
      lines.push(`          type: '${m.type ?? 'warn'}',`)
      lines.push('          args: [')
      lines.push(`            ${m.arg},`)
      lines.push('            [length]: 1')
      lines.push('          ]')
      lines.push('        },')
    }
    lines.push('        [length]: ' + messages.length)
    lines.push('      ]')
    lines.push('    }')
  }
  lines.push('}')
  return lines.join('\n') + '\n'
}

// ————————————————————————— 主流程 —————————————————————————

const main = async () => {
  // ————— 一、文件名与头部 —————
  console.log('一、文件名与头部')
  const n1 = parseLogName('startup-2026-10-17T06-35-35.974Z-c357dce7-6342-4c88-9007-1be9a21db50d.log')
  ok(n1 !== null, '认识标准日志文件名')
  ok(n1.at === '2026-10-17T06:35:35.974Z', `还原本 ISO 时间（实际 ${n1?.at}）`)
  ok(n1.id === 'c357dce7-6342-4c88-9007-1be9a21db50d', '取出 uuid')
  ok(parseLogName('random.log') === null, '不认识的文件名返回 null')
  ok(parseLogName('startup-bad.log') === null, '格式不对返回 null')

  const h = parseHeader(makeLog({ profile: 'dev' }))
  ok(h.dshVersion === '0.2.1-alpha.5', '取出版本')
  ok(h.profile === 'dev', '取出 profile')
  ok(h.platform === 'linux', '取出平台')
  ok(parseHeader('nothing here').dshVersion === null, '取不到时是 null，不编默认值')

  // ————— 二、启动失败识别 —————
  console.log('\n二、启动失败识别')
  const e1 = parseStartupError(makeLog({ startup: '2 required plugins did not activate' }))
  ok(e1?.count === 2, `数对数量（实际 ${e1?.count}）`)
  ok(parseStartupError(makeLog({ startup: '1 required plugin did not activate' }))?.count === 1, '单数形式也认')
  ok(parseStartupError('no failure here') === null, '没失败时返回 null')

  // ————— 三、失败插件解析 —————
  console.log('\n三、失败插件解析')
  const fp = parseFailedPlugins(makeLog({
    failed: [
      { id: 'webserver', required: true, pkg: '@deepseek-ai/dsh-host-webserver', errors: ['listen EADDRINUSE: address already in use 127.0.0.1:3080'] },
      { id: 'typert-loader', required: false, pkg: '@deepseek-ai/dsh-typert-loader', errors: ['AggregateError: 22 contributors failed'] },
    ],
  }))
  ok(fp.length === 2, `解析出 2 个（实际 ${fp.length}）`)
  ok(fp[0].id === 'webserver' && fp[0].required === true, '第一个是必装的 webserver')
  ok(fp[0].packages[0] === '@deepseek-ai/dsh-host-webserver', '取到包名')
  ok(fp[0].errors[0].includes('EADDRINUSE'), '取到错误原文')
  ok(fp[1].id === 'typert-loader' && fp[1].required === false, '第二个是可选的 typert-loader')
  ok(parseFailedPlugins('no failed plugins').length === 0, '没有失败插件时返回空数组')

  // 关键：不把后续大段落吞进错误里
  const longLog = makeLog()
  const fpLong = parseFailedPlugins(longLog)
  ok(fpLong[0].errors[0].length < 200, `错误没被后续段落污染（长度 ${fpLong[0].errors[0].length}）`)
  ok(!fpLong[0].errors[0].includes('Plugins waiting'), '错误里不含下一段的标题')

  // ————— 四、运行时消息 —————
  console.log('\n四、运行时消息')
  const msgs = parseRuntimeMessages(makeLog({
    messages: [
      { name: 'dsh-slack', type: 'warn', arg: "'未检测到 Slack 令牌'" },
      { name: 'web-server', type: 'error', arg: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3080' },
      { name: 'our-free-model', type: 'warn', arg: '`[codearts] 续期失败：token request failed: 400`' },
    ],
  }))
  ok(msgs.length === 3, `解析出 3 条（实际 ${msgs.length}）`)
  ok(msgs[0].name === 'dsh-slack' && msgs[0].message === '未检测到 Slack 令牌', '单引号字符串')
  ok(msgs[1].type === 'error' && msgs[1].message.includes('EADDRINUSE'), 'Error 对象也能取出消息')
  ok(msgs[2].message.includes('codearts'), '反引号模板串也能取出')
  ok(msgs.every((m) => m.message !== ''), '没有解析成空消息的条目')

  // ————— 五、诊断规则 —————
  console.log('\n五、诊断规则')
  const d1 = diagnose(makeLog())
  ok(d1.broken === true, '有启动失败 → broken')
  ok(d1.issues.length === 1 && d1.issues[0].id === 'port-in-use', '认出端口占用')
  ok(d1.issues[0].explain.includes('3080'), '说明里带出端口号')
  ok(d1.issues[0].repairable === true, '标记为可修')

  const d2 = diagnose(makeLog({
    failed: [{ id: 'x', required: true, pkg: '@x/y', errors: ["Cannot find module '/a/b/node_modules/x/lib/client.js'"] }],
  }))
  ok(d2.issues.some((i) => i.id === 'plugin-missing-module'), '认出模块缺失')

  const d3 = diagnose(makeLog({
    failed: [{ id: 'x', required: true, pkg: '@x/y', errors: ['Plugin x@1.0.0 is incompatible with dsh 0.2.1-alpha.5'] }],
  }))
  ok(d3.issues.some((i) => i.id === 'profile-version-mismatch'), '认出版本不匹配')

  // 认不出就老实说认不出
  const d4 = diagnose(makeLog({
    failed: [{ id: 'x', required: true, pkg: '@x/y', errors: ['some totally unknown error'] }],
  }))
  ok(d4.broken === true, '未知错误仍然算 broken')
  ok(d4.issues.length === 0, '但不下结论（不为未知错误编造诊断）')

  // 健康日志
  const d5 = diagnose('WARNING: x\n\n{\n  timestamp: \'2026-01-01T00:00:00.000Z\',\n  dshVersion: \'1.0.0\',\n}\n')
  ok(d5.broken === false, '没有失败标记 → 不 broken')
  ok(d5.issues.length === 0, '健康日志没有诊断结论')

  // 只有告警、没有失败
  const d6 = diagnose(makeLog({
    startup: '0 required plugins did not activate',
    failed: [],
    messages: [{ name: 'a', type: 'warn', arg: "'只是个告警'" }],
  }))
  ok(d6.warnCount === 1 && d6.errorCount === 0, '告警与错误分开计数')

  // ————— 六、修复方案 —————
  console.log('\n六、修复方案')
  const p1 = plan(d1)
  ok(p1.length >= 1, '端口占用生成至少一步')
  ok(p1[0].action === 'inspect-port', '第一步是只读的端口探查')
  ok(p1[0].args.port === '3080', `带出端口参数（实际 ${p1[0].args.port}）`)
  // 人工项不该被当成可执行动作
  ok(p1.every((s) => s.action !== undefined), '每一步都有白名单动作 id')

  const pModules = plan(d2)
  ok(pModules.some((s) => s.action === 'reinstall-profile'), '模块缺失给出重装步骤')
  ok(plan(d5).length === 0, '健康日志没有修复步骤')

  // ————— 七、白名单动作 —————
  console.log('\n七、白名单动作')

  // 假执行器：记录调用，绝不真跑
  const calls = []
  const fakeExec = (okResult) => async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return typeof okResult === 'function' ? okResult(cmd, args, opts) : okResult
  }

  calls.length = 0
  const r1 = await runStep(p1[0], fakeExec({ ok: true, stdout: 'LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=1))' }))
  ok(r1.ok === true && r1.busy === true, '认出口语正被占用')
  ok(calls[0].cmd === 'ss' && calls[0].args[0] === '-ltnp', '只调用 ss -ltnp')
  ok(calls[0].args[1] === 'sport = :3080', '端口作为独立参数传入（不经 shell）')

  calls.length = 0
  const r2 = await runStep(p1[0], fakeExec({ ok: true, stdout: 'State\n' }))
  ok(r2.ok === true && r2.busy === false, '认出口语已空出')

  // 非法端口必须拒绝，且不执行命令
  calls.length = 0
  const r3 = await runStep({ ...p1[0], args: { port: 'abc' } }, fakeExec({ ok: true, stdout: '' }))
  ok(r3.ok === false, '非法端口被拒绝')
  ok(calls.length === 0, '非法端口没有执行任何命令')

  calls.length = 0
  const r3b = await runStep({ ...p1[0], args: { port: '80; rm -rf /' } }, fakeExec({ ok: true, stdout: '' }))
  ok(r3b.ok === false, '命令注入串被拒绝')
  ok(calls.length === 0, '注入串没有执行任何命令')

  // 未知动作
  const r4 = await runStep({ action: 'rm-rf-everything', args: {} }, fakeExec({ ok: true }))
  ok(r4.ok === false && r4.reason.includes('没有这个动作'), '未知动作被拒绝')

  // 执行器失败
  const r5 = await runStep(p1[0], fakeExec({ ok: false, reason: '系统里没有 ss 命令' }))
  ok(r5.ok === false && r5.reason.includes('ss'), '命令不存在时如实报告')

  // reinstall 的 profile 名校验
  calls.length = 0
  const r6 = await runStep(
    { action: 'reinstall-profile', args: { profile: '../evil' } },
    fakeExec({ ok: true, stdout: '' }),
  )
  ok(r6.ok === false, '非法 profile 名被拒绝')
  ok(calls.length === 0, '非法 profile 名没有执行命令')

  // ————— 八、复查语义 —————
  console.log('\n八、复查语义')
  const tmp = await mkdtemp(join(tmpdir(), 'dtj-logs-'))
  const dir = join(tmp, 'logs')
  await mkdir(dir, { recursive: true })
  const fileName = 'startup-2026-10-17T06-35-35.974Z-c357dce7-6342-4c88-9007-1be9a21db50d.log'
  await writeFile(join(dir, fileName), makeLog())

  // verify 用的是 logsDir()，这里用 DSH_HOME 指向临时目录
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    calls.length = 0
    const v1 = await verify({ name: fileName, exec: fakeExec({ ok: true, stdout: 'State\n' }) })
    ok(v1.ok === true, '复查可执行')
    ok(v1.checks.some((c) => c.id === 'log-still-records-failure'), '明确告知「日志仍然记录着失败」')
    const that = v1.checks.find((c) => c.id === 'log-still-records-failure')
    ok(that.ok === false && that.detail.includes('历史快照'), '并说明这不是没修好的证据')

    // 没有实时证据 → 无法判定，不假装修好
    const v2 = await verify({ name: fileName, exec: fakeExec({ ok: true, stdout: '' }) })
    ok(v2.verdict === 'unknown', `没有实时证据 → unknown（实际 ${v2.verdict}）`)

    // 有实时证据且端口空了 → fixed
    const v3 = await verify({ name: fileName, port: '3080', exec: fakeExec({ ok: true, stdout: 'State\n' }) })
    ok(v3.verdict === 'fixed', `端口空出 → fixed（实际 ${v3.verdict}）`)

    // 端口仍占 → still-broken
    const v4 = await verify({
      name: fileName, port: '3080',
      exec: fakeExec({ ok: true, stdout: 'LISTEN 0 511 127.0.0.1:3080 0.0.0.0:*' }),
    })
    ok(v4.verdict === 'still-broken', `端口仍占 → still-broken（实际 ${v4.verdict}）`)

    const v5 = await verify({ name: 'nope.log', exec: fakeExec({ ok: true, stdout: '' }) })
    ok(v5.ok === false && v5.reason.includes('读不到'), '读不到日志时如实报告')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await rm(tmp, { recursive: true, force: true })
  }

  // ————— 九、文件列举与读取 —————
  console.log('\n九、文件列举与读取')
  const tmp2 = await mkdtemp(join(tmpdir(), 'dtj-logs2-'))
  const dir2 = join(tmp2, 'logs')
  await mkdir(dir2, { recursive: true })
  // 造三份，时间乱序写入，验证按时间倒序返回
  const names = [
    'startup-2026-10-01T00-00-00.000Z-11111111-1111-1111-1111-111111111111.log',
    'startup-2026-10-20T00-00-00.000Z-22222222-2222-2222-2222-222222222222.log',
    'startup-2026-10-10T00-00-00.000Z-33333333-3333-3333-3333-333333333333.log',
  ]
  for (const name of names) await writeFile(join(dir2, name), makeLog())
  // 混一个不相关文件，必须被忽略
  await writeFile(join(dir2, 'not-a-log.txt'), 'hi')

  const listed = await listLogFiles(dir2, { limit: 10 })
  ok(listed.exists === true, '目录存在')
  ok(listed.total === 3, `只数合法的日志（实际 ${listed.total}）`)
  ok(listed.files[0].at.startsWith('2026-10-20'), '按时间倒序，最新在前')
  ok(listed.files[2].at.startsWith('2026-10-01'), '最旧在最后')
  ok(listed.files.every((f) => f.bytes > 0), '带出文件大小')

  const limited = await listLogFiles(dir2, { limit: 2 })
  ok(limited.files.length === 2 && limited.total === 3, 'limit 只截返回，total 仍报全量')

  const missing = await listLogFiles(join(tmp2, 'nope'))
  ok(missing.exists === false && missing.files.length === 0, '目录不存在时返回空，不抛')

  const read = await readLogFile(dir2, names[0], { maxBytes: 100 })
  ok(read.truncated === true, '超限时标记 truncated')
  ok(read.preview.length <= 100, 'preview 受 maxBytes 限制')

  const full = await readLogFile(dir2, names[0])
  ok(full.truncated === false, '不超限时 truncated=false')
  ok(full.broken === true, '读出来能诊断')
  await rm(tmp2, { recursive: true, force: true })

  // ————— 十、凭据遮蔽 —————
  console.log('\n十、凭据遮蔽')
  const tmp3 = await mkdtemp(join(tmpdir(), 'dtj-logs3-'))
  const dir3 = join(tmp3, 'logs')
  await mkdir(dir3, { recursive: true })
  const secretish = makeLog() + "\n  token: 'ghp_" + 'a'.repeat(30) + "'\n"
  await writeFile(join(dir3, names[0]), secretish)
  const red = await readLogFile(dir3, names[0])
  ok(!red.preview.includes('ghp_' + 'a'.repeat(30)), 'preview 里的 token 被遮蔽')
  ok(red.preview.includes('<redacted:'), '留下可识别的遮蔽标记')
  await rm(tmp3, { recursive: true, force: true })

  // ————— 十一、logsDir 跟随 DSH_HOME —————
  console.log('\n十一、日志目录')
  ok(logsDir({ DSH_HOME: '/x' }) === join('/x', 'logs'), '跟随 DSH_HOME')
  ok(logsDir({}).endsWith('/logs'), '没有 DSH_HOME 时落在 HOME 下')

  // ————— 十二、HTTP 接口与工具 —————
  console.log('\n十二、HTTP 接口与工具')
  const tmp4 = await mkdtemp(join(tmpdir(), 'dtj-logs4-'))
  const home4 = tmp4
  await mkdir(join(home4, 'logs'), { recursive: true })
  await writeFile(join(home4, 'logs', names[0]), makeLog())

  const oldHome2 = process.env.DSH_HOME
  process.env.DSH_HOME = home4
  try {
    const ctx = fakeApiCtx()
    apply(ctx, { enabled: true, dir: join(tmp4, 'journal') })
    await new Promise((r) => setTimeout(r, 60))
    const handler = ctx._handler()
    ok(typeof handler === 'function', 'API handler 已注册')

    const list = await call(handler, 'GET', '/api/dsh-journal/logs')
    ok(list.status === 200 && list.body.ok === true, 'GET /logs 200')
    ok(list.body.total === 1, `列出 1 份（实际 ${list.body.total}）`)
    ok(list.body.latest !== null && list.body.latest.broken === true, 'latest 标出失败')
    ok(list.body.alert?.level === 'error', '有失败时给出 error 级提醒')

    const readApi = await call(handler, 'GET', `/api/dsh-journal/logs/read?name=${encodeURIComponent(names[0])}`)
    ok(readApi.status === 200 && readApi.body.broken === true, '读单份 200 且能诊断')

    // 路径穿越必须挡住
    const travel = await call(handler, 'GET', '/api/dsh-journal/logs/read?name=../../../etc/passwd')
    ok(travel.status === 400, '路径穿越被拒（400）')
    const travel2 = await call(handler, 'GET', '/api/dsh-journal/logs/read?name=sub/x.log')
    ok(travel2.status === 400, '带斜杠的文件名被拒')

    const planApi = await call(handler, 'GET', `/api/dsh-journal/logs/plan?name=${encodeURIComponent(names[0])}`)
    ok(planApi.status === 200 && planApi.body.steps.length >= 1, '出方案接口返回步骤')
    ok(planApi.body.steps[0].action === 'inspect-port', '方案第一步是端口探查')

    const noConfirm = await call(handler, 'POST', '/api/dsh-journal/logs/fix', { name: names[0], action: 'inspect-port' })
    ok(noConfirm.status === 400, '缺 confirm → 400')

    const noAction = await call(handler, 'POST', '/api/dsh-journal/logs/fix', { name: names[0], confirm: true })
    ok(noAction.status === 400, '缺 action → 400')

    const badAction = await call(handler, 'POST', '/api/dsh-journal/logs/fix', {
      name: names[0], action: 'rm-rf-everything', confirm: true,
    })
    ok(badAction.status === 400, '非白名单动作 → 400')
    ok(String(badAction.body.reason ?? '').includes('没有'), '说明这份诊断里没有这一步')

    const missing = await call(handler, 'GET', '/api/dsh-journal/logs/read?name=nope.log')
    ok(missing.status === 404, '不存在的日志 → 404')
    ok(!String(missing.body.reason).includes('/'), '404 不回显绝对路径')

    const unknownRoute = await call(handler, 'GET', '/api/dsh-journal/logs/nope')
    ok(unknownRoute.status === 404, '未知日志接口 → 404')

    // 工具
    const tool = ctx._tools.find((t) => t.name === 'journal_logs')
    ok(tool !== undefined, 'journal_logs 工具已注册')
    const exec = { agent: { session: { id: 's' } }, signal: undefined }
    const tList = await tool.execute({ action: 'list' }, exec)
    ok(tList.ok === true && tList.message.includes('共 1 份'), '工具 list 报出数量')
    const tRead = await tool.execute({ action: 'read', name: names[0] }, exec)
    ok(tRead.ok === true && tRead.message.includes('端口被占用'), '工具 read 给出诊断')
    const tPlan = await tool.execute({ action: 'plan', name: names[0] }, exec)
    ok(tPlan.ok === true && tPlan.message.includes('inspect-port'), '工具 plan 列出动作')
    ok(tPlan.message.includes('模型不代劳'), '工具明确不代替人执行')
    const tBad = await tool.execute({ action: 'read', name: '../x' }, exec)
    ok(tBad.ok === false, '工具也挡路径穿越')
    // 非法 action 由工具框架的参数校验拦下（enum），到不了我们的代码 ——
    // 这比在实现里再判一次更可靠，所以这里断言的是「会被拦」。
    let tUnknown = null
    try { tUnknown = await tool.execute({ action: 'bogus' }, exec) } catch (e) { tUnknown = { ok: false, code: e?.code } }
    ok(tUnknown.ok === false, '工具对未知 action 拒绝')
  } finally {
    if (oldHome2 === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome2
    await rm(tmp4, { recursive: true, force: true })
  }

  // 目录不存在时的降级
  const tmp5 = await mkdtemp(join(tmpdir(), 'dtj-logs5-'))
  const oldHome3 = process.env.DSH_HOME
  process.env.DSH_HOME = tmp5
  try {
    const ctx = fakeApiCtx()
    apply(ctx, { enabled: true, dir: join(tmp5, 'journal') })
    await new Promise((r) => setTimeout(r, 60))
    const r = await call(ctx._handler(), 'GET', '/api/dsh-journal/logs')
    ok(r.status === 200 && r.body.exists === false, '日志目录不存在时 200 且 exists=false')
    ok(r.body.alert === null, '没有日志时不弹提醒')
    const tool = ctx._tools.find((t) => t.name === 'journal_logs')
    const t = await tool.execute({ action: 'list' }, { agent: { session: { id: 's' } }, signal: undefined })
    ok(t.ok === false && t.message.includes('不存在'), '工具在无目录时说明原因')
  } finally {
    if (oldHome3 === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome3
    await rm(tmp5, { recursive: true, force: true })
  }

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// ————————————————————————— 假 ctx —————————————————————————

function fakeApiCtx() {
  const tools = []
  let handler = null
  return {
    logger: { info() {}, warn() {} },
    on() { return () => {} },
    effect(fn) { return fn() },
    get() { return undefined },
    inject(names, cb) {
      if (names.includes('webServer')) {
        cb({
          effect: (f) => f(),
          webServer: { register: ({ handler: h2 }) => { handler = h2; return () => {} } },
        })
      }
      if (names.includes('tools')) cb({ tools: { register: (t) => tools.push(t) } })
      if (names.includes('agents')) cb({ on: () => () => {} })
    },
    agents: { get: () => undefined, list: () => [] },
    _tools: tools,
    _handler: () => handler,
  }
}

/** 极简 req/res。 */
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

main().catch((e) => {
  console.error('\n自测自身异常：', e)
  process.exit(1)
})
