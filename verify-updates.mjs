#!/usr/bin/env node
/**
 * dsh-task-journal / 插件更新 自测。
 *
 *   node verify-updates.mjs
 *
 * 不依赖 DSH 宿主，也不联网：自己造 `pluginManager` / `pluginMarket` / registry
 * 的假实现，把「检查 → 拦截 → 升级」整条路走一遍，断言：
 *   - 语义化版本比较与范围判断（口径必须与 DSH 的 includePrerelease 一致）；
 *   - 市场可用时用市场，市场缺失时退到 npm registry；
 *   - 兼容性不过的包被拦下，绝不走到「先移除」那一步；
 *   - 升级严格是「先移除、再安装」，顺序与参数都对；
 *   - 只升级已安装、可移除、来源是 registry 的包；
 *   - 本地链接/仓库来源不参与；
 *   - 移除成功但安装失败时如实说明（不能假装还是旧版本）；
 *   - HTTP 接口与模型工具都已接上。
 */
import { compareVersions, parseVersion, satisfies } from './lib/semver.js'
import { makeUpdateService, sourceKind, statusLabel, dshRuntimeVersion } from './lib/updates.js'
import { apply } from './lib/index.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

// ————————————————————————— 假件 —————————————————————————

/** 假的 pluginManager：记录调用顺序，按脚本返回结果。 */
function fakeManager(bundles, script = {}) {
  const calls = []
  return {
    calls,
    async listBundles() { return bundles },
    async removeBundle(name) {
      calls.push(['remove', name])
      if (script.removeThrows !== undefined) throw new Error(script.removeThrows)
      return script.remove?.(name) ?? { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async installBundle(spec, options) {
      calls.push(['install', spec, options])
      if (script.installThrows !== undefined) throw new Error(script.installThrows)
      return script.install?.(spec) ?? { changed: true, application: 'applied', stage: 'install', target: spec, version: spec.split('@').pop() }
    },
  }
}

/** 假的 pluginMarket：索引 + 条目表。 */
function fakeMarket(indexes, entries) {
  return {
    listIndexes() { return indexes },
    async entry(url, name) {
      const table = entries[url]
      if (table === undefined) throw new Error(`unknown index ${url}`)
      return table[name]
    },
  }
}

/** market 条目：默认版本 + 安装 spec + 兼容性。 */
function marketEntry(name, latest, installed, opts = {}) {
  return {
    name,
    versions: [{ version: latest, install: { spec: `${name}@${latest}` }, compatibility: { compatible: opts.compatible !== false }, engines: opts.engines }],
    defaultVersion: latest,
    installation: { status: installed === undefined ? 'not-found' : opts.status ?? 'update-available', installedVersion: installed },
  }
}

/** 假的 fetch：按包名返回 registry 元数据。 */
function fakeFetch(table) {
  return async (url) => {
    const name = decodeURIComponent(url.split('/').slice(3).join('/')).replace('%2f', '/')
    const hit = table[name] ?? table[url]
    if (hit === undefined) return { ok: false, status: 404, async json() { return null } }
    return { ok: true, status: 200, async json() { return hit } }
  }
}

const npmMeta = (latest, engines) => ({
  'dist-tags': { latest },
  versions: { [latest]: engines === undefined ? {} : { engines: { dsh: engines } } },
})

/** 造一个已安装组合包。 */
const bundle = (name, version, extra = {}) => ({
  name, version, installed: true, enabled: true, removable: true, official: false, availability: 'profile', ...extra,
})

/** 只给 pluginManager 的 ctx。 */
const ctxWith = (services) => ({
  get: (name) => services[name],
  logger: { info() {}, warn() {} },
})

// ————————————————————————— 主流程 —————————————————————————

const main = async () => {
  // ————— 一、语义化版本 —————
  console.log('一、语义化版本')
  ok(parseVersion('1.2.3') !== null && parseVersion('v1.2.3') !== null, '认识 1.2.3 与 v1.2.3')
  ok(parseVersion('1.2') === null && parseVersion('x') === null, '不认识 1.2 与 x')
  ok(parseVersion('1.2.3-alpha.1')?.pre.join('.') === 'alpha.1', '拆出先行版本号')
  ok(compareVersions('1.0.0-alpha', '1.0.0') === -1, '先行版本号小于正式版')
  ok(compareVersions('1.0.0', '1.0.0') === 0, '相等')
  ok(compareVersions('2.0.0', '1.9.9') === 1, '主版本优先')
  ok(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10') === -1, '先行号里的数字按数值比')
  ok(compareVersions('bad', '1.0.0') === null, '不合法返回 null')
  // 关键：口径必须和 DSH 的 `satisfies(v, r, { includePrerelease: true })` 一致。
  ok(satisfies('0.2.1-alpha.5', '>=0.1.7-rc.2') === true,
    'includePrerelease 口径：alpha 运行时满足 >=0.1.7-rc.2（比标准 semver 宽）')
  ok(satisfies('0.2.1-alpha.5', '>=0.2.1-rc.2') === false,
    'alpha 小于同元组的 rc，被正确判为不满足')
  ok(satisfies('0.2.1', '>=0.2.1-rc.2') === true, '正式版满足带先行号的 >=')
  ok(satisfies('1.2.3', '^1.2.0') === true && satisfies('2.0.0', '^1.2.0') === false, '^ 范围')
  ok(satisfies('1.2.9', '~1.2.0') === true && satisfies('1.3.0', '~1.2.0') === false, '~ 范围')
  ok(satisfies('0.2.5', '^0.2.3') === true && satisfies('0.3.0', '^0.2.3') === false, '^0.x 只放到下一个次版本')
  ok(satisfies('1.5.0', '>=1.0.0 <2.0.0') === true && satisfies('2.0.0', '>=1.0.0 <2.0.0') === false,
    '空格是「与」')
  ok(satisfies('1.0.0', '^2.0.0 || ^1.0.0') === true, '|| 是「或」')
  ok(satisfies('1.0.0', 'banana') === null, '认不出的范围返回 null（未知，不当通过）')
  ok(satisfies('not-a-version', '^1.0.0') === null, '版本不合法返回 null')
  ok(satisfies('2.0.0', '*') === null, '不支持通配，老实返回 null')

  // ————— 二、来源判定 —————
  console.log('\n二、来源判定')
  ok(sourceKind('dsh-repair') === 'registry', '裸包名走 registry')
  ok(sourceKind('@scope/pkg') === 'registry', '作用域包名走 registry')
  ok(sourceKind('link:/home/a/b') === 'local', 'link: 是本地')
  ok(sourceKind('/home/a/b') === 'local', '绝对路径是本地')
  ok(sourceKind('git+https://x/y.git#abc') === 'local', 'git 来源不参与 registry 升级')
  ok(sourceKind('github:a/b') === 'local', 'github: 来源不参与')
  ok(sourceKind(null) === 'registry', '来源未知时按 registry 处理')

  // ————— 三、能力探测 —————
  console.log('\n三、能力探测')
  const none = makeUpdateService({ ctx: ctxWith({}) })
  ok(none.available().available === false, '没有 pluginManager 时报告不可用')
  ok(none.available().reason.includes('pluginManager'), '原因点明缺哪个服务')
  const partial = makeUpdateService({ ctx: ctxWith({ pluginManager: { listBundles() {} } }) })
  ok(partial.available().available === false, '服务只挂了一半也算不可用')
  ok(partial.available().reason.includes('removeBundle'), '原因点明缺哪个方法')
  const bare = makeUpdateService({ ctx: ctxWith({ pluginManager: fakeManager([]) }) })
  ok(bare.available().available === true, '只有 pluginManager 也可用（退到 registry）')
  ok(bare.available().market === false, '如实报告市场不在')

  // ————— 四、市场路径 —————
  console.log('\n四、市场路径')
  const INDEX = 'https://market.example/index.json'
  const mgr4 = fakeManager([
    bundle('dsh-a', '1.0.0'),
    bundle('dsh-b', '2.0.0'),
    bundle('dsh-locked', '1.0.0', { removable: false }),
  ])
  const mkt4 = fakeMarket([{ url: INDEX, title: '测试市场' }], {
    [INDEX]: {
      'dsh-a': marketEntry('dsh-a', '1.2.0', '1.0.0'),
      'dsh-b': marketEntry('dsh-b', '2.0.0', '2.0.0', { status: 'installed' }),
      'dsh-locked': marketEntry('dsh-locked', '1.1.0', '1.0.0'),
    },
  })
  const svc4 = makeUpdateService({ ctx: ctxWith({ pluginManager: mgr4, pluginMarket: mkt4 }) })
  const rep4 = await svc4.list()
  ok(rep4.ok === true && rep4.source === 'market', '有市场时用市场作为版本来源')
  ok(rep4.counts.installed === 3, '列出 3 个已安装插件')
  ok(rep4.counts.updatable === 2, '2 个有更新（dsh-a 与 dsh-locked）')
  ok(rep4.counts.appliable === 1, '其中只有 1 个可一键升级（不可移除的不算）')
  ok(rep4.plugins.find((p) => p.name === 'dsh-b').market.status === 'installed', '已是最新的标 installed')
  ok(rep4.plugins.find((p) => p.name === 'dsh-locked').updatable === true, '不可移除但有更新的仍标出可更新')
  ok(rep4.indexes[0].title === '测试市场', '返回索引标题')

  // 市场里没有的包 → unknown
  const mkt4b = fakeMarket([{ url: INDEX }], { [INDEX]: {} })
  const rep4b = await makeUpdateService({ ctx: ctxWith({ pluginManager: mgr4, pluginMarket: mkt4b }) }).list()
  ok(rep4b.plugins.every((p) => p.market.status === 'unknown'), '市场没收录的包标 unknown')

  // 索引报错 → 不抛给调用方，且退回 registry 前先如实报告
  const mkt4c = fakeMarket([{ url: INDEX, error: '取不到' }], {})
  const rep4c = await makeUpdateService({ ctx: ctxWith({ pluginManager: mgr4, pluginMarket: mkt4c }) }).list()
  ok(rep4c.ok === true, '索引不可用时 list 仍然成功')
  ok(rep4c.indexes[0].error === '取不到', '索引错误如实带出')

  // ————— 五、registry 退路 —————
  console.log('\n五、registry 退路')
  const RUNTIME = '0.2.1-alpha.5'
  const mgr5 = fakeManager([
    bundle('dsh-new', '1.0.0'),
    bundle('dsh-same', '1.0.0'),
    bundle('dsh-old', '2.0.0'),
    bundle('dsh-incompat', '1.0.0'),
    bundle('dsh-local', '1.0.0', { source: 'link:/home/wsn/x' }),
    bundle('dsh-weird', 'not-semver'),
  ])
  const fetcher = fakeFetch({
    'dsh-new': npmMeta('1.3.0', '>=0.1.0'),
    'dsh-same': npmMeta('1.0.0'),
    'dsh-old': npmMeta('1.5.0'),
    'dsh-incompat': npmMeta('2.0.0', '>=0.2.1-rc.2'),
    'dsh-weird': npmMeta('9.9.9'),
  })
  const svc5 = makeUpdateService({
    ctx: ctxWith({ pluginManager: mgr5 }),
    fetchImpl: fetcher,
    registry: 'https://registry.example',
  })
  const rep5 = await svc5.list()
  ok(rep5.source === 'registry', '市场缺失时退到 registry')
  ok(rep5.registry === 'https://registry.example', '回报实际使用的 registry')
  const by5 = (n) => rep5.plugins.find((p) => p.name === n)
  ok(by5('dsh-new').market.status === 'update-available', 'registry 里更高的版本判为可更新')
  ok(by5('dsh-same').market.status === 'installed', '版本相同判为已最新')
  ok(by5('dsh-old').market.status === 'different-version', '已安装更高时不说「有更新」')
  ok(by5('dsh-local').market.status === 'local', '本地链接来源不查 registry')
  ok(by5('dsh-weird').market.status === 'different-version', '已安装版本不合法时不比较')
  ok(by5('dsh-new').updatable === true, '兼容的包可升级')
  ok(by5('dsh-incompat').updatable === false, 'engines.dsh 不满足的包不可升级')
  ok(typeof by5('dsh-incompat').blocked === 'string' && by5('dsh-incompat').blocked.includes('0.2.1-rc.2'),
    '拦下时说明要求哪个运行时')
  ok(rep5.counts.blocked === 1, '被兼容性拦下的计数为 1')
  ok(rep5.runtime === RUNTIME || rep5.runtime === dshRuntimeVersion(), '回报运行时版本')

  // registry 不可达 → unknown，不抛
  const svc5b = makeUpdateService({
    ctx: ctxWith({ pluginManager: mgr5 }),
    fetchImpl: async () => { throw new Error('网络不通') },
  })
  const rep5b = await svc5b.list()
  ok(rep5b.ok === true, 'registry 不可达时 list 仍成功')
  ok(rep5b.plugins.every((p) => p.market.status === 'unknown' || p.market.status === 'local' || p.market.status === 'different-version'),
    '取不到版本时标 unknown，不瞎猜')

  // ————— 六、升级：拦截 —————
  console.log('\n六、升级的拦截')
  const mgr6 = fakeManager([
    bundle('dsh-new', '1.0.0'),
    bundle('dsh-incompat', '1.0.0'),
    bundle('dsh-same', '1.0.0'),
    bundle('dsh-local', '1.0.0', { source: 'link:/tmp/x' }),
    bundle('dsh-locked', '1.0.0', { removable: false }),
  ])
  const svc6 = makeUpdateService({
    ctx: ctxWith({ pluginManager: mgr6 }),
    fetchImpl: fakeFetch({
      'dsh-new': npmMeta('1.3.0'),
      'dsh-incompat': npmMeta('2.0.0', '>=0.2.1-rc.2'),
      'dsh-same': npmMeta('1.0.0'),
      'dsh-locked': npmMeta('1.1.0'),
    }),
  })
  ok((await svc6.apply('dsh-new', {})).ok === false, '缺 confirm 被拒')
  const notInstalled = await svc6.apply('left-pad', { confirm: true })
  ok(notInstalled.ok === false && notInstalled.reason.includes('没有安装'), '未安装的包被拒（不能当安装器用）')
  const noUpdate = await svc6.apply('dsh-same', { confirm: true })
  ok(noUpdate.ok === false && noUpdate.reason.includes('没有可用更新'), '没有更新的包被拒')
  const blocked = await svc6.apply('dsh-incompat', { confirm: true })
  ok(blocked.ok === false && blocked.reason.includes('不能升'), '兼容性不过的包被拒')
  const locked = await svc6.apply('dsh-locked', { confirm: true })
  ok(locked.ok === false && locked.reason.includes('不可移除'), '不可移除的包被拒')
  const local = await svc6.apply('dsh-local', { confirm: true })
  ok(local.ok === false && local.reason.includes('本地链接'), '本地来源的包被拒，且原因说清楚')
  // 关键：任何一次拦截都不该碰过 manager
  ok(mgr6.calls.length === 0, '全部拦截都没有调用 removeBundle/installBundle')

  // ————— 七、升级：正常路径 —————
  console.log('\n七、升级的正常路径')
  const mgr7 = fakeManager([bundle('dsh-new', '1.0.0')])
  const svc7 = makeUpdateService({
    ctx: ctxWith({ pluginManager: mgr7 }),
    fetchImpl: fakeFetch({ 'dsh-new': npmMeta('1.3.0') }),
  })
  const done = await svc7.apply('dsh-new', { confirm: true })
  ok(done.ok === true, '升级成功')
  ok(done.from === '1.0.0' && done.to === '1.3.0', '报出从哪个版本到哪个版本')
  ok(done.spec === 'dsh-new@1.3.0', 'spec 由来源推导（调用方无从指定）')
  ok(mgr7.calls.length === 2, '恰好两步')
  ok(mgr7.calls[0][0] === 'remove' && mgr7.calls[0][1] === 'dsh-new', '第一步是移除旧版')
  ok(mgr7.calls[1][0] === 'install' && mgr7.calls[1][1] === 'dsh-new@1.3.0', '第二步是安装新版')
  ok(mgr7.calls[1][2]?.enabled === true, '沿用升级前的启用状态')
  ok(done.steps.length === 2 && done.steps[0].step === 'remove' && done.steps[1].step === 'install', '两步结果都回报')

  // 未启用的包升级后仍保持未启用
  const mgr7b = fakeManager([bundle('dsh-off', '1.0.0', { enabled: false })])
  const svc7b = makeUpdateService({
    ctx: ctxWith({ pluginManager: mgr7b }),
    fetchImpl: fakeFetch({ 'dsh-off': npmMeta('1.1.0') }),
  })
  await svc7b.apply('dsh-off', { confirm: true })
  ok(mgr7b.calls[1][2]?.enabled === false, '未启用的包升级后仍未启用')

  // ————— 八、升级：失败处理 —————
  console.log('\n八、升级的失败处理')
  const mgr8 = fakeManager([bundle('dsh-x', '1.0.0')], {
    remove: () => ({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-x', error: { code: 'not-removable' } }),
  })
  const svc8 = makeUpdateService({
    ctx: ctxWith({ pluginManager: mgr8 }),
    fetchImpl: fakeFetch({ 'dsh-x': npmMeta('1.1.0') }),
  })
  const rmFail = await svc8.apply('dsh-x', { confirm: true })
  ok(rmFail.ok === false, '移除失败时升级失败')
  ok(mgr8.calls.filter((c) => c[0] === 'install').length === 0, '移除失败后绝不再安装')

  const mgr8b = fakeManager([bundle('dsh-y', '1.0.0')], { removeThrows: '不允许' })
  const svc8b = makeUpdateService({
    ctx: ctxWith({ pluginManager: mgr8b }),
    fetchImpl: fakeFetch({ 'dsh-y': npmMeta('1.1.0') }),
  })
  const rmThrow = await svc8b.apply('dsh-y', { confirm: true })
  ok(rmThrow.ok === false && rmThrow.reason.includes('移除'), '移除抛异常时如实报告')

  const mgr8c = fakeManager([bundle('dsh-z', '1.0.0')], { installThrows: '装不上' })
  const svc8c = makeUpdateService({
    ctx: ctxWith({ pluginManager: mgr8c }),
    fetchImpl: fakeFetch({ 'dsh-z': npmMeta('1.1.0') }),
  })
  const instThrow = await svc8c.apply('dsh-z', { confirm: true })
  ok(instThrow.ok === false, '安装失败时升级失败')
  ok(instThrow.reason.includes('未安装状态'), '明确指出插件现在处于未安装状态（不假装还是旧版）')

  // stop-profile：移除要等重启 → 不安装
  const mgr8d = fakeManager([bundle('dsh-w', '1.0.0')], {
    remove: () => ({ changed: false, application: 'restart-required', stage: 'remove', target: 'dsh-w', error: { code: 'stop-profile' } }),
  })
  const svc8d = makeUpdateService({
    ctx: ctxWith({ pluginManager: mgr8d }),
    fetchImpl: fakeFetch({ 'dsh-w': npmMeta('1.1.0') }),
  })
  const stop = await svc8d.apply('dsh-w', { confirm: true })
  ok(stop.ok === false && stop.reason.includes('下次启动'), 'stop-profile 时不继续安装')
  ok(mgr8d.calls.filter((c) => c[0] === 'install').length === 0, 'stop-profile 后没有安装')

  // restart-required 安装 → 成功但提示重启
  const mgr8e = fakeManager([bundle('dsh-v', '1.0.0')], {
    install: () => ({ changed: true, application: 'restart-required', stage: 'install', target: 'dsh-v@1.1.0', version: '1.1.0', restartReason: 'host-restart' }),
  })
  const svc8e = makeUpdateService({
    ctx: ctxWith({ pluginManager: mgr8e }),
    fetchImpl: fakeFetch({ 'dsh-v': npmMeta('1.1.0') }),
  })
  const rst = await svc8e.apply('dsh-v', { confirm: true })
  ok(rst.ok === true && rst.application === 'restart-required', '装完需要重启时仍算成功并带出原因')

  // ————— 九、状态文案 —————
  console.log('\n九、状态文案')
  ok(statusLabel('installed') === '已是最新', 'installed → 已是最新')
  ok(statusLabel('update-available') === '可更新', 'update-available → 可更新')
  ok(statusLabel('local') === '本地来源', 'local → 本地来源')
  ok(statusLabel('不存在的东西') === '未知', '未知状态有兜底')

  // ————— 十、HTTP 接口与工具 —————
  console.log('\n十、HTTP 接口与工具')
  const ctx = fakeApiCtx({ pluginManager: mgr5, pluginMarket: null })
  apply(ctx, { enabled: true, dir: '/tmp/dtj-updates-none' })
  await new Promise((r) => setTimeout(r, 60))
  // 把 registry 换成假 fetch：这里直接替换全局 fetch 最省事，且只在本进程内生效。
  const realFetch = globalThis.fetch
  globalThis.fetch = fakeFetch({
    'dsh-new': npmMeta('1.3.0', '>=0.1.0'),
    'dsh-same': npmMeta('1.0.0'),
    'dsh-old': npmMeta('1.5.0'),
    'dsh-incompat': npmMeta('2.0.0', '>=0.2.1-rc.2'),
    'dsh-weird': npmMeta('9.9.9'),
  })
  try {
    const handler = ctx._handler()
    ok(typeof handler === 'function', 'API handler 已注册')
    const list = await call(handler, 'GET', '/api/dsh-journal/updates')
    ok(list.status === 200 && list.body.ok === true, 'GET /updates 返回 200 且 ok')
    ok(list.body.counts.installed === 6, `列出 6 个已安装插件（实际 ${list.body.counts.installed}）`)

    const noConfirm = await call(handler, 'POST', '/api/dsh-journal/updates/apply', { name: 'dsh-new' })
    ok(noConfirm.status === 400, '缺 confirm → 400')
    ok(String(noConfirm.body.error).includes('confirm'), '错误说明要 confirm')

    const noName = await call(handler, 'POST', '/api/dsh-journal/updates/apply', { confirm: true })
    ok(noName.status === 400, '缺包名 → 400')

    const badName = await call(handler, 'POST', '/api/dsh-journal/updates/apply', { name: 'left-pad', confirm: true })
    ok(badName.status === 400 && badName.body.ok === false, '未安装的包 → 400')

    const unknown = await call(handler, 'GET', '/api/dsh-journal/updates/nope')
    ok(unknown.status === 404, '未知更新接口 → 404')

    // 工具
    const tool = ctx._tools.find((t) => t.name === 'journal_updates')
    ok(tool !== undefined, 'journal_updates 工具已注册')
    const exec = { agent: { session: { id: 's' } }, signal: undefined }
    const tList = await tool.execute({ action: 'list' }, exec)
    ok(tList.ok === true && tList.message.includes('已安装 6 个插件'), '工具 list 输出摘要')
    ok(tList.message.includes('dsh-new'), '工具 list 列出插件名')
    const tNoConfirm = await tool.execute({ action: 'apply', name: 'dsh-new' }, exec)
    ok(tNoConfirm.ok === false && tNoConfirm.message.includes('confirm'), '工具 apply 缺 confirm 时拒绝')
    const tNoName = await tool.execute({ action: 'apply', confirm: true }, exec)
    ok(tNoName.ok === false, '工具 apply 缺包名时拒绝')
  } finally {
    globalThis.fetch = realFetch
  }

  // 服务不可用时接口与工具的降级
  const ctxOff = fakeApiCtx({})
  apply(ctxOff, { enabled: true, dir: '/tmp/dtj-updates-none' })
  await new Promise((r) => setTimeout(r, 60))
  const offHandler = ctxOff._handler()
  const offList = await call(offHandler, 'GET', '/api/dsh-journal/updates')
  ok(offList.status === 503, '没有插件管理服务时接口返回 503')
  ok(offList.body.ok === false && typeof offList.body.reason === 'string', '503 里带明确原因')
  const offTool = ctxOff._tools.find((t) => t.name === 'journal_updates')
  const offExec = await offTool.execute({ action: 'list' }, { agent: { session: { id: 's' } }, signal: undefined })
  ok(offExec.ok === false && offExec.message.includes('pluginManager'), '工具在不可用时说清楚缺什么')

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// ————————————————————————— 接口测试用的假 ctx —————————————————————————

function fakeApiCtx(services) {
  const tools = []
  let handler = null
  return {
    logger: { info() {}, warn() {} },
    on() { return () => {} },
    effect(fn) { return fn() },
    get: (name) => services[name],
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

main().catch((e) => {
  console.error('\n自测自身异常：', e)
  process.exit(1)
})
