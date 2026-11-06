import { createHash } from 'node:crypto'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { defaultProSessionQuarantines } from '../db/repos/pro-session-quarantine-repo.mjs'
import { CALLER_SESSION_HEADER_KEYS, agentSessionId, parseUserId } from '../identity/identity-rewrite.mjs'
import { isContentPolicyErrorCode, isProSessionQuarantineEnabled } from './refusal-guard.mjs'

export const PRO_SESSION_KEY_NAMESPACES = 'pro_session_quarantine_key_namespaces'
const digest = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const officialCliMessage =
  /^(?:API Error:\s*)?(?:Claude Code|Claude) is unable to respond to this request, which appears to violate our Usage Policy\b/i

// Only call on actual upstream events/results from the selected Claude Pro VM.
export function confirmedProRefusal(value) {
  if (!value) return false
  const body = value.body ?? value
  const error = body.error
  const status = Number(value.status ?? 200)
  if (
    value.clientCancelled ||
    value.transportError ||
    value.upstreamExecutions === 0 ||
    status < 200 ||
    status === 401 ||
    status === 429 ||
    status >= 500
  )
    return false
  if (['authentication_error', 'rate_limit_error', 'overloaded_error'].includes(error?.type)) return false
  if (body.stop_reason === 'refusal' || value.stopReason === 'refusal') return true
  if (value.type === 'message_delta' && value.delta?.stop_reason === 'refusal') return true
  if (value.type === 'message_start' && value.message?.stop_reason === 'refusal') return true
  if (value.type === 'content_block_start' && value.content_block?.type === 'refusal') return true
  if (Array.isArray(body.content) && body.content.some((block) => block?.type === 'refusal')) return true
  if (!error || error.code === 'refusal_guard' || ![200, 400, 403, 422].includes(status)) return false
  const message = typeof error.message === 'string' ? error.message.trim().replace(/^(?:provider error:\s*)+/i, '') : ''
  return (
    isContentPolicyErrorCode(error.code) || isContentPolicyErrorCode(error.type) || officialCliMessage.test(message)
  )
}

function principal(req, settings) {
  const record = req?.apiKeyRecord
  if (record?.id) {
    const namespaces = settings.get(PRO_SESSION_KEY_NAMESPACES, {})
    const shared = namespaces && Object.hasOwn(namespaces, record.id) ? namespaces[record.id] : null
    // Only an operator-assigned namespace can join rotation keys. Caller headers cannot join one.
    return typeof shared === 'string' && shared
      ? digest(['shared', record.user_id ?? null, shared])
      : digest(['key', record.user_id ?? null, record.id])
  }
  if (req?.apiKeyKind === 'master') return digest(['master'])
  if (req?.panelUser) return digest(['panel', req.panelUserId ?? req.panelUser])
  return null
}

function quarantineIdentity(inbound, headers) {
  const valid = (value) => (typeof value === 'string' && value.length <= 4096 ? value.trim() : '')
  const meta = parseUserId(inbound.metadata?.user_id) ?? {}
  const fields = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  // Cache keys can be shared by an entire application. Only conversation IDs qualify.
  const root =
    [
      meta.session_id,
      ...CALLER_SESSION_HEADER_KEYS.map((k) => fields[k]),
      inbound.conversation_id,
      inbound.session_id,
      inbound.thread_id,
    ]
      .map(valid)
      .find(Boolean) ?? ''
  const id = agentSessionId(root, valid(fields['x-claude-code-agent-id']))
  const device = [meta.device_id, inbound.device_id, fields['x-kin-device-id']].map(valid).find(Boolean) ?? ''
  const session = id ? digest(['session', device, id]) : null
  return { session, client: device ? digest(['device', device]) : session || '' }
}

// Stream canonical JSON fields into the hash. Large image/tool strings are never copied into a second serialized request.
function hashValue(hash, value) {
  const stack = [value]
  while (stack.length) {
    const v = stack.pop()
    if (typeof v === 'string') {
      hash.update(`s${Buffer.byteLength(v)}:`).update(v)
    } else if (Array.isArray(v)) {
      hash.update(`a${v.length}:`)
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i])
    } else if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v).sort()
      hash.update(`o${keys.length}:`)
      for (let i = keys.length - 1; i >= 0; i--) stack.push(v[keys[i]], keys[i])
    } else {
      hash.update(`v${JSON.stringify(v)};`)
    }
  }
}

