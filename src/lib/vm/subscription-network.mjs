import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { lookup } from 'node:dns/promises'

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024
export class SubscriptionError extends Error {
  constructor(code = 'subscription_invalid') {
    super(
      {
        subscription_invalid: '订阅格式、节点协议或字段不受支持',
        subscription_blocked: '订阅或节点地址不是允许的公网地址',
        subscription_limit: '订阅大小、节点数量或监听端口超出限制',
        subscription_fetch: '订阅下载失败，请检查来源与网络',
        subscription_runtime: '代理内核不可用，已有出口不会切换为直连',
        subscription_storage: '代理订阅存储不可用',
        subscription_not_found: '订阅不存在',
        subscription_busy: '另一项订阅操作正在进行',
        subscription_bound: '订阅包含已绑定节点，请先解除绑定',
      }[code] || '代理订阅操作失败',
    )
    this.code = code
  }
}

const blocked4 = new net.BlockList()
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  blocked4.addSubnet(ip, prefix, 'ipv4')
const global6 = new net.BlockList()
global6.addSubnet('2000::', 3, 'ipv6')
const blocked6 = new net.BlockList()
for (const [ip, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
]) {
  blocked6.addSubnet(ip, prefix, 'ipv6')
}

export function isPublicAddress(address) {
  const family = net.isIP(address)
  return family === 4
    ? !blocked4.check(address, 'ipv4')
    : family === 6 && global6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6')
}

export function validEndpointHost(value) {
  if (typeof value !== 'string' || value.length > 253) return false
  if (net.isIP(value)) return isPublicAddress(value)
  return (
    !/^(localhost|.*\.(localhost|local|internal|home|lan))\.?$/i.test(value) &&
    value.includes('.') &&
    value.split('.').every((part) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part))
  )
}

export async function withDeadline(promise, timeoutMs, code) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SubscriptionError(code)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function resolvePublicHost(host, resolver = lookup, timeoutMs = 8000) {
  if (!validEndpointHost(host)) throw new SubscriptionError('subscription_blocked')
  let addresses
  try {
    addresses = net.isIP(host)
      ? [{ address: host, family: net.isIP(host) }]
      : await withDeadline(resolver(host, { all: true, verbatim: true }), timeoutMs, 'subscription_blocked')
  } catch {
    throw new SubscriptionError('subscription_blocked')
  }
  if (!addresses.length || addresses.length > 32 || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new SubscriptionError('subscription_blocked')
  }
  return [...new Set(addresses.map((item) => item.address))].sort((a, b) => net.isIP(a) - net.isIP(b))
}

export function sourceUrl(value) {
  try {
    const url = new URL(value)
    if (
      typeof value !== 'string' ||
      value.length > 4096 ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      !validEndpointHost(url.hostname.replace(/^\[|\]$/g, ''))
    ) {
      throw new Error()
    }
    return url
  } catch {
    throw new SubscriptionError('subscription_blocked')
  }
}

export async function fetchSubscription(raw, { resolver = resolvePublicHost, timeoutMs = 20000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs)
  let url = sourceUrl(raw)
  for (let redirect = 0; redirect < 5; redirect += 1) {
    if (signal.aborted) throw new SubscriptionError('subscription_fetch')
    const addresses = await Promise.race([
      resolver(url.hostname.replace(/^\[|\]$/g, '')),
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new SubscriptionError('subscription_fetch')), { once: true }),
      ),
    ])
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
      throw new SubscriptionError('subscription_blocked')
    }
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).get(
        url,
        {
          agent: false,
          signal,
          minVersion: 'TLSv1.2',
          headers: { 'User-Agent': 'clash.meta', 'Accept-Encoding': 'identity' },
          lookup: (_host, options, callback) => {
            const answer = { address: addresses[0], family: net.isIP(addresses[0]) }
            if (options?.all) callback(null, [answer])
            else callback(null, answer.address, answer.family)
          },
        },
        (res) => {
          res.on('error', () => reject(new SubscriptionError('subscription_fetch')))
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            resolve({ redirect: res.headers.location })
            return
          }
          if (
            res.statusCode !== 200 ||
            (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')
          ) {
            res.destroy()
            reject(new SubscriptionError('subscription_fetch'))
            return
          }
          const chunks = []
          let size = 0
          res.on('data', (chunk) => {
            size += chunk.length
            if (size > MAX_SOURCE_BYTES) {
              res.destroy()
              reject(new SubscriptionError('subscription_limit'))
            } else chunks.push(chunk)
          })
          res.on('end', () => resolve({ body: Buffer.concat(chunks) }))
        },
      )
      request.on('error', () => reject(new SubscriptionError('subscription_fetch')))
    })
    if (response.body) return response.body
    const next = sourceUrl(new URL(response.redirect, url).href)
    if (url.protocol === 'https:' && next.protocol !== 'https:') throw new SubscriptionError('subscription_blocked')
    url = next
  }
  throw new SubscriptionError('subscription_fetch')
}
