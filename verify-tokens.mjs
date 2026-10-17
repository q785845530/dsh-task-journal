#!/usr/bin/env node
/**
 * dsh-task-journal / 令牌管理 自测。
 *
 *   node verify-tokens.mjs
 *
 * 不联网。重点断言**不该发生的没发生**：
 *   - 磁盘上只有密文，连片段都搜不到；
 *   - 接口只对本机开放，带转发头一律拒绝；
 *   - 响应里不回显令牌，只给打码提示；
 *   - 密文被改过会解不开（GCM 认证），而不是解出垃圾；
 *   - 密钥文件权限必须是 0600，且长度不对时不覆盖（否则旧令牌全废）。
 */
import { mkdtemp, readFile, rm, stat, writeFile, chmod, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SLOTS, slot, encrypt, decrypt, maskOf, list, set, remove, reveal, resolve,
  storageInfo, storeDir, keyPath, tokenPath, envToken,
} from './lib/tokens.js'
import { apply as applyPlugin } from './lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

/** 每个用例用独立的 DSH_HOME，互不干扰。 */
async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'dtj-tok-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return await fn(home) } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    await rm(home, { recursive: true, force: true })
  }
}

const main = async () => {
  const SENT = 'ghp_SENTINELtokenDONOTLEAK1234567890abcd'

  // ————— 一、槽位声明 —————
  console.log('一、槽位')
  ok(SLOTS.length >= 2, `声明了 ${SLOTS.length} 个槽位（github / gitee）`)
  ok(SLOTS.some((s) => s.name === 'github'), '含 github')
  ok(SLOTS.some((s) => s.name === 'gitee'), '含 gitee')
  ok(slot('github').envVars.includes('GH_TOKEN'), 'github 认 GH_TOKEN')
  ok(slot('github').envVars.includes('GITHUB_TOKEN'), 'github 认 GITHUB_TOKEN')
  ok(slot('nope') === null, '未知槽位返回 null')

  // ————— 二、打码 —————
  console.log('\n二、打码')
  ok(maskOf('ghp_abcdefghijklmnop').startsWith('ghp_'), '保留前 4 位')
  ok(maskOf('ghp_abcdefghijklmnop').endsWith('mnop'), '保留后 4 位')
  ok(maskOf('ghp_abcdefghijklmnop').includes('•'), '中间打码')
  ok(!maskOf(SENT).includes('SENTINEL'), '打码后看不到令牌主体')
  ok(maskOf('short') === '•••••', '太短的整串打码')
  ok(maskOf('') === '••••', '空串也不返回空')

  // ————— 三、加解密 —————
  console.log('\n三、加解密')
  {
    const key = Buffer.alloc(32, 7)
    const enc = encrypt('hello', key)
    ok(typeof enc.iv === 'string' && typeof enc.tag === 'string' && typeof enc.data === 'string', '密文含 iv/tag/data')
    ok(!JSON.stringify(enc).includes('hello'), '密文里没有明文')
    ok(decrypt(enc, key) === 'hello', '能解回原文')
    // 换密钥解不开
    let threw = false
    try { decrypt(enc, Buffer.alloc(32, 8)) } catch { threw = true }
    ok(threw, '换密钥解不开（不会解出垃圾）')
    // 改密文解不开（GCM 认证）
    threw = false
    try {
      const tampered = { ...enc, data: Buffer.from('tampered-data-here').toString('base64') }
      decrypt(tampered, key)
    } catch { threw = true }
    ok(threw, '密文被改过会解不开')
    // 改 tag 也解不开
    threw = false
    try { decrypt({ ...enc, tag: Buffer.alloc(16, 1).toString('base64') }, key) } catch { threw = true }
    ok(threw, '认证标签被改过会解不开')
    // 同一个明文两次加密结果不同（iv 随机）
    ok(encrypt('x', key).data !== encrypt('x', key).data, '每次加密的密文不同（iv 随机）')
  }

  // ————— 四、存取与磁盘密文 —————
  console.log('\n四、存取与磁盘密文')
  await withHome(async (home) => {
    const r = await set('github', SENT)
    ok(r.ok === true, '存入成功')
    ok(!JSON.stringify(r).includes(SENT), '存入的响应里不回显令牌')
    ok(typeof r.hint === 'string' && !r.hint.includes('SENTINEL'), '只返回打码提示')

    // **关键**：磁盘上有没有明文
    const raw = await readFile(tokenPath(), 'utf8')
    ok(!raw.includes(SENT), '**令牌文件里没有明文**')
    ok(!raw.includes('SENTINEL'), '**连片段都没有**')
    ok(raw.includes('aes-256-gcm'), '标明了算法')
    ok(raw.includes('"iv"') && raw.includes('"tag"') && raw.includes('"data"'), '结构是 iv/tag/data')

    // 整个目录都搜一遍
    const names = await readdir(storeDir())
    let leaked = 0
    for (const n of names) {
      const t = await readFile(join(storeDir(), n), 'utf8').catch(() => '')
      if (t.includes(SENT) || t.includes('SENTINEL')) leaked += 1
    }
    ok(leaked === 0, `存储目录里 ${names.length} 个文件都没有明文`)

    // 权限
    const k = await stat(keyPath())
    const t = await stat(tokenPath())
    ok((k.mode & 0o777) === 0o600, `密钥权限 0600（实际 ${(k.mode & 0o777).toString(8)}）`)
    ok((t.mode & 0o777) === 0o600, `令牌文件权限 0600（实际 ${(t.mode & 0o777).toString(8)}）`)
    ok(k.size === 32, '密钥 32 字节')

    // 读回
    ok((await reveal('github')).value === SENT, '能取回明文')
    ok((await resolve('github')) === SENT, 'resolve 能取到')
    const l = await list()
    const g = l.slots.find((x) => x.name === 'github')
    ok(g.stored === true && g.hint !== null, '列表里标为已存并给提示')
    ok(!JSON.stringify(l).includes(SENT), '列表响应里没有明文')
    ok(l.keyExists === true, '报告密钥存在')
  })

  // ————— 五、权限被改宽会自动收紧 —————
  console.log('\n五、权限自动收紧')
  await withHome(async () => {
    await set('github', SENT)
    await chmod(keyPath(), 0o644)
    const before = (await stat(keyPath())).mode & 0o777
    ok(before === 0o644, '前置条件：手动改成 0644')
    await list() // 触发一次读取
    const after = (await stat(keyPath())).mode & 0o777
    ok(after === 0o600, `再次读取时收紧回 0600（实际 ${after.toString(8)}）`)
  })

  // ————— 六、密钥损坏时不覆盖 —————
  console.log('\n六、密钥损坏')
  await withHome(async () => {
    await set('github', SENT)
    // 把密钥改成错误长度
    await writeFile(keyPath(), Buffer.alloc(16, 3))
    const l = await list()
    const g = l.slots.find((x) => x.name === 'github')
    ok(g.broken !== null && g.broken !== undefined, '解不开时如实标为 broken')
    ok(String(g.broken).includes('长度'), '说明是密钥长度问题')
    // 关键：没有把密钥覆盖掉（否则旧令牌全废）
    ok((await stat(keyPath())).size === 16, '**没有覆盖损坏的密钥**（避免旧令牌全部解不开）')
    const rv = await reveal('github')
    ok(rv.ok === false, '取明文时如实报错')
  })

  // ————— 七、输入校验 —————
  console.log('\n七、输入校验')
  await withHome(async () => {
    ok((await set('nope', SENT)).ok === false, '未知槽位被拒')
    ok((await set('github', '')).ok === false, '空令牌被拒')
    ok((await set('github', '   ')).ok === false, '纯空白被拒')
    ok((await set('github', 'abc')).ok === false, '太短被拒')
    ok((await set('github', 'has space here')).ok === false, '含空白被拒')
    ok((await set('github', 12345)).ok === false, '非字符串被拒')
    // 前后空白应当被 trim 掉再存
    const r = await set('gitee', `  ${SENT}  `)
    ok(r.ok === true, '前后空白会被 trim')
    ok((await reveal('gitee')).value === SENT, '存的是 trim 后的值')
  })

  // ————— 八、删除 —————
  console.log('\n八、删除')
  await withHome(async () => {
    await set('github', SENT)
    ok((await remove('github')).ok === true, '删除成功')
    ok((await reveal('github')).ok === false, '删完取不到')
    ok((await remove('github')).ok === false, '重复删除如实报错')
    ok((await remove('nope')).ok === false, '未知槽位被拒')
    const l = await list()
    ok(l.slots.find((x) => x.name === 'github').stored === false, '列表里标为未存')
  })

  // ————— 九、环境变量优先 —————
  console.log('\n九、环境变量优先')
  await withHome(async () => {
    await set('github', SENT)
    process.env.GH_TOKEN = 'from-env-token-value'
    try {
      const env = envToken('github')
      ok(env !== null && env.from === 'GH_TOKEN', '认出环境变量来源')
      ok(env.value === 'from-env-token-value', '取到环境变量的值')
      ok((await resolve('github')) === 'from-env-token-value', 'resolve 优先返回环境变量')
      const l = await list()
      const g = l.slots.find((x) => x.name === 'github')
      ok(g.effective === 'env', '列表里标为来自环境变量')
      ok(g.fromEnv === 'GH_TOKEN', '标出是哪个变量')
      ok(g.stored === true, '存的那份仍在（没被删）')
    } finally { delete process.env.GH_TOKEN }
    // GITHUB_TOKEN 也认（GH_TOKEN 优先）
    process.env.GITHUB_TOKEN = 'second-env'
    try {
      ok(envToken('github').from === 'GITHUB_TOKEN', '没有 GH_TOKEN 时用 GITHUB_TOKEN')
    } finally { delete process.env.GITHUB_TOKEN }
    // 用显式空值模拟「环境变量是空白」
    process.env.GH_TOKEN = '   '
    try {
      ok(envToken('github') === null, '空白的环境变量不算设置')
    } finally { delete process.env.GH_TOKEN }
  })

  // ————— 十、存储信息 —————
  console.log('\n十、存储信息')
  await withHome(async () => {
    const empty = await storageInfo()
    ok(empty.key.exists === false && empty.tokens.exists === false, '没用过时两个文件都不存在')
    await set('github', SENT)
    const full = await storageInfo()
    ok(full.key.exists === true && full.tokens.exists === true, '用过之后两个文件都在')
    ok(full.key.mode === '0600' && full.tokens.mode === '0600', '权限都是 0600')
    ok(full.dir === storeDir(), '带出目录')
  })

  // ————— 十一、接口：本地限制 —————
  console.log('\n十一、接口：只对本机开放')
  await withHome(async () => {
    const ctx = fakeApiCtx()
    applyPlugin(ctx, { enabled: true, dir: join(tmpdir(), 'dtj-tok-plugin') })
    await new Promise((r) => setTimeout(r, 80))
    const handler = ctx._handler()
    ok(typeof handler === 'function', 'API handler 已注册')

    // 本机来源：正常
    const local = await call(handler, 'GET', '/api/dsh-journal/tokens', undefined, { addr: '127.0.0.1' })
    ok(local.status === 200 && local.body.ok === true, '本机请求正常')

    // 非本机来源：拒绝
    const remote = await call(handler, 'GET', '/api/dsh-journal/tokens', undefined, { addr: '10.0.0.5' })
    ok(remote.status === 403, '非本机来源被拒（403）')
    ok(remote.body.reason.includes('本机'), '说明只对本机开放')

    // 带转发头：拒绝（哪怕 remoteAddress 是 127.0.0.1）
    const proxied = await call(handler, 'GET', '/api/dsh-journal/tokens', undefined,
      { addr: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } })
    ok(proxied.status === 403, '带 x-forwarded-for 时拒绝（看着像本地其实不是）')
    const proxied2 = await call(handler, 'GET', '/api/dsh-journal/tokens', undefined,
      { addr: '127.0.0.1', headers: { 'x-real-ip': '203.0.113.9' } })
    ok(proxied2.status === 403, '带 x-real-ip 时也拒绝')

    // ::1 也算本机
    const v6 = await call(handler, 'GET', '/api/dsh-journal/tokens', undefined, { addr: '::1' })
    ok(v6.status === 200, 'IPv6 环回也算本机')
    const v6mapped = await call(handler, 'GET', '/api/dsh-journal/tokens', undefined, { addr: '::ffff:127.0.0.1' })
    ok(v6mapped.status === 200, 'IPv4 映射地址也算本机')
  })

  // ————— 十二、接口：行为 —————
  console.log('\n十二、接口：行为')
  await withHome(async () => {
    const ctx = fakeApiCtx()
    applyPlugin(ctx, { enabled: true, dir: join(tmpdir(), 'dtj-tok-plugin2') })
    await new Promise((r) => setTimeout(r, 80))
    const handler = ctx._handler()
    const local = { addr: '127.0.0.1' }

    const list0 = await call(handler, 'GET', '/api/dsh-journal/tokens', undefined, local)
    ok(list0.status === 200 && list0.body.slots.length >= 2, '列出槽位')
    ok(list0.body.storage !== undefined, '带出存储信息')
    ok(!JSON.stringify(list0.body).includes(SENT), '列表里没有明文')

    const setR = await call(handler, 'POST', '/api/dsh-journal/tokens/set', { name: 'github', value: SENT }, local)
    ok(setR.status === 200 && setR.body.ok === true, '存入成功')
    ok(!JSON.stringify(setR.body).includes(SENT), '**存入响应里没有明文**')

    const noName = await call(handler, 'POST', '/api/dsh-journal/tokens/set', { value: SENT }, local)
    ok(noName.status === 400, '缺 name → 400')
    const noValue = await call(handler, 'POST', '/api/dsh-journal/tokens/set', { name: 'github' }, local)
    ok(noValue.status === 400, '缺 value → 400')

    const noConfirm = await call(handler, 'POST', '/api/dsh-journal/tokens/reveal', { name: 'github' }, local)
    ok(noConfirm.status === 400, '显示明文缺 confirm → 400')

    const rev = await call(handler, 'POST', '/api/dsh-journal/tokens/reveal', { name: 'github', confirm: true }, local)
    ok(rev.status === 200 && rev.body.value === SENT, '显式确认后能取到明文')

    const delNoConfirm = await call(handler, 'POST', '/api/dsh-journal/tokens/delete', { name: 'github' }, local)
    ok(delNoConfirm.status === 400, '删除缺 confirm → 400')
    const del = await call(handler, 'POST', '/api/dsh-journal/tokens/delete', { name: 'github', confirm: true }, local)
    ok(del.status === 200 && del.body.ok === true, '删除成功')

    const unknown = await call(handler, 'GET', '/api/dsh-journal/tokens/nope', undefined, local)
    ok(unknown.status === 404, '未知令牌接口 → 404')

    // 工具里不该有令牌动作（令牌只能人在本地界面输）
    const toolNames = ctx._tools.map((t) => t.name)
    ok(!toolNames.some((n) => n.includes('token')), `**工具里没有令牌动作**（${toolNames.filter((n) => n.includes('token')).join(',') || '无'}）`)
  })

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// ————————————————————————— 假件 —————————————————————————

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
        cb({ effect: (f) => f(), webServer: { register: ({ handler: h2 }) => { handler = h2; return () => {} } } })
      }
      if (names.includes('tools')) cb({ tools: { register: (t) => tools.push(t) } })
      if (names.includes('agents')) cb({ on: () => () => {} })
    },
    agents: { get: () => undefined, list: () => [] },
    _tools: tools,
    _handler: () => handler,
  }
}

/** 极简 req/res；`opts.addr` 用来模拟来源地址。 */
function call(handler, method, path, body, opts = {}) {
  return new Promise((done) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      url: path, method,
      headers: opts.headers ?? {},
      socket: { remoteAddress: opts.addr ?? '127.0.0.1' },
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
