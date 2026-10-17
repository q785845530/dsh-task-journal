#!/usr/bin/env node
/**
 * dsh-journal CLI 自测。
 *
 *   node verify-cli.mjs
 *
 * 造一份假的 .dsh-journal/ 数据，逐个跑子命令，断言输出与退出码。
 */
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, 'bin', 'dsh-journal.mjs')

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}`) }
}

/** 跑一条 CLI 命令。 */
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
}

const main = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-journal-cli-'))
  const base = join(root, '.dsh-journal')
  await mkdir(base, { recursive: true })
  const sid = 'cli-test-42'

  await writeFile(join(base, `journal-${sid}.md`),
    `# 任务日志\n\n- 会话：\`${sid}\`\n\n---\n## 任务 1｜2026-01-01 00:00:00\n\n写一个插件\n`, 'utf8')
  await writeFile(join(base, `tasks-${sid}.md`),
    `# 任务清单\n\n- 会话：\`${sid}\`\n\n---\n- [x] [\`T1\`] 2026-01-01 00:00:00｜写一个插件\n- [ ] [\`T2\`] 2026-01-01 00:01:00｜把 0500 写完\n`, 'utf8')
  await writeFile(join(base, `failures-${sid}.md`),
    `# 未完成的任务与问题\n\n- 会话：\`${sid}\`\n\n---\n\n## F1｜任务 T2｜2026-01-01 00:02:00\n\n- 任务：把 0500 写完\n- 原因：限流 [QUOTA_EXCEEDED]\n- 状态：未完成\n`, 'utf8')
  await writeFile(join(base, `models-${sid}.md`),
    `# 模型与参数记录\n\n- 会话：\`${sid}\`\n\n---\n- 2026-01-01 00:00:00｜provider=p model=m reasoning=high maxTokens=128000\n`, 'utf8')
  await writeFile(join(base, `events-${sid}.jsonl`),
    `{"type":"task","n":1}\n{"type":"model"}\n`, 'utf8')

  console.log(`临时目录：${root}\n`)

  // —— help ——
  console.log('用例 1：--help')
  const h = run(['--help'])
  ok(h.code === 0, '退出码 0')
  ok(h.out.includes('dsh-journal'), '打印用法标题')
  ok(h.out.includes('export'), '列出 export 子命令')

  // —— list ——
  console.log('\n用例 2：list')
  const l = run(['list', '--cwd', root])
  ok(l.code === 0, '退出码 0')
  ok(l.out.includes(sid), '列出会话 id')
  ok(l.out.includes('✅'), '有完成提示')

  // —— show ——
  console.log('\n用例 3：show')
  const s = run(['show', '--cwd', root, '--file', 'models'])
  ok(s.code === 0, '退出码 0')
  ok(s.out.includes('deepseek') || s.out.includes('provider=p'), '显示模型记录')
  ok(s.out.includes('✅'), '有完成提示')

  // —— failures ——
  console.log('\n用例 4：failures')
  const f = run(['failures', '--cwd', root])
  ok(f.code === 0, '退出码 0')
  ok(f.out.includes('QUOTA_EXCEEDED'), '显示失败原因')
  ok(f.out.includes('1 条'), '统计未完成条数')
  ok(f.out.includes('✅'), '有完成提示')

  // —— export（md）——
  console.log('\n用例 5：export --format md')
  const e1 = run(['export', '--cwd', root])
  ok(e1.code === 0, '退出码 0')
  ok(e1.out.includes('导出完成'), '有完成提示')
  const expDir = join(base, 'export')
  ok(existsSync(expDir), '默认导出目录已创建')
  const expFiles = existsSync(expDir) ? await readdir(expDir) : []
  ok(expFiles.filter((x) => x.endsWith('.md')).length === 1, 'md 模式只导 1 个汇总文件')

  // —— export（all）——
  console.log('\n用例 6：export --format all')
  const e2 = run(['export', '--cwd', root, '--format', 'all', '--dir', join(root, 'out2')])
  ok(e2.code === 0, '退出码 0')
  const out2 = join(root, 'out2')
  const f2 = existsSync(out2) ? await readdir(out2) : []
  ok(f2.some((x) => x.endsWith('.jsonl')), 'all 模式导出 jsonl')
  ok(f2.some((x) => x.includes('failures')), 'all 模式导出 failures')
  ok(e2.out.includes('导出完成'), '有完成提示')

  // —— 导出的读侧脱敏 ——
  // 真实事故回归：老日志里写着明文凭据，导出会把它原样再打包一份新的。
  console.log('\n用例 6.5：导出时遮蔽历史凭据')
  const leaked = 'ghp' + '_' + 'e'.repeat(36)
  await writeFile(join(base, 'journal-dirty-1.md'),
    `# 任务日志\n\n- 会话：\`dirty-1\`\n\n---\n## 任务 1｜2026-01-01 00:00:00\n\n我的 token 是 ${leaked} ，帮我配\n`, 'utf8')
  const e3 = run(['export', '--cwd', root, '--session', 'dirty-1', '--format', 'all',
    '--dir', join(root, 'out3')])
  ok(e3.code === 0, '导出脏会话退出码 0')
  const out3 = join(root, 'out3')
  const f3 = existsSync(out3) ? await readdir(out3) : []
  const summary3 = f3.find((x) => x.startsWith('export-') && x.endsWith('.md')) ?? ''
  const sumBody = summary3 !== '' ? await readFile(join(out3, summary3), 'utf8') : ''
  ok(!sumBody.includes(leaked), '汇总文件里没有明文凭据')
  ok(sumBody.includes('<redacted:github-pat>'), '汇总文件里留下遮蔽标记')
  ok(sumBody.includes('帮我配'), '汇总文件保留了其余原文')
  const copy3 = f3.find((x) => x.startsWith('journal-') && x.endsWith('.md')) ?? ''
  const copyBody = copy3 !== '' ? await readFile(join(out3, copy3), 'utf8') : ''
  ok(copy3 !== '', 'all 模式导出了单文件副本')
  ok(!copyBody.includes(leaked), '单文件副本里也没有明文凭据')

  // —— retry ——
  console.log('\n用例 7：retry')
  // 显式指定会话：不指定时按最新日志取，会被后面新增的样本抢走。
  const r = run(['retry', '--cwd', root, '--session', sid])
  ok(r.code === 0, '退出码 0')
  ok(r.out.includes('journal_retry'), '给出工具重试指引')
  ok(r.out.includes('继续'), '给出「继续」指引')
  ok(r.out.includes('✅'), '有完成提示')

  // —— agents（目录浏览 + 归档）——
  console.log('\n用例 8：agents 目录')
  const ag = run(['agents', '--cwd', root])
  ok(ag.code === 0, '退出码 0')
  ok(ag.out.includes('子智能体目录'), '打印目录标题')
  ok(ag.out.includes('【'), '按分类分组输出')
  const agCat = run(['agents', '--cwd', root, '--category', 'backend'])
  ok(agCat.code === 0, '带分类参数退出码 0')
  ok(agCat.out.includes('后端'), '只输出该分类')

  console.log('\n用例 9：agents --archive')
  const arch = run(['agents', '--cwd', root, '--archive'])
  ok(arch.code === 0, '归档退出码 0')
  ok(arch.out.includes('归档完成'), '有完成提示')
  const subBase = join(base, 'subagents')
  ok(existsSync(join(subBase, 'catalog.json')), '写出 catalog.json')
  ok(existsSync(join(subBase, 'catalog.md')), '写出 catalog.md')
  const ent = existsSync(join(subBase, 'entries')) ? await readdir(join(subBase, 'entries')) : []
  ok(ent.some((x) => x.endsWith('.md')), '写出条目 Markdown')
  const pre = existsSync(join(subBase, 'presets')) ? await readdir(join(subBase, 'presets')) : []
  ok(pre.length > 0, '写出预设目录')

  console.log('\n用例 10：agents --archive --sources')
  const src = run(['agents', '--cwd', root, '--archive', '--sources'])
  ok(src.code === 0, '源码归档退出码 0')
  ok(src.out.includes('源码归档'), '报告源码归档结果')
  ok(existsSync(join(subBase, 'src', 'SOURCE.md')), '写出 SOURCE.md')

  console.log('\n用例 11：HOME 遮蔽')
  const masked = run(['list', '--cwd', root])
  const home = process.env.HOME
  ok(home === undefined || !masked.out.includes(home), 'list 输出不含本机 HOME')
  const raw = run(['list', '--cwd', root, '--no-redact'])
  ok(raw.code === 0, '--no-redact 可用')
  ok(raw.out.includes(root), '--no-redact 时输出完整路径')

  // —— repair 子命令 ——
  console.log('\n用例 12：repair 体检与修复会话归档')
  {
    const { zstdCompressSync, constants } = await import('node:zlib')
    const opts = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
    const frame = (t) => zstdCompressSync(Buffer.from(t), opts)
    const sessRoot = await mkdtemp(join(tmpdir(), 'dsh-journal-cli-repair-'))
    const proj = '--proj--'
    const sid = 'session-cli-repair-1'
    await mkdir(join(sessRoot, proj, sid), { recursive: true })
    const header = `${JSON.stringify({ type: 'session', version: 4, id: sid, createdAt: 1, cwd: '/tmp' })}\n`
    const good = { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, role: 'user', id: 'g0' } }
    const badEv = { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'notice' }], source: { kind: 'dsh-task-journal', form: 'notice', summary: 'n' } } }
    const file = join(sessRoot, proj, sid, 'session.v4.jsonl.zstd')
    await writeFile(file, Buffer.concat([
      frame(header), frame(`${JSON.stringify(good)}\n`), frame(`${JSON.stringify(badEv)}\n`),
    ]))

    const env = { ...process.env, DSH_SESSIONS_DIR: sessRoot }
    const runEnv = (a) => {
      const r = spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env })
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
    }

    const dry = runEnv(['repair'])
    ok(dry.code === 0, 'repair 试运行退出码 0')
    ok(dry.out.includes('破损 1 个'), '报出破损数量')
    ok(dry.out.includes('试运行'), '标注为试运行')
    ok(dry.out.includes('可自动修复 1 个'), '报出可自动修复数量')
    ok(!dry.out.includes('已修复'), '试运行不宣称已修复')

    const applied = runEnv(['repair', '--apply'])
    ok(applied.code === 0, 'repair --apply 退出码 0')
    ok(applied.out.includes('已修复'), '宣称已修复')
    ok(applied.out.includes('备份'), '报出备份路径')

    const again = runEnv(['repair'])
    ok(again.out.includes('破损 0 个'), '修完再体检：破损归零')
    ok(again.out.includes('完好'), '给出「完好」结论')

    const one = runEnv(['repair', '--session', sid])
    ok(one.code === 0, '指定会话（已修好）退出码 0')
    ok(one.out.includes('完好'), '指定会话提示无需修复')

    const missing = runEnv(['repair', '--session', 'session-does-not-exist'])
    ok(missing.code === 1, '指定不存在的会话退出码 1')

    await rm(sessRoot, { recursive: true, force: true })
  }

  // —— 错误处理 ——
  console.log('\n用例 13：错误处理')
  const bad = run(['export', '--cwd', join(root, 'nope')])
  ok(bad.code === 1, '无日志目录时退出码 1')
  ok(bad.err.includes('❌'), '错误输出带 ❌')
  const unknown = run(['frobnicate'])
  ok(unknown.code === 1, '未知命令退出码 1')

  await rm(root, { recursive: true, force: true })
  console.log(`\n结果：${pass} passed / ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('自测崩了：', e)
  process.exit(1)
})
