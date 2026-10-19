/**
 * dsh-task-journal — 插件更新。
 *
 * DSH 的插件市场只**报告** `update-available`，自己不升级：官方插件的「更新」
 * 由 Discover 页走「先移除、再安装」，第三方插件没有这条路。这个模块把那条路
 * 搬进任务日记：读已安装的组合包，逐个问「有没有更新版本」，需要时按
 * 「移除 → 安装」升级。
 *
 * 两个版本来源
 * ------------
 * 1. **插件市场**（`pluginMarket` 服务）：权威，自带兼容性判断与版本豁免。
 *    但它由 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 挂载，
 *    随附 profile 默认没有 —— 没有时退到第 2 条。
 * 2. **npm registry**：直接问每个包的最新版本。不依赖宿主装了什么，
 *    但兼容性要自己判：读目标版本的 `engines.dsh`，用 `./semver.js` 比。
 *
 * 四条纪律
 * --------
 * 1. **只更新已安装且可移除的组合包。** 不接受任意包名 —— 否则这个接口就成了
 *    任意包安装器，一个本地请求就能把任意代码装进 profile。
 * 2. **装哪个版本由版本来源说了算。** 请求里只给包名，spec 永远由来源推导，
 *    调用方无从指定。
 * 3. **兼容性不过就不动。** 升级是「先移除、再安装」，中间没有回退：
 *    目标版本声明 `engines.dsh` 而当前运行时不满足时，宁可不升，
 *    也不能让用户少一个插件。
 * 4. **没有服务就如实说不可用。** 不假装成功、不猜版本。
 *
 * @module dsh-task-journal/updates
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { compareVersions, parseVersion, satisfies } from './semver.js'

const require_ = createRequire(import.meta.url)

/** 一次最多看多少个已安装组合包，防止极端 profile 拖垮一次请求。 */
const MAX_BUNDLES = 200

/** DSH 主目录：与插件别处（会话目录、日志目录）用同一个判据，环境变量优先。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * 找出 profile 清单里那些「指向已经不在的文件」的依赖。
 *
 * 为什么要有这一步：pnpm 对 `file:` / `link:` 依赖**不做复制**，它把绝对路径
 * 记进 package.json，之后每次 `pnpm install` 都重新读那个文件。任何一次「下载到
 * 临时目录 → 安装 → 清理临时目录」的升级流程，都会在清单里留下一条悬空引用，
 * 而从那一刻起**整个 profile 装不了任何包**——报错长这样：
 *
 *     Failed to resolve dependency: Could not install from
 *     "/tmp/dsh-…-update-XXXX/pkg-0.19.92.tgz" as it does not exist.
 *
 * 这就是 2026-10-20 实际发生的事故。与其等下一次安装失败，不如在列出插件时
 * 先扫一遍，把「已经坏了」这件事直接说出来。
 *
 * @returns {Array<{profile:string, manifest:string, name:string, spec:string, reason:string}>}
 */
export function findDanglingDependencies(home = dshHome()) {
  const root = join(home, 'profiles')
  let profiles
  try {
    profiles = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const found = []
  for (const profile of profiles) {
    const manifestPath = join(root, profile, 'package.json')
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    const deps = manifest?.dependencies
    if (deps === null || typeof deps !== 'object') continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') continue
      const local = /^(file|link):(.*)$/s.exec(spec)
      if (local === null) continue
      const raw = local[2].replace(/^~(?=$|[\\/])/, homedir())
      const target = isAbsolute(raw) ? raw : resolve(join(root, profile), raw)
      if (fs.existsSync(target)) continue
      found.push({ profile, manifest: manifestPath, name, spec, target, reason: `${local[1]}: 指向的 ${target} 不存在` })
    }
  }
  return found
}

