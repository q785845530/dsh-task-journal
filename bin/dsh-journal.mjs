#!/usr/bin/env node
/**
 * dsh-journal — 命令行入口。
 *
 * 直接对任务日志做导出/查看/重试，不必进入会话：
 *
 *   dsh-journal export [--dir <目录>] [--format md|all] [--cwd <工作目录>] [--session <id>]
 *   dsh-journal list   [--cwd <工作目录>] [--session <id>]
 *   dsh-journal show   [--cwd <工作目录>] [--session <id>] [--file failures|tasks|models|journal|subagents]
 *   dsh-journal failures [--cwd <工作目录>]
 *   dsh-journal agents [--cwd <工作目录>] [--category <分类>] [--archive] [--sources]
 *   dsh-journal retry  [--session <id>] [--note <补充>]
 *
 * 默认在 <cwd>/.dsh-journal/ 下找当前（或指定）会话的日志。
 * 找不到指定会话时，自动选取该目录下最近更新的一个会话。
 *
 * 每个写盘命令结束时打印一行醒目提示（含文件路径与条数），便于确认结果。
 * 输出里的本机 HOME 前缀默认遮蔽成 `~`（--no-redact 关闭）。
 */
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  builtinEntries, groupByCategory, normalizeCategory, categoryIds,
  writeCatalog, archiveSources, subagentDir, redactHome, redactSecrets,
} from '../lib/subagent-catalog.js'
import { statusLabel } from '../lib/updates.js'

const USAGE = `dsh-journal — 任务日志命令行

用法：
  dsh-journal export   [--dir <目录>] [--format md|all]  导出结果（默认 .dsh-journal/export）
  dsh-journal list     [--cwd <目录>]                     列出可用会话日志
  dsh-journal show     [--file journal|tasks|failures|models|subagents]  查看某份日志
  dsh-journal failures [--cwd <目录>]                     只看未完成的任务
  dsh-journal agents   [--category <分类>]                列出子智能体目录
  dsh-journal agents   --archive [--sources]              归档目录（可选含源码）
  dsh-journal retry    [--note <补充>]                    打印重试指引（不唤醒会话）
  dsh-journal repair   [--session <id>] [--apply]         体检并修复会话归档（默认试运行）
  dsh-journal updates  [--apply <包名>] [--url <地址>]     查看/升级已安装插件（走运行中的 DSH）

通用参数：
  --cwd <目录>      工作目录（默认当前目录）
  --session <id>    指定会话（默认取最近更新的那个）
  --category <分类> 只看某一分类（${categoryIds().join(' | ')}）
  --no-redact       输出完整路径（默认把本机 HOME 前缀遮蔽成 ~）
  --apply           repair 时真正落盘（默认只试运行，不写文件）
  -h, --help        显示帮助

说明：日志由 DSH 插件 dsh-task-journal 在会话过程中自动写入。
命令行负责导出与查看；要真正唤醒会话继续未完成的任务，请在会话里发「继续」，
或让模型调用 journal_retry 工具（命令行无法注入会话）。

repair 修复的是 DSH 的会话归档（<会话根>/<项目>/<id>/session.v4.jsonl.zstd），
不是本插件的任务日志。历史加载报 "lacks an identified message" 时用它。
只补消息缺失的 role/id，不改内容；落盘前自动备份，默认试运行。

updates 读的是**运行中的 DSH**：插件管理服务只活在宿主进程里，命令行起不来它。
所以要先用 dsh web 把界面跑起来，再用 --url 指向它（默认 http://127.0.0.1:3080）。
--apply <包名> 会真的升级：先移除旧版，再装市场索引给出的版本。`

/** HOME 遮蔽：默认开启。 */
const hideHome = (p, args) => (args !== undefined && args['no-redact'] === true
  ? String(p ?? '')
  : redactHome(p, homedir()))

/** 极简参数解析：--key value 与 --flag。 */
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1 }
      else out[key] = true
    } else if (a === '-h') out.help = true
    else out._.push(a)
  }
  return out
}

/** 彩色输出（非 TTY 时自动降级为纯文本）。 */
const tty = process.stdout.isTTY === true
const paint = (code, s) => (tty ? `\u001b[${code}m${s}\u001b[0m` : s)
const bold = (s) => paint('1', s)
const green = (s) => paint('32', s)
const yellow = (s) => paint('33', s)
const red = (s) => paint('31', s)
const dim = (s) => paint('2', s)

/** 成功提示：每个写盘/导出命令的最后一行。 */
function done(message) {
  const line = `✅ ${message}`
  console.log('')
  console.log(tty ? green(line) : line)
}

