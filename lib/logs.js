/**
 * dsh-task-journal — DSH 后台诊断日志。
 *
 * 读取 `$DSH_HOME/logs/startup-*.log`：DSH 启动失败时写下的诊断快照。
 * 做三件事：
 *   1. **读**：列出日志、解析出结构化字段（时间、版本、profile、错误）；
 *   2. **诊**：从文本里认出常见故障，给出人话结论；
 *   3. **修**：为认得出的故障生成修复方案 —— 可执行的命令 + 说明。
 *
 * ## 为什么不去读 stdout
 * 网关的 stdout 常常是 socket 或终端（`/proc/<pid>/fd/1 -> socket:[...]`），
 * 插件拿不到，也读不到历史。`startup-*.log` 是 DSH 自己落盘的、有固定格式的
 * 唯一稳定来源。
 *
 * ## 格式
 * 不是 JSON：`util.inspect` 的文本输出（`{ key: value }`），前面一行 WARNING
 * 提示可能含凭据。所以解析只能是**尽力而为的文本匹配**，认不出就如实说认不出，
 * 绝不猜。
 *
 * @module dsh-task-journal/logs
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { redactSecrets } from './redact.js'

/** 日志目录：跟随 `DSH_HOME`，与 DSH 自己写入的位置一致。 */
export function logsDir(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'logs')
}

/** 文件名 → 结构化元信息；认不出就是 null。 */
export function parseLogName(name) {
  const m = /^startup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z-([0-9a-f-]{36})\.log$/.exec(name)
  if (m === null) return null
  return {
    name,
    // 文件名里的时间戳被替换过冒号，还原成合法 ISO。
    at: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`,
    id: m[6],
  }
}

/**
 * 从日志文本里抽出头部字段。
 *
 * DSH 用 `util.inspect` 打印一个对象，所以这里按 `key: value` 逐行取。
 * 取不到的字段一律给 null，不补默认值 —— 「不知道」和「是空」不是一回事。
 */
export function parseHeader(text) {
  const s = String(text ?? '')
  const grab = (key) => {
    const m = new RegExp(`^\\s{2,4}${key}:\\s*'([^']*)'`, 'm').exec(s)
    return m === null ? null : m[1]
  }
  return {
    timestamp: grab('timestamp'),
    dshVersion: grab('dshVersion'),
    nodeVersion: grab('nodeVersion'),
    platform: grab('platform'),
    arch: grab('arch'),
    profile: grab('profile'),
  }
}

/**
 * 认出「启动失败」那一行。
 *
 * 形如：`dsh: startup failed: 2 required plugins did not activate`
 */
export function parseStartupError(text) {
  const s = String(text ?? '')
  const m = /dsh: startup failed: (\d+) required plugin(?:s)? did not activate/.exec(s)
  if (m === null) return null
  return { count: Number(m[1]), message: m[0] }
}

/**
 * 抽出失败插件清单。
 *
 * 每项形如：
 * ```
 *   Failed plugins (1):
 *     webserver (required)
 *       Package: @deepseek-ai/dsh-host-webserver
 *       Error: listen EADDRINUSE: address already in use 127.0.0.1:3080
 * ```
 * 缩进层级会随嵌套深度变化，所以只按「Package:」与「Error:」定位，不依赖列号。
 *
 * 续行只在**明确是 AggregateError 的条目列表**时才接上（`- xxx: 原因`）。
 * 别的一律不接：这些日志里 `util.inspect` 的内联对象动辄几千字符，
 * 顺手接上去会把一条干净的报错污染成整段垃圾。
 */
export function parseFailedPlugins(text) {
  const s = String(text ?? '')
  const out = []
  const start = s.search(/Failed plugins \(\d+\):/)
  if (start < 0) return out
  // 截到下一个段标题为止，避免把别处的 Package 也算进来。
  const tail = s.slice(start)
  const stop = tail.search(/\n {2}Plugins waiting for services|\n {2}\[startup\]:/)
  const body = stop < 0 ? tail : tail.slice(0, stop)

  let current = null
  let inAggregate = false
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('Failed plugins')) continue

    // 段内的插件条目头：`webserver (required)` / `typert-loader`
    const head = /^([A-Za-z0-9@/._-]+)(?: \((required|optional)\))?$/.exec(trimmed)
    if (head !== null) {
      current = { id: head[1], required: head[2] === 'required', packages: [], errors: [] }
      out.push(current)
      inAggregate = false
      continue
    }
    if (current === null) continue

    const pkg = /^Package:\s*(\S+)/.exec(trimmed)
    if (pkg !== null) { current.packages.push(pkg[1]); continue }

    const err = /^Error:\s*(.+)$/.exec(trimmed)
    if (err !== null) {
      current.errors.push(err[1].trim())
      inAggregate = /failed to register|AggregateError/.test(err[1])
      continue
    }
    // AggregateError 的条目列表：接上，但限长，免得一条错误吃掉整份日志。
    if (inAggregate && /^- \S/.test(trimmed) && current.errors.length > 0) {
      const last = current.errors[current.errors.length - 1]
      if (last.length < 400) current.errors[current.errors.length - 1] = `${last}；${trimmed}`
    }
  }
  // 错误行自己也可能很长（内联对象），统一砍到可读长度。
  for (const item of out) {
    item.errors = item.errors.map((e) => (e.length > 400 ? `${e.slice(0, 400)}…` : e))
  }
  return out
}

