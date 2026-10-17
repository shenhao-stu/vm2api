import crypto from 'node:crypto'
import { parseDocument, isAlias, isCollection } from 'yaml'
import { MAX_SOURCE_BYTES, SubscriptionError, validEndpointHost } from './subscription-network.mjs'

export const MAX_SUBSCRIPTION_NODES = 256
const set = (text) => new Set(text.split(' '))
const TYPES = set('ss vmess vless trojan hysteria2 tuic socks5 http')
const COMMON = set(
  'name type server port udp tls skip-cert-verify servername sni client-fingerprint fingerprint alpn network',
)
const FIELDS = {
  ss: set('cipher password udp-over-tcp'),
  vmess: set('uuid alterId cipher packet-encoding'),
  vless: set('uuid flow packet-encoding'),
  trojan: set('password'),
  hysteria2: set('password obfs obfs-password up down ports mport hop-interval'),
  tuic: set(
    'uuid password token congestion-controller udp-relay-mode reduce-rtt heartbeat-interval request-timeout disable-sni',
  ),
  socks5: set('username password'),
  http: set('username password'),
}
const OPTIONS = {
  'ws-opts': set('path headers max-early-data early-data-header-name'),
  'grpc-opts': set('grpc-service-name'),
  'h2-opts': set('path host'),
  'http-opts': set('method path headers'),
  'reality-opts': set('public-key short-id'),
  'ech-opts': set('enable config query-server-name'),
}
const TRANSPORTS = { vmess: set('tcp ws grpc h2 http'), vless: set('tcp ws grpc h2 http'), trojan: set('tcp ws grpc') }
const OPTION_TRANSPORT = { 'ws-opts': 'ws', 'grpc-opts': 'grpc', 'h2-opts': 'h2', 'http-opts': 'http' }
const BOOLEAN = set('udp tls skip-cert-verify udp-over-tcp reduce-rtt disable-sni')
const invalid = () => {
  throw new SubscriptionError()
}
const scalar = (v) =>
  (typeof v === 'string' && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v)) ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v))
const strings = (v) => Array.isArray(v) && v.length <= 16 && v.every((s) => typeof s === 'string' && scalar(s))
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}

function portRanges(value) {
  if (typeof value !== 'string' || value.length > 512) invalid()
  const parts = value.split(',')
  if (!parts.length || parts.length > 32) invalid()
  return parts
    .map((part) => {
      const match = part.trim().match(/^(\d+)(?:[-:](\d+))?$/)
      if (!match) invalid()
      const start = Number(match[1]),
        end = Number(match[2] || match[1])
      if (start < 1 || end > 65535 || start > end) invalid()
      return start === end ? String(start) : `${start}-${end}`
    })
    .join(',')
}

export function sanitizeNode(input) {
  if (!object(input) || !TYPES.has(input.type)) invalid()
  const config = structuredClone(input)
  if (!validEndpointHost(config.server)) throw new SubscriptionError('subscription_blocked')
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) invalid()
  const name = config.name ?? `${config.type} node`
  if (typeof name !== 'string' || !name.trim() || name.length > 128 || !scalar(name)) invalid()
  config.name = name
  for (const [key, value] of Object.entries(config)) {
    if (COMMON.has(key) || FIELDS[config.type].has(key)) {
      if (key === 'alpn' ? !strings(value) : !scalar(value)) invalid()
      if (BOOLEAN.has(key) && typeof value !== 'boolean') invalid()
    } else if (OPTIONS[key]) {
      if (!object(value)) invalid()
      if (OPTION_TRANSPORT[key] && config.network !== OPTION_TRANSPORT[key]) invalid()
      if (key === 'reality-opts' && (!['vless', 'vmess'].includes(config.type) || config.tls !== true)) invalid()
      for (const [option, item] of Object.entries(value)) {
        if (!OPTIONS[key].has(option)) invalid()
        if (option === 'headers') {
          if (
            !object(item) ||
            Object.keys(item).length > 16 ||
            Object.entries(item).some(
              ([h, v]) => !/^[a-z\d-]{1,64}$/i.test(h) || (!(typeof v === 'string' && scalar(v)) && !strings(v)),
            )
          )
            invalid()
        } else if (!scalar(item) && !strings(item)) invalid()
      }
      if (key === 'ech-opts' && value['query-server-name'] && !validEndpointHost(value['query-server-name'])) invalid()
    } else invalid()
  }
  if (config.network && !TRANSPORTS[config.type]?.has(config.network)) invalid()
  if (
    ['vmess', 'vless'].includes(config.type) &&
    (typeof config.uuid !== 'string' || !/^[a-f\d-]{32,36}$/i.test(config.uuid))
  )
    invalid()
  if (['ss', 'trojan', 'hysteria2'].includes(config.type) && (typeof config.password !== 'string' || !config.password))
    invalid()
  if (config.type === 'ss' && (typeof config.cipher !== 'string' || !config.cipher)) invalid()
  if (config.type === 'tuic' && !(config.token || (config.uuid && config.password))) invalid()
  if (config.mport !== undefined) {
    const ports = portRanges(config.mport)
    if (config.ports !== undefined && portRanges(config.ports) !== ports) invalid()
    config.ports = ports
    delete config.mport
  }
  if (config.ports !== undefined) config.ports = portRanges(config.ports)
  const identity = { ...config }
  delete identity.name
  return {
    name,
    type: config.type,
    config,
    hash: crypto
      .createHash('sha256')
      .update(JSON.stringify(canonical(identity)))
      .digest('hex'),
  }
}

