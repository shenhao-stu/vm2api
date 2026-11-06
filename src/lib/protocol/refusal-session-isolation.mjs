import { createHash } from 'node:crypto'
import { makeError } from '../core/errors.mjs'
import { isContentPolicyErrorCode, isUpstreamRefusal } from '../core/refusal-guard.mjs'
import { RefusedSessionsRepo } from '../db/repos/refused-sessions-repo.mjs'
import { stripCallerBilling } from './anthropic-policy.mjs'
import { parseSseDataLine } from './stream-keepalive.mjs'
import { scopeAccountFromVm } from './jev-intercept.mjs'

export function protectsClaudePro({ vm, account } = {}) {
  if (!vm) return false
  // Native relay slots are excluded even when a legacy import labels their plan Pro.
  const origins = [
    vm.id,
    vm.name,
    vm.kind,
    vm.provider,
    vm.credential_mode,
    vm.claude?.mode,
    vm.claude?.source,
    vm.claude?.provider,
  ]
  if (origins.some((value) => /(?:^|[^a-z0-9])re[-_]?claude(?:$|[^a-z0-9])/i.test(String(value || '')))) return false
  const mode = vm.claude?.mode || vm.credential_mode || 'oauth'
  if (mode !== 'oauth') return false
  const scoped = scopeAccountFromVm(vm, account?.unified)
  return scoped.platform === 'claude' && scoped.account_tier === 'pro'
}

// Normalize JSON object order and string/text-block spelling without discarding tool IDs or arguments.
function canonical(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, item[key]]),
    )
  })
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (!block || !Object.hasOwn(block, 'cache_control')) return block
    const { cache_control, ...rest } = block
    return rest
  })
}

function contextDigests({ keyId, sessionId, system, messages }) {
  const session = sessionId
    ? createHash('sha256')
        .update(canonical([keyId, 'session', sessionId]))
        .digest('hex')
    : null
  // A changed or missing client ID can still replay the refused conversation.
  // Hash every prefix for lookup, but only persist the full refused prefix.
  const hash = createHash('sha256').update(
    canonical([keyId, 'history', contentBlocks(stripCallerBilling({ system }).system) || []]),
  )
  const prefixes = []
  for (const turn of Array.isArray(messages) ? messages : []) {
    // Conversion can merge consecutive user turns into one array of blocks.
    // The refused final block must still match when "continue" is appended.
    const content = contentBlocks(turn?.content)
    for (const block of Array.isArray(content) && content.length ? content : [content]) {
      hash.update(canonical({ ...turn, content: block }))
      prefixes.push(hash.copy().digest('hex'))
    }
  }
  return {
    candidates: [session, ...prefixes].filter(Boolean),
    refused: [session, prefixes.at(-1)].filter(Boolean),
  }
}

const isolated = () =>
  makeError({
    type: 'permission_error',
    code: 'session_context_isolated',
    status: 403,
    message:
      'This conversation was isolated after an upstream policy refusal. Start a new conversation without the refused context.',
  })
const unavailable = () =>
  makeError({
    type: 'api_error',
    code: 'session_isolation_unavailable',
    status: 503,
    message: 'Conversation isolation is temporarily unavailable. Please try again later.',
  })

function officialRefusal(result) {
  const error = result?.body?.error
  const status = Number(result?.status)
  const code = error?.code || error?.type || ''
  if (
    [401, 429].includes(status) ||
    /authentication_error|rate_limit|overload|invalid_grant|oauth_revoked|organization_disabled|account_disabled|billing_error|entitlement/.test(
      code,
    ) ||
    /(?:organization|account).{0,80}(?:disabled|deactivated|suspended|banned|blocked)|oauth authentication is currently not allowed|token has been revoked|third.party apps.{0,60}(?:credit|allow)/i.test(
      error?.message || '',
    )
  )
    return false
  if (status >= 500) return [code, error?.upstream_code].some(isContentPolicyErrorCode)
  return isUpstreamRefusal(result)
}

export function createRefusalSessionIsolation({ readPolicy, getRepo = () => new RefusedSessionsRepo() }) {
  let repo
  const pending = new Map()
  function store() {
    return (repo ??= getRepo())
  }
  function flush(generation) {
    for (const [digests, seenGeneration] of pending) {
      if (generation === seenGeneration) store().remember(digests)
      pending.delete(digests)
    }
  }
  return function forRequest(context) {
    let digests
    let admittedGeneration = null
    let remembered = false
    function identities() {
      return (digests ??= contextDigests(context))
    }
    function remember() {
      if (admittedGeneration === null || remembered) return
      const refused = identities().refused
      if (!refused.length) return
      remembered = true
      pending.set(refused, admittedGeneration)
      try {
        flush(readPolicy().generation)
      } catch {
        // The next protected admission must persist this verdict before sending anything.
        console.error('[refusal-isolation] could not persist an upstream refusal')
      }
    }
    return {
      admit(candidate) {
        admittedGeneration = null
        if (!protectsClaudePro(candidate)) return null
        try {
          const policy = readPolicy()
          if (!policy.enabled) return null
          admittedGeneration = policy.generation
          flush(policy.generation)
          return store().hasRecords() && store().matches(identities().candidates) ? isolated() : null
        } catch {
          return unavailable()
        }
      },
      observeLine(line) {
        if (admittedGeneration === null || remembered || !/refusal|"error"/i.test(line)) return
        const event = parseSseDataLine(line)
        if (
          event?.delta?.stop_reason === 'refusal' ||
          event?.content_block?.type === 'refusal' ||
          (event?.type === 'error' && officialRefusal({ body: event }))
        )
          remember()
      },
      complete(result) {
        if (admittedGeneration !== null && officialRefusal(result)) remember()
      },
    }
  }
}
