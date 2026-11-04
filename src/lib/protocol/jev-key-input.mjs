export const JEV_KEY_MAX = 999
const KEY_LINE_MAX = 500

/** A validated line may bind a key to a provider URL. */
export function splitJevKeyLine(line) {
  const match = String(line || '')
    .trim()
    .match(/^(https?:\/\/\S+)\s+(\S+)$/)
  return match ? { baseUrl: match[1], apiKey: match[2] } : { baseUrl: '', apiKey: String(line || '').trim() }
}

/** Parse export text without returning credential bytes in validation messages. */
export function parseJevKeyInput(input) {
  const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/)
  const keys = []
  const duplicates = []
  const errors = []
  const seen = new Set()
  let total = 0
  for (const [index, value] of lines.entries()) {
    const line = index + 1
    if (typeof value !== 'string') {
      errors.push({ line, message: '需要文本' })
      continue
    }
    let text = value.trim()
    if (!text) continue
    total += 1
    if (/^APIKEY\s*:/i.test(text)) {
      const exported = text.match(/^APIKEY\s*:\s*(\S+)(?:\s+临时邮箱\s*[:：]\s*[^\s@]+@[^\s@]+\.[^\s@]+)?$/i)
      if (!exported) {
        errors.push({ line, message: 'APIKEY 导出行格式不正确，仅支持可选的临时邮箱尾注' })
        continue
      }
      text = exported[1]
    }
    let token = text
    let valid = true
    if (/^https?:\/\//i.test(text)) {
      const parts = text.split(/\s+/)
      try {
        const url = new URL(parts[0])
        valid = parts.length === 2 && !url.username && !url.password && !url.hash
        token = parts[1] || ''
        text = `${url.href.replace(/\/$/, '')} ${token}`
      } catch {
        valid = false
      }
    }
    if (!valid || !/^[A-Za-z0-9._~+/-]+=*$/.test(token) || text.length > KEY_LINE_MAX) {
      errors.push({ line, message: `需填写 Key、APIKEY:Key 或 URL 空格 Key，最长 ${KEY_LINE_MAX} 字符` })
    } else if (seen.has(text)) duplicates.push(line)
    else {
      seen.add(text)
      keys.push(text)
    }
  }
  return { keys, total, duplicates, errors, tooMany: keys.length > JEV_KEY_MAX }
}