/** 失败提示。 */
function fail(message) {
  console.error(tty ? red(`❌ ${message}`) : `❌ ${message}`)
}

/** 取 base 目录下的会话前缀文件，按修改时间倒序返回 { sid, files }。 */
async function sessionsIn(base) {
  if (!existsSync(base)) return []
  const names = await readdir(base)
  const map = new Map()
  for (const n of names) {
    const m = /^(journal|events|tasks|failures|models)-(.+?)\.(md|jsonl)$/.exec(n)
    if (!m) continue
    const sid = m[2]
    if (!map.has(sid)) map.set(sid, { sid, files: {}, mtime: 0 })
    const entry = map.get(sid)
    entry.files[m[1]] = join(base, n)
    try {
      const st = await stat(join(base, n))
      if (st.mtimeMs > entry.mtime) entry.mtime = st.mtimeMs
    } catch { /* 忽略 */ }
  }
  return [...map.values()].sort((a, b) => b.mtime - a.mtime)
}

/** 解析目标：base 目录 + 指定或最近会话。 */
async function resolveTarget(args) {
  const cwd = args.cwd ? resolve(String(args.cwd)) : process.cwd()
  const base = join(cwd, '.dsh-journal')
  const sessions = await sessionsIn(base)
  if (sessions.length === 0) {
    fail(`没有找到日志目录：${hideHome(base, args)}`)
    console.log(dim('  （该目录下还没有会话日志；先在 DSH 里跑一次会话，插件会自动生成）'))
    return null
  }
  let target
  if (typeof args.session === 'string' && args.session !== '') {
    target = sessions.find((s) => s.sid === args.session)
    if (target === undefined) {
      fail(`没有找到会话 ${args.session}`)
      console.log(`  可用的会话：`)
      for (const s of sessions) console.log(`    - ${s.sid}`)
      return null
    }
  } else {
    target = sessions[0]
  }
  return { cwd, base, sessions, target }
}

