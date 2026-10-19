#!/usr/bin/env node
/**
 * dsh-task-journal / 插件管理 自测。
 *
 *   node verify-plugins.mjs
 *
 * 不依赖 DSH 宿主、不联网、不动真实 profile：自己造 `pluginManager` 的假实现，
 * 把「列表 → 拦截 → 安装 → 删除」整条路走一遍，并断言 HTTP 接口的护栏。
 *
 * 重点断言的是**拒绝路径**：这个模块能改 profile、能装任意代码，
 * 写操作放错一次就够糟了，所以每条护栏都要有用例盯着。
 */
import { createServer } from 'node:http'
import { makePluginAdminService, validateSpec, summarise, SELF_PACKAGE } from './lib/plugins.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

// ————————————————————————— 假宿主 —————————————————————————

/** 假的 pluginManager：记录调用，按脚本返回。 */
function fakeManager(bundles, script = {}) {
  const calls = []
  return {
    calls,
    async listBundles() {
      if (script.listThrows !== undefined) throw new Error(script.listThrows)
      return bundles
    },
    async installBundle(spec, options) {
      calls.push(['install', spec, options])
      if (script.installThrows !== undefined) throw new Error(script.installThrows)
      return script.install?.(spec, options) ?? {
        changed: true, application: 'restart-required', restartReason: 'no-hmr',
        stage: 'install', target: spec, version: '9.9.9',
      }
    },
    async removeBundle(name) {
      calls.push(['remove', name])
      if (script.removeThrows !== undefined) throw new Error(script.removeThrows)
      return script.remove?.(name) ?? {
        changed: true, application: 'restart-required', restartReason: 'no-hmr',
        stage: 'remove', target: name,
      }
    },
  }
}

/** 只提供部分方法的假 ctx，用来测「服务缺失/方法缺失」。 */
const ctxWith = (service) => ({ get: (name) => (name === 'pluginManager' ? service : undefined) })

/** 一份典型的组合包列表。 */
const BUNDLES = [
  {
    name: 'dsh-task-journal', version: '0.9.0', installed: true, enabled: true,
    removable: true, official: false, optional: false, availability: 'profile',
    description: '任务日志插件',
  },
  {
    name: 'dsh-base', version: '1.0.0', installed: true, enabled: true,
    removable: false, official: true, optional: false, availability: 'installation',
    description: '随安装提供的核心包',
  },
  {
    name: 'dsh-broken', version: '0.1.0', installed: true, enabled: false,
    removable: true, official: false, optional: false, availability: 'profile',
    error: { code: 'load-failed', message: '入口文件缺失' },
  },
  {
    name: 'dsh-optional', version: '2.0.0', installed: false, enabled: false,
    removable: false, official: true, optional: true, availability: 'installation',
    description: '可选但未启用',
    installTarget: { spec: 'dsh-optional@2.0.0', version: '2.0.0' },
  },
]

// ————————————————————————— 主流程 —————————————————————————

