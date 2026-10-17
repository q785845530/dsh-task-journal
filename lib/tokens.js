/**
 * dsh-task-journal — 令牌管理（加密存储）。
 *
 * 有些服务要给令牌才能用（GitHub 的 Star 数、Gitee 的私有仓库等）。
 * GitHub 有行业标准的环境变量（`GH_TOKEN` / `GITHUB_TOKEN`），但 Gitee 之类
 * 没有，所以插件得自己管。
 *
 * ## 磁盘上只有密文
 * 用户的要求是「记录内容是密文」。做法：
 *   - 令牌用 **AES-256-GCM** 加密后才落盘，文件里没有任何明文；
 *   - 密钥是 32 字节随机数，存在**另一个文件**里，权限 0600；
 *   - 连「提示」（前几位/后几位）也不明文存 —— 显示时才解密算出来。
 *
 * ## 这层加密挡得住什么、挡不住什么
 * 挡得住：误提交进 git、被备份/同步服务带走、随手 `cat` 看到。
 * 挡不住：能读到你**同一个用户**文件的人 —— 密钥文件也在同一个家目录下。
 * 要挡住那种情况需要口令派生密钥（每次要输口令）或用系统钥匙串，
 * 这里**不假装**做到了。README 里写明。
 *
 * @module dsh-task-journal/tokens
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { dshHome } from './about.js'

/** 存储目录。 */
export function storeDir() {
  return join(dshHome(), '.dsh-task-journal')
}

/** 密钥文件（0600）。 */
export function keyPath() {
  return join(storeDir(), 'key')
}

/** 令牌文件（密文）。 */
export function tokenPath() {
  return join(storeDir(), 'tokens.json')
}

/**
 * 支持的令牌「槽位」。
 *
 * 每项声明：显示名、用途、以及有没有等价的标准环境变量。
 * 环境变量优先于这里存的 —— 那是更标准的做法，也让用户随时能改。
 */
export const SLOTS = [
  {
    name: 'github',
    label: 'GitHub',
    purpose: '读取 star / fork / issue 数（未认证接口每小时只有 60 次）',
    envVars: ['GH_TOKEN', 'GITHUB_TOKEN'],
    hintPrefix: 'ghp_ / github_pat_',
  },
  {
    name: 'gitee',
    label: 'Gitee',
    purpose: '访问私有仓库、提高接口额度',
    envVars: ['GITEE_TOKEN'],
    hintPrefix: 'Gitee 私人令牌',
  },
]

/** 按名字取槽位。 */
export function slot(name) {
  return SLOTS.find((s) => s.name === name) ?? null
}

// ————————————————————————— 密钥 —————————————————————————

