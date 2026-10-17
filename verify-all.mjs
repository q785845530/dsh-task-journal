#!/usr/bin/env node
/**
 * dsh-task-journal — 一键跑全部自测。
 *
 *   node verify-all.mjs
 *
 * 依次跑六个套件，汇总结果；任一失败则整体退出码非 0。
 * 「改完立刻知道有没有坏」是这套自测存在的唯一理由：修复会话这种动作
 * 一旦写错就是不可逆的，靠人工在真实事故里试太贵。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const SUITES = [
  ['verify.mjs', '插件核心（落盘、任务清单、journal 工具）'],
  ['verify-cli.mjs', '命令行 dsh-journal'],
  ['verify-api.mjs', 'HTTP API'],
  ['verify-subagent.mjs', '子智能体目录与归档'],
  ['verify-repair.mjs', '会话修复流水线（含损坏样本）'],
  ['verify-updates.mjs', '插件更新（版本比较、兼容性拦截、升级顺序）'],
  ['verify-logs.mjs', '后台日志（解析、诊断、修复白名单、路径穿越）'],
  ['verify-mirrors.mjs', '镜像源（清单、配置改写、备份恢复、测速）'],
  ['verify-about.mjs', '关于（仓库归一化、GitHub 降级、热重载、profile 检测）'],
  ['verify-client.mjs', '浏览器半渲染（含「会话修复」「插件更新」「后台日志」「镜像源」「关于」页签）'],
]

let failed = 0
const rows = []

for (const [file, label] of SUITES) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [join(here, file)], { encoding: 'utf8' })
  const ms = Date.now() - started
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const last = out.trim().split('\n').filter(Boolean).pop() ?? ''
  const good = r.status === 0
  if (!good) failed += 1
  rows.push({ file, label, good, ms, last })
  console.log(`${good ? '✓' : '✗'} ${file.padEnd(20)} ${label}`)
  console.log(`  ${last}  (${ms}ms)`)
  if (!good) {
    // 失败时把尾部输出打出来，省得再跑一遍
    console.log(out.trim().split('\n').slice(-25).map((l) => `  │ ${l}`).join('\n'))
  }
}

console.log('')
if (failed === 0) {
  console.log(`✅ 全部 ${SUITES.length} 个套件通过`)
} else {
  console.log(`❌ ${failed}/${SUITES.length} 个套件失败`)
  process.exit(1)
}