function decoded64(value) {
  const compact = value.replace(/\s+/g, '')
  if (!compact || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact) || compact.length % 4 === 1) invalid()
  const bytes = Buffer.from(compact, 'base64')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function uriNode(line) {
  if (line.startsWith('vmess://')) {
    const value = JSON.parse(decoded64(line.slice(8)))
    const allowed = set('v ps add port id aid scy net type host path tls sni alpn fp')
    if (Object.keys(value).some((key) => !allowed.has(key)) || (value.type && value.type !== 'none')) invalid()
    const node = {
      name: value.ps || 'vmess node',
      type: 'vmess',
      server: value.add,
      port: Number(value.port),
      uuid: value.id,
      alterId: Number(value.aid || 0),
      cipher: value.scy || 'auto',
      network: value.net || 'tcp',
      tls: value.tls === 'tls',
    }
    if (value.sni) node.servername = value.sni
    if (value.fp) node['client-fingerprint'] = value.fp
    if (value.alpn) node.alpn = String(value.alpn).split(',')
    if (node.network === 'ws')
      node['ws-opts'] = { path: value.path || '/', ...(value.host ? { headers: { Host: value.host } } : {}) }
    else if (node.network === 'grpc') node['grpc-opts'] = { 'grpc-service-name': value.path || '' }
    else if (value.path || value.host) invalid()
    return node
  }
  let normalized = line
  if (line.startsWith('ss://') && !line.split('#')[0].includes('@')) {
    const [encoded, label] = line.slice(5).split('#')
    normalized = `ss://${decoded64(encoded)}${label ? `#${label}` : ''}`
  }
  const url = new URL(normalized)
  const type =
    { 'hy2:': 'hysteria2', 'hysteria2:': 'hysteria2', 'socks:': 'socks5' }[url.protocol] || url.protocol.slice(0, -1)
  if (!TYPES.has(type)) invalid()
  const allowed = set(
    'type security sni peer fp alpn allowInsecure insecure flow pbk sid path host serviceName encryption obfs obfs-password up down ports mport',
  )
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) invalid()
  const q = Object.fromEntries(url.searchParams)
  if (q.encryption && q.encryption !== 'none') invalid()
  const name = decodeURIComponent(url.hash.slice(1)) || `${type} node`
  const node = {
    name,
    type,
    server: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || (type === 'socks5' ? 1080 : 443)),
  }
  const user = decodeURIComponent(url.username),
    password = decodeURIComponent(url.password)
  if (type === 'ss') {
    const credentials = password ? `${user}:${password}` : decoded64(user)
    const colon = credentials.indexOf(':')
    if (colon < 1) invalid()
    node.cipher = credentials.slice(0, colon)
    node.password = credentials.slice(colon + 1)
  } else if (type === 'vless') node.uuid = user
  else if (['socks5', 'http'].includes(type)) {
    if (user) node.username = user
    if (password) node.password = password
  } else if (type === 'tuic') {
    node.uuid = user
    node.password = password
  } else node.password = password ? `${user}:${password}` : user
  if (q.security) {
    if (!['none', 'tls', 'reality'].includes(q.security)) invalid()
    node.tls = q.security !== 'none'
  }
  if (q.sni || q.peer) node.sni = q.sni || q.peer
  if (q.fp) node['client-fingerprint'] = q.fp
  if (q.alpn) node.alpn = q.alpn.split(',')
  if (q.allowInsecure || q.insecure) {
    const value = q.allowInsecure || q.insecure
    if (!['0', '1', 'true', 'false'].includes(value)) invalid()
    node['skip-cert-verify'] = ['1', 'true'].includes(value)
  }
  if (q.type) node.network = q.type
  if (q.flow) node.flow = q.flow
  if (q.security === 'reality') node['reality-opts'] = { 'public-key': q.pbk || '', 'short-id': q.sid || '' }
  if (q.type === 'ws') node['ws-opts'] = { path: q.path || '/', ...(q.host ? { headers: { Host: q.host } } : {}) }
  else if (q.type === 'grpc') node['grpc-opts'] = { 'grpc-service-name': q.serviceName || '' }
  else if (q.path || q.host || q.serviceName) invalid()
  for (const key of ['obfs', 'obfs-password', 'up', 'down', 'ports', 'mport']) if (q[key]) node[key] = q[key]
  return node
}

export function parseSubscription(source) {
  try {
    const bytes = Buffer.isBuffer(source) ? source : Buffer.from(String(source ?? ''))
    if (bytes.length > MAX_SOURCE_BYTES) throw new SubscriptionError('subscription_limit')
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    if (!text) invalid()
    if (/^[\w+/=\s-]+$/.test(text)) text = decoded64(text).trim()
    let nodes
    if (/^[a-z0-9]+:\/\//i.test(text))
      nodes = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(uriNode)
    else {
      const doc = parseDocument(text, { schema: 'core', uniqueKeys: true, strict: true })
      if (doc.errors.length || doc.warnings.length) invalid()
      const pending = [[doc.contents, 0]]
      let total = 0
      while (pending.length) {
        const [node, depth] = pending.pop()
        if (++total > 20000 || depth > 20 || isAlias(node) || node?.anchor) invalid()
        if (isCollection(node)) for (const child of node.items) pending.push([child, depth + 1])
        else if (node?.key !== undefined) {
          pending.push([node.key, depth + 1])
          pending.push([node.value, depth + 1])
        }
      }
      const value = doc.toJS({ maxAliasCount: 0 })
      nodes = Array.isArray(value) ? value : value?.proxies
    }
    if (!Array.isArray(nodes) || !nodes.length) invalid()
    if (nodes.length > MAX_SUBSCRIPTION_NODES) throw new SubscriptionError('subscription_limit')
    return [...new Map(nodes.map(sanitizeNode).map((node) => [node.hash, node])).values()]
  } catch (error) {
    if (error instanceof SubscriptionError) throw error
    throw new SubscriptionError()
  }
}