/** 判断某行是否是「未完成」的任务行。 */
const isOpenTask = (l) => /^- \[ \]/.test(l)

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] ?? (args.help ? 'help' : '')

  if (cmd === '' || cmd === 'help' || args.help === true) {
    console.log(USAGE)
    return 0
  }

  switch (cmd) {
    case 'list': {
      const cwd = args.cwd ? resolve(String(args.cwd)) : process.cwd()
      const base = join(cwd, '.dsh-journal')
      const sessions = await sessionsIn(base)
      console.log(bold(`日志目录：${hideHome(base, args)}`))
      if (sessions.length === 0) {
        console.log(dim('  （空）'))
        console.log('')
        console.log(yellow('提示：在 DSH 里跑一次会话即可自动生成日志。'))
        return 0
      }
      console.log(`共 ${sessions.length} 个会话：`)
      for (const s of sessions) {
        const when = new Date(s.mtime).toLocaleString('zh-CN')
        const kinds = Object.keys(s.files).sort().join(',')
        console.log(`  - ${bold(s.sid)}  ${dim(when)}  ${dim(`[${kinds}]`)}`)
      }
      done(`列出 ${sessions.length} 个会话（目录：${hideHome(base, args)}）`)
      return 0
    }

    case 'show': {
      const r = await resolveTarget(args)
      if (r === null) return 1
      const which = typeof args.file === 'string' ? args.file : 'journal'
      const p = r.target.files[which]
      if (p === undefined || !existsSync(p)) {
        fail(`该会话没有 ${which} 文件`)
        console.log(`  可用：${Object.keys(r.target.files).join(', ')}`)
        return 1
      }
      const text = await readFile(p, 'utf8')
      console.log(bold(`会话 ${r.target.sid}｜${which}`))
      console.log(dim(`文件：${hideHome(p, args)}`))
      console.log('---')
      console.log(text)
      done(`已显示 ${which}（${text.split('\n').length} 行，${hideHome(p, args)}）`)
      return 0
    }

    case 'failures': {
      const r = await resolveTarget(args)
      if (r === null) return 1
      const p = r.target.files.failures
      if (p === undefined || !existsSync(p)) {
        console.log(yellow('这个会话还没有记录到未完成的任务。'))
        done('无未完成任务（0 条）')
        return 0
      }
      const text = await readFile(p, 'utf8')
      const blocks = text.split('\n').filter((l) => l.startsWith('## F')).length
      console.log(bold(`未完成的任务：${blocks} 条`))
      console.log(dim(`文件：${hideHome(p, args)}`))
      console.log(text)
      const hint = blocks > 0
        ? `发现 ${blocks} 条未完成的任务（${hideHome(p, args)}）。要接着做，请在 DSH 会话里发一句「继续」，或让模型调用 journal_retry。`
        : '无未完成任务。'
      done(hint)
      return 0
    }

    case 'export': {
      const r = await resolveTarget(args)
      if (r === null) return 1
      const outDir = typeof args.dir === 'string' && args.dir !== ''
        ? (isAbsolute(args.dir) ? args.dir : resolve(r.cwd, args.dir))
        : join(r.base, 'export')
      await mkdir(outDir, { recursive: true })

      const format = args.format === 'all' ? 'all' : 'md'
      const sid = r.target.sid
      const day = new Date().toISOString().slice(0, 10)
      const files = []

      const order = ['journal', 'tasks', 'failures', 'models']
      const parts = []
      // 读侧也过遮蔽：老日志可能还带着修复前写下的凭据，导出别把它再打包一份。
      const readClean = async (p) => redactSecrets(await readFile(p, 'utf8'))
      for (const k of order) {
        const p = r.target.files[k]
        if (p === undefined || !existsSync(p)) continue
        parts.push(`\n\n<!-- ===== ${k} ===== -->\n\n`, await readClean(p))
      }
      const ev = r.target.files.events
      if (ev !== undefined && existsSync(ev)) {
        parts.push(`\n\n<!-- ===== events(jsonl) ===== -->\n\n`, '```jsonl\n', await readClean(ev), '\n```\n')
      }
      const summaryPath = join(outDir, `export-${sid}-${day}.md`)
      await writeFile(summaryPath, parts.join(''), 'utf8')
      files.push(summaryPath)

      if (format === 'all') {
        for (const k of [...order, 'events']) {
          const p = r.target.files[k]
          if (p === undefined || !existsSync(p)) continue
          const ext = p.endsWith('.jsonl') ? '.jsonl' : '.md'
          const t = join(outDir, `${k}-${sid}-${day}${ext}`)
          await writeFile(t, await readClean(p), 'utf8')
          files.push(t)
        }
      }

      console.log(bold(`导出会话 ${sid}`))
      console.log(dim(`源目录：${hideHome(r.base, args)}`))
      for (const f of files) console.log(`  - ${f}`)
      done(`导出完成：${files.length} 个文件 → ${hideHome(outDir, args)}`)
      return 0
    }

    case 'agents': {
      const cwd = args.cwd ? resolve(String(args.cwd)) : process.cwd()
      const base = join(cwd, '.dsh-journal')
      const all = builtinEntries()

      if (args.archive === true) {
        const r = await writeCatalog(base, all, { home: homedir() })
        console.log(bold(`已归档 ${r.count} 个子智能体`))
        console.log(dim(`目录：${hideHome(r.dir, args)}`))
        for (const f of r.files.slice(0, 12)) console.log(`  - ${hideHome(f, args)}`)
        if (r.files.length > 12) console.log(dim(`  …另有 ${r.files.length - 12} 个文件`))
        let extra = ''
        if (args.sources === true) {
          const s = await archiveSources(base, all, { home: homedir() })
          extra = `｜源码 ${s.ok}/${s.total}`
          console.log(bold(`源码归档：${s.ok}/${s.total} 个条目`))
          console.log(dim(`目录：${hideHome(s.dir, args)}`))
          for (const x of s.results) {
            if (x.ok) console.log(`  - ${x.id}：${x.files} 个文件（${x.from}）`)
            else console.log(`  - ${x.id}：未归档 — ${x.reason}`)
          }
        }
        done(`归档完成：目录 ${r.count} 条 / ${r.files.length} 个文件${extra} → ${hideHome(subagentDir(base), args)}`)
        return 0
      }

      const want = typeof args.category === 'string' && args.category !== ''
        ? normalizeCategory(args.category) : null
      const filtered = want === null ? all : all.filter((e) => e.category === want)
      console.log(bold(`子智能体目录：${filtered.length} 个`))
      console.log(dim(`归档位置：${hideHome(subagentDir(base), args)}（尚未归档时不存在）`))
      for (const g of groupByCategory(filtered)) {
        console.log('')
        console.log(bold(`【${g.label}】`) + dim(` ${g.desc}`))
        for (const e of g.entries) {
          console.log(`  - ${bold(e.name)} ${dim(`(${e.id})`)}`)
          console.log(`      ${e.summary}`)
          console.log(dim(`      工具/后端：${e.tool ?? '—'} / ${e.provider ?? '—'}　包：${e.package ?? '—'}`))
        }
      }
      done(`列出 ${filtered.length} 个子智能体（${groupByCategory(filtered).length} 个分类）；用 --archive 持久化，--archive --sources 连源码一起`)
      return 0
    }

    case 'retry': {
      const r = await resolveTarget(args)
      if (r === null) return 1
      const p = r.target.files.failures
      let open = 0
      if (p !== undefined && existsSync(p)) {
        open = (await readFile(p, 'utf8')).split('\n').filter((l) => l.startsWith('## F')).length
      }
      console.log(bold(`会话 ${r.target.sid}｜未完成 ${open} 条`))
      if (open === 0) {
        done('没有未完成的任务，无需重试。')
        return 0
      }
      const note = typeof args.note === 'string' && args.note !== '' ? `（补充：${args.note}）` : ''
      console.log('')
      console.log('命令行无法直接唤醒一个会话；请选一种：')
      console.log(`  1) 在对应的 DSH 会话里发一句：${bold('继续')}${note}`)
      console.log(`  2) 让模型在该会话里调用工具：${bold('journal_retry')}${note}`)
      console.log(`  3) 用导出的 failures 文件核对原因：${dim(hideHome(r.target.files.failures ?? '(无)', args))}`)
      done(`已给出重试指引（未完成 ${open} 条）`)
      return 0
    }

    case 'repair': {
      // 会话修复：无需进入会话，直接对会话归档体检/修复。
      // 这是「修得快」的兜底路径——界面起不来时，命令行还能修。
      const root = process.env.DSH_SESSIONS_DIR
        ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
      const apply = args.apply === true
      const only = typeof args.session === 'string' && args.session !== '' ? args.session : null

      console.log(bold(`会话归档根：${hideHome(root, args)}`))
      if (!existsSync(root)) {
        fail(`找不到会话目录：${hideHome(root, args)}`)
        return 1
      }

      const { scanRoot, repairFile } = await import('../lib/session-repair.js')
      const { results } = await scanRoot(root)
      const broken = results.filter((r) => !r.ok)

      console.log(`扫描 ${results.length} 个会话，破损 ${broken.length} 个。`)
      if (only !== null) {
        const hit = broken.find((r) => r.session === only)
        if (hit === undefined) {
          const healthy = results.find((r) => r.session === only)
          console.log(healthy === undefined
            ? yellow(`没有找到会话 ${only}`)
            : `${green('该会话完好，无需修复')}：${only}`)
          return healthy === undefined ? 1 : 0
        }
        const one = await repairFile(hit.file, { apply, sessionId: hit.session })
        printRepairOne(one, args)
        return one.applied || (!apply && one.plan.ok) ? 0 : 1
      }

      if (broken.length === 0) {
        done('全部会话归档完好，无需修复')
        return 0
      }

      let fixed = 0
      let skipped = 0
      for (const r of broken) {
        if (!r.repairable) {
          skipped += 1
          console.log(`\n${yellow('跳过（需人工）')} ${bold(r.session)}`)
          for (const i of r.issues.slice(0, 3)) console.log(`  seq ${i.seq ?? '-'}｜${i.reason}`)
          continue
        }
        const one = await repairFile(r.file, { apply, sessionId: r.session })
        printRepairOne(one, args)
        if (one.applied) fixed += 1
      }
      console.log('')
      if (apply) done(`已修复 ${fixed} 个，跳过 ${skipped} 个（需人工）`)
      else {
        console.log(yellow('以上为试运行，未落盘。加 --apply 才真正修复。'))
        done(`可自动修复 ${broken.length - skipped} 个，需人工 ${skipped} 个`)
      }
      return 0
    }

    case 'updates': {
      // 插件管理服务只活在宿主进程里，命令行自己拿不到 ——
      // 所以走运行中的 DSH 的 HTTP 接口，而不是本地重算。
      const base = typeof args.url === 'string' && args.url !== ''
        ? String(args.url).replace(/\/+$/, '')
        : (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
      const endpoint = `${base}/api/dsh-journal/updates`
      const wanted = typeof args.apply === 'string' && args.apply !== '' ? args.apply : null

      const reach = async (url, init) => {
        try {
          const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) })
          const text = await res.text()
          let body = null
          try { body = JSON.parse(text) } catch { /* 非 JSON 就只报状态码 */ }
          return { ok: true, status: res.status, body, text }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }

      if (wanted === null) {
        const r = await reach(endpoint)
        if (!r.ok) {
          fail(`连不上运行中的 DSH：${base}（${r.error}）`)
          console.log(dim('  插件管理服务只在宿主进程里。先启动 `dsh web`，再用 --url 指定地址。'))
          return 1
        }
        if (r.body === null) {
          fail(`接口返回了非 JSON（HTTP ${r.status}）`)
          console.log(dim(`  ${r.text.slice(0, 200)}`))
          return 1
        }
        if (r.body.ok !== true) {
          fail(`插件更新不可用：${r.body.reason ?? '未知原因'}`)
          return 1
        }
        const c = r.body.counts ?? {}
        console.log(bold(`已安装 ${c.installed ?? 0} 个插件，可更新 ${c.updatable ?? 0} 个（可一键升级 ${c.appliable ?? 0} 个）`))
        // 版本来源要讲清楚：市场是权威的，registry 是退路。
        if (r.body.source === 'market') console.log(dim('版本来源：插件市场'))
        else {
          console.log(dim(`版本来源：npm registry（${r.body.registry ?? '默认地址'}）`))
          if (r.body.market !== true) console.log(dim(`  插件市场未装配：${r.body.marketReason ?? ''}`))
        }
        for (const p of (r.body.plugins ?? [])) {
          const arrow = p.updatable ? ` → ${p.market.latestVersion}` : ''
          const tag = p.updatable ? yellow('可更新') : p.market.status === 'installed' ? green('已最新') : dim(statusLabel(p.market.status))
          const lock = p.removable ? '' : dim('（不可移除）')
          const blk = p.blocked ? dim(`  ⚠ ${p.blocked}`) : ''
          console.log(`  ${p.updatable ? '↑' : ' '} ${bold(p.name)}  ${p.version ?? '未知'}${arrow}  ${tag}${lock}${blk}`)
        }
        if ((c.appliable ?? 0) > 0) {
          console.log('')
          console.log(dim('升级：dsh-journal updates --apply <包名>（会先移除旧版，再装新版）'))
        }
        return 0
      }

      const r = await reach(`${endpoint}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: wanted, confirm: true }),
      })
      if (!r.ok) {
        fail(`连不上运行中的 DSH：${base}（${r.error}）`)
        return 1
      }
      if (r.body === null) {
        fail(`接口返回了非 JSON（HTTP ${r.status}）`)
        return 1
      }
      for (const s of (r.body.steps ?? [])) {
        const how = s.result?.application ?? '?'
        const why = s.result?.error?.code ? `（${s.result.error.code}）` : ''
        console.log(dim(`  ${s.step}：${how}${why}`))
      }
      if (r.body.ok !== true) {
        fail(`升级 ${wanted} 未完成：${r.body.reason ?? '未知原因'}`)
        return 1
      }
      const note = r.body.application === 'restart-required' ? '（需要重启 DSH 才生效）' : ''
      done(`已把 ${r.body.name} 从 ${r.body.from ?? '未知'} 升到 ${r.body.to ?? '未知'}${note}`)
      return 0
    }

    default: {
      fail(`未知命令：${cmd}`)
      console.log('')
      console.log(USAGE)
      return 1
    }
  }
}

/** 打印单个会话的修复结果（CLI）。 */
function printRepairOne(one, args) {
  const mark = one.applied ? green('已修复') : one.projected ? yellow('试运行') : yellow('未改动')
  console.log(`\n${mark} ${bold(one.sessionId)}`)
  console.log(`  修复前：${one.before.issues.length} 处（可自动 ${one.before.autoCount}，需人工 ${one.before.manualCount}）`)
  console.log(`  改动：${one.plan.report.length} 处`)
  if (one.plan.report.length > 0) {
    for (const e of one.plan.report.slice(0, 10)) {
      console.log(`    seq ${e.seq}｜${e.type}｜来源 ${e.producer}｜补 id=${e.added?.id ?? '-'}`)
    }
  }
  if (one.after !== null) console.log(`  修复后：${one.after.ok ? green('校验通过') : red(`仍有 ${one.after.issues.length} 处`)}`)
  if (one.backup !== null) console.log(`  备份：${hideHome(one.backup, args)}`)
  if (one.plan.reason !== null) console.log(`  ${red(one.plan.reason)}`)
  for (const i of one.plan.remaining.slice(0, 5)) console.log(`    ${red(`seq ${i.seq ?? '-'}｜${i.reason}`)}`)
}

main()
  .then((code) => { process.exitCode = code })
  .catch((e) => {
    fail(e?.message ?? String(e))
    process.exitCode = 1
  })
