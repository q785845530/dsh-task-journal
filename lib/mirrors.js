/**
 * dsh-task-journal — 包管理器镜像管理。
 *
 * 管的是「把国外源换成国内镜像」这件事：查看现状、切到镜像、切回原源。
 * 顺带能测速，帮人判断哪个镜像真的快。
 *
 * ## 为什么这么谨慎
 * 这个模块改的是**系统的工具配置**（`~/.npmrc`、`pip.conf`、`daemon.json`…）。
 * 改错了会让 `npm install` / `pip install` 直接失败，而且人往往在几小时后
 * 才发现。所以：
 *   - 只碰**已知的键**，文件里其它行原样保留；
 *   - 写之前先备份，备份名带时间戳，可回退；
 *   - 原子写（临时文件 + rename），不留半个文件；
 *   - 需要 root 才能改的（Docker 的 `/etc/docker/daemon.json`）
 *     **不去偷偷试**，如实报告「要人来做」并给出命令。
 *
 * @module dsh-task-journal/mirrors
 */
import { copyFile, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'

/** 家目录简写。 */
const H = () => homedir()

/**
 * 镜像清单。
 *
 * 每项描述「一个工具怎么换源」：
 *   - `official`：原源（清除镜像时恢复到它）；
 *   - `mirrors`：可选的国内镜像；
 *   - `file` / `format` / `key`：配置在哪、什么格式、改哪个键。
 *
 * `format` 决定读写方式：
 *   - `npmrc`：`key=value` 行，替换同名键；
 *   - `ini`：`[global]` 段里的 `key = value`；
 *   - `yaml`：单行 `key: value`；
 *   - `json`：整份解析后改字段（Docker）；
 *   - `manual`：要 root 或格式复杂，只给命令，不动手。
 */
export const CATALOG = [
  {
    id: 'npm',
    label: 'npm',
    what: 'Node 包安装源',
    file: join(H(), '.npmrc'),
    format: 'npmrc',
    key: 'registry',
    official: 'https://registry.npmjs.org/',
    mirrors: [
      { label: 'npmmirror（淘宝）', url: 'https://registry.npmmirror.com/' },
      { label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/npm/' },
      { label: '华为云', url: 'https://mirrors.huaweicloud.com/repository/npm/' },
      { label: 'CNPM', url: 'https://r.cnpmjs.org/' },
    ],
    probe: (base) => `${base.replace(/\/+$/, '')}/-/ping`,
  },
  {
    id: 'pnpm',
    label: 'pnpm',
    what: 'Node 包安装源（pnpm）',
    // pnpm 有自己的 registry 位置：~/.config/pnpm/auth.ini。
    // 它**不读** ~/.npmrc 里的 registry（那是 npm 的），
    // 所以拿 npm 的行去判断 pnpm 会得出错误结论 —— 实测踩过。
    file: join(H(), '.config', 'pnpm', 'auth.ini'),
    format: 'npmrc',
    key: 'registry',
    official: 'https://registry.npmjs.org/',
    mirrors: [
      { label: 'npmmirror（淘宝）', url: 'https://registry.npmmirror.com/' },
      { label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/npm/' },
      { label: '华为云', url: 'https://mirrors.huaweicloud.com/repository/npm/' },
    ],
    probe: (base) => `${base.replace(/\/+$/, '')}/-/ping`,
  },
  {
    id: 'yarn',
    label: 'yarn',
    what: 'Node 包安装源（yarn）',
    file: join(H(), '.yarnrc.yml'),
    format: 'yaml',
    key: 'npmRegistryServer',
    official: 'https://registry.yarnpkg.com',
    mirrors: [
      { label: 'npmmirror（淘宝）', url: 'https://registry.npmmirror.com' },
      { label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/npm' },
    ],
    probe: (base) => `${base.replace(/\/+$/, '')}/-/ping`,
  },
  {
    id: 'pypi',
    label: 'pip',
    what: 'Python 包安装源',
    file: join(H(), '.config', 'pip', 'pip.conf'),
    format: 'ini',
    key: 'index-url',
    section: 'global',
    official: null, // pip 没有显式默认源：清掉即回官方
    mirrors: [
      { label: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple/' },
      { label: '清华 TUNA', url: 'https://pypi.tuna.tsinghua.edu.cn/simple/' },
      { label: '中科大 USTC', url: 'https://mirrors.ustc.edu.cn/pypi/simple/' },
      { label: '华为云', url: 'https://repo.huaweicloud.com/repository/pypi/simple/' },
      { label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/pypi/simple/' },
    ],
    probe: (base) => base,
  },
  {
    id: 'docker',
    label: 'Docker',
    what: '容器镜像拉取源',
    file: '/etc/docker/daemon.json',
    format: 'json',
    key: 'registry-mirrors',
    official: [],
    mirrors: [
      { label: '轩辕镜像', url: 'https://docker.xuanyuan.me' },
      { label: 'DaoCloud', url: 'https://docker.m.daocloud.io' },
      { label: '1Panel', url: 'https://docker.1panel.live' },
      { label: 'AtomHub（中科院）', url: 'https://atomhub.openatom.cn' },
      { label: '腾讯云', url: 'https://mirror.ccs.tencentyun.com' },
    ],
    probe: (base) => `${base.replace(/\/+$/, '')}/v2/`,
    // 在 /etc 下，要 root。本会话没有审批通道，绝不擅自 sudo。
    needsRoot: true,
    applyHint: '需要 root：把地址加进 daemon.json 的 registry-mirrors，再 systemctl restart docker',
  },
  {
    id: 'apt',
    label: 'APT',
    what: '系统包安装源',
    file: '/etc/apt/sources.list',
    format: 'manual',
    key: null,
    official: null,
    mirrors: [
      { label: '中科大 USTC', url: 'https://mirrors.ustc.edu.cn/debian/' },
      { label: '清华 TUNA', url: 'https://mirrors.tuna.tsinghua.edu.cn/debian/' },
      { label: '阿里云', url: 'https://mirrors.aliyun.com/debian/' },
      { label: '腾讯云', url: 'https://mirrors.cloud.tencent.com/debian/' },
    ],
    probe: (base) => `${base.replace(/\/+$/, '')}/dists/stable/Release`,
    needsRoot: true,
    // sources.list 的格式在不同 Debian 版本里差别很大（还有 .sources 新格式），
    // 自动改的风险高于收益：改坏会导致 apt 完全不可用。
    applyHint: '需要 root，且 Debian 13 存在两种源格式。建议手工改 /etc/apt/sources.list',
  },
  {
    id: 'github',
    label: 'GitHub 加速',
    what: '克隆 / 下载 GitHub 资源的代理',
    file: join(H(), '.gitconfig'),
    format: 'npmrc',
    key: null,
    official: null,
    // GitHub 加速是「临时套一层前缀」，不是改某个配置键，所以只提供地址与测速。
    mirrors: [
      { label: 'gh-proxy.com', url: 'https://gh-proxy.com/' },
      { label: 'ghfast.top', url: 'https://ghfast.top/' },
      { label: 'ghproxy.net', url: 'https://ghproxy.net/' },
      { label: 'kkgithub', url: 'https://raw.kkgithub.com/' },
    ],
    probe: (base) => base,
    readOnly: true,
    applyHint: 'GitHub 加速是给地址加前缀（如 git clone https://gh-proxy.com/https://github.com/x/y），不改系统配置',
  },
]

/** 按 id 取一项。 */
export function entryById(id) {
  return CATALOG.find((x) => x.id === id) ?? null
}

// ————————————————————————— 读 —————————————————————————

/**
 * 从文本里读出当前配置值。
 *
 * 只认已知格式。认不出就返回 `null`，让上层显示「未设置」——
 * 比猜一个值安全。
 */
export function readValue(text, entry) {
  const s = String(text ?? '')
  if (s === '') return null

  if (entry.format === 'npmrc') {
    if (entry.key === null) return null
    // `key=value` 或 `key = value`，允许行首空格，忽略注释。
    const re = new RegExp(`^\\s*${entry.key}\\s*=\\s*(.+?)\\s*$`, 'm')
    const m = re.exec(s)
    return m === null ? null : m[1]
  }

  if (entry.format === 'ini') {
    // 限定在目标段内找，避免碰到别的段里同名键。
    const section = entry.section ?? 'global'
    const sec = new RegExp(`^\\[${section}\\]\\s*$`, 'm').exec(s)
    if (sec === null) return null
    const rest = s.slice(sec.index + sec[0].length)
    const next = /^\[[^\]]+\]\s*$/m.exec(rest)
    const body = next === null ? rest : rest.slice(0, next.index)
    const m = new RegExp(`^\\s*${entry.key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(body)
    return m === null ? null : m[1]
  }

  if (entry.format === 'yaml') {
    const m = new RegExp(`^\\s*${entry.key}\\s*:\\s*(.+?)\\s*$`, 'm').exec(s)
    if (m === null) return null
    return m[1].replace(/^['"]|['"]$/g, '')
  }

  if (entry.format === 'json') {
    try {
      const obj = JSON.parse(s)
      const v = obj?.[entry.key]
      if (Array.isArray(v)) return v
      return typeof v === 'string' ? v : null
    } catch { return null }
  }

  return null
}

/** 判断当前值是不是某个已知镜像。 */
export function isMirror(entry, value) {
  if (typeof value !== 'string' || value === '') return false
  const norm = (x) => x.replace(/\/+$/, '').toLowerCase()
  return entry.mirrors.some((m) => norm(m.url) === norm(value))
}

// ————————————————————————— 写 —————————————————————————

/**
 * 备份一份文件，返回备份路径。
 *
 * 备份名带时间戳，不覆盖任何已有文件。文件不存在时返回 null（没什么可备份的）。
 */
export async function backup(file) {
  try { await stat(file) } catch { return null }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${file}.dtj-backup-${stamp}`
  await copyFile(file, dest)
  return dest
}

/** 原子写：先写临时文件，再 rename 覆盖。保留原文件权限。 */
async function atomicWrite(file, text) {
  let mode = 0o600
  try {
    const st = await stat(file)
    mode = st.mode & 0o777
  } catch { /* 新文件：用 0600，因为里面可能有 token */ }
  const tmp = `${file}.dtj-tmp-${process.pid}`
  try {
    await writeFile(tmp, text, { mode })
    await rename(tmp, file)
  } catch (error) {
    try { await unlink(tmp) } catch { /* 清理失败不重要 */ }
    throw error
  }
}

/**
 * 修改文本里的目标键，其它内容原样保留。
 *
 * @param text 原文本。
 * @param entry 清单项。
 * @param value 新值；`null` 表示**删除这个键**（用于 pip 回官方源）。
 * @returns 新文本。
 */
export function rewrite(text, entry, value) {
  const s = String(text ?? '')

  if (entry.format === 'npmrc') {
    if (entry.key === null) throw new Error('这一项不能自动改（没有可写的配置键）')
    const re = new RegExp(`^\\s*${entry.key}\\s*=\\s*.*$`, 'm')
    if (value === null) {
      // 删掉这一行
      if (re.test(s)) return s.replace(new RegExp(`^\\s*${entry.key}\\s*=\\s*.*\\n?`, 'm'), '')
      return s
    }
    if (re.test(s)) return s.replace(re, `${entry.key}=${value}`)
    // 没有就追加，保证结尾有换行
    const sep = s === '' || s.endsWith('\n') ? '' : '\n'
    return `${s}${sep}${entry.key}=${value}\n`
  }

  if (entry.format === 'ini') {
    const section = entry.section ?? 'global'
    const head = `[${section}]`
    if (!s.includes(head)) {
      // 整份文件没有这个段：新建一个
      if (value === null) return s
      const sep = s === '' || s.endsWith('\n') ? '' : '\n'
      return `${s}${sep}${head}\n${entry.key} = ${value}\n`
    }
    const sec = new RegExp(`^\\[${section}\\]\\s*$`, 'm').exec(s)
    const before = s.slice(0, sec.index + sec[0].length)
    const rest = s.slice(sec.index + sec[0].length)
    const next = /^\[[^\]]+\]\s*$/m.exec(rest)
    let body = next === null ? rest : rest.slice(0, next.index)
    const after = next === null ? '' : rest.slice(next.index)

    const lineRe = new RegExp(`^\\s*${entry.key}\\s*=\\s*.*$`, 'm')
    if (value === null) {
      body = body.replace(new RegExp(`^\\s*${entry.key}\\s*=\\s*.*\\n?`, 'm'), '')
    } else if (lineRe.test(body)) {
      body = body.replace(lineRe, `${entry.key} = ${value}`)
    } else {
      const sep = body === '' || body.endsWith('\n') ? '' : '\n'
      body = `${body}${sep}${entry.key} = ${value}\n`
    }
    return before + body + after
  }

  if (entry.format === 'yaml') {
    const re = new RegExp(`^\\s*${entry.key}\\s*:\\s*.*$`, 'm')
    if (value === null) {
      if (re.test(s)) return s.replace(new RegExp(`^\\s*${entry.key}\\s*:\\s*.*\\n?`, 'm'), '')
      return s
    }
    if (re.test(s)) return s.replace(re, `${entry.key}: ${value}`)
    const sep = s === '' || s.endsWith('\n') ? '' : '\n'
    return `${s}${sep}${entry.key}: ${value}\n`
  }

  if (entry.format === 'json') {
    let obj = {}
    if (s.trim() !== '') {
      // 非法 JSON 不硬改：那会把用户的配置整个毁掉。
      try { obj = JSON.parse(s) } catch {
        throw new Error(`${entry.file} 不是合法 JSON，拒绝改写（先人工检查）`)
      }
    }
    if (value === null) delete obj[entry.key]
    else obj[entry.key] = value
    return `${JSON.stringify(obj, null, 2)}\n`
  }

  throw new Error(`这一项不支持自动改写（format=${entry.format}）`)
}

// ————————————————————————— 状态 —————————————————————————

/**
 * 汇总所有项的当前状态。
 *
 * @returns 每项：当前值、是否已是镜像、匹配到哪个镜像、能否自动改、要不要 root。
 */
export async function listStatus() {
  const out = []
  for (const entry of CATALOG) {
    let exists = false
    let text = ''
    let error = null
    let writable = false
    try {
      const st = await stat(entry.file)
      exists = true
      writable = (st.mode & 0o200) !== 0
      text = await readFile(entry.file, 'utf8')
    } catch (e) {
      if (e?.code !== 'ENOENT') error = e?.message ?? String(e)
    }

    const current = readValue(text, entry)
    const matched = entry.mirrors.find((m) => {
      const norm = (x) => x.replace(/\/+$/, '').toLowerCase()
      return typeof current === 'string' && norm(m.url) === norm(current)
    })

    out.push({
      id: entry.id,
      label: entry.label,
      what: entry.what,
      file: entry.file,
      exists,
      // 能不能自动改：格式支持 + 没标 needsRoot + 文件存在且可写（或可新建）
      canApply: entry.format !== 'manual' && entry.readOnly !== true
        && entry.needsRoot !== true && (exists === false || writable),
      needsRoot: entry.needsRoot === true,
      readOnly: entry.readOnly === true,
      official: entry.official,
      current,
      usingMirror: matched !== undefined,
      mirrorLabel: matched?.label ?? null,
      mirrors: entry.mirrors,
      applyHint: entry.applyHint ?? null,
      sharesWith: entry.sharesWith ?? null,
      error,
    })
  }
  return out
}

/**
 * 切换镜像。
 *
 * @param id 清单项 id。
 * @param url 目标地址；`null` 表示清除镜像（回到原源）。
 * @returns 结果：改了哪个文件、备份在哪、改成了什么。
 */
export async function apply(id, url) {
  const entry = entryById(id)
  if (entry === null) return { ok: false, reason: `没有这一项：${id}` }
  if (entry.format === 'manual' || entry.readOnly === true) {
    return { ok: false, reason: `「${entry.label}」不能在这里自动改。${entry.applyHint ?? ''}` }
  }
  if (entry.needsRoot === true) {
    return {
      ok: false,
      needsRoot: true,
      reason: `「${entry.label}」的配置在 ${entry.file}，需要 root。${entry.applyHint ?? ''}`,
      file: entry.file,
    }
  }
  // 清除镜像时回到原源；pip 没有显式原源，删掉这个键即可。
  const target = url === null ? entry.official : url
  if (url !== null && url !== undefined) {
    // 只接受清单里的镜像，或 http(s) 地址 —— 不接受任意字符串。
    const known = entry.mirrors.some((m) => m.url === url)
    if (!known && !/^https?:\/\/[^\s]+$/.test(String(url))) {
      return { ok: false, reason: `不是合法地址：${String(url)}` }
    }
  }
  if (url === null && entry.official === null && entry.format !== 'ini') {
    return { ok: false, reason: `「${entry.label}」没有记录原源，不知道该恢复成什么` }
  }

  let before = ''
  let exists = true
  try { before = await readFile(entry.file, 'utf8') } catch (e) {
    if (e?.code === 'ENOENT') exists = false
    else return { ok: false, reason: `读不到 ${entry.file}：${e?.message ?? String(e)}` }
  }

  const nextText = rewrite(before, entry, target)
  if (nextText === before) return { ok: true, changed: false, file: entry.file, value: target, reason: '本来就是目标状态' }

  let backupPath = null
  if (exists) {
    try { backupPath = await backup(entry.file) } catch (e) {
      return { ok: false, reason: `备份失败，为安全起见没有改：${e?.message ?? String(e)}` }
    }
  }
  try {
    // 目录可能不存在（比如 ~/.config/pip）
    await stat(dirname(entry.file)).catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dirname(entry.file), { recursive: true })
    })
    await atomicWrite(entry.file, nextText)
  } catch (e) {
    return { ok: false, reason: `写入失败：${e?.message ?? String(e)}`, backup: backupPath }
  }

  return {
    ok: true,
    changed: true,
    file: entry.file,
    value: target,
    cleared: url === null,
    backup: backupPath,
    // 有些工具改完要重启或重新登录才生效，说清楚比让人猜好。
    note: noteFor(entry, url),
  }
}

/** 改完之后的生效说明。 */
function noteFor(entry, url) {
  if (entry.id === 'npm' || entry.id === 'pnpm') return '下一条 npm/pnpm 命令即生效；已开着的 shell 不用重开。'
  if (entry.id === 'pip') return '下一条 pip 命令生效。'
  if (entry.id === 'yarn') return 'yarn 4 读 .yarnrc.yml，下一条命令生效。'
  return url === null ? '已切回原源。' : '已切到镜像。'
}

/** 把备份恢复回去。 */
export async function restore(backupPath) {
  const name = basename(String(backupPath))
  if (!name.includes('.dtj-backup-')) return { ok: false, reason: '只能恢复本功能产生的备份文件' }
  try {
    const text = await readFile(backupPath, 'utf8')
    // 备份名是 `<原文件>.dtj-backup-<时间>`，去掉后缀就是原文件。
    const original = String(backupPath).replace(/\.dtj-backup-[^.]+$/, '')
    if (original === String(backupPath)) return { ok: false, reason: '备份名不合规，认不出原文件' }
    await atomicWrite(original, text)
    return { ok: true, file: original, bytes: text.length }
  } catch (e) {
    return { ok: false, reason: `恢复失败：${e?.message ?? String(e)}` }
  }
}

// ————————————————————————— 测速 —————————————————————————

/**
 * 测一个地址的响应。
 *
 * 用轻量端点（`probe`），不拉真包 —— 拉包会把「慢」和「大」混在一起。
 *
 * 超时单独标记：**超时和失败不是一回事**，超时说明「连上了但很慢」或
 * 「根本连不上」，这两种要分开说，否则人没法判断能不能用。
 */
export async function probe(url, options = {}) {
  const timeout = options.timeout ?? 8000
  if (!/^https?:\/\/[^\s]+$/.test(String(url))) {
    return { ok: false, url, reason: '不是合法地址' }
  }
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': 'dsh-task-journal/mirror-probe' },
    })
    const ms = Date.now() - started
    // 镜像站对 HEAD/GET 的返回五花八门，2xx/3xx/401/403 都说明「服务在」。
    const reachable = res.status < 500
    return { ok: true, url, status: res.status, ms, reachable, timeout: false }
  } catch (error) {
    const ms = Date.now() - started
    const aborted = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return {
      ok: false,
      url,
      ms,
      timeout: aborted,
      reachable: false,
      reason: aborted ? `超时（${timeout}ms 内没响应）` : (error?.message ?? String(error)),
    }
  }
}