/**
 * 抽出运行时告警（`[startup]: { messages: [...] }` 段）。
 *
 * 每条形如：
 * ```
 * { ts: 1792218933822, name: 'dsh-dingtalk', type: 'warn',
 *   args: [ '未配置：webhook...', [length]: 1 ] }
 * ```
 * 这里只要 name / type / 第一条字符串参数，够定位就够了。
 */
export function parseRuntimeMessages(text) {
  const s = String(text ?? '')
  const out = []
  const block = /\[startup\]:\s*\{[\s\S]*?messages:\s*\[([\s\S]*?)\n {6}\]/.exec(s)
  if (block === null) return out
  const re = /\{\s*ts:\s*(\d+),\s*name:\s*'([^']*)',\s*type:\s*'(warn|error)',\s*args:\s*\[([\s\S]*?)\](\s*,\s*\[length\]:\s*\d+)?\s*\}/g
  let m
  while ((m = re.exec(block[1])) !== null) {
    // 第一个参数有四种写法，都要认：
    //   - 'single quoted'
    //   - `backtick template${...}`（util.inspect 对含引号的内容会换成反引号）
    //   - Error: xxx（插件直接把 Error 丢进 logger）
    //   - 其它对象（认不出就给空，但下面会标出来）
    const str = /^\s*'((?:[^'\\]|\\.)*)'/.exec(m[4])
    const tmpl = /^\s*`((?:[^`\\]|\\.)*)`/.exec(m[4])
    const err = /^\s*(?:[A-Za-z]*Error):\s*(.+)$/m.exec(m[4])
    let message = ''
    if (str !== null) message = str[1].replace(/\\'/g, "'")
    else if (tmpl !== null) message = tmpl[1].replace(/\\`/g, '`').replace(/\$\{[^}]*\}/g, '${…}')
    else if (err !== null) message = err[1].trim()
    out.push({
      ts: Number(m[1]),
      name: m[2],
      type: m[3],
      message: message.length > 300 ? `${message.slice(0, 300)}…` : message,
      // 认不出第一个参数时如实标记，别让调用方以为「这条没内容」。
      unparsed: message === '',
    })
  }
  return out
}

/**
 * 诊断：把已解析的内容归成「故障 → 人话结论 → 修复方案」。
 *
 * 每条规则的 `match` 只看**已经解析出来的结构**，不看原始文本的模糊片段 ——
 * 宁可漏报，也不要凭一个词就断言原因。
 *
 * `fixes` 里 `kind: 'command'` 的可以直接执行；`kind: 'manual'` 的只能人做，
 * 这一区分很关键：自动跑一条错的命令比不跑更糟。
 */
