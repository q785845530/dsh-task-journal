/**
 * dsh-task-journal — 够用的语义化版本。
 *
 * 为什么自己写：插件进程只能 import `@deepseek-ai/dsh-tools` 与 `cordis`，
 * 拿不到 `semver`。而升级路径是「先移除、再安装」—— 中间没有回退，
 * 所以**必须在移除之前**判断目标版本能不能在当前运行时上跑。
 * 判断错了，用户就少了插件。
 *
 * 支持范围：`||`、空格（与）、`^`、`~`、`>=` `>` `<=` `<` `=`，以及裸版本。
 * 不支持：`x`/`*` 通配、连字符区间、`npm:` 别名。认不出来的范围一律返回
 * `null`（未知），调用方据此保守处理，而不是当成通过。
 *
 * 口径与 DSH 一致：DSH 判兼容性用的是
 * `semver.satisfies(v, range, { includePrerelease: true })`，
 * 所以这里也不加标准 semver 那条「先行版本号只能匹配同元组」的限制。
 *
 * @module dsh-task-journal/semver
 */

/** 拆一个版本号；不合法返回 null。 */
export function parseVersion(text) {
  const s = String(text ?? '').trim()
  if (s === '') return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s)
  if (m === null) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
  }
}

/** 比一个先行标识符：数字按数值比，数字小于非数字，其余按字典序。 */
function comparePre(a, b) {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Math.sign(Number(a) - Number(b))
  if (an) return -1
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 比较两个版本。
 *
 * 有先行版本号的小于没有的（`1.0.0-alpha < 1.0.0`）。
 *
 * @returns {number|null} -1 / 0 / 1；任一侧不合法返回 null。
 */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (x === null || y === null) return null
  return compareParsed(x, y)
}

/** 比较两个已解析的版本。 */
function compareParsed(x, y) {
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0
  if (x.pre.length === 0) return 1
  if (y.pre.length === 0) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const c = comparePre(p, q)
    if (c !== 0) return c < 0 ? -1 : 1
  }
  return 0
}

/** 一个比较器：`>=1.2.3`、`^1.2.3`、`1.2.3` 等。 */
function parseComparator(text) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(text.trim())
  if (m === null) return null
  const op = m[1] ?? '='
  const version = parseVersion(m[2])
  if (version === null) return null
  return { op, version, raw: m[2].trim() }
}

/** 单个比较器是否满足。 */
function testComparator(version, comparator) {
  const { op, version: c } = comparator
  const cmp = compareParsed(version, c)
  if (cmp === null) return false
  switch (op) {
    case '=': return cmp === 0
    case '>': return cmp > 0
    case '>=': return cmp >= 0
    case '<': return cmp < 0
    case '<=': return cmp <= 0
    case '^': {
      // ^1.2.3 → >=1.2.3 <2.0.0；^0.2.3 → >=0.2.3 <0.3.0；^0.0.3 → >=0.0.3 <0.0.4
      if (cmp < 0) return false
      if (c.major !== 0) return version.major === c.major
      if (c.minor !== 0) return version.major === 0 && version.minor === c.minor
      return version.major === 0 && version.minor === 0 && version.patch === c.patch
    }
    case '~': {
      // ~1.2.3 → >=1.2.3 <1.3.0；~1.2 → >=1.2.0 <1.3.0
      if (cmp < 0) return false
      return version.major === c.major && version.minor === c.minor
    }
    default: return false
  }
}

/**
 * 版本是否落在范围内。
 *
 * @param {string} version 版本号。
 * @param {string} range 范围表达式。
 * @returns {boolean|null} true / false；范围认不出来时返回 null（未知，别当通过）。
 */
export function satisfies(version, range) {
  const v = parseVersion(version)
  const text = String(range ?? '').trim()
  if (v === null || text === '') return null

  const groups = text.split('||')
  let evaluated = false
  for (const group of groups) {
    const parts = group.trim().split(/\s+/).filter((p) => p !== '')
    if (parts.length === 0) continue
    const comparators = []
    let usable = true
    for (const part of parts) {
      const c = parseComparator(part)
      if (c === null) { usable = false; break }
      comparators.push(c)
    }
    // 认不出来的组不算数：整段只要有一组认不出，就退回「未知」。
    if (!usable) return null
    evaluated = true
    // 同一组内的比较器是「与」。
    //
    // 这里**刻意不加**标准 semver 的「先行版本号只能匹配同一
    // major.minor.patch 的先行比较器」那条限制：DSH 判定兼容性时用的是
    // `semver.satisfies(v, range, { includePrerelease: true })`，
    // 那条限制在该模式下不生效。我们要和它一致 —— 比它严会拦下本该能升的包，
    // 比它松会在移除旧版之后被 DSH 拒绝安装，把插件弄丢。
    if (!comparators.every((c) => testComparator(v, c))) continue
    return true
  }
  return evaluated ? false : null
}
