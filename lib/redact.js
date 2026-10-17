/**
 * dsh-task-journal — 凭据遮蔽。
 *
 * 单独成模块，因为有两个互不相干的调用方：
 *   - `index.js`（写日志、看接口）与 `subagent-catalog.js`（目录归档）；
 *   - `session-repair.js`（擦除会话归档里的历史凭据）。
 * 后者刻意不依赖子智能体目录，所以规则放在这里，谁都能拿。
 *
 * 只认**有明确前缀**的凭据，不做高熵猜测。日志里满是提交哈希、会话 id
 * 与 base64 摘要，通用熵检测会把它们一起撕碎，然后你还找不到原因。
 * 宁可漏掉一个无前缀的密钥，也不要毁掉日志的可读性。
 *
 * @module dsh-task-journal/redact
 */

/**
 * 已知凭据前缀 → 脱敏标签。
 *
 * `re` 带 `g` 标志，`replace` 前必须重置 `lastIndex`，否则跨次调用会漏配。
 */
export const SECRET_RULES = [
  // GitHub：ghp_ 经典 PAT、github_pat_ 细粒度 PAT、gho_/ghu_/ghs_/ghr_ 各类令牌。
  { label: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  // AWS 访问密钥 id（AKIA 长期、ASIA 临时）。
  { label: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // OpenAI 风格。
  { label: 'api-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  // Slack。
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  // Google API key。
  { label: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  // PEM 私钥整块（含多行正文）。
  { label: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

/**
 * 把文本里已知前缀的凭据换成 `<redacted:标签>`。
 *
 * @param text - 原始文本。
 * @returns 脱敏后的文本；不含凭据时原样返回。
 */
export function redactSecrets(text) {
  let s = String(text ?? '')
  if (s === '') return s
  for (const { label, re } of SECRET_RULES) {
    re.lastIndex = 0
    s = s.replace(re, `<redacted:${label}>`)
  }
  return s
}

/** 文本里是否还有已知前缀的凭据。 */
export function hasSecrets(text) {
  const s = String(text ?? '')
  if (s === '') return false
  for (const { re } of SECRET_RULES) {
    re.lastIndex = 0
    if (re.test(s)) return true
  }
  return false
}

/** 递归遮蔽对象/数组里所有字符串值中的凭据（返回新对象，不改原对象）。 */
export function redactSecretsDeep(value) {
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map((v) => redactSecretsDeep(v))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactSecretsDeep(v)
    return out
  }
  return value
}