const main = async () => {
  console.log('一、spec 校验')
  ok(validateSpec('').ok === false, '空 spec 被拒')
  ok(validateSpec('   ').ok === false, '纯空白 spec 被拒')
  ok(validateSpec('-g').ok === false, '以 - 开头被拒（会被当成 pnpm 选项）')
  ok(validateSpec('--registry=http://evil').ok === false, '长选项被拒')
  ok(validateSpec('a\u0000b').ok === false, '控制字符被拒')
  ok(validateSpec('x'.repeat(600)).ok === false, '超长 spec 被拒')
  ok(validateSpec('dsh-foo').ok === true, '普通包名通过')
  ok(validateSpec('  dsh-foo  ').spec === 'dsh-foo', '首尾空白被裁掉')
  ok(validateSpec('/abs/path').ok === true, '绝对路径通过')
  ok(validateSpec('github:owner/repo').ok === true, 'git 简写通过')

  console.log('\n二、结果摘要')
  const sm = summarise({ changed: true, application: 'restart-required', stage: 'install', target: 'x', version: '1.2.3', restartReason: 'no-hmr' })
  ok(sm.application === 'restart-required' && sm.version === '1.2.3', '摘要保留关键字段')
  ok(summarise(null).application === null, 'null 输入不炸')
  const smErr = summarise({ application: 'failed', error: { code: 'permission', message: '拒绝访问' } })
  ok(smErr.error.code === 'permission', '错误码被保留')

  console.log('\n三、服务可用性')
  const noSvc = makePluginAdminService({ ctx: ctxWith(undefined) })
  const a1 = noSvc.available()
  ok(a1.available === false && typeof a1.reason === 'string', '没有 pluginManager 时如实报不可用')
  const badSvc = makePluginAdminService({ ctx: ctxWith({ listBundles() {} }) })
  const a2 = badSvc.available()
  ok(a2.available === false && a2.reason.includes('缺少方法'), '方法不全时指出缺什么')
  const r0 = await noSvc.list()
  ok(r0.ok === false, '服务缺失时 list 返回 ok:false')
  const i0 = await noSvc.install('dsh-x', { confirm: true })
  ok(i0.ok === false, '服务缺失时 install 不硬撑')
  const d0 = await noSvc.remove('dsh-x', { confirm: true })
  ok(d0.ok === false, '服务缺失时 remove 不硬撑')

  console.log('\n四、列表与可操作性')
  const svc = makePluginAdminService({ ctx: ctxWith(fakeManager(BUNDLES)) })
  ok(svc.available().available === true, '服务齐全时可用')
  const ls = await svc.list()
  ok(ls.ok === true, 'list 成功')
  ok(ls.counts.total === 4 && ls.counts.installed === 3, '计数正确（4 总 / 3 已装）')
  const self = ls.plugins.find((p) => p.name === SELF_PACKAGE)
  ok(self.isSelf === true && self.canRemove === false, '自己不可删除')
  ok(typeof self.blocked === 'string' && self.blocked.includes('自己'), '自己被标出原因')
  const base = ls.plugins.find((p) => p.name === 'dsh-base')
  ok(base.canRemove === false && base.blocked.includes('随 DSH 安装提供'), '随安装提供的不可删')
  const broken = ls.plugins.find((p) => p.name === 'dsh-broken')
  ok(broken.canRemove === false && broken.blocked.includes('加载错误'), '有加载错误的不可删')
  const opt = ls.plugins.find((p) => p.name === 'dsh-optional')
  ok(opt.installed === false && opt.installTarget?.version === '2.0.0', '未安装项带安装目标')
  // 这份样本里没有一项真的可删：自己、随安装提供、有加载错误、未安装——各占一种拦截。
  ok(ls.counts.removable === 0, '没有任何一项可删除（四种拦截各占其一）')
  const blockedCount = ls.plugins.filter((p) => p.blocked !== null).length
  ok(blockedCount === ls.counts.blocked, '受限计数与实际标注一致')

  const listThrow = makePluginAdminService({ ctx: ctxWith(fakeManager([], { listThrows: '读不到 profile' })) })
  const lt = await listThrow.list()
  ok(lt.ok === false && lt.reason.includes('读不到 profile'), '读列表失败时如实转述')

  console.log('\n五、安装')
  const mgrI = fakeManager(BUNDLES)
  const svcI = makePluginAdminService({ ctx: ctxWith(mgrI) })
  const noConfirm = await svcI.install('dsh-new', {})
  ok(noConfirm.ok === false && noConfirm.reason.includes('confirm'), '缺 confirm 被拒')
  ok(mgrI.calls.length === 0, '被拒时完全没有调用宿主')
  const badSpec = await svcI.install('-evil', { confirm: true })
  ok(badSpec.ok === false && mgrI.calls.length === 0, '坏 spec 在调用宿主前就被拦下')
  const already = await svcI.install('dsh-base', { confirm: true })
  ok(already.ok === false && already.reason.includes('已经安装'), '已安装的包不再装（避免第二份）')
  ok(mgrI.calls.length === 0, '已安装判断也没碰宿主')

  const okInstall = await svcI.install('dsh-new', { confirm: true })
  ok(okInstall.ok === true, '正常安装成功')
  ok(mgrI.calls[0][0] === 'install' && mgrI.calls[0][1] === 'dsh-new', '调用参数正确')
  ok(mgrI.calls[0][2].enabled === true, '默认装完即启用')
  ok(okInstall.restartReason === 'no-hmr', '回报需要重启')

  const mgrOff = fakeManager(BUNDLES)
  const svcOff = makePluginAdminService({ ctx: ctxWith(mgrOff) })
  await svcOff.install('dsh-new', { confirm: true, enabled: false })
  ok(mgrOff.calls[0][2].enabled === false, 'enabled:false 会传下去')

  const failInstall = makePluginAdminService({
    ctx: ctxWith(fakeManager(BUNDLES, {
      install: () => ({ changed: false, application: 'failed', stage: 'install', target: 'x', error: { code: 'network', message: '连不上 registry' } }),
    })),
  })
  const fi = await failInstall.install('dsh-new', { confirm: true })
  ok(fi.ok === false && fi.reason.includes('连不上 registry'), '安装失败时转述宿主原因')

  const throwInstall = makePluginAdminService({
    ctx: ctxWith(fakeManager(BUNDLES, { installThrows: 'pnpm 不在 PATH' })),
  })
  const ti = await throwInstall.install('dsh-new', { confirm: true })
  ok(ti.ok === false && ti.reason.includes('pnpm 不在 PATH'), '安装抛异常时也如实报')

  console.log('\n六、删除')
  const mgrR = fakeManager(BUNDLES)
  const svcR = makePluginAdminService({ ctx: ctxWith(mgrR) })
  const selfRm = await svcR.remove(SELF_PACKAGE, { confirm: true })
  ok(selfRm.ok === false && selfRm.reason.includes('自己'), '删除自己被拒')
  ok(mgrR.calls.length === 0, '删自己被拒时没碰宿主')
  const emptyRm = await svcR.remove('  ', { confirm: true })
  ok(emptyRm.ok === false, '空包名被拒')
  const noConfirmRm = await svcR.remove('dsh-x', {})
  ok(noConfirmRm.ok === false && noConfirmRm.reason.includes('confirm'), '删除缺 confirm 被拒')
  ok(mgrR.calls.length === 0, '缺 confirm 时没碰宿主')

  const notInstalled = await svcR.remove('dsh-optional', { confirm: true })
  ok(notInstalled.ok === false && notInstalled.reason.includes('没有安装'), '未安装的不能删')
  const notRemovable = await svcR.remove('dsh-base', { confirm: true })
  ok(notRemovable.ok === false && notRemovable.reason.includes('随 DSH 安装提供'), '随安装提供的不能删')
  const withError = await svcR.remove('dsh-broken', { confirm: true })
  ok(withError.ok === false && withError.reason.includes('加载错误'), '有加载错误的先修再删')
  ok(mgrR.calls.length === 0, '以上被拒场景都没碰宿主')

  const okRm = await svcR.remove('dsh-task-journal-x', { confirm: true })
  ok(okRm.ok === false, '列表里没有的包不送进 pnpm')

  const mgrOk = fakeManager([
    ...BUNDLES,
    { name: 'dsh-removable', version: '1.0.0', installed: true, enabled: true, removable: true, availability: 'profile' },
  ])
  const svcOk = makePluginAdminService({ ctx: ctxWith(mgrOk) })
  const rm = await svcOk.remove('dsh-removable', { confirm: true })
  ok(rm.ok === true && rm.name === 'dsh-removable', '正常删除成功')
  ok(mgrOk.calls[0][0] === 'remove' && mgrOk.calls[0][1] === 'dsh-removable', '删除调用参数正确')
  ok(rm.needsRestart === true, '无 HMR 时标明需要重启')

  const stopProfile = makePluginAdminService({
    ctx: ctxWith(fakeManager(
      [{ name: 'dsh-r2', installed: true, removable: true, enabled: true, availability: 'profile' }],
      { remove: () => ({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-r2', error: { code: 'stop-profile', message: '运行中' } }) },
    )),
  })
  const sp = await stopProfile.remove('dsh-r2', { confirm: true })
  ok(sp.needsRestart === true && sp.application === 'failed', 'stop-profile 视为需要重启')

  const failRm = makePluginAdminService({
    ctx: ctxWith(fakeManager(
      [{ name: 'dsh-r3', installed: true, removable: true, enabled: true, availability: 'profile' }],
      { remove: () => ({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-r3', error: { code: 'permission', message: '没有写权限' } }) },
    )),
  })
  const fr = await failRm.remove('dsh-r3', { confirm: true })
  ok(fr.ok === false && fr.reason.includes('没有写权限'), '删除失败时转述原因')

  // —— HTTP 接口 ——
  console.log('\n七、HTTP 接口')
  const { handler } = await bootApi(fakeManager(BUNDLES))
  const server = createServer((req, res) => handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const url = (p) => `http://127.0.0.1:${port}/api/dsh-journal${p}`
  const getJson = async (p) => (await fetch(url(p))).json()
  const postJson = async (p, body) => {
    const r = await fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }

  const cap = await getJson('/plugins/capability')
  ok(cap.available === true, 'GET /plugins/capability 报告可用')

  const pl = await getJson('/plugins')
  ok(Array.isArray(pl.plugins) && pl.plugins.length === 4, 'GET /plugins 返回列表')

  const i400 = await postJson('/plugins/install', { spec: 'dsh-new' })
  ok(i400.status === 400 && String(i400.body.error).includes('confirm'), '安装缺 confirm → 400')

  const i400b = await postJson('/plugins/install', { confirm: true })
  ok(i400b.status === 400, '缺 spec → 400')

  const iOk = await postJson('/plugins/install', { spec: 'dsh-new', confirm: true })
  ok(iOk.status === 200 && iOk.body.ok === true, '正常安装 → 200')

  const r400self = await postJson('/plugins/remove', { name: SELF_PACKAGE, confirm: true })
  ok(r400self.status === 400 && String(r400self.body.error).includes('自己'), '删除自己 → 400')

  const r400c = await postJson('/plugins/remove', { name: 'dsh-x' })
  ok(r400c.status === 400 && String(r400c.body.error).includes('confirm'), '删除缺 confirm → 400')

  const r400n = await postJson('/plugins/remove', { confirm: true })
  ok(r400n.status === 400, '删除缺 name → 400')

  const r404 = await fetch(url('/plugins/nope'))
  ok(r404.status === 404, '未知子路径 → 404')

  server.close()

  // 服务缺失时接口给 503，而不是假装成功
  const { handler: h2 } = await bootApi(undefined)
  const s2 = createServer((req, res) => h2(req, res))
  await new Promise((r) => s2.listen(0, '127.0.0.1', r))
  const p2 = s2.address().port
  const cap503 = await (await fetch(`http://127.0.0.1:${p2}/api/dsh-journal/plugins/capability`)).status
  const list503 = await (await fetch(`http://127.0.0.1:${p2}/api/dsh-journal/plugins`)).status
  ok(cap503 === 503 && list503 === 503, '服务缺失时接口返回 503')
  s2.close()

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

/** 起插件，取出它注册的 API handler；`manager` 为 undefined 表示宿主没装服务。 */
async function bootApi(manager) {
  const mod = await import('./lib/index.js')
  const handlers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on: () => () => {},
    effect: (f) => f(),
    get: (name) => (name === 'pluginManager' ? manager : undefined),
    inject: (services, cb) => {
      if (services.includes('webServer')) {
        cb({
          effect: (f) => f(),
          webServer: { register({ handler }) { handlers.push(handler); return () => {} } },
        })
      }
      if (services.includes('tools')) cb({ tools: { register() {} } })
      if (services.includes('agents')) cb({ on: () => () => {} })
    },
    agents: { get: () => undefined, list: () => [] },
  }
  mod.apply(ctx, { enabled: true, notify: false, notifyOnFailure: false })
  return { handler: handlers[0], mod }
}

main().catch((e) => {
  console.error(`\n❌ 自测异常：${e?.stack ?? e}`)
  process.exit(1)
})
