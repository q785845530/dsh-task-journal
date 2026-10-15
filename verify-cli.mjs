#!/usr/bin/env node
/**
 * dsh-journal CLI 自测。
 *
 *   node verify-cli.mjs
 *
 * 造一份假的 .dsh-journal/ 数据，逐个跑子命令，断言输出与退出码。
 */
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
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

  // —— retry ——
  console.log('\n用例 7：retry')
  const r = run(['retry', '--cwd', root])
  ok(r.code === 0, '退出码 0')
  ok(r.out.includes('journal_retry'), '给出工具重试指引')
  ok(r.out.includes('继续'), '给出「继续」指引')
  ok(r.out.includes('✅'), '有完成提示')

  // —— 错误处理 ——
  console.log('\n用例 8：错误处理')
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