/** 读取密钥；不存在则生成。权限一律收紧到 0600。 */
async function ensureKey() {
  const path = keyPath()
  try {
    const buf = await readFile(path)
    if (buf.length === 32) {
      // 万一权限被改宽了（比如从备份恢复），顺手收紧。
      const st = await stat(path)
      if ((st.mode & 0o777) !== 0o600) await chmod(path, 0o600)
      return buf
    }
    // 长度不对：当作损坏，重新生成会让旧密文全部解不开，
    // 所以这里**不覆盖**，直接报错让人处理。
    throw new Error(`密钥文件长度不对（${buf.length} 字节），应为 32。为避免解不开已有令牌，这里不覆盖它。`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(storeDir(), { recursive: true, mode: 0o700 })
  const key = randomBytes(32)
  // 先写成 0600 再 rename，避免出现权限短暂的宽窗口。
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, key, { mode: 0o600 })
  await rename(tmp, path)
  await chmod(path, 0o600).catch(() => {})
  return key
}

// ————————————————————————— 加解密 —————————————————————————

/**
 * 加密一个字符串。
 *
 * AES-256-GCM：带认证标签，密文被改过会解密失败，而不是解出一段垃圾。
 */
export function encrypt(plain, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

/** 解密。密文或标签被改过会抛异常。 */
export function decrypt(payload, key) {
  const iv = Buffer.from(payload.iv, 'base64')
  const tag = Buffer.from(payload.tag, 'base64')
  const data = Buffer.from(payload.data, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

// ————————————————————————— 读写 —————————————————————————

/** 读整份存储；文件不存在返回空结构，解析失败如实报错。 */
async function readStore() {
  const path = tokenPath()
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.tokens !== 'object') {
      return { ok: false, reason: '令牌文件结构不对', tokens: {} }
    }
    return { ok: true, tokens: parsed.tokens ?? {} }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, tokens: {} }
    if (error instanceof SyntaxError) return { ok: false, reason: '令牌文件不是合法 JSON', tokens: {} }
    return { ok: false, reason: error?.message ?? String(error), tokens: {} }
  }
}

/** 原子写整份存储，权限 0600。 */
async function writeStore(tokens) {
  await mkdir(storeDir(), { recursive: true, mode: 0o700 })
  const path = tokenPath()
  const body = `${JSON.stringify({ version: 1, alg: 'aes-256-gcm', tokens }, null, 2)}\n`
  const tmp = `${path}.tmp-${process.pid}`
  try {
    await writeFile(tmp, body, { mode: 0o600 })
    await rename(tmp, path)
    await chmod(path, 0o600).catch(() => {})
  } catch (error) {
    try { await unlink(tmp) } catch { /* 清理失败不重要 */ }
    throw error
  }
}

/** 从明文算出显示用的提示：前 4 位 + 后 4 位，中间打码。 */
export function maskOf(value) {
  const s = String(value ?? '')
  if (s.length <= 8) return '•'.repeat(Math.max(4, s.length))
  return `${s.slice(0, 4)}${'•'.repeat(Math.min(12, s.length - 8))}${s.slice(-4)}`
}

/** 环境变量里有没有给这个槽位配令牌。**不回显值**。 */
export function envToken(slotName) {
  const s = slot(slotName)
  if (s === null) return null
  for (const v of s.envVars) {
    const val = process.env[v]
    if (typeof val === 'string' && val.trim() !== '') return { from: v, value: val.trim() }
  }
  return null
}

/**
 * 列出所有槽位的状态。
 *
 * **只返回提示，不返回明文。** 明文只能通过 `reveal` 显式取。
 */
export async function list() {
  const store = await readStore()
  const out = []
  for (const s of SLOTS) {
    const entry = store.tokens[s.name]
    const env = envToken(s.name)
    let hint = null
    let broken = null
    if (entry !== undefined) {
      try {
        const key = await ensureKey()
        hint = maskOf(decrypt(entry, key))
      } catch (error) {
        // 解不开通常是密钥换了。如实说，别显示成一个空令牌。
        broken = error?.message ?? String(error)
      }
    }
    out.push({
      name: s.name,
      label: s.label,
      purpose: s.purpose,
      envVars: s.envVars,
      hintPrefix: s.hintPrefix ?? null,
      // 存在哪里、什么时候存的
      stored: entry !== undefined,
      storedAt: entry?.at ?? null,
      hint,
      broken,
      // 环境变量优先：它比存在插件里更标准，也更方便轮换。
      fromEnv: env === null ? null : env.from,
      effective: env !== null ? 'env' : (entry !== undefined ? 'store' : 'none'),
    })
  }
  return { ok: store.ok !== false, reason: store.reason ?? null, slots: out, dir: storeDir(), keyExists: existsSync(keyPath()) }
}

/** 存入一个令牌（加密后落盘）。 */
export async function set(name, value) {
  const s = slot(name)
  if (s === null) return { ok: false, reason: `不认识的令牌槽位：${name}` }
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: '令牌不能为空' }
  const v = value.trim()
  // 明显不合法的直接拒，免得存进去一个永远用不了的东西。
  if (v.length < 8) return { ok: false, reason: '令牌太短，看起来不像有效的令牌' }
  if (/[\s]/.test(v)) return { ok: false, reason: '令牌里不该有空白字符' }

  const key = await ensureKey()
  const store = await readStore()
  if (store.ok === false) return { ok: false, reason: `现有令牌文件读不了，为安全起见没有覆盖：${store.reason}` }
  const tokens = { ...store.tokens }
  tokens[name] = { ...encrypt(v, key), at: new Date().toISOString(), slot: name }
  await writeStore(tokens)
  return { ok: true, name, hint: maskOf(v), storedAt: tokens[name].at }
}

/** 删除一个令牌。 */
export async function remove(name) {
  const s = slot(name)
  if (s === null) return { ok: false, reason: `不认识的令牌槽位：${name}` }
  const store = await readStore()
  if (store.tokens[name] === undefined) return { ok: false, reason: `${s.label} 本来就没有存令牌` }
  const tokens = { ...store.tokens }
  delete tokens[name]
  await writeStore(tokens)
  return { ok: true, name }
}

/**
 * 取出明文。
 *
 * 只有显式的「显示」动作才会走到这里，且调用方必须已经做过本地校验。
 */
export async function reveal(name) {
  const s = slot(name)
  if (s === null) return { ok: false, reason: `不认识的令牌槽位：${name}` }
  const store = await readStore()
  const entry = store.tokens[name]
  if (entry === undefined) return { ok: false, reason: `${s.label} 没有存令牌` }
  try {
    const key = await ensureKey()
    return { ok: true, name, value: decrypt(entry, key) }
  } catch (error) {
    return { ok: false, reason: `解不开：${error?.message ?? String(error)}（密钥可能被换过）` }
  }
}

/**
 * 取一个可用的令牌值，供**内部**使用（比如去打 GitHub 接口）。
 *
 * 环境变量优先。返回 `null` 表示没有。
 */
export async function resolve(name) {
  const env = envToken(name)
  if (env !== null) return env.value
  const store = await readStore()
  if (store.tokens[name] === undefined) return null
  try {
    const key = await ensureKey()
    return decrypt(store.tokens[name], key)
  } catch { return null }
}

/** 存储目录的状态（给界面看：文件在不在、多大、权限对不对）。 */
export async function storageInfo() {
  const info = { dir: storeDir(), key: null, tokens: null }
  for (const [k, path] of [['key', keyPath()], ['tokens', tokenPath()]]) {
    try {
      const st = await stat(path)
      info[k] = { exists: true, bytes: st.size, mode: (st.mode & 0o777).toString(8).padStart(4, '0') }
    } catch {
      info[k] = { exists: false }
    }
  }
  return info
}
