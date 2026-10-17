/**
 * dsh-task-journal — 提权执行（sudo）。
 *
 * 有些配置在 `/etc` 下（Docker 的 `daemon.json`、APT 的源列表），只有 root
 * 能改。这个模块提供一条**受控**的提权通道。
 *
 * ## 密码为什么只放在内存里
 * 用户明确要求：**密码不能记录下来**。所以：
 *   - 只存在这个模块的内存变量里，绝不写文件、绝不写日志、绝不出现在任何响应里；
 *   - 有过期时间（默认 5 分钟不用就丢），并有总时长上限；
 *   - `deauthorize()` 会把内存清零，并顺手 `sudo -k` 掉 sudo 自己的时间戳缓存。
 *
 * ## 密码怎么交给 sudo
 * 走 **stdin**（`sudo -S`），不走命令行参数。
 * 命令行参数会出现在 `ps` 里，任何本机用户都看得到。
 *
 * ## 这条通道的边界
 * 网关只监听 `127.0.0.1`，所以密码不出这台机器。但本机上的其它进程仍可能
 * 通过 `/proc` 或调试接口碰到宿主内存 —— 这是本方案**接受的风险**，
 * 不能宣称比这更强。要彻底避免，只能用免密 sudo 白名单或 polkit。
 *
 * @module dsh-task-journal/privileged
 */

/** 授权状态。**唯一**持有密码的地方，模块外拿不到。 */
let holder = null

/** 默认参数。 */
const DEFAULTS = {
  /** 多久不用就丢弃授权（毫秒）。 */
  idleMs: 5 * 60 * 1000,
  /** 从授权算起的最长存活（毫秒），防止无限续用。 */
  maxMs: 30 * 60 * 1000,
  /** 单条命令超时。 */
  commandTimeoutMs: 60 * 1000,
}

/** 该不该认为 sudo 可用（只判断可执行文件在不在）。 */
export async function sudoAvailable(exec) {
  const r = await exec('sudo', ['--version'])
  return r.ok === true
}

/**
 * 当前授权状态。**不返回密码**。
 *
 * @param now 便于测试注入时间。
 */
export function state(now = Date.now()) {
  if (holder === null) return { authorized: false }
  if (now - holder.lastUsedAt > DEFAULTS.idleMs || now - holder.startedAt > DEFAULTS.maxMs) {
    // 过期即失效，并把密码从内存里抹掉。
    holder.password = null
    holder = null
    return { authorized: false, expired: true }
  }
  return {
    authorized: true,
    since: new Date(holder.startedAt).toISOString(),
    lastUsedAt: new Date(holder.lastUsedAt).toISOString(),
    // 剩余可用时间，让界面能显示倒计时。
    expiresInMs: Math.max(0, DEFAULTS.idleMs - (now - holder.lastUsedAt)),
  }
}

/**
 * 校验并暂存密码。
 *
 * 用 `sudo -S -v` 校验：它只刷新 sudo 的时间戳，**不改任何东西** ——
 * 拿一个写操作去试密码是危险的（密码错会留下半截改动）。
 *
 * @param password 用户输入的密码。
 * @param exec 执行器（便于测试）。
 */
export async function authorize(password, exec) {
  if (typeof password !== 'string' || password === '') {
    return { ok: false, reason: '密码不能为空' }
  }
  const probe = await runSudo(exec, ['-v'], password)
  if (probe.ok !== true) {
    // 判定「密码不对」要跨语言：这台机器上 sudo 输出的是中文
    // （「对不起，请重试。」/「错误密码尝试」），只认英文会误报成环境问题。
    const text = `${probe.stderr ?? ''}\n${probe.reason ?? ''}`
    const bad = /incorrect password|Sorry, try again|authentication failure|密码尝试|请重试|口令/i.test(text)
    return {
      ok: false,
      // 不回显命令与原始 stderr：sudo 的输出可能带主机名、用户名等环境信息。
      reason: bad ? '密码不正确' : '无法获得提权（可能是当前用户不在 sudoers，或 sudo 需要终端）',
    }
  }
  const now = Date.now()
  holder = { password, startedAt: now, lastUsedAt: now }
  return { ok: true, ...state(now) }
}

/** 丢弃授权：内存清零，并让 sudo 的时间戳缓存也失效。 */
export async function deauthorize(exec) {
  const had = holder !== null
  if (holder !== null) holder.password = null
  holder = null
  if (had && exec !== undefined) await runSudo(exec, ['-k'], null)
  return { ok: true, had }
}

/**
 * 跑一条 sudo 命令。
 *
 * 密码写进 stdin，不走 argv —— argv 会被 `ps` 看到。
 *
 * @param args 传给 sudo 的参数（如 `['-v']`、`['tee','/etc/x']`）。
 * @param password 密码；`null` 表示不需要密码（例如 `-k`）。
 * @param options 可给 `input`（额外写入 stdin 的内容，如要写入文件的内容）。
 */
