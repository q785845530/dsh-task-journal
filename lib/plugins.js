/**
 * dsh-task-journal — 插件管理（安装 / 删除 / 状态）。
 *
 * 「插件更新」那条路只管**升级**已安装的组合包（`./updates.js`）。
 * 这个模块补上另外两件事：把包**装进当前 profile**，以及**删除**已安装的插件。
 * 两者都直接改 profile 的 `package.json` 与 `pnpm-lock.yaml`，所以纪律比读操作严得多。
 *
 * 五条纪律
 * --------
 * 1. **写操作必须显式 confirm。** 不靠界面上点过一次就算数——请求体里没 `confirm: true` 一律拒绝。
 * 2. **不许删自己。** 本插件管理着这个面板；删掉自己，面板当场消失，
 *    用户失去唯一的操作入口。要删请从 DSH 原生的插件页或命令行做。
 * 3. **不许删宿主随安装提供的东西。** `removable === false` 的一律拒绝，并说明原因，
 *    而不是让 pnpm 报一个看不懂的错。
 * 4. **不许把 spec 当命令行参数。** 以 `-` 开头的 spec 直接拒绝——
 *    它会被 pnpm 当成选项，而不是包名。
 * 5. **没有服务就如实说不可用。** 宿主没装配 `pluginManager` 时照实回 503，
 *    不假装成功、不猜版本。
 *
 * 关于「安装」的风险，这里不做任何粉饰：装一个包就是允许它的代码在你的 DSH 里运行。
 * 这个模块只保证**只在本机、且经人确认**才动手（HTTP 服务本身只监听 127.0.0.1）。
 *
 * @module dsh-task-journal/plugins
 */

/** 本插件自己的包名：拒绝删除，避免把操作入口一起删掉。 */
export const SELF_PACKAGE = 'dsh-task-journal'

/** 一次最多列多少个组合包，防止极端 profile 拖垮一次请求。 */
const MAX_BUNDLES = 300

/** 取服务，并确认需要的方法都在。 */
function take(ctx, name, methods) {
  const service = ctx?.get?.(name)
  if (service === undefined || service === null) {
    return { ok: false, reason: `宿主没有装配 ${name} 服务` }
  }
  const missing = methods.filter((m) => typeof service[m] !== 'function')
  if (missing.length > 0) {
    return { ok: false, reason: `${name} 缺少方法：${missing.join('、')}` }
  }
  return { ok: true, service }
}

/** 把异常转成一句话。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把 `ChangeResult` 压成几行。
 *
 * 不把 pnpm 的完整输出塞进响应：它会很长，而且界面只需要「成没成、要不要重启、错在哪」。
 * @param result - 宿主返回的 ChangeResult。
 * @returns 精简后的结果。
 */
export function summarise(result) {
  if (result === null || typeof result !== 'object') return { application: null }
  return {
    changed: result.changed === true,
    application: typeof result.application === 'string' ? result.application : null,
    stage: typeof result.stage === 'string' ? result.stage : null,
    target: typeof result.target === 'string' ? result.target : null,
    version: typeof result.version === 'string' ? result.version : null,
    restartReason: typeof result.restartReason === 'string' ? result.restartReason : null,
    error: result.error === undefined || result.error === null
      ? null
      : { code: result.error.code ?? null, message: result.error.message ?? null },
  }
}

/**
 * 校验收到的安装 spec。
 *
 * 只做能明确判断的检查，其余交给宿主的 `installBundle` 去拒绝——
 * 在这里重复实现 pnpm 的 spec 语法没有意义，反而会漏。
 * @param spec - 用户输入的 spec。
 * @returns `{ok:true, spec}` 或 `{ok:false, reason}`。
 */
export function validateSpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return { ok: false, reason: '需要包名、路径或仓库地址' }
  if (text.length > 512) return { ok: false, reason: 'spec 太长（上限 512 字符）' }
  // 以 - 开头的会被 pnpm 当成选项而不是包名。
  if (text.startsWith('-')) return { ok: false, reason: 'spec 不能以 - 开头（会被当成命令行选项）' }
  // 控制字符会让日志与命令行解析出问题。
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: 'spec 含控制字符' }
  return { ok: true, spec: text }
}