function blocks(value) {
  return typeof value === 'string' ? [{ type: 'text', text: value }] : Array.isArray(value) ? value : []
}

function conversationBlock(block) {
  if (!block || typeof block !== 'object') return block
  const { cache_control, ...content } = block
  if (content.type === 'tool_result') content.content = blocks(content.content).map(conversationBlock)
  return content
}

function* steps(messages) {
  for (const message of messages) {
    if (!['assistant', 'user', 'system'].includes(message?.role)) continue
    yield ['role', message.role]
    for (const block of blocks(message.content)) yield ['block', conversationBlock(block)]
  }
}

// A full refused prefix remains recognizable when Continue adds a new turn or a block to the last turn.
function* digestsAt(messages, system, lengths) {
  const hash = createHash('sha256')
  let last = 0
  for (const length of lengths) last = Math.max(last, length)
  const systemBlocks = blocks(system).filter((block) => !/^\s*x-anthropic-billing-header:/i.test(block?.text ?? ''))
  hashValue(hash, ['system', systemBlocks.map(conversationBlock)])
  let count = 0
  for (const step of steps(messages)) {
    hashValue(hash, step)
    count++
    if (lengths.has(count)) yield { digest: hash.copy().digest('hex'), steps: count }
    if (count >= last) break
  }
}

const dependency = (value, fallback) => (typeof value === 'function' ? value() : value) ?? fallback()

export function createProSessionQuarantine({ req, inbound = {}, body = inbound, headers = {}, settings, repo }) {
  const messages = Array.isArray(body?.messages)
    ? body.messages
    : Array.isArray(inbound.messages)
      ? inbound.messages
      : []
  const system = body?.system ?? inbound.system
  const prefixes = new Map()
  let saved = false,
    count,
    scope,
    session,
    client,
    config,
    storage
  function enabled() {
    config ??= dependency(settings, () => new SettingsRepo())
    if (!isProSessionQuarantineEnabled((key, fallback) => config.get(key, fallback))) return false
    scope ??= principal(req, config)
    if (!scope) return false
    storage ??= dependency(repo, defaultProSessionQuarantines)
    if (session === undefined) {
      const identity = quarantineIdentity(inbound, headers)
      session = identity.session
      client = identity.client
    }
    return true
  }
  function size() {
    count ??= messages.reduce(
      (n, m) =>
        n +
        (['user', 'assistant', 'system'].includes(m?.role)
          ? 1 + (typeof m.content === 'string' ? 1 : Array.isArray(m.content) ? m.content.length : 0)
          : 0),
      0,
    )
    return count
  }
  function prefixDigests(lengths) {
    const missing = new Set([...lengths].filter((length) => !prefixes.has(length)))
    if (missing.size) {
      for (const entry of digestsAt(messages, system, missing)) prefixes.set(entry.steps, entry)
    }
    return [...lengths].map((length) => prefixes.get(length)).filter(Boolean)
  }
  return {
    enabled,
    blocked() {
      if (!enabled()) return false
      if (session && storage.has(scope, 'session', session)) return true
      // A new, explicitly identified conversation must carry the refused prefix
      // forward, not merely start with the same standalone request.
      const lengths = new Set(storage.contextLengths(scope, size() - (session ? 1 : 0)))
      if (!lengths.size) return false
      for (const entry of prefixDigests(lengths)) {
        if (storage.has(scope, 'context', entry.digest, client)) return true
      }
      return false
    },
    observe(result) {
      if (saved) return true
      if (!confirmedProRefusal(result) || !enabled()) return false
      const entries = session ? [{ kind: 'session', digest: session, steps: 0 }] : []
      if (size()) {
        for (const entry of prefixDigests([count])) entries.push({ kind: 'context', client, ...entry })
      }
      if (!entries.length) return false
      storage.remember(scope, entries)
      saved = true
      return true
    },
  }
}
