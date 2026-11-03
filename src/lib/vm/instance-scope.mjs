import crypto from 'node:crypto'

const INSTANCE = 'VM2API_INSTANCE_ID'
const SUB_PORTS = 'VM2API_SUBSCRIPTION_PORT_RANGE'
const EGRESS_PORTS = 'VM2API_EGRESS_PORT_RANGE'
export const INSTANCE_LABEL = 'vm2api.instance'
export const RESOURCE_LABEL = 'vm2api.resource'

const invalid = (message) => Object.assign(new Error(message), { code: 'instance_scope_invalid' })

export function instanceId(env = process.env) {
  const id = env[INSTANCE] ?? ''
  if (typeof id !== 'string' || (id !== '' && !/^[a-z][a-z0-9-]{0,31}$/.test(id))) {
    throw invalid(`${INSTANCE} must be empty or a lowercase identifier of at most 32 characters`)
  }
  return id
}

function portRange(value, key, fallback, required, paired = false) {
  if (value == null || value === '') {
    if (required) throw invalid(`${key} is required for a named instance`)
    return fallback
  }
  const match = typeof value === 'string' && value.match(/^([1-9][0-9]{3,4})-([1-9][0-9]{3,4})$/)
  if (!match) throw invalid(`${key} must be first-last`)
  const first = Number(match[1]),
    last = Number(match[2])
  if (first < 1024 || last > 65535 || first > last || (paired && (first % 2 !== 0 || last % 2 !== 1))) {
    throw invalid(`${key} has an invalid port range`)
  }
  return { first, last }
}

export function instancePortRanges(env = process.env) {
  const named = instanceId(env) !== ''
  const subscription = portRange(env[SUB_PORTS], SUB_PORTS, { first: 21000, last: 22999 }, named)
  const egress = portRange(env[EGRESS_PORTS], EGRESS_PORTS, { first: 20000, last: 35999 }, named, true)
  const explicit = named || !!env[SUB_PORTS] || !!env[EGRESS_PORTS]
  if (explicit && subscription.first <= egress.last && egress.first <= subscription.last) {
    throw invalid('subscription and egress port ranges must not overlap')
  }
  return { subscription, egress }
}

export function subscriptionPortRange(env = process.env) {
  return instancePortRanges(env).subscription
}

export function instanceLabels(resourceId, env = process.env) {
  const id = instanceId(env)
  return id ? { [INSTANCE_LABEL]: id, [RESOURCE_LABEL]: resourceId } : {}
}

export function ownsInstanceResource(labels, resourceId = null, env = process.env) {
  const id = instanceId(env)
  const owner = labels?.[INSTANCE_LABEL] || ''
  if (owner !== id) return false
  return !id || resourceId == null || labels?.[RESOURCE_LABEL] === resourceId
}

export function assertInstanceOwner(labels, resourceId, env = process.env) {
  if (!ownsInstanceResource(labels, resourceId, env)) {
    throw Object.assign(new Error('resource belongs to a different vm2api instance'), {
      code: 'instance_scope_conflict',
    })
  }
}

export function slotContainerName(vmId, env = process.env) {
  const id = instanceId(env)
  const vm = String(vmId || '')
  if (!id) return `kin-${vm.replace(/^vm-/, '')}`
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(vm)) throw invalid('invalid slot ID in named instance')
  const name = `kin-i${id.length}-${id}-${vm}`
  if (name.length > 128) throw invalid('scoped slot container name exceeds 128 characters')
  return name
}

export function slotContainerForVm(vm, env = process.env) {
  const configured = String(vm?.runtime?.container || '').trim()
  const id = String(vm?.id || vm?.vmId || '').trim()
  const scope = instanceId(env)
  if (!scope) return configured || (id ? slotContainerName(id, env) : '')
  const expected = slotContainerName(id, env)
  if (configured && configured !== expected) {
    throw Object.assign(new Error('slot container does not belong to this instance'), {
      code: 'instance_scope_conflict',
    })
  }
  return expected
}

function fnv(value) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return hash >>> 0
}

/** proxyId is the canonical artifact ID (all local-node exits share px-local on a host). */
export function egressIdentity(proxyId, env = process.env) {
  const scope = instanceId(env)
  const raw = String(proxyId || '')
  const id = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '')
  if (scope && (!id || id !== raw)) throw invalid('invalid proxy ID in named instance')
  const legacyHex = id
    .replace(/^px-/, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12)
  const identity = scope ? JSON.stringify([scope, id]) : id
  const digest = crypto.createHash('sha256').update(identity).digest('hex')
  const range = instancePortRanges(env).egress
  const tcp = range.first + (fnv(identity) % ((range.last - range.first + 1) / 2)) * 2
  return {
    network: id ? (scope ? `kin-eg-i${scope.length}-${scope}-${id}` : `kin-eg-${id}`) : '',
    bridge: scope ? `keg${digest.slice(0, 12)}` : (`keg${legacyHex}` || 'kegbridge').slice(0, 15),
    chain: scope ? `KEG${digest.slice(0, 24)}` : (`KEG${legacyHex}` || 'KEG').slice(0, 28),
    ports: { tcp, dns: tcp + 1 },
    labels: instanceLabels(`proxy:${id}`, env),
  }
}

/** Remote host facts are scoped before entering the manager cache or edit verifier. */
export function scopedRemoteHost(host, env = process.env) {
  const scope = instanceId(env)
  if (!scope) return host
  const root = String(host?.root || '')
  if (
    !root.startsWith('/') ||
    /[\x00-\x1f\x7f]/.test(root) ||
    root.split('/').some((part) => part === '.' || part === '..')
  )
    throw invalid('invalid remote instance root')
  return { ...host, root: `${root.replace(/\/+$/, '')}/i/${scope}` }
}

export function nativeServiceLabel(vmId, kind = 'kernel', env = process.env) {
  const scope = instanceId(env)
  const vm = String(vmId || '')
  if (scope && !/^[a-zA-Z0-9_-]{1,96}$/.test(vm)) throw invalid('invalid native slot ID in named instance')
  if (!['kernel', 'telemetry'].includes(kind)) throw invalid('invalid native service kind')
  return `com.vm2api.slot.${scope ? `i${scope.length}-${scope}.` : ''}${vm}.${kind}`
}

export function gateContainerName(env = process.env) {
  const scope = instanceId(env)
  return scope ? `kin-slot-gate-i${scope.length}-${scope}` : 'kin-slot-gate'
}
