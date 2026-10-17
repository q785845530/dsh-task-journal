/**
 * dsh-task-journal — 插件自身信息（「关于」页签的数据源）。
 *
 * 回答几个平时要翻文件系统才能回答的问题：装在哪、哪个版本、来源是链接
 * 还是 registry、怎么装、怎么卸、有没有新版本、这次跑的是磁盘上那份代码吗。
 *
 * ## 为什么「运行版本」和「磁盘版本」要分开显示
 * 插件被加载进内存之后，磁盘上的文件可能已经被改过了。这时候界面显示
 * 「0.1.0」并不代表**正在跑**的就是那份 0.1.0 —— 可能跑的是十分钟前的代码。
 * 这两个数字摆在一起，才能看出「改了没生效」这种事。
 *
 * @module dsh-task-journal/about
 */
import { readFile, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件安装目录（lib/ 的上一层）。 */
export function pluginDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** 读自身 package.json。读不到就返回 null，不抛。 */
export async function readManifest() {
  try {
    return JSON.parse(await readFile(join(pluginDir(), 'package.json'), 'utf8'))
  } catch { return null }
}

/**
 * 把各种写法的仓库地址统一成 https 链接。
 *
 * `git@github.com:a/b.git`、`git+https://...`、`github:a/b` 都可能出现，
 * 界面只需要一个能点的链接。
 *
 * @returns `{ https, slug }`；认不出时两者都是 null。
 */
export function normalizeRepo(url) {
  const s = String(url ?? '').trim()
  if (s === '') return { https: null, slug: null }
  let m = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(s)
  if (m !== null) return finalize(m[1], m[2])
  m = /^(?:git\+)?(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(s)
  if (m !== null) return finalize(m[1], m[2])
  m = /^github:([^/]+)\/(.+?)$/.exec(s)
  if (m !== null) return finalize('github.com', `${m[1]}/${m[2]}`)
  return { https: null, slug: null }
}

function finalize(host, path) {
  const slug = path.replace(/\/+$/, '')
  return { https: `https://${host}/${slug}`, slug: host === 'github.com' ? slug : null }
}

/** 从磁盘上的 .git/config 读远端（不跑 git 命令，避免依赖外部程序）。 */
export async function gitRemote(dir) {
  try {
    const text = await readFile(join(dir, '.git', 'config'), 'utf8')
    const m = /\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/.exec(text)
    return m === null ? null : m[1]
  } catch { return null }
}

/** DSH 主目录：优先环境变量，其次 ~/.dsh。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(process.env.HOME ?? '~', '.dsh')
}

/**
 * 找出**哪些 profile 装了本插件**。
 *
 * 不去猜「当前是哪个 profile」—— DSH 没把 profile 名交给插件。改成看事实：
 * 遍历 `$DSH_HOME` 下每个 profile 的 node_modules 里的本插件条目，把 realpath 等于本插件
 * 目录的那些挑出来。这样既回答了「当前 profile」，也能顺带回答
 * 「我还装在别的地方吗」，而且结论是从磁盘读出来的，不是猜的。
 *
 * @returns `{ profiles, linked }`：命中的 profile 名，以及它们是否为链接安装。
 */
export async function detectProfiles(name) {
  const root = join(dshHome(), 'profiles')
  const profiles = []
  const linked = []
  let names = []
  try { names = await readdir(root) } catch { return { profiles, linked, root, scanned: 0 } }
  for (const profile of names) {
    if (profile === 'node_modules') continue
    const guess = join(root, profile, 'node_modules', name)
    try {
      const st = await stat(guess) // 跟随符号链接
      if (!st.isDirectory()) continue
      const { realpath } = await import('node:fs/promises')
      const real = await realpath(guess)
      if (real !== pluginDir()) continue
      profiles.push(profile)
      const link = await import('node:fs/promises').then((m) => m.lstat(guess))
      if (link.isSymbolicLink()) linked.push(profile)
    } catch { /* 这个 profile 没装，继续 */ }
  }
  return { profiles, linked, root, scanned: names.length }
}

/** 生成安装/卸载命令。 */
export function commands(name, profile) {
  const p = profile === null || profile === undefined || profile === '' ? 'web' : profile
  return {
    install: `dsh plugin --profile ${p} add ${name}`,
    uninstall: `dsh plugin --profile ${p} remove ${name}`,
    // 从 Git 直接装（还没有发布到 registry 时用得上）
    installFromGit: null,
  }
}

/** GitHub 数据的短时缓存：未认证接口每小时只有 60 次，不能每次刷新都打。 */
const githubCache = new Map()

/**
 * 取仓库的 star / fork 数。
 *
 * 失败不是错误：拿不到就返回 `ok: false`，界面显示「暂不可用」——
 * 一个统计数据不该把整个页面变成错误页。
 */
export async function githubStats(slug, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const ttl = options.ttlMs ?? 10 * 60 * 1000
  const now = Date.now()
  if (slug === null || slug === undefined || slug === '') {
    return { ok: false, reason: '没有可识别的 GitHub 仓库' }
  }
  const hit = githubCache.get(slug)
  if (hit !== undefined && now - hit.at < ttl) return { ...hit.value, cached: true }
  // 有标准环境变量 token 就用上：未认证接口每小时只有 60 次，
  // 一个「关于」页签不值得把人家的额度耗光。没有 token 也能跑，只是额度低。
  const token = options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ''
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-task-journal' }
  if (typeof token === 'string' && token.trim() !== '') headers.authorization = `Bearer ${token.trim()}`
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${slug}`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    })
    if (res.status === 404) {
      const v = { ok: false, reason: '仓库不存在或不可见' }
      githubCache.set(slug, { at: now, value: v })
      return v
    }
    if (res.status === 403 || res.status === 429) {
      // 限流：不缓存，下次还能重试
      return { ok: false, reason: 'GitHub 接口限流（未认证每小时 60 次）' }
    }
    if (res.ok !== true) return { ok: false, reason: `GitHub 返回 HTTP ${res.status}` }
    const j = await res.json()
    const v = {
      ok: true,
      stars: Number(j.stargazers_count ?? 0),
      forks: Number(j.forks_count ?? 0),
      openIssues: Number(j.open_issues_count ?? 0),
      pushedAt: j.pushed_at ?? null,
      license: j.license?.spdx_id ?? null,
      htmlUrl: j.html_url ?? null,
    }
    githubCache.set(slug, { at: now, value: v })
    return v
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return { ok: false, reason: timedOut ? '连接 GitHub 超时' : (error?.message ?? String(error)) }
  }
}

// ————————————————————————— 热重载状态 —————————————————————————

/**
 * 热重载追踪器。
 *
 * 事件名与 DSH 的 HMR 服务一致（`hmr/reload`）。订阅不到也没关系：
 * 那就报「自启动以来未见重载」，而不是猜一个数字。
 *
 * @param ctx 插件上下文。
 * @param options 可给 `files`（要监视修改时间的文件）与 `startedAt`。
 */
/**
 * 进程级的加载计数。
 *
 * 热重载会**重新导入这个模块**，模块内的变量全部重置 —— 所以计数器放在
 * 模块里就永远是 0，等于没测。挂在 `globalThis` 上才能跨重载累计。
 * 用 Symbol.for 是为了多次导入拿到同一个键。
 */
const LOADS_KEY = Symbol.for('dsh-task-journal.moduleLoads')

function bumpModuleLoad() {
  const now = Date.now()
  const prev = globalThis[LOADS_KEY]
  const next = {
    // 本进程内这个模块被求值过几次。>1 就说明发生过热重载。
    count: (prev?.count ?? 0) + 1,
    firstAt: prev?.firstAt ?? now,
    lastAt: now,
  }
  globalThis[LOADS_KEY] = next
  return next
}

/** 本次模块求值的时间点与累计次数。 */
const THIS_LOAD = bumpModuleLoad()

export function makeReloadTracker(ctx, options = {}) {
  const startedAt = options.startedAt ?? Date.now()
  const files = options.files ?? [join(pluginDir(), 'lib', 'index.js')]
  const state = { count: 0, lastAt: null, lastFiles: [], subscribed: false }
  const loads = globalThis[LOADS_KEY] ?? THIS_LOAD

  if (ctx !== null && ctx !== undefined && typeof ctx.on === 'function') {
    try {
      ctx.on('hmr/reload', (reloads) => {
        state.count += 1
        state.lastAt = Date.now()
        try {
          state.lastFiles = reloads instanceof Map
            ? [...reloads.values()].map((x) => x?.filename).filter((x) => typeof x === 'string').slice(0, 10)
            : []
        } catch { state.lastFiles = [] }
      })
      state.subscribed = true
    } catch { state.subscribed = false }
  }

  return {
    /** 读取当前状态；会顺手查一遍源码文件的修改时间。 */
    async describe() {
      const mtimes = []
      for (const f of files) {
        try {
          const st = await stat(f)
          mtimes.push({ file: f, mtime: st.mtimeMs })
        } catch { /* 文件不在就算了 */ }
      }
      const newest = mtimes.reduce((a, b) => (a === null || b.mtime > a.mtime ? b : a), null)
      const now = Date.now()
      const live = globalThis[LOADS_KEY] ?? loads
      return {
        startedAt,
        uptimeMs: now - startedAt,
        // 本实例订阅到的重载次数（热重载后重新计数，所以可能小于 moduleLoads）
        reloadCount: state.count,
        // 进程级：这个模块被求值过几次。>1 就说明热重载发生过 ——
        // 这才是「插件已热重载」的可靠证据。
        moduleLoads: live.count,
        moduleFirstAt: live.firstAt,
        moduleLoadedAt: live.lastAt,
        hotReloaded: live.count > 1,
        thisLoadAt: THIS_LOAD.lastAt,
        lastReloadAt: state.lastAt,
        lastReloadFiles: state.lastFiles,
        // 没订阅上事件时如实说，别让人以为「0 次」是确凿的。
        eventSubscribed: state.subscribed,
        // 磁盘上的代码比进程新 = 改了还没生效（要么没热重载，要么要重启）。
        filesNewerThanStart: newest !== null && newest.mtime > startedAt
          ? { file: newest.file, mtime: newest.mtime }
          : null,
        mtimes,
      }
    },
  }
}

// ————————————————————————— 数据目录 —————————————————————————

/** 统计一个目录的体积与文件数（有上限，避免在巨大目录上卡住）。 */
export async function dirStats(dir, options = {}) {
  const maxFiles = options.maxFiles ?? 5000
  let bytes = 0
  let files = 0
  let truncated = false
  const walk = async (d, depth) => {
    if (files >= maxFiles || depth > 4) { truncated = true; return }
    let items
    try { items = await readdir(d, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (files >= maxFiles) { truncated = true; return }
      const full = join(d, item.name)
      if (item.isDirectory()) { await walk(full, depth + 1); continue }
      if (!item.isFile()) continue
      try { bytes += (await stat(full)).size; files += 1 } catch { /* 跳过 */ }
    }
  }
  if (existsSync(dir)) await walk(dir, 0)
  return { dir, exists: existsSync(dir), bytes, files, truncated }
}

/**
 * 汇总「关于」页签需要的全部信息。
 *
 * @param deps.manager 插件管理服务（可选，用来列全部已安装插件）。
 * @param deps.reload 热重载追踪器。
 * @param deps.dataDir 数据目录（`.dsh-journal`）。
 * @param deps.profile 当前 profile 名。
 * @param deps.fetchImpl 便于测试。
 */
export async function gather(deps = {}) {
  const dir = pluginDir()
  const manifest = await readManifest()
  const name = manifest?.name ?? 'dsh-task-journal'
  // profile 名从磁盘事实推断（见 detectProfiles），拿不到就退到约定值并标明。
  const detected = await detectProfiles(name)
  const profile = deps.profile ?? detected.profiles[0] ?? 'web'
  const profileAssumed = deps.profile === undefined && detected.profiles.length === 0
  const remote = await gitRemote(dir)
  const repo = normalizeRepo(manifest?.repository?.url ?? manifest?.repository ?? remote)
  // 令牌来源：环境变量优先（更标准、便于轮换），其次插件里加密存的那份。
  // 拿不到就用未认证接口 —— 额度低但能用，不该因为没令牌就整个不可用。
  let token = deps.token ?? null
  let tokenSource = token === null ? 'none' : 'explicit'
  if (token === null) {
    const { resolve } = await import('./tokens.js')
    const stored = await resolve('github').catch(() => null)
    if (stored !== null && stored !== '') { token = stored; tokenSource = 'store' }
  }
  const stats = repo.slug === null
    ? { ok: false, reason: '没有可识别的 GitHub 仓库' }
    : await githubStats(repo.slug, { fetchImpl: deps.fetchImpl, token: token ?? '' })

  // 镜像仓库（非 GitHub）：git 慢的时候从那里拉更快，也方便国内网络访问。
  const mirrorsRaw = manifest?.mirrors ?? {}
  const mirrors = Object.entries(mirrorsRaw)
    .filter(([, v]) => typeof v === 'string' && /^https?:\/\//.test(v))
    .map(([host, url]) => ({ host, url }))

  const cmds = commands(name, profile)
  if (repo.https !== null) {
    // 从 Git 装：适合还没发到 registry 的情况。
    cmds.installFromGit = `dsh plugin --profile ${profile} add ${repo.https}`
  }
  // 国内从 Gitee 装通常快得多，所以单独给一条。
  if (mirrors.length > 0) {
    cmds.installFromMirror = `dsh plugin --profile ${profile} add ${mirrors[0].url}`
    cmds.installFromMirrorHost = mirrors[0].host
  }

  const reload = deps.reload === undefined ? null : await deps.reload.describe()
  const data = deps.dataDir === undefined ? null : await dirStats(deps.dataDir)

  // 全部已安装插件：给「本地路径 + 版本」一张总表。
  let installed = []
  if (deps.manager !== undefined && deps.manager !== null) {
    try {
      const bundles = await deps.manager.listBundles()
      installed = (bundles ?? []).map((b) => ({
        name: b.name,
        version: b.version ?? null,
        enabled: b.enabled === true,
        removable: b.removable === true,
        official: b.official === true,
        source: b.source ?? null,
        // 本地来源（link:/file:）标出来：它们不随 registry 升级。
        local: typeof b.source === 'string' && (b.source.startsWith('link:') || b.source.startsWith('file:') || b.source.startsWith('/')),
      }))
    } catch { installed = [] }
  }

  return {
    self: {
      name,
      version: manifest?.version ?? null,
      dir,
      dirDisplay: dir,
      license: manifest?.license ?? null,
      engines: manifest?.engines ?? null,
      description: manifest?.description ?? null,
      dependencyCount: Object.keys(manifest?.dependencies ?? {}).length,
      mirrors,
      repo: repo.https,
      repoSlug: repo.slug,
      remote,
    },
    github: { ...stats, tokenSource },
    commands: cmds,
    reload,
    data,
    // 装在哪些 profile 里（从磁盘查出来的，不是猜的）。
    profiles: { detected: detected.profiles, linked: detected.linked, scanned: detected.scanned, active: profile, assumed: profileAssumed },
    installed,
    links: {
      repo: repo.https,
      issues: repo.https === null ? null : `${repo.https}/issues`,
      readme: repo.https === null ? null : `${repo.https}#readme`,
      star: repo.https === null ? null : repo.https,
    },
  }
}