/**
 * 测一组镜像：同一项的多个候选，加上原源做对照。
 *
 * 逐条测（不并发），因为并发会互相干扰延迟读数 —— 测速本身要让测量可信。
 */
export async function probeAll(id, options = {}) {
  const entry = entryById(id)
  if (entry === null) return { ok: false, reason: `没有这一项：${id}` }
  const list = []
  if (entry.official !== null && typeof entry.official === 'string') {
    list.push({ label: '原源', url: entry.official, official: true })
  }
  for (const m of entry.mirrors) list.push({ label: m.label, url: m.url, official: false })

  const results = []
  for (const item of list) {
    const probeUrl = typeof item.url === 'string' ? entry.probe(item.url) : ''
    const r = await probe(probeUrl, options)
    results.push({ ...item, probeUrl, ...r })
  }
  // 排个序方便看：能用的在前，按延迟升序；不可达的垫底。
  results.sort((a, b) => {
    const av = a.ok && a.reachable ? a.ms : Infinity
    const bv = b.ok && b.reachable ? b.ms : Infinity
    return av - bv
  })
  return { ok: true, id, label: entry.label, results }
}

/**
 * 测一个自定义地址（用户新加的镜像）。
 *
 * @param url 完整请求地址（已经是可探测的地址，不是 registry 根）。
 * @param kind 可选：清单项 id，用来推导 probe 路径。
 */
export async function probeCustom(url, kind, options = {}) {
  let probeUrl = String(url ?? '')
  const entry = kind === undefined || kind === null ? null : entryById(kind)
  if (entry !== null && typeof entry.probe === 'function') {
    probeUrl = entry.probe(probeUrl)
  }
  const r = await probe(probeUrl, options)
  // 展开 r 之后要把原始 url 放回去：probe 的返回里也有 url（探测地址），
  // 顺序不对会让调用方以为用户输的地址被改写了。
  return { ...r, ok: true, url, probeUrl }
}
