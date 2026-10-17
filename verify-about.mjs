#!/usr/bin/env node
/**
 * dsh-task-journal / 关于 自测。
 *
 *   node verify-about.mjs
 *
 * 不联网：GitHub 用假 fetch。重点断言：
 *   - 各种写法的仓库地址都能还原成可点的链接；
 *   - GitHub 拿不到数据时**不报错而是降级**（一个统计数字不该毁掉整页）；
 *   - 限流不缓存，下次还能重试；成功要缓存，别把额度打光；
 *   - profile 是从磁盘事实查出来的，查不到就如实说「按默认处理」；
 *   - 「磁盘比进程新」这个判断要准 —— 它决定要不要提示「改了没生效」。
 */
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  pluginDir, readManifest, normalizeRepo, gitRemote, commands,
  githubStats, makeReloadTracker, dirStats, gather, dshHome, detectProfiles,
} from './lib/about.js'

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

const main = async () => {
  // ————— 一、仓库地址归一化 —————
  console.log('一、仓库地址归一化')
  ok(normalizeRepo('git@github.com:a/b.git').https === 'https://github.com/a/b', 'SSH 形式')
  ok(normalizeRepo('git@github.com:a/b').https === 'https://github.com/a/b', 'SSH 无 .git')
  ok(normalizeRepo('https://github.com/a/b.git').https === 'https://github.com/a/b', 'HTTPS 形式')
  ok(normalizeRepo('git+https://github.com/a/b.git').https === 'https://github.com/a/b', 'git+ 前缀')
  ok(normalizeRepo('github:a/b').https === 'https://github.com/a/b', 'github: 简写')
  ok(normalizeRepo('https://gitlab.com/a/b.git').https === 'https://gitlab.com/a/b', '非 GitHub 也认')
  ok(normalizeRepo('https://gitlab.com/a/b').slug === null, '非 GitHub 不给 slug（Star 接口只认 GitHub）')
  ok(normalizeRepo('').https === null, '空串返回 null')
  ok(normalizeRepo(null).https === null, 'null 返回 null')
  ok(normalizeRepo('随便一段话').https === null, '认不出就 null，不瞎拼')
  ok(normalizeRepo('git@github.com:a/b.git').slug === 'a/b', 'GitHub 给 slug')

  // ————— 二、自身信息 —————
  console.log('\n二、自身信息')
  const dir = pluginDir()
  // 不要断言目录名里含仓库名 —— 克隆到任意目录（/tmp/freshN）就跑不过。
  // 该断言的是「这里确实是本插件的目录」，也就是它有正确的 package.json。
  const manifest = await readManifest()
  ok(typeof dir === 'string' && dir !== '', `自身目录可定位（${dir}）`)
  ok(manifest !== null && manifest.name === 'dsh-task-journal', '读到的 package.json 就是本插件的')
  ok(Array.isArray(manifest.exports) === false, 'package.json 结构正常')
  ok(manifest.repository !== undefined, '声明了 repository（Star 与链接依赖它）')
  const remote = await gitRemote(dir)
  ok(remote === null || typeof remote === 'string', '读 git 远端不抛异常')

  // ————— 三、安装命令 —————
  console.log('\n三、安装命令')
  const c1 = commands('dsh-task-journal', 'web')
  ok(c1.install === 'dsh plugin --profile web add dsh-task-journal', '安装命令')
  ok(c1.uninstall === 'dsh plugin --profile web remove dsh-task-journal', '卸载命令')
  ok(commands('x', null).install.includes('--profile web'), '没给 profile 时退到 web')
  ok(commands('x', undefined).install.includes('--profile web'), 'undefined 也退到 web')

  // ————— 四、GitHub 数据 —————
  console.log('\n四、GitHub 数据')
  const mkFetch = (impl) => async (url, init) => impl(url, init)
  {
    const r = await githubStats('a/b', {
      fetchImpl: mkFetch(async () => ({
        ok: true, status: 200,
        json: async () => ({ stargazers_count: 12, forks_count: 3, open_issues_count: 4, pushed_at: 'x', license: { spdx_id: 'MIT' }, html_url: 'https://github.com/a/b' }),
      })),
      ttlMs: 60000,
    })
    ok(r.ok === true && r.stars === 12, '读到 star 数')
    ok(r.forks === 3 && r.openIssues === 4, '读到 fork 与 issue 数')
    ok(r.license === 'MIT', '读到许可')
  }
  {
    // 缓存：第二次不打网络
    let calls = 0
    const impl = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ stargazers_count: 1 }) } }
    await githubStats('cache/test', { fetchImpl: impl, ttlMs: 60000 })
    const second = await githubStats('cache/test', { fetchImpl: impl, ttlMs: 60000 })
    ok(calls === 1, '命中的结果走缓存，不再打接口')
    ok(second.cached === true, '标出 cached')
  }
  {
    // 限流不缓存：下次必须还能重试
    let calls = 0
    const impl = async () => { calls += 1; return { ok: false, status: 403, json: async () => ({}) } }
    await githubStats('rate/test', { fetchImpl: impl, ttlMs: 60000 })
    await githubStats('rate/test', { fetchImpl: impl, ttlMs: 60000 })
    ok(calls === 2, '限流结果不缓存（下次仍会重试）')
  }
  {
    const r = await githubStats('rate/test2', { fetchImpl: mkFetch(async () => ({ ok: false, status: 429 })) })
    ok(r.ok === false && r.reason.includes('限流'), '限流时给出明确原因')
  }
  {
    const r = await githubStats('nope/test3', { fetchImpl: mkFetch(async () => ({ ok: false, status: 404 })) })
    ok(r.ok === false && r.reason.includes('不存在'), '404 说仓库不存在')
  }
  {
    const r = await githubStats('x/y', {
      fetchImpl: mkFetch(async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e }),
    })
    ok(r.ok === false && r.reason.includes('超时'), '超时说超时')
  }
  {
    const r = await githubStats('x/y', { fetchImpl: mkFetch(async () => { throw new Error('boom') }) })
    ok(r.ok === false, '异常不抛给调用方') 
    ok(typeof r.reason === 'string', '异常也给出可读原因')
  }
  {
    const r = await githubStats(null, { fetchImpl: mkFetch(async () => { throw new Error('不该被调用') }) })
    ok(r.ok === false, '没有 slug 时直接返回失败，不打接口')
  }
  {
    // token 会带进 Authorization 头
    let seen = null
    await githubStats('tok/test', {
      fetchImpl: mkFetch(async (url, init) => { seen = init.headers; return { ok: true, status: 200, json: async () => ({ stargazers_count: 0 }) } }),
      token: 'tok123',
    })
    ok(seen.authorization === 'Bearer tok123', '给了 token 就带上 Authorization')
  }
  {
    let seen = null
    await githubStats('tok/test2', {
      fetchImpl: mkFetch(async (url, init) => { seen = init.headers; return { ok: true, status: 200, json: async () => ({ stargazers_count: 0 }) } }),
      token: '',
    })
    ok(seen.authorization === undefined, '没 token 时不带 Authorization 头')
  }

  // ————— 五、热重载追踪 —————
  console.log('\n五、热重载追踪')
  {
    // 订阅到事件：计数与最后时间都要动
    let handler = null
    const fakeCtx = { on: (name, fn) => { if (name === 'hmr/reload') handler = fn } }
    const tmp = await mkdtemp(join(tmpdir(), 'dtj-about-'))
    const f = join(tmp, 'x.js')
    await writeFile(f, 'x')
    const tracker = makeReloadTracker(fakeCtx, { files: [f], startedAt: Date.now() + 100000 })
    ok(handler !== null, '订阅了 hmr/reload 事件')
    let d = await tracker.describe()
    ok(d.reloadCount === 0 && d.eventSubscribed === true, '初始 0 次且已订阅')
    // 触发一次
    handler(new Map([['p', { filename: 'lib/index.js' }]]))
    d = await tracker.describe()
    ok(d.reloadCount === 1, '事件后计数 +1')
    ok(d.lastReloadAt !== null, '记录最后重载时间')
    ok(d.lastReloadFiles[0] === 'lib/index.js', '记录被重载的文件')
    // 文件改动时间比 startedAt 早 → 不算「改了没生效」
    ok(d.filesNewerThanStart === null, '文件不比进程新时不报警')
    await rm(tmp, { recursive: true, force: true })
  }
  {
    // 文件比进程新 → 必须报出来
    const tmp = await mkdtemp(join(tmpdir(), 'dtj-about2-'))
    const f = join(tmp, 'y.js')
    await writeFile(f, 'y')
    const tracker = makeReloadTracker({ on: () => {} }, { files: [f], startedAt: 1 })
    const d = await tracker.describe()
    ok(d.filesNewerThanStart !== null, '文件比进程新时标出来')
    ok(d.filesNewerThanStart.file === f, '带出具体文件')
    await rm(tmp, { recursive: true, force: true })
  }
  {
    // 订阅不上也要能工作
    const tracker = makeReloadTracker(null, { files: [], startedAt: Date.now() })
    const d = await tracker.describe()
    ok(d.eventSubscribed === false, '没上下文时标为未订阅')
    ok(d.reloadCount === 0, '未订阅时仍给出 0 次（且已标明不可靠）')
  }
  {
    // on 抛异常不能把插件带崩
    const tracker = makeReloadTracker({ on: () => { throw new Error('nope') } }, { files: [] })
    const d = await tracker.describe()
    ok(d.eventSubscribed === false, 'on 抛异常时降级为未订阅，不崩')
  }

  // ————— 六、数据目录统计 —————
  console.log('\n六、数据目录')
  {
    const tmp = await mkdtemp(join(tmpdir(), 'dtj-dir-'))
    await writeFile(join(tmp, 'a.md'), 'x'.repeat(100))
    await mkdir(join(tmp, 'sub'))
    await writeFile(join(tmp, 'sub', 'b.jsonl'), 'y'.repeat(50))
    const s = await dirStats(tmp)
    ok(s.exists === true, '目录存在')
    ok(s.files === 2, `数对文件数（实际 ${s.files}）`)
    ok(s.bytes === 150, `算对体积（实际 ${s.bytes}）`)
    ok(s.truncated === false, '没超上限时不标 truncated')
    const missing = await dirStats(join(tmp, 'nope'))
    ok(missing.exists === false && missing.files === 0, '目录不存在时返回 0，不抛')
    // 上限：超了就标 truncated，但不要卡死
    const small = await dirStats(tmp, { maxFiles: 1 })
    ok(small.truncated === true, '超过上限时标 truncated')
    await rm(tmp, { recursive: true, force: true })
  }

  // ————— 七、DSH 主目录与 profile 检测 —————
  console.log('\n七、主目录与 profile')
  {
    const old = process.env.DSH_HOME
    process.env.DSH_HOME = '/x/y'
    ok(dshHome() === '/x/y', '跟随 DSH_HOME')
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    ok(dshHome().endsWith('.dsh'), '没有 DSH_HOME 时退到 ~/.dsh')
  }
  {
    // 造两个 profile：一个链到本插件，一个没有
    const home = await mkdtemp(join(tmpdir(), 'dtj-home-'))
    const old = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const me = pluginDir()
      await mkdir(join(home, 'profiles', 'web', 'node_modules'), { recursive: true })
      await mkdir(join(home, 'profiles', 'other', 'node_modules'), { recursive: true })
      await symlink(me, join(home, 'profiles', 'web', 'node_modules', 'dsh-task-journal'))
      const d = await detectProfiles('dsh-task-journal')
      ok(d.profiles.includes('web'), '检测出装了本插件的 profile')
      ok(!d.profiles.includes('other'), '没装的不算')
      ok(d.linked.includes('web'), '认出是链接安装')
      ok(d.scanned === 2, `扫过 2 个 profile（实际 ${d.scanned}）`)
      const missing = await detectProfiles('完全不存在-xyz')
      ok(missing.profiles.length === 0, '没装任何地方时返回空')
    } finally {
      if (old === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = old
      await rm(home, { recursive: true, force: true })
    }
  }
  {
    // profiles 目录整个不存在
    const home = await mkdtemp(join(tmpdir(), 'dtj-home2-'))
    const old = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const d = await detectProfiles('x')
      ok(d.profiles.length === 0 && d.scanned === 0, '没有 profiles 目录时返回空，不抛')
    } finally {
      if (old === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = old
      await rm(home, { recursive: true, force: true })
    }
  }

  // ————— 八、汇总 —————
  console.log('\n八、汇总')
  const noNet = { fetchImpl: async () => { throw new Error('offline') } }
  const g = await gather(noNet)
  ok(g.self.name === 'dsh-task-journal', '自身名字')
  ok(g.self.version === '0.1.0', '自身版本')
  ok(typeof g.self.dir === 'string' && g.self.dir !== '', '自身目录')
  ok(g.self.repo === 'https://github.com/q785845530/dsh-task-journal', '规范化后的仓库链接')
  ok(g.github.ok === false, '离线时 GitHub 降级为不可用')
  ok(typeof g.github.reason === 'string', '降级时给出原因')
  ok(g.commands.install.includes('add'), '安装命令')
  ok(g.commands.installFromGit.includes('github.com'), '从 Git 安装的命令')
  ok(g.links.issues.endsWith('/issues'), 'Issue 链接')
  ok(g.links.star === g.self.repo, 'Star 链接就是仓库')
  ok(g.installed.length === 0, '没有插件管理服务时不列插件，且不抛')
  ok(g.reload === null, '没给追踪器时不假装有热重载状态')
  ok(g.data === null, '没给数据目录时不假装有')

  // 给了 manager 与 reload
  const fakeManager = {
    listBundles: async () => [
      { name: 'dsh-task-journal', version: '0.1.0', enabled: true, removable: true, official: false, source: 'link:/x' },
      { name: 'official-thing', version: '2.0.0', enabled: false, removable: false, official: true, source: 'registry' },
    ],
  }
  const g2 = await gather({
    ...noNet,
    manager: fakeManager,
    reload: makeReloadTracker(null, { files: [], startedAt: Date.now() }),
    profile: 'web',
  })
  ok(g2.installed.length === 2, '列出已安装插件')
  ok(g2.installed[0].local === true, 'link: 来源标为本地')
  ok(g2.installed[1].local === false, 'registry 来源不标本地')
  ok(g2.reload !== null && g2.reload.reloadCount === 0, '带上热重载状态')
  ok(g2.profiles.active === 'web', '显式给了 profile 就用它')

  // manager 抛异常也不能崩
  const g3 = await gather({
    ...noNet,
    manager: { listBundles: async () => { throw new Error('boom') } },
  })
  ok(g3.installed.length === 0, 'manager 抛异常时列表为空，不崩')
  ok(g3.self.name === 'dsh-task-journal', '其余信息照常给出')

  console.log(`\n结果：${pass} passed / ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error('\n自测自身异常：', e)
  process.exit(1)
})
