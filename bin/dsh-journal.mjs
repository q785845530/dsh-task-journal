#!/usr/bin/env node
/**
 * dsh-journal — 命令行入口。
 *
 * 直接对任务日志做导出/查看/重试，不必进入会话：
 *
 *   dsh-journal export [--dir <目录>] [--format md|all] [--cwd <工作目录>] [--session <id>]
 *   dsh-journal list   [--cwd <工作目录>] [--session <id>]
 *   dsh-journal show   [--cwd <工作目录>] [--session <id>] [--file failures|tasks|models|journal]
 *   dsh-journal failures [--cwd <工作目录>]
 *   dsh-journal retry  [--session <id>] [--note <补充>]
 *
 * 默认在 <cwd>/.dsh-journal/ 下找当前（或指定）会话的日志。
 * 找不到指定会话时，自动选取该目录下最近更新的一个会话。
 *
 * 每个写盘命令结束时打印一行醒目提示（含文件路径与条数），便于确认结果。
 */
import { readFile, readdir, stat, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const USAGE = `dsh-journal — 任务日志命令行

用法：
  dsh-journal export   [--dir <目录>] [--format md|all]  导出结果（默认 .dsh-journal/export）
  dsh-journal list     [--cwd <目录>]                     列出可用会话日志
  dsh-journal show     [--file journal|tasks|failures|models]  查看某份日志
  dsh-journal failures [--cwd <目录>]                     只看未完成的任务
  dsh-journal retry    [--note <补充>]                    打印重试指引（不唤醒会话）

通用参数：
  --cwd <目录>      工作目录（默认当前目录）
  --session <id>    指定会话（默认取最近更新的那个）
  -h, --help        显示帮助

说明：日志由 DSH 插件 dsh-task-journal 在会话过程中自动写入。
命令行负责导出与查看；要真正唤醒会话继续未完成的任务，请在会话里发「继续」，
或让模型调用 journal_retry 工具（命令行无法注入会话）。`

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
    fail(`没有找到日志目录：${base}`)
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
      console.log(bold(`日志目录：${base}`))
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
      done(`列出 ${sessions.length} 个会话（目录：${base}）`)
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
      console.log(dim(`文件：${p}`))
      console.log('---')
      console.log(text)
      done(`已显示 ${which}（${text.split('\n').length} 行，${p}）`)
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
      console.log(dim(`文件：${p}`))
      console.log(text)
      const hint = blocks > 0
        ? `发现 ${blocks} 条未完成的任务（${p}）。要接着做，请在 DSH 会话里发一句「继续」，或让模型调用 journal_retry。`
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
      for (const k of order) {
        const p = r.target.files[k]
        if (p === undefined || !existsSync(p)) continue
        parts.push(`\n\n<!-- ===== ${k} ===== -->\n\n`, await readFile(p, 'utf8'))
      }
      const ev = r.target.files.events
      if (ev !== undefined && existsSync(ev)) {
        parts.push(`\n\n<!-- ===== events(jsonl) ===== -->\n\n`, '```jsonl\n', await readFile(ev, 'utf8'), '\n```\n')
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
          await copyFile(p, t)
          files.push(t)
        }
      }

      console.log(bold(`导出会话 ${sid}`))
      console.log(dim(`源目录：${r.base}`))
      for (const f of files) console.log(`  - ${f}`)
      done(`导出完成：${files.length} 个文件 → ${outDir}`)
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
      console.log(`  3) 用导出的 failures 文件核对原因：${dim(r.target.files.failures ?? '(无)')}`)
      done(`已给出重试指引（未完成 ${open} 条）`)
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

main()
  .then((code) => { process.exitCode = code })
  .catch((e) => {
    fail(e?.message ?? String(e))
    process.exitCode = 1
  })