/**
 * 建插件管理服务。
 *
 * @param deps - `{ ctx, logger }`。
 * @returns `{ available, list, install, remove }`。
 */
export function makePluginAdminService(deps = {}) {
  const { ctx, logger } = deps

  /** 取 `pluginManager`（三个方法缺一不可）。 */
  const manager = () => take(ctx, 'pluginManager', ['listBundles', 'installBundle', 'removeBundle'])

  /** 只报能力，不动磁盘。 */
  const available = () => {
    const m = manager()
    if (!m.ok) return { available: false, reason: m.reason }
    return { available: true, self: SELF_PACKAGE }
  }

  /**
   * 列出所有组合包及其可操作性。
   *
   * 与「插件更新」不同，这里**不只列已安装的**：未安装但随安装提供的、
   * 以及 profile 里声明了但文件缺失的，也要能看到并说明原因——
   * 否则用户会以为「列表里没有 = 不存在」。
   *
   * @returns 列表与计数。
   */
  const list = async () => {
    const m = manager()
    if (!m.ok) return { ok: false, reason: m.reason }

    let rows = []
    try {
      const all = await m.service.listBundles()
      rows = Array.isArray(all) ? all : []
    } catch (error) {
      return { ok: false, reason: `读取插件列表失败：${messageOf(error)}` }
    }

    const plugins = rows.slice(0, MAX_BUNDLES).map((b) => {
      const name = String(b?.name ?? '')
      const installed = b?.installed === true
      const removable = b?.removable === true
      const optional = b?.optional === true
      const error = b?.error === undefined || b?.error === null
        ? null
        : { code: b.error.code ?? null, message: b.error.message ?? null }
      const target = b?.installTarget === undefined || b?.installTarget === null
        ? null
        : {
          spec: typeof b.installTarget.spec === 'string' ? b.installTarget.spec : null,
          version: typeof b.installTarget.version === 'string' ? b.installTarget.version : null,
        }

      // 逐条算出「为什么不能动」，让界面直接显示，而不是点下去才报错。
      let blocked = null
      if (name === SELF_PACKAGE) blocked = '这是任务日志插件自己，删掉面板就没了'
      else if (installed && !removable) blocked = '随 DSH 安装提供，不能在这里移除'
      else if (error !== null) blocked = `该组合包有加载错误：${error.message ?? error.code ?? '未知'}`

      return {
        name,
        version: typeof b?.version === 'string' ? b.version : null,
        installed,
        enabled: b?.enabled === true,
        removable,
        official: b?.official === true,
        optional,
        availability: typeof b?.availability === 'string' ? b.availability : null,
        source: typeof b?.source === 'string' ? b.source : null,
        readOnlyReason: typeof b?.readOnlyReason === 'string' ? b.readOnlyReason : null,
        description: typeof b?.description === 'string' ? b.description : null,
        installTarget: target,
        error,
        isSelf: name === SELF_PACKAGE,
        blocked,
        // 能删 = 已安装 + 可移除 + 不是自己 + 没加载错误。
        canRemove: installed && removable && name !== SELF_PACKAGE && error === null,
      }
    }).filter((p) => p.name !== '')

    const installedCount = plugins.filter((p) => p.installed).length
    const offline = plugins.filter((p) => !p.installed)
    return {
      ok: true,
      self: SELF_PACKAGE,
      runtime: typeof process !== 'undefined' ? process.version : null,
      plugins,
      counts: {
        total: plugins.length,
        installed: installedCount,
        notInstalled: offline.length,
        removable: plugins.filter((p) => p.canRemove).length,
        blocked: plugins.filter((p) => p.blocked !== null).length,
      },
    }
  }

  /**
   * 把一个包装进当前 profile。
   *
   * @param spec - 包名、绝对路径、git 地址或 tarball。
   * @param options - `confirm` 必须为真；`enabled` 决定装完是否立即启用。
   * @returns 安装结果。
   */
  const install = async (spec, options = {}) => {
    const m = manager()
    if (!m.ok) return { ok: false, reason: m.reason }

    const checked = validateSpec(spec)
    if (!checked.ok) return { ok: false, reason: checked.reason }

    if (options.confirm !== true) {
      return { ok: false, reason: '安装会改动 profile 并执行该包的代码，需要 confirm=true' }
    }

    // 已经装过的包不再走这条路：DSH 在有 HMR 时会直接拒绝，
    // 没有 HMR 时也可能装出第二份。要换版本用「插件更新」。
    const current = await list()
    if (current.ok === true) {
      const exists = current.plugins.find((p) => p.installed && p.name === checked.spec)
      if (exists !== undefined) {
        return { ok: false, reason: `${checked.spec} 已经安装；换版本请用「插件更新」页签` }
      }
    }

    const enabled = options.enabled !== false
    try {
      const result = await m.service.installBundle(checked.spec, { enabled })
      const summary = summarise(result)
      const failed = summary.application === 'failed'
      return {
        ok: !failed,
        reason: failed
          ? `安装 ${checked.spec} 失败${summary.error?.message === undefined ? '' : `：${summary.error.message}`}`
          : null,
        spec: checked.spec,
        enabled,
        application: summary.application,
        restartReason: summary.restartReason,
        version: summary.version,
        error: summary.error,
      }
    } catch (error) {
      logger?.warn?.(`dsh-task-journal: 安装 ${checked.spec} 失败：${messageOf(error)}`)
      return { ok: false, reason: `安装 ${checked.spec} 失败：${messageOf(error)}` }
    }
  }

  /**
   * 删除一个已安装的插件。
   *
   * @param name - 包名。
   * @param options - `confirm` 必须为真。
   * @returns 删除结果。
   */
  const remove = async (name, options = {}) => {
    const m = manager()
    if (!m.ok) return { ok: false, reason: m.reason }

    const target = String(name ?? '').trim()
    if (target === '') return { ok: false, reason: '需要包名' }
    if (target === SELF_PACKAGE) {
      return { ok: false, reason: '不能在这里删除任务日志插件自己——删掉这个面板就消失了。请用 DSH 原生插件页或命令行操作。' }
    }
    if (options.confirm !== true) {
      return { ok: false, reason: '删除会改动 profile 并卸载该插件，需要 confirm=true' }
    }

    // 先核一遍状态，不信任调用方：未安装/不可移除的不要送进 pnpm。
    const current = await list()
    if (current.ok === true) {
      const row = current.plugins.find((p) => p.name === target)
      if (row === undefined) return { ok: false, reason: `列表里没有 ${target}` }
      if (!row.installed) return { ok: false, reason: `${target} 没有安装` }
      if (!row.removable) {
        return { ok: false, reason: `${target} 随 DSH 安装提供，不能在这里移除` }
      }
      if (row.error !== null) {
        return { ok: false, reason: `${target} 有加载错误（${row.error.message ?? row.error.code ?? '未知'}），请先用「会话修复」处理` }
      }
    }

    try {
      const result = await m.service.removeBundle(target)
      const summary = summarise(result)
      const failed = summary.application === 'failed'
      // stop-profile：没有 HMR 时移除要等重启；文件已按 pnpm 处理，但运行中的还在。
      const needsRestart = summary.application === 'restart-required' || summary.error?.code === 'stop-profile'
      return {
        ok: !failed,
        reason: failed
          ? `删除 ${target} 失败${summary.error?.message === undefined ? '' : `：${summary.error.message}`}`
          : null,
        name: target,
        changed: summary.changed,
        application: summary.application,
        restartReason: summary.restartReason,
        needsRestart,
        error: summary.error,
      }
    } catch (error) {
      logger?.warn?.(`dsh-task-journal: 删除 ${target} 失败：${messageOf(error)}`)
      return { ok: false, reason: `删除 ${target} 失败：${messageOf(error)}` }
    }
  }

  return { available, list, install, remove }
}
