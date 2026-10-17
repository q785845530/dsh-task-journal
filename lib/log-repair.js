/**
 * dsh-task-journal — 日志故障修复。
 *
 * `logs.js` 只负责「诊断」，这里负责「动手」。分开的原因是安全性不同：
 * 读日志永远安全，改系统不一定。
 *
 * ## 设计原则
 * 1. **默认不执行。** `plan()` 只出方案，`apply()` 才动，且一次只动一步。
 * 2. **只跑白名单动作。** 不把诊断文本拼成 shell 命令去跑 —— 那样一个
 *    日志里的注入就能变成任意代码执行。每个动作是一个具名函数，按 id 找。
 * 3. **做完要复查。** 修完重新诊断同一份日志，看故障是否真的消失；
 *    没消失就如实说没修好，不假装成功。
 *
 * @module dsh-task-journal/log-repair
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { diagnose, logsDir } from './logs.js'

/** 白名单动作：id → { 说明, 执行 }。**只加只读或可完全回退的动作。** */
export const ACTIONS = {
  /**
   * 查看谁占着端口。纯只读。
   */
  'inspect-port': {
    title: '查看端口占用',
    async run({ port, exec }) {
      if (typeof port !== 'string' || !/^\d{1,5}$/.test(port)) {
        return { ok: false, reason: `端口不合法：${String(port)}` }
      }
      const r = await exec('ss', ['-ltnp', `sport = :${port}`])
      if (!r.ok) return { ok: false, reason: r.reason }
      // 输出里除了表头还有没有监听行，直接决定端口是否仍被占。
      const busy = r.stdout.split('\n').some((line) => line.includes(`:${port}`))
      return { ok: true, busy, output: r.stdout.trim() }
    },
  },

  /**
   * 重装 profile 依赖。可回退（再装回来就是），但会动 node_modules，
   * 所以只由人显式触发。
   */
  'reinstall-profile': {
    title: '重装 profile 依赖',
    async run({ profile, exec }) {
      if (typeof profile !== 'string' || !/^[A-Za-z0-9._-]+$/.test(profile)) {
        return { ok: false, reason: `profile 名不合法：${String(profile)}` }
      }
      const dir = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '~', '.dsh'), 'profiles', profile)
      const r = await exec('pnpm', ['install'], { cwd: dir })
      return r.ok
        ? { ok: true, output: r.stdout.trim().slice(0, 800) }
        : { ok: false, reason: r.reason }
    },
  },
}

/** 从诊断结论里生成「可执行修复方案」。 */
export function plan(diagnosis) {
  const steps = []
  for (const issue of diagnosis.issues ?? []) {
    for (const fix of issue.fixes) {
      if (fix.kind !== 'command') continue
      // 把「给人看的命令」翻译成白名单动作 id。
      const action = actionFor(fix.command)
      if (action === null) continue
      steps.push({
        issue: issue.id,
        issueTitle: issue.title,
        label: fix.label,
        action,
        args: argsFor(action, fix.command, diagnosis),
        command: fix.command,
        why: fix.why,
      })
    }
  }
  return steps
}

/** 命令 → 动作 id。认不出就不提供执行，只留文字建议。 */
function actionFor(command) {
  if (/^ss -ltnp /.test(command)) return 'inspect-port'
  if (/pnpm install$/.test(command)) return 'reinstall-profile'
  return null
}

/** 从命令里抠出动作参数。 */
function argsFor(action, command, diagnosis) {
  if (action === 'inspect-port') {
    const m = /sport = :(\d+)/.exec(command)
    return { port: m === null ? '' : m[1] }
  }
  if (action === 'reinstall-profile') {
    return { profile: diagnosis.header?.profile ?? 'web' }
  }
  return {}
}

/** 跑一个动作。`exec` 由调用方注入，方便测试与限制权限。 */
export async function runStep(step, exec) {
  const action = ACTIONS[step.action]
  if (action === undefined) return { ok: false, reason: `没有这个动作：${step.action}` }
  try {
    return await action.run({ ...step.args, exec })
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) }
  }
}

/**
 * 修完后复查：重新读同一份日志再诊断一遍。
 *
 * 注意这是**复查档案**，不是复查系统现状 —— 日志是历史快照，不会因为
 * 修好而改变。真正要确认「现在还坏不坏」，得看端口探测之类的实时证据。
 * 所以这里同时给出两者，并明确区分。
 */
export async function verify({ name, port, exec }) {
  const dir = logsDir()
  let file = null
  try {
    const text = await readFile(join(dir, name), 'utf8')
    file = diagnose(text)
  } catch (e) {
    return { ok: false, reason: `读不到那份日志：${e?.message ?? String(e)}` }
  }

  const checks = []
  checks.push({
    id: 'log-still-records-failure',
    label: '那份日志仍然记录着启动失败',
    ok: false,
    detail: '日志是历史快照，修好也不会变。这不是没修好的证据。',
  })

  if (typeof port === 'string' && /^\d{1,5}$/.test(port)) {
    const r = await ACTIONS['inspect-port'].run({ port, exec })
    checks.push({
      id: 'port-free',
      label: `端口 ${port} 现在是否空出来了`,
      ok: r.ok === true && r.busy === false,
      detail: r.ok ? (r.busy ? '仍被占用' : '已空出') : r.reason,
    })
  }

  // 结论只认实时证据；没有实时证据就明确说「无法判定」。
  const live = checks.filter((c) => c.id !== 'log-still-records-failure')
  const verdict = live.length === 0
    ? 'unknown'
    : live.every((c) => c.ok) ? 'fixed' : 'still-broken'

  return {
    ok: true,
    verdict,
    name,
    issues: file.issues,
    checks,
  }
}