/**
 * 尽力修好悬空引用：把目标文件从候选目录里找回来，重写成找到的那份。
 *
 * 只改**指向已经不存在的东西**的条目；正常引用一律不碰。找不到替代文件时如实
 * 返回失败，绝不猜一个路径写进清单。
 *
 * @param {object} entry - `findDanglingDependencies` 的一项。
 * @param {string[]} [searchDirs] - 额外找文件的位置（默认含 `~/.dsh/vendor`）。
 * @returns {{ok:boolean, to?:(string|null), error?:string}}
 */
export function repairDanglingDependency(entry, searchDirs = []) {
  const wanted = basename(String(entry?.target ?? ''))
  if (wanted === '') return { ok: false, error: '这条引用没有可用的文件名' }
  const dirs = [...searchDirs, join(dshHome(), 'vendor')]
  const hit = dirs.map((d) => join(d, wanted)).find((candidate) => fs.existsSync(candidate))
  if (hit === undefined) {
    return {
      ok: false,
      error: `在 ${dirs.join('、')} 里没找到 ${wanted}；把文件放回原地，或改用 name@version 形态重装`,
    }
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(entry.manifest, 'utf8'))
    const prefix = /^(file|link):/.exec(entry.spec)?.[1] ?? 'file'
    manifest.dependencies[entry.name] = `${prefix}:${hit}`
    fs.writeFileSync(entry.manifest, JSON.stringify(manifest, null, 2) + '\n')
    return { ok: true, to: `${prefix}:${hit}` }
  } catch (error) {
    return { ok: false, error: `改写 ${entry.manifest} 失败：${error?.message ?? String(error)}` }
  }
}

/** 默认 npm registry；可用配置或环境变量覆盖。 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/**
 * 当前 DSH 运行时版本。
 *
 * 插件进程解析不到 `@deepseek-ai/dsh-app-boot`，但 `@deepseek-ai/dsh-tools` 是它
 * 自己的依赖，能解析到 —— 同一发布里的包共享版本号，所以那就是运行时版本。
 *
 * @returns {string|null} 版本号；拿不到返回 null。
 */