export const DIAGNOSES = [
  {
    id: 'port-in-use',
    title: '端口被占用',
    match: (d) => d.failedPlugins.some((p) => p.errors.some((e) => /EADDRINUSE/.test(e))),
    explain: (d) => {
      const ports = new Set()
      for (const p of d.failedPlugins) {
        for (const e of p.errors) {
          const m = /address already in use ([\d.]+):(\d+)/.exec(e)
          if (m !== null) ports.add(`${m[1]}:${m[2]}`)
        }
      }
      const list = [...ports]
      return list.length === 0
        ? '启动时端口已被别的进程占着，webserver 无法监听。'
        : `启动时端口 ${list.join('、')} 已被别的进程占着，webserver 无法监听。`
    },
    fixes: (d) => {
      const ports = new Set()
      for (const p of d.failedPlugins) {
        for (const e of p.errors) {
          const m = /address already in use ([\d.]+):(\d+)/.exec(e)
          if (m !== null) ports.add(m[2])
        }
      }
      const fixes = []
      for (const port of ports) {
        fixes.push({
          kind: 'command',
          label: `查看占着 ${port} 端口的进程`,
          command: `ss -ltnp 'sport = :${port}'`,
          why: '先看清是谁占着，别直接杀。',
        })
      }
      fixes.push({
        kind: 'manual',
        label: '换端口或停掉占用方',
        why: '如果占用的是另一个 DSH 实例，关掉它；否则用 --port 换一个。',
      })
      return fixes
    },
  },
  {
    id: 'plugin-missing-module',
    title: '插件模块找不到',
    match: (d) => d.failedPlugins.some((p) => p.errors.some((e) => /ENOENT|Cannot find (?:module|package)/.test(e)))
      || d.failedPlugins.some((p) => p.errors.some((e) => /exports "\.\/\w+" but importing/.test(e))),
    explain: (d) => {
      const paths = new Set()
      for (const p of d.failedPlugins) {
        for (const e of p.errors) {
          // 从错误里捞出绝对路径（最常见的就是它）
          for (const m of e.matchAll(/\/[^\s'",]+/g)) {
            if (m[0].includes('node_modules') || m[0].endsWith('/client.js') || m[0].endsWith('/typert')) paths.add(m[0])
          }
        }
      }
      const sample = [...paths].slice(0, 3)
      return sample.length === 0
        ? '有插件要加载的模块在磁盘上不存在，通常是安装不完整或路径已失效。'
        : `有插件要加载的模块在磁盘上不存在。看不到的路径示例：${sample.map((p) => `\`${p}\``).join('、')}。`
    },
    fixes: (d) => {
      const pkgs = new Set()
      for (const p of d.failedPlugins) for (const pkg of p.packages) pkgs.add(pkg)
      const fixes = []
      if (pkgs.size > 0) {
        fixes.push({
          kind: 'command',
          label: '重装 profile 依赖',
          command: `cd ~/.dsh/profiles/${d.header.profile ?? 'web'} && pnpm install`,
          why: '多数「模块找不到」是安装不完整，重装能补回来。',
        })
      }
      fixes.push({
        kind: 'manual',
        label: '确认这些包真的存在',
        why: '如果重装后仍报同一路径，说明依赖声明指向了不存在的包，需要改 package.json。',
      })
      return fixes
    },
  },
  {
    id: 'profile-version-mismatch',
    title: '插件与运行时版本不匹配',
    match: (d) => d.failedPlugins.some((p) => p.errors.some((e) => /incompatible with dsh|is incompatible with/.test(e))),
    explain: (d) => '有插件的版本要求与当前 DSH 运行时不符，被拒加载。',
    fixes: (d) => [
      {
        kind: 'command',
        label: '看哪些插件被版本检查拦下',
        command: 'dsh plugin list --profile ' + (d.header.profile ?? 'web'),
        why: '先拿到准确清单，再决定升降级。',
      },
      {
        kind: 'manual',
        label: '按提示升降级插件',
        why: '优先找与运行时同版本的插件；确有必要才用 allow-version 豁免（有崩溃风险）。',
      },
    ],
  },
  {
    id: 'plugin-not-activate',
    title: '必装插件未激活',
    match: (d) => d.startupError !== null && d.failedPlugins.length === 0,
    explain: (d) => `有 ${d.startupError.count} 个必装插件没能激活，但日志里没有更多细节。`,
    fixes: () => [
      {
        kind: 'manual',
        label: '开详细日志重跑',
        why: '这份日志没记下失败原因，用 --debug 或看终端输出能拿到更多。',
      },
    ],
  },
]

/**
 * 诊断一份日志。
 *
 * @param text 日志原文。
 * @returns 结构化诊断结果；认不出故障时 `issues` 为空，但仍返回解析出的头信息。
 */
export function diagnose(text) {
  const raw = String(text ?? '')
  const header = parseHeader(raw)
  const startupError = parseStartupError(raw)
  const failedPlugins = parseFailedPlugins(raw)
  const runtime = parseRuntimeMessages(raw)

  const parsed = { header, startupError, failedPlugins, runtime }
  const issues = []
  for (const rule of DIAGNOSES) {
    let hit = false
    try { hit = rule.match(parsed) === true } catch { hit = false }
    if (!hit) continue
    issues.push({
      id: rule.id,
      title: rule.title,
      explain: rule.explain(parsed),
      fixes: rule.fixes(parsed),
      // 修复方案里只要有一条是命令，就说明这个故障「有可执行动作」。
      repairable: rule.fixes(parsed).some((f) => f.kind === 'command'),
    })
  }

  return {
    header,
    startupError,
    failedPlugins,
    runtime,
    issues,
    // 顶层判定：有没有真实故障（不是告警）。
    broken: startupError !== null || failedPlugins.length > 0,
    errorCount: runtime.filter((m) => m.type === 'error').length,
    warnCount: runtime.filter((m) => m.type === 'warn').length,
  }
}

/**
 * 读一份日志的完整诊断。
 *
 * @param dir 日志目录。
 * @param name 日志文件名。
 * @param options `maxBytes` 限制读取量：这些文件能到几十 MB，全读会卡。
 */
export async function readLogFile(dir, name, options = {}) {
  const maxBytes = options.maxBytes ?? 1024 * 1024
  const path = join(dir, name)
  const info = await stat(path)
  const handle = await readFile(path)
  const truncated = handle.length > maxBytes
  const text = handle.subarray(0, maxBytes).toString('utf8')
  const result = diagnose(text)
  return {
    ...result,
    name,
    path,
    bytes: info.size,
    truncated,
    // 凭据遮蔽后再出门：这些日志明确可能含配置与密钥。
    preview: redactSecrets(text.slice(0, 4000)),
  }
}

/** 列出日志文件（新的在前），带大小与解析出的时间。 */
export async function listLogFiles(dir, options = {}) {
  const limit = options.limit ?? 50
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { dir, exists: false, files: [], total: 0 }
    throw error
  }
  const parsed = names.map(parseLogName).filter((x) => x !== null)
  parsed.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const files = []
  for (const item of parsed.slice(0, limit)) {
    let bytes = 0
    try { bytes = (await stat(join(dir, item.name))).size } catch { bytes = 0 }
    files.push({ ...item, bytes })
  }
  return { dir, exists: true, files, total: parsed.length }
}
