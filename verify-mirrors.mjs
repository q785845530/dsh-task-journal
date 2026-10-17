#!/usr/bin/env node
/**
 * dsh-task-journal / 镜像源 自测。
 *
 *   node verify-mirrors.mjs
 *
 * 不联网、不碰真实配置：所有文件写在临时目录，探测用假 fetch。
 * 重点断言**不该发生的没发生**：
 *   - 改配置只动目标键，文件里其它行原样保留；
 *   - 改之前一定先备份，备份能恢复；
 *   - 不是合法镜像/地址的输入被拒；
 *   - 需要 root 的一项（Docker）不去偷偷改，如实报告；
 *   - 非法 JSON 的配置拒绝改写（不硬改毁掉配置）；
 *   - 测速区分「超时」与「不可达」。
 */
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CATALOG, entryById, readValue, isMirror, rewrite, backup, apply, listStatus,
  restore, probe, probeAll, probeCustom,
} from './lib/mirrors.js'
import { apply as applyPlugin } from './lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

const main = async () => {
  // ————— 一、清单完整性 —————
  console.log('一、清单')
  ok(CATALOG.length === 7, `清单 ${CATALOG.length} 项（npm/pnpm/yarn/pip/docker/apt/github）`)
  const ids = CATALOG.map((x) => x.id)
  for (const want of ['npm', 'npm', 'pnpm', 'yarn', 'pypi', 'docker', 'apt', 'github']) {
    if (want === 'npm') continue
    ok(ids.includes(want), `含 ${want}`)
  }
  ok(CATALOG.every((x) => x.mirrors.length > 0), '每项都有候选镜像')
  ok(CATALOG.every((x) => typeof x.label === 'string' && x.label !== ''), '每项都有名字')
  ok(entryById('npm') !== null && entryById('nope') === null, '按 id 取项')
  // 关键：pnpm 不是共用 npm 的 .npmrc
  const pnpm = entryById('pnpm')
  const npm = entryById('npm')
  ok(pnpm.file !== npm.file, 'pnpm 与 npm 不是同一个配置文件（实测踩过）')
  ok(pnpm.file.includes('auth.ini'), 'pnpm 读 auth.ini')

  // ————— 二、读值 —————
  console.log('\n二、读值')
  ok(readValue('registry=https://a/\n', npm) === 'https://a/', 'npmrc 读普通值')
  ok(readValue('other=1\nregistry = https://b/ \nx=2\n', npm) === 'https://b/', 'npmrc 容忍空格')
  ok(readValue('# registry=https://c/\n', npm) === null, '注释行不算')
  ok(readValue('', npm) === null, '空文件返回 null')
  ok(readValue('[global]\nindex-url = https://p/\n', entryById('pypi')) === 'https://p/', 'ini 读 global 段')
  ok(readValue('[other]\nindex-url = https://q/\n', entryById('pypi')) === null, 'ini 不读别的段')
  ok(readValue('npmRegistryServer: https://y/\n', entryById('yarn')) === 'https://y/', 'yaml 读值')
  ok(readValue('npmRegistryServer: "https://y/"\n', entryById('yarn')) === 'https://y/', 'yaml 去引号')
  ok(readValue('{"registry-mirrors":["https://d/"]}', entryById('docker')).length === 1, 'json 读数组')
  ok(readValue('not json', entryById('docker')) === null, '非法 JSON 读不出就 null')

  // ————— 三、改写保留其它内容 —————
  console.log('\n三、改写只动目标键')
  const npmText = 'allow-scripts=foo,bar\nregistry=https://old/\n//x/:_authToken=SECRET\n'
  const npmNext = rewrite(npmText, npm, 'https://new/')
  ok(npmNext.includes('registry=https://new/'), '目标键被替换')
  ok(!npmNext.includes('https://old/'), '旧值没了')
  ok(npmNext.includes('allow-scripts=foo,bar'), '其它键保留')
  ok(npmNext.includes('_authToken=SECRET'), 'token 行保留（不能弄丢凭据）')
  ok(npmNext.split('\n').length === npmText.split('\n').length, '行数不变')

  const added = rewrite('a=1\n', npm, 'https://new/')
  ok(added.includes('registry=https://new/'), '没有该键时追加')
  ok(added.startsWith('a=1\n'), '追加不破坏原内容')

  const removed = rewrite('a=1\nregistry=https://x/\nb=2\n', npm, null)
  ok(!removed.includes('registry='), '值为 null 时删掉该行')
  ok(removed.includes('a=1') && removed.includes('b=2'), '删行不误伤其它行')

  const iniText = '[global]\nindex-url = https://old/\ntimeout = 60\n\n[install]\nx = 1\n'
  const iniNext = rewrite(iniText, entryById('pypi'), 'https://new/')
  ok(iniNext.includes('index-url = https://new/'), 'ini 替换目标键')
  ok(iniNext.includes('timeout = 60'), 'ini 保留同段其它键')
  ok(iniNext.includes('[install]'), 'ini 保留其它段')
  const iniClear = rewrite(iniText, entryById('pypi'), null)
  ok(!iniClear.includes('index-url'), 'ini 清除镜像 = 删掉该键')
  ok(iniClear.includes('timeout = 60'), 'ini 清除后其它键还在')

  const jsonText = '{"registry-mirrors":["https://a/"],"log-driver":"json-file"}'
  const jsonNext = rewrite(jsonText, entryById('docker'), ['https://b/'])
  const parsed = JSON.parse(jsonNext)
  ok(parsed['registry-mirrors'][0] === 'https://b/', 'json 替换数组')
  ok(parsed['log-driver'] === 'json-file', 'json 保留其它字段')

  // 非法 JSON 必须拒绝，不能硬改
  let threw = null
  try { rewrite('{ broken', entryById('docker'), ['https://b/']) } catch (e) { threw = e }
  ok(threw !== null, '非法 JSON 拒绝改写')
  ok(threw.message.includes('不是合法 JSON'), '错误说明原因')

  // ————— 四、isMirror —————
  console.log('\n四、镜像判定')
  ok(isMirror(npm, 'https://registry.npmmirror.com/') === true, '认出淘宝')
  ok(isMirror(npm, 'https://registry.npmmirror.com') === true, '尾斜杠不影响')
  ok(isMirror(npm, 'https://registry.npmjs.org/') === false, '官方不算镜像')
  ok(isMirror(npm, null) === false, 'null 不算')
  ok(isMirror(npm, '') === false, '空串不算')

  // ————— 五、真实文件操作（临时目录） —————
  console.log('\n五、文件操作')
  const tmp = await mkdtemp(join(tmpdir(), 'dtj-mirror-'))
  const oldHome = process.env.HOME
  // CATALOG 里的路径在模块加载时就算好了，所以这里直接测 apply 的通用路径：
  // 用 npm 项，但把文件指到临时目录。
  const target = join(tmp, 'npmrc')
  await writeFile(target, 'registry=https://registry.npmjs.org/\nother=keep\n')

  const bk = await backup(target)
  ok(bk !== null && bk.includes('.dtj-backup-'), '备份文件带时间戳标记')
  ok(await readFile(bk, 'utf8') === await readFile(target, 'utf8'), '备份内容与原文件一致')
  ok(await backup(join(tmp, 'nope')) === null, '文件不存在时不产生备份')

  // 恢复
  await writeFile(target, 'registry=https://changed/\n')
  const rs = await restore(bk)
  ok(rs.ok === true, '恢复成功')
  ok((await readFile(target, 'utf8')).includes('registry=https://registry.npmjs.org/'), '恢复回原内容')
  const badRestore = await restore(join(tmp, 'evil.txt'))
  ok(badRestore.ok === false, '非本功能产生的备份拒绝恢复')

  await rm(tmp, { recursive: true, force: true })

  // ————— 六、apply 的拦截 —————
  console.log('\n六、apply 拦截')
  const rUnknown = await apply('nope', 'https://x/')
  ok(rUnknown.ok === false && rUnknown.reason.includes('没有这一项'), '未知 id 被拒')

  const rDocker = await apply('docker', ['https://x/'])
  ok(rDocker.ok === false && rDocker.needsRoot === true, 'Docker 需 root：拒绝自动改')
  ok(rDocker.reason.includes('root'), '说明要 root')
  ok(rDocker.file === '/etc/docker/daemon.json', '带出要改的文件')

  const rApt = await apply('apt', 'https://x/')
  ok(rApt.ok === false, 'APT 拒绝自动改（格式风险高）')

  const rGithub = await apply('github', 'https://x/')
  ok(rGithub.ok === false && rGithub.reason.includes('前缀'), 'GitHub 只给地址不改配置')

  // 非法地址：不接受任意字符串
  const rBad = await apply('npm', 'not a url')
  ok(rBad.ok === false, '非法地址被拒')
  const rBad2 = await apply('npm', 'ftp://x/')
  ok(rBad2.ok === false, '非 http(s) 被拒')

  // ————— 七、apply 真改（用可控路径） —————
  console.log('\n七、apply 真改（可控路径）')
  // 直接调底层：把 npm 项的文件换成临时文件
  const tmp2 = await mkdtemp(join(tmpdir(), 'dtj-mirror2-'))
  const fake = { ...entryById('npm'), file: join(tmp2, 'npmrc') }
  await writeFile(fake.file, 'allow-scripts=a\nregistry=https://registry.npmjs.org/\n')
  // 用真实的 entry id 但临时路径不方便；这里验证 rewrite+backup+写盘这条链
  const nextText = rewrite(await readFile(fake.file, 'utf8'), fake, 'https://registry.npmmirror.com/')
  const bk2 = await backup(fake.file)
  await writeFile(fake.file, nextText)
  const after = await readFile(fake.file, 'utf8')
  ok(after.includes('https://registry.npmmirror.com/'), '切换后是新镜像')
  ok(after.includes('allow-scripts=a'), '切换保留其它配置')
  ok(bk2 !== null, '切换前有备份')
  await rm(tmp2, { recursive: true, force: true })

  // ————— 八、listStatus 不炸 —————
  console.log('\n八、状态汇总')
  const status = await listStatus()
  ok(Array.isArray(status) && status.length === CATALOG.length, '每项都有一条状态')
  ok(status.every((s) => typeof s.id === 'string' && typeof s.file === 'string'), '每条都有 id 与文件')
  ok(status.every((s) => typeof s.canApply === 'boolean'), '每条都标明能否自动改')
  const stDocker = status.find((s) => s.id === 'docker')
  ok(stDocker.canApply === false && stDocker.needsRoot === true, 'Docker 标为不可自动改')
  const stGithub = status.find((s) => s.id === 'github')
  ok(stGithub.canApply === false && stGithub.readOnly === true, 'GitHub 标为只读')
  // 不存在的文件也不能炸
  ok(status.every((s) => s.error === null || typeof s.error === 'string'), '读不到文件时记录错误而非抛异常')

  // ————— 九、测速语义 —————
  console.log('\n九、测速')
  const realFetch = globalThis.fetch
  try {
    // 快
    globalThis.fetch = async () => ({ status: 200, ok: true })
    const p1 = await probe('https://a/')
    ok(p1.ok === true && p1.reachable === true, 'HTTP 200 → 可达')
    ok(typeof p1.ms === 'number', '带延迟读数')

    // 服务器错误：服务可能有问题，但机器通 —— 这里按 5xx 算不可达
    globalThis.fetch = async () => ({ status: 503, ok: false })
    const p2 = await probe('https://a/')
    ok(p2.ok === true && p2.reachable === false, 'HTTP 503 → 不可达')

    // 4xx：镜像站对 HEAD 返回 403 很常见，仍算「服务在」
    globalThis.fetch = async () => ({ status: 403, ok: false })
    const p3 = await probe('https://a/')
    ok(p3.reachable === true, 'HTTP 403 仍算服务在（镜像常见）')

    // 超时要与不可达分开
    globalThis.fetch = async () => {
      const e = new Error('timed out')
      e.name = 'TimeoutError'
      throw e
    }
    const p4 = await probe('https://a/')
    ok(p4.ok === false && p4.timeout === true, '超时单独标记')
    ok(p4.reason.includes('超时'), '超时说明里写明')

    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    const p5 = await probe('https://a/')
    ok(p5.ok === false && p5.timeout === false, '连接失败不算超时')
    ok(p5.reason.includes('ECONNREFUSED'), '带出原始原因')

    // 非法地址不发起请求
    let called = 0
    globalThis.fetch = async () => { called += 1; return { status: 200 } }
    const p6 = await probe('file:///etc/passwd')
    ok(p6.ok === false && p6.reason.includes('不是合法地址'), '非法协议被拒')
    ok(called === 0, '非法地址没有发起请求')

    // probeAll：排序与探测器路径
    const seen = []
    globalThis.fetch = async (url) => { seen.push(url); return { status: 200 } }
    const all = await probeAll('npm', { timeout: 1000 })
    ok(all.ok === true && all.results.length === 5, `npm 有 5 个（4 镜像 + 原源，实际 ${all.results.length}）`)
    ok(all.results.some((x) => x.official === true), '包含原源做对照')
    ok(seen.every((u) => u.endsWith('/-/ping')), '用的是轻量 ping 端点，不拉真包')
    const sorted = all.results.every((x, i, arr) => i === 0 || (arr[i - 1].ms <= x.ms))
    ok(sorted, '按延迟升序')

    // 不可达的排在后面
    let n = 0
    globalThis.fetch = async () => { n += 1; if (n === 1) throw new Error('x'); return { status: 200 } }
    const all2 = await probeAll('npm', { timeout: 1000 })
    ok(all2.results[0].ok === true, '可达的排在前面')

    // probeCustom
    globalThis.fetch = async () => ({ status: 200 })
    const pc = await probeCustom('https://my.mirror/npm/', 'npm', { timeout: 1000 })
    ok(pc.ok === true && pc.probeUrl === 'https://my.mirror/npm/-/ping', '自定义地址按 kind 推导探测路径')
    const pc2 = await probeCustom('https://x/', null, { timeout: 1000 })
    ok(pc2.probeUrl === 'https://x/', '没有 kind 时直接用原地址')
  } finally {
    globalThis.fetch = realFetch
  }

  // ————— 十、HTTP 接口与工具 —————
  console.log('\n十、HTTP 接口与工具')
  const realFetch2 = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, ok: true })
  try {
    const ctx = fakeApiCtx()
    applyPlugin(ctx, { enabled: true, dir: join(tmpdir(), 'dtj-mirror-plugin') })
    await new Promise((r) => setTimeout(r, 80))
    const handler = ctx._handler()
    ok(typeof handler === 'function', 'API handler 已注册')

    const list = await call(handler, 'GET', '/api/dsh-journal/mirrors')
    ok(list.status === 200 && list.body.ok === true, 'GET /mirrors 200')
    ok(list.body.entries.length === CATALOG.length, '返回全部项')

    const cat = await call(handler, 'GET', '/api/dsh-journal/mirrors/catalog')
    ok(cat.status === 200 && cat.body.entries.length === CATALOG.length, 'catalog 返回清单')

    const noConfirm = await call(handler, 'POST', '/api/dsh-journal/mirrors/apply', { id: 'npm', url: 'https://x/' })
    ok(noConfirm.status === 400, '缺 confirm → 400')

    const noId = await call(handler, 'POST', '/api/dsh-journal/mirrors/apply', { confirm: true })
    ok(noId.status === 400, '缺 id → 400')

    const rootRefuse = await call(handler, 'POST', '/api/dsh-journal/mirrors/apply', {
      // url 用字符串：Docker 该项要 root，会在格式校验之后被拦。
      id: 'docker', url: 'https://x/', confirm: true,
    })
    ok(rootRefuse.status === 400, 'Docker 需 root → 400')
    ok(rootRefuse.body.reason.includes('root'), '响应里说明需要 root')
    ok(rootRefuse.body.file === '/etc/docker/daemon.json', '响应里带出要改的文件')

    const probeApi = await call(handler, 'POST', '/api/dsh-journal/mirrors/probe', { id: 'npm' })
    ok(probeApi.status === 200 && probeApi.body.results.length > 0, '测速接口返回结果')

    const probeUrl = await call(handler, 'POST', '/api/dsh-journal/mirrors/probe', { url: 'https://my/', id: 'npm' })
    ok(probeUrl.status === 200 && probeUrl.body.url === 'https://my/', '测单个地址')

    const probeNoArg = await call(handler, 'POST', '/api/dsh-journal/mirrors/probe', {})
    ok(probeNoArg.status === 400, '既没 id 也没 url → 400')

    const unknown = await call(handler, 'GET', '/api/dsh-journal/mirrors/nope')
    ok(unknown.status === 404, '未知镜像接口 → 404')

    const tool = ctx._tools.find((t) => t.name === 'journal_mirrors')
    ok(tool !== undefined, 'journal_mirrors 工具已注册')
    const exec = { agent: { session: { id: 's' } }, signal: undefined }
    const tList = await tool.execute({ action: 'list' }, exec)
    ok(tList.ok === true && tList.message.includes('npm'), '工具 list 列出工具名')
    ok(tList.message.includes('模型不代劳'), '工具明确不代替人改配置')
    const tProbe = await tool.execute({ action: 'probe', id: 'npm' }, exec)
    ok(tProbe.ok === true && tProbe.message.includes('ms'), '工具 probe 给出延迟')
    const tBad = await tool.execute({ action: 'apply', id: 'npm' }, exec).catch((e) => ({ ok: false, code: e?.code }))
    ok(tBad.ok === false, '工具没有 apply 动作（换源必须人来点）')
  } finally {
    globalThis.fetch = realFetch2
  }

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