export function dshRuntimeVersion() {
  try {
    const manifest = require_(require_.resolve('@deepseek-ai/dsh-tools/package.json'))
    const version = manifest?.version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/**
 * 从上下文取一个服务，并确认它真的带着我们需要的那些方法。
 *
 * 插件进程解析不到 `@deepseek-ai/dsh-plugin-manager` 这些包，所以只能鸭子类型：
 * 服务可能不存在、可能是另一个版本、可能只挂了一半。
 *
 * @param ctx - cordis 上下文。
 * @param name - 服务名。
 * @param methods - 需要存在的方法名。
 * @returns `{ok:true, service}` 或 `{ok:false, reason}`。
 */
function take(ctx, name, methods) {
  const service = ctx?.get?.(name)
  if (service === undefined || service === null) {
    return { ok: false, reason: `宿主没有装配 ${name} 服务` }
  }
  const missing = methods.filter((m) => typeof service[m] !== 'function')
  if (missing.length > 0) {
    return { ok: false, reason: `${name} 缺少方法：${missing.join('、')}` }
  }
  return { ok: true, service }
}

/** 把异常转成一句话，不让调用方看到 `[object Object]`。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 更新状态的中文说明。
 *
 * 命令行、模型工具、界面三处共用一套，免得同一个状态三处三种说法。
 *
 * @param {string} status 状态 id。
 * @returns {string} 中文说明。
 */
export function statusLabel(status) {
  switch (status) {
    case 'installed': return '已是最新'
    case 'update-available': return '可更新'
    case 'different-version': return '版本不同'
    case 'provided': return '随安装提供'
    case 'not-installed': return '未安装'
    case 'local': return '本地来源'
    default: return '未知'
  }
}

/** 规范化 registry 地址。 */
function normalizeRegistry(url) {
  const text = String(url ?? '').trim()
  if (text === '') return DEFAULT_REGISTRY
  return text.replace(/\/+$/, '')
}

/**
 * 这个已安装插件的来源能不能从 registry 更新。
 *
 * `link:`、`file:`、相对/绝对路径、`git+`、`github:` 这些都不是 npm 版本，
 * 问 registry 没有意义 —— 直接标成本地/仓库来源，不参与更新。
 *
 * @param {string|null} source 组合包的来源 spec。
 * @returns {'registry'|'local'} 来源类型。
 */
export function sourceKind(source) {
  const s = String(source ?? '').trim()
  if (s === '') return 'registry'
  if (/^(link|file|portal|workspace):/i.test(s)) return 'local'
  if (/^(git\+|git:|github:|https?:\/\/)/i.test(s)) return 'local'
  if (s.startsWith('.') || s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) return 'local'
  return 'registry'
}

/**
 * 组合包在市场里的可用更新。
 *
 * @param {string} name 包名。
 * @param {string|null} url 命中的索引地址。
 * @param {object|null} entry 市场条目。
 * @returns {object} 行数据。
 */
function marketRow(name, url, entry) {
  if (entry === null || entry === undefined) {
    return { name, status: 'unknown', latestVersion: null, index: url, installSpec: null, versions: 0, engineRange: null }
  }
  const installation = entry.installation ?? { status: 'not-installed' }
  // 有默认版本用默认版本；没有（全不兼容）就退回最高版本，只为了显示。
  const target = entry.defaultVersion ?? entry.versions?.[0]?.version ?? null
  const chosen = (entry.versions ?? []).find((v) => v.version === target) ?? null
  return {
    name,
    status: installation.status,
    installedVersion: installation.installedVersion ?? null,
    latestVersion: target,
    index: url,
    // spec 只从来源里取，调用方永远无法指定来源。
    installSpec: chosen?.install?.spec ?? null,
    // 市场已经算过兼容性，直接用它的结论。
    engineOk: chosen === null ? null : chosen.compatibility?.compatible === true,
    engineRange: chosen?.engines?.dsh ?? null,
    versions: (entry.versions ?? []).length,
  }
}

/**
 * 建一个更新服务。
 *
 * @param {object} deps 依赖：`ctx`、`hideDeep`、`logger`、`registry`、`fetchImpl`。
 * @returns {{available: Function, list: Function, apply: Function}} 服务。
 */
export function makeUpdateService(deps = {}) {
  const {
    ctx,
    hideDeep = (v) => v,
    logger,
    registry: registryConfig = '',
    fetchImpl,
  } = deps
  const registry = normalizeRegistry(registryConfig !== '' ? registryConfig : (process.env.npm_config_registry ?? DEFAULT_REGISTRY))
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch

  /** 取服务；市场是可选的，没有就退到 registry。 */
  const services = () => {
    const manager = take(ctx, 'pluginManager', ['listBundles', 'removeBundle', 'installBundle'])
    if (!manager.ok) return { ok: false, reason: manager.reason }
    const market = take(ctx, 'pluginMarket', ['listIndexes', 'entry'])
    return {
      ok: true,
      manager: manager.service,
      market: market.ok ? market.service : null,
      marketReason: market.ok ? null : market.reason,
    }
  }

  /** 只报能力，不查版本。 */
  const available = () => {
    const s = services()
    return s.ok
      ? { available: true, market: s.market !== null, registry, runtime: dshRuntimeVersion() }
      : { available: false, reason: s.reason }
  }

  /** 读已安装的组合包。 */
  const installedBundles = async (manager) => {
    const all = await manager.listBundles()
    const list = Array.isArray(all) ? all : []
    return list
      .filter((b) => b?.installed === true)
      .slice(0, MAX_BUNDLES)
      .map((b) => ({
        name: String(b.name ?? ''),
        version: typeof b.version === 'string' ? b.version : null,
        enabled: b.enabled === true,
        removable: b.removable === true,
        official: b.official === true,
        availability: typeof b.availability === 'string' ? b.availability : null,
        source: typeof b.source === 'string' ? b.source : null,
        error: b.error === undefined ? null : (b.error.message ?? String(b.error)),
      }))
      .filter((b) => b.name !== '')
  }

  /** registry 里一个包的元数据缓存（一次 list 内复用）。 */
  const npmCache = new Map()

  /**
   * 问 npm registry 要一个包的版本信息。
   *
   * 用缩写元数据（`install-v1+json`）：只要版本表与 dist-tags，体积小得多。
   *
   * @returns {Promise<{latest:string|null, engineRange:(string|null)}|null>}
   */
  const npmLookup = async (name) => {
    if (npmCache.has(name)) return npmCache.get(name)
    const run = async () => {
      const url = `${registry}/${name.replace('/', '%2f')}`
      const res = await doFetch(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
      const body = await res.json()
      const latest = typeof body?.['dist-tags']?.latest === 'string' ? body['dist-tags'].latest : null
      const engineRange = latest === null ? null : (body?.versions?.[latest]?.engines?.dsh ?? null)
      return { latest, engineRange: typeof engineRange === 'string' ? engineRange : null }
    }
    try {
      const value = await run()
      npmCache.set(name, value)
      return value
    } catch (error) {
      logger?.warn?.(`dsh-task-journal: 查 ${name} 的 registry 版本失败：${messageOf(error)}`)
      npmCache.set(name, null)
      return null
    }
  }

  /**
   * 用 registry 判断一个包的更新状态。
   *
   * @returns {Promise<{row:object, blocked:(string|null)}>}
   */
  const registryRow = async (bundle, runtime) => {
    const installed = bundle.version
    if (parseVersion(installed) === null) {
      return { row: { name: bundle.name, status: 'different-version', latestVersion: null, index: null, installSpec: null, versions: 0, engineOk: null, engineRange: null, note: '已安装版本不是合法语义化版本，无法比较' }, blocked: null }
    }
    const found = await npmLookup(bundle.name)
    if (found === null || found.latest === null) {
      return { row: { name: bundle.name, status: 'unknown', latestVersion: null, index: null, installSpec: null, versions: 0, engineOk: null, engineRange: null, note: 'registry 未返回可比较的版本' }, blocked: null }
    }
    const cmp = compareVersions(found.latest, installed)
    const status = cmp === null ? 'different-version' : cmp > 0 ? 'update-available' : cmp === 0 ? 'installed' : 'different-version'
    // 兼容性：目标版本声明了 engines.dsh 就必须满足，认不出来的范围按不通过处理。
    const engineOk = found.engineRange === null || runtime === null
      ? null
      : satisfies(runtime, found.engineRange)
    const blocked = status === 'update-available' && engineOk === false
      ? `新版本要求 dsh ${found.engineRange}，当前运行时是 ${runtime}`
      : null
    return {
      row: {
        name: bundle.name,
        status,
        latestVersion: found.latest,
        index: null,
        installSpec: `${bundle.name}@${found.latest}`,
        engineOk,
        engineRange: found.engineRange,
        versions: 0,
      },
      blocked,
    }
  }

  /**
   * 列出已安装的组合包与它们的更新状态。
   *
   * @returns {Promise<object>} 状态报告。
   */
  const list = async () => {
    const s = services()
    if (!s.ok) return { ok: false, available: false, reason: s.reason, plugins: [], indexes: [], updates: 0 }
    const runtime = dshRuntimeVersion()

    let bundles
    try {
      bundles = await installedBundles(s.manager)
    } catch (error) {
      return { ok: false, available: true, reason: `读取已安装插件失败：${messageOf(error)}`, plugins: [], indexes: [], updates: 0 }
    }

    // 索引列表：拿不到就当没有市场，退到 registry。
    const indexes = []
    if (s.market !== null) {
      try {
        const summaries = s.market.listIndexes()
        for (const item of Array.isArray(summaries) ? summaries : []) {
          indexes.push({
            url: String(item.url ?? ''),
            title: typeof item.title === 'string' ? item.title : null,
            error: typeof item.error === 'string' ? item.error : null,
          })
        }
      } catch (error) {
        indexes.push({ url: '', title: null, error: `读取市场索引失败：${messageOf(error)}` })
      }
    }
    const usable = indexes.filter((i) => i.error === null && i.url !== '')
    const useMarket = s.market !== null && usable.length > 0

    const plugins = []
    for (const bundle of bundles) {
      const kind = sourceKind(bundle.source)
      let market = null
      let blocked = null

      if (kind === 'local') {
        market = { status: 'local', latestVersion: null, index: null, engineOk: null, engineRange: null, versions: 0, note: '本地链接或仓库来源，不走 registry' }
      } else if (useMarket) {
        let entry = null
        let hitUrl = null
        for (const source of usable) {
          try {
            const found = await s.market.entry(source.url, bundle.name)
            if (found !== undefined && found !== null) { entry = found; hitUrl = source.url; break }
          } catch (error) {
            source.error = source.error ?? messageOf(error)
          }
        }
        const row = marketRow(bundle.name, hitUrl, entry)
        market = { status: row.status, latestVersion: row.latestVersion, index: row.index, engineOk: row.engineOk, engineRange: row.engineRange, versions: row.versions, spec: row.installSpec }
      } else {
        const { row, blocked: why } = await registryRow(bundle, runtime)
        blocked = why
        market = { status: row.status, latestVersion: row.latestVersion, index: null, engineOk: row.engineOk, engineRange: row.engineRange, versions: row.versions, spec: row.installSpec, ...row.note === undefined ? {} : { note: row.note } }
      }

      plugins.push({
        ...bundle,
        // 来源里可能有本机绝对路径，出口前遮蔽。
        source: hideDeep(bundle.source),
        market,
        updatable: market.status === 'update-available' && blocked === null,
        blocked,
        target: market.status === 'update-available' && blocked === null && typeof market.spec === 'string' && market.spec !== ''
          ? { version: market.latestVersion, spec: market.spec, index: market.index }
          : null,
      })
    }

    const withUpdate = plugins.filter((p) => p.updatable)
    const blockedList = plugins.filter((p) => p.blocked !== null)
    return {
      ok: true,
      available: true,
      source: useMarket ? 'market' : 'registry',
      market: s.market !== null,
      marketReason: s.marketReason,
      registry,
      runtime,
      indexes: hideDeep(indexes),
      counts: {
        installed: plugins.length,
        updatable: withUpdate.length,
        // 能一键升级的：有更新、兼容性过得去、而且这个包能被移除。
        appliable: withUpdate.filter((p) => p.removable).length,
        blocked: blockedList.length,
      },
      plugins,
      updates: withUpdate.length,
    }
  }

  /**
   * 升级一个已安装的组合包：先移除，再装目标版本。
   *
   * @param {string} name 包名，必须已经安装。
   * @param {object} [options] `confirm` 必须为真；`enabled` 覆盖升级后的启用状态。
   * @returns {Promise<object>} 每一步的结果。
   */
  const apply = async (name, options = {}) => {
    const s = services()
    if (!s.ok) return { ok: false, reason: s.reason }
    const target = String(name ?? '').trim()
    if (target === '') return { ok: false, reason: '需要包名' }
    // 写操作要显式确认：这条路径会改 profile 并重载插件。
    if (options.confirm !== true) {
      return { ok: false, reason: '升级会改动 profile 并重载插件，需要 confirm=true' }
    }

    // 重新算一遍，不信任调用方传进来的版本。
    const report = await list()
    if (report.ok !== true) return { ok: false, reason: report.reason }
    const row = report.plugins.find((p) => p.name === target)
    if (row === undefined) {
      return { ok: false, reason: `没有安装 ${target}，这里只升级已安装的插件` }
    }
    if (row.removable !== true) {
      return { ok: false, reason: `${target} 不可移除，不能用「移除再安装」升级` }
    }
    if (row.blocked !== null) {
      return { ok: false, reason: `${target} 的最新版本不能升：${row.blocked}` }
    }
    if (row.market?.status === 'local') {
      return { ok: false, reason: `${target} 是本地链接或仓库来源，没有 registry 版本可升；改动请直接改那份代码` }
    }
    if (row.updatable !== true || row.target === null) {
      return { ok: false, reason: `${target} 没有可用更新（当前 ${row.version ?? '未知'}）` }
    }
    const spec = row.target.spec
    if (typeof spec !== 'string' || spec === '') {
      return { ok: false, reason: `没有推导出 ${target} ${row.target.version} 的安装方式` }
    }
    const enabled = options.enabled === undefined ? row.enabled : options.enabled === true

    // 有 HMR 时不能在已安装的包上再装：必须先把旧的移除。
    const steps = []
    try {
      const removed = await s.manager.removeBundle(target)
      steps.push({ step: 'remove', result: summarise(removed) })
      if (removed?.error?.code === 'stop-profile') {
        return { ok: false, reason: `${target} 的移除要等下次启动才生效，本次没有安装`, steps }
      }
      if (removed?.application === 'failed') {
        return { ok: false, reason: `移除 ${target} 失败`, steps }
      }
    } catch (error) {
      return { ok: false, reason: `移除 ${target} 失败：${messageOf(error)}`, steps }
    }

    try {
      const done = await s.manager.installBundle(spec, { enabled })
      steps.push({ step: 'install', result: summarise(done) })
      const failed = done?.application === 'failed'
      return {
        ok: !failed,
        reason: failed ? `安装 ${spec} 失败` : null,
        name: target,
        from: row.version,
        to: row.target.version,
        spec,
        enabled,
        // 装完要重载才生效：有的 profile 立刻应用，有的等重启。
        application: done?.application ?? null,
        restartReason: done?.restartReason ?? null,
        steps,
      }
    } catch (error) {
      // 移除成功、安装失败：如实说清楚，别让用户以为还是旧版本。
      return {
        ok: false,
        reason: `移除成功但安装失败：${messageOf(error)}。${target} 现在处于未安装状态`,
        name: target,
        steps,
      }
    }
  }

  /**
   * 扫一遍 profile 清单里指向已消失文件的依赖，可选顺手修好。
   *
   * 挂在这里而不是单独的模块：它和升级是同一条因果链上的两端——升级流程负责
   * 不制造悬空引用，这里负责把已经存在的找出来。
   *
   * @param {object} [options] `repair` 为真时尝试把引用改到找回来的文件上。
   * @returns {{ok:boolean, dangling:Array<object>, repaired:Array<object>, failed:Array<object>}}
   */
  const audit = async (options = {}) => {
    const dangling = findDanglingDependencies()
    const repaired = []
    const failed = []
    if (options.repair === true) {
      for (const entry of dangling) {
        const fixed = repairDanglingDependency(entry)
        if (fixed.ok === true) repaired.push({ ...entry, to: fixed.to })
        else failed.push({ ...entry, error: fixed.error })
      }
    }
    return { ok: true, dangling, repaired, failed }
  }

  return { available, list, apply, audit }
}

/** 把 ChangeResult 压成几行，别把整个 pnpm 输出塞进响应。 */
function summarise(result) {
  if (result === null || typeof result !== 'object') return { application: null }
  return {
    changed: result.changed === true,
    application: typeof result.application === 'string' ? result.application : null,
    stage: typeof result.stage === 'string' ? result.stage : null,
    version: typeof result.version === 'string' ? result.version : null,
    restartReason: typeof result.restartReason === 'string' ? result.restartReason : null,
    error: result.error === undefined ? null : { code: result.error.code ?? null, message: result.error.message ?? null },
  }
}