function runSudo(exec, args, password, options = {}) {
  // `-S` 从 stdin 读密码；`-p ''` 关掉提示语，避免提示混进 stdout。
  const argv = password === null ? args : ['-S', '-p', '', ...args]
  return exec('sudo', argv, {
    ...options,
    // 密码与内容不能混在同一个 stdin 里，见 writeAsRoot。
    stdin: password === null ? (options.input ?? null) : `${password}\n${options.input ?? ''}`,
    // 明确不让这一步的输出进入任何日志路径。
    sensitive: true,
  })
}

/** 拿当前授权的密码；没有授权时返回 null。 */
function currentPassword(now = Date.now()) {
  const s = state(now)
  if (s.authorized !== true) return null
  holder.lastUsedAt = now
  return holder.password
}

/**
 * 以 root 写一个文件。
 *
 * 做法刻意分两步：内容先写进**用户自己的临时文件**，再用 `sudo install`
 * 搬过去。这样密码（走 stdin）与文件内容（走临时文件）永远不会混在一起。
 *
 * @param target 目标绝对路径。
 * @param content 新内容。
 * @param exec 执行器。
 * @param options 可给 `mode`（默认沿用目标文件现有权限，或 0644）。
 */
export async function writeAsRoot(target, content, exec, options = {}) {
  const { writeFile, unlink, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  if (typeof target !== 'string' || !target.startsWith('/')) {
    return { ok: false, reason: '目标必须是绝对路径' }
  }
  const password = currentPassword()
  if (password === null) return { ok: false, needsAuth: true, reason: '还没有授权提权' }

  // 目标文件现有的权限尽量保留。
  let mode = options.mode ?? '0644'
  try {
    const st = await stat(target)
    mode = (st.mode & 0o777).toString(8).padStart(4, '0')
  } catch { /* 新文件用默认 */ }

  const tmp = join(tmpdir(), `dtj-sudo-${process.pid}-${Date.now()}`)
  try {
    await writeFile(tmp, content, { mode: 0o600 })
    const r = await runSudo(exec, ['install', '-m', mode, '-o', 'root', '-g', 'root', tmp, target], password)
    if (r.ok !== true) {
      const bad = /incorrect password|Sorry, try again|密码尝试|请重试|口令/i.test(r.stderr ?? '')
      return { ok: false, reason: bad ? '密码已失效，请重新授权' : `写入失败：${r.reason ?? '未知原因'}` }
    }
    return { ok: true, target, mode, bytes: Buffer.byteLength(content) }
  } finally {
    // 临时文件里是配置内容（可能有 secrets），一定删掉。
    try { await unlink(tmp) } catch { /* 删不掉不影响结果 */ }
  }
}

/** 以 root 跑一条普通命令（不经过 shell）。 */
export async function runAsRoot(command, args, exec) {
  const password = currentPassword()
  if (password === null) return { ok: false, needsAuth: true, reason: '还没有授权提权' }
  if (typeof command !== 'string' || command.includes('/')) {
    // 只接受裸命令名，交给 sudo 走 PATH 解析。
    return { ok: false, reason: `命令名不合法：${String(command)}` }
  }
  return runSudo(exec, [command, ...(args ?? [])], password)
}

/**
 * 提权动作的预检：在动手之前把「能不能做」查清楚。
 *
 * 检查项都是只读的，不需要密码。
 *
 * @param id 镜像清单项 id（`docker` / `apt`）。
 * @param exec 执行器。
 */
export async function preflight(id, exec) {
  const checks = []
  const sudo = await sudoAvailable(exec)
  checks.push({ id: 'sudo', label: '系统里有 sudo', ok: sudo, detail: sudo ? '' : '找不到 sudo 命令' })

  if (id === 'docker') {
    const info = await exec('docker', ['info', '--format', '{{.ServerVersion}}'])
    checks.push({
      id: 'docker-running',
      label: 'Docker 守护进程可用',
      ok: info.ok === true,
      detail: info.ok === true ? `服务端 ${String(info.stdout).trim()}` : (info.reason ?? '连接不上 docker'),
    })
    const unit = await exec('systemctl', ['is-active', 'docker'])
    checks.push({
      id: 'docker-unit',
      label: 'docker 服务在运行（改完要重启）',
      ok: String(unit.stdout ?? '').trim() === 'active',
      detail: String(unit.stdout ?? '').trim() || '查不到状态',
    })
  }

  if (id === 'apt') {
    const { stat } = await import('node:fs/promises')
    let has = false
    try { has = (await stat('/etc/apt/sources.list')).isFile() } catch { has = false }
    checks.push({
      id: 'apt-list',
      label: '/etc/apt/sources.list 存在',
      ok: has,
      detail: has ? '' : '不存在（Debian 13 可能只用 .sources 新格式，需人工处理）',
    })
  }

  return { ok: checks.every((c) => c.ok), id, checks, dryRun: state().authorized !== true }
}
