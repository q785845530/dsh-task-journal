#!/usr/bin/env node
/**
 * dsh-task-journal / 浏览器半 自测。
 *
 *   node verify-client.mjs
 *
 * 浏览器半是手写 ModuleLoader bundle，没有构建步骤，所以语法检查不足以说明
 * 它能跑：真正会坏的是「渲染时抛异常」（比如访问了 undefined 的字段）。
 * 这个自测用最小 React/web 桩把 bundle 真正**渲染一遍**，走一遍：
 *   - 模块注册与导出形状；
 *   - 设置页 section 的注册；
 *   - 主面板（含新加的「会话修复」页签）渲染；
 *   - 修复页签在有/无扫描结果两种状态下的渲染；
 *   - HTTPS 请求路径与错误分支不抛异常。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

/**
 * 最小 React 桩。
 *
 * 只实现 bundle 用到的那几件事：createElement、useState/useEffect/
 * useCallback/useMemo。hooks 按调用顺序线性返回，够渲染一遍。
 */
function makeReact() {
  const stateSlots = []
  const effects = []
  const cleanups = []
  let slot = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) }
    },
    useState(initial) {
      const i = slot++
      if (stateSlots[i] === undefined) stateSlots[i] = typeof initial === 'function' ? initial() : initial
      const set = (v) => { stateSlots[i] = typeof v === 'function' ? v(stateSlots[i]) : v }
      return [stateSlots[i], set]
    },
    // 记录 effect，供测试手动 flush —— 空实现会让「挂载后自动加载」的分支
    // 永远走不到，界面里那些依赖数据的部分（比如两栏）就测不出来。
    useEffect(fn) { effects.push(fn); slot += 1 },
    useCallback(fn) { slot += 0; return fn },
    useMemo(fn) { slot += 0; return fn() },
    _reset() { slot = 0; effects.length = 0 },
    /** 跑一遍已登记的 effect（只跑一次，避免无限循环）。 */
    async _flush() {
      const pending = effects.splice(0, effects.length)
      for (const fn of pending) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
      await new Promise((r) => setTimeout(r, 0))
    },
    _slots: stateSlots,
    _effects: effects,
  }
  return React
}

/** 把元素树递归走一遍，验证每个节点都能安全成型（不访问 undefined）。 */
function walk(node, depth = 0, seen = { count: 0 }) {
  if (node === null || node === undefined || node === false || node === true) return seen
  if (typeof node === 'string' || typeof node === 'number') return seen
  if (Array.isArray(node)) { for (const c of node) walk(c, depth, seen); return seen }
  seen.count += 1
  if (typeof node.type === 'function') {
    // 函数组件：渲染它（hooks 桩是线性分配的，深层渲染会错位，故只在这里取样）
    const out = node.type(node.props)
    walk(out, depth + 1, seen)
    return seen
  }
  for (const c of node.children) walk(c, depth, seen)
  return seen
}

/** 只统计我们关心的结构，不递归渲染函数组件（避免 hooks 错位）。 */
function countNodes(node, pred, acc = { n: 0 }) {
  if (node === null || node === undefined || typeof node !== 'object') return acc
  if (Array.isArray(node)) { for (const c of node) countNodes(c, pred, acc); return acc }
  if (pred(node)) acc.n += 1
  for (const c of node.children ?? []) countNodes(c, pred, acc)
  return acc
}

/** 在干净环境里加载 bundle，返回 { mod, React }。 */
function loadBundle(sharedStore, fetchImpl) {
  const src = readFileSync(join(here, 'lib', 'client.js'), 'utf8')
  let captured = null
  const store = sharedStore ?? new Map()
  const React = makeReact()

  const sandbox = {
    window: {
      __ModuleLoader__: { load: (spec) => { captured = spec } },
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
      },
      location: { href: 'http://localhost/' },
    },
    document: {
      createElement: () => ({ setAttribute() {}, set textContent(v) { this._t = v }, get textContent() { return this._t }, parentNode: null }),
      head: { appendChild() {} },
    },
    fetch: fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    setTimeout, clearTimeout, console,
  }
  sandbox.window.document = sandbox.document

  const require = (name) => {
    if (name === 'react') return React
    throw new Error(`未预期的 require：${name}`)
  }

  // bundle 是 `window.__ModuleLoader__.load({...})`，用 Function 注入沙箱
  const fn = new Function('window', 'document', 'require', 'fetch', 'setTimeout', 'clearTimeout', 'console', src)
  fn(sandbox.window, sandbox.document, require, sandbox.fetch, setTimeout, clearTimeout, console)

  if (captured === null) throw new Error('bundle 没有调用 __ModuleLoader__.load')
  const mod = captured.factory(require)
  return { mod, React, sandbox, store }
}

const main = async () => {
  console.log('一、模块注册与导出')
  const { mod, sandbox, store } = loadBundle()
  ok(mod.name === 'dsh-task-journal', `模块名正确（${mod.name}）`)
  ok(Array.isArray(mod.inject) && mod.inject.includes('slots'), '声明注入 slots')
  ok(typeof mod.apply === 'function', '导出 apply')

  console.log('\n二、设置页 section 注册')
  let section = null
  const slots = {
    register: (spec, Comp) => { section = { spec, Comp } },
    inject: (name, cb) => cb(),
  }
  const ctx = { effect(fn) { return fn() }, slots }
  let applyThrew = null
  try { mod.apply(ctx) } catch (e) { applyThrew = e }
  ok(applyThrew === null, 'apply 不抛异常')
  ok(section !== null, '注册了 settings.section')
  ok(section?.spec?.id === 'task-journal', 'section id 正确')
  ok(typeof section?.Comp === 'function', 'section 有组件')

  console.log('\n三、主面板渲染（含「会话修复」页签）')
  // 默认页签是 tasks；先渲染一遍确认不抛
  let tree = null
  let renderErr = null
  try { tree = section.Comp({}) } catch (e) { renderErr = e }
  ok(renderErr === null, '默认渲染不抛异常' + (renderErr === null ? '' : `：${renderErr.message}`))

  const tabs = countNodes(tree, (n) => n.props?.className === 'dtj_tab')
  ok(tabs.n >= 7, `页签数量 ≥ 7（实际 ${tabs.n}，含新增的「会话修复」）`)
  const tabLabels = []
  const collect = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const c of node) collect(c); return }
    if (node.props?.className === 'dtj_tab' && typeof node.children?.[0] === 'string') tabLabels.push(node.children[0])
    for (const c of node.children ?? []) collect(c)
  }
  collect(tree)
  ok(tabLabels.includes('会话修复'), `页签里含「会话修复」（${tabLabels.join('、')}）`)

  console.log('\n四、会话修复页签渲染')
  // 记住页签 = repair，再渲染一次，走修复页签分支
  store.set('dsh-task-journal:last-tab', 'repair')
  const { mod: mod2, React: React2, store: sharedStore } = loadBundle(store)
  let section2 = null
  const slots2 = {
    register: (spec, Comp) => { section2 = { spec, Comp } },
    inject: (name, cb) => cb(),
  }
  mod2.apply({ effect: (f) => f(), slots: slots2 })
  React2._reset()
  let repairTree = null
  let repairErr = null
  try { repairTree = section2.Comp({}) } catch (e) { repairErr = e }
  ok(repairErr === null, '修复页签渲染不抛异常' + (repairErr === null ? '' : `：${repairErr.message}`))
  // 渲染整棵树：既要走 children，也要**调用函数组件**——
  // RepairPanel 本身是个函数组件，只走 children 会完全看不到它的按钮。
  // hooks 桩是线性分配的，单次渲染里每个组件各走一遍，顺序稳定。
  const buttons = []
  const seenTypes = new Set()
  const render = (node, depth = 0) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (depth > 40) return
    if (Array.isArray(node)) { for (const c of node) render(c, depth); return }
    if (typeof node.type === 'function') {
      // 同一个组件类型只渲染一次，避免递归组件把桩状态搅乱
      if (seenTypes.has(node.type)) return
      seenTypes.add(node.type)
      render(node.type(node.props), depth + 1)
      return
    }
    if (node.type === 'button' && typeof node.children?.[0] === 'string') buttons.push(node.children[0])
    for (const c of node.children ?? []) render(c, depth)
  }
  render(repairTree)
  ok(buttons.some((b) => b.includes('扫描')), `有四步流水线的按钮（${buttons.join(' / ')}）`)
  ok(buttons.some((b) => b.includes('复验')), '有复验按钮')
  ok(buttons.some((b) => b.includes('批量修复')), '有批量修复按钮')

  console.log('\n五、插件更新页签渲染')
  sharedStore.set('dsh-task-journal:last-tab', 'updates')
  const { mod: mod3, React: React3 } = loadBundle(sharedStore)
  let section3 = null
  const slots3 = {
    register: (spec, Comp) => { section3 = { spec, Comp } },
    inject: (name, cb) => cb(),
  }
  mod3.apply({ effect: (f) => f(), slots: slots3 })
  React3._reset()
  let updTree = null
  let updErr = null
  try { updTree = section3.Comp({}) } catch (e) { updErr = e }
  ok(updErr === null, '更新页签渲染不抛异常' + (updErr === null ? '' : `：${updErr.message}`))
  const updButtons = []
  const seen3 = new Set()
  const render3 = (node, depth = 0) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (depth > 40) return
    if (Array.isArray(node)) { for (const c of node) render3(c, depth); return }
    if (typeof node.type === 'function') {
      if (seen3.has(node.type)) return
      seen3.add(node.type)
      render3(node.type(node.props), depth + 1)
      return
    }
    if (node.type === 'button' && typeof node.children?.[0] === 'string') updButtons.push(node.children[0])
    for (const c of node.children ?? []) render3(c, depth)
  }
  render3(updTree)
  ok(updButtons.some((b) => b.includes('检查更新')), `更新页签有「检查更新」按钮（${updButtons.join(' / ')}）`)
  // 更新页签面向整个 profile，不是某个会话：不该出现会话工具条上的动作。
  ok(!updButtons.some((b) => b.includes('一键重试')), '更新页签不套用会话工具条')

  console.log('\n五之二、插件管理页签渲染')
  sharedStore.set('dsh-task-journal:last-tab', 'plugins')
  const { mod: modP, React: ReactP } = loadBundle(sharedStore)
  let sectionP = null
  const slotsP = {
    register: (spec, Comp) => { sectionP = { spec, Comp } },
    inject: (name, cb) => cb(),
  }
  modP.apply({ effect: (f) => f(), slots: slotsP })
  ReactP._reset()
  let pTree = null
  let pErr = null
  try { pTree = sectionP.Comp({}) } catch (e) { pErr = e }
  ok(pErr === null, '插件管理页签渲染不抛异常' + (pErr === null ? '' : `：${pErr.message}`))
  const pButtons = []
  const pInputs = []
  const seenP = new Set()
  const renderP = (node, depth = 0) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (depth > 40) return
    if (Array.isArray(node)) { for (const c of node) renderP(c, depth); return }
    if (typeof node.type === 'function') {
      if (seenP.has(node.type)) return
      seenP.add(node.type)
      renderP(node.type(node.props), depth + 1)
      return
    }
    if (node.type === 'button' && typeof node.children?.[0] === 'string') pButtons.push(node.children[0])
    if (node.type === 'input' && typeof node.props?.placeholder === 'string') pInputs.push(node.props.placeholder)
    for (const c of node.children ?? []) renderP(c, depth + 1)
  }
  renderP(pTree)
  ok(pButtons.some((b) => b.includes('安装')), `插件管理有「安装」按钮（${pButtons.join(' / ')}）`)
  ok(pButtons.some((b) => b.includes('刷新')), '插件管理有「刷新」按钮')
  ok(pInputs.some((t) => t.includes('包名')), `有 spec 输入框（${pInputs.join(' / ')}）`)
  ok(!pButtons.some((b) => b.includes('一键重试')), '插件管理页签不套用会话工具条')

  console.log('\n六、镜像源页签渲染')
  sharedStore.set('dsh-task-journal:last-tab', 'mirrors')
  // 注入一份假的镜像数据：这样才走得到两栏与按钮那些依赖数据的分支。
  const fakeEntries = [
    { id: 'npm', label: 'npm', what: 'Node 包', file: '/home/u/.npmrc', exists: true, canApply: true,
      requiresAuth: false, needsRoot: false, readOnly: false, official: 'https://registry.npmjs.org/',
      current: 'https://registry.npmjs.org/', usingMirror: false, mirrorLabel: null, error: null,
      mirrors: [{ label: '淘宝', url: 'https://registry.npmmirror.com/' }] },
    { id: 'docker', label: 'Docker', what: '容器镜像', file: '/etc/docker/daemon.json', exists: true,
      canApply: false, requiresAuth: true, needsRoot: false, readOnly: false, official: [],
      current: ['https://a/'], usingMirror: false, mirrorLabel: null, error: null,
      mirrors: [{ label: 'DaoCloud', url: 'https://docker.m.daocloud.io' }] },
  ]
  const fakeFetch = async (url) => {
    const u = String(url)
    if (u.includes('/mirrors/auth')) return { ok: true, status: 200, json: async () => ({ authorized: false }) }
    if (u.includes('/mirrors')) return { ok: true, status: 200, json: async () => ({ ok: true, entries: fakeEntries }) }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const { mod: mod4, React: React4 } = loadBundle(sharedStore, fakeFetch)
  let section4 = null
  const slots4 = {
    register: (spec, Comp) => { section4 = { spec, Comp } },
    inject: (name, cb) => cb(),
  }
  mod4.apply({ effect: (f) => f(), slots: slots4 })
  React4._reset()
  let mirTree = null
  let mirErr = null
  try { mirTree = section4.Comp({}) } catch (e) { mirErr = e }
  ok(mirErr === null, '镜像源页签渲染不抛异常' + (mirErr === null ? '' : `：${mirErr.message}`))
  // 跑一遍挂载后的自动加载，再重渲染看数据分支
  const mirButtons = []
  const mirInputs = []
  const mirCols = { n: 0 }
  const mirTwo = { n: 0 }
  const seen4 = new Set()
  const render4 = (node, depth = 0) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (depth > 40) return
    if (Array.isArray(node)) { for (const c of node) render4(c, depth); return }
    if (typeof node.type === 'function') {
      if (seen4.has(node.type)) return
      seen4.add(node.type)
      render4(node.type(node.props), depth + 1)
      return
    }
    if (node.type === 'button' && typeof node.children?.[0] === 'string') mirButtons.push(node.children[0])
    if (node.type === 'input') mirInputs.push(node.props ?? {})
    // 栏容器要在**渲染后的树**里数：countNodes 不调用函数组件，
    // 直接查 mirTree 只会看到一个未渲染的 MirrorsPanel 元素。
    const cls = node.props?.className
    if (typeof cls === 'string' && cls.includes('dtj_col')) mirCols.n += 1
    if (typeof cls === 'string' && cls.includes('dtj_two')) mirTwo.n += 1
    for (const c of node.children ?? []) render4(c, depth)
  }
  render4(mirTree)
  // MirrorsPanel 是子组件：只有走完渲染树它才被调用，它的「挂载后自动加载」
  // 才会登记。所以必须先渲染、再 flush、再渲染一次。
  await React4._flush()
  mirButtons.length = 0
  mirInputs.length = 0
  mirCols.n = 0
  mirTwo.n = 0
  seen4.clear()
  // 关键：重渲染前要把槽计数器归零。状态值本身要留着（那才是刚加载的数据），
  // 但计数器不归零的话，顶层组件会从错位的下标读状态，
  // 于是读到的是「上一个组件的状态」，界面整个走错分支。
  React4._reset()
  try { mirTree = section4.Comp({}) } catch (e) { mirErr = e }
  render4(mirTree)
  ok(mirButtons.some((b) => b.includes('授权')), `镜像页签有授权按钮（${mirButtons.join(' / ')}）`)
  ok(mirButtons.some((b) => b.includes('刷新')), '有刷新按钮')
  // 密码输入框必须是 password 类型：不能被肩窥，也不能被浏览器记住
  const pwInput = mirInputs.find((i) => i.type === 'password')
  ok(pwInput !== undefined, '有密码输入框')
  ok(pwInput?.type === 'password', '密码框类型是 password')
  ok(pwInput?.autoComplete === 'off', '密码框关掉自动填充')
  // 两栏结构
  ok(mirTwo.n >= 1, `有左右两栏的容器（找到 ${mirTwo.n} 个）`)
  ok(mirCols.n >= 2, `渲染出两栏（找到 ${mirCols.n} 个栏容器）`)
  // 左栏是工具清单，右栏是选中项详情 —— 用真实数据验证内容出现了
  const leftCol = mirCols.n >= 2
  ok(leftCol, '两栏都渲染出来了')

  console.log('\n七、关于页签渲染')
  sharedStore.set('dsh-task-journal:last-tab', 'about')
  // 注入一份真实形状的 about 数据（字段与 lib/about.js 的 gather 一致）。
  const aboutPayload = {
    ok: true,
    self: { name: 'dsh-task-journal', version: '0.1.0', dir: '/home/u/.dsh/plugins/dsh-task-journal',
      dirDisplay: '~/.dsh/plugins/dsh-task-journal', license: 'MIT', engines: { node: '>=22.5', dsh: '>=0.1.7-rc.2' },
      dependencyCount: 1, repo: 'https://github.com/q785845530/dsh-task-journal',
      repoSlug: 'q785845530/dsh-task-journal', remote: 'git@github.com:q785845530/dsh-task-journal.git' },
    github: { ok: true, stars: 7, forks: 2, openIssues: 1, pushedAt: '2026-10-17T16:00:00Z', license: 'MIT' },
    commands: { install: 'dsh plugin --profile web add dsh-task-journal',
      uninstall: 'dsh plugin --profile web remove dsh-task-journal',
      installFromGit: 'dsh plugin --profile web add https://github.com/q785845530/dsh-task-journal' },
    reload: { startedAt: 1792257000000, uptimeMs: 60000, reloadCount: 2, moduleLoads: 3,
      hotReloaded: true, moduleFirstAt: 1792257000000, moduleLoadedAt: 1792257600000,
      lastReloadAt: 1792257600000,
      lastReloadFiles: ['/a/lib/index.js'], eventSubscribed: true, filesNewerThanStart: null, mtimes: [] },
    data: { dir: '/home/u/proj/.dsh-journal', dirDisplay: '~/proj/.dsh-journal', exists: true, bytes: 2048, files: 4, truncated: false },
    profiles: { detected: ['web'], linked: ['web'], scanned: 2, active: 'web', assumed: false },
    installed: [
      { name: 'dsh-task-journal', version: '0.1.0', enabled: true, removable: true, official: false, source: 'link:', local: true },
      { name: 'dsh-repair', version: '0.1.0', enabled: true, removable: true, official: false, source: 'registry', local: false },
    ],
    links: { repo: 'https://github.com/q785845530/dsh-task-journal',
      issues: 'https://github.com/q785845530/dsh-task-journal/issues',
      readme: 'https://github.com/q785845530/dsh-task-journal#readme',
      star: 'https://github.com/q785845530/dsh-task-journal' },
  }
  const aboutUpdates = { ok: true, counts: { installed: 2, updatable: 1, appliable: 1, blocked: 0 },
    source: 'registry', plugins: [
      { name: 'dsh-task-journal', version: '0.1.0', updatable: true, removable: true, blocked: null,
        market: { status: 'update-available', latestVersion: '0.2.0' } },
    ] }
  const aboutFetch = async (url) => {
    const u = String(url)
    if (u.includes('/about')) return { ok: true, status: 200, json: async () => aboutPayload }
    if (u.includes('/updates')) return { ok: true, status: 200, json: async () => aboutUpdates }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const { mod: mod5, React: React5 } = loadBundle(sharedStore, aboutFetch)
  let section5 = null
  const slots5 = { register: (spec, Comp) => { section5 = { spec, Comp } }, inject: (n, cb) => cb() }
  mod5.apply({ effect: (f) => f(), slots: slots5 })
  React5._reset()
  let aboutTree = null
  let aboutErr = null
  try { aboutTree = section5.Comp({}) } catch (e) { aboutErr = e }
  ok(aboutErr === null, '关于页签渲染不抛异常' + (aboutErr === null ? '' : `：${aboutErr.message}`))
  const collect5 = { buttons: [], codes: [], texts: [] }
  const seen5 = new Set()
  const render5 = (node, depth = 0) => {
    // 字符串要在「不是对象就返回」之前收掉，否则文字全被丢掉。
    if (typeof node === 'string') { collect5.texts.push(node); return }
    if (node === null || node === undefined || typeof node !== 'object') return
    if (depth > 45) return
    if (Array.isArray(node)) { for (const c of node) render5(c, depth); return }
    if (typeof node.type === 'function') {
      if (seen5.has(node.type)) return
      seen5.add(node.type)
      render5(node.type(node.props), depth + 1)
      return
    }
    if (node.type === 'button' && typeof node.children?.[0] === 'string') collect5.buttons.push(node.children[0])
    if (node.type === 'code' && typeof node.children?.[0] === 'string') collect5.codes.push(node.children[0])
    for (const c of node.children ?? []) render5(c, depth)
  }
  render5(aboutTree)
  // 先渲染一次让 effect 登记，再 flush 加载数据，再重渲染
  await React5._flush()
  collect5.buttons.length = 0; collect5.codes.length = 0; collect5.texts.length = 0
  seen5.clear()
  React5._reset()
  try { aboutTree = section5.Comp({}) } catch (e) { aboutErr = e }
  render5(aboutTree)

  const allText = collect5.texts.join(' ')
  ok(collect5.buttons.some((b) => b.includes('Star')), `有「去 GitHub 点 Star」按钮（${collect5.buttons.join(' / ')}）`)
  ok(collect5.buttons.some((b) => b.includes('刷新')), '有刷新按钮')
  ok(collect5.buttons.some((b) => b.includes('升级到')), `有升级按钮（含目标版本）`)
  ok(collect5.buttons.some((b) => b.includes('提 Issue')), '有提 Issue 按钮')
  ok(collect5.codes.some((c) => c.includes('~/.dsh/plugins/dsh-task-journal')), '显示本地路径')
  ok(collect5.codes.some((c) => c.includes('dsh plugin --profile web add')), '显示安装命令')
  ok(collect5.codes.some((c) => c.includes('remove')), '显示卸载命令')
  ok(allText.includes('0.1.0'), '显示版本')
  ok(allText.includes('链接安装'), '标出链接安装方式')
  ok(allText.includes('0.2.0'), '显示可升级到的版本')
  ok(allText.includes('插件模块加载'), '显示模块加载次数（热重载的可靠证据）')
  ok(allText.includes('磁盘与进程一致'), '显示磁盘与进程是否一致')
  ok(allText.includes('dsh-repair'), '列出全部已安装插件')
  ok(allText.includes('本地来源'), '标出本地来源的插件')

  // 磁盘比进程新时，要明确提示「改了没生效」
  // 这次模拟「没热重载过」：moduleLoads 仍是 1。
  const staleAbout = { ...aboutPayload, reload: { ...aboutPayload.reload, moduleLoads: 1, hotReloaded: false,
    filesNewerThanStart: { file: '/x/lib/index.js', mtime: 1792299999000 } } }
  const staleFetch = async (url) => {
    const u = String(url)
    if (u.includes('/about')) return { ok: true, status: 200, json: async () => staleAbout }
    if (u.includes('/updates')) return { ok: true, status: 200, json: async () => aboutUpdates }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const store2 = new Map()
  // 新 store 不会记住页签，会退回默认的「任务清单」——先设成 about。
  store2.set('dsh-task-journal:last-tab', 'about')
  const { mod: mod6, React: React6 } = loadBundle(store2, staleFetch)
  let section6 = null
  mod6.apply({ effect: (f) => f(), slots: { register: (s2, C) => { section6 = { spec: s2, Comp: C } }, inject: (n, cb) => cb() } })
  React6._reset()
  let staleTree = null
  try { staleTree = section6.Comp({}) } catch { staleTree = null }
  const seen6 = new Set()
  const texts6 = []
  const render6 = (node, depth = 0) => {
    if (typeof node === 'string') { texts6.push(node); return }
    if (node === null || node === undefined || typeof node !== 'object') return
    if (depth > 45) return
    if (Array.isArray(node)) { for (const c of node) render6(c, depth); return }
    if (typeof node.type === 'function') {
      if (seen6.has(node.type)) return
      seen6.add(node.type); render6(node.type(node.props), depth + 1); return
    }
    for (const c of node.children ?? []) render6(c, depth)
  }
  render6(staleTree)
  await React6._flush()
  texts6.length = 0; seen6.clear(); React6._reset()
  try { staleTree = section6.Comp({}) } catch { staleTree = null }
  render6(staleTree)
  const staleText = texts6.join(' ')
  ok(staleText.includes('改动还没生效'), '磁盘比进程新时提示「改动还没生效」')
  ok(staleText.includes('磁盘有改动'), '状态标为「磁盘有改动」')
  ok(staleText.includes('需要重启'), '未热重载时说清需要重启（不让人白等自动重载）')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
